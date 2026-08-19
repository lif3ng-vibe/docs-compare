/**
 * puppeteer-core 接线层:启动/连接浏览器、开两页、平铺窗口、
 * 每页一条自有 CDP session 承载全部通道:
 *
 * - 上行:Runtime.addBinding('dcReport') + Runtime.bindingCalled
 * - 注入:Page.addScriptToEvaluateOnNewDocument(__DC_VIEW__ 前缀 + reporter bundle)
 * - 导航事件:Page.frameNavigated(整页)+ Page.navigatedWithinDocument(hash/pushState)
 * - 下行/驱动:Runtime.evaluate(__dcApply) / Page.navigate
 */
import puppeteer from 'puppeteer-core';
import type { Browser, CDPSession, Page } from 'puppeteer-core';
import type { Protocol } from 'puppeteer-core';
import type { Engine, EnginePort, Side } from './engine';
import { parseContentMsg } from './protocol';
import type { ReportEnvelope } from './protocol';

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface LaunchOptions {
  /** 连接已运行的 Chrome(端口或 http://127.0.0.1:port);缺省则自启临时 profile */
  attach?: string;
  userDataDir?: string;
  headless?: boolean;
}

export async function launchOrAttach(opts: LaunchOptions): Promise<Browser> {
  if (opts.attach) {
    const url = /^\d+$/.test(opts.attach) ? `http://127.0.0.1:${opts.attach}` : opts.attach;
    console.warn(
      `[dc] attach 模式:连接 ${url}。调试端口对本机所有进程可见,用完请关闭 Chrome。`,
    );
    return puppeteer.connect({ browserURL: url, defaultViewport: null });
  }
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  try {
    return await puppeteer.launch({
      // 系统装好的 Chrome(与浏览器插件同款真实环境);可用环境变量覆盖路径
      executablePath: envPath || undefined,
      channel: envPath ? undefined : 'chrome',
      headless: opts.headless ?? false,
      userDataDir: opts.userDataDir,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        // 窗口被遮挡/失焦时保持渲染与动画:平滑滚动同步不因后台化而冻结
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        // CI 容器里 Chrome 以高权限跑,必须关沙箱才能启动
        ...(process.env.CI ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
      ],
      defaultViewport: null,
    });
  } catch (e) {
    if (!envPath) {
      throw new Error(
        `未找到系统 Chrome(${(e as Error).message})。可设置 PUPPETEER_EXECUTABLE_PATH 指向浏览器可执行文件。`,
      );
    }
    throw e;
  }
}

// ---------- 浏览器级 CDP session(复用一个连接) ----------
const browserSessions = new WeakMap<Browser, Promise<CDPSession>>();
function browserSession(browser: Browser): Promise<CDPSession> {
  let s = browserSessions.get(browser);
  if (!s) {
    s = browser.target().createCDPSession();
    browserSessions.set(browser, s);
  }
  return s;
}

/** 新建独立窗口中的空白页(Target.createTarget 的实验性 newWindow) */
export async function newWindowPage(browser: Browser): Promise<Page> {
  const before = new Set(await browser.pages());
  const bs = await browserSession(browser);
  await bs.send('Target.createTarget', { url: 'about:blank', newWindow: true });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const found = (await browser.pages()).find((p) => !before.has(p));
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('新窗口目标未出现(Target.createTarget 超时)');
}

/** page → targetId(Browser.setWindowBounds 平铺要用;内部字段,puppeteer 多年稳定) */
function targetIdOf(page: Page): string {
  return (page.target() as unknown as { _targetId: string })._targetId;
}

/**
 * 左右平铺:各占 region 一半;region 缺省用左侧窗口当前 bounds。
 * 平铺失败(如无头模式)只警告不影响同步。
 */
export async function tileWindows(
  browser: Browser,
  left: Page,
  right: Page,
  region?: Rect,
): Promise<void> {
  try {
    const bs = await browserSession(browser);
    const lw = await bs.send('Browser.getWindowForTarget', { targetId: targetIdOf(left) });
    const rw = await bs.send('Browser.getWindowForTarget', { targetId: targetIdOf(right) });
    const r =
      region ??
      {
        left: lw.bounds.left ?? 40,
        top: lw.bounds.top ?? 40,
        width: lw.bounds.width ?? 1600,
        height: lw.bounds.height ?? 900,
      };
    const w = Math.floor(r.width / 2);
    await bs.send('Browser.setWindowBounds', {
      windowId: lw.windowId,
      bounds: { windowState: 'normal', left: r.left, top: r.top, width: w, height: r.height },
    });
    await bs.send('Browser.setWindowBounds', {
      windowId: rw.windowId,
      bounds: {
        windowState: 'normal',
        left: r.left + w,
        top: r.top,
        width: r.width - w,
        height: r.height,
      },
    });
  } catch (e) {
    console.warn('[dc] 窗口平铺失败(不影响同步):', (e as Error).message);
  }
}

// ---------- 每页通道 ----------

export interface SideChannel {
  page: Page;
  session: CDPSession;
}

/**
 * 给一页接上全部通道。reporterSource 为 reporter bundle 源码;
 * onSignal/onNav 由调用方汇入 engine(信号已含 view,无需再传 side)。
 */
export async function attachSide(
  page: Page,
  view: Side,
  reporterSource: string,
  onSignal: (msg: ReportEnvelope) => void,
  onNav: (side: Side, url: string) => void,
): Promise<SideChannel> {
  const session = await page.createCDPSession();
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await session.send('Runtime.addBinding', { name: 'dcReport' });
  const prelude = `window.__DC_VIEW__=${JSON.stringify(view)};`;
  await session.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `${prelude}\n${reporterSource}`,
  });
  // 当前已加载的文档补注入一次(新文档由 init script 覆盖)
  await session
    .send('Runtime.evaluate', { expression: prelude + reporterSource })
    .catch(() => undefined);

  session.on('Runtime.bindingCalled', (ev: Protocol.Runtime.BindingCalledEvent) => {
    if (ev.name !== 'dcReport') return;
    try {
      onSignal(JSON.parse(ev.payload) as ReportEnvelope);
    } catch {
      // 页面侧组装异常,忽略
    }
  });
  session.on('Page.navigatedWithinDocument', (ev: Protocol.Page.NavigatedWithinDocumentEvent) =>
    onNav(view, ev.url),
  );
  session.on('Page.frameNavigated', (ev: Protocol.Page.FrameNavigatedEvent) => {
    // 只看主框架(子框架 parentId 非空)
    if (ev.frame.parentId === undefined) onNav(view, ev.frame.url);
  });
  return { page, session };
}

// ---------- engine 的 Port 实现 ----------

/** 信号串行队列:并发导航事件按序汇入 engine,保证收敛确定性 */
export function wireEngine(
  engine: Engine,
  channels: Record<Side, SideChannel>,
): {
  port: EnginePort;
  onSignal: (side: Side, msg: ReportEnvelope) => void;
  onNav: (side: Side, url: string) => void;
} {
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (fn: () => Promise<void>): void => {
    chain = chain.then(fn).catch((e) => console.warn('[dc] 信号处理错误:', e));
  };
  const debug = !!process.env.DC_DEBUG;
  const port: EnginePort = {
    navigate: async (side, url) => {
      if (debug) console.log(`[dbg] drive ${side} → ${url}`);
      await channels[side].session
        .send('Page.navigate', { url })
        .catch((e) => console.warn(`[dc] ${side} 导航失败:`, (e as Error).message));
    },
    apply: async (side, msg) => {
      if (debug) console.log(`[dbg] apply ${side} ←`, JSON.stringify(msg));
      await evalIn(channels[side], `window.__dcApply && __dcApply(${JSON.stringify(msg)})`);
    },
  };
  const onSignal = (side: Side, p: ReportEnvelope): void => {
    if (p.view !== side) return; // 防串扰:信封 view 必须与通道一致
    const msg = parseContentMsg(p);
    if (msg) enqueue(() => engine.handleSignal(side, msg));
  };
  const onNav = (side: Side, url: string): void => {
    enqueue(() => engine.handleNav(side, url));
  };
  return { port, onSignal, onNav };
}

/** 在一页上执行表达式(导航中上下文销毁时返回 undefined,不抛) */
export async function evalIn(ch: SideChannel, expr: string): Promise<unknown> {
  try {
    const r = await ch.session.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return (r as { result?: { value?: unknown } }).result?.value;
  } catch {
    return undefined;
  }
}
