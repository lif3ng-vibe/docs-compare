/**
 * WKWebView 版控制器(Tauri 版 controller.ts 的平移):
 * 信号(dcReport 消息)→ core 映射 → dc_eval 驱动对侧视图。
 * 本页同时是宿主 UI:顶部工具条 + 中间可拖分隔条(左右 webview 铺在两侧,
 * 中间 8px 缝隙露出本层拖拽手柄)。
 *
 * 传输层差异(vs Tauri):
 * - 上行 invoke:window.webkit.messageHandlers.dcInvoke.postMessage(JSON),
 *   原生经 window.__dcDispatch({t:'cmd:result',...}) 回填 Promise
 * - 信号:原生把 reporter 消息以 __dcDispatch({t:'signal',payload}) 推入
 * - 布局:分隔条数学改为「内容区偏移」(扣除安全区),dc_layout 上报偏移,
 *   原生按 ratio = 偏移/可用宽度 换算(语义与 Tauri 版一致)
 * - 模式:单文档/对照可切(dc_set_mode);原生裁决生效模式并回推 dc:mode
 *
 * selftest 模式(Swift 注入 window.__DC_SELFTEST__):
 * - true:fixtures 双语站(离线、快速)
 * - 'live':与浏览器插件相同的真实文档(onorca.dev ↔ GitHub Pages 镜像)
 */
import {
  AnchorIndex,
  PageIndex,
  buildUrl,
  defaultAnchorMapUrl,
  defaultPageMapUrl,
  fetchRemoteSites,
  mapUrl,
  normalizePathKey,
  parseSites,
} from '@docs-compare/core';
import type { SitePair, SyncSettings } from '@docs-compare/core';

const TOOLBAR_H = 44;
const GAP = 8;
const DEFAULT_SETTINGS: SyncSettings = {
  navSync: true,
  scrollSync: true,
  semanticScroll: true,
  focusCss: false,
  layout: 'windows', // 双视图固定;此字段仅保持 schema 一致
};

// ---------- 状态 ----------
let sites: SitePair[] = [];
const settings: SyncSettings = { ...DEFAULT_SETTINGS };
const viewUrls: Record<string, string> = { left: 'about:blank', right: 'about:blank' };
const pendingUrl = new Map<string, string>();
const anchorCache = new Map<string, Promise<AnchorIndex>>();
const EMPTY_INDEX = AnchorIndex.fromRaw({});

// ---------- 单窗口标识 ----------
// Swift 侧恒定单窗口 w1,视图标签 w1-left/w1-right。
/** 上报载荷 view(完整标签 w1-left/right)剥出视图名;格式不合法返回 null。
 *  Swift 路由已按视图定向,这里格式过滤是双保险 */
function parseView(view: string | undefined): 'left' | 'right' | null {
  const m = /^w\d+-(left|right)$/.exec(view ?? '');
  return m ? (m[1] as 'left' | 'right') : null;
}

// ---------- 页面路径表(两侧逻辑路径不一致的站点) ----------
const pageCache = new Map<string, Promise<PageIndex>>();
const EMPTY_PAGE_INDEX = PageIndex.fromRaw({});

function pageIndexFor(site: SitePair): Promise<PageIndex> {
  let p = pageCache.get(site.id);
  if (!p) {
    const path = site.pageMapUrl ?? defaultPageMapUrl(site, site.anchorMapUrl) ?? '';
    if (!path) {
      p = Promise.resolve(EMPTY_PAGE_INDEX);
    } else {
      const url = /^https?:/i.test(path) ? path : new URL(path, location.href).href;
      p = PageIndex.load(url).catch(() => EMPTY_PAGE_INDEX); // 不存在(404)静默退空表
    }
    pageCache.set(site.id, p);
  }
  return p;
}

/** mapUrl 包装:带上站点各自的页面路径表(含约定回退,故所有站点都查) */
async function mapUrlWithPages(rawUrl: string, sitesArr: SitePair[]) {
  for (const site of sitesArr) {
    const hit = await mapUrl(rawUrl, [site], { pageIndex: await pageIndexFor(site) });
    if (hit) return hit;
  }
  return mapUrl(rawUrl, sitesArr);
}

function resolveAnchorMapUrl(site: SitePair): string {
  const p = site.anchorMapUrl ?? defaultAnchorMapUrl(site);
  return /^https?:/i.test(p) ? p : new URL(p, location.href).href;
}
function anchorIndexFor(site: SitePair): Promise<AnchorIndex> {
  let p = anchorCache.get(site.id);
  if (!p) {
    const url = resolveAnchorMapUrl(site);
    p = AnchorIndex.load(url).catch((e) => {
      console.warn(`[dc] ${url} 加载失败,锚点原样透传:`, e);
      return EMPTY_INDEX;
    });
    anchorCache.set(site.id, p);
  }
  return p;
}

// ---------- 桥接:invoke / 信号(替换 @tauri-apps/api) ----------
interface WebkitHost {
  webkit?: {
    messageHandlers?: {
      dcInvoke?: { postMessage(s: string): void };
    };
  };
}
type DispatchMsg =
  | { t: 'cmd:result'; reqId: number; ok: boolean; value?: unknown; error?: string }
  | { t: 'signal'; payload: Record<string, unknown> }
  | { t: 'dc:mode'; mode: LayoutMode; side: SingleSide };

let invokeSeq = 0;
const invokeWaiters = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const signalSubs: ((p: Record<string, unknown>) => void)[] = [];

function invoke<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const host = window as typeof window & WebkitHost;
  const handler = host.webkit?.messageHandlers?.dcInvoke;
  if (!handler) return Promise.reject(new Error('webkit.messageHandlers.dcInvoke 不可用(非 WKWebView 宿主?)'));
  return new Promise((resolve, reject) => {
    const reqId = ++invokeSeq;
    invokeWaiters.set(reqId, {
      resolve: (v) => resolve(v as T),
      reject,
    });
    handler.postMessage(JSON.stringify({ cmd, reqId, args }));
  });
}
function onSignal(h: (p: Record<string, unknown>) => void): () => void {
  signalSubs.push(h);
  return () => {
    const i = signalSubs.indexOf(h);
    if (i >= 0) signalSubs.splice(i, 1);
  };
}
function installDispatch(): void {
  (window as unknown as { __dcDispatch?: (m: DispatchMsg) => void }).__dcDispatch = (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'cmd:result') {
      const w = invokeWaiters.get(m.reqId);
      if (!w) return;
      invokeWaiters.delete(m.reqId);
      if (m.ok) w.resolve(m.value);
      else w.reject(new Error(m.error ?? `invoke 失败:reqId=${m.reqId}`));
      return;
    }
    if (m.t === 'signal') {
      for (const h of [...signalSubs]) h(m.payload);
      return;
    }
    if (m.t === 'dc:mode') {
      effectiveMode = m.mode;
      sideRequested = m.side;
      applyModeUi();
    }
  };
}

// ---------- 驱动原语 ----------
async function evalIn(view: string, js: string): Promise<void> {
  await invoke('dc_eval', { target: view, js });
}
async function applyTo(view: string, msg: unknown): Promise<void> {
  await evalIn(view, `window.__dcApply && __dcApply(${JSON.stringify(msg)});`);
}
async function navigateTo(view: string, url: string): Promise<void> {
  viewUrls[view] = url;
  await invoke('dc_navigate', { target: view, url });
}

// ---------- 状态机(与 background.syncFrom 同构) ----------
async function syncFrom(view: 'left' | 'right', rawUrl: string): Promise<void> {
  const other = view === 'left' ? 'right' : 'left';
  if (!settings.navSync) return;
  if (pendingUrl.get(view) === rawUrl) {
    pendingUrl.delete(view);
    return;
  }
  viewUrls[view] = rawUrl;
  const src = await mapUrlWithPages(rawUrl, sites);
  syncSelectFromUrl(src?.site.id ?? null);
  if (!src) return;

  const anchor = decodeURIComponent(new URL(rawUrl).hash.replace(/^#/, ''));
  const mappedAnchor = anchor
    ? (await anchorIndexFor(src.site)).lookup(
        src.logicalPath,
        anchor,
        src.from === 'origin' ? 'toMirror' : 'toOrigin',
      )
    : null;

  const dst = await mapUrlWithPages(viewUrls[other], sites);
  const samePage =
    !!dst &&
    dst.site.id === src.site.id &&
    normalizePathKey(dst.logicalPath) === normalizePathKey(src.logicalPath);

  if (samePage) {
    if (mappedAnchor) await applyTo(other, { t: 'bg:anchor', anchor: mappedAnchor });
    return;
  }
  const target = src.url + (mappedAnchor ? `#${mappedAnchor}` : '');
  if ((viewUrls[other] ?? '').split('#')[0] === target.split('#')[0]) return;
  pendingUrl.set(other, target);
  await navigateTo(other, target);
}

async function onScroll(
  view: 'left' | 'right',
  topId: string | null,
  frac: number,
  ratio: number,
): Promise<void> {
  const other = view === 'left' ? 'right' : 'left';
  if (!settings.scrollSync) return;
  let anchorId: string | null = null;
  if (settings.semanticScroll && topId) {
    const src = await mapUrlWithPages(viewUrls[view], sites);
    if (src) {
      anchorId = (await anchorIndexFor(src.site)).lookup(
        src.logicalPath,
        topId,
        src.from === 'origin' ? 'toMirror' : 'toOrigin',
      );
    }
  }
  await applyTo(other, { t: 'bg:scroll', anchorId, frac, ratio });
}

// ---------- 信号接入 + 自测查询通道 ----------
let qid = 0;
const queryWaiters = new Map<string, (v: unknown) => void>();
// 窗口标题跟随在 Swift 原生实现(left webview 的 title KVO → scene.title):
// JS 信号里 cs:nav 发生在导航前(title 是旧页的)、cs:hello 时机不可靠,
// 都不如原生事件准。controller 不参与标题。

function query(view: string, expr: string, timeoutMs = 4000): Promise<unknown> {
  const name = `q${++qid}`;
  return new Promise((resolve, reject) => {
    let done = false;
    const off = onSignal((p) => {
      if (p?.t === 'test:info' && p.name === name) {
        done = true;
        queryWaiters.delete(name);
        off();
        resolve(p.value);
      }
    });
    queryWaiters.set(name, resolve);
    void evalIn(view, `window.__dcTest && __dcTest(${JSON.stringify(name)}, (${expr}));`).catch(() => {});
    setTimeout(() => {
      if (!done) {
        queryWaiters.delete(name);
        off();
        reject(new Error(`查询超时:${view}:${expr}`));
      }
    }, timeoutMs);
  });
}

// ---------- 安全区 + 布局 ----------
// divider 是「内容区内偏移」(扣除左右安全区);原生按
// ratio = divider / usableW 换算,与 Tauri 版的窗口内比例语义一致。
// 安全区数值用页面里的固定探针读 env()(旋转后 env() 自动更新,resize 重读)。
const insets = { left: 0, right: 0 };
const MIN_PANE = 120; // 与原生 LayoutMath 一致
let divider = 0;
let layoutTimer: number | undefined;

function readInsets(): void {
  const l = document.getElementById('sa-probe-l');
  const r = document.getElementById('sa-probe-r');
  if (l) insets.left = Math.max(0, l.getBoundingClientRect().left);
  if (r) insets.right = Math.max(0, window.innerWidth - r.getBoundingClientRect().left);
}
function usableW(): number {
  return Math.max(0, window.innerWidth - insets.left - insets.right);
}
function clampDivider(v: number): number {
  const u = usableW();
  const m = Math.min(MIN_PANE, u / 2);
  return Math.min(Math.max(v, m), u - m);
}
function scheduleLayout(): void {
  if (layoutTimer != null) return;
  layoutTimer = window.setTimeout(() => {
    layoutTimer = undefined;
    void invoke('dc_layout', {
      divider,
      width: usableW(),
      height: window.innerHeight,
    }).catch(() => {});
  }, 16);
}
function positionDividerEl(): void {
  const el = document.getElementById('divider');
  if (el) el.style.left = `${insets.left + divider}px`;
}

// ---------- 布局模式:单文档 / 对照 ----------
type LayoutMode = 'split' | 'single';
type SingleSide = 'origin' | 'mirror';
let modeRequested: LayoutMode = 'split';
let sideRequested: SingleSide = 'mirror'; // 单文档默认看译文
let effectiveMode: LayoutMode = 'split';

function loadModePrefs(): void {
  try {
    if (localStorage.getItem('dc.mode') === 'single') modeRequested = 'single';
    if (localStorage.getItem('dc.side') === 'origin') sideRequested = 'origin';
  } catch {
    // localStorage 不可用时静默用默认
  }
}
function applyModeUi(): void {
  document.body.classList.toggle('single', effectiveMode === 'single');
  const mt = document.getElementById('mode-toggle');
  if (mt) {
    mt.textContent = effectiveMode === 'single' ? '对照' : '单文';
    mt.title = effectiveMode === 'single' ? '切换到左右对照' : '切换到单文档';
  }
  document.getElementById('side-origin')?.classList.toggle('on', sideRequested === 'origin');
  document.getElementById('side-mirror')?.classList.toggle('on', sideRequested === 'mirror');
}
function showStatus(s: string): void {
  const status = document.getElementById('status');
  if (status) status.textContent = s;
}
async function requestMode(mode: LayoutMode, side?: SingleSide): Promise<void> {
  modeRequested = mode;
  if (side) sideRequested = side;
  try {
    localStorage.setItem('dc.mode', modeRequested);
    localStorage.setItem('dc.side', sideRequested);
  } catch {
    // ignore
  }
  try {
    const r = await invoke<{ mode: LayoutMode }>('dc_set_mode', { mode: modeRequested, side: sideRequested });
    effectiveMode = r.mode;
  } catch {
    // 壳未就绪时先按请求值渲染,后续 dc:mode 推送会纠正
  }
  applyModeUi();
  if (effectiveMode === 'single' && modeRequested === 'split') {
    showStatus('竖屏仅支持单文档,请横屏后对照');
  }
}

// ---------- 工具条站点下拉 ----------
/** 渲染站点下拉选项;sites 为空则禁用(仅剩占位项) */
function renderSiteSelect(): void {
  const sel = document.getElementById('site-select') as HTMLSelectElement | null;
  if (!sel) return;
  sel.replaceChildren();
  const ph = document.createElement('option');
  ph.value = '';
  ph.disabled = true;
  ph.selected = true;
  ph.textContent = '选择文档站点…';
  sel.appendChild(ph);
  for (const s of sites) {
    const opt = document.createElement('option');
    opt.value = s.id;
    // 官方双语站(origin/mirror 都是官方维护)打「官方」后缀,与我们维护的汉化镜像区分
    opt.textContent = s.official ? `${s.name ?? s.id}(官方)` : (s.name ?? s.id);
    sel.appendChild(opt);
  }
  sel.disabled = sites.length === 0;
}

/** 下拉选站:左右各开该站点首页(原站/镜像;单文档模式下隐藏侧同样导航,
 *  保持两侧同步,切回对照/转横屏即已就位) */
async function openSitePair(site: SitePair): Promise<void> {
  const leftUrl = buildUrl(site, 'origin', '/');
  const rightUrl = buildUrl(site, 'mirror', '/');
  await navigateTo('left', leftUrl);
  await navigateTo('right', rightUrl);
  const input = document.getElementById('url-left') as HTMLInputElement | null;
  if (input) input.value = leftUrl;
  syncSelectFromUrl(site.id);
  showStatus(`${site.id}:已对照打开`);
}

/** 导航后回填下拉:命中站点则切过去,否则回占位项(程序化赋值不触发 change,无回环) */
function syncSelectFromUrl(siteId: string | null): void {
  const sel = document.getElementById('site-select') as HTMLSelectElement | null;
  if (!sel) return;
  sel.value = siteId && sites.some((s) => s.id === siteId) ? siteId : '';
}

function wireUi(): void {
  readInsets();
  divider = clampDivider(Math.floor(usableW() / 2));
  positionDividerEl();
  scheduleLayout();
  let prevUsable = usableW();
  window.addEventListener('resize', () => {
    // 安全区可能随旋转变化:先重读,再按比例换算分隔条,最后上报
    readInsets();
    const u = usableW();
    if (prevUsable > 0 && u > 0) divider = clampDivider((divider / prevUsable) * u);
    prevUsable = u;
    positionDividerEl();
    scheduleLayout();
  });

  const dividerEl = document.getElementById('divider');
  if (dividerEl) {
    dividerEl.addEventListener('pointerdown', (e) => {
      dividerEl.classList.add('dragging');
      dividerEl.setPointerCapture(e.pointerId);
    });
    dividerEl.addEventListener('pointermove', (e) => {
      if (!dividerEl.classList.contains('dragging')) return;
      divider = clampDivider(e.clientX - insets.left);
      positionDividerEl();
      scheduleLayout();
    });
    const end = (e: PointerEvent): void => {
      if (!dividerEl.classList.contains('dragging')) return;
      dividerEl.classList.remove('dragging');
      dividerEl.releasePointerCapture(e.pointerId);
    };
    dividerEl.addEventListener('pointerup', end);
    dividerEl.addEventListener('pointercancel', end);
  }

  const siteSelect = document.getElementById('site-select') as HTMLSelectElement | null;
  siteSelect?.addEventListener('change', () => {
    const site = sites.find((s) => s.id === siteSelect.value);
    if (site) void openSitePair(site);
  });

  const input = document.getElementById('url-left') as HTMLInputElement | null;
  async function openPair(): Promise<void> {
    const url = input?.value?.trim();
    if (!url) return;
    const src = await mapUrlWithPages(url, sites);
    if (!src) {
      showStatus('URL 不匹配任何站点配置');
      return;
    }
    // mapUrl 的 src.url 是"映射后的对侧"地址;归一为 左=原站、右=镜像
    const leftUrl = src.from === 'origin' ? url : src.url;
    const rightUrl = src.from === 'mirror' ? url : src.url;
    await navigateTo('left', leftUrl);
    await navigateTo('right', rightUrl);
    syncSelectFromUrl(src.site.id);
    showStatus(`${src.site.id}:已对照打开`);
  }
  document.getElementById('open-pair')?.addEventListener('click', () => void openPair());
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void openPair();
  });

  // 布局模式:单文/对照切换;单文下选看原/译
  document.getElementById('mode-toggle')?.addEventListener('click', () => {
    void requestMode(effectiveMode === 'single' ? 'split' : 'single');
  });
  document.getElementById('side-origin')?.addEventListener('click', () => {
    void requestMode('single', 'origin');
  });
  document.getElementById('side-mirror')?.addEventListener('click', () => {
    void requestMode('single', 'mirror');
  });
}

// ---------- selftest ----------
interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

interface Scenario {
  /** 左右初始页(直接对照打开) */
  leftHome: string;
  rightHome: string;
  /** 锚点测试:左侧设此 hash,右侧应滚到 expectHeading */
  anchorHash: string;
  expectHeading: string;
  minScrollY: number;
  /** 链接测试:左页上此选择器的链接,右侧应到达 rightAfterLink */
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
/** 等页面加载稳定(真实站点渐进渲染,页高连续两次采样相同) */
async function waitPageStable(view: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let prev = -1;
  for (;;) {
    const h = Number(await query(view, 'document.body.scrollHeight'));
    if (h === prev && h > 0) return;
    if (Date.now() - start > timeoutMs) return;
    prev = h;
    await wait(500);
  }
}
function nearestHeadingExpr(tolerancePx: number): string {
  return `(() => {
    const skip = new Set(['_top', 'starlight__on-this-page']);
    const hs = [...document.querySelectorAll('h2[id], h3[id]')].filter((h) => !skip.has(h.id));
    let best = '';
    for (const h of hs) { if (h.getBoundingClientRect().top <= ${tolerancePx}) best = h.id; }
    return best;
  })()`;
}

async function selftest(mode: true | 'live'): Promise<void> {
  const results: TestResult[] = [];
  let phase = '未开始';
  (window as unknown as { __DC_PHASE__?: string }).__DC_PHASE__ = phase;
  const t = async (name: string, fn: () => Promise<void>): Promise<void> => {
    phase = name;
    (window as unknown as { __DC_PHASE__?: string }).__DC_PHASE__ = name;
    try {
      await fn();
      results.push({ name, pass: true, detail: '' });
    } catch (e) {
      results.push({ name, pass: false, detail: String(e) });
    }
  };

  let s: Scenario;
  if (mode === 'live') {
    // 与浏览器插件验收相同的真实站点对;锚点表用扩展同款打包数据
    sites = [
      {
        id: 'orca',
        origin: 'https://www.onorca.dev/docs',
        mirror: 'https://lif3ng-vibe.github.io/docs-cn/orca',
        anchorMapUrl: new URL('anchor-maps/orca.json', location.href).href,
      },
    ];
    s = {
      leftHome: 'https://www.onorca.dev/docs/agents/codex',
      rightHome: 'https://lif3ng-vibe.github.io/docs-cn/orca/agents/codex',
      anchorHash: '#setup',
      expectHeading: '安装',
      minScrollY: 80,
      linkSelector: 'a[href="/docs/install"]',
      rightAfterLink: '/docs-cn/orca/install',
      navTimeout: 20000,
    };
  } else {
    const EN = `${location.origin}/fixtures/en`;
    const ZH = `${location.origin}/fixtures/zh`;
    sites = [
      {
        id: 'fixture',
        origin: EN,
        mirror: ZH,
        anchorMapUrl: `${ZH}/anchor-map.json`,
      },
    ];
    s = {
      leftHome: `${EN}/index.html`,
      rightHome: `${ZH}/index.html`,
      anchorHash: '#launch-orca',
      expectHeading: '启动-orca',
      minScrollY: 300,
      linkSelector: "a[href='page2.html']",
      rightAfterLink: '/zh/page2.html',
      navTimeout: 5000,
    };
  }

  await t('初始导航(对照打开)', async () => {
    // 等 Swift 侧 left/right webview 都创建好再导航(协议轮询,与 Tauri 版同因)
    await waitFor(async () => Boolean(await invoke('dc_ready')), 10000, 'left/right webview 就绪');
    await navigateTo('left', s.leftHome);
    await navigateTo('right', s.rightHome);
    // query 是单发+等回信:eval 若落在「导航已提交、reporter 未装好」的窗口会被
    // __dcTest undefined 静默吞掉,4s 后 reject。这里把超时当"还没好"继续轮询,
    // 否则第一发撞上加载窗口整个用例就掀桌(改用短超时快速进入下一轮)。
    await waitFor(
      async () =>
        String(
          await query('left', 'location.href', 800).catch(() => ''),
        ).includes(new URL(s.leftHome).pathname),
      s.navTimeout,
      'left 加载',
    );
    await waitFor(
      async () =>
        String(
          await query('right', 'location.href', 800).catch(() => ''),
        ).includes(new URL(s.rightHome).pathname),
      s.navTimeout,
      'right 加载',
    );
    // 真实站点渐进渲染,页高稳定后再测,否则标题位置/比例都在漂
    await waitPageStable('left', s.navTimeout);
    await waitPageStable('right', s.navTimeout);
  });

  await t('锚点表加载', async () => {
    const idx = await anchorIndexFor(sites[0]);
    assert(idx.size >= 3, `锚点映射 ${idx.size} < 3`);
  });

  await t('点标题对侧滚到对应标题', async () => {
    await evalIn('left', `location.hash = ${JSON.stringify(s.anchorHash)}`);
    // 不轮询:evaluateJavaScript 会打断 WebKit 的顺滑滚动动画,
    // 固定等待动画结束后单次查询。iOS WKWebView 的动画比桌面长(窄视口
    // 长距离缓动可达数秒),等待比 Tauri 版加长
    await wait(4200);
    const near = String(await query('right', nearestHeadingExpr(200)));
    const ry = Number(await query('right', 'window.scrollY'));
    const elTop = String(
      await query('right', `(() => { const e = document.getElementById(${JSON.stringify(s.expectHeading)}); return e ? Math.round(e.getBoundingClientRect().top) : 'missing'; })()`),
    );
    assert(
      near === s.expectHeading,
      `right 视口顶标题=${near},期望 ${s.expectHeading};rightY=${ry};目标元素视口位置=${elTop};innerW=${String(
        await query('right', 'window.innerWidth'),
      )};scale=${String(await query('right', '(window.visualViewport ? visualViewport.scale : -1)'))}`,
    );
  });

  await t('语义滚动(高度不对称文档)', async () => {
    const before = Number(await query('right', 'window.scrollY'));
    // 等锚点阶段的 hashchange 抑制窗(1s)过去:自测的单次瞬时滚动
    // 若落在窗口内会被吞掉且不会再有事件(真人连续滚动无此问题)
    await wait(1300);
    // 滚到 0.85:跨过锚点区间,对侧语义位置必然明显变化
    await evalIn('left', `window.scrollTo(0, Math.floor(document.body.scrollHeight * 0.85))`);
    await wait(400);
    const ly = Number(await query('left', 'window.scrollY'));
    // WKWebView 上不能轮询等停稳:每次 evaluateJavaScript 都会打断顺滑滚动
    // 动画(Tauri 桌面版 waitSettled 在此不适用),固定等待后单次查询
    await wait(4200);
    const y = Number(await query('right', 'window.scrollY'));
    assert(ly > 100, `left 未滚动(scrollY=${ly})`);
    assert(Math.abs(y - before) > 50, `right 未跟随(${before} → ${y},left=${ly})`);
  });

  await t('点链接同步到对侧页面', async () => {
    await evalIn('left', `document.querySelector(${JSON.stringify(s.linkSelector)}).click()`);
    await waitFor(
      async () =>
        String(
          await query('right', 'location.href', 800).catch(() => ''),
        ).includes(s.rightAfterLink),
      s.navTimeout,
      `right 跳转到 ${s.rightAfterLink}`,
    );
  });

  const pass = results.filter((r) => r.pass).length;
  await invoke('dc_selftest_done', {
    results: JSON.stringify({ pass, total: results.length, results }, null, 2),
  });
}

// ---------- 启动 ----------
async function main(): Promise<void> {
  // 看门狗 + 未捕获异常:selftest 模式下任何卡死/报错都要给 Swift 一个交代
  const mode = (window as unknown as { __DC_SELFTEST__?: true | 'live' }).__DC_SELFTEST__;
  if (mode) {
    let done = false;
    const bail = (why: string): void => {
      if (done) return;
      done = true;
      void invoke('dc_selftest_done', {
        results: JSON.stringify(
          { pass: 0, total: 1, results: [{ name: 'selftest 执行', pass: false, detail: why }] },
          null,
          2,
        ),
      }).catch(() => {});
    };
    window.addEventListener('error', (e) => bail(`window.onerror: ${e.message}`));
    window.addEventListener('unhandledrejection', (e) => bail(`unhandledrejection: ${String(e.reason)}`));
    setTimeout(
      () =>
        bail(
          `看门狗超时(90s,卡在:${
            (window as unknown as { __DC_PHASE__?: string }).__DC_PHASE__ ?? '未知'
          })`,
        ),
      90_000,
    );
  }

  installDispatch();
  onSignal((p) => {
    if (!p) return;
    if (p.t === 'test:info') {
      const name = p.name as string | undefined;
      const w = name ? queryWaiters.get(name) : undefined;
      if (name && w) {
        queryWaiters.delete(name);
        w(p.value);
      }
      return;
    }
    const view = parseView(p.view as string | undefined);
    if (!view) return; // 非 w{n}-left/right 格式的信号(路由已定向,格式过滤双保险)
    if (p.t === 'cs:hello') viewUrls[view] = (p.href as string) ?? viewUrls[view];
    else if (p.t === 'cs:nav') void syncFrom(view, p.href as string);
    else if (p.t === 'cs:scroll') void onScroll(view, (p.topId as string | null) ?? null, (p.frac as number) ?? 0, (p.ratio as number) ?? 0);
  });

  if (mode) {
    // selftest 自带站点配置,不渲染下拉(避免干扰测试 UI)
  } else {
    try {
      const res = await fetch('sites.json');
      if (res.ok) {
        const { sites: parsed, errors } = parseSites(await res.json());
        if (errors.length) console.warn('[dc] 站点配置问题:', errors);
        sites = parsed;
      }
    } catch (e) {
      console.warn('[dc] sites.json 加载失败:', e);
    }
    renderSiteSelect();
    // 远程热更:打包配置先用(秒开),后台拉 Release 固定地址的 sites.json;
    // 成功则整体替换并重渲染下拉——新增站点免发版即得。失败静默退打包版。
    void fetchRemoteSites().then((remote) => {
      if (!remote || remote.length === 0) return;
      sites = remote;
      renderSiteSelect();
    });
  }

  wireUi();
  loadModePrefs();
  applyModeUi();
  // 与壳同步模式(拿回生效模式;竖屏 iPhone 会被原生裁成 single 并回推)
  void requestMode(modeRequested);
  if (mode) await selftest(mode);
}

void main();
