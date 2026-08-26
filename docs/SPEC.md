# docs-compare 规格说明(SPEC)

版本:0.1.0(2026-08-19)
状态:Chrome 扩展实现已交付;Tauri 实现进行中;其他实现见 [IMPLEMENTATIONS.md](IMPLEMENTATIONS.md)

## 1. 目标

并排对照阅读「原站文档 ↔ 汉化镜像」:

- 在任一侧点击链接,另一侧跳到对应语言的页面
- 在任一侧点击标题(锚点),另一侧滚动到对应语言的标题
- 滚动同步:默认按标题语义对齐,可退回几何比例
- 可注入 CSS 隐藏干扰内容("专注模式")
- 支持多对站点,配置驱动
- 移动端(iOS):**单文档 / 对照**两种布局模式——iPhone 竖屏强制单文档
  (工具条「原/译」选看哪侧),iPhone 横屏与 iPad 任意方向两模式皆可;
  单文档下隐藏侧仍被静默驱动,切回对照即已同步

非目标:翻译本身、页面内容改写。

## 2. 术语与核心概念

### 2.1 站点对(SitePair)

```
origin  原站,如 https://www.onorca.dev/docs
mirror  汉化镜像,如 https://lif3ng-vibe.github.io/docs-cn/orca
```

一侧 URL 剥掉 base(base 可含仓库路径)+ 可选前缀后得到**逻辑路径**,两站逻辑路径一致即互为对照页:

```
https://www.onorca.dev/docs/agents/codex   → 逻辑路径 /agents/codex
https://lif3ng-vibe.github.io/docs-cn/orca/agents/codex → 逻辑路径 /agents/codex
```

URL 映射 = 剥 base → 换 base。两侧扩展名不同(`.html` vs 干净路径)用 `originStripHtmlExt`/`mirrorStripHtmlExt` 归一。

### 2.2 锚点表(anchor-map.json)

翻译后标题 slug 已本地化,两侧锚点不同,需要映射表:

```json
{
  "/learn/hooks": { "安装-react": "installing-react", "使用钩子": "using-hooks" }
}
```

- 外层键:逻辑路径(归一化:无 `.html`、无尾斜杠,`/index.html` → `/`)
- 内层:**键 = 镜像锚点,值 = 原站锚点**,不含 `#`;内存中反向一份即得双向
- 查不到的锚点**原样透传**(两侧 slug 恰好相同时依然对上)
- 生成:`scripts/gen-anchor-map.mjs` 抓两侧线上渲染 HTML,按标题级别+顺序配对真实锚点 ID(零警告 ⇒ 翻译结构 1:1)
- 托管:绝对 URL(镜像站)或宿主内相对路径(扩展打包 `anchor-maps/*.json`)

### 2.3 同步设置(SyncSettings)

| 字段 | 含义 | 默认 |
|---|---|---|
| navSync | 跳转同步总开关 | true |
| scrollSync | 滚动同步总开关 | true |
| semanticScroll | 滚动按标题语义(否则几何比例) | true |
| focusCss | 专注模式 CSS | false |
| layout | 配对并排方式:windows(两窗口平铺)/ tabs(相邻标签页+原生分屏) | windows |

## 3. 架构

```
packages/core            纯 TS、零浏览器依赖,全部实现共用
  url.ts                   逻辑路径 / URL 映射 / 路径归一化
  anchors.ts               锚点表加载、双向查询、透传兜底
  config.ts                站点配置解析校验(错误带位置)
  scroll.ts                比例滚动 + 语义滚动(findBracket/interpAt)
apps/chrome-extension     实现一:Chrome MV3 扩展
  background.ts            同步状态机(service worker)
  content.ts               事件上报 + 命令执行
  main-world.ts            SPA pushState/replaceState 补丁
  protocol.ts              消息协议(跨实现复用的形状)
apps/tauri                实现二:多 webview 单窗口桌面应用
```

**分工原则**:映射/配置/锚点/滚动数学只存在于 core;宿主(扩展/Tauri/…)只做三件事——
**捕获信号**(点击/hash/history/滚动)→ **查 core 映射** → **驱动对侧**(导航/滚动/注 CSS)。

## 4. 消息协议(protocol.ts)

### 4.1 上报信号(content/view → 状态机)

| 消息 | 载荷 | 触发 |
|---|---|---|
| cs:hello | — | 脚本注入完成,请求当前状态 |
| cs:nav | href(完整 URL) | 链接点击(capture)、hashchange、SPA pushState(main-world 补丁派发 dc:history) |
| cs:scroll | topId, frac, ratio | 滚动(50ms 节流;抑制窗口内不上报) |

### 4.2 下发命令(状态机 → content/view)

| 消息 | 载荷 | 行为 |
|---|---|---|
| bg:state | settings, css | 应用设置;注入/移除专注 CSS(style 元素) |
| bg:anchor | anchor | getElementById → scrollIntoView(smooth,start)+ 高亮 1.6s;懒渲染重试 5×350ms;不改 URL hash |
| bg:scroll | anchorId, frac, ratio | 语义:interpAt(映射锚点区间);兜底:scrollTopFor(ratio);smooth 执行 |

### 4.3 管理(popup/控制器 → 状态机)

popup:status / popup:pair(+screen) / popup:unpair / popup:toggle / popup:set-layout

## 5. 行为规格

### 5.1 配对(pair)

1. 当前 URL → mapUrl 匹配站点对,失败则报错
2. 生成对侧 URL(带映射后的锚点)
3. 打开对侧:windows 布局 = 当前窗口缩左半屏 + 对侧开右半屏新窗口(popup 提供 screen 可用区域);tabs 布局 = 同窗口相邻标签页(Chrome 无编程式原生分屏 API,由用户右键标签 → 分屏)
4. 建立双向配对关系,下发 bg:state

### 5.2 跳转同步(cs:nav / onUpdated 兜底)

所有导航信号统一汇入 syncFrom(url):

1. 配对不存在或 navSync 关闭 → 忽略
2. 回声消除:本方主动触发的跳转,事件到达时吞掉
3. mapUrl 失败(站外链接)→ 忽略
4. hash 经锚点表双向映射(方向按源侧决定)
5. **同页**(逻辑路径相同):只发 bg:anchor 滚动,不刷新对侧
6. **跨页**:对侧导航到 `映射 URL + #映射锚点`;query 丢弃(已知简化)
7. 配对存活期:标签关闭 → 解除配对;SW 重启 → storage.session 恢复

### 5.3 滚动同步

**语义模式**(默认):
- 源侧:标题偏移缓存(h1-h6 带 id,排除 `_top`/`starlight__on-this-page`;MutationObserver+resize 失效重测),findBracket 把 scrollY 表达为 {锚点 id, 区间内比例 frac}
- 状态机:锚点表映射 id(透传兜底)
- 对侧:interpAt 在对应标题区间插值;对侧找不到该锚点 → 退回比例
- 首个标题之前 / 语义关闭 → 比例模式(scrollTopFor)

**执行与防抖**:
- 对侧 smooth 滚动,每条新命令把进行中的动画重定向到新目标(离散步进→连续跟随)
- 防回环:程序滚动后 600ms 内不上报自身滚动
- **锚点优先**:点标题后 1.2s 锁内忽略比例滚动命令(修复"标题被滚出屏幕"竞态);源侧同页锚点点击/hashchange 亦暂停上报 1s

**锚点滚动定位**:scrollIntoView(block:start);站点无 scroll-margin 时补 4rem(避开吸顶导航)

### 5.4 专注 CSS

按站点配置 css.origin/css.mirror,经 bg:state 下发对应侧;style 元素注入,可 Alt+Shift+D(扩展)切换。依赖配对状态。

### 5.5 窗口布局(Tauri 实现)

- 结构:一个窗口 + 三个子 webview(controller 宿主 UI 全幅铺底,left/right 铺在其上,中间 8px 缝隙露出 controller 的分隔条手柄)
- **标题栏补偿**:macOS 子 webview 的 (0,0) 落在标题栏下方约 28px(`outer_size` 不含标题栏,无法动态获得),按平台固定补偿;Windows/Linux 为 0
- **分隔条按比例**:窗口尺寸变化时按比例(默认 50/50,拖动后保持拖动比例)重分割,**不钉死绝对像素**;两侧视图右缘贴内容区右缘(滚动条完整可见)、底缘贴齐
- **重排职责**:窗口 `Resized` 事件由 Rust 侧读取实时 `inner_size` 重排;尺寸一律以 Rust 侧为准,controller 的尺寸回读会构成反馈环(曾致每轮塌陷一个标题栏高度),禁止参与

## 6. 配置 schema(sites)

```jsonc
[{
  "id": "orca",                       // 唯一
  "origin": "https://a.dev/docs",     // 原站 base(可含路径)
  "mirror": "https://b.github.io/x",  // 镜像 base
  "originPrefix": "/guide",           // 可选,额外剥离前缀
  "mirrorPrefix": "",
  "originStripHtmlExt": false,        // 可选,剥 .html
  "mirrorStripHtmlExt": false,
  "anchorMapUrl": "anchor-maps/orca.json", // 绝对 URL 或宿主内相对路径
  "css": { "origin": "...", "mirror": "..." }
}]
```

解析校验:parseSites,错误逐项报位置;非法/重复项跳过。

## 7. 已知简化与边界

- 锚点同步只滚动不改对侧 URL hash(避免整页刷新);地址栏/回退由 tabs.onUpdated 兜底
- 跳转同步丢弃 query
- 滚动假设窗口级滚动(非内部滚动容器)
- 懒渲染页面对侧锚点未渲染时退回比例,渲染后不主动校正
- 扩展请求 `<all_urls>` host 权限(自用取舍)

## 8. 测试

- `npm test`:core 冒烟测试(URL 映射/路径归一化/锚点双向+透传/配置校验/滚动比例/语义区间往返),34 断言
- Tauri 自动化(`apps/tauri`,窗口弹出、跑完自动退出、exit code 0/1):
  - `npm run selftest`:fixture 双语站(离线;页面高度两侧故意不对称,验证语义同步)
  - `npm run selftest:live`:真实站点(onorca.dev ↔ GitHub Pages 镜像;含远程 https 页面信号通道的端到端验证)
  - `npm run selftest:layout`:程序化 5 组窗口尺寸 + 最大化/还原 + 连续 resize 风暴,断言左右等宽、右缘贴内容区(滚动条完整)、底缘贴齐、顶部对齐
  - 同步断言:对照导航、锚点表加载、点标题对侧滚动到对应标题(视口顶 ±200px 内)、语义滚动跟随、点链接对侧跳页
- 扩展人工验收:配对分屏、点链接、点标题、滚轮跟手、专注 CSS 开关

### 8.1 实现间已知差异

- 防程序滚动回声:扩展用时间窗抑制(人类使用有天然阻尼);Tauri 用 programmatic 标志(apply 起静默至滚动停稳 + 2s 兜底 + 停稳后 400ms 余波抑制),因自测环境全为程序滚动
- Tauri 的 init script 在 document_start 注入, MutationObserver 观察 documentElement(body 未生成)

## 9. 交付物清单

- packages/core + 冒烟测试(34 断言)
- apps/chrome-extension(esbuild 构建,dist/ 加载)
- apps/tauri(Rust 哑中继 + controller 复用 core;fixture/live/layout 三种自测)
- scripts/gen-anchor-map.mjs + anchor-map.config.json(out/ 产物并同步扩展打包)
- docs/:本 SPEC、IMPLEMENTATIONS(其他实现方案详设)
