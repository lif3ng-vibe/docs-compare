/**
 * 注入 left/right webview 的上报+执行脚本(content.ts 的 Tauri 平移)。
 * 由 Rust 以 initialization_script 在每个文档加载前注入,并先注入
 * window.__DC_VIEW__ = "left"|"right" 标明所在视图。
 *
 * 上行:Tauri 事件 dc-report(local context 直接可用;外部 https 站点
 * 需要 capability 里配 remote urls,见 src-tauri/capabilities/)。
 * 下行:window.__dcApply(msg),由 controller 经 dc_eval 调用。
 *
 * 锁与防抖语义与扩展版完全一致(SPEC §5.3):
 * - 程序滚动后 600ms 不上报;锚点滚动后 1.2s 拒绝比例滚动命令
 * - 同页锚点点击/hashchange 暂停上报 1s
 */
import { findBracket, interpAt, scrollRatio, scrollTopFor } from '@docs-compare/core';

(() => {
  const w = window as typeof window & { __DC_REPORTER__?: boolean; __DC_VIEW__?: string };
  if (w.__DC_REPORTER__) return;
  w.__DC_REPORTER__ = true;
  const view = w.__DC_VIEW__;
  if (!view) return;

  function report(msg: Record<string, unknown>): void {
    try {
      (window as unknown as { __TAURI_INTERNALS__?: { invoke: (c: string, a: unknown) => Promise<unknown> } })
        .__TAURI_INTERNALS__?.invoke('plugin:event|emit', { event: 'dc-report', payload: { view, ...msg } })
        ?.catch?.((e: unknown) => {
          (window as unknown as { __dcReportErr?: string }).__dcReportErr = String(e);
        });
    } catch (e) {
      (window as unknown as { __dcReportErr?: string }).__dcReportErr = `throw:${String(e)}`;
    }
  }

  let suppressScrollUntil = 0;
  let ignoreScrollCmdUntil = 0;

  // ---- 专注 CSS + 高亮样式 ----
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
      // 允许任意绝对 scheme(含自测用的 tauri://),只排除脚本/邮件类
      if (href && /^[a-z][a-z0-9+.-]*:/i.test(href) && !/^(javascript|mailto|tel):/i.test(href)) {
        report({ t: 'cs:nav', href, title: document.title ?? '' });
      }
      if (a.getAttribute('href')?.startsWith('#')) suppressScrollUntil = Date.now() + 1000;
    },
    true,
  );
  window.addEventListener('hashchange', () => {
    suppressScrollUntil = Date.now() + 1000;
    report({ t: 'cs:nav', href: location.href, title: document.title ?? '' });
  });
  // SPA history 路由(init script 运行在主世界时可拦截;失败则由 hashchange 兜底)
  try {
    const emit = (): void => report({ t: 'cs:nav', href: location.href, title: document.title ?? '' });
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
  // 点击/hashchange 都是监听器内直接上报且工作正常,滚动同样直接上报(时间戳节流)
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
    const w = window as unknown as { __dcScrollState?: string; __dcScrollErr?: string };
    try {
      const now = Date.now();
      const y = window.scrollY;
      if (programmatic) {
        if (Math.abs(y - lastY) < 1 || now > programmaticDeadline) {
          // 停稳:清标志并加一小段静默期,吃掉 WebKit 动画尾段的余波事件
          programmatic = false;
          suppressScrollUntil = Math.max(suppressScrollUntil, now + 400);
        }
        lastY = y;
        w.__dcScrollState = 'prog';
        return;
      }
      if (now < suppressScrollUntil || now - lastReportAt < 50) {
        w.__dcScrollState = 'suppressed';
        return;
      }
      const ratio = scrollRatio(scrollingEl());
      if (Math.abs(ratio - lastSent) <= 0.001) {
        w.__dcScrollState = 'nodiff';
        return;
      }
      lastSent = ratio;
      lastReportAt = now;
      const { topId, frac } = semanticPosition();
      report({ t: 'cs:scroll', topId, frac, ratio });
      w.__dcScrollState = 'sent';
    } catch (e) {
      w.__dcScrollErr = String(e);
      w.__dcScrollState = 'throw';
    }
  };
  window.addEventListener('scroll', onScrollEvt, { passive: true, capture: true });
  // 自测取证:滚动事件到底有没有触发
  (window as unknown as { __dcScrollEvents: () => number }).__dcScrollEvents = () => scrollEventCount;
  // init script 在 document_start 注入,此时 body 尚未出现,观察 documentElement。
  // WebView2 的 document_start 时 documentElement 也可能未就绪(为 null),
  // observe(null) 会抛 TypeError 打断整个 IIFE——__dcApply/__dcTest 装不上、
  // cs:hello 发不出。防御:documentElement 未就绪时先观察 document,
  // 等 documentElement 出现后再转挂(并立即失效一次标题缓存)
  if (document.documentElement) {
    new MutationObserver((): void => {
      headingsDirty = true;
    }).observe(document.documentElement, { childList: true, subtree: true });
  } else {
    let rootMo: MutationObserver | null = new MutationObserver((): void => {
      if (!document.documentElement || !rootMo) return;
      rootMo.disconnect();
      rootMo = null;
      new MutationObserver((): void => {
        headingsDirty = true;
      }).observe(document.documentElement, { childList: true, subtree: true });
      headingsDirty = true;
    });
    rootMo.observe(document, { childList: true });
  }
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

  // ---- 自测钩子:controller 经 dc_eval 查询页面状态 ----
  (window as unknown as { __dcTest: (name: string, value: unknown) => void }).__dcTest = (name, value) => {
    report({ t: 'test:info', name, value });
  };

  document.documentElement.appendChild(flash);
  report({ t: 'cs:hello', href: location.href, title: document.title ?? '' });
})();
