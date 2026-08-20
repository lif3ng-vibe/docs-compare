#!/usr/bin/env node
/**
 * check-anchor-drift.mjs —— 锚点表漂移检测(翻译管线日常检查)。
 *
 * 原站更新后,在役的 anchor-map.json 会过期:新标题没入表(点击查不到,
 * 原样透传可能错位)、旧映射失效。本脚本现抓两侧线上真实标题重算「应有映射」,
 * 与打包表对比(copyTo 目录,随扩展/Tauri/CDP 发布,是在役真值):
 *
 *   - 新页面/新增映射:两侧已有、表里没有 → 原站或汉化更新后未重新生成
 *   - 失效映射:表里有、线上已无 → 标题被删/改 ID
 *   - 值变化:同一键映射目标变了
 *   - 页面下线:表里的页面两侧都已不存在
 *   - 标题数量不齐:漏译/多译信号(非表漂移,不计数)
 *
 * 另作两项健康检查(不计漂移):生成器产物 out/ 与打包表是否一致;
 * 镜像站若部署了 /anchor-map.json 则与打包表比对(当前模式为打包表分发,
 * 未部署属正常,仅提示)。
 *
 * 有漂移 exit 1,干净 exit 0(可挂 CI 或定时任务)。
 *
 * 用法:node scripts/check-anchor-drift.mjs [配置路径]
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { fetchText, scanSite } from './lib/anchor-scan.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const configPath = process.argv[2] ?? path.join(root, 'scripts', 'anchor-map.config.json');
const { default: cfg } = await import(pathToFileURL(configPath).href, { with: { type: 'json' } });

function showList(title, items, cap = 20) {
  if (!items.length) return;
  console.log(`  ${title}(${items.length}):`);
  for (const line of items.slice(0, cap)) console.log(`    ${line}`);
  if (items.length > cap) console.log(`    … 共 ${items.length} 条`);
}

/** 条目数:Record<path, Record<zh,en>> */
const entryCount = (m) => Object.values(m).reduce((n, page) => n + Object.keys(page).length, 0);

async function readJsonIfExists(p) {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

let driftTotal = 0;

for (const site of cfg.sites) {
  console.log(`\n=== ${site.id} ===`);
  const { results } = await scanSite(cfg, site);

  // 现状聚合:成功扫到的页面 / 应有映射 / 抓取失败
  const freshPages = new Set();
  const freshMap = {};
  const errors = [];
  const countWarns = [];
  for (const r of results) {
    if (!r || r.__error) {
      errors.push(String(r?.__error ?? '未知错误'));
      continue;
    }
    freshPages.add(r.page.logicalPath);
    if (Object.keys(r.map).length > 0) freshMap[r.page.logicalPath] = r.map;
    countWarns.push(...r.warns);
  }
  console.log(`扫描页面:${freshPages.size},应有映射 ${entryCount(freshMap)} 条`);

  // 在役真值:打包表(copyTo)
  const copyDir = [cfg.copyTo].flat().filter(Boolean)[0];
  const packagedPath = copyDir ? path.join(root, copyDir, `${site.id}.json`) : null;
  const packaged = packagedPath ? await readJsonIfExists(packagedPath) : null;
  if (!packaged) {
    console.log(`  ✗ 打包表不存在:${packagedPath ?? '(copyTo 未配置)'}——先跑生成器`);
    driftTotal++;
    continue;
  }
  console.log(`打包表:${entryCount(packaged)} 条`);

  const added = [];
  const removed = [];
  const changed = [];
  const gonePages = [];

  // 页面级:表里有、现在两侧都扫不到的(抓取失败不算下线)
  for (const p of Object.keys(packaged)) {
    if (!freshPages.has(p)) gonePages.push(`${p}(表内 ${Object.keys(packaged[p]).length} 条)`);
  }

  // 锚点级
  for (const [p, pairs] of Object.entries(freshMap)) {
    if (!(p in packaged)) {
      added.push(`${p}:整页未入表,${Object.keys(pairs).length} 条`);
      continue;
    }
    for (const [zh, en] of Object.entries(pairs)) {
      if (!(zh in packaged[p])) added.push(`${p}: ${zh} → ${en}`);
      else if (packaged[p][zh] !== en) changed.push(`${p}: ${zh}: ${packaged[p][zh]} → ${en}`);
    }
  }
  for (const [p, pairs] of Object.entries(packaged)) {
    if (!freshMap[p]) {
      // 页面还在但已无差异映射 → 旧条目全部失效
      if (freshPages.has(p) && Object.keys(pairs).length) {
        removed.push(`${p}: ${Object.keys(pairs).length} 条全部失效(两侧标题已相同)`);
      }
      continue;
    }
    for (const zh of Object.keys(pairs)) {
      if (!(zh in freshMap[p])) removed.push(`${p}: ${zh} → ${pairs[zh]}(标题已删/改 ID)`);
    }
  }

  // 健康检查(不计漂移):生成器产物与打包表一致?
  const outMap = await readJsonIfExists(
    path.join(root, cfg.outDir ?? 'out', site.id, 'anchor-map.json'),
  );
  if (outMap && JSON.stringify(outMap) !== JSON.stringify(packaged)) {
    console.log(`  ⚠ 生成器产物 out/ 与打包表不同步(out ${entryCount(outMap)} / 打包 ${entryCount(packaged)} 条)`);
  }

  // 健康检查(不计漂移):镜像站部署表(当前模式为打包表分发,未部署属正常)
  try {
    const deployed = JSON.parse(await fetchText(`${site.mirror}/anchor-map.json`));
    if (JSON.stringify(deployed) !== JSON.stringify(packaged)) {
      console.log(
        `  ⚠ 镜像站部署表与打包表不同步(部署 ${entryCount(deployed)} / 打包 ${entryCount(packaged)} 条)`,
      );
    } else {
      console.log('  ℹ 镜像站已部署且与打包表一致');
    }
  } catch {
    console.log('  ℹ 镜像站未部署 anchor-map.json(当前走打包表分发,正常)');
  }

  showList('新页面/新增映射(表缺)', added);
  showList('失效映射(表多余)', removed);
  showList('值变化', changed);
  showList('页面下线(表多余)', gonePages);
  if (errors.length) showList('页面抓取失败(无法核对)', errors, 5);
  if (countWarns.length) console.log(`  ℹ 标题数量不齐 ${countWarns.length} 处(漏译/多译信号,非表漂移)`);

  const drift = added.length + removed.length + changed.length + gonePages.length;
  driftTotal += drift;
  console.log(drift ? `  ✗ 漂移 ${drift} 项` : '  ✓ 无漂移');
}

console.log(
  driftTotal
    ? `\n共 ${driftTotal} 项漂移:重跑 node scripts/gen-anchor-map.mjs(会同步 copyTo),各实现重新打包即可。`
    : '\n全部干净。',
);
process.exit(driftTotal ? 1 : 0);
