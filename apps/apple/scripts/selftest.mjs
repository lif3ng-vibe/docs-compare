/**
 * 自测跑法(先 npm run build 由 package script 保证):
 *   node scripts/selftest.mjs           → fixture 离线自测(模拟器)
 *   node scripts/selftest.mjs --live    → 真实站点
 *   node scripts/selftest.mjs --layout  → 纯 Swift 布局断言(不起 UI)
 *
 * 退出码:app 进程经 --console-pty 传播;同时对 stdout 的 JSON 做二次校验,
 * 防 simctl 退出码传播不稳(双保险)。
 */
import { spawnSync } from 'node:child_process';
import { pickSimulator, bootSimulator, buildApp, installApp, BUNDLE_ID } from './lib.mjs';

const arg = process.argv[2] ?? '';
const mode = arg === '--live' ? '--selftest=live' : arg === '--layout' ? '--selftest=layout' : '--selftest';

const { udid, name } = pickSimulator();
bootSimulator(udid, name);
const app = buildApp(udid);
installApp(udid, app);

console.log(`[selftest] ${mode} @ ${name} …`);
// --console(非 pty)在 CI 无终端场景也稳;退出码以 JSON 双保险兜底
const r = spawnSync(
  'xcrun',
  ['simctl', 'launch', '--console', '--terminate-running-process', udid, BUNDLE_ID, mode],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
);
const out = (r.stdout ?? '') + (r.stderr ?? '');
if (out.trim()) console.log(out.trim());

// 双保险:从输出里找 JSON 结果,pass==total 才算过
let jsonOk = null;
const start = out.indexOf('{');
if (start >= 0) {
  const end = out.lastIndexOf('}');
  if (end > start) {
    try {
      const obj = JSON.parse(out.slice(start, end + 1));
      if (typeof obj.pass === 'number' && typeof obj.total === 'number') {
        jsonOk = obj.pass === obj.total && obj.total > 0;
      }
    } catch {
      // 输出里没有合法 JSON,只信退出码
    }
  }
}
const pass = jsonOk === null ? r.status === 0 : jsonOk;
console.log(`[selftest] 退出码=${r.status}${jsonOk === null ? '' : ` JSON 校验=${jsonOk ? 'pass' : 'fail'}`}`);
process.exitCode = pass ? 0 : 1;
