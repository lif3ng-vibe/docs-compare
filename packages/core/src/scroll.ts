export interface ScrollLike {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** 当前滚动位置占总可滚动距离的比例(0~1) */
export function scrollRatio(el: ScrollLike): number {
  const max = el.scrollHeight - el.clientHeight;
  if (max <= 0) return 0;
  return el.scrollTop / max;
}

/** 按比例算出对侧应滚动到的 scrollTop */
export function scrollTopFor(el: ScrollLike, ratio: number): number {
  const max = el.scrollHeight - el.clientHeight;
  return Math.round(ratio * Math.max(max, 0));
}

// ---------- 语义(锚点区间)滚动同步 ----------

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export interface Bracket {
  /** 命中的锚点序号;-1 表示在首个锚点之前 */
  index: number;
  /** 区间内比例(0~1,尾段按 tail 虚拟延伸后钳位) */
  frac: number;
}

/**
 * 在有序锚点偏移中定位 y。语义同步的源侧用:
 * 把"视口顶在哪两个标题之间"表达成 {锚点序号, 区间内比例},
 * 对侧映射锚点后用 interpAt 还原出等价语义位置。
 * tail:最后一个锚点之后的虚拟延伸长度,两侧必须一致。
 */
export function findBracket(offsets: readonly number[], y: number, tail = 600): Bracket {
  if (offsets.length === 0) return { index: -1, frac: 0 };
  if (y < offsets[0]) {
    return { index: -1, frac: offsets[0] > 0 ? clamp01(y / offsets[0]) : 0 };
  }
  let i = 0;
  while (i + 1 < offsets.length && y >= offsets[i + 1]) i++;
  const base = offsets[i];
  const next = i + 1 < offsets.length ? offsets[i + 1] : base + tail;
  return { index: i, frac: clamp01((y - base) / Math.max(next - base, 1)) };
}

/** findBracket 的逆运算:锚点序号 + 区间内比例 → 目标偏移 */
export function interpAt(offsets: readonly number[], index: number, frac: number, tail = 600): number {
  if (index < 0 || index >= offsets.length) return NaN;
  const base = offsets[index];
  const next = index + 1 < offsets.length ? offsets[index + 1] : base + tail;
  return base + clamp01(frac) * Math.max(next - base, 1);
}
