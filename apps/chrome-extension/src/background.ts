import {
  AnchorIndex,
  defaultAnchorMapUrl,
  findSite,
  mapUrl,
  normalizePathKey,
  parseSites,
} from '@docs-compare/core';
import type { SitePair, SyncSettings } from '@docs-compare/core';
import type { BgMsg, BgState, ContentMsg, PopupMsg, PopupPair, StatusReply } from './protocol';

/**
 * background(service worker)是同步状态机:
 * 所有导航信号(content 消息 / tabs.onUpdated)都汇入 syncFrom(),
 * 比较后决定"改对侧 URL"还是"只发锚点滚动",天然去重防回环。
 * 映射逻辑全部来自 @docs-compare/core,不含浏览器特定规则。
 */

const DEFAULT_SETTINGS: SyncSettings = {
  navSync: true,
  scrollSync: true,
  semanticScroll: true,
  focusCss: false,
  layout: 'windows',
};
const EMPTY_INDEX = AnchorIndex.fromRaw({});

/** tabId ↔ tabId,双向 */
const pairs = new Map<number, number>();
/** 我方主动触发的跳转(用于吞掉回声) */
const pendingUrl = new Map<number, string>();
/** siteId → 锚点表(失败也缓存,避免反复请求) */
const anchorCache = new Map<string, Promise<AnchorIndex>>();

// ---------- 存取 ----------

async function getSites(): Promise<SitePair[]> {
  const got = await chrome.storage.local.get('dc_sites');
  const { sites, errors } = parseSites(got.dc_sites);
  if (errors.length) console.warn('[docs-compare] 站点配置有问题:', errors);
  return sites;
}

async function getSettings(): Promise<SyncSettings> {
  const got = await chrome.storage.local.get('dc_settings');
  return { ...DEFAULT_SETTINGS, ...(got.dc_settings ?? {}) };
}

async function saveSettings(s: SyncSettings): Promise<void> {
  await chrome.storage.local.set({ dc_settings: s });
}

async function loadPairs(): Promise<void> {
  const got = await chrome.storage.session.get('dc_pairs');
  const list = got.dc_pairs as [number, number][] | undefined;
  if (Array.isArray(list)) {
    for (const [a, b] of list) {
      pairs.set(a, b);
      pairs.set(b, a);
    }
  }
}

async function persistPairs(): Promise<void> {
  // 双向表存去重后的对
  const seen = new Set<number>();
  const list: [number, number][] = [];
  for (const [a, b] of pairs) {
    if (seen.has(a)) continue;
    seen.add(a);
    seen.add(b);
    list.push([a, b]);
  }
  await chrome.storage.session.set({ dc_pairs: list });
}

// ---------- 消息发送(content 可能尚未注入,失败时补注入再试) ----------

async function sendSafe(tabId: number, msg: BgMsg): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tabId, msg);
    } catch {
      // chrome:// 等不可注入页面,忽略
    }
  }
}

// ---------- 锚点表 ----------

/** 锚点表地址:绝对 URL 直接用;否则视为扩展内打包路径 */
function anchorMapLocation(site: SitePair): string {
  const p = site.anchorMapUrl ?? defaultAnchorMapUrl(site);
  return /^https?:\/\//.test(p) ? p : chrome.runtime.getURL(p.replace(/^\//, ''));
}

function anchorIndexFor(site: SitePair): Promise<AnchorIndex> {
  let p = anchorCache.get(site.id);
  if (!p) {
    const url = anchorMapLocation(site);
    p = AnchorIndex.load(url).catch((e) => {
      console.warn(`[docs-compare] ${url} 加载失败,锚点将原样透传:`, e);
      return EMPTY_INDEX;
    });
    anchorCache.set(site.id, p);
  }
  return p;
}

// ---------- 状态下发 ----------

async function stateForTab(tabId: number): Promise<BgState> {
  const settings = await getSettings();
  let css: string | null = null;
  if (settings.focusCss && pairs.has(tabId)) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.url) {
      const hit = findSite(tab.url, await getSites());
      if (hit) css = hit.site.css?.[hit.side] ?? null;
    }
  }
  return { t: 'bg:state', settings, css };
}

async function refreshState(tabId: number): Promise<void> {
  await sendSafe(tabId, await stateForTab(tabId));
}

// ---------- 核心:同步 ----------

function stripHash(url: string): string {
  return url.split('#')[0];
}

async function syncFrom(tabId: number, rawUrl: string): Promise<void> {
  const other = pairs.get(tabId);
  if (other == null) return;
  const settings = await getSettings();
  if (!settings.navSync) return;
  if (pendingUrl.get(tabId) === rawUrl) {
    pendingUrl.delete(tabId); // 自己是被同步方,吞掉回声
    return;
  }

  const sites = await getSites();
  const src = mapUrl(rawUrl, sites);
  if (!src) return;

  const u = new URL(rawUrl);
  const anchor = decodeURIComponent(u.hash.replace(/^#/, ''));
  const mappedAnchor = anchor
    ? (await anchorIndexFor(src.site)).lookup(
        src.logicalPath,
        anchor,
        src.from === 'origin' ? 'toMirror' : 'toOrigin',
      )
    : null;

  const otherTab = await chrome.tabs.get(other).catch(() => null);
  if (!otherTab) {
    await dropPair(tabId);
    return;
  }
  const dst = otherTab.url ? mapUrl(otherTab.url, sites) : null;
  const samePage =
    !!dst &&
    dst.site.id === src.site.id &&
    normalizePathKey(dst.logicalPath) === normalizePathKey(src.logicalPath);

  if (samePage) {
    // 同一页面:只滚动到锚点,不刷新对侧
    if (mappedAnchor) await sendSafe(other, { t: 'bg:anchor', anchor: mappedAnchor });
    return;
  }

  const target = src.url + (mappedAnchor ? `#${mappedAnchor}` : '');
  if (stripHash(otherTab.url ?? '') === stripHash(target)) return; // 已同步
  pendingUrl.set(other, target);
  await chrome.tabs.update(other, { url: target });
}

// ---------- 配对管理 ----------

async function setPair(a: number, b: number): Promise<void> {
  pairs.set(a, b);
  pairs.set(b, a);
  await persistPairs();
  await refreshState(a);
  await refreshState(b);
}

async function dropPair(tabId: number): Promise<void> {
  const other = pairs.get(tabId);
  pairs.delete(tabId);
  if (other != null) pairs.delete(other);
  await persistPairs();
  await refreshState(tabId);
  if (other != null) await refreshState(other);
}

async function activeTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ?? null;
}

async function doPair(screen?: PopupPair['screen']): Promise<StatusReply> {
  const tab = await activeTab();
  if (!tab?.id || !tab.url || tab.windowId == null) return popupStatusWithError('找不到当前标签页');
  const sites = await getSites();
  const src = mapUrl(tab.url, sites);
  if (!src) {
    return popupStatusWithError('当前页不匹配任何站点配置,请先到配置页添加该站点对');
  }
  if (pairs.has(tab.id)) await dropPair(tab.id);

  const u = new URL(tab.url);
  let anchor: string | null = null;
  if (u.hash) {
    anchor = (await anchorIndexFor(src.site)).lookup(
      src.logicalPath,
      decodeURIComponent(u.hash.replace(/^#/, '')),
      src.from === 'origin' ? 'toMirror' : 'toOrigin',
    );
  }
  const target = src.url + (anchor ? `#${anchor}` : '');

  let counterpartId: number | undefined;
  const settings = await getSettings();
  if (settings.layout === 'tabs') {
    // 分屏模式:同窗口相邻标签页,用户自行用 Chrome 原生分屏并排
    const created = await chrome.tabs.create({ url: target, index: tab.index + 1, active: false });
    counterpartId = created.id ?? undefined;
  } else if (screen) {
    // 左右平铺:当前窗口缩到左半屏,对照页开右半屏新窗口。
    // 最大化/全屏时直接设 bounds 无效,先还原成普通窗口。
    const win = await chrome.windows.get(tab.windowId).catch(() => null);
    if (win?.id != null) {
      if (win.state === 'maximized' || win.state === 'fullscreen') {
        await chrome.windows.update(win.id, { state: 'normal' });
      }
      const half = Math.floor(screen.width / 2);
      await chrome.windows.update(win.id, {
        left: screen.left,
        top: screen.top,
        width: half,
        height: screen.height,
      });
      const created = await chrome.windows.create({
        url: target,
        left: screen.left + half,
        top: screen.top,
        width: screen.width - half,
        height: screen.height,
        focused: true,
      });
      counterpartId = created?.tabs?.[0]?.id;
    }
  }
  if (counterpartId == null) {
    // 拿不到屏幕信息(或窗口操作失败):退回同窗口相邻标签页
    const created = await chrome.tabs.create({ url: target, index: tab.index + 1, active: false });
    counterpartId = created.id ?? undefined;
  }
  if (counterpartId == null) return popupStatusWithError('打开对照页失败');
  await setPair(tab.id, counterpartId);
  return popupStatus();
}

async function doUnpair(): Promise<StatusReply> {
  const tab = await activeTab();
  if (tab?.id != null) await dropPair(tab.id);
  return popupStatus();
}

async function doToggle(key: 'navSync' | 'scrollSync' | 'semanticScroll' | 'focusCss'): Promise<StatusReply> {
  const s = await getSettings();
  s[key] = !s[key];
  await saveSettings(s);
  for (const tabId of [...pairs.keys()]) await refreshState(tabId);
  return popupStatus();
}

async function doSetLayout(layout: 'windows' | 'tabs'): Promise<StatusReply> {
  const s = await getSettings();
  s.layout = layout;
  await saveSettings(s);
  return popupStatus();
}

async function popupStatus(): Promise<StatusReply> {
  const settings = await getSettings();
  const tab = await activeTab();
  if (!tab?.url) return { matched: false, paired: false, settings };
  const sites = await getSites();
  const hit = findSite(tab.url, sites);
  const other = tab.id != null ? pairs.get(tab.id) : undefined;
  const otherTab = other != null ? await chrome.tabs.get(other).catch(() => null) : null;
  let anchorMapSize: number | undefined;
  if (hit && other != null) {
    anchorMapSize = (await anchorIndexFor(hit.site)).size;
  }
  return {
    matched: !!hit,
    siteId: hit?.site.id,
    side: hit?.side,
    paired: other != null,
    counterpartUrl: otherTab?.url,
    anchorMapSize,
    settings,
  };
}

function popupStatusWithError(error: string): Promise<StatusReply> {
  return popupStatus().then((s) => ({ ...s, error }));
}

// ---------- 事件接线 ----------

chrome.runtime.onMessage.addListener((msg: ContentMsg | PopupMsg, sender, sendResponse) => {
  void (async () => {
    switch (msg?.t) {
      case 'cs:hello': {
        const tabId = sender.tab?.id;
        if (tabId != null) sendResponse(await stateForTab(tabId));
        return;
      }
      case 'cs:nav':
        if (sender.tab?.id != null) await syncFrom(sender.tab.id, msg.href);
        return;
      case 'cs:scroll': {
        const tabId = sender.tab?.id;
        const other = tabId != null ? pairs.get(tabId) : undefined;
        const s = await getSettings();
        if (other == null || !s.scrollSync) return;
        // 语义滚动:把源侧的标题锚点映射到对侧;解析不到就走比例兜底
        let anchorId: string | null = null;
        if (s.semanticScroll && msg.topId && tabId != null) {
          const tab = await chrome.tabs.get(tabId).catch(() => null);
          const src = tab?.url ? mapUrl(tab.url, await getSites()) : null;
          if (src) {
            anchorId = (await anchorIndexFor(src.site)).lookup(
              src.logicalPath,
              msg.topId,
              src.from === 'origin' ? 'toMirror' : 'toOrigin',
            );
          }
        }
        await sendSafe(other, { t: 'bg:scroll', anchorId, frac: msg.frac, ratio: msg.ratio });
        return;
      }
      case 'popup:status':
        sendResponse(await popupStatus());
        return;
      case 'popup:pair':
        sendResponse(await doPair(msg.screen));
        return;
      case 'popup:unpair':
        sendResponse(await doUnpair());
        return;
      case 'popup:toggle':
        sendResponse(await doToggle(msg.key));
        return;
      case 'popup:set-layout':
        sendResponse(await doSetLayout(msg.layout));
        return;
    }
  })().catch((e) => console.warn('[docs-compare] 处理消息出错:', e));
  return true; // 异步 sendResponse
});

// 兜底:地址栏导航、SPA 路由、content 脚本未注入的场景
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url && pairs.has(tabId)) void syncFrom(tabId, change.url);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (pairs.has(tabId)) void dropPair(tabId);
});

chrome.commands?.onCommand.addListener((command) => {
  if (command === 'toggle-focus-css') void doToggle('focusCss');
});

chrome.runtime.onInstalled.addListener(() => void loadPairs());
chrome.runtime.onStartup?.addListener(() => void loadPairs());
void loadPairs();
