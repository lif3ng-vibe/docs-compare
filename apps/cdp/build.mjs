import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const out = `${root}dist`;

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// CLI/引擎:Node 侧 bundle(puppeteer-core 外置,core 打进去)
await esbuild.build({
  entryPoints: { main: 'src/main.ts' },
  outdir: 'dist',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: false,
  logLevel: 'info',
  external: ['puppeteer-core'],
});

// 注入载荷:页面主世界 IIFE(CDP addScriptToEvaluateOnNewDocument 用)
await esbuild.build({
  entryPoints: { 'reporter.iife': 'src/reporter.ts' },
  outdir: 'dist',
  bundle: true,
  format: 'iife',
  target: 'es2021',
  sourcemap: false,
  logLevel: 'info',
});

// 静态资源:站点配置、锚点表(与扩展共享)、fixture 双语站(与 Tauri 共享)
await cp('config/sites.json', `${out}/sites.json`);
await cp('../chrome-extension/src/static/anchor-maps', `${out}/anchor-maps`, { recursive: true });
await cp('../tauri/fixtures', `${out}/fixtures`, { recursive: true });
console.log('[docs-compare/cdp] dist/ 就绪');
