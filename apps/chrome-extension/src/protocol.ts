import type { SyncSettings } from '@docs-compare/core';

/**
 * 扩展内部消息协议。协议形状与实现无关——
 * 以后 Electron 版把 content↔background 换成 executeJavaScript 的
 * 消息往返即可复用同一套消息定义。
 */

// ---- content → background ----
export interface CsHello {
  t: 'cs:hello';
}
/** 导航信号:链接点击 / hashchange / SPA pushState 后的完整 URL */
export interface CsNav {
  t: 'cs:nav';
  href: string;
}
export interface CsScroll {
  t: 'cs:scroll';
  /** 语义位置:视口顶所夹标题区间的上界锚点(null = 首个标题之前) */
  topId: string | null;
  /** 区间内比例(0~1) */
  frac: number;
  /** 几何比例(对侧锚点解析失败时的兜底) */
  ratio: number;
}
export type ContentMsg = CsHello | CsNav | CsScroll;

// ---- background → content ----
export interface BgState {
  t: 'bg:state';
  settings: SyncSettings;
  /** 该侧要注入的专注 CSS;null = 不注入 */
  css: string | null;
}
/** 滚动到指定锚点(不改 URL,避免整页刷新) */
export interface BgAnchor {
  t: 'bg:anchor';
  anchor: string;
}
export interface BgScroll {
  t: 'bg:scroll';
  /** 映射后的对侧锚点(null = 语义关闭或源侧在首标题前,走比例兜底) */
  anchorId: string | null;
  frac: number;
  ratio: number;
}
export type BgMsg = BgState | BgAnchor | BgScroll;

// ---- popup → background ----
export interface PopupStatus {
  t: 'popup:status';
}
export interface PopupPair {
  t: 'popup:pair';
  /** popup 所在屏幕的可用区域(扣除任务栏/Dock),用于自动左右平铺;缺省则退回开新标签页 */
  screen?: { left: number; top: number; width: number; height: number };
}
export interface PopupUnpair {
  t: 'popup:unpair';
}
export interface PopupToggle {
  t: 'popup:toggle';
  key: 'navSync' | 'scrollSync' | 'semanticScroll' | 'focusCss';
}
export interface PopupSetLayout {
  t: 'popup:set-layout';
  layout: 'windows' | 'tabs';
}
export type PopupMsg = PopupStatus | PopupPair | PopupUnpair | PopupToggle | PopupSetLayout;

// ---- 应答 ----
export interface StatusReply {
  matched: boolean;
  siteId?: string;
  side?: 'origin' | 'mirror';
  paired: boolean;
  counterpartUrl?: string;
  anchorMapSize?: number;
  settings: SyncSettings;
  error?: string;
}
