import { DEFAULT_SITES, parseSites } from '@docs-compare/core';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** 配置页初始值 = 内置默认(与 background 兜底同源),保存过的显示用户配置 */
const EXAMPLE = JSON.stringify(DEFAULT_SITES, null, 2);

async function load(): Promise<void> {
  const got = await chrome.storage.local.get('dc_sites_raw');
  ($('sites') as HTMLTextAreaElement).value =
    typeof got.dc_sites_raw === 'string' && got.dc_sites_raw.trim() !== '' ? got.dc_sites_raw : EXAMPLE;
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
  await chrome.storage.local.set({ dc_sites: sites, dc_sites_raw: raw });
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
