#!/usr/bin/env node
/**
 * gen-anchor-map.mjs —— 为汉化镜像站生成 anchor-map.json(docs-compare 扩展用)。
 *
 * 原理:分别抓「镜像页」和「原站页」线上渲染后的 HTML,提取真实锚点 ID,
 * 按标题级别 + 顺序一一配对(翻译是 1:1 的),不做任何 slug 算法模拟。
 *
 * 数据来源:
 *   - 页面清单:GitHub API 拉仓库树,取 <dir>/src/content/docs/ 下的 .md
 *   - 原站 URL:优先读 frontmatter 的 source: 字段,否则按 origin + 逻辑路径构造
 *
 * 用法:node scripts/gen-anchor-map.mjs [配置路径]
 * 配置默认读 scripts/anchor-map.config.json,产物写 out/<siteId>/anchor-map.json
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const configPath = process.argv[2] ?? path.join(root, 'scripts', 'anchor-map.config.json');
const { default: cfg } = await import(configPath, { with: { type: 'json' } });

/** Starlight 自带的非正文锚点,配对时排除 */
const CHROME_IDS = new Set(['_top', 'starlight__on-this-page']);

// ---------- 抓取 ----------

/** GitHub API 匿名限额 60/h;有 gh 登录态或 GITHUB_TOKEN 时带上,限额 5000/h */
async function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const { execFileSync } = await import('node:child_process');
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

async function fetchText(url, retries = 2) {
  const headers = { 'user-agent': 'docs-compare/gen-anchor-map' };
  if (url.startsWith('https://api.github.com/')) {
    const token = await githubToken();
    if (token) headers.authorization = `Bearer ${token}`;
  }
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (i === retries) throw new Error(`${url} → ${e.message}`);
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  return '';
}

/** 简单并发池 */
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i).catch((e) => ({ __error: String(e) }));
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------- 解析 ----------

const HEAD_RE = /<h([1-6])[^>]*?\sid="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g;

/** 提取正文标题:[{level, id}](顺序保持文档顺序) */
function headings(html) {
  const out = [];
  for (const m of html.matchAll(HEAD_RE)) {
    const id = m[2];
    if (CHROME_IDS.has(id)) continue;
    out.push({ level: Number(m[1]), id });
  }
  return out;
}

/**
 * 按级别配对:第 n 个 h2 对第 n 个 h2,以此类推。
 * 返回 {zh: en} 与对齐警告。
 */
function pairHeadings(mirrorHeads, originHeads, pageLabel) {
  const map = {};
  const warns = [];
  for (let level = 1; level <= 6; level++) {
    const a = mirrorHeads.filter((h) => h.level === level);
    const b = originHeads.filter((h) => h.level === level);
    if (a.length !== b.length) {
      warns.push(`${pageLabel}: h${level} 数量不一致(镜像 ${a.length} / 原站 ${b.length}),按少的配`);
    }
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (a[i].id !== b[i].id) map[a[i].id] = b[i].id; // 相同的不用写,core 会原样透传
    }
  }
  return { map, warns };
}

/** 从 markdown 文本取 frontmatter 字段 */
function frontmatterField(md, key) {
  const m = md.match(new RegExp(`^---[\\s\\S]*?^${key}:\\s*["']?([^"'\\n]+)["']?\\s*$`, 'm'));
  return m ? m[1].trim() : null;
}

// ---------- 主流程 ----------

const report = [];

for (const site of cfg.sites) {
  console.log(`\n=== ${site.id} ===`);
  const tree = await fetchText(
    `https://api.github.com/repos/${cfg.repo}/git/trees/${cfg.branch}?recursive=1`,
  ).then((t) => JSON.parse(t).tree);

  const pages = tree
    .filter((t) => t.type === 'blob' && t.path.startsWith(`${site.dir}/src/content/docs/`) && t.path.endsWith('.md'))
    .map((t) => t.path.slice(`${site.dir}/src/content/docs/`.length))
    .map((p) => {
      const noExt = p.replace(/\.md$/, '');
      return { file: p, logicalPath: noExt === 'index' ? '/' : `/${noExt}` };
    });

  console.log(`页面数:${pages.length}`);

  const results = await pool(pages, cfg.concurrency ?? 6, async (page) => {
    const rawUrl = `https://raw.githubusercontent.com/${cfg.repo}/${cfg.branch}/${site.dir}/src/content/docs/${page.file}`;
    let originUrl = null;
    if (site.useSourceFrontmatter) {
      const md = await fetchText(rawUrl);
      originUrl = frontmatterField(md, 'source');
    }
    if (!originUrl) originUrl = site.origin + (page.logicalPath === '/' ? '/' : page.logicalPath);
    const mirrorUrl = site.mirror + (page.logicalPath === '/' ? '/' : `${page.logicalPath}/`);

    const [mirrorHtml, originHtml] = await Promise.all([fetchText(mirrorUrl), fetchText(originUrl)]);
    const { map, warns } = pairHeadings(headings(mirrorHtml), headings(originHtml), page.logicalPath);
    return { page, originUrl, map, warns };
  });

  const anchorMap = {};
  let pairCount = 0;
  const warns = [];
  for (const r of results) {
    if (!r || r.__error) {
      warns.push(`${r?.__error ?? '未知错误'}`);
      continue;
    }
    if (Object.keys(r.map).length > 0) {
      anchorMap[r.page.logicalPath] = r.map;
      pairCount += Object.keys(r.map).length;
    }
    warns.push(...r.warns);
  }

  const outDir = path.join(root, cfg.outDir ?? 'out', site.id);
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, 'anchor-map.json');
  const json = JSON.stringify(anchorMap, null, 2) + '\n';
  await writeFile(outFile, json);

  // 可选:同步一份到扩展打包目录(配置 copyTo),省去手动拷贝
  const copies = [cfg.copyTo].flat().filter(Boolean);
  for (const c of copies) {
    const destDir = path.join(root, c);
    await mkdir(destDir, { recursive: true });
    await writeFile(path.join(destDir, `${site.id}.json`), json);
  }

  console.log(`映射条数:${pairCount},覆盖页面:${Object.keys(anchorMap).length}/${pages.length}`);
  console.log(`已写入 ${outFile}${copies.length ? `(并同步到 ${copies.join(', ')})` : ''}`);
  if (warns.length) {
    console.log(`警告 ${warns.length} 条(详见 report):`);
    for (const w of warns.slice(0, 10)) console.log(`  ⚠ ${w}`);
    if (warns.length > 10) console.log(`  … 共 ${warns.length} 条`);
  }
  report.push({ site: site.id, pages: pages.length, mappedPages: Object.keys(anchorMap).length, pairs: pairCount, warns });
}

await mkdir(path.join(root, cfg.outDir ?? 'out'), { recursive: true });
await writeFile(
  path.join(root, cfg.outDir ?? 'out', 'gen-report.json'),
  JSON.stringify(report, null, 2) + '\n',
);
console.log('\n完成。把各站点 anchor-map.json 放到对应站点的 public/ 目录重新部署即可。');
