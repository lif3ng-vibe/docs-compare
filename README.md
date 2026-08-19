# docs-compare

并排对照阅读「原站文档 ↔ GitHub Pages 汉化镜像」:在一个分屏里点链接/标题,另一侧同步跳到对应页面/滚动到对应锚点,并可注入 CSS 隐藏干扰内容。同一套核心逻辑,多套实现。

## 结构

```
packages/core            通用核心(纯 TS、零浏览器 API,所有实现共用)
  src/url.ts               URL ↔ URL 映射(base/前缀剥离、逻辑路径、.html 归一)
  src/anchors.ts           anchor-map.json 加载与双向锚点查询
  src/config.ts            站点配置解析校验
  src/scroll.ts            比例滚动 + 语义滚动数学(findBracket/interpAt)
  test/smoke.ts            冒烟测试(npm test)
apps/chrome-extension     实现一:Chrome MV3 扩展(esbuild 打包)
  src/background.ts        同步状态机:所有导航信号汇入 syncFrom(),比较后驱动对侧
  src/content.ts           事件上报 + 命令执行(锚点滚动、CSS 注入)
  src/main-world.ts        补丁 SPA 的 pushState/replaceState
  src/protocol.ts          消息协议(与实现无关,其他实现可直接复用)
apps/tauri                实现二:Tauri v2 单窗口双 webview(Rust 哑中继)
  src-tauri/src/main.rs    窗口/三 webview、事件转发、dc_eval/dc_navigate/dc_layout
  frontend/controller.ts   状态机(background.ts 平移)+ 工具条 + 可拖分隔条
  inject/reporter.ts       content.ts 平移(init script 注入,任意 origin)
  fixtures/                自测双语站(离线)
scripts/gen-anchor-map.mjs  锚点表生成器
```

后续实现(Electron / CDP / WKWebView,见 docs/IMPLEMENTATIONS.md)应**只写壳**:

- 把信号通道换成宿主的原生机制(executeJavaScript / CDP binding / WKScriptMessage)
- 映射、配置、锚点、滚动计算一律 import `@docs-compare/core`
- 消息形状复用 protocol.ts

## Tauri 版

```bash
npm run build:tauri               # 前端 bundle → frontend-dist/(cargo 前必跑)
cd apps/tauri/src-tauri && cargo run
```

- 工具条粘贴原站 URL → 「对照打开」(回车同效);左右自动归一为 原站/镜像
- 中间分隔条可拖拽;窗口缩放时**按比例**保持左右分割(默认 50/50),两侧滚动条始终完整可见
- 站点配置:`apps/tauri/config/sites.json`(与扩展同一 schema,锚点表打包在 `anchor-maps/`)
- 自动化测试(窗口会弹出,跑完自动退出,exit code 0/1):

```bash
npm run selftest           # fixture 双语站(离线、快速):导航/锚点/语义滚动同步
npm run selftest:live      # 真实站点(onorca.dev ↔ GitHub Pages 镜像)
npm run selftest:layout    # 布局:5 组尺寸 + 最大化 + 连续 resize,断言等宽/贴边
```

## 快速开始(Chrome 扩展)

```bash
npm install
npm run build          # 产物在 apps/chrome-extension/dist/
```

1. Chrome 打开 `chrome://extensions` → 开「开发者模式」→「加载已解压的扩展程序」→ 选 `apps/chrome-extension/dist`
2. 扩展「配置」页(或详情 → 扩展程序选项)填站点对,例如:

```json
[
  {
    "id": "vitepress",
    "origin": "https://vitepress.dev",
    "mirror": "https://you.github.io/vitepress-zh"
  }
]
```

3. 打开任一侧的文档页 → 点扩展图标 →「配对并打开对照页」

内置的两个站点对可直接用(锚点表打包在扩展里,`anchor-maps/*.json`,由生成器同步):

```json
[
  { "id": "orca", "origin": "https://www.onorca.dev/docs",
    "mirror": "https://lif3ng-vibe.github.io/docs-cn/orca",
    "anchorMapUrl": "anchor-maps/orca.json" },
  { "id": "codegraph", "origin": "https://colbymchenry.github.io/codegraph",
    "mirror": "https://lif3ng-vibe.github.io/docs-cn/codegraph",
    "anchorMapUrl": "anchor-maps/codegraph.json" }
]
```
4. 分屏方式在 popup 里选:**两窗口平铺**(配对时自动左右平铺)或**同窗口标签页 + Chrome 分屏**(配对时开相邻标签页,右键 →「分屏」;建议关掉 Chrome 分屏自带的同步滚动,避免与扩展叠加)
5. 之后任意一侧点链接/标题,对侧自动跳页/滚动;Alt+Shift+D 切换专注 CSS

开发迭代:`npm run watch` 改代码,回 `chrome://extensions` 点刷新。

## anchor-map.json

汉化管线构建时生成,放镜像站根目录(或配置 `anchorMapUrl`):

```json
{
  "/learn/hooks": { "安装-react": "installing-react", "使用钩子": "using-hooks" }
}
```

- 外层键:页面逻辑路径,归一化形式(不带 `.html`、不带尾斜杠)
- 内层:**键 = 汉化站锚点,值 = 原站锚点**,均不含 `#`
- 查不到的锚点原样透传(两侧 slug 恰好相同时依然能对上)
- URL 路径两侧镜像(去掉 base/前缀后相同)则不需要额外配置

### 用生成器脚本产 anchor-map.json

`scripts/gen-anchor-map.mjs`:抓两侧线上渲染后的 HTML,按标题级别+顺序配对真实锚点 ID,
不模拟 slug 算法。配置在 `scripts/anchor-map.config.json`(仓库、站点对、是否读 frontmatter `source:`)。

```bash
node scripts/gen-anchor-map.mjs     # 产物在 out/<siteId>/anchor-map.json
```

生成后把文件放进各汉化站的 `public/` 目录(构建时会拷到站点根)重新部署。

## 已知简化(v1)

- 锚点同步只滚动不改对侧 URL 的 hash(避免整页刷新);地址栏/回退导航由 `tabs.onUpdated` 兜底同步
- 同步跳转时丢弃源页面 query 参数
- 滚动同步默认**语义模式**:按"视口顶夹在哪些标题之间"插值(锚点表映射),解析失败退回几何比例;可在 popup 关闭
- 专注 CSS 依赖配对状态(配对了才注入)

## 测试

```bash
npm test          # core 冒烟测试
npm run typecheck # 全部 workspace
```
