/**
 * 远程站点列表:GitHub Release latest 固定 URL 下发,客户端打包兜底 + 远程热更。
 * 扩展与 Tauri 共用同一 URL——新增站点合入 main 后,CI 滚动更新 Release,
 * 客户端下次启动即得,零发版。
 *
 * Release 资产 URL 模式 releases/download/latest/<file>(Release 滚动重建
 * URL 不变);仓库 public 无需鉴权。fetch 用各宿主自带的(扩展 SW /
 * Tauri controller 页面均同源无碍)。
 */
import { parseSites } from './config';
import type { SitePair } from './types';

export const REMOTE_SITES_URL =
  'https://github.com/lif3ng-vibe/docs-compare/releases/download/latest/sites.json';

/** Release 资产的固定地址前缀(CI 下发的 sites.json 里锚点表用绝对 URL) */
export function releaseAssetUrl(name: string): string {
  // GitHub Release 资产名不允许 '/':锚点表用平铺前缀 anchor-maps-<id>.json
  const flat = name.replace(/^\/+/, '').replace(/\//g, '-');
  return `https://github.com/lif3ng-vibe/docs-compare/releases/download/latest/${flat}`;
}

/**
 * 拉取远程站点列表并校验。任何失败(网络/超时/非 200/JSON 非法/
 * parseSites 有 errors)都返回 null——调用方静默退回本地,不抛错。
 */
export async function fetchRemoteSites(timeoutMs = 5000): Promise<SitePair[] | null> {
  try {
    const res = await fetch(REMOTE_SITES_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const raw: unknown = await res.json();
    if (!Array.isArray(raw)) return null;
    const { sites, errors } = parseSites(raw);
    if (errors.length > 0) return null;
    return sites;
  } catch {
    return null;
  }
}
