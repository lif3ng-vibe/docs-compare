# 其他实现方案详设(Electron / WKWebView)

已交付:Chrome 扩展(apps/chrome-extension)、Tauri(apps/tauri)、CDP(apps/cdp,2026-08-20)、Apple iOS/Catalyst(apps/apple,2026-08-27,见 D 节)。
本文档详设尚未开工的实现,统一遵循 SPEC 的架构原则:**core 全复用,宿主只写"捕获→映射→驱动"的接线**。

通用复用清单(所有实现):

- `@docs-compare/core`:url.ts / anchors.ts / config.ts / scroll.ts(含语义滚动数学)
- `protocol.ts` 消息形状:cs:nav / cs:scroll(topId,frac,ratio) / bg:anchor / bg:scroll(anchorId,frac,ratio) / bg:state
- content.ts 的上报/执行逻辑(点击 capture、hashchange、history 补丁、标题缓存、锁与防抖)——按宿主 API 平移
- sites 配置 schema 与 anchor-map.json 约定

---

## A. Electron

**形态**:单窗口,两个 `WebContentsView`(Electron 30+,替代已废弃 BrowserView)+ 可拖分隔条;顶部工具条(站点切换、同步开关)。包 ~100-200MB,内存 300-500MB。

**能力映射**

| 需求 | Electron API |
|---|---|
| 捕获导航 | `webContents.on('did-navigate')`(整页)、`did-navigate-in-page`(hash/pushState,SPA 全覆盖,优于扩展的补丁方案) |
| 注入 JS | `webContents.executeJavaScript`(任意时机);或 `session.setPreloads`/`webFrame` 级 preload |
| 注入 CSS | `webContents.insertCSS` / `removeCSS`(原生成对,比 style 元素更干净) |
| 驱动导航 | `webContents.loadURL(url)` |
| 窗口 | `BrowserWindow` + 手动排两个 view 的 bounds,分隔条 = 透明 strip 捕获拖拽 |

**与扩展的差异点**
- 无需配对管理:固定左右两个 view,状态机退化为「信号来自哪侧 → 驱动另一侧」
- 无 SW 生命周期问题:内存态即可,锚点表缓存不怕被杀
- main-world history 补丁可以省掉(did-navigate-in-page 原生覆盖),reporter 只需点击/hashchange/滚动
- 配置持久化:直接读本地 JSON 文件,可加设置 UI

**坑**
- `did-navigate` 与脚本信号重复 → 沿用"逻辑路径相同即忽略 + 期望 URL 回声消除"的统一 syncFrom 汇聚
- executeJavaScript 的返回 Promise 要小心页面销毁时的 rejection

**工作量**:壳 + 状态机平移约 1-2 天(大部分从 background.ts/content.ts 改写)。

---

## B. CDP 驱动现有 Chrome(最轻,零新壳)——已交付 apps/cdp

实现备注(puppeteer-core,按本节设计落地,两处实测修正):
- reporter 注入用 `Page.addScriptToEvaluateOnNewDocument`,其执行时点比 WKWebView 的 init script 更早,`document.documentElement` 可能为 null——DOM 相关初始化需等其出现(reporter.ts 的 whenDocEl 轮询)
- Chrome 会冻结后台标签页的渲染:smooth 滚动在后台标签永不推进。双窗口形态天然规避;启动参数加禁后台节流兜底;自测也必须用双窗口而非同窗双标签
- 验证了「Chrome 下 Runtime.evaluate 轮询不打断顺滑滚动」(WebKit 特有坑在 Chrome 不存在),selftest 可放心轮询等待滚动停稳


**形态**:Node 脚本(Puppeteer/Playwright)通过 CDP 控制用户日常 Chrome(或独立 profile),开两个标签页并由脚本平铺两个窗口。无 GUI 框架;复用用户登录态与浏览器生态。

**能力映射**

| 需求 | CDP |
|---|---|
| 注入脚本 | `Page.addScriptToEvaluateOnNewDocument`(= init script,新文档自动注入) |
| 执行 JS | `Runtime.evaluate`(可拿返回值,最灵活) |
| 捕获导航 | `Page.frameNavigated` + `Page.navigatedWithinDocument`(hash 变更原生事件) |
| 注入 CSS | `CSS.addStyleSheet`,或注入脚本加 style 元素 |
| 驱动导航 | `Page.navigate` |
| 平铺窗口 | `Browser.setWindowBounds`(或沿用扩展的 popup screen 方案由 CLI 参数给屏幕区域) |

**信号通道**:reporter 脚本里 `Runtime.evaluate` 一个全局函数?不行——反向通道用 `Runtime.addBinding('dcReport')`,页面侧 `window.dcReport(json)`,Node 侧收 `Runtime.bindingCalled` 事件。这是 CDP 的标准双向通道,无权限问题。

**形态选择**
- CLI:`docs-compare --pair https://...` 打开并平铺,退出即停
- 或常驻:`docs-compare watch` 记录配对,任意一侧信号驱动另一侧

**坑**
- 调试端口安全面:绑定 127.0.0.1、用完即关;建议连"已运行的 Chrome(--remote-debugging-port)"时提示风险
- addScriptToEvaluateOnNewDocument 对已打开页面不追溯 → 启动时对现存页 Runtime.evaluate 手动补注入
- Node 进程退出 = 同步停止(可接受,自用)

**工作量**:最小,半天到一天。protocol 消息几乎一一映射成 binding/evaluate 调用,是验证「core+protocol 跨宿主复用」成本最低的一条路。

---

## C. macOS 原生 WKWebView(Swift)

> 2026-08-27 状态:本节设计已由 D 节实现覆盖(经 Mac Catalyst 跑 macOS,同套代码)。

**形态**:AppKit `NSSplitViewController` + 两个 `WKWebView`,原生可拖分隔条;app 几 MB。仅 macOS。

**能力映射**

| 需求 | WKWebView API |
|---|---|
| 注入脚本 | `WKUserScript`(forMainFrameOnly,documentStart 注入,任意 origin) |
| 页面 → App | `WKUserContentController.add(_ messageHandler:)` —— **任意 origin 可用,无需给第三方页面开任何 IPC 权限**(相比 Tauri 的 remote capability 更省心) |
| App → 页面 | `evaluateJavaScript`(任意时机) |
| 捕获导航 | `decidePolicyFor navigationAction`(含 same-document/hash) |
| 注入 CSS | evaluateJavaScript 加 style 元素 |
| 分隔条 | NSSplitViewController 原生 |

**架构**:Swift 壳(Relay/窗口)+ 一个 controller WKWebView(隐藏或作工具条)加载 esbuild 打包的 TS controller(复用 core 与 background.ts 状态机),Swift↔controller 走 WKScriptMessageHandler / evaluateJavaScript。或者直接把状态机翻成 Swift(~300 行,放弃 TS 复用)——二选一,前者复用最大。

**坑**
- 单平台;WKWebView 的 cookie/登录态独立于 Safari(共享 WebKit 数据需要 WebsiteDataStore 配置)
- 最低系统版本决定部分 API 可用性

**工作量**:1-2 天(Swift 熟练的话);对 macOS 自用是最精致的形态。

---

## D. iOS / iPadOS / Mac Catalyst——已交付 apps/apple(2026-08-27)

按 C 节的 WKWebView 能力映射落地(选了"TS controller 最大复用"分支),扩展到 iOS:
Tauri 的多 webview 架构在 iOS 走不通(wry `build_as_child` 官方不支持 iOS),
而 UIKit 挂多个 WKWebView 是标准做法,正好把 C 节方案反哺成 iOS/Catalyst 双平台。

**形态**:Swift 哑壳(`ios/App/`,7 文件 ~700 行,main.rs 的平移)+ 三个共享进程池的
WKWebView:controller(可见工具条页)+ left/right(文档页)。Mac Catalyst 直接同代码跑 macOS。

**通道**(全部 JSON 字符串,CDP binding 同款先例):

- 上行:`WKScriptMessageHandler`(controller → dcInvoke;reporter → dcReport)
- 下行:`evaluateJavaScript("window.__dcDispatch(...)")`;命令回包 `{t:'cmd:result',reqId,...}`
- 资源:`dcapp://bundle/*`(WKURLSchemeHandler 映射 bundle 内 esbuild 产物 `web/`),
  自定义 scheme 给 controller 页非 null origin——selftest 的 `location.origin/fixtures`
  与同源 fetch sites.json 都依赖它
- 命令面与 main.rs 对齐(dc_ready/dc_eval/dc_navigate/dc_layout/dc_set_title/
  dc_window_title/dc_selftest_done),新增 `dc_set_mode`;`dc_new_window` 返回错误(留待 iPad scenes)

**iOS 特有**:

- 布局模式:**单文档/对照**可切;iPhone 竖屏强制单文档,横屏与 iPad 任意方向两模式皆可。
  单文档=隐藏一侧 webview 但保持静默驱动(引擎零改动,切回即同步)
- 安全区:controller 页全屏铺满 + CSS `env()`,JS 用探针元素数值化供分隔条数学;
  内容页 frame 由 `LayoutMath.computeFrames`(纯函数,layout 自测对象)计算
- 旋转 = `viewDidLayoutSubviews` 重布局,分隔条比例保持(Tauri 的 Resized→relayout 同构)
- 标题跟随:left 的 `title` KVO → `scene.title`(Catalyst 窗口可见)
- 竖屏点「对照」→ 提示横屏;`viewport-fit=cover` + 16px 输入字号(防聚焦缩放)
- 自测:启动参数 `--selftest[=live|layout]` 经 `simctl launch` 传入,
  结果 JSON 打 stdout、`pass==total` 定退出码;120s 看门狗;CI macos job 跑 fixture 模式

**坑(实测)**:

- 模拟器构建免签:`CODE_SIGNING_ALLOWED=NO` 命令行传参(工程里 sdk 条件设置偶发不生效)
- `about:blank` 与 wry/macOS 同款不提交导航问题 → 左右初始页用 `dcapp://bundle/blank.html`
- 精简版 Xcode(删过运行时)需 `xcodebuild -downloadPlatform iOS` 手动装运行时(~9GB 磁盘)
- `evaluateJavaScript` 会打断 WebKit 顺滑滚动(Tauri 版已知),selftest 沿用"固定等待后单次查询"策略

**分发**:模拟器/本地自用优先;真机走 Xcode 个人 team 调试签名;Catalyst 产物 ad-hoc 签名本机跑。

---

## 选型对照

| | 包体积 | 内存 | 复用度 | 平台 | 附加依赖 |
|---|---|---|---|---|---|
| Electron | ~100-200MB | 300-500MB | 高 | 全平台 | 无 |
| CDP(已做) | 0 | ~0(复用 Chrome) | 最高 | 全平台 | Node 进程 |
| Apple(已做) | ~5MB | 150-250MB | 中-高 | iOS/iPadOS/macOS(Catalyst) | Xcode 工具链 |
| Tauri(已做) | ~10MB | 150-250MB | 高 | 全平台 | Rust 工具链 |
