/**
 * 同步状态机(background.ts 的 Node 平移,Tauri controller.ts 同构):
 * 信号(reporter 上报 / CDP 导航事件)→ core 映射 → 驱动对侧页面。
 *
 * 与扩展版的差异:固定左右两页,无配对管理、无 SW 生命周期,内存态即可。
 * 通过 Port 接口与宿主(CDP 接线/自测)解耦——engine 不 import 任何浏览器库,
 * 语义与 background.syncFrom 完全一致:
 * - pendingUrl 期望 URL 回声消除(自己发起的导航,其 URL 变更事件被吞掉)
 * - 逻辑路径相同 → 只发锚点滚动,不重载对侧
 */
import { AnchorIndex, PageIndex, defaultAnchorMapUrl, mapUrl, normalizePathKey, parseSites } from '@docs-compare/core';
import type { SitePair, SyncSettings } from '@docs-compare/core';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import type { BgMsg, ContentMsg } from './protocol';

/** Node fetch 不支持 file://;打包在产物目录里的锚点表直接读盘 */
const nodeFetch: typeof fetch = (input, init) => {
  const u = String(input);
  if (u.startsWith('file:')) {
    return (async () => {
      const data = await readFile(fileURLToPath(u), 'utf8');
      return new Response(data, { status: 200, headers: { 'content-type': 'application/json' } });
    })() as Promise<Response>;
  }
  return fetch(input, init);
};

export type Side = 'left' | 'right';

export interface EnginePort {
  /** 驱动一侧页面导航(回声消除由 engine 记 pendingUrl 后调用方执行) */
  navigate(side: Side, url: string): Promise<void>;
  /** 向一侧页面下发执行命令(__dcApply) */
  apply(side: Side, msg: BgMsg): Promise<void>;
}

export const DEFAULT_SETTINGS: SyncSettings = {
  navSync: true,
  scrollSync: true,
  semanticScroll: true,
  focusCss: false,
  layout: 'windows', // CDP 版即真实双窗口,此字段仅保持 schema 一致
};

export class Engine {
  private sites: SitePair[] = [];
  private settings: SyncSettings;
  private viewUrls: Record<Side, string> = { left: 'about:blank', right: 'about:blank' };
  private pendingUrl = new Map<Side, string>();
  private anchorCache = new Map<string, Promise<AnchorIndex>>();
  private readonly EMPTY_INDEX = AnchorIndex.fromRaw({});
  private pageCache = new Map<string, Promise<PageIndex>>();
  private readonly EMPTY_PAGE_INDEX = PageIndex.fromRaw({});

  constructor(
    private port: EnginePort,
    /** 相对 anchorMapUrl 的解析基点(打包产物目录,含锚点表) */
    private assetBase: string,
    settings: Partial<SyncSettings> = {},
  ) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
  }

  loadSites(input: unknown): string[] {
    const { sites, errors } = parseSites(input);
    this.sites = sites;
    return errors;
  }

  getSiteList(): SitePair[] {
    return this.sites;
  }

  /**
   * 归一化打开:任意一侧 URL → 左=原站、右=镜像。
   * 返回 null 表示不匹配任何站点配置。
   */
  async openPair(rawUrl: string): Promise<{ leftUrl: string; rightUrl: string; siteId: string } | null> {
    const src = await this.mapUrlWithPages(rawUrl);
    if (!src) return null;
    // mapUrl 的 src.url 是"映射后的对侧"地址;归一为 左=原站、右=镜像
    const leftUrl = src.from === 'origin' ? rawUrl : src.url;
    const rightUrl = src.from === 'mirror' ? rawUrl : src.url;
    return { leftUrl, rightUrl, siteId: src.site.id };
  }

  /** 初始导航(selftest/打开对照页共用);记入 viewUrls 但不触发同步 */
  async open(side: Side, url: string): Promise<void> {
    this.viewUrls[side] = url;
    await this.port.navigate(side, url);
  }

  urlOf(side: Side): string {
    return this.viewUrls[side];
  }

  /** reporter 上报信号(cs:hello / cs:nav / cs:scroll) */
  async handleSignal(side: Side, msg: ContentMsg): Promise<void> {
    if (msg.t === 'cs:hello') {
      this.viewUrls[side] = msg.href;
      await this.port.apply(side, this.stateFor(side));
      return;
    }
    if (msg.t === 'cs:nav') {
      await this.syncFrom(side, msg.href);
      return;
    }
    await this.onScroll(side, msg.topId, msg.frac, msg.ratio);
  }

  /** CDP 导航事件(frameNavigated / navigatedWithinDocument)——与 cs:nav 同一汇聚 */
  async handleNav(side: Side, url: string): Promise<void> {
    await this.syncFrom(side, url);
  }

  // ---------- 状态机(与 background.syncFrom 同构) ----------
  private async syncFrom(side: Side, rawUrl: string): Promise<void> {
    const other: Side = side === 'left' ? 'right' : 'left';
    if (!this.settings.navSync) return;
    if (this.pendingUrl.get(side) === rawUrl) {
      this.pendingUrl.delete(side);
      return;
    }
    this.viewUrls[side] = rawUrl;
    const src = await this.mapUrlWithPages(rawUrl);
    if (!src) return;

    const anchor = decodeURIComponent(new URL(rawUrl).hash.replace(/^#/, ''));
    const mappedAnchor = anchor
      ? (await this.anchorIndexFor(src.site)).lookup(
          src.logicalPath,
          anchor,
          src.from === 'origin' ? 'toMirror' : 'toOrigin',
        )
      : null;

    const dst = await this.mapUrlWithPages(this.viewUrls[other]);
    const samePage =
      !!dst &&
      dst.site.id === src.site.id &&
      normalizePathKey(dst.logicalPath) === normalizePathKey(src.logicalPath);

    if (samePage) {
      if (mappedAnchor) await this.port.apply(other, { t: 'bg:anchor', anchor: mappedAnchor });
      return;
    }
    const target = src.url + (mappedAnchor ? `#${mappedAnchor}` : '');
    if ((this.viewUrls[other] ?? '').split('#')[0] === target.split('#')[0]) return;
    this.pendingUrl.set(other, target);
    // 目的地已知先记入(与 Tauri 版一致):同一信号的重复上报(cs:nav +
    // frameNavigated)在"已同步"检查处短路,不重复 Page.navigate
    this.viewUrls[other] = target;
    await this.port.navigate(other, target);
  }

  private async onScroll(side: Side, topId: string | null, frac: number, ratio: number): Promise<void> {
    const other: Side = side === 'left' ? 'right' : 'left';
    if (!this.settings.scrollSync) return;
    let anchorId: string | null = null;
    if (this.settings.semanticScroll && topId) {
      const src = await this.mapUrlWithPages(this.viewUrls[side]);
      if (src) {
        anchorId = (await this.anchorIndexFor(src.site)).lookup(
          src.logicalPath,
          topId,
          src.from === 'origin' ? 'toMirror' : 'toOrigin',
        );
      }
    }
    await this.port.apply(other, { t: 'bg:scroll', anchorId, frac, ratio });
  }

  // ---------- 锚点表 ----------
  private resolveAnchorMapUrl(site: SitePair): string {
    const p = site.anchorMapUrl ?? defaultAnchorMapUrl(site);
    if (/^https?:/i.test(p)) return p;
    // 相对路径 = 打包产物目录下的资源(anchor-maps/…)
    let base = this.assetBase;
    if (!base.endsWith('/')) base += '/';
    return new URL(p, base.startsWith('file:') ? base : pathToFileURL(base).href).href;
  }
  anchorIndexFor(site: SitePair): Promise<AnchorIndex> {
    let p = this.anchorCache.get(site.id);
    if (!p) {
      const url = this.resolveAnchorMapUrl(site);
      p = AnchorIndex.load(url, nodeFetch).catch((e) => {
        console.warn(`[dc] ${url} 加载失败,锚点原样透传:`, e?.message ?? e);
        return this.EMPTY_INDEX;
      });
      this.anchorCache.set(site.id, p);
    }
    return p;
  }

  // ---------- 页面路径表(两侧逻辑路径不一致的站点) ----------
  private pageIndexFor(site: SitePair): Promise<PageIndex> {
    let p = this.pageCache.get(site.id);
    if (!p) {
      if (!site.pageMapUrl) {
        p = Promise.resolve(this.EMPTY_PAGE_INDEX);
      } else {
        let base = this.assetBase;
        if (!base.endsWith('/')) base += '/';
        const url = /^https?:/i.test(site.pageMapUrl)
          ? site.pageMapUrl
          : new URL(site.pageMapUrl, base.startsWith('file:') ? base : pathToFileURL(base).href).href;
        p = PageIndex.load(url, nodeFetch).catch((e) => {
          console.warn(`[dc] ${url} 加载失败,页面路径退回直映:`, e?.message ?? e);
          return this.EMPTY_PAGE_INDEX;
        });
      }
      this.pageCache.set(site.id, p);
    }
    return p;
  }

  /** mapUrl 包装:带上站点各自的页面路径表 */
  private async mapUrlWithPages(rawUrl: string): Promise<ReturnType<typeof mapUrl>> {
    for (const site of this.sites) {
      if (!site.pageMapUrl) continue;
      const hit = await mapUrl(rawUrl, [site], { pageIndex: await this.pageIndexFor(site) });
      if (hit) return hit;
    }
    return mapUrl(rawUrl, this.sites);
  }

  // ---------- 专注 CSS(bg:state) ----------
  /** 与扩展 refreshState 同语义:仅 focusCss 开启且站点配了该侧 CSS 才注入 */
  stateFor(side: Side): BgMsg {
    let css: string | null = null;
    if (this.settings.focusCss) {
      // CSS 注入只看站点归属,路径表不影响判定;用同步 mapUrl 即可
      const src = mapUrl(this.viewUrls[side], this.sites);
      if (src) css = src.site.css?.[src.from] ?? null;
    }
    return { t: 'bg:state', settings: this.settings, css };
  }
}
