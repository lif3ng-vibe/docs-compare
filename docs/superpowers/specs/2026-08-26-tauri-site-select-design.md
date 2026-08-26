# Tauri 版工具条下拉选择文档站点 — 设计

日期:2026-08-26
状态:已确认(两节设计均获用户通过)

## 背景与目标

扩展版 popup 已有站点下拉(`siteSelect`):不依赖当前页命中,选站即开对照。
Tauri 版工具条目前只有「粘贴原站 URL → 对照打开」,用户想换站点而没有现成 URL 时无从下手。

目标:在 Tauri 工具条加一个站点下拉,与扩展版能力对齐:

- 从 `apps/tauri/config/sites.json`(已由 controller 启动时加载)列出全部站点对
- 选中即打开该站点的原站/镜像首页对照,无需额外按钮
- 下拉与 URL 输入框双向联动

## 交互设计

工具条布局(brand 之后、URL 输入框之前插入 select):

```
Docs Compare [选择文档站点… ▼] [原站 URL…] [对照打开] 状态
```

1. **初始状态**:第一项为占位「选择文档站点…」(`value=""`,`disabled selected`);
   启动不自动打开任何站点,保持干净初始态(两侧仍 about:blank)。
2. **选项文案**:`name ?? id`;官方双语站(`official: true`)后缀「(官方)」——与扩展 popup 一致。
3. **选中即打开**:`change` → 左侧开 `buildUrl(site, 'origin', '/')`,
   右侧开 `buildUrl(site, 'mirror', '/')`,状态栏显示 `siteId:已对照打开`。
4. **双向联动**:
   - 选站 → URL 框自动填入原站首页 URL(用户可改路径再回车精确定位);
   - 任意一侧导航后命中站点(`syncFrom`/`openPair` 的映射结果)→ 下拉同步切到该站点;
     命不中任何站点则回占位项。
5. **样式**:select 与 `#url-left` 同风格(同高、同圆角边框、12px 字号),
   宽度约 180px,`text-overflow: ellipsis` 防长站名挤压工具条。

## 实现

改动仅 3 个文件,全在 `apps/tauri/frontend/`,Rust 侧零改动:

| 文件 | 改动 |
|---|---|
| `index.html` | 工具条加 `<select id="site-select">` |
| `style.css` | `#site-select` 样式(对齐 `#url-left`,定宽+省略号) |
| `controller.ts` | 渲染选项、change 打开、URL 联动回填 |

### controller.ts 细节

- `main()` 中 sites 加载成功后调用 `renderSiteSelect()`:
  渲染占位项 + 各站点 `<option>`(`value = site.id`,文案见上)。
- `wireUi()` 挂 `change` 监听:
  1. 选中站点 → `openSitePair(site)`(新函数,复用 `navigateTo`):
     左 = `buildUrl(site, 'origin', '/')`,右 = `buildUrl(site, 'mirror', '/')`;
  2. URL 框填原站首页;
  3. 状态栏显示 `siteId:已对照打开`。
- 联动回填:`syncFrom()` 更新 `viewUrls` 后、`openPair()` 打开后,
  调用 `syncSelectFromUrl(siteId | null)`:命中站点设 `select.value = site.id`,否则 `""`。
  来源直接用两处已有的 `mapUrlWithPages`/映射结果里的 `site`,不重复解析。
  注意:程序化设置 `select.value` 不触发 `change`,回填不会引发重复导航。
- **selftest 模式不渲染下拉**(自带站点配置、避免干扰测试 UI),
  与现在 selftest 跳过 sites.json 的分支一致:`if (mode) … else { 加载 sites → renderSiteSelect() }`。

### 数据流

```
启动 → fetch sites.json → parseSites → renderSiteSelect(占位 + N 站)
选站 → change → openSitePair → buildUrl(origin/mirror, '/') → navigateTo 左/右
     → URL 框 = 原站首页 → 状态栏 "siteId:已对照打开"
导航(点链接/输入框打开) → syncFrom/openPair 命中 site → select.value = site.id
不命中 → select.value = ""
```

## 错误处理

- sites 为空/`sites.json` 加载失败:下拉只显示占位项并 `disabled`
  (控制台已有 `[dc] sites.json 加载失败` warn,状态栏不额外占位)。
- 选中 id 在 sites 中找不到(理论上不发生,选项即来源):状态栏提示「站点不存在」。

## 测试

- 现有三套 selftest(fixture/live/layout)不渲染下拉,行为不变,回归应全绿。
- 下拉交互属 UI 手测:启动 → 选站 → 两侧开首页;改 URL 回车 → 下拉跟随;
  点链接导航 → 下拉跟随;加载失败 fixture → 下拉禁用。
- 布局:工具条高度固定 44px 不变,`selftest:layout` 的等宽断言天然覆盖,无需新断言。

## 明确不做(YAGNI)

- 不加「打开」按钮(选中即开,已确认)。
- 不做站点管理/编辑 UI(与扩展 options 对齐是另一个话题)。
- 不持久化「上次选中站点」(启动永远是占位项,已确认)。
- Rust 侧(`main.rs`/`dc_layout` 等)零改动。
