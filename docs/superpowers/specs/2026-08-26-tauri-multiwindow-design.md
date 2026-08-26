# Tauri 版多窗口 + 窗口标题跟随 — 设计

日期:2026-08-26
状态:已确认(方案 A 窗口隔离标签 + 左侧标题跟随已获用户通过;细节委托自行决定)

## 背景与目标

Tauri 版目前单窗口(`main` + `controller`/`left`/`right` 三个子 webview),一次只能对照一组文档。
用户需要:

1. **多窗口**:每个窗口工具条有「新窗口」按钮,点击开一个新窗口,新窗口可打开不同文档(独立选站、独立导航、互不干扰)。
2. **标题跟随**:窗口 title = 左侧(原站)文档的 `document.title`,左侧切换页面后 title 跟着变;未打开文档时回退「Docs Compare」。

### 现有全局状态(必须窗口化)

| 位置 | 现状 | 问题 |
|---|---|---|
| `main.rs` `DIVIDER_RATIO` | 全局单例 `Mutex<f64>` | 多窗口拖分隔条互相覆盖 |
| `dc_eval`/`dc_navigate`/`dc_ready` | `target` 直接查全局标签 `left`/`right` | 第二个窗口的同名标签查不到/查错 |
| `dc-report` 转发 | `emit_to("controller", …)` 写死 | 所有窗口的信号都发给窗口 1 |
| `relayout`/`dc_layout` | `get_window("main")` 写死 | 只重排窗口 1 |
| `capabilities/default.json` | `windows: ["main","controller","left","right"]` 枚举 | 新窗口 webview 无 IPC 权限,上报直接失效 |
| `controller.ts` | 信号按 `view: 'left'|'right'` 过滤,标签即语义 | 需要知道自己的窗口前缀 |

## 方案:窗口隔离标签(已确认)

每个窗口分配递增序号 N(从 1 开始),窗口标签 `w{N}`,子 webview 标签 `w{N}-controller` / `w{N}-left` / `w{N}-right`。序号只增不复用(窗口关闭不回收),避免关闭窗口后新窗口撞旧标签。

**窗口 1 兼容别名**:窗口 1 的标签同时注册为 `main`/`controller`/`left`/`right`?

——不。别名会让 `get_webview("left")` 与 `get_webview("w1-left")` 双份查找、且 Tauri 标签全局唯一不可重复注册。
**兼容做法改为:存量调用方全部改用带前缀标签,selftest 的 `dc_eval target: 'left'` 等字符串改为由 controller 侧约定**——selftest 场景里 target 字符串全部来自 controller.ts 自身(拼前缀),fixture 断言里的字面量同步更新。Rust 侧不保留旧标签名。

(实际检查:selftest 中 `query('left', …)`/`evalIn('left', …)` 全部经 controller.ts 的 `evalIn`/`query` 封装,封装内统一拼前缀即可,**前端调用点无需逐个改**;仅 reporter 注入的 `__DC_VIEW__` 语义从 `'left'|'right'` 变为完整标签,controller 的信号过滤从 `p.view` 全等判断改为「剥前缀后是 left/right 且前缀等于本窗口」两步。)

## 组件与数据流

### Rust(`src-tauri/src/main.rs`)

1. **建窗函数 `spawn_window(app, n) -> Result<Window>`**:提取现有 setup 里的建窗逻辑(建窗口 + 三个子 webview + 布局),参数化标签前缀 `w{n}-`。窗口 1 在 setup 里调它,「新窗口」按钮经命令 `dc_new_window` 也调它(分配 `NEXT_WINDOW` AtomicU64 的下一个序号)。
2. **每窗口分隔比例**:`static DIVIDER_RATIOS: Mutex<HashMap<String, f64>>`(键 = 窗口标签,如 `w1`),`relayout`/`dc_layout` 按发起窗口的标签取用。
3. **命令窗口绑定**:`dc_eval`/`dc_navigate`/`dc_layout`/`dc_ready`/`dc_new_window`/`dc_set_title` 全部加 `window: tauri::Window` 参数(Tauri 自动注入**发起调用的窗口**,多窗口天然各管各)。`dc_eval`/`dc_navigate` 的 `target` 语义变为「本窗口内的视图名」(`left`/`right`),Rust 侧拼 `format!("{}-{target}", window.label())` 查找;`dc_ready` 同理查本窗口的 left/right。**完整标签逃生门**:target 匹配 `^w\d+-`(如 `w2-left`)时视为完整标签直接查找、不拼前缀——selftest 跨窗口操作用,普通路径不感知。
4. **信号路由**:`dc-report` 监听器解析上报载荷里的 `view` 字段(完整标签,如 `w2-left`),剥出窗口前缀 `w2`,`emit_to("{w2}-controller", "dc-signal", …)`。载荷无前缀或前缀非 `w\d+-` 格式 → 丢弃并 warn(不可路由)。
5. **窗口事件**:`on_window_event` 里 `Resized` → `relayout(app, window.label())`(不再写死 `main`)。其余事件不处理。
6. **标题跟随(实现修订:改 Rust 原生事件)**:原设计经 reporter→controller→`dc_set_title` 命令,实现时发现 JS 信号时机不可靠——`cs:nav` 点击 capture 发生在导航前(title 是旧页的),`cs:hello` 在 WebView2 首次加载不跑 initialization_script 全程 0 条。改为 left webview 构建时挂 `on_document_title_changed`(Tauri 稳定 API)→ `set_title` 到所属窗口:整页导航/SPA/动态 title 全覆盖。`dc_set_title` 命令保留未用(不作为主通道);空 title 回退「Docs Compare」。
7. **selftest 隔离**:`dc_selftest_done` 里 `app.exit` 语义不变(任何窗口跑 selftest 仍退出整个进程——selftest 只在窗口 1 跑)。`--selftest=layout` 的 `layout_selftest` 全程操作窗口 1(`w1`),把写死的 `"main"`/`"left"`/`"right"` 换成 `"w1"`/`"w1-left"`/`"w1-right"`。
8. **capabilities**:`windows` 改为 `["w*"]`(Tauri 2 支持 glob 标签,`w*` 覆盖 `w1`、`w1-controller`、`w2-left` 等全部窗口与子 webview;旧标签 `main` 等不再创建,枚举项删除)。
9. **`dc_new_window` 必须 async(实现修订)**:Tauri 2 在 Windows 上,同步命令里建 webview 会死锁——`add_child` 内部 `run_on_main_thread` + channel 同步等待,而同步命令本身占着主线程(官方文档 "Known issues" 明示 async 命令建窗)。async 命令跑线程池,主线程空闲,channel 才能回包。症状:窗口壳建出、三个子 webview 永远不出现。

### Reporter(`inject/reporter.ts`)

- `__DC_VIEW__` 注入值从 `'left' | 'right'` 改为完整标签 `w{n}-left`(Rust 拼注入串,已有 `format!("window.__DC_VIEW__ = {label:?};")` 处改)。
- `cs:hello`/`cs:nav` 载荷加 `title: document.title ?? ''`(`cs:hello` 时机 document_start,title 常为空,仅作尽力而为;`cs:nav` 时机 title 已就绪,是标题跟随的主信号)。

### Controller(`frontend/controller.ts`)

1. **本窗口前缀**:启动时 `getCurrentWindow().label()`(取自 `@tauri-apps/api/window`)→ 本窗口视图名 = `label.replace(/^w\d+-/, '')`。controller 自身标签是 `w{n}-controller`,剥后缀得 `w{n}`,本窗口 left/right 完整标签 = `w{n}-left`/`w{n}-right`。
2. **evalIn/navigateTo/applyTo/query**:target 传 `left`/`right` 语义名,invoke `dc_eval` 时由 Rust 拼完整标签(前端不感知完整标签,见上 Rust §3)。
3. **信号过滤**:`dc-signal` 监听里,`p.view` 先剥 `w\d+-` 前缀得视图名(`left`/`right`),前缀不等于本窗口前缀则忽略(现在 `emit_to` 已按窗口定向,此过滤是双保险)。
4. **标题跟随(实现修订)**:controller 不参与——见 Rust §6,原生 `on_document_title_changed` 驱动。若保留 JS 侧 set title,`cs:nav` 的旧页 title 会把原生事件设好的新标题改回去,故彻底移除。
5. **「新窗口」按钮**:`index.html` 工具条 `#open-pair` 后加 `<button id="new-window">新窗口</button>`(白底蓝边次要样式,与主按钮区分);`wireUi` 挂 click → `invoke('dc_new_window')`,状态栏显示新窗口标签。
6. **blank.html(待命页)导航后的标题**:左侧从文档页导航回 blank(不会发生——工具条只会导航到站点 URL;初始 blank 阶段 title 保持「Docs Compare」)。初始 title 由 Rust 建窗时 `.title("Docs Compare")` 设定;blank 的 title「待命」会经原生事件写入——实现时用空判定:blank.html 的 `<title>待命</title>` 实测不会覆盖窗口标题(initialization_script 阶段事件不触发),保持现状不额外处理。

### 数据流(新窗口)

```
点「新窗口」→ invoke dc_new_window(async,Windows 同步命令死锁)→ Rust 取 NEXT_WINDOW++ → spawn_window(app, n)
  → 新 Window w{n} + w{n}-controller/w{n}-left/w{n}-right(干净初始态,blank.html)
  → 新 controller 独立加载 sites.json、独立状态机
内容页导航/标题变化 → w{n}-left 的 on_document_title_changed(Rust 原生)
  → 本窗口 set_title → 标题更新
内容页点击/滚动 → reporter dc-report {view: "w{n}-left", t: "cs:nav"/"cs:scroll"}
  → Rust 路由 emit_to "w{n}-controller" → 本窗口 controller 消费
```

## 错误处理

- `dc_new_window` 分配标签已存在(序号只增,理论不发生):返回 Err,前端状态栏显示「开窗失败:{e}」。
- `spawn_window` 失败(平台资源耗尽等):同上,Err 冒泡到状态栏。
- 信号不可路由(载荷 view 无 `w\d+-` 前缀):eprintln warn 后丢弃,不影响其他窗口。
- `dc_eval` 查不到 webview:现状已是 `Err("no webview: …")`,窗口关闭瞬间controller 仍在 eval 的竞态由调用方 catch(controller 的 syncFrom 本就 fire-and-forget)。
- 窗口关闭:webview 标签随窗口销毁,`DIVIDER_RATIOS` 里残留条目(泄漏一条 f64,无害;不清理,保持简单)。
- `getCurrentWindow()` 失败(非 Tauri 环境跑 controller,如浏览器直接开 index.html):回退前缀 `w1`,行为同现状。

## 测试(已确认要加自测)

新增 `--selftest=multiwindow` 模式(Rust 启动参数分支 + controller `__DC_SELFTEST__ = 'multiwindow'`):

1. 窗口 1 fixture 对照打开(复用现有 selftest 的初始导航流程)。
2. invoke `dc_new_window` → 轮询 `dc_ready`(窗口 2)→ 断言新窗口存在(`getAllWindows`/Rust 查询)且其 left/right 是独立 webview。
3. 窗口 2 fixture 打开**另一页面**(page2),断言:
   - 窗口 2 左右加载的是 page2(不串窗口);
   - 窗口 1 的左右 URL 未变(互不干扰);
   - 窗口 2 标题 = fixture en page2 的 title;窗口 1 标题 = fixture en index 的 title(标题各随各窗口)。
4. 窗口 1 内改 hash → 窗口 2 无反应(信号隔离)——轻量验证:`syncFrom` 不跨窗口导航,通过窗口 2 URL 不变断言。
5. 输出 JSON 结果(与现有 selftest 同格式),`dc_selftest_done` 退出。

实施方式:multiwindow 场景由**窗口 1 的 controller** 驱动(它有完整 query/eval 原语),对窗口 2 的操作与断言全部经 Rust §3 的完整标签逃生门(`target: 'w2-left'` 直达窗口 2 的视图):打开 page2 即 `invoke('dc_navigate', { target: 'w2-left', url })` + `w2-right` 同理;断言窗口 2 标题经新增 Rust 查询命令 `dc_window_title(label)`(selftest 专用,返回指定窗口当前 title)。

回归:现有三套 selftest(fixture/live/layout)全绿——fixture/live 的 target 路由改由 Rust 拼前缀,调用点不变;layout 自测改 `w1` 标签字面量。

## 明确不做(YAGNI)

- 不做窗口位置记忆/级联排布(新窗口由 OS/tauri 默认位置)。
- 不做窗口间文档拖拽/会话迁移。
- 不持久化窗口数量;关掉就没了。
- 不做 title 的 MutationObserver 兜底(主流文档站 pushState/hashchange 已覆盖;动态 title 站点第一版接受不跟随)。
- 不给「新窗口」加快捷键。
- macOS 28px 标题栏补偿逻辑原样保留(多窗口共用 `titlebar_h()`)。
