import { DEFAULT_SITES, mergeDefaultSites, parseSites } from '@docs-compare/core';
import type { SitePair } from '@docs-compare/core';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** 配置页初始值 = 内置默认(与 background 兜底同源),保存过的显示用户配置 */
const EXAMPLE = JSON.stringify(DEFAULT_SITES, null, 2);

/** 展示视角 = 用户配置 + 内置新站(与 background.getSites 同口径):
 *  用户看到的即生效的,避免「textarea 没有但下拉有」的困惑 */
function viewOf(saved: SitePair[], snap: string[] | undefined): SitePair[] {
  return mergeDefaultSites(saved, snap);
}

async function load(): Promise<void> {
  const got = await chrome.storage.local.get(['dc_sites_raw', 'dc_sites', 'dc_defaults_at_save']);
  const el = $('sites') as HTMLTextAreaElement;
  if (typeof got.dc_sites_raw === 'string' && got.dc_sites_raw.trim() !== '') {
    // 保存过:展示合并视角(用户配置 + 保存后新收录的内置站)
    const { sites } = parseSites(got.dc_sites);
    const snap = Array.isArray(got.dc_defaults_at_save) ? (got.dc_defaults_at_save as string[]) : undefined;
    el.value = JSON.stringify(viewOf(sites, snap), null, 2);
  } else {
    el.value = EXAMPLE;
  }
}

function setMsg(text: string, cls: 'ok' | 'err'): void {
  const el = $('msg');
  el.textContent = text;
  el.className = cls;
}

async function save(): Promise<void> {
  const raw = ($('sites') as HTMLTextAreaElement).value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    setMsg(`JSON 解析失败:${e}`, 'err');
    return;
  }
  const { sites, errors } = parseSites(parsed);
  if (errors.length) {
    setMsg(`未保存,有问题:\n${errors.join('\n')}`, 'err');
    return;
  }
  // 快照此刻的内置 id:升级合并用——快照里没有的 id 视为「新收录站」自动补入,
  // 快照里有但用户删掉的视为「主动删除」不回补
  await chrome.storage.local.set({
    dc_sites: sites,
    dc_sites_raw: raw,
    dc_defaults_at_save: DEFAULT_SITES.map((s) => s.id),
  });
  setMsg(`已保存,共 ${sites.length} 个站点对。`, 'ok');
}

function wire(): void {
  $('save').addEventListener('click', () => void save());
  $('example').addEventListener('click', () => {
    ($('sites') as HTMLTextAreaElement).value = EXAMPLE;
    setMsg('', 'ok');
  });
}

wire();
void load();
