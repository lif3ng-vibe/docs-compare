import { findBracket, interpAt, scrollRatio, scrollTopFor } from '@docs-compare/core';
import type { BgMsg, BgState, ContentMsg } from './protocol';

/**
 * content script:只做"事件上报 + 命令执行",不做任何映射决策。
 * 映射逻辑全部在 background(复用 core),便于其他实现照抄同一分工。
 */
(() => {
  const w = window as typeof window & { __DC_CONTENT__?: boolean };
  if (w.__DC_CONTENT__) return;
  w.__DC_CONTENT__ = true;

  /** 程序滚动期间忽略自身滚动事件,防同步回环 */
  let suppressScrollUntil = 0;
  /** 锚点滚动进行期间忽略比例滚动命令,防止晚到的 bg:scroll 把锚点滚到屏幕外 */
  let ignoreScrollCmdUntil = 0;

  function send(msg: ContentMsg): void {
    try {
      void chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      // 扩展上下文已失效(重载过),忽略
    }
  }

  // ---- 专注 CSS ----
  const styleEl = document.createElement('style');
  styleEl.id = 'dc-focus-css';
  function applyCss(css: string | null): void {
    if (css) {
      styleEl.textContent = css;
      document.documentElement.appendChild(styleEl);
    } else {
      styleEl.remove();
    }
  }

  // ---- 导航信号上报 ----
  const httpRe = /^https?:/;

  document.addEventListener(
    'click',
    (e) => {
      const target = e.target as Element | null;
      const a = target?.closest?.('a[href]');
      if (!a) return;
      const href = (a as HTMLAnchorElement).href;
      if (href && httpRe.test(href)) send({ t: 'cs:nav', href });
      // 同页锚点:本地马上要滚到锚点,先停掉滚动上报,
      // 否则这次原生滚动产生的比例同步会压过对侧的精确锚点滚动
      if (a.getAttribute('href')?.startsWith('#')) suppressScrollUntil = Date.now() + 1000;
    },
    true,
  );

  window.addEventListener('hashchange', () => {
    suppressScrollUntil = Date.now() + 1000; // 兜底键盘/脚本触发的锚点跳转
    send({ t: 'cs:nav', href: location.href });
  });

  // main-world 脚本捕获的 SPA pushState/replaceState
  window.addEventListener('dc:history', (e) => {
    const url = (e as CustomEvent<{ url?: string }>).detail?.url ?? location.href;
    send({ t: 'cs:nav', href: url });
  });

  // ---- 标题位置缓存(语义滚动同步) ----
  const CHROME_HEADING_IDS = new Set(['_top', 'starlight__on-this-page']);
  interface HeadEntry {
    id: string;
    top: number;
  }
  let headings: HeadEntry[] = [];
  let headingsDirty = true;
  function refreshHeadings(): void {
    headings = Array.from(
      document.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]'),
    )
      .filter((el) => !CHROME_HEADING_IDS.has(el.id))
      .map((el) => ({ id: el.id, top: el.getBoundingClientRect().top + window.scrollY }));
    headingsDirty = false;
  }
  function ensureHeadings(): HeadEntry[] {
    if (headingsDirty) refreshHeadings();
    return headings;
  }
  /** 视口顶的语义位置:所夹标题区间的上界锚点 + 区间内比例 */
  function semanticPosition(): { topId: string | null; frac: number } {
    const hs = ensureHeadings();
    const { index, frac } = findBracket(
      hs.map((h) => h.top),
      window.scrollY,
    );
    return { topId: index >= 0 ? hs[index].id : null, frac };
  }
  // 懒渲染/图片加载/窗口变化后重测
  new MutationObserver(() => {
    headingsDirty = true;
  }).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', () => {
    headingsDirty = true;
  });

  // ---- 滚动上报(节流;capture 捕获嵌套容器的滚动) ----
  let timer: number | undefined;
  let lastSent = -1;
  function scrollingEl(): Element {
    return document.scrollingElement ?? document.documentElement;
  }
  window.addEventListener(
    'scroll',
    () => {
      if (Date.now() < suppressScrollUntil || timer != null) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        const ratio = scrollRatio(scrollingEl());
        if (Math.abs(ratio - lastSent) > 0.001) {
          lastSent = ratio;
          const { topId, frac } = semanticPosition();
          send({ t: 'cs:scroll', topId, frac, ratio });
        }
      }, 50);
    },
    { passive: true, capture: true },
  );

  // ---- 命令执行 ----
  function cssEscapeId(id: string): string {
    return (window.CSS && CSS.escape) ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
  }

  function scrollToAnchor(anchor: string): void {
    const id = decodeURIComponent(anchor.replace(/^#/, ''));
    let tries = 0;
    const attempt = (): void => {
      const el = document.getElementById(id) ?? document.querySelector(`[name="${cssEscapeId(id)}"]`);
      if (el) {
        // 站点没设 scroll-margin 时补一个,避免标题停在吸顶导航后面
        if (getComputedStyle(el).scrollMarginTop === '0px') el.style.scrollMarginTop = '4rem';
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        el.classList.add('dc-flash');
        setTimeout(() => el.classList.remove('dc-flash'), 1600);
        suppressScrollUntil = Date.now() + 800;
        ignoreScrollCmdUntil = Date.now() + 1200;
        return;
      }
      if (++tries < 5) {
        ignoreScrollCmdUntil = Date.now() + 1200; // 等懒渲染期间也持续挡住比例滚动
        setTimeout(attempt, 350);
      }
    };
    attempt();
  }

  chrome.runtime.onMessage.addListener((msg: BgMsg, _sender, sendResponse) => {
    switch (msg?.t) {
      case 'bg:state':
        applyCss(msg.css);
        break;
      case 'bg:anchor':
        scrollToAnchor(msg.anchor);
        break;
      case 'bg:scroll': {
        if (Date.now() < ignoreScrollCmdUntil) break; // 锚点滚动优先
        // 优先语义定位:映射锚点的同区间等比位置;解析不到退回几何比例。
        // 顺滑追踪:每条更新都把进行中的滚动动画重定向到新目标,
        // 离散步进就变成了连续跟随;600ms 抑制覆盖整个动画期防回环
        const hs = ensureHeadings();
        const idx = msg.anchorId ? hs.findIndex((h) => h.id === msg.anchorId) : -1;
        const top =
          idx >= 0
            ? interpAt(
                hs.map((h) => h.top),
                idx,
                msg.frac,
              )
            : scrollTopFor(scrollingEl(), msg.ratio);
        suppressScrollUntil = Date.now() + 600;
        window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
        break;
      }
    }
    sendResponse?.({ ok: true });
    return false;
  });

  // ---- 锚点高亮样式 + 初始化 ----
  const flash = document.createElement('style');
  flash.textContent =
    '.dc-flash{outline:2px solid rgba(66,133,244,.9);outline-offset:4px;border-radius:2px;transition:outline-color .4s}';
  document.documentElement.appendChild(flash);

  void chrome.runtime
    .sendMessage({ t: 'cs:hello' })
    .then((st: BgState | undefined) => {
      if (st?.t === 'bg:state') applyCss(st.css);
    })
    .catch(() => {});
})();
