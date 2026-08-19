import type { SyncSettings } from '@docs-compare/core';

/**
 * CDP 实现的消息协议(chrome-extension/src/protocol.ts 的子集平移)。
 *
 * 通道:页面 reporter → Node 走 CDP Runtime.addBinding('dcReport')(页面侧
 * window.dcReport(json) → Runtime.bindingCalled);Node → 页面走 Runtime.evaluate
 * 调 window.__dcApply(msg)。消息形状与扩展/Tauri 一致。
 */

// ---- 页面 → Node(reporter 上报) ----
export interface CsHello {
  t: 'cs:hello';
  href: string;
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

// ---- Node → 页面(__dcApply 执行) ----
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

/** reporter 上报信封(含所在侧;字段按消息类型出现) */
export interface ReportEnvelope {
  view: 'left' | 'right';
  t?: ContentMsg['t'];
  href?: string;
  topId?: string | null;
  frac?: number;
  ratio?: number;
}

/** 信封 → 严格 ContentMsg;不完整/未知消息返回 null */
export function parseContentMsg(p: ReportEnvelope): ContentMsg | null {
  switch (p.t) {
    case 'cs:hello':
    case 'cs:nav':
      return typeof p.href === 'string' ? { t: p.t, href: p.href } : null;
    case 'cs:scroll':
      return typeof p.frac === 'number' && typeof p.ratio === 'number'
        ? { t: 'cs:scroll', topId: p.topId ?? null, frac: p.frac, ratio: p.ratio }
        : null;
    default:
      return null;
  }
}
