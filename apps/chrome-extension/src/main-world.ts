/**
 * 注入页面主世界的补丁:SPA(VitePress/Docusaurus/Nextra 等)用 history
 * 路由跳页不触发 hashchange,content script(隔离世界)也拦不到,
 * 所以在这里包一层 pushState/replaceState,通过 CustomEvent 通知 content script。
 */
(() => {
  const w = window as typeof window & { __DC_MAIN_WORLD__?: boolean };
  if (w.__DC_MAIN_WORLD__) return;
  w.__DC_MAIN_WORLD__ = true;

  const emit = (): void => {
    try {
      window.dispatchEvent(new CustomEvent('dc:history', { detail: { url: location.href } }));
    } catch {
      // ignore
    }
  };

  for (const name of ['pushState', 'replaceState'] as const) {
    const orig = history[name].bind(history) as (...args: unknown[]) => unknown;
    history[name] = ((...args: unknown[]) => {
      const r = orig(...args);
      emit();
      return r;
    }) as typeof history[typeof name];
  }
})();
