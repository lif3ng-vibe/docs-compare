import type { StatusReply } from '../protocol';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** 屏幕可用区域(扣 Dock/菜单栏)只有 popup 拿得到,配对/直开时带给后台做左右平铺 */
function screenRect(): { left: number; top: number; width: number; height: number } {
  const s = window.screen as Screen & { availLeft?: number; availTop?: number };
  return {
    left: s.availLeft ?? 0,
    top: s.availTop ?? 0,
    width: s.availWidth || s.width,
    height: s.availHeight || s.height,
  };
}

async function refresh(): Promise<void> {
  const st: StatusReply | undefined = await chrome.runtime
    .sendMessage({ t: 'popup:status' })
    .catch(() => undefined);

  const status = $('status');
  const pair = $('pair') as HTMLButtonElement;
  const unpair = $('unpair') as HTMLButtonElement;
  const navSync = $('navSync') as HTMLInputElement;
  const scrollSync = $('scrollSync') as HTMLInputElement;
  const semanticScroll = $('semanticScroll') as HTMLInputElement;
  const focusCss = $('focusCss') as HTMLInputElement;

  if (!st) {
    status.textContent = '无法连接后台,请重新加载扩展';
    status.classList.add('err');
    return;
  }

  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="layout"]')) {
    radio.checked = radio.value === st.settings.layout;
  }
  ($('hint') as HTMLElement).textContent =
    st.settings.layout === 'tabs'
      ? '配对后右键新标签页 →「分屏」并排;建议关掉 Chrome 分屏自带的同步滚动,避免与扩展叠加。'
      : '点「配对」会把当前窗口缩到左半屏,对照页开在右半屏,自动完成分屏。';

  status.classList.remove('err');
  const lines: string[] = [];
  if (!st.matched) {
    lines.push('当前页不匹配任何站点配置');
  } else {
    lines.push(`站点:${st.siteId}(${st.side === 'origin' ? '原站' : '汉化站'})`);
    if (st.paired) {
      lines.push(`已配对:${st.counterpartUrl ?? ''}`);
      if (st.anchorMapSize != null) lines.push(`锚点表:${st.anchorMapSize} 条映射`);
    } else {
      lines.push('未配对');
    }
  }
  if (st.error) {
    lines.push(`⚠ ${st.error}`);
    status.classList.add('err');
  }
  status.textContent = lines.join('\n');

  // 站点下拉:不依赖当前页命中,选站直开对照
  const sites = st.sites ?? [];
  const picker = $('sitePicker');
  const sel = $('siteSelect') as HTMLSelectElement;
  const openSite = $('openSite') as HTMLButtonElement;
  if (sites.length === 0) {
    picker.hidden = true;
    openSite.disabled = true;
    lines.push('尚未配置站点对,请到配置页添加');
    status.textContent = lines.join('\n');
  } else {
    picker.hidden = false;
    openSite.disabled = false;
    sel.replaceChildren();
    for (const s of sites) {
      const opt = document.createElement('option');
      opt.value = s.id;
      // 官方双语站(origin/mirror 都是官方维护)打「官方」后缀,与我们维护的汉化镜像区分
      opt.textContent = s.official ? `${s.name ?? s.id}(官方)` : (s.name ?? s.id);
      sel.appendChild(opt);
    }
    // 当前页命中且在列表中 → 预选;否则选第一个
    sel.value =
      st.matched && st.siteId && sites.some((s) => s.id === st.siteId) ? st.siteId : sites[0].id;
  }

  pair.disabled = !st.matched;
  pair.hidden = st.paired;
  unpair.hidden = !st.paired;
  navSync.checked = st.settings.navSync;
  scrollSync.checked = st.settings.scrollSync;
  semanticScroll.checked = st.settings.semanticScroll;
  focusCss.checked = st.settings.focusCss;
}

function wire(): void {
  $('pair').addEventListener('click', () =>
    void chrome.runtime.sendMessage({ t: 'popup:pair', screen: screenRect() }).then(refresh),
  );
  $('openSite').addEventListener('click', () => {
    const siteId = ($('siteSelect') as HTMLSelectElement).value;
    if (!siteId) return;
    void chrome.runtime
      .sendMessage({ t: 'popup:open-site', siteId, screen: screenRect() })
      .then(refresh);
  });
  $('unpair').addEventListener('click', () => void chrome.runtime.sendMessage({ t: 'popup:unpair' }).then(refresh));
  for (const [id, key] of [
    ['navSync', 'navSync'],
    ['scrollSync', 'scrollSync'],
    ['semanticScroll', 'semanticScroll'],
    ['focusCss', 'focusCss'],
  ] as const) {
    $(id).addEventListener('change', () => void chrome.runtime.sendMessage({ t: 'popup:toggle', key }).then(refresh));
  }
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="layout"]')) {
    radio.addEventListener('change', () => {
      if (radio.checked) {
        void chrome.runtime
          .sendMessage({ t: 'popup:set-layout', layout: radio.value as 'windows' | 'tabs' })
          .then(refresh);
      }
    });
  }
}

wire();
void refresh();
