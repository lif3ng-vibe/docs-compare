/**
 * Tauri 版控制器(background.ts 的平移):
 * 信号(dc-report 事件)→ core 映射 → dc_eval 驱动对侧视图。
 * 本页同时是宿主 UI:顶部工具条 + 中间可拖分隔条(左右 webview 铺在两侧,
 * 中间 8px 缝隙露出本层拖拽手柄)。
 *
 * selftest 模式(Rust 注入 window.__DC_SELFTEST__):
 * - true:fixtures 双语站(离线、快速)
 * - 'live':与浏览器插件相同的真实文档(onorca.dev ↔ GitHub Pages 镜像)
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
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
  layout: 'windows', // Tauri 版固定双视图,此字段仅保持 schema 一致
};

// ---------- 状态 ----------
let sites: SitePair[] = [];
const settings: SyncSettings = { ...DEFAULT_SETTINGS };
const viewUrls: Record<string, string> = { left: 'about:blank', right: 'about:blank' };
const pendingUrl = new Map<string, string>();
const anchorCache = new Map<string, Promise<AnchorIndex>>();
const EMPTY_INDEX = AnchorIndex.fromRaw({});

// ---------- 多窗口:本窗口标识 ----------
// controller 自身标签形如 w{n}-controller;剥 -controller 得窗口标签 w{n}。
// 非 Tauri 环境直接浏览器开 index.html 时回退 w1(行为同首窗)。
const WINDOW_LABEL = (() => {
  try {
    return getCurrentWindow().label.replace(/-controller$/, '');
  } catch {
    return 'w1';
  }
})();
/** 上报载荷 view(完整标签 w{n}-left/right)剥出视图名;格式不合法返回 null。
 *  Rust 转发已按窗口定向,这里格式过滤是双保险 */
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
// 窗口标题跟随在 Rust 原生实现(left webview 的 on_document_title_changed
// → set_title):JS 信号里 cs:nav 发生在导航前(title 是旧页的)、cs:hello 在
// WebView2 首载不可靠,都不如原生事件准。controller 不参与标题。

function query(view: string, expr: string, timeoutMs = 4000): Promise<unknown> {
  const name = `q${++qid}`;
  return new Promise((resolve, reject) => {
    let done = false;
    const off = listen('dc-signal', (e) => {
      const p = e.payload as { t?: string; name?: string; value?: unknown };
      if (p?.t === 'test:info' && p.name === name) {
        done = true;
        queryWaiters.delete(name);
        void off.then((u) => u());
        resolve(p.value);
      }
    });
    queryWaiters.set(name, resolve);
    void evalIn(view, `window.__dcTest && __dcTest(${JSON.stringify(name)}, (${expr}));`).catch(() => {});
    setTimeout(() => {
      if (!done) {
        queryWaiters.delete(name);
        void off.then((u) => u());
        reject(new Error(`查询超时:${view}:${expr}`));
      }
    }, timeoutMs);
  });
}

// ---------- 布局 ----------
let divider = Math.floor(window.innerWidth / 2);
let layoutTimer: number | undefined;
function scheduleLayout(): void {
  if (layoutTimer != null) return;
  layoutTimer = window.setTimeout(() => {
    layoutTimer = undefined;
    void invoke('dc_layout', {
      divider,
      width: window.innerWidth,
      height: window.innerHeight,
    });
  }, 16);
}
function positionDividerEl(): void {
  const el = document.getElementById('divider');
  if (el) el.style.left = `${divider}px`;
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

/** 下拉选站:左右各开该站点首页(原站/镜像) */
async function openSitePair(site: SitePair): Promise<void> {
  const leftUrl = buildUrl(site, 'origin', '/');
  const rightUrl = buildUrl(site, 'mirror', '/');
  await navigateTo('left', leftUrl);
  await navigateTo('right', rightUrl);
  const input = document.getElementById('url-left') as HTMLInputElement | null;
  if (input) input.value = leftUrl;
  syncSelectFromUrl(site.id);
  const status = document.getElementById('status');
  if (status) status.textContent = `${site.id}:已对照打开`;
}

/** 导航后回填下拉:命中站点则切过去,否则回占位项(程序化赋值不触发 change,无回环) */
function syncSelectFromUrl(siteId: string | null): void {
  const sel = document.getElementById('site-select') as HTMLSelectElement | null;
  if (!sel) return;
  sel.value = siteId && sites.some((s) => s.id === siteId) ? siteId : '';
}

function wireUi(): void {
  positionDividerEl();
  scheduleLayout();
  let prevW = window.innerWidth;
  window.addEventListener('resize', () => {
    // 分隔条按比例跟随窗口宽度(默认 50/50,拖过则保持拖动比例)
    const nw = window.innerWidth;
    if (prevW > 0 && nw > 0) {
      divider = Math.min(Math.max((divider / prevW) * nw, 180), nw - 180);
    }
    prevW = nw;
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
      divider = Math.min(Math.max(e.clientX, 180), window.innerWidth - 180);
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
  const status = document.getElementById('status');
  const show = (s: string): void => {
    if (status) status.textContent = s;
  };
  async function openPair(): Promise<void> {
    const url = input?.value?.trim();
    if (!url) return;
    const src = await mapUrlWithPages(url, sites);
    if (!src) {
      show('URL 不匹配任何站点配置');
      return;
    }
    // mapUrl 的 src.url 是"映射后的对侧"地址;归一为 左=原站、右=镜像
    const leftUrl = src.from === 'origin' ? url : src.url;
    const rightUrl = src.from === 'mirror' ? url : src.url;
    await navigateTo('left', leftUrl);
    await navigateTo('right', rightUrl);
    syncSelectFromUrl(src.site.id);
    show(`${src.site.id}:已对照打开`);
  }
  document.getElementById('open-pair')?.addEventListener('click', () => void openPair());
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void openPair();
  });

  // 新窗口:干净初始态(blank 两视图),本窗口状态不受影响
  document.getElementById('new-window')?.addEventListener('click', () => {
    invoke('dc_new_window')
      .then((label) => show(`已开新窗口 ${String(label)}`))
      .catch((e: unknown) => show(`开窗失败:${String(e)}`));
  });

  // 缩放快捷键:焦点在工具条时内容页收不到键盘事件,这里补一份
  // (与 reporter 的监听同一协议:cs:zoom → dc_zoom)
  window.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const dir =
      e.key === '=' || e.key === '+' ? 1 : e.key === '-' || e.key === '_' ? -1 : e.key === '0' ? 0 : null;
    if (dir === null) return;
    e.preventDefault();
    void invoke('dc_zoom', { dir }).catch(() => {});
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
  const t = async (name: string, fn: () => Promise<void>): Promise<void> => {
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
    // 等 Rust 侧 left/right webview 都创建好再导航:
    // WebView2 初始化有快慢,不等会撞上 "no webview: right" 竞态。
    // (不能用 cs:hello:WebView2 对首次加载不跑 initialization_script,
    // blank.html 的 hello 只在导航后的页面才上报,平台行为不可靠)
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
    // 固定等待动画结束后单次查询
    await wait(2200);
    const near = String(await query('right', nearestHeadingExpr(200)));
    const ry = Number(await query('right', 'window.scrollY'));
    const elTop = String(
      await query('right', `(() => { const e = document.getElementById(${JSON.stringify(s.expectHeading)}); return e ? Math.round(e.getBoundingClientRect().top) : 'missing'; })()`),
    );
    assert(
      near === s.expectHeading,
      `right 视口顶标题=${near},期望 ${s.expectHeading};rightY=${ry};目标元素视口位置=${elTop}`,
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
    // WebKit(macOS wry)上不能轮询等停稳:每次 evaluateJavaScript 都会打断
    // 顺滑滚动动画,固定等待后单次查询(Windows WebView2 轮询无此问题,
    // 但定点等待同样成立)
    await wait(2600);
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

  await t('键盘缩放(Ctrl/Cmd± 两侧同步)', async () => {
    // 页面缩放后 layout viewport 的 CSS 像素数变化:放大 → innerWidth 变小
    const w0 = Number(await query('left', 'window.innerWidth'));
    const w0r = Number(await query('right', 'window.innerWidth'));
    await evalIn('left', `window.dispatchEvent(new KeyboardEvent('keydown', {key: '=', metaKey: true, ctrlKey: true}))`);
    await waitFor(
      async () => Number(await query('left', 'window.innerWidth', 800).catch(() => w0)) < w0 * 0.95,
      4000,
      'left innerWidth 缩小(放大生效)',
    );
    const w1r = Number(await query('right', 'window.innerWidth'));
    assert(w1r < w0r * 0.95, `right 未同步缩放(${w0r} → ${w1r})`);
    await evalIn('left', `window.dispatchEvent(new KeyboardEvent('keydown', {key: '0', metaKey: true, ctrlKey: true}))`);
    await wait(700);
    const w2 = Number(await query('left', 'window.innerWidth'));
    assert(Math.abs(w2 - w0) <= 3, `复位偏差(${w0} → ${w2})`);
  });

  const pass = results.filter((r) => r.pass).length;
  await invoke('dc_selftest_done', {
    results: JSON.stringify({ pass, total: results.length, results }, null, 2),
  });
}

/** 多窗口自测:开第二窗口 → 独立导航 → 断言隔离与标题跟随(fixture 离线站)。
 *  对窗口 2 的操作走 dc_eval/dc_navigate 的完整标签逃生门(w2-left 直达,
 *  Rust 侧不拼发起窗口前缀),不依赖窗口 2 自己的 controller */
async function multiwindowSelftest(): Promise<void> {
  const results: TestResult[] = [];
  const t = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      results.push({ name, pass: true, detail: '' });
    } catch (e) {
      results.push({ name, pass: false, detail: String(e) });
    }
  };

  const EN = `${location.origin}/fixtures/en`;
  const ZH = `${location.origin}/fixtures/zh`;
  sites = [
    { id: 'fixture', origin: EN, mirror: ZH, anchorMapUrl: `${ZH}/anchor-map.json` },
  ];

  // 窗口 1:与 fixture 自测相同的初始导航
  await waitFor(async () => Boolean(await invoke('dc_ready')), 10000, '窗口1 left/right 就绪');
  await navigateTo('left', `${EN}/index.html`);
  await navigateTo('right', `${ZH}/index.html`);
  await waitFor(
    async () =>
      String(await query('left', 'location.href', 800).catch(() => '')).includes(
        '/fixtures/en/index.html',
      ),
    8000,
    '窗口1 left 加载',
  );
  await waitFor(
    async () =>
      String(await query('right', 'location.href', 800).catch(() => '')).includes(
        '/fixtures/zh/index.html',
      ),
    8000,
    '窗口1 right 加载',
  );

  let w2 = '';
  await t('开第二窗口', async () => {
    w2 = String(await invoke('dc_new_window'));
    assert(/^w\d+$/.test(w2), `新窗口标签格式异常:${w2}`);
    // 窗口 2 内容视图就绪(其 controller 同样在跑,断言只走逃生门不经过它)
    await waitFor(
      async () => {
        try {
          await invoke('dc_eval', {
            target: `${w2}-left`,
            js: 'window.__dcTest && __dcTest("w2probe", location.href)',
          });
          return true;
        } catch {
          return false;
        }
      },
      10000,
      `窗口2 ${w2}-left 可用`,
    );
  });

  await t('窗口2 独立导航 page2', async () => {
    await invoke('dc_navigate', { target: `${w2}-left`, url: `${EN}/page2.html` });
    await invoke('dc_navigate', { target: `${w2}-right`, url: `${ZH}/page2.html` });
    await waitFor(
      async () =>
        String(await query(`${w2}-left`, 'location.href', 800).catch(() => '')).includes(
          '/fixtures/en/page2.html',
        ),
      8000,
      `窗口2 ${w2}-left 到 page2`,
    );
    await waitFor(
      async () =>
        String(await query(`${w2}-right`, 'location.href', 800).catch(() => '')).includes(
          '/fixtures/zh/page2.html',
        ),
      8000,
      `窗口2 ${w2}-right 到 page2`,
    );
  });

  await t('两窗口互不干扰', async () => {
    const l1 = String(await query('left', 'location.href', 2000));
    assert(l1.includes('/fixtures/en/index.html'), `窗口1 left 被带偏:${l1}`);
    const r1 = String(await query('right', 'location.href', 2000));
    assert(r1.includes('/fixtures/zh/index.html'), `窗口1 right 被带偏:${r1}`);
  });

  await t('窗口1 内导航不影响窗口2', async () => {
    // 窗口1 左侧跳 page2;窗口2 两视图 URL 必须纹丝不动
    await evalIn('left', `document.querySelector("a[href='page2.html']").click()`);
    await waitFor(
      async () =>
        String(await query('right', 'location.href', 800).catch(() => '')).includes(
          '/fixtures/zh/page2.html',
        ),
      8000,
      '窗口1 right 跟随到 page2',
    );
    const w2l = String(await query(`${w2}-left`, 'location.href', 2000));
    assert(w2l.includes('/fixtures/en/page2.html'), `窗口2 left 异常(应为 page2):${w2l}`);
  });

  await t('标题各随各窗口', async () => {
    await wait(1200); // 等 cs:nav → dc_set_title 传播
    const t1 = String(await invoke('dc_window_title', { label: 'w1' }));
    const t2 = String(await invoke('dc_window_title', { label: w2 }));
    assert(t1 === 'Fixture EN — Page 2', `窗口1 标题=${t1},期望 Fixture EN — Page 2`);
    assert(t2 === 'Fixture EN — Page 2', `窗口2 标题=${t2},期望 Fixture EN — Page 2`);
  });

  const pass = results.filter((r) => r.pass).length;
  await invoke('dc_selftest_done', {
    results: JSON.stringify({ pass, total: results.length, results }, null, 2),
  });
}

// ---------- 启动 ----------
async function main(): Promise<void> {
  // 看门狗 + 未捕获异常:selftest 模式下任何卡死/报错都要给 Rust 一个交代
  const mode = (window as unknown as { __DC_SELFTEST__?: true | 'live' | 'multiwindow' })
    .__DC_SELFTEST__;
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
    setTimeout(() => bail('看门狗超时(90s)'), 90_000);
  }

  await listen('dc-signal', (e) => {
    const p = e.payload as {
      t?: string;
      view?: string;
      href?: string;
      title?: string;
      topId?: string | null;
      frac?: number;
      ratio?: number;
      name?: string;
      value?: unknown;
      dir?: number;
    };
    if (!p) return;
    if (p.t === 'test:info') {
      const w = queryWaiters.get(p.name!);
      if (w) {
        queryWaiters.delete(p.name!);
        w(p.value);
      }
      return;
    }
    const view = parseView(p.view);
    if (!view) return; // 非 w{n}-left/right 格式的信号(路由已定向,格式过滤双保险)
    if (p.t === 'cs:hello') viewUrls[view] = p.href ?? viewUrls[view];
    else if (p.t === 'cs:nav') void syncFrom(view, p.href!);
    else if (p.t === 'cs:scroll') void onScroll(view, p.topId ?? null, p.frac ?? 0, p.ratio ?? 0);
    else if (p.t === 'cs:zoom') void invoke('dc_zoom', { dir: (p.dir as number) ?? 0 }).catch(() => {});
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
  if (mode === 'multiwindow') await multiwindowSelftest();
  else if (mode) await selftest(mode);
}

void main();
