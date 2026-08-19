/**
 * 自动化测试(平移 Tauri selftest 五场景,断言口径一致):
 * 1. 初始导航(对照打开)  2. 锚点表加载  3. 点标题对侧滚到对应标题
 * 4. 语义滚动(高度不对称文档)  5. 点链接同步对侧页面
 *
 * fixture 模式:本地静态服务器服务 dist/fixtures 双语站(离线、快速)。
 * live 模式:与插件验收相同的真实站点对(onorca.dev ↔ GitHub Pages 镜像)。
 * 窗口会弹出,跑完自动退出,exit code 0/1。
 *
 * 与 Tauri 的差异:Chrome 下 Runtime.evaluate 轮询不打断顺滑滚动
 * (那是 WebKit 特有坑),waitSettled 可放心轮询。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Engine } from './engine';
import type { Side } from './engine';
import { attachSide, evalIn, launchOrAttach, newWindowPage, wireEngine } from './chrome';
import type { SideChannel } from './chrome';
import type { ReportEnvelope } from './protocol';
import { readFileSync } from 'node:fs';

const DIST = dirname(__filename);

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

interface Scenario {
  leftHome: string;
  rightHome: string;
  anchorHash: string;
  expectHeading: string;
  linkSelector: string;
  rightAfterLink: string;
  navTimeout: number;
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitFor(fn: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时:${what}`);
    await wait(150);
  }
}
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
/** 等 smooth 滚动停稳(连续两次采样相同;Chrome 下轮询不打断动画) */
async function waitSettled(ch: SideChannel, timeoutMs = 8000): Promise<number> {
  const start = Date.now();
  let prev = Number.NaN;
  for (;;) {
    const y = Number(await evalIn(ch, 'window.scrollY'));
    if (y === prev) return y;
    if (Date.now() - start > timeoutMs) return y;
    prev = y;
    await wait(200);
  }
}
/** 等页面加载稳定(真实站点渐进渲染,页高连续两次采样相同) */
async function waitPageStable(ch: SideChannel, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let prev = -1;
  for (;;) {
    const h = Number(await evalIn(ch, 'document.body.scrollHeight'));
    if (h === prev && h > 0) return;
    if (Date.now() - start > timeoutMs) return;
    prev = h;
    await wait(500);
  }
}
/** 视口顶附近(容差内)最靠下的标题 id */
function nearestHeadingExpr(tolerancePx: number): string {
  return `(() => {
    const skip = new Set(['_top', 'starlight__on-this-page']);
    const hs = [...document.querySelectorAll('h2[id], h3[id]')].filter((h) => !skip.has(h.id));
    let best = '';
    for (const h of hs) { if (h.getBoundingClientRect().top <= ${tolerancePx}) best = h.id; }
    return best;
  })()`;
}

// ---------- 本地静态服务器(fixture 站 + 锚点表) ----------
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};
async function startStaticServer(root: string): Promise<{ base: string; close: () => void }> {
  const srv = createServer((req, res) => {
    void (async () => {
      try {
        const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
        let p = normalize(join(root, pathname));
        if (!p.startsWith(root)) throw new Error('越界');
        if (pathname.endsWith('/')) p = join(p, 'index.html');
        const data = await readFile(p);
        res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
    })();
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => srv.close() });
    });
  });
}

export async function runSelftest(
  mode: true | 'live',
  opts: { headless?: boolean },
): Promise<void> {
  const results: TestResult[] = [];
  const t = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      results.push({ name, pass: true, detail: '' });
      console.log(`[dc/selftest] ✓ ${name}`);
    } catch (e) {
      results.push({ name, pass: false, detail: String((e as Error)?.message ?? e) });
      console.log(`[dc/selftest] ✗ ${name}:${String((e as Error)?.message ?? e)}`);
    }
  };

  // 看门狗:任何卡死都要退出并报失败
  const watchdog = setTimeout(() => {
    console.error('[dc/selftest] 看门狗超时(120s),强制失败退出');
    process.exit(1);
  }, 120_000);

  const server = await startStaticServer(DIST);
  const browser = await launchOrAttach({ headless: opts.headless });
  const finish = (): void => {
    clearTimeout(watchdog);
    void browser.close().finally(() => {
      server.close();
      const pass = results.filter((r) => r.pass).length;
      console.log(`\n[dc/selftest] ${pass}/${results.length} 通过\n`);
      for (const r of results.filter((x) => !x.pass)) {
        console.log(`  ✗ ${r.name}:${r.detail}`);
      }
      process.exit(pass === results.length ? 0 : 1);
    });
  };

  try {
    // 两页(同窗口标签即可,断言与布局无关),通道与正式流程同一套
    const reporterSource = readFileSync(join(DIST, 'reporter.iife.js'), 'utf8');
    const port = { navigate: async () => {}, apply: async () => {} };
    const engine = new Engine(port, DIST);
    // 双窗口(与正式形态一致):同窗双标签会被 Chrome 后台标签冻结渲染,
    // 平滑滚动(smooth)永不推进——fixture 是瞬时滚动测不出,真实站点会假死
    const left = await newWindowPage(browser);
    const right = await newWindowPage(browser);
    let wiring: ReturnType<typeof wireEngine> | undefined;
    const debug = !!process.env.DC_DEBUG;
    const deferSignal = (side: Side, msg: ReportEnvelope): void => {
      if (debug) console.log(`[dbg] → ${side}`, JSON.stringify(msg));
      wiring?.onSignal(side, msg);
    };
    const deferNav = (side: Side, url: string): void => {
      if (debug) console.log(`[dbg] nav ${side}: ${url}`);
      wiring?.onNav(side, url);
    };
    const channels = {
      left: await attachSide(
        left,
        'left',
        reporterSource,
        (msg) => deferSignal('left', msg),
        deferNav,
      ),
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

    const q = (side: Side, expr: string): Promise<unknown> => evalIn(channels[side], expr);

    let s: Scenario;
    if (mode === 'live') {
      // 与浏览器插件验收相同的真实站点对;锚点表用扩展同款打包数据(经本地服务器)
      engine.loadSites([
        {
          id: 'orca',
          origin: 'https://www.onorca.dev/docs',
          mirror: 'https://lif3ng-vibe.github.io/docs-cn/orca',
          anchorMapUrl: `${server.base}/anchor-maps/orca.json`,
        },
      ]);
      s = {
        leftHome: 'https://www.onorca.dev/docs/agents/codex',
        rightHome: 'https://lif3ng-vibe.github.io/docs-cn/orca/agents/codex',
        anchorHash: '#setup',
        expectHeading: '安装',
        linkSelector: 'a[href="/docs/install"]',
        rightAfterLink: '/docs-cn/orca/install',
        navTimeout: 20000,
      };
    } else {
      const EN = `${server.base}/fixtures/en`;
      const ZH = `${server.base}/fixtures/zh`;
      engine.loadSites([
        {
          id: 'fixture',
          origin: EN,
          mirror: ZH,
          anchorMapUrl: `${ZH}/anchor-map.json`,
        },
      ]);
      s = {
        leftHome: `${EN}/index.html`,
        rightHome: `${ZH}/index.html`,
        anchorHash: '#launch-orca',
        expectHeading: '启动-orca',
        linkSelector: "a[href='page2.html']",
        rightAfterLink: '/zh/page2.html',
        navTimeout: 5000,
      };
    }

    await t('初始导航(对照打开)', async () => {
      await engine.open('left', s.leftHome);
      await engine.open('right', s.rightHome);
      await waitFor(
        async () => String(await q('left', 'location.href')).includes(new URL(s.leftHome).pathname),
        s.navTimeout,
        'left 加载',
      );
      await waitFor(
        async () => String(await q('right', 'location.href')).includes(new URL(s.rightHome).pathname),
        s.navTimeout,
        'right 加载',
      );
      // 真实站点渐进渲染,页高稳定后再测,否则标题位置/比例都在漂
      await waitPageStable(channels.left, s.navTimeout);
      await waitPageStable(channels.right, s.navTimeout);
    });

    await t('锚点表加载', async () => {
      const idx = await engine.anchorIndexFor(engine.getSiteList()[0]);
      assert(idx.size >= 3, `锚点映射 ${idx.size} < 3`);
    });

    await t('点标题对侧滚到对应标题', async () => {
      await evalIn(channels.left, `location.hash = ${JSON.stringify(s.anchorHash)}`);
      // 等 hashchange → bg:anchor → 对侧 smooth 滚动到位
      await waitFor(
        async () => String(await q('right', nearestHeadingExpr(200))) === s.expectHeading,
        Math.min(s.navTimeout, 8000),
        `right 视口顶标题到达 ${s.expectHeading}`,
      );
      const near = String(await q('right', nearestHeadingExpr(200)));
      const ry = Number(await q('right', 'window.scrollY'));
      const elTop = String(
        await q(
          'right',
          `(() => { const e = document.getElementById(${JSON.stringify(s.expectHeading)}); return e ? Math.round(e.getBoundingClientRect().top) : 'missing'; })()`,
        ),
      );
      assert(
        near === s.expectHeading,
        `right 视口顶标题=${near},期望 ${s.expectHeading};rightY=${ry};目标元素视口位置=${elTop}`,
      );
    });

    await t('语义滚动(高度不对称文档)', async () => {
      const before = Number(await q('right', 'window.scrollY'));
      // 等锚点阶段的 hashchange 抑制窗(1s)过去:自测的单次瞬时滚动
      // 若落在窗口内会被吞掉且不会再有事件(真人连续滚动无此问题)
      await wait(1300);
      // 滚到 0.85:跨过锚点区间,对侧语义位置必然明显变化
      await evalIn(
        channels.left,
        'window.scrollTo(0, Math.floor(document.body.scrollHeight * 0.85))',
      );
      await wait(400);
      const ly = Number(await q('left', 'window.scrollY'));
      const diag = String(
        await q(
          'left',
          `[document.body.scrollHeight, window.innerHeight, document.readyState, window.__dcScrollEvents ? window.__dcScrollEvents() : 'x', window.__dcScrollState ?? 'x', location.href].join(' | ')`,
        ),
      );
      await waitSettled(channels.right, Math.min(s.navTimeout, 8000));
      const y = Number(await q('right', 'window.scrollY'));
      assert(ly > 100, `left 未滚动(scrollY=${ly};${diag})`);
      assert(Math.abs(y - before) > 50, `right 未跟随(${before} → ${y},left=${ly})`);
    });

    await t('点链接同步到对侧页面', async () => {
      await evalIn(
        channels.left,
        `document.querySelector(${JSON.stringify(s.linkSelector)}).click()`,
      );
      await waitFor(
        async () => String(await q('right', 'location.href')).includes(s.rightAfterLink),
        s.navTimeout,
        `right 跳转到 ${s.rightAfterLink}`,
      );
    });
  } catch (e) {
    results.push({ name: 'selftest 执行', pass: false, detail: String((e as Error)?.message ?? e) });
    console.error('[dc/selftest] 执行异常:', e);
  }
  finish();
}
