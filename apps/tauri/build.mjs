import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const out = `${root}frontend-dist`;
const watch = process.argv.includes('--watch');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const ctx = await esbuild.context({
  entryPoints: {
    controller: 'frontend/controller.ts',
    reporter: 'inject/reporter.ts',
  },
  outdir: 'frontend-dist',
  bundle: true,
  format: 'iife',
  target: 'es2021',
  sourcemap: false,
  logLevel: 'info',
});
await ctx.rebuild();

// 静态资源:控制器页面、fixture 双语站、站点配置、锚点表(与扩展共享)
await cp('frontend/index.html', `${out}/index.html`);
await cp('frontend/blank.html', `${out}/blank.html`);
await cp('frontend/style.css', `${out}/style.css`);
await cp('fixtures', `${out}/fixtures`, { recursive: true });
await cp('config/sites.json', `${out}/sites.json`);
await cp('../chrome-extension/src/static/anchor-maps', `${out}/anchor-maps`, { recursive: true });

if (watch) {
  console.log('[docs-compare/tauri] watching…');
} else {
  await ctx.dispose();
  console.log('[docs-compare/tauri] frontend-dist 就绪(cargo run 前先跑本构建)');
}
