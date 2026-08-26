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
  src/remote-sites.ts      远程站点列表(GitHub Release 固定 URL 下发+校验)
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
apps/apple                实现四:iOS / iPadOS / Mac Catalyst(Swift 哑壳 + WKWebView)
  ios/App/*.swift          三视图容器、命令中继、dcapp:// 资源、布局数学、自测
  frontend/controller.ts   状态机(Tauri 版平移)+ 工具条 + 单文/对照模式
  inject/reporter.ts       content.ts 平移(WKUserScript 注入,上行 messageHandler)
scripts/gen-anchor-map.mjs  锚点表生成器
scripts/gen-remote-sites.mjs  远程 sites.json 生成器(CI 上传 Release,见「收录新站点」)
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
- 工具条站点下拉:列出全部站点对(与扩展 popup 同源),选中即开该站首页对照;与 URL 框双向联动
- 工具条「新窗口」按钮:一键再开一个对照窗口,各窗口独立选站/导航/分隔条,互不干扰
- 窗口标题跟随左侧(原站)文档标题,切页即变(未打开文档时为「Docs Compare」);Rust 原生 `on_document_title_changed` 事件驱动
- 中间分隔条可拖拽;窗口缩放时**按比例**保持左右分割(默认 50/50),两侧滚动条始终完整可见
- 站点配置:启动用打包的 `apps/tauri/config/sites.json`,后台拉远程热更(见「收录新站点」)
- 自动化测试(窗口会弹出,跑完自动退出,exit code 0/1):

```bash
npm run selftest           # fixture 双语站(离线、快速):导航/锚点/语义滚动同步
npm run selftest:live      # 真实站点(onorca.dev ↔ GitHub Pages 镜像)
npm run selftest:layout    # 布局:5 组尺寸 + 最大化 + 连续 resize,断言等宽/贴边
npm run selftest:multiwindow  # 多窗口:开窗/独立导航/互不干扰/标题跟随
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

## Apple 版(iOS / iPadOS / Mac Catalyst)

Swift 哑壳(main.rs 的平移)+ 三个 WKWebView(controller 工具条页 + 左右文档页),同步引擎与站点配置完全复用 core。通道全部 JSON 字符串:上行 `WKScriptMessageHandler`(dcInvoke/dcReport),下行 `evaluateJavaScript`(`window.__dcDispatch`)。

```bash
npm run sim:apple            # 构建 + 装 iPhone 模拟器正常启动(手动过 UI)
npm run selftest:apple       # fixture 离线自测(模拟器里跑完自动退出)
npm run selftest:apple:live  # 真实站点
npm run selftest:apple:layout # 纯 Swift 布局断言(安全区/比例钳制/单文档帧)
```

- 前置:Xcode(完整版含 iOS 运行时;精简安装先 `xcodebuild -downloadPlatform iOS`)+ `brew install xcodegen`
- 布局模式:**单文档 / 对照**可切。iPhone 竖屏强制单文档(工具条「原/译」选看哪侧),横屏与 iPad 任意方向两模式皆可
- 单文档模式下隐藏侧仍被静默驱动(导航/滚动同步照常)——切回对照或转横屏即已同步
- 工具条与桌面同款:站点下拉(远程热更同机制)、分隔条可拖(比例随旋转保持)
- 多窗口 v1 不支持(按钮隐藏,命令返回错误,留待 iPad scenes)
- 真机调试:用 Xcode 打开生成的工程选自己 team 签名即可(模拟器构建免签);Catalyst 冒烟跑法见 `.claude/skills/apple/SKILL.md`

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

内置的六个站点对可直接用(锚点表打包在扩展里,`anchor-maps/*.json`,由生成器同步;`official: true` 表示两侧都是官方维护的双语站,下拉打「官方」角标)。列表会随远程热更自动补新站(见「收录新站点」),以下为兜底快照:

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

## 收录新站点(远程热更,零发版)

站点列表不随客户端发版:CI 每次 push main 会把 `sites.json` + 全部锚点表
(平铺命名 `anchor-maps-<id>[.page-map].json`)上传到
[Release latest](https://github.com/lif3ng-vibe/docs-compare/releases/tag/latest),
固定 URL `releases/download/latest/<file>` 永不变化。扩展与 Tauri 客户端
启动后台拉取,成功即热更——**新增站点合入 main,所有客户端下次启动自动出现**。

收录一个新站点的完整流程:

1. **加配置**:改 `packages/core/src/defaults.ts`(`DEFAULT_SITES` 追加一项:
   id/名称/origin/mirror/`official` 标记等)——这是唯一事实源,
   CI 用 `scripts/gen-remote-sites.mjs` 从它生成下发的 sites.json
   (anchorMapUrl 自动改写为 Release 绝对 URL)
2. **生成锚点表**:`scripts/anchor-map.config.json` 加站点对 → `node scripts/gen-anchor-map.mjs`
   → 产物自动 `copyTo` 到 `apps/chrome-extension/src/static/anchor-maps/<id>.json`
   (CI 会把该目录整体上传 Release)
3. **同步打包兜底**:`apps/tauri/config/sites.json`、`apps/cdp/config/sites.json`
   抄同一份(离线/CI 时的兜底数据;name 等字段与 defaults.ts 保持一致)
4. **验证后合入**:本地 `npm test && npm run typecheck`,合入 main 后 CI 自动
   滚动 Release;可顺手 `curl -sL .../releases/download/latest/sites.json` 抽查

客户端加载策略(拉不到就退打包,永不白屏):

- **Tauri**:启动加载打包 sites.json 立即可用,后台拉远程,成功整体替换并重渲染下拉
- **扩展**:SW 冷启动拉一次存 `dc_sites_remote`;`getSites()` 三级合并
  **用户手存 > 远程 > 打包内置**(用户改过的 id 不被远程覆盖;远程新站自动补入)
- 拉取失败/超时(5s)/校验不过 → 静默用本地,下次再试;远程锚点表 404 → 空表退化为锚点原样透传

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

CI(GitHub Actions,`.github/workflows/ci.yml`):push/PR 自动跑 typecheck + core 冒烟 + 扩展/Tauri/Apple 前端打包 + CDP fixture 自测(headless)+ iOS 模拟器自测(macos job)。live 自测依赖外网站点,只在本地跑。
