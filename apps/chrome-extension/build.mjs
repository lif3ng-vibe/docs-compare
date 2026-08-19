import * as esbuild from 'esbuild';
import { cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const out = `${root}dist`;
const watch = process.argv.includes('--watch');

await rm(out, { recursive: true, force: true });

const ctx = await esbuild.context({
  entryPoints: {
    background: 'src/background.ts',
    content: 'src/content.ts',
    'main-world': 'src/main-world.ts',
    popup: 'src/popup/popup.ts',
    options: 'src/options/options.ts',
  },
  outdir: 'dist',
  bundle: true,
  format: 'iife',
  target: 'chrome111',
  sourcemap: false,
  logLevel: 'info',
});

await ctx.rebuild();
// manifest / html 等静态文件原样拷贝
await cp('src/static', out, { recursive: true });

if (watch) {
  console.log('[docs-compare] watching… 改完代码后到 chrome://extensions 点「重新加载」');
} else {
  await ctx.dispose();
}
