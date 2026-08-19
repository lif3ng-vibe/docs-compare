/**
 * 注入两侧页面的上报+执行脚本(content.ts 的 CDP 平移)。
 * 由 chrome.ts 以 Page.addScriptToEvaluateOnNewDocument 在每个文档加载前注入,
 * 并先注入 window.__DC_VIEW__ = "left"|"right" 标明所在侧。
 *
 * 上行:window.dcReport(json)(CDP Runtime.addBinding 提供,Node 侧收
 * Runtime.bindingCalled)。下行:window.__dcApply(msg),由引擎经
 * Runtime.evaluate 调用。
 *
 * 锁与防抖语义与扩展/Tauri 版完全一致:
 * - 程序滚动后停稳+400ms 余波内不上报;锚点滚动后 1.2s 拒绝比例滚动命令
 * - 同页锚点点击/hashchange 暂停上报 1s
 */
import { findBracket, interpAt, scrollRatio, scrollTopFor } from '@docs-compare/core';

(() => {
  if (window.top !== window) return; // 只在主框架运行
  const w = window as typeof window & {
    __DC_REPORTER__?: boolean;
    __DC_VIEW__?: string;
    dcReport?: (payload: string) => void;
  };
  if (w.__DC_REPORTER__) return;
  w.__DC_REPORTER__ = true;
  const view = w.__DC_VIEW__;
  if (!view) return;

  function report(msg: Record<string, unknown>): void {
    try {
      w.dcReport?.(JSON.stringify({ view, ...msg }));
    } catch (e) {
      (window as unknown as { __dcReportErr?: string }).__dcReportErr = String(e);
    }
  }

  let suppressScrollUntil = 0;
  let ignoreScrollCmdUntil = 0;

  // ---- 专注 CSS + 高亮样式 ----
  /**
   * CDP init script 在文档创建极早期注入,html 元素可能尚未生成
   * (WKWebView 无此时序);DOM 相关初始化等 documentElement 出现再挂,
   * 轮询几毫秒内即就绪,仍远早于页面脚本与解析完成。
   */
  function whenDocEl(fn: (root: HTMLElement) => void): void {
    const tick = (): void => {
      const root = document.documentElement;
      if (root) fn(root);
      else setTimeout(tick, 5);
    };
    tick();
  }
  const styleEl = document.createElement('style');
  styleEl.id = 'dc-focus-css';
  function applyCss(css: string | null): void {
    if (css) {
      styleEl.textContent = css;
      whenDocEl((root) => root.appendChild(styleEl));
    } else {
      styleEl.remove();
    }
  }
  const flash = document.createElement('style');
  flash.textContent =
    '.dc-flash{outline:2px solid rgba(66,133,244,.9);outline-offset:4px;border-radius:2px;transition:outline-color .4s}';

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
  function semanticPosition(): { topId: string | null; frac: number } {
    const hs = ensureHeadings();
    const { index, frac } = findBracket(
      hs.map((h) => h.top),
      window.scrollY,
    );
    return { topId: index >= 0 ? hs[index].id : null, frac };
  }

  // ---- 导航信号 ----
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target as Element | null;
      const a = target?.closest?.('a[href]');
      if (!a) return;
      const href = (a as HTMLAnchorElement).href;
      // 允许任意绝对 scheme(含自测用的 http://localhost),只排除脚本/邮件类
      if (href && /^[a-z][a-z0-9+.-]*:/i.test(href) && !/^(javascript|mailto|tel):/i.test(href)) {
        report({ t: 'cs:nav', href });
      }
      if (a.getAttribute('href')?.startsWith('#')) suppressScrollUntil = Date.now() + 1000;
    },
    true,
  );
  window.addEventListener('hashchange', () => {
    suppressScrollUntil = Date.now() + 1000;
    report({ t: 'cs:nav', href: location.href });
  });
  // SPA history 路由(init script 运行在主世界,可直接拦截;
  // 漏网的由 CDP navigatedWithinDocument 事件兜底)
  try {
    const emit = (): void => report({ t: 'cs:nav', href: location.href });
    for (const name of ['pushState', 'replaceState'] as const) {
      const orig = history[name].bind(history) as (...args: unknown[]) => unknown;
      history[name] = ((...args: unknown[]) => {
        const r = orig(...args);
        emit();
        return r;
      }) as typeof history[typeof name];
    }
  } catch {
    // ignore
  }

  // ---- 滚动上报 ----
  let lastSent = -1;
  let scrollEventCount = 0;
  function scrollingEl(): Element {
    return document.scrollingElement ?? document.documentElement;
  }
  let lastReportAt = 0;
  /**
   * 程序滚动(我们 apply 引发)期间不上报,直到滚动停稳(连续两帧位置不变)
   * 或超时。这是防"两侧程序滚动互相回声拉扯"的关键:纯时间窗口抑制不住
   * 顺滑动画尾段的回声。
   */
  let programmatic = false;
  let programmaticDeadline = 0;
  let lastY = Number.NaN;
  const markProgrammatic = (): void => {
    programmatic = true;
    programmaticDeadline = Date.now() + 2000;
    lastY = Number.NaN;
  };
  const onScrollEvt = (): void => {
    scrollEventCount++;
    const s = window as unknown as { __dcScrollState?: string; __dcScrollErr?: string };
    try {
      const now = Date.now();
      const y = window.scrollY;
      if (programmatic) {
        if (Math.abs(y - lastY) < 1 || now > programmaticDeadline) {
          // 停稳:清标志并加一小段静默期,吃掉顺滑动画尾段的余波事件
          programmatic = false;
          suppressScrollUntil = Math.max(suppressScrollUntil, now + 400);
        }
        lastY = y;
        s.__dcScrollState = 'prog';
        return;
      }
      if (now < suppressScrollUntil || now - lastReportAt < 50) {
        s.__dcScrollState = 'suppressed';
        return;
      }
      const ratio = scrollRatio(scrollingEl());
      if (Math.abs(ratio - lastSent) <= 0.001) {
        s.__dcScrollState = 'nodiff';
        return;
      }
      lastSent = ratio;
      lastReportAt = now;
      const { topId, frac } = semanticPosition();
      report({ t: 'cs:scroll', topId, frac, ratio });
      s.__dcScrollState = 'sent';
    } catch (e) {
      s.__dcScrollErr = String(e);
      s.__dcScrollState = 'throw';
    }
  };
  window.addEventListener('scroll', onScrollEvt, { passive: true, capture: true });
  // 自测取证:滚动事件到底有没有触发(Node 侧经 Runtime.evaluate 读取)
  (window as unknown as { __dcScrollEvents: () => number }).__dcScrollEvents = () => scrollEventCount;
  // init script 注入时 body 必未出现;documentElement 也可能尚未生成(见 whenDocEl)
  whenDocEl((root) => {
    new MutationObserver(() => {
      headingsDirty = true;
    }).observe(root, { childList: true, subtree: true });
  });
  window.addEventListener('resize', () => {
    headingsDirty = true;
  });

  // ---- 下行命令执行 ----
  function cssEscapeId(id: string): string {
    return window.CSS && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
  }
  function scrollToAnchor(anchor: string): void {
    const id = decodeURIComponent(anchor.replace(/^#/, ''));
    let tries = 0;
    const attempt = (): void => {
      let el: HTMLElement | null = null;
      try {
        el = document.getElementById(id) ?? document.querySelector<HTMLElement>(`[name="${cssEscapeId(id)}"]`);
      } catch (e) {
        (window as unknown as { __dcAnchorErr?: string }).__dcAnchorErr = String(e);
      }
      if (el) {
        if (getComputedStyle(el).scrollMarginTop === '0px') {
          el.style.scrollMarginTop = '4rem';
        }
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        el.classList.add('dc-flash');
        setTimeout(() => el.classList.remove('dc-flash'), 1600);
        markProgrammatic();
        ignoreScrollCmdUntil = Date.now() + 1200;
        return;
      }
      if (++tries < 5) {
        ignoreScrollCmdUntil = Date.now() + 1200;
        setTimeout(attempt, 350);
      }
    };
    attempt();
  }

  (window as unknown as { __dcApply: (msg: unknown) => void }).__dcApply = (msg: unknown) => {
    const m = msg as { t: string; css?: string | null; anchor?: string; anchorId?: string | null; frac?: number; ratio?: number };
    switch (m?.t) {
      case 'bg:state':
        applyCss(m.css ?? null);
        break;
      case 'bg:anchor':
        if (m.anchor) scrollToAnchor(m.anchor);
        break;
      case 'bg:scroll': {
        if (Date.now() < ignoreScrollCmdUntil) break;
        const hs = ensureHeadings();
        const idx = m.anchorId ? hs.findIndex((h) => h.id === m.anchorId) : -1;
        const top =
          idx >= 0
            ? interpAt(
                hs.map((h) => h.top),
                idx,
                m.frac ?? 0,
              )
            : scrollTopFor(scrollingEl(), m.ratio ?? 0);
        markProgrammatic();
        window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
        break;
      }
    }
  };

  whenDocEl((root) => root.appendChild(flash));
  report({ t: 'cs:hello', href: location.href });
})();
