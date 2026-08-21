#!/usr/bin/env node
/**
 * gen-anchor-map.mjs —— 为汉化镜像站生成 anchor-map.json(docs-compare 各实现用)。
 * 抓取/配对逻辑在 scripts/lib/anchor-scan.mjs(与 check-anchor-drift.mjs 共用)。
 *
 * 用法:node scripts/gen-anchor-map.mjs [配置路径]
 * 配置默认读 scripts/anchor-map.config.json,产物写 out/<siteId>/anchor-map.json
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { scanSite } from './lib/anchor-scan.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const configPath = process.argv[2] ?? path.join(root, 'scripts', 'anchor-map.config.json');
const { default: cfg } = await import(pathToFileURL(configPath).href, { with: { type: 'json' } });

// ---------- 主流程 ----------

const report = [];

for (const site of cfg.sites) {
  console.log(`\n=== ${site.id} ===`);
  const { pages, results } = await scanSite(cfg, site);
  console.log(`页面数:${pages.length}`);

  const anchorMap = {};
  const warns = [];
  for (const r of results) {
    if (!r || r.__error) {
      warns.push(`${r?.__error ?? '未知错误'}`);
      continue;
    }
    if (Object.keys(r.map).length > 0) {
      anchorMap[r.page.logicalPath] = r.map;
    }
    warns.push(...r.warns);
  }

  // 人工补正:重组页(常见于落地页)顺序配对不可信,由 config 的 manualOverrides
  // 提供人工确认的映射,按逻辑路径合并(覆盖同名键;值为 null 表示删除该键——
  // 用于剔除自动配对产出的语义错位项,如镜像新增节被硬配到原站相邻节)。
  const overrides = site.manualOverrides ?? {};
  for (const [logicalPath, pairs] of Object.entries(overrides)) {
    const merged = { ...anchorMap[logicalPath], ...pairs };
    for (const [k, v] of Object.entries(pairs)) if (v === null) delete merged[k];
    anchorMap[logicalPath] = merged;
  }
  const realPairs = Object.values(anchorMap).reduce((n, page) => n + Object.keys(page).length, 0);

  // 页面路径映射:镜像逻辑路径 → 原站完整路径(来源 frontmatter source:)。
  // 值存原站完整 pathname(core 命中时以 origin host + 完整路径拼 URL)。
  // 只收录与「base+逻辑路径」推导结果不同的页(真扁平/重组);全站按规律
  // 嵌套的(如 orca)不产出文件。
  const originBasePath = (() => {
    try {
      const p = new URL(site.origin.replace(/\/+$/, '')).pathname.replace(/\/+$/, '');
      return p === '' ? null : p;
    } catch {
      return null;
    }
  })();
  const pageMap = {};
  let pageMapEntries = 0;
  for (const r of results) {
    if (!r || r.__error || !r.originPath) continue;
    const derived = (originBasePath ?? '') + (r.page.logicalPath === '/' ? '/' : r.page.logicalPath);
    const derivedNorm = derived.replace(/\/+$/, '') || '/';
    if (r.originPath !== derivedNorm && !(originBasePath === null && r.originPath === r.page.logicalPath)) {
      pageMap[r.page.logicalPath] = r.originPath;
      pageMapEntries++;
    }
  }

  const outDir = path.join(root, cfg.outDir ?? 'out', site.id);
  await mkdir(outDir, { recursive: true });
  const copies = [cfg.copyTo].flat().filter(Boolean);
  const outFile = path.join(outDir, 'anchor-map.json');
  const json = JSON.stringify(anchorMap, null, 2) + '\n';
  await writeFile(outFile, json);

  // 页面路径映射产物(仅两侧不一致时);文件名 page-map.json,随锚点表同一目录分发
  if (pageMapEntries > 0) {
    const pj = JSON.stringify(pageMap, null, 2) + '\n';
    await writeFile(path.join(outDir, 'page-map.json'), pj);
    for (const c of copies) await writeFile(path.join(root, c, `${site.id}.page-map.json`), pj);
  }

  // 可选:同步一份到扩展打包目录(配置 copyTo),省去手动拷贝
  for (const c of copies) {
    const destDir = path.join(root, c);
    await mkdir(destDir, { recursive: true });
    await writeFile(path.join(destDir, `${site.id}.json`), json);
  }

  console.log(`映射条数:${realPairs},覆盖页面:${Object.keys(anchorMap).length}/${pages.length}${Object.keys(overrides).length ? `(含人工补正 ${Object.keys(overrides).length} 页)` : ''}`);
  if (pageMapEntries > 0) console.log(`页面路径映射:${pageMapEntries} 条(两侧逻辑路径不一致)→ page-map.json`);
  console.log(`已写入 ${outFile}${copies.length ? `(并同步到 ${copies.join(', ')})` : ''}`);
  if (warns.length) {
    console.log(`警告 ${warns.length} 条(详见 report):`);
    for (const w of warns.slice(0, 10)) console.log(`  ⚠ ${w}`);
    if (warns.length > 10) console.log(`  … 共 ${warns.length} 条`);
  }
  report.push({ site: site.id, pages: pages.length, mappedPages: Object.keys(anchorMap).length, pairs: realPairs, warns });
}

await mkdir(path.join(root, cfg.outDir ?? 'out'), { recursive: true });
await writeFile(
  path.join(root, cfg.outDir ?? 'out', 'gen-report.json'),
  JSON.stringify(report, null, 2) + '\n',
);
console.log('\n完成。把各站点 anchor-map.json 放到对应站点的 public/ 目录重新部署即可。');
