import type { Side, SitePair } from './types';

/** 去掉 base 末尾的斜杠 */
export function normalizeBase(base: string): string {
  return base.replace(/\/+$/, '');
}

/** 前缀规范成 "/xxx" 或 "/" */
export function normalizePrefix(p?: string): string {
  if (!p) return '/';
  return '/' + p.replace(/^\/+|\/+$/g, '');
}

/**
 * 剥掉 base 自带路径(如 github.io 的仓库路径)+ 配置前缀,
 * 得到两站共享的"逻辑路径"。不属于该站返回 null。
 */
export function logicalPath(rawUrl: string, site: SitePair, side: Side): string | null {
  let u: URL;
  let b: URL;
  try {
    u = new URL(rawUrl);
    b = new URL(normalizeBase(side === 'origin' ? site.origin : site.mirror));
  } catch {
    return null;
  }
  if (u.origin !== b.origin) return null;

  const prefix = normalizePrefix(side === 'origin' ? site.originPrefix : site.mirrorPrefix);
  const strip = [b.pathname === '/' ? null : b.pathname.replace(/\/+$/, ''), prefix === '/' ? null : prefix]
    .filter(Boolean)
    .join('');

  let p = u.pathname;
  if (strip !== '') {
    if (p === strip) p = '/';
    else if (!p.startsWith(strip + '/')) return null;
    else p = p.slice(strip.length) || '/';
  }
  if (side === 'origin' ? site.originStripHtmlExt : site.mirrorStripHtmlExt) {
    p = p.replace(/\/index\.html?$/, '/');
    p = p.replace(/\.html?$/, '');
  }
  return p || '/';
}

/** 判断 URL 属于这对站点的哪一侧(都不属于返回 null) */
export function sideOf(rawUrl: string, site: SitePair): Side | null {
  if (logicalPath(rawUrl, site, 'origin') !== null) return 'origin';
  if (logicalPath(rawUrl, site, 'mirror') !== null) return 'mirror';
  return null;
}

export function findSite(rawUrl: string, sites: SitePair[]): { site: SitePair; side: Side } | null {
  for (const site of sites) {
    const side = sideOf(rawUrl, site);
    if (side) return { site, side };
  }
  return null;
}

/** 由逻辑路径拼出某一侧的页面 URL(不含 hash、query) */
export function buildUrl(site: SitePair, side: Side, path: string): string {
  const base = normalizeBase(side === 'origin' ? site.origin : site.mirror);
  const prefix = normalizePrefix(side === 'origin' ? site.originPrefix : site.mirrorPrefix);
  const strip = [prefix === '/' ? null : prefix].filter(Boolean).join('');
  const p = '/' + path.replace(/^\/+/, '');
  return base + strip + (p === '/' ? '/' : p);
}

export interface MappedUrl {
  site: SitePair;
  from: Side;
  to: Side;
  /** 映射后的页面 URL(不含 hash) */
  url: string;
  /** 源侧逻辑路径(用于查锚点表) */
  logicalPath: string;
}

/** 任意 URL → 对侧对应 URL;不匹配任何站点返回 null */
export function mapUrl(rawUrl: string, sites: SitePair[]): MappedUrl | null {
  const hit = findSite(rawUrl, sites);
  if (!hit) return null;
  const path = logicalPath(rawUrl, hit.site, hit.side);
  if (path == null) return null;
  const to: Side = hit.side === 'origin' ? 'mirror' : 'origin';
  return { site: hit.site, from: hit.side, to, url: buildUrl(hit.site, to, path), logicalPath: path };
}

/**
 * 路径归一化,用于锚点表键与"是否同一页面"判断:
 * 去尾斜杠、/index.html → 目录、剥 .html/.md。
 */
export function normalizePathKey(path: string): string {
  let p = path.replace(/\/+$/, '');
  p = p.replace(/\/index\.html?$/, '');
  p = p.replace(/\.(html?|md)$/, '');
  if (!p.startsWith('/')) p = '/' + p;
  return p;
}
