import type { SitePair } from './types';
import { parseSites } from './config';

/**
 * 内置站点对:扩展首次安装(或用户从未在配置页保存过)时的默认配置。
 * 与 apps/tauri/config/sites.json、apps/cdp/config/sites.json 同源——
 * 增删站点四处一起改(另加 chrome-extension options 示例与 README)。
 * anchorMapUrl 走打包约定路径 anchor-maps/<id>.json(gen-anchor-map 的 copyTo)。
 */
const RAW = [
  {
    id: 'orca',
    name: 'Orca 文档',
    origin: 'https://www.onorca.dev/docs',
    mirror: 'https://lif3ng-vibe.github.io/docs-cn/orca',
    anchorMapUrl: 'anchor-maps/orca.json',
  },
  {
    id: 'codegraph',
    name: 'CodeGraph 文档',
    origin: 'https://colbymchenry.github.io/codegraph',
    mirror: 'https://lif3ng-vibe.github.io/docs-cn/codegraph',
    anchorMapUrl: 'anchor-maps/codegraph.json',
  },
  {
    id: 'mattpocock-skills',
    name: 'Matt Pocock 技能库',
    origin: 'https://www.aihero.dev/skills',
    mirror: 'https://lif3ng-vibe.github.io/docs-cn/mattpocock-skills',
    anchorMapUrl: 'anchor-maps/mattpocock-skills.json',
    pageMapUrl: 'anchor-maps/mattpocock-skills.page-map.json',
  },
  {
    id: 'ai-coding-dictionary',
    name: 'AI 编程词典',
    origin: 'https://www.aihero.dev/ai-coding-dictionary',
    mirror: 'https://lif3ng-vibe.github.io/docs-cn/ai-coding-dictionary',
    anchorMapUrl: 'anchor-maps/ai-coding-dictionary.json',
    pageMapUrl: 'anchor-maps/ai-coding-dictionary.page-map.json',
  },
  {
    id: 'ai-memory',
    name: 'ai-memory 文档',
    origin: 'https://lif3ng-vibe.github.io/docs-cn/ai-memory-en',
    mirror: 'https://lif3ng-vibe.github.io/docs-cn/ai-memory',
    anchorMapUrl: 'anchor-maps/ai-memory.json',
  },
  {
    id: 'herdr',
    name: 'Herdr 文档',
    origin: 'https://herdr.dev/docs',
    mirror: 'https://herdr.dev/zh-cn/docs',
    anchorMapUrl: 'anchor-maps/herdr.json',
    official: true,
  },
] as const;

/** 解析一次并断言全绿:内置配置出错属构建期错误,不该静默兜底 */
const parsed = parseSites(RAW);
if (parsed.errors.length || parsed.sites.length !== RAW.length) {
  throw new Error(`内置站点对配置有误: ${parsed.errors.join('; ') || '数量不符'}`);
}

export const DEFAULT_SITES: readonly SitePair[] = parsed.sites;

/**
 * 老安装升级合并:用户保存过的配置 + 内置默认,按 id 合并(用户值优先)。
 *
 * 背景:dc_sites 是保存时的快照,内置新收录的站点不会自动出现。
 * savedDefaultIds 是保存那一刻的内置 id 快照(dc_defaults_at_save):
 *   - 内置新站(快照里没有的 id)自动补入——用户从没见过它,谈不上删过
 *   - 快照里有、用户配置里没有的 = 用户当时主动删过,不回补
 *   - 无快照(更早期安装)退化为按 id 合并,新站同样补入
 * 用户自定义站点(非内置 id)始终原样保留。
 */
export function mergeDefaultSites(
  saved: readonly SitePair[],
  savedDefaultIds: readonly string[] | undefined,
): SitePair[] {
  const savedIds = new Set(saved.map((s) => s.id));
  const merged = [...saved];
  for (const d of DEFAULT_SITES) {
    if (savedIds.has(d.id)) continue;
    // 该站在用户保存时还不存在 → 内置新站,补入
    if (savedDefaultIds === undefined || !savedDefaultIds.includes(d.id)) merged.push(d);
  }
  return merged;
}
