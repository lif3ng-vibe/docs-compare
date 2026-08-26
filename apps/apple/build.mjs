import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const out = `${root}web`;
const watch = process.argv.includes('--watch');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const ctx = await esbuild.context({
  entryPoints: {
    controller: 'frontend/controller.ts',
    reporter: 'inject/reporter.ts',
  },
  outdir: 'web',
  bundle: true,
  format: 'iife',
  target: 'es2021',
  sourcemap: false,
  logLevel: 'info',
});
await ctx.rebuild();

// 静态资源:控制器页面、fixture 双语站、站点配置、锚点表。
// fixtures/sites.json/blank.html 直接取自 tauri 实现(同一份离线测试站与
// 打包配置快照,避免两处漂移),anchor-maps 与扩展共享。
await cp('frontend/controller.html', `${out}/controller.html`);
await cp('frontend/style.css', `${out}/style.css`);
await cp('../tauri/frontend/blank.html', `${out}/blank.html`);
await cp('../tauri/fixtures', `${out}/fixtures`, { recursive: true });
await cp('../tauri/config/sites.json', `${out}/sites.json`);
await cp('../chrome-extension/src/static/anchor-maps', `${out}/anchor-maps`, { recursive: true });

if (watch) {
  console.log('[docs-compare/apple] watching…');
} else {
  await ctx.dispose();
  console.log('[docs-compare/apple] web/ 就绪(xcodegen + xcodebuild 前先跑本构建;产物以 folder reference 进 bundle)');
}
