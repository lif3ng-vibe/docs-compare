/**
 * 开发跑法:npm run sim —— 构建安装并在模拟器里正常启动(不带自测),
 * 用于手动过 UI(选站、对照打开、旋转、拖分隔条、单文/对照切换)。
 */
import { execFileSync } from 'node:child_process';
import { pickSimulator, bootSimulator, buildApp, installApp, BUNDLE_ID } from './lib.mjs';

const { udid, name } = pickSimulator();
bootSimulator(udid, name);
const app = buildApp(udid);
installApp(udid, app);
console.log(`[sim] 启动 ${BUNDLE_ID}(正常模式)…`);
execFileSync('xcrun', ['simctl', 'launch', udid, BUNDLE_ID], { stdio: 'inherit' });
console.log(`[sim] 已在 ${name} 上启动。旋转/选站/拖分隔条手动验证`);
