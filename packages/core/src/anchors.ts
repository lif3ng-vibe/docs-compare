import { normalizePathKey } from './url';
import type { AnchorDir } from './types';

/**
 * anchor-map.json 格式(由汉化管线在构建时生成):
 * {
 *   "/learn/hooks": { "安装-react": "installing-react", ... },
 *   ...
 * }
 * - 外层键:页面逻辑路径(归一化,不带 .html/尾斜杠)
 * - 内层方向:键 = 汉化站(mirror)锚点,值 = 原站(origin)锚点
 * - 均不含前导 #
 */
export type AnchorMap = Record<string, Record<string, string>>;

export interface AnchorLookupOptions {
  /** 查不到时原样返回同一锚点(两侧 slug 恰好相同时有用),默认 true */
  fallbackToSame?: boolean;
}

export class AnchorIndex {
  /** mirror → origin */
  private readonly fwd = new Map<string, Map<string, string>>();
  /** origin → mirror */
  private readonly rev = new Map<string, Map<string, string>>();

  private constructor() {}

  static fromRaw(raw: AnchorMap): AnchorIndex {
    const idx = new AnchorIndex();
    for (const [path, pairs] of Object.entries(raw ?? {})) {
      const key = normalizePathKey(path);
      // 不同写法的路径键归一化后可能撞车,要合并不是覆盖
      let f = idx.fwd.get(key);
      let r = idx.rev.get(key);
      if (!f || !r) {
        f = new Map<string, string>();
        r = new Map<string, string>();
        idx.fwd.set(key, f);
        idx.rev.set(key, r);
      }
      for (const [mirrorAnchor, originAnchor] of Object.entries(pairs ?? {})) {
        f.set(mirrorAnchor, originAnchor);
        r.set(originAnchor, mirrorAnchor);
      }
    }
    return idx;
  }

  static async load(url: string, fetchImpl: typeof fetch = fetch): Promise<AnchorIndex> {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`加载锚点表失败 HTTP ${res.status}: ${url}`);
    return AnchorIndex.fromRaw((await res.json()) as AnchorMap);
  }

  /** 映射锚点。查不到时默认原样返回(锚点本身可能两侧一致) */
  lookup(path: string, anchor: string, dir: AnchorDir, opts: AnchorLookupOptions = {}): string | null {
    const a = anchor.replace(/^#/, '');
    if (!a) return null;
    const m = (dir === 'toOrigin' ? this.fwd : this.rev).get(normalizePathKey(path));
    const hit = m?.get(a);
    if (hit) return hit;
    if (opts.fallbackToSame !== false) return a;
    return null;
  }

  /** 映射对总数,用于状态展示 */
  get size(): number {
    let n = 0;
    for (const m of this.fwd.values()) n += m.size;
    return n;
  }
}
