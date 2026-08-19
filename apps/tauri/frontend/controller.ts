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
import {
  AnchorIndex,
  defaultAnchorMapUrl,
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
  const src = mapUrl(rawUrl, sites);
  if (!src) return;

  const anchor = decodeURIComponent(new URL(rawUrl).hash.replace(/^#/, ''));
  const mappedAnchor = anchor
    ? (await anchorIndexFor(src.site)).lookup(
        src.logicalPath,
        anchor,
        src.from === 'origin' ? 'toMirror' : 'toOrigin',
      )
    : null;

  const dst = mapUrl(viewUrls[other], sites);
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
    const src = mapUrl(viewUrls[view], sites);
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

function wireUi(): void {
  positionDividerEl();
  scheduleLayout();
  window.addEventListener('resize', () => {
    divider = Math.min(Math.max(divider, 180), window.innerWidth - 180);
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

  const input = document.getElementById('url-left') as HTMLInputElement | null;
  const status = document.getElementById('status');
  const show = (s: string): void => {
    if (status) status.textContent = s;
  };
  async function openPair(): Promise<void> {
    const url = input?.value?.trim();
    if (!url) return;
    const src = mapUrl(url, sites);
    if (!src) {
      show('URL 不匹配任何站点配置');
      return;
    }
    await navigateTo('left', src.url);
    await navigateTo('right', src.url.replace(src.site.origin, src.site.mirror));
    show(`${src.site.id}:已对照打开`);
  }
  document.getElementById('open-left')?.addEventListener('click', () => {
    const url = input?.value?.trim();
    if (url) void navigateTo('left', url);
  });
  document.getElementById('open-pair')?.addEventListener('click', () => void openPair());
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void openPair();
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
/** 等 smooth 滚动停稳(连续两次采样相同) */
async function waitSettled(view: string, timeoutMs = 3000): Promise<number> {
  const start = Date.now();
  let prev = Number.NaN;
  for (;;) {
    const y = Number(await query(view, 'window.scrollY'));
    if (y === prev) return y;
    if (Date.now() - start > timeoutMs) return y;
    prev = y;
    await wait(200);
  }
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
    await navigateTo('left', s.leftHome);
    await navigateTo('right', s.rightHome);
    await waitFor(
      async () => String(await query('left', 'location.href')).includes(new URL(s.leftHome).pathname),
      s.navTimeout,
      'left 加载',
    );
    await waitFor(
      async () => String(await query('right', 'location.href')).includes(new URL(s.rightHome).pathname),
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
    await waitSettled('right', Math.min(s.navTimeout, 8000));
    const y = Number(await query('right', 'window.scrollY'));
    assert(ly > 100, `left 未滚动(scrollY=${ly})`);
    assert(Math.abs(y - before) > 50, `right 未跟随(${before} → ${y},left=${ly})`);
  });

  await t('点链接同步到对侧页面', async () => {
    await evalIn('left', `document.querySelector(${JSON.stringify(s.linkSelector)}).click()`);
    await waitFor(
      async () => String(await query('right', 'location.href')).includes(s.rightAfterLink),
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
  // 看门狗 + 未捕获异常:selftest 模式下任何卡死/报错都要给 Rust 一个交代
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
    setTimeout(() => bail('看门狗超时(90s)'), 90_000);
  }

  await listen('dc-signal', (e) => {
    const p = e.payload as {
      t?: string;
      view?: string;
      href?: string;
      topId?: string | null;
      frac?: number;
      ratio?: number;
      name?: string;
      value?: unknown;
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
    if (p.view !== 'left' && p.view !== 'right') return;
    if (p.t === 'cs:hello') viewUrls[p.view] = p.href ?? viewUrls[p.view];
    else if (p.t === 'cs:nav') void syncFrom(p.view, p.href!);
    else if (p.t === 'cs:scroll') void onScroll(p.view, p.topId ?? null, p.frac ?? 0, p.ratio ?? 0);
  });

  if (mode) {
    // selftest 自带站点配置
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
  }

  wireUi();
  if (mode) await selftest(mode);
}

void main();
