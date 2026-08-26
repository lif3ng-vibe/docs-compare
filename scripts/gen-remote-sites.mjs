/**
 * 生成远程下发的 sites.json(GitHub Release latest 资产):
 * 以 packages/core 的 DEFAULT_SITES 为事实源,anchorMapUrl/pageMapUrl
 * 改写为 Release 绝对 URL(releases/download/latest/anchor-maps/<id>.json),
 * 客户端拿到即可直接加载,无需宿主相对路径解析。
 *
 * 用法:node scripts/gen-remote-sites.mjs <outDir>
 * 产物:<outDir>/sites.json(CI 上传 Release;本地预览/断言也用它)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = process.argv[2] ?? path.join(root, 'out', 'remote-sites');
const tmp = path.join(root, 'out', 'remote-sites.tmp.mjs');

// esbuild(devDependency)即时打包 defaults.ts 取 DEFAULT_SITES,零新增依赖
await esbuild.build({
  entryPoints: [path.join(root, 'packages/core/src/defaults.ts')],
  bundle: true,
  format: 'esm',
  outfile: tmp,
  logLevel: 'error',
});

const { DEFAULT_SITES } = await import(`file://${tmp.replace(/\\/g, '/')}`);

const ASSET_BASE = 'https://github.com/lif3ng-vibe/docs-compare/releases/download/latest';
const sites = DEFAULT_SITES.map((s) => ({
  ...s,
  anchorMapUrl: `${ASSET_BASE}/anchor-maps/${s.id}.json`,
  pageMapUrl: s.pageMapUrl ? `${ASSET_BASE}/anchor-maps/${s.id}.page-map.json` : undefined,
}));

await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, 'sites.json'), JSON.stringify(sites, null, 2) + '\n');
console.log(`[gen-remote-sites] ${sites.length} 站 → ${path.join(outDir, 'sites.json')}`);
