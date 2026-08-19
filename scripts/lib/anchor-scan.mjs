/**
 * anchor-scan.mjs —— gen-anchor-map / check-anchor-drift 共用的抓取与配对逻辑。
 *
 * 原理:分别抓「镜像页」和「原站页」线上渲染后的 HTML,提取真实锚点 ID,
 * 按标题级别 + 顺序一一配对(翻译是 1:1 的),不做任何 slug 算法模拟。
 *
 * 数据来源:
 *   - 页面清单:GitHub API 拉仓库树,取 <dir>/src/content/docs/ 下的 .md
 *   - 原站 URL:优先读 frontmatter 的 source: 字段,否则按 origin + 逻辑路径构造
 */

/** Starlight 自带的非正文锚点,配对时排除 */
export const CHROME_IDS = new Set(['_top', 'starlight__on-this-page']);

/** GitHub API 匿名限额 60/h;有 gh 登录态或 GITHUB_TOKEN 时带上,限额 5000/h */
export async function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const { execFileSync } = await import('node:child_process');
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

export async function fetchText(url, retries = 2) {
  const headers = { 'user-agent': 'docs-compare/anchor-scan' };
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
export async function pool(items, limit, fn) {
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
export function headings(html) {
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
export function pairHeadings(mirrorHeads, originHeads, pageLabel) {
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
export function frontmatterField(md, key) {
  const m = md.match(new RegExp(`^---[\\s\\S]*?^${key}:\\s*["']?([^"'\\n]+)["']?\\s*$`, 'm'));
  return m ? m[1].trim() : null;
}

// ---------- 站点扫描 ----------

/**
 * 单站点全量扫描:拉页面清单,逐页抓两侧 HTML 配对。
 * 返回 { pages, results }:results[i] = { page, originUrl, map, warns } 或 { __error }。
 */
export async function scanSite(cfg, site) {
  const tree = JSON.parse(
    await fetchText(`https://api.github.com/repos/${cfg.repo}/git/trees/${cfg.branch}?recursive=1`),
  ).tree;

  const contentDir = `${site.dir}/src/content/docs/`;
  const pages = tree
    .filter((t) => t.type === 'blob' && t.path.startsWith(contentDir) && t.path.endsWith('.md'))
    .map((t) => t.path.slice(contentDir.length))
    .map((p) => {
      const noExt = p.replace(/\.md$/, '');
      return { file: p, logicalPath: noExt === 'index' ? '/' : `/${noExt}` };
    });

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

  return { pages, results };
}
