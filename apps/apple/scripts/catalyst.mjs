/**
 * Mac Catalyst 一键跑法:构建(ad-hoc 签名)并启动 macOS 版。
 * 与 iOS 同一套代码/布局;桌面主力分发仍是 Tauri dmg,这个用于自用/验证。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, APP_NAME } from './lib.mjs';

if (!existsSync(path.join(ROOT, 'web/controller.js'))) {
  console.error('web/ 不存在:先 npm run build');
  process.exit(1);
}
if (!existsSync(path.join(ROOT, 'DocsCompare.xcodeproj'))) {
  execFileSync('xcodegen', ['generate'], { cwd: ROOT, stdio: 'inherit' });
}
console.log('[catalyst] 构建 Debug-maccatalyst…');
execFileSync(
  'xcodebuild',
  [
    '-project', 'DocsCompare.xcodeproj',
    '-scheme', APP_NAME,
    '-configuration', 'Debug',
    '-destination', 'platform=macOS,variant=Mac Catalyst',
    '-derivedDataPath', 'build',
    // 本机自用:ad-hoc 签名免证书
    'CODE_SIGN_IDENTITY=-',
    'CODE_SIGNING_REQUIRED=NO',
    'build',
  ],
  { cwd: ROOT, stdio: 'inherit' },
);
const app = path.join(ROOT, 'build/Build/Products/Debug-maccatalyst', `${APP_NAME}.app`);
if (!existsSync(app)) throw new Error(`构建产物缺失:${app}`);
execFileSync('open', [app]);
console.log('[catalyst] 已启动(窗口应已弹出)');
