import { normalizePathKey } from './url';

/**
 * page-map.json 格式(由汉化管线在构建时生成,来源是每页 frontmatter 的 source):
 * {
 *   "/engineering/ask-matt": "/skills-ask-matt",
 *   "/terms/afk": "/ai-coding-dictionary/afk",
 *   ...
 * }
 * - 键 = 镜像(mirror)逻辑路径(归一化,不带 .html、不带尾斜杠)
 * - 值 = 原站(origin)**完整路径**(pathname,同样归一化)。存完整路径而非
 *   剥 base 的逻辑路径,是因为原站扁平页(如 /skills-ask-matt)与 base
 *   (/skills)是兄弟路径,剥了再拼会多出斜杠;命中表项时直接以
 *   origin host + 完整路径拼 URL,绕过 base/prefix 剥拼。
 * - 两侧按 base+逻辑路径推导即一致的页不用入表。
 */
export type PageMap = Record<string, string>;

export interface PageHit {
  /** 对侧完整 URL(不含 hash) */
  url: string;
  /** 锚点表用的镜像侧逻辑路径 */
  mirrorPath: string;
}

export class PageIndex {
  /** mirror 逻辑路径 → origin 完整路径 */
  private readonly fwd = new Map<string, string>();
  /** origin 完整路径 → mirror 逻辑路径 */
  private readonly rev = new Map<string, string>();

  private constructor() {}

  static fromRaw(raw: PageMap): PageIndex {
    const idx = new PageIndex();
    for (const [mirrorPath, originPath] of Object.entries(raw ?? {})) {
      const m = normalizePathKey(mirrorPath);
      const o = normalizePathKey(originPath);
      idx.fwd.set(m, o);
      idx.rev.set(o, m);
    }
    return idx;
  }

  static async load(url: string, fetchImpl: typeof fetch = fetch): Promise<PageIndex> {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`加载页面映射表失败 HTTP ${res.status}: ${url}`);
    return PageIndex.fromRaw((await res.json()) as PageMap);
  }

  /**
   * 查镜像逻辑路径对应的原站页面。返回完整 URL(直接以 origin host +
   * 表内完整路径拼接)与镜像逻辑路径;未入表返回 null(调用方退回
   * base+逻辑路径直映)。
   */
  toOrigin(mirrorPath: string, originBase: string): PageHit | null {
    const o = this.fwd.get(normalizePathKey(mirrorPath));
    if (!o) return null;
    return { url: new URL(o, originBase).href, mirrorPath: normalizePathKey(mirrorPath) };
  }

  /**
   * 查原站路径对应的镜像逻辑路径。origin 逻辑路径可能已剥 base(/afk)也可能
   * 是完整路径(/ai-coding-dictionary/afk,表内形态),两种都试。
   * 未入表返回 null。
   */
  toMirror(originPath: string, originBase?: string): string | null {
    const p = normalizePathKey(originPath);
    const direct = this.rev.get(p);
    if (direct) return direct;
    if (originBase) {
      let base: string;
      try {
        base = new URL(originBase).pathname.replace(/\/+$/, '');
      } catch {
        return null;
      }
      const full = base === '' ? p : base + (p === '/' ? '/' : p);
      return this.rev.get(normalizePathKey(full)) ?? null;
    }
    return null;
  }

  /**
   * 判定原站 URL 是否命中表内某页(按完整 pathname 匹配)。
   * 原站扁平页(如 https://host/skills-ask-matt)不是 base(/skills)的
   * 子路径,logicalPath 前缀剥离认不出来,只能靠表识别。
   * 返回镜像逻辑路径,未命中返回 null。
   */
  matchOriginUrl(rawUrl: string, originBase: string): { mirrorPath: string } | null {
    let u: URL;
    let b: URL;
    try {
      u = new URL(rawUrl);
      b = new URL(originBase);
    } catch {
      return null;
    }
    if (u.origin !== b.origin) return null;
    const p = normalizePathKey(u.pathname);
    const m = this.rev.get(p);
    return m ? { mirrorPath: m } : null;
  }

  get size(): number {
    return this.fwd.size;
  }
}
