/**
 * 模拟器驱动公共库:找/启设备、xcodegen、xcodebuild、安装启动。
 * 供 sim.mjs(交互开发)与 selftest.mjs(自测)共用。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const BUNDLE_ID = 'dev.docscompare.apple';
export const APP_NAME = 'DocsCompare';

const simctl = (...args) => execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8' });

/** 找一台可用 iPhone 模拟器(优先 Pro),返回 {udid, name} */
export function pickSimulator() {
  const json = JSON.parse(simctl('list', 'devices', 'available', '--json'));
  const devices = Object.values(json.devices).flat();
  const pick =
    devices.find((d) => d.name.includes('iPhone 16 Pro')) ??
    devices.find((d) => d.name.includes('iPhone 15 Pro')) ??
    devices.find((d) => d.isAvailable && d.name.startsWith('iPhone'));
  if (!pick) throw new Error('没有可用的 iPhone 模拟器(先装 iOS 运行时:xcodebuild -downloadPlatform iOS)');
  return { udid: pick.udid, name: pick.name };
}

export function bootSimulator(udid, name) {
  const state = JSON.parse(simctl('list', 'devices', '--json'));
  const dev = Object.values(state.devices).flat().find((d) => d.udid === udid);
  if (dev?.state !== 'Booted') {
    console.log(`[sim] 启动 ${name}…`);
    simctl('boot', udid);
  }
  simctl('bootstatus', udid, '-b'); // 等到基本可用
  // 打开 Simulator 窗口便于观察(CI 等无 GUI 需求场景跳过)
  if (!process.env.CI) {
    spawnSync('open', ['-a', 'Simulator'], { stdio: 'ignore' });
  }
}

/** npm run build 之后的工程生成 + xcodebuild,返回 .app 路径 */
export function buildApp(udid) {
  if (!existsSync(path.join(ROOT, 'web/controller.js'))) {
    throw new Error('web/controller.js 不存在:先 npm run build');
  }
  const proj = path.join(ROOT, 'DocsCompare.xcodeproj');
  if (!existsSync(proj)) {
    console.log('[xcodegen] 生成工程…');
    execFileSync('xcodegen', ['generate'], { cwd: ROOT, stdio: 'inherit' });
  }
  console.log('[xcodebuild] 编译(Debug-iphonesimulator)…');
  execFileSync(
    'xcodebuild',
    [
      '-project', 'DocsCompare.xcodeproj',
      '-scheme', APP_NAME,
      '-configuration', 'Debug',
      '-destination', `id=${udid}`,
      '-derivedDataPath', 'build',
      // 模拟器不需要签名;命令行覆盖最可靠(免 team,CI 可跑)
      'CODE_SIGNING_ALLOWED=NO',
      'build',
    ],
    { cwd: ROOT, stdio: 'inherit' },
  );
  const app = path.join(ROOT, 'build/Build/Products/Debug-iphonesimulator', `${APP_NAME}.app`);
  if (!existsSync(app)) throw new Error(`构建产物缺失:${app}`);
  return app;
}

export function installApp(udid, appPath) {
  simctl('install', udid, appPath);
}
