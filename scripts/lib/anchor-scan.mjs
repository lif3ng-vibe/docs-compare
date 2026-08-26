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
  // gh 不在 PATH 时(常见于刚安装、shell 未重启)按平台常见位置找
  const candidates =
    process.platform === 'win32'
      ? ['gh', 'C:\\Program Files\\GitHub CLI\\gh.exe', `${process.env.LOCALAPPDATA}\\Programs\\GitHub CLI\\gh.exe`]
      : ['gh', '/usr/local/bin/gh', '/opt/homebrew/bin/gh'];
  for (const gh of candidates) {
    try {
      const { execFileSync } = await import('node:child_process');
      const token = execFileSync(gh, ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (token) return token;
    } catch {
      // 换下一个候选
    }
  }
  return null;
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
 *
 * 配对纪律:翻译是 1:1 的,顺序配对只在「各级标题数量完全一致」时可信。
 * 数量不齐 ⇒ 页面被重组/漏译,硬按顺序配会产出语义错位的映射(点击滚到
 * 错位置,比没有映射更糟)——此时丢弃该级映射,只报警告,留给人工或
 * config 里的 manualOverrides 补正。
 */
export function pairHeadings(mirrorHeads, originHeads, pageLabel) {
  const map = {};
  const warns = [];
  for (let level = 1; level <= 6; level++) {
    const a = mirrorHeads.filter((h) => h.level === level);
    const b = originHeads.filter((h) => h.level === level);
    if (a.length !== b.length) {
      warns.push(`${pageLabel}: h${level} 数量不一致(镜像 ${a.length} / 原站 ${b.length}),该级映射已丢弃`);
      continue;
    }
    for (let i = 0; i < a.length; i++) {
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

// ---------- sitemap 页面清单 ----------

/** 抓取 sitemap(支持 sitemapindex 嵌套一层),返回去重后的 loc 列表 */
export async function sitemapUrls(sitemapUrl) {
  const xml = await fetchText(sitemapUrl);
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
  if (/<sitemapindex/i.test(xml)) {
    const nested = [];
    for (const u of locs) nested.push(...(await sitemapUrls(u)));
    return nested;
  }
  return locs;
}

/**
 * sitemap 页面清单模式(官方双语站,不走 GitHub 树枚举):
 * 从 sitemap 里取 origin base 下的页面,逻辑路径 = 剥掉 origin pathname 前缀。
 * origin base 必须精确到语言根(如 https://herdr.dev/docs),否则会捞进博客/落地页。
 */
async function pagesFromSitemap(site) {
  const locs = await sitemapUrls(site.listFrom.sitemap);
  const o = new URL(site.origin);
  const base = o.pathname.replace(/\/+$/, ''); // 如 /docs
  const pages = [];
  for (const loc of locs) {
    let u;
    try {
      u = new URL(loc);
    } catch {
      continue;
    }
    if (u.origin !== o.origin) continue;
    let p = u.pathname;
    if (base === '') {
      if (p === '/') pages.push({ file: null, logicalPath: '/' });
      else if (p.endsWith('.html') || p.endsWith('.md')) continue; // 站点根裸奔的站少见,谨慎跳过非目录形态
      else pages.push({ file: null, logicalPath: p.replace(/\/+$/, '') });
    } else {
      if (p === `${base}/` || p === base) {
        pages.push({ file: null, logicalPath: '/' });
        continue;
      }
      if (!p.startsWith(`${base}/`)) continue;
      const rest = p.slice(base.length + 1).replace(/\/+$/, '');
      if (rest === '') continue;
      // .html 归一(目录式优先);非目录也不跳——带扩展名的逻辑路径照收,URL 拼接时原样带回
      const norm = rest.replace(/\/index\.html?$/, '').replace(/\.html?$/, '');
      if (norm === '') continue;
      pages.push({ file: null, logicalPath: `/${norm}` });
    }
  }
  // 去重(逻辑路径维度)
  const seen = new Set();
  return pages.filter((p) => (seen.has(p.logicalPath) ? false : (seen.add(p.logicalPath), true)));
}

// ---------- 站点扫描 ----------

/**
 * 原站 URL → 原站侧完整路径(仅归一:去尾斜杠、剥 .html/.md、/index 归目录)。
 * 不剥 base——page-map 的值是原站完整 pathname(如 /skills-ask-matt),
 * core 命中表项时直接以 origin host + 完整路径拼 URL,绕过 base/prefix
 * 剥拼(原站扁平页 /skills-ask-matt 与 base /skills 是兄弟路径,
 * 剥掉再拼会多出斜杠拼出 /skills/-ask-matt)。
 */
export function originPath(originUrl) {
  let u;
  try {
    u = new URL(originUrl);
  } catch {
    return null;
  }
  let p = u.pathname.replace(/\/index\.html?$/, '').replace(/\.(html?|md)$/, '').replace(/\/+$/, '');
  return p === '' ? '/' : p;
}

/**
 * 单站点全量扫描:拉页面清单,逐页抓两侧 HTML 配对。
 * 返回 { pages, results }:results[i] = { page, originUrl, map, warns, originPath } 或 { __error }。
 *
 * 页面清单两种来源:
 *   - 默认:GitHub API 读 docs-cn 仓库 <dir>/src/content/docs/ 下的 .md(我们维护的翻译站)
 *   - site.listFrom = { sitemap: '<url>' }:官方双语站,从 sitemap 枚举
 */
export async function scanSite(cfg, site) {
  let pages;
  if (site.listFrom?.sitemap) {
    pages = await pagesFromSitemap(site);
  } else {
    const tree = JSON.parse(
      await fetchText(`https://api.github.com/repos/${cfg.repo}/git/trees/${cfg.branch}?recursive=1`),
    ).tree;

    const contentDir = `${site.dir}/src/content/docs/`;
    pages = tree
      .filter((t) => t.type === 'blob' && t.path.startsWith(contentDir) && t.path.endsWith('.md'))
      .map((t) => t.path.slice(contentDir.length))
      .map((p) => {
        const noExt = p.replace(/\.md$/, '');
        return { file: p, logicalPath: noExt === 'index' ? '/' : `/${noExt}` };
      });
  }

  const results = await pool(pages, cfg.concurrency ?? 6, async (page) => {
    let originUrl = null;
    if (site.useSourceFrontmatter && page.file) {
      const rawUrl = `https://raw.githubusercontent.com/${cfg.repo}/${cfg.branch}/${site.dir}/src/content/docs/${page.file}`;
      const md = await fetchText(rawUrl);
      originUrl = frontmatterField(md, 'source');
    }
    if (!originUrl) originUrl = site.origin + (page.logicalPath === '/' ? '/' : page.logicalPath);
    const mirrorUrl = site.mirror + (page.logicalPath === '/' ? '/' : `${page.logicalPath}/`);

    const [mirrorHtml, originHtml] = await Promise.all([fetchText(mirrorUrl), fetchText(originUrl)]);
    const { map, warns } = pairHeadings(headings(mirrorHtml), headings(originHtml), page.logicalPath);
    return { page, originUrl, originPath: originPath(originUrl), map, warns };
  });

  return { pages, results };
}
