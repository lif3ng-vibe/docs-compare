/**
 * 一对文档站:原站(origin)↔ 汉化镜像(mirror)。
 * 全部字段可 JSON 序列化,便于各实现用文件 / storage 存取。
 */
export interface SitePair {
  /** 唯一 id,如 "react" */
  id: string;
  /** 原站 base,如 "https://react.dev" */
  origin: string;
  /** 汉化站 base,如 "https://user.github.io/react-zh"(可含仓库路径) */
  mirror: string;
  /** 原站还需额外剥离的路径前缀,如 "/docs"(默认无) */
  originPrefix?: string;
  /** 汉化站还需额外剥离的路径前缀 */
  mirrorPrefix?: string;
  /**
   * 该侧 URL 带 .html 扩展名而另一侧是干净路径时置 true,
   * 映射到对侧前会剥掉扩展名(默认 false)。
   */
  originStripHtmlExt?: boolean;
  mirrorStripHtmlExt?: boolean;
  /**
   * 锚点映射 JSON 的地址,两种写法:
   * - 绝对 http(s) URL(如部署在镜像站的 /anchor-map.json)
   * - 宿主应用内相对路径(如扩展内打包的 "anchor-maps/orca.json",
   *   由各宿主解析为自己的资源地址)
   * 缺省为 `${mirror}/anchor-map.json`
   */
  anchorMapUrl?: string;
  /** 专注模式 CSS,分别注入两侧 */
  css?: { origin?: string; mirror?: string };
}

export type Side = 'origin' | 'mirror';

export type AnchorDir = 'toOrigin' | 'toMirror';

/** 各实现共用的开关(导航同步/滚动同步/专注 CSS)+ 分屏方式 */
export interface SyncSettings {
  navSync: boolean;
  scrollSync: boolean;
  /** 滚动同步按标题区间插值(语义)还是纯几何比例 */
  semanticScroll: boolean;
  focusCss: boolean;
  /**
   * 配对时如何并排:
   * - windows:自动平铺两个窗口(扩展实现)
   * - tabs:同窗口开相邻标签页,由用户配合宿主原生分屏(如 Chrome Split View)
   */
  layout: 'windows' | 'tabs';
}
