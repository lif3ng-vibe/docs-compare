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
] as const;

/** 解析一次并断言全绿:内置配置出错属构建期错误,不该静默兜底 */
const parsed = parseSites(RAW);
if (parsed.errors.length || parsed.sites.length !== RAW.length) {
  throw new Error(`内置站点对配置有误: ${parsed.errors.join('; ') || '数量不符'}`);
}

export const DEFAULT_SITES: readonly SitePair[] = parsed.sites;
