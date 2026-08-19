import { parseSites } from '@docs-compare/core';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const EXAMPLE = JSON.stringify(
  [
    {
      id: 'orca',
      origin: 'https://www.onorca.dev/docs',
      mirror: 'https://lif3ng-vibe.github.io/docs-cn/orca',
      anchorMapUrl: 'anchor-maps/orca.json',
    },
    {
      id: 'codegraph',
      origin: 'https://colbymchenry.github.io/codegraph',
      mirror: 'https://lif3ng-vibe.github.io/docs-cn/codegraph',
      anchorMapUrl: 'anchor-maps/codegraph.json',
    },
  ],
  null,
  2,
);

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
