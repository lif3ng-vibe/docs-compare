/**
 * CDP 实现入口:CLI 解析 → 浏览器 → 双窗口 → engine 接线 → 常驻同步。
 * 架构与 SPEC 一致:core 全复用,本文件只做「捕获→映射→驱动」的宿主接线。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Page } from 'puppeteer-core';
import { Engine } from './engine';
import type { EnginePort, Side } from './engine';
import { attachSide, launchOrAttach, newWindowPage, tileWindows, wireEngine } from './chrome';
import type { ReportEnvelope } from './protocol';
import { parseCli } from './cli';
import { runSelftest } from './selftest';

const DIST = dirname(__filename); // 打包后 dist/main.js,静态资源同目录

async function readJson(p: string): Promise<unknown> {
  return JSON.parse(readFileSync(p, 'utf8')) as unknown;
}

async function run(): Promise<void> {
  const opts = parseCli(process.argv.slice(2));
  if (opts.selftest) {
    await runSelftest(opts.selftest, { headless: opts.headless });
    return;
  }
  if (!opts.url) {
    console.error('缺少 URL。docs-compare-cdp <url> --help 查看用法。');
    process.exitCode = 1;
    return;
  }

  const reporterSource = readFileSync(join(DIST, 'reporter.iife.js'), 'utf8');
  // 占位 port:通道就绪后替换为真实现(见下方 Object.assign)
  const port: EnginePort = {
    navigate: async () => {},
    apply: async () => {},
  };
  const engine = new Engine(port, DIST, opts.settings);
  const errors = engine.loadSites(await readJson(opts.sites ?? join(DIST, 'sites.json')));
  if (errors.length) console.warn('[dc] 站点配置问题:', errors);

  const pair = await engine.openPair(opts.url);
  if (!pair) {
    console.error(
      `URL 不匹配任何站点配置:${opts.url}\n已配置:${engine
        .getSiteList()
        .map((s) => `\n  ${s.id}: ${s.origin} ↔ ${s.mirror}`)
        .join('')}`,
    );
    process.exitCode = 1;
    return;
  }

  const browser = await launchOrAttach(opts);
  process.on('SIGINT', () => {
    console.log('\n[dc] 退出');
    void (opts.attach ? browser.disconnect() : browser.close()).finally(() => process.exit(0));
  });

  // 双窗口:launch 模式复用初始页为左侧;attach 模式新建两个窗口。
  // newWindow 失败退化为同窗口标签(等价扩展 tabs 布局,提示手动分屏)。
  let left: Page;
  let right: Page;
  if (opts.attach) {
    left = await newWindowPage(browser).catch(() => browser.newPage());
    right = await newWindowPage(browser).catch(() => browser.newPage());
    if (!opts.region) {
      console.warn('[dc] attach 模式未指定 --region,不平铺;可传 --region l,t,w,h 自动左右分屏');
    }
  } else {
    left =
      (await browser.pages())[0] ?? (await newWindowPage(browser).catch(() => browser.newPage()));
    right = await newWindowPage(browser).catch(() => browser.newPage());
  }

  // 先接通道(注册 init script),再导航,保证 reporter 从 document_start 就位。
  // 信号经 defer 转 wiring(wiring 在两条通道都就绪后生成)
  let wiring: ReturnType<typeof wireEngine> | undefined;
  const deferSignal = (side: Side, msg: ReportEnvelope): void => wiring?.onSignal(side, msg);
  const deferNav = (side: Side, url: string): void => wiring?.onNav(side, url);
  const channels = {
    left: await attachSide(left, 'left', reporterSource, (msg) => deferSignal('left', msg), deferNav),
    right: await attachSide(
      right,
      'right',
      reporterSource,
      (msg) => deferSignal('right', msg),
      deferNav,
    ),
  } as const;
  wiring = wireEngine(engine, channels);
  Object.assign(port, wiring.port);

  if (!opts.headless && (opts.attach ? opts.region : true)) {
    await tileWindows(browser, left, right, opts.region);
  }

  await engine.open('left', pair.leftUrl);
  await engine.open('right', pair.rightUrl);
  console.log(`[dc] ${pair.siteId}:已对照打开`);
  console.log(`[dc]   左(原站) ${pair.leftUrl}`);
  console.log(`[dc]   右(镜像) ${pair.rightUrl}`);
  console.log('[dc] Ctrl-C 退出同步');
  await new Promise<never>(() => undefined); // 常驻
}

run().catch((e) => {
  console.error('[dc] 启动失败:', e);
  process.exit(1);
});
