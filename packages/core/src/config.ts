import type { SitePair } from './types';
import { normalizeBase } from './url';

export interface ParseResult {
  sites: SitePair[];
  errors: string[];
}

function isHttpUrl(s: unknown): s is string {
  if (typeof s !== 'string' || !s) return false;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/**
 * 解析并校验站点配置。接受数组或 { sites: [...] }。
 * 有错的项被跳过,错误信息带位置,便于在配置页展示。
 */
export function parseSites(input: unknown): ParseResult {
  const errors: string[] = [];
  const raw = Array.isArray(input) ? input : (input as { sites?: unknown } | null)?.sites;
  if (!Array.isArray(raw)) {
    return { sites: [], errors: ['配置必须是数组,或 { "sites": [...] }'] };
  }
  const sites: SitePair[] = [];
  raw.forEach((item, i) => {
    const at = `第 ${i + 1} 项`;
    if (typeof item !== 'object' || item === null) {
      errors.push(`${at}: 不是对象`);
      return;
    }
    const o = item as Record<string, unknown>;
    const id = str(o.id);
    const origin = isHttpUrl(o.origin) ? o.origin : undefined;
    const mirror = isHttpUrl(o.mirror) ? o.mirror : undefined;
    if (!id) errors.push(`${at}: 缺少 id`);
    if (!origin) errors.push(`${at}: origin 缺失或不是 http(s) URL`);
    if (!mirror) errors.push(`${at}: mirror 缺失或不是 http(s) URL`);
    if (!id || !origin || !mirror) return;
    if (sites.some((s) => s.id === id)) {
      errors.push(`${at}: id 重复(${id})`);
      return;
    }
    const css =
      o.css && typeof o.css === 'object'
        ? {
            origin: str((o.css as Record<string, unknown>).origin),
            mirror: str((o.css as Record<string, unknown>).mirror),
          }
        : undefined;
    sites.push({
      id,
      origin: normalizeBase(origin),
      mirror: normalizeBase(mirror),
      originPrefix: str(o.originPrefix),
      mirrorPrefix: str(o.mirrorPrefix),
      originStripHtmlExt: o.originStripHtmlExt === true || undefined,
      mirrorStripHtmlExt: o.mirrorStripHtmlExt === true || undefined,
      anchorMapUrl: str(o.anchorMapUrl),
      pageMapUrl: str(o.pageMapUrl),
      css: css && (css.origin || css.mirror) ? css : undefined,
    });
  });
  return { sites, errors };
}

/** 锚点表默认放在汉化站根目录 */
export function defaultAnchorMapUrl(site: SitePair): string {
  return `${normalizeBase(site.mirror)}/anchor-map.json`;
}

/**
 * 页面路径表的约定路径:与锚点表同目录的 `<siteId>.page-map.json`。
 * 用户没配 pageMapUrl 的旧存储配置也能自动用上打包表(不存在时
 * 各实现的加载器退回空表,即原直映行为)。
 */
export function defaultPageMapUrl(site: SitePair, anchorMapUrl?: string): string | null {
  if (anchorMapUrl && !/^https?:\/\//.test(anchorMapUrl)) {
    // 宿主内相对路径(扩展打包 anchor-maps/<id>.json):同目录推导
    const i = anchorMapUrl.lastIndexOf('/');
    const dir = i >= 0 ? anchorMapUrl.slice(0, i + 1) : '';
    return `${dir}${site.id}.page-map.json`;
  }
  return null; // 绝对 URL(镜像站部署)无法推导同目录约定,不猜
}
