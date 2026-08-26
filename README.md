# docs-compare

[![CI](https://github.com/lif3ng-vibe/docs-compare/actions/workflows/ci.yml/badge.svg)](https://github.com/lif3ng-vibe/docs-compare/actions/workflows/ci.yml)

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
apps/cdp                  实现三:CDP 驱动 Chrome(Node CLI,零新壳)
  src/engine.ts            状态机(background.ts 平移到 Node,Port 接口解耦宿主)
  src/chrome.ts            puppeteer-core 接线:双窗口平铺、addBinding/init script/导航事件
  src/reporter.ts          content.ts 平移(上行 window.dcReport binding)
  src/selftest.ts          自动化测试(fixture/live 双模式)
scripts/gen-anchor-map.mjs  锚点表生成器
scripts/check-anchor-drift.mjs  锚点漂移检测(原站更新后表过期检查)
scripts/lib/anchor-scan.mjs    两者共用的抓取/配对逻辑
```

后续实现(Electron / WKWebView,见 docs/IMPLEMENTATIONS.md)应**只写壳**:

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

## CDP 版

零新壳:Node CLI(puppeteer-core)驱动 Chrome,开两个窗口自动左右平铺,常驻同步、Ctrl-C 退出即停。复用 core 与 protocol,通道全部走 CDP 原语(`Runtime.addBinding` 上行、`Page.addScriptToEvaluateOnNewDocument` 注入、`frameNavigated`/`navigatedWithinDocument` 捕获导航、`Page.navigate` 驱动)。

```bash
npm run cdp -- https://www.onorca.dev/docs/agents/codex   # 任意一侧 URL,自动归一为 左=原站/右=镜像
```

- 默认启动系统 Chrome + 临时 profile;找不到时设 `PUPPETEER_EXECUTABLE_PATH`
- `--user-data-dir <dir>`:持久 profile(登录态可累积);`--attach 9222`:连接已运行的 Chrome(需以 `--remote-debugging-port=9222` 启动;调试端口对本机进程可见,用完即关)
- `--region l,t,w,h`:自定平铺区域(默认取左窗当前 bounds 对半分);`--css` 专注 CSS;`--no-nav/--no-scroll/--no-semantic` 关单项同步
- 站点配置:`apps/cdp/config/sites.json`(与扩展同一 schema,锚点表打包在 `anchor-maps/`)
- 启动参数含禁后台节流(`--disable-backgrounding-occluded-windows` 等):窗口被遮挡时平滑滚动同步不冻结

自动化测试(弹出两个 Chrome 窗口,跑完自动退出,exit code 0/1;`DC_DEBUG=1` 可看信号流):

```bash
npm run selftest:cdp        # fixture 双语站(离线、快速,复用 Tauri fixtures)
npm run selftest:cdp:live   # 真实站点(onorca.dev ↔ GitHub Pages 镜像)
```

## 快速开始(Chrome 扩展)

**方式一:直接下载**(无需本地构建)——CI 每次 push 自动构建,固定链接永不过期:

```
https://github.com/lif3ng-vibe/docs-compare/releases/download/latest/docs-compare-extension.zip
```

(即仓库首页 Releases 区的「最新构建(扩展 + 桌面安装包)」。下载 → 解压 → `chrome://extensions` 开「开发者模式」→「加载已解压的扩展程序」→ 选解压目录)

**方式二:本地构建**:

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

内置的六个站点对可直接用(锚点表打包在扩展里,`anchor-maps/*.json`,由生成器同步;`official: true` 表示两侧都是官方维护的双语站,下拉打「官方」角标):

```json
[
  { "id": "orca", "origin": "https://www.onorca.dev/docs",
    "mirror": "https://lif3ng-vibe.github.io/docs-cn/orca",
    "anchorMapUrl": "anchor-maps/orca.json" },
  { "id": "codegraph", "origin": "https://colbymchenry.github.io/codegraph",
    "mirror": "https://lif3ng-vibe.github.io/docs-cn/codegraph",
    "anchorMapUrl": "anchor-maps/codegraph.json" },
  { "id": "mattpocock-skills", "origin": "https://www.aihero.dev/skills",
    "mirror": "https://lif3ng-vibe.github.io/docs-cn/mattpocock-skills",
    "anchorMapUrl": "anchor-maps/mattpocock-skills.json",
    "pageMapUrl": "anchor-maps/mattpocock-skills.page-map.json" },
  { "id": "ai-coding-dictionary", "origin": "https://www.aihero.dev/ai-coding-dictionary",
    "mirror": "https://lif3ng-vibe.github.io/docs-cn/ai-coding-dictionary",
    "anchorMapUrl": "anchor-maps/ai-coding-dictionary.json",
    "pageMapUrl": "anchor-maps/ai-coding-dictionary.page-map.json" },
  { "id": "ai-memory", "origin": "https://lif3ng-vibe.github.io/docs-cn/ai-memory-en",
    "mirror": "https://lif3ng-vibe.github.io/docs-cn/ai-memory",
    "anchorMapUrl": "anchor-maps/ai-memory.json" },
  { "id": "herdr", "origin": "https://herdr.dev/docs",
    "mirror": "https://herdr.dev/zh-cn/docs",
    "anchorMapUrl": "anchor-maps/herdr.json", "official": true }
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

## page-map.json(两侧路径不镜像的站点)

原站扁平页(如 aihero.dev 的 `/skills-ask-matt`)配上镜像分组页
(`/engineering/ask-matt/`)时,剥 base 后逻辑路径对不上,导航同步会 404——
这类站点需要页面路径映射,配置 `pageMapUrl` 指向打包的 `<siteId>.page-map.json`
(生成器从每页 frontmatter `source:` 自动产出,只收录与 base 推导不一致的页):

```json
{
  "/engineering/ask-matt": "/skills-ask-matt",
  "/terms/afk": "/ai-coding-dictionary/afk"
}
```

- 键 = 镜像逻辑路径;值 = 原站**完整路径**(命中时直接以 origin host + 完整路径拼 URL,
  绕过 base/prefix 剥拼——原站扁平页与 base 是兄弟路径,剥了再拼会多出斜杠)
- 原站侧点击也靠它识别 URL 归属(扁平页不是 base 子路径,前缀剥离认不出)
- 查不到的路径退回逻辑路径直映(两侧镜像的站点无需此表)

### 用生成器脚本产 anchor-map.json

`scripts/gen-anchor-map.mjs`:抓两侧线上渲染后的 HTML,按标题级别+顺序配对真实锚点 ID,
不模拟 slug 算法。配置在 `scripts/anchor-map.config.json`(仓库、站点对、是否读 frontmatter `source:`)。

```bash
node scripts/gen-anchor-map.mjs     # 产物在 out/<siteId>/anchor-map.json
```

生成后把文件放进各汉化站的 `public/` 目录(构建时会拷到站点根)重新部署。

### 锚点漂移检测

原站一更新,部署中的 anchor-map.json 就会过期(新标题没入表、旧映射失效),对照开始错位。日常检查:

```bash
node scripts/check-anchor-drift.mjs     # 有漂移 exit 1,可挂定时任务
```

现抓两侧线上标题重算「应有映射」,与打包表(`copyTo` 目录,随扩展/Tauri/CDP 发布,是在役真值)对比。报告新页面未入表 / 新增·失效·变化的映射 / 页面下线 / 两侧标题数量不齐(漏译信号);另作健康检查:生成器产物 out/ 与打包表是否一致、镜像站部署表(若部署)是否同步。有漂移 exit 1,重跑生成器(自动同步 copyTo)、各实现重新打包即可。

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

CI(GitHub Actions,`.github/workflows/ci.yml`):push/PR 自动跑 typecheck + core 冒烟 + 扩展/Tauri 前端打包 + CDP fixture 自测(headless)。live 自测依赖外网站点,只在本地跑。
