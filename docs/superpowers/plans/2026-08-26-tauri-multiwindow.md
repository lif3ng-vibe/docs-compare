# Tauri 多窗口 + 窗口标题跟随 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tauri 版支持开多个对照窗口(每窗口一个「新窗口」按钮、独立状态互不干扰),且每个窗口 title 跟随本窗口左侧(原站)文档标题。

**Architecture:** 窗口隔离标签——窗口序号 N 递增,窗口 `w{N}` + 子 webview `w{N}-controller`/`w{N}-left`/`w{N}-right`;全部 Rust 命令经 `window: tauri::Window` 参数绑定发起窗口,`target` 语义名由 Rust 拼完整标签;`dc-report` 信号按载荷里的完整 view 标签路由回同窗口 controller。标题:reporter 的 `cs:nav`/`cs:hello` 载荷带 `document.title`,controller 见左侧导航即 `dc_set_title`。

**Tech Stack:** Rust + Tauri 2.11(已装,crate 不加新依赖)、TypeScript + esbuild(iife)、`@tauri-apps/api`(window 模块新增 import,不加包)。

**Spec:** `docs/superpowers/specs/2026-08-26-tauri-multiwindow-design.md`

## Global Constraints

- 仓库根:`C:\Users\lif3n\src\docs-compare`;bash 相对路径即可。
- 窗口标签命名:窗口 `w{N}`、controller `w{N}-controller`、内容 `w{N}-left`/`w{N}-right`,N 从 1 起、只增不复用。
- 旧标签 `main`/`controller`/`left`/`right` 全部废弃,不保留别名。
- UI 文案中文;注释风格与现文件一致(中文、说明「为什么」)。
- 窗口 title 回退值:`Docs Compare`(与现 `.title("Docs Compare")` 一致)。
- commit 信息不带 Co-Authored-By/任何 Claude 署名(用户全局规则)。
- cargo 侧不加新 crate(用现有 tauri/std;`AtomicU64`、`HashMap` 均标准库)。
- 验证命令(仓库根):`npm run typecheck`、`npm run build:tauri`、`npm run selftest`、`npm run selftest:layout`、`npm run selftest:multiwindow`(本计划新增)。窗口会真实弹出、跑完自动退出,exit 0/1。
- CI(`ci.yml`)不跑 Tauri cargo 自测,无需改 CI;但 typecheck/build:tauri 必须绿。

## 现状速览(给零上下文工程师)

- `apps/tauri/src-tauri/src/main.rs`(唯一 Rust 文件,~360 行):
  - `main()`:`setup` 闭包建窗口 `main` + 3 子 webview;`app.listen("dc-report")` 转发到 `emit_to("controller","dc-signal")`;`on_window_event` Resized→`relayout(&window.app_handle())`;`invoke_handler` 注册 `dc_ready/dc_eval/dc_navigate/dc_layout/dc_selftest_done`。
  - `static DIVIDER_RATIO: Mutex<f64>`(16 行)全局单例。
  - `relayout(app)`(171 行):`get_window("main")` 写死;按 DIVIDER_RATIO 排 controller/left/right。
  - `dc_layout`(207 行):算比例存 DIVIDER_RATIO 再 relayout。
  - `layout_selftest`(232 行):写死 `"main"`/`"left"`/`"right"` 标签做几何断言。
- `apps/tauri/inject/reporter.ts`:IIFE 注入内容视图;`__DC_VIEW__` 全局(Rust 注入 `'left'|'right'`);`report({t:'cs:hello'|'cs:nav'|'cs:scroll', …})` 经 `plugin:event|emit` 发 `dc-report`。
- `apps/tauri/frontend/controller.ts`(~600 行):`evalIn/applyTo/navigateTo` invoke `dc_eval/dc_navigate`(target 传 `'left'|'right'`);`listen('dc-signal')` 按 `p.view === 'left'|'right'` 过滤;`wireUi()` 绑工具条。
- `apps/tauri/frontend/index.html`:工具条 `#toolbar`(brand/site-select/url-left/open-pair/status)+ `#divider`。
- `apps/tauri/src-tauri/capabilities/default.json`:`windows: ["main","controller","left","right"]` 枚举。
- `apps/tauri/src-tauri/tauri.conf.json`:`app.windows: []`(窗口全由 Rust setup 建,无静态窗口定义——新窗口无需改此文件)。
- fixture 站点标题:`fixtures/en/index.html` → `Fixture EN — Index`;`fixtures/en/page2.html` → `Fixture EN — Page 2`;zh 侧 `Fixture 中文 — 首页` 等。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `apps/tauri/src-tauri/src/main.rs` | Modify(大改) | 窗口隔离标签、spawn_window、每窗口比例表、命令窗口绑定、dc_new_window/dc_set_title/dc_window_title、信号路由、multiwindow selftest 分支 |
| `apps/tauri/src-tauri/capabilities/default.json` | Modify | `windows` 改 `["w*"]` |
| `apps/tauri/inject/reporter.ts` | Modify | `cs:hello`/`cs:nav` 载荷加 `title` |
| `apps/tauri/frontend/controller.ts` | Modify | 本窗口前缀解析、信号过滤、标题跟随、「新窗口」按钮、multiwindow selftest 场景 |
| `apps/tauri/frontend/index.html` | Modify | 工具条加 `<button id="new-window">` |
| `apps/tauri/package.json` | Modify | 加 `selftest:multiwindow` script |
| 根 `package.json` | Modify | 加 `selftest:multiwindow` script |
| `README.md` | Modify | Tauri 版小节补两行(多窗口按钮、标题跟随、新自测命令) |
| `.claude/skills/tauri/SKILL.md` | Modify | 自测清单加 multiwindow 一行 |
| `.claude/skills/run-tests/SKILL.md` | Modify | 自测矩阵表加一行 |

无新文件(main.rs 保持单文件,与现状一致;拆窗口模块属无关重构,不做)。

任务切分按「每步可独立验证 + commit」:Rust 标签改造是一次原子重构(拆开任何一半都是不可编译的中间态),故 Task 1 整体交付;Task 2 标题、Task 3 按钮+新窗命令、Task 4 自测、Task 5 文档各自独立。

---

### Task 1: Rust 窗口隔离标签(多窗口地基)

**Files:**
- Modify: `apps/tauri/src-tauri/src/main.rs`
- Modify: `apps/tauri/src-tauri/capabilities/default.json`

**Interfaces:**
- Consumes: 无(纯重构,外部行为不变)。
- Produces(Task 2-4 依赖的签名):
  - `fn spawn_window(app: &tauri::AppHandle, n: u64) -> tauri::Result<tauri::Window>` — 建窗口 `w{n}` + 三子 webview
  - `fn next_window_id() -> u64` — `NEXT_WINDOW.fetch_add(1, Ordering::Relaxed)`,首窗 setup 里先取(返回 1)
  - `#[tauri::command] fn dc_new_window(app: tauri::AppHandle) -> Result<String, String>` — 返回新窗口标签(如 `"w2"`)
  - `#[tauri::command] fn dc_set_title(window: tauri::Window, title: String) -> Result<(), String>`
  - `#[tauri::command] fn dc_window_title(app: tauri::AppHandle, label: String) -> Result<String, String>` — selftest 查询
  - `dc_eval`/`dc_navigate` 签名变更为 `(app, window: tauri::Window, target: String, …)`,target 语义名(`left`/`right`)或完整标签(`^w\d+-` 前缀直达)
  - `dc_ready`/`dc_layout` 签名加 `window: tauri::Window`
  - `relayout(app: &tauri::AppHandle, win_label: &str) -> tauri::Result<()>`(参数化窗口标签)
  - `static DIVIDER_RATIOS: Mutex<HashMap<String, f64>>`(键 = 窗口标签)
  - selftest 注入标记新增值 `'multiwindow'`(Task 4 用)
  - Rust 侧注入内容视图的 `__DC_VIEW__` 值改为完整标签(如 `w1-left`)

**关键设计决定(实现时不要偏离):**

- Tauri 2 命令的 `window: tauri::Window` 参数自动注入**发起 invoke 的窗口**——这是多窗口各管各的基石,不需要手传标签。
- 完整标签逃生门只在 `dc_eval`/`dc_navigate`:`target` 以 `w` + 数字 + `-` 开头(用 `target.starts_with('w') && target.contains('-')` 简判,再由 `get_webview` 找不到时报错兜底)时直接 `get_webview(target)`,否则 `get_webview(&format!("{}-{target}", window.label()))`。controller 正常路径传 `left`/`right`,不会命中逃生门(`left` 无 `-`)。
- `dc-report` 路由:载荷 `view` 字段是完整标签(reporter 上报 `__DC_VIEW__`)。剥 `w{n}-` 前缀得 controller 标签:`view.rsplit_once('-')` 取前半 `w{n}` → `emit_to(format!("{w}-controller"), …)`。剥不出(格式不对)→ `eprintln!` warn 丢弃。
- `layout_selftest` 全部标签换 `w1`/`w1-left`/`w1-right`(setup 里首窗序号固定为 1:`next_window_id()` 首次调用返回 1)。
- `dc_selftest_done` 不加 window 参数(退出整个进程,与哪侧调用无关)。

- [ ] **Step 1: 改写 main.rs(整文件重构,一次到位)**

用下面完整内容替换 `apps/tauri/src-tauri/src/main.rs`(相对旧版的变化点在注释里标了「多窗口」):

```rust
// Docs Compare —— Tauri 实现入口。
// 职责刻意保持"哑中继":N 个窗口,每窗一个 controller + left/right 两个内容 webview、
// 事件转发、dc_eval / dc_navigate / dc_layout / dc_new_window / dc_set_title 等命令。
// 同步状态机全部在各窗口的 controller(frontend/controller.ts,复用 @docs-compare/core)。
//
// 多窗口:窗口标签 w{N}(N 只增不复用),子 webview w{N}-controller / w{N}-left / w{N}-right。
// 命令一律带 window: tauri::Window 参数(Tauri 自动注入发起窗口),target 语义名
// (left/right)由本文件拼完整标签;target 形如 w2-left 视为完整标签直达(selftest 用)。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::HashMap,
    sync::atomic::{AtomicU64, Ordering},
    Mutex,
};

use tauri::{
    Emitter, Listener, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewBuilder,
    WindowBuilder,
};

/// 每窗分隔条比例(0~1),键 = 窗口标签:窗口 resize 时按比例重排而不是钉死像素,
/// 多窗口各拖各的互不覆盖(多窗口:替换单例 DIVIDER_RATIO)
static DIVIDER_RATIOS: Mutex<HashMap<String, f64>> = Mutex::new(HashMap::new());

/// 下一个窗口序号:只增不复用,窗口关闭不回收,避免新窗撞上残留标签
static NEXT_WINDOW: AtomicU64 = AtomicU64::new(1);

/// 注入 left/right 的上报脚本(esbuild 产物,build.mjs 先于 cargo 生成)
const REPORTER: &str = include_str!("../../frontend-dist/reporter.js");

const TOOLBAR: f64 = 44.0;
const GAP: f64 = 8.0;

fn next_window_id() -> u64 {
    NEXT_WINDOW.fetch_add(1, Ordering::Relaxed)
}

fn main() {
    let live = std::env::args().any(|a| a == "--selftest=live");
    let multiwindow = std::env::args().any(|a| a == "--selftest=multiwindow");
    let layout_test = std::env::args().any(|a| a == "--selftest=layout");
    let selftest = std::env::args().any(|a| a == "--selftest" || a.starts_with("--selftest="));
    let selftest_flag = if live {
        "window.__DC_SELFTEST__ = 'live';"
    } else if multiwindow {
        "window.__DC_SELFTEST__ = 'multiwindow';"
    } else if layout_test {
        "" // 布局自测纯 Rust 侧驱动,无需 controller 标记
    } else if selftest {
        "window.__DC_SELFTEST__ = true;"
    } else {
        ""
    };

    tauri::Builder::default()
        .setup(move |app| {
            // 多窗口:首窗与其他窗同一函数创建(selftest 标记只注入首窗)
            spawn_window(app, next_window_id(), selftest_flag)?;

            // 中继:内容视图上报 → 同窗口的 controller。
            // 转发必须换事件名(dc-signal):同名会再次触发本监听器,同步递归直到栈溢出。
            // 必须在创建内容 webview 之前注册:blank.html 加载极快,reporter 的
            // cs:hello 若在监听就绪前发出会被静默丢弃(selftest 的就绪等待将超时)
            // (多窗口:emit_to 按上报载荷里的完整 view 标签定向到同窗口 controller)
            let handle = app.handle().clone();
            app.listen("dc-report", move |e| {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(e.payload()) else {
                    return;
                };
                if std::env::var_os("DC_DEBUG").is_some() {
                    eprintln!("[dc] report: {}", e.payload());
                }
                // view 形如 w2-left;剥出 w2 定向到 w2-controller。剥不出 = 不可路由,丢弃
                let view = v.get("view").and_then(|s| s.as_str()).unwrap_or("");
                match view.rsplit_once('-') {
                    Some((win, _)) => {
                        let _ = handle.emit_to(format!("{win}-controller"), "dc-signal", v);
                    }
                    None => eprintln!("[dc] 不可路由的上报(view={view:?}),已丢弃"),
                }
            });

            // 布局自测:程序化改变窗口尺寸,断言三个视图的几何
            if layout_test {
                let handle = app.handle().clone();
                std::thread::spawn(move || layout_selftest(handle));
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // 窗口尺寸变化由 Rust 重排(controller 是固定尺寸子视图,自身收不到)
            // (多窗口:重排发起事件的那个窗口,不再写死 main)
            if let tauri::WindowEvent::Resized(_) = event {
                let _ = relayout(&window.app_handle(), window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            dc_ready,
            dc_eval,
            dc_navigate,
            dc_layout,
            dc_new_window,
            dc_set_title,
            dc_window_title,
            dc_selftest_done
        ])
        .run(tauri::generate_context!())
        .expect("error while running docs-compare");
}

/// 建一个对照窗口:窗口 w{n} + controller/left/right 三个子 webview,返回窗口。
/// 首窗与新窗口按钮共用;selftest_flag 仅首窗非空。
/// (多窗口:从 setup 内联逻辑提取参数化;标签全部带 w{n}- 前缀)
fn spawn_window(
    app: &tauri::AppHandle,
    n: u64,
    selftest_flag: &str,
) -> tauri::Result<tauri::Window> {
    let win_label = format!("w{n}");
    let window = WindowBuilder::new(app, &win_label)
        .title("Docs Compare")
        .inner_size(1280.0, 860.0)
        .build()?;

    // inner_size 是物理像素,必须除以 scale factor 得逻辑像素,
    // 否则 Retina 下所有 webview 尺寸翻倍(工具条被裁、视口过高)
    let sf = window.scale_factor().unwrap_or(1.0);
    let (w, h) = window
        .inner_size()
        .map(|s| (s.width as f64 / sf, s.height as f64 / sf))
        .unwrap_or((1280.0, 860.0));
    if std::env::var_os("DC_DEBUG").is_some() {
        eprintln!("[dc] {win_label} 初始几何: sf={sf} logical={w}x{h}");
    }

    // controller:宿主 UI(工具条+分隔条),铺满窗口,后创建的内容视图盖在上面
    window.add_child(
        WebviewBuilder::new(
            format!("{win_label}-controller"),
            WebviewUrl::App("index.html".into()),
        )
        .initialization_script(selftest_flag),
        LogicalPosition::new(0.0, 0.0),
        LogicalSize::new(w, h),
    )?;

    // 左右内容视图:初始加载本地占位页(about:blank 在 macOS 多 webview 下
    // 不会提交导航,后续 eval 会全部失效),内容由 controller 导航。
    // (多窗口:__DC_VIEW__ 注入完整标签 w{n}-left/right,上报据此路由回本窗口)
    for side in ["left", "right"] {
        let label = format!("{win_label}-{side}");
        let init = format!("window.__DC_VIEW__ = {label:?};\n{REPORTER}");
        window.add_child(
            WebviewBuilder::new(label, WebviewUrl::App("blank.html".into()))
                .initialization_script(init)
                .on_page_load(|wv, payload| {
                    if std::env::var_os("DC_DEBUG").is_some() {
                        eprintln!("[dc] load: {} {}", wv.label(), payload.url());
                    }
                }),
            LogicalPosition::new(0.0, TOOLBAR),
            LogicalSize::new(w / 2.0 - GAP / 2.0, (h - TOOLBAR).max(120.0)),
        )?;
    }
    Ok(window)
}

/// target 解析:语义名(left/right)拼本窗口前缀;完整标签(w2-left)直达。
/// 逃生门仅 selftest 跨窗口操作使用,普通路径 target 无 '-'。
fn resolve_view<'a>(window_label: &str, target: &'a str) -> String {
    if target.starts_with('w') && target.contains('-') {
        target.to_string()
    } else {
        format!("{window_label}-{target}")
    }
}

/// 发起窗口内两个内容视图是否都已创建(selftest 据此决定何时可以开始导航,
/// 消除 "no webview: left/right" 启动竞态;多窗口只查本窗)
#[tauri::command]
fn dc_ready(app: tauri::AppHandle, window: tauri::Window) -> bool {
    let l = window.label();
    app.get_webview(&format!("{l}-left")).is_some() && app.get_webview(&format!("{l}-right")).is_some()
}

/// 在指定视图执行 JS(任意 origin;init script 保证 __dcApply/__dcTest 存在)
/// (多窗口:target 语义名拼发起窗口前缀;完整标签直达见 resolve_view)
#[tauri::command]
fn dc_eval(app: tauri::AppHandle, window: tauri::Window, target: String, js: String) -> Result<(), String> {
    if std::env::var_os("DC_DEBUG").is_some() {
        eprintln!("[dc] eval → {target}: {}", js.chars().take(120).collect::<String>());
    }
    let full = resolve_view(window.label(), &target);
    let wv = app.get_webview(&full).ok_or_else(|| format!("no webview: {full}"))?;
    let r = wv.eval(&js).map_err(|e| e.to_string());
    if let Err(e) = &r {
        eprintln!("[dc] eval FAILED → {full}: {e}");
    }
    r
}

/// 导航指定视图(比 JS location.href 可靠,尤其自定义 scheme)
#[tauri::command]
fn dc_navigate(app: tauri::AppHandle, window: tauri::Window, target: String, url: String) -> Result<(), String> {
    let full = resolve_view(window.label(), &target);
    let wv = app.get_webview(&full).ok_or_else(|| format!("no webview: {full}"))?;
    let parsed = url.parse().map_err(|e| format!("bad url {url}: {e}"))?;
    wv.navigate(parsed).map_err(|e| e.to_string())
}

/// macOS 上子 webview 的 (0,0) 被标题栏遮住约 28px(outer_size 在 wry 里
/// 不含标题栏,只能按平台补偿);Windows/Linux 子视图坐标相对客户区,为 0。
fn titlebar_h() -> f64 {
    if cfg!(target_os = "macos") {
        28.0
    } else {
        0.0
    }
}

/// 内容区几何(逻辑像素):宽、高
fn content_metrics(window: &tauri::Window) -> (f64, f64) {
    let sf = window.scale_factor().unwrap_or(1.0) as f64;
    let inner = window.inner_size().unwrap_or_default();
    (inner.width as f64 / sf, inner.height as f64 / sf)
}

/// (多窗口:按窗口标签取本窗比例,缺省 0.5)
fn divider_of(win_label: &str) -> f64 {
    DIVIDER_RATIOS
        .lock()
        .unwrap()
        .get(win_label)
        .copied()
        .unwrap_or(0.5)
}

/// (多窗口:relayout 参数化窗口标签;controller/left/right 标签全部带前缀)
fn relayout(app: &tauri::AppHandle, win_label: &str) -> tauri::Result<()> {
    let win = app
        .get_window(win_label)
        .ok_or_else(|| tauri::Error::WindowNotFound)?;
    let (iw, ih) = content_metrics(&win);
    let divider = divider_of(win_label).clamp(0.05, 0.95) * iw;
    let (toolbar, gap, tb) = (TOOLBAR, GAP, titlebar_h());

    // controller 铺满窗口(顶部落入标题栏下方),可见高度正好等于内容区高;
    // 每次设置相同尺寸不会再触发 resize 事件,无反馈环
    if let Some(c) = app.get_webview(&format!("{win_label}-controller")) {
        c.set_position(LogicalPosition::new(0.0, 0.0))?;
        c.set_size(LogicalSize::new(iw, ih + tb))?;
    }

    let y0 = tb + toolbar;
    let h = (ih - toolbar).max(120.0);
    let left_w = (divider - gap / 2.0).clamp(120.0, (iw - gap - 120.0).max(120.0));
    let right_x = divider + gap / 2.0;
    let right_w = (iw - right_x).clamp(120.0, iw);

    if let Some(left) = app.get_webview(&format!("{win_label}-left")) {
        left.set_position(LogicalPosition::new(0.0, y0))?;
        left.set_size(LogicalSize::new(left_w, h))?;
    }
    if let Some(right) = app.get_webview(&format!("{win_label}-right")) {
        right.set_position(LogicalPosition::new(right_x, y0))?;
        right.set_size(LogicalSize::new(right_w, h))?;
    }
    if std::env::var_os("DC_DEBUG").is_some() {
        eprintln!("[dc] layout[{win_label}]: divider={divider:.0} 内容区 {iw:.0}x{ih:.0} titlebar={tb}");
    }
    Ok(())
}

#[tauri::command]
fn dc_layout(app: tauri::AppHandle, window: tauri::Window, divider: f64, width: f64, height: f64) -> Result<(), String> {
    let _ = (width, height); // 尺寸一律以 Rust 侧实时 inner_size 为准
    let iw = app
        .get_window(window.label())
        .and_then(|w| w.inner_size().ok())
        .map(|s| s.width as f64 / w_scale(&app))
        .unwrap_or(1280.0);
    DIVIDER_RATIOS
        .lock()
        .unwrap()
        .insert(window.label().to_string(), (divider / iw).clamp(0.05, 0.95));
    relayout(&app, window.label()).map_err(|e| e.to_string())
}

fn w_scale(app: &tauri::AppHandle) -> f64 {
    // 比例只用于除宽度,scale 取任一窗口皆可;取发起窗口找不到时退 1.0
    app.get_window("w1")
        .and_then(|w| w.scale_factor().ok())
        .unwrap_or(1.0)
}

/// 开新窗口(多窗口):分配下一个序号,干净初始态(blank.html 两视图 + 独立 controller)。
/// 返回新窗口标签(如 "w2"),selftest 与 UI 都可用它做后续断言/提示。
#[tauri::command]
fn dc_new_window(app: tauri::AppHandle) -> Result<String, String> {
    let n = next_window_id();
    spawn_window(&app, n, "")
        .map(|w| w.label().to_string())
        .map_err(|e| format!("spawn_window: {e}"))
}

/// 设置发起窗口的标题(多窗口标题跟随):controller 收到左侧导航信号后调用,
/// title 为空时前端已回退 "Docs Compare",后端只透传。
#[tauri::command]
fn dc_set_title(window: tauri::Window, title: String) -> Result<(), String> {
    window.set_title(&title).map_err(|e| e.to_string())
}

/// 查询任意窗口当前标题(selftest 专用断言通道)
#[tauri::command]
fn dc_window_title(app: tauri::AppHandle, label: String) -> Result<String, String> {
    let win = app.get_window(&label).ok_or_else(|| format!("no window: {label}"))?;
    win.title().map_err(|e| e.to_string())
}

/// selftest 结束:打印结果并以 0/1 退出
#[tauri::command]
fn dc_selftest_done(app: tauri::AppHandle, results: String) {
    println!("{results}");
    let failed = results.contains("\"pass\": false");
    app.exit(if failed { 1 } else { 0 });
}

/// 布局自测:窗口改到多组尺寸,验证左右视图完整落在可见区域内
/// (右缘贴内容区右缘、底缘贴底,滚动条可见),并打印几何。
/// (多窗口:全程操作首窗 w1,标签字面量统一带前缀)
fn layout_selftest(app: tauri::AppHandle) {
    use std::time::Duration;

    const W1: &str = "w1";
    const W1L: &str = "w1-left";
    const W1R: &str = "w1-right";

    fn view_rect(app: &tauri::AppHandle, label: &str) -> (f64, f64, f64, f64) {
        let sf = app.get_window(W1).and_then(|w| w.scale_factor().ok()).unwrap_or(1.0);
        let wv = app.get_webview(label).unwrap();
        let p = wv.position().unwrap_or_default();
        let s = wv.size().unwrap_or_default();
        (p.x as f64 / sf, p.y as f64 / sf, s.width as f64 / sf, s.height as f64 / sf)
    }

    // 等 controller 首次 dc_layout 生效:right 已从初始位 (0,44) 挪到
    // left 右缘之后。固定 sleep 在慢启动时会截在布局前(存量竞态):
    // webview 渲染器未就绪时 set_position/set_size 会被静默丢弃,同尺寸
    // set_size 又不触发 Resized 事件,所以轮询里直接重跑 relayout 直到生效
    let wait_deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let (_, _, lw, _) = view_rect(&app, W1L);
        let (rx, _, _, _) = view_rect(&app, W1R);
        if rx >= lw && rx > 0.0 {
            break;
        }
        if std::time::Instant::now() > wait_deadline {
            eprintln!("[layout] 等待首次布局超时,继续执行");
            break;
        }
        let _ = relayout(&app, W1);
        std::thread::sleep(Duration::from_millis(100));
    }
    let targets: [(f64, f64, &str); 5] = [
        (1280.0, 860.0, "初始"),
        (1000.0, 700.0, "缩小"),
        (1600.0, 950.0, "放大"),
        (900.0, 620.0, "再缩小"),
        (1280.0, 860.0, "还原"),
    ];
    let mut results: Vec<(String, bool, String)> = vec![];
    let (tb, toolbar) = (titlebar_h(), TOOLBAR);

    for (w, h, name) in targets {
        if let Some(win) = app.get_window(W1) {
            let _ = win.set_size(tauri::LogicalSize::new(w, h));
        }
        std::thread::sleep(Duration::from_millis(900));
        let win = app.get_window(W1).unwrap();
        let sf = win.scale_factor().unwrap_or(1.0);
        let inner = win.inner_size().unwrap_or_default();
        let (iw, ih) = (inner.width as f64 / sf, inner.height as f64 / sf);
        let (lx, ly, lw, lh) = view_rect(&app, W1L);
        let (rx, ry, rw, rh) = view_rect(&app, W1R);
        let (mut errs, mut geo) = (vec![], format!(
            "内容区{iw:.0}x{ih:.0} left({lx:.0},{ly:.0} {lw:.0}x{lh:.0}) right({rx:.0},{ry:.0} {rw:.0}x{rh:.0})"
        ));
        let close = |a: f64, b: f64| (a - b).abs() < 4.0;
        if !close(ly, tb + toolbar) { errs.push(format!("left.y={ly:.0} 期望 {}", tb + toolbar)); }
        if !close(ry, ly) { errs.push(format!("right.y={ry:.0} ≠ left.y={ly:.0}")); }
        if !close(lx, 0.0) { errs.push(format!("left.x={lx:.0} ≠ 0")); }
        if !close(rx, lx + lw + GAP) { errs.push(format!("right.x={rx:.0} ≠ left右缘+{GAP}")); }
        if !close(lh, ih - toolbar) { errs.push(format!("left.h={lh:.0} ≠ 内容高-{toolbar}={}", ih - toolbar)); }
        if !close(rh, lh) { errs.push(format!("right.h={rh:.0} ≠ left.h")); }
        // 用户要求:滚动条完整可见 → 右缘贴内容区右缘、底缘不越界
        if !close(rx + rw, iw) { errs.push(format!("right右缘={} ≠ 内容宽{iw:.0}(滚动条被裁)", rx + rw)); }
        if ry + rh > tb + ih + 4.0 { errs.push(format!("right底缘越界")); }
        // 用户要求:窗口尺寸变化后左右平分宽度(未拖动分隔条时)
        if !close(lw, rw) { errs.push(format!("左右不等宽 {lw:.0} vs {rw:.0}")); }
        let pass = errs.is_empty();
        if !pass { geo.push_str(" ‹"); geo.push_str(&errs.join("; ")); geo.push('›'); }
        println!("[layout] {name}: {} {}", if pass { "ok" } else { "FAIL" }, geo);
        results.push((format!("{name} {w:.0}x{h:.0}"), pass, errs.join("; ")));
    }

    // 最大化/还原
    for maximize in [true, false] {
        if let Some(win) = app.get_window(W1) {
            let _ = if maximize { win.maximize() } else { win.unmaximize() };
        }
        std::thread::sleep(Duration::from_millis(1000));
        let win = app.get_window(W1).unwrap();
        let sf = win.scale_factor().unwrap_or(1.0);
        let inner = win.inner_size().unwrap_or_default();
        let (iw, ih) = (inner.width as f64 / sf, inner.height as f64 / sf);
        let (lx, ly, lw, lh) = view_rect(&app, W1L);
        let (rx, ry, rw, rh) = view_rect(&app, W1R);
        let mut errs = vec![];
        let close = |a: f64, b: f64| (a - b).abs() < 4.0;
        if !close(lh, ih - toolbar) { errs.push(format!("left.h={lh:.0} ≠ {}", ih - toolbar)); }
        if !close(rx + rw, iw) { errs.push(format!("right右缘={} ≠ {iw:.0}", rx + rw)); }
        if !close(ry, tb + toolbar) { errs.push(format!("right.y={ry:.0}")); }
        let pass = errs.is_empty();
        println!(
            "[layout] {}: {} 内容区{iw:.0}x{ih:.0} left({lx:.0},{ly:.0} {lw:.0}x{lh:.0}) right({rx:.0},{ry:.0} {rw:.0}x{rh:.0}){}",
            if maximize { "最大化" } else { "还原" },
            if pass { "ok" } else { "FAIL" },
            if pass { String::new() } else { format!(" ‹{}›", errs.join("; ")) }
        );
        results.push((if maximize { "最大化".into() } else { "还原2".into() }, pass, errs.join("; ")));
    }

    // 连续快速改尺寸(模拟拖拽边缘的事件风暴),最后一次停下后必须收敛
    if let Some(win) = app.get_window(W1) {
        for i in 0..12 {
            let w = 1100.0 + (i as f64) * 45.0;
            let _ = win.set_size(tauri::LogicalSize::new(w, 760.0 + (i as f64) * 12.0));
            std::thread::sleep(Duration::from_millis(60));
        }
    }
    std::thread::sleep(Duration::from_millis(900));
    {
        let win = app.get_window(W1).unwrap();
        let sf = win.scale_factor().unwrap_or(1.0);
        let inner = win.inner_size().unwrap_or_default();
        let (iw, ih) = (inner.width as f64 / sf, inner.height as f64 / sf);
        let (lx, ly, lw, lh) = view_rect(&app, W1L);
        let (rx, ry, rw, rh) = view_rect(&app, W1R);
        let close = |a: f64, b: f64| (a - b).abs() < 4.0;
        let pass = close(lh, ih - toolbar) && close(rx + rw, iw) && close(ry, tb + toolbar);
        println!(
            "[layout] 快速连续resize: {} 内容区{iw:.0}x{ih:.0} left({lx:.0},{ly:.0} {lw:.0}x{lh:.0}) right({rx:.0},{ry:.0} {rw:.0}x{rh:.0})"
            , if pass { "ok" } else { "FAIL" }
        );
        results.push(("快速连续resize".into(), pass, String::new()));
    }

    let pass = results.iter().filter(|r| r.1).count();
    println!(
        "[layout] 通过 {}/{}",
        pass,
        results.len()
    );
    app.exit(if pass == results.len() { 0 } else { 1 });
}
```

与旧版的差异清单(自查):
- `DIVIDER_RATIO` → `DIVIDER_RATIOS: HashMap` + `divider_of()`;`dc_layout` 改 `insert`。
- `NEXT_WINDOW: AtomicU64` + `next_window_id()`。
- setup 建窗逻辑提取为 `spawn_window(app, n, selftest_flag)`;首窗 `next_window_id()` 返回 1。
- `dc-report` 转发按 `view.rsplit_once('-')` 定向 `{win}-controller`。
- `resolve_view()` 逃生门;`dc_eval`/`dc_navigate`/`dc_ready`/`dc_layout` 加 `window: tauri::Window`。
- 新命令 `dc_new_window`/`dc_set_title`/`dc_window_title`,注册进 `invoke_handler`。
- `relayout(app, win_label)` 参数化;`on_window_event` 用 `window.label()`。
- `--selftest=multiwindow` 参数分支 → 注入 `'multiwindow'` 标记。
- `layout_selftest` 标签常量 `W1`/`W1L`/`W1R`。
- `w_scale` 不再依赖特定窗口语义,取 `w1`(仅 `dc_layout` 除宽度用;窗口全 1.0 scale 时无差异,多显示器下以 w1 为基准——与旧行为一致,旧代码也是取 main 一家)。
- 删除 `spawn_window` 前 setup 里对 `window` 变量的后续使用(setup 不再直接持有窗口;布局自测入口不变)。

- [ ] **Step 2: capabilities 改通配**

`apps/tauri/src-tauri/capabilities/default.json` 的 `windows` 字段:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "dc-default",
  "description": "controller 全量本地 IPC;left/right 内容视图仅事件发射;远程 https 页面也允许上报(语义见 docs/SPEC.md)。多窗口:标签 w{N} 系列,用 glob w* 覆盖",
  "local": true,
  "remote": {
    "urls": ["https://**", "http://**"]
  },
  "windows": ["w*"],
  "permissions": ["core:event:default"]
}
```

- [ ] **Step 3: cargo check 编译验证**

Run: `cd apps/tauri/src-tauri && cargo check 2>&1 | tail -5`
Expected: `Finished` 无 error(warning 可接受,如未用变量;若有 error 按提示修——常见:`Emitter`/`Listener` trait 已 import、`HashMap` import 补齐)。

- [ ] **Step 4: 回归 fixture + layout 自测**

先构建前端再跑(Rust 改动不依赖前端,但 selftest 会加载 controller.js):

Run: `cd C:/Users/lif3n/src/docs-compare && npm run build:tauri && npm run selftest && npm run selftest:layout`
Expected: 两条命令 exit 0;fixture 自测打印 5 项全 pass;layout 打印 `通过 N/N`。

注意:此时 reporter 上报的 `view` 已是 `w1-left` 完整标签(Rust 注入变了),而 controller.ts 还按 `p.view === 'left'` 过滤——**fixture 自测此时会失败(信号全部被丢弃)**。这是预期中间态;若想绿了再 commit,可先只跑 `npm run selftest:layout`(纯 Rust,不依赖 controller 信号),commit 后立即进 Task 2 Step 1 补 controller 过滤逻辑再跑 fixture。选择:本任务只验证 layout 自测绿 + cargo check 绿即 commit,fixture 回归推迟到 Task 2 完成后(下一任务的 Step 会跑)。**修正:上面"Step 4 跑 fixture"作废,只跑 `npm run selftest:layout`。**

- [ ] **Step 5: Commit**

```bash
git add apps/tauri/src-tauri/src/main.rs apps/tauri/src-tauri/capabilities/default.json
git commit -m "重构:窗口隔离标签 w{N} 系列,命令绑定发起窗口(多窗口地基)"
```

---

### Task 2: 标题跟随(reporter 带 title + controller 设置)

**Files:**
- Modify: `apps/tauri/inject/reporter.ts`
- Modify: `apps/tauri/frontend/controller.ts`

**Interfaces:**
- Consumes: Task 1 的 `dc_set_title(window, title)` 命令;reporter 现有 `report()` 与 `cs:nav`/`cs:hello` 上报点。
- Produces: 上报载荷新增字段 `title: string`(cs:hello/cs:nav,Task 4 断言依赖);controller 内部 `applyWindowTitle(view: 'left'|'right', title?: string): void`(模块内私有)。

- [ ] **Step 1: controller.ts — 信号过滤适配完整标签 + 标题跟随**

`main()` 里 `listen('dc-signal', …)` 回调整体替换(96 行 `viewUrls` 上报的 `cs:hello` 分支、573-575 行过滤逻辑)。改动点:

a. 模块顶部 import 区加:

```ts
import { getCurrentWindow } from '@tauri-apps/api/window';
```

b. 模块级状态区(`const EMPTY_PAGE_INDEX` 附近)加:

```ts
// ---------- 多窗口:本窗口标识 ----------
// controller 自身标签形如 w{n}-controller;剥 -controller 得窗口标签 w{n}。
// 非 Tauri 环境直接浏览器开 index.html 时回退 w1(行为同首窗)。
const WINDOW_LABEL = (() => {
  try {
    return getCurrentWindow().label.replace(/-controller$/, '');
  } catch {
    return 'w1';
  }
})();
/** 上报载荷 view(完整标签 w{n}-left)剥出 [本窗前缀, 视图名];非本窗/不合法返回 null */
function parseView(view: string | undefined): 'left' | 'right' | null {
  const m = /^w\d+-(left|right)$/.exec(view ?? '');
  return m ? (m[1] as 'left' | 'right') : null;
}
```

c. 标题跟随函数(放在 `// ---------- 信号接入` 区块之前):

```ts
/** 窗口标题跟随左侧(原站)文档;空标题回退应用名。同标题去重,避免每信号都 invoke */
let lastTitle = 'Docs Compare';
function applyWindowTitle(view: 'left' | 'right', title?: string): void {
  if (view !== 'left' || !title) return;
  const next = title.trim() || 'Docs Compare';
  if (next === lastTitle) return;
  lastTitle = next;
  void invoke('dc_set_title', { title: next }).catch(() => {});
}
```

d. `listen('dc-signal')` 回调里,`if (p.view !== 'left' && p.view !== 'right') return;` 替换为:

```ts
    const view = parseView(p.view);
    if (!view) return; // 非本窗格式信号(路由已定向,双保险)与 test:info 之外的消息
```

并把后续 `p.view` 引用改为 `view`:

```ts
    if (p.t === 'cs:hello') {
      viewUrls[view] = p.href ?? viewUrls[view];
      applyWindowTitle(view, p.title);
    } else if (p.t === 'cs:nav') {
      applyWindowTitle(view, p.title);
      void syncFrom(view, p.href!);
    } else if (p.t === 'cs:scroll') void onScroll(view, p.topId ?? null, p.frac ?? 0, p.ratio ?? 0);
```

载荷类型加 `title?: string`(payload 类型字面量里补一行)。

- [ ] **Step 2: reporter.ts — cs:hello / cs:nav 载荷带 title**

两处 `report({...})` 调用改:

```ts
  report({ t: 'cs:hello', href: location.href, title: document.title ?? '' });
```

`cs:nav` 有两个上报点:链接点击 capture 监听器里(93 行)与 hashchange(100 行)、pushState/replaceState 的 `emit`(104 行)。**只给「整页导航」语义的链接点击与 hashchange 带 title 不够——SPA pushState 后 title 可能由框架随后更新,此时 title 尚是旧页的。简化统一:三处都带 `title: document.title ?? ''`,title 何时准确交给信号时序,不额外加 MutationObserver(spec YAGNI 已定)。**

```ts
        report({ t: 'cs:nav', href, title: document.title ?? '' });      // 链接点击
```

```ts
    report({ t: 'cs:nav', href: location.href, title: document.title ?? '' });  // hashchange
```

```ts
    const emit = (): void => report({ t: 'cs:nav', href: location.href, title: document.title ?? '' });  // pushState/replaceState
```

- [ ] **Step 3: typecheck + build + fixture 自测回归**

Run: `cd C:/Users/lif3n/src/docs-compare && npm run typecheck && npm run build:tauri && npm run selftest`
Expected: typecheck 0 错;selftest exit 0、5 项 pass(Task 1 遗留的信号过滤中间态在此修复)。

- [ ] **Step 4: 手测标题跟随(可选但推荐)**

Run: `cd apps/tauri/src-tauri && cargo run`
窗口弹出后:选「Orca 文档」→ 窗口 title 变为 onorca.dev 首页英文标题;左侧点任意链接 → title 跟随变化。关掉窗口结束。

- [ ] **Step 5: Commit**

```bash
git add apps/tauri/inject/reporter.ts apps/tauri/frontend/controller.ts
git commit -m "功能:窗口标题跟随左侧(原站)文档标题,导航即更新"
```

---

### Task 3: 「新窗口」按钮 + dc_new_window 接线

**Files:**
- Modify: `apps/tauri/frontend/index.html`
- Modify: `apps/tauri/frontend/controller.ts`

**Interfaces:**
- Consumes: Task 1 的 `dc_new_window() -> Result<String, String>`。
- Produces: 工具条 `#new-window` 按钮(DOM id,无代码消费者);wireUi 里 click 处理(模块私有)。

- [ ] **Step 1: index.html 加按钮**

`#open-pair` 之后、`#status` 之前插入:

```html
  <button id="new-window" title="打开一个新的对照窗口">新窗口</button>
```

改后工具条:

```html
<div id="toolbar">
  <span class="brand">Docs Compare</span>
  <select id="site-select" aria-label="站点对"><option value="" disabled selected>选择文档站点…</option></select>
  <input id="url-left" placeholder="原站 URL,粘贴后回车" spellcheck="false">
  <button id="open-pair">对照打开</button>
  <button id="new-window" title="打开一个新的对照窗口">新窗口</button>
  <span id="status"></span>
</div>
```

样式:现有 `button {}` 规则(36-43 行)自动覆盖,零 CSS 改动。视觉区分:`#new-window` 用次要色更好看,但 YAGNI——先复用,不够再调。**给一点区分度**(同一蓝两按钮挤在一起易误点),`style.css` 末尾追加:

```css
#new-window { background: #fff; color: #1a73e8; border: 1px solid #1a73e8; }
#new-window:hover { background: #eef4fe; }
```

- [ ] **Step 2: controller.ts — wireUi 挂 click**

`wireUi()` 里 `#open-pair` 绑定之后加:

```ts
  // 新窗口:干净初始态(blank 两视图),本窗口状态不受影响
  document.getElementById('new-window')?.addEventListener('click', () => {
    invoke('dc_new_window')
      .then((label) => show(`已开新窗口 ${label}`))
      .catch((e: unknown) => show(`开窗失败:${String(e)}`));
  });
```

(`show` 是 wireUi 里已有的状态栏函数,394 行附近定义——直接用。)

- [ ] **Step 3: typecheck + build + 手测**

Run: `cd C:/Users/lif3n/src/docs-compare && npm run typecheck && npm run build:tauri && cd apps/tauri/src-tauri && cargo run`
手测:点「新窗口」→ 第二窗口弹出(干净初始态、下拉占位项);两窗口各自选站打开文档,互不影响;标题各自跟随;各拖分隔条互不覆盖。关掉全部窗口结束。

- [ ] **Step 4: Commit**

```bash
git add apps/tauri/frontend/index.html apps/tauri/frontend/style.css apps/tauri/frontend/controller.ts
git commit -m "功能:工具条「新窗口」按钮,一键开独立对照窗口"
```

---

### Task 4: multiwindow selftest

**Files:**
- Modify: `apps/tauri/frontend/controller.ts`
- Modify: `apps/tauri/package.json`
- Modify: `package.json`(根)

**Interfaces:**
- Consumes: Task 1 `dc_new_window`/`dc_window_title`/`dc_eval`/`dc_navigate` 完整标签逃生门(`w2-left` 直达)、`__DC_SELFTEST__ = 'multiwindow'` 注入、现有 `selftest()` 骨架(`t`/`waitFor`/`query`/`navigateTo`)。
- Produces: npm scripts `selftest:multiwindow`(根与 apps/tauri 两级同名);controller 内部 `multiwindowSelftest(): Promise<void>`。

- [ ] **Step 1: controller.ts — multiwindow 场景**

a. `main()` 里 selftest 分发改为三态(现有 `if (mode) await selftest(mode);` 替换):

```ts
  if (mode === 'multiwindow') await multiwindowSelftest();
  else if (mode) await selftest(mode);
```

看门狗 `bail`/`window error` 捕获对 multiwindow 同样生效(mode 为任意真值即挂,现有代码不用改)。

b. 新函数(放在 `selftest()` 之后):

```ts
/** 多窗口自测:开第二窗口 → 独立导航 → 断言隔离与标题跟随(fixture 离线站) */
async function multiwindowSelftest(): Promise<void> {
  const results: TestResult[] = [];
  const t = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      results.push({ name, pass: true, detail: '' });
    } catch (e) {
      results.push({ name, pass: false, detail: String(e) });
    }
  };

  const EN = `${location.origin}/fixtures/en`;
  const ZH = `${location.origin}/fixtures/zh`;
  sites = [
    { id: 'fixture', origin: EN, mirror: ZH, anchorMapUrl: `${ZH}/anchor-map.json` },
  ];

  // 窗口 1:与 fixture 自测相同初始导航
  await waitFor(async () => Boolean(await invoke('dc_ready')), 10000, '窗口1 left/right 就绪');
  await navigateTo('left', `${EN}/index.html`);
  await navigateTo('right', `${ZH}/index.html`);
  await waitFor(
    async () => String(await query('left', 'location.href', 800).catch(() => '')).includes('/fixtures/en/index.html'),
    8000,
    '窗口1 left 加载',
  );
  await waitFor(
    async () => String(await query('right', 'location.href', 800).catch(() => '')).includes('/fixtures/zh/index.html'),
    8000,
    '窗口1 right 加载',
  );

  let w2 = '';
  await t('开第二窗口', async () => {
    w2 = String(await invoke('dc_new_window'));
    assert(/^w\d+$/.test(w2), `新窗口标签格式异常:${w2}`);
    // 窗口 2 内容视图就绪(其 controller 同样在跑,但我们直接经逃生门驱动它的视图)
    await waitFor(
      async () => {
        try {
          const h1 = String(await invoke('dc_eval', { target: `${w2}-left`, js: 'location.href' }));
          return !h1.includes('error');
        } catch {
          return false;
        }
      },
      10000,
      `窗口2 ${w2}-left 可用`,
    );
  });

  await t('窗口2 独立导航 page2', async () => {
    await invoke('dc_navigate', { target: `${w2}-left`, url: `${EN}/page2.html` });
    await invoke('dc_navigate', { target: `${w2}-right`, url: `${ZH}/page2.html` });
    await waitFor(
      async () => String(await query(`${w2}-left`, 'location.href', 800).catch(() => '')).includes('/fixtures/en/page2.html'),
      8000,
      `窗口2 ${w2}-left 到 page2`,
    );
    await waitFor(
      async () => String(await query(`${w2}-right`, 'location.href', 800).catch(() => '')).includes('/fixtures/zh/page2.html'),
      8000,
      `窗口2 ${w2}-right 到 page2`,
    );
  });

  await t('两窗口互不干扰', async () => {
    const l1 = String(await query('left', 'location.href', 2000));
    assert(l1.includes('/fixtures/en/index.html'), `窗口1 left 被带偏:${l1}`);
    const r1 = String(await query('right', 'location.href', 2000));
    assert(r1.includes('/fixtures/zh/index.html'), `窗口1 right 被带偏:${r1}`);
  });

  await t('窗口1 内导航不影响窗口2', async () => {
    // 窗口1 左侧跳 page2;窗口2 两视图 URL 必须纹丝不动
    await evalIn('left', `document.querySelector("a[href='page2.html']").click()`);
    await waitFor(
      async () => String(await query('right', 'location.href', 800).catch(() => '')).includes('/fixtures/zh/page2.html'),
      8000,
      '窗口1 right 跟随到 page2',
    );
    const w2l = String(await query(`${w2}-left`, 'location.href', 2000));
    assert(w2l.includes('/fixtures/en/page2.html'), `窗口2 left 异常(应为 page2):${w2l}`);
  });

  await t('标题各随各窗口', async () => {
    await wait(1200); // 等 cs:nav → dc_set_title 传播
    const t1 = String(await invoke('dc_window_title', { label: 'w1' }));
    const t2 = String(await invoke('dc_window_title', { label: w2 }));
    assert(t1 === 'Fixture EN — Page 2', `窗口1 标题=${t1},期望 Fixture EN — Page 2`);
    assert(t2 === 'Fixture EN — Page 2', `窗口2 标题=${t2},期望 Fixture EN — Page 2`);
  });

  const pass = results.filter((r) => r.pass).length;
  await invoke('dc_selftest_done', {
    results: JSON.stringify({ pass, total: results.length, results }, null, 2),
  });
}
```

注:窗口 2 的 controller 也在运行(加载 sites.json、wireUi),不参与本场景断言——它的存在本身不影响逃生门操作。窗口 2 blank.html 初始 title 是「待命」,导航 page2 后其 controller 收到 `w2-left` 的 cs:nav(title=Fixture EN — Page 2)→ 标题更新;断言经 `dc_window_title` 读 Rust 侧真实值。

c. `query()` 已支持任意 target 字符串(190 行 `evalIn(view, …)` 直接透传),无需改;`evalIn`/`navigateTo` 里 `viewUrls[view]` 只对 `left`/`right` 语义名有副作用,逃生门 target(`w2-left`)经 `invoke('dc_eval', { target … })` 手写调用,不走 `navigateTo`(避免 viewUrls 污染)——上面代码已如此(直接 `invoke('dc_navigate', …)`)。

- [ ] **Step 2: npm scripts**

`apps/tauri/package.json` scripts 加(10-12 行区域):

```json
    "selftest:multiwindow": "npm run build && cd src-tauri && cargo run -- --selftest=multiwindow",
```

根 `package.json` scripts 加(17 行 `selftest:layout` 之后):

```json
    "selftest:multiwindow": "npm run selftest:multiwindow --workspace @docs-compare/tauri",
```

- [ ] **Step 3: 跑自测**

Run: `cd C:/Users/lif3n/src/docs-compare && npm run selftest:multiwindow`
Expected: exit 0,JSON 输出 5 项 pass。失败时看 stdout JSON 的 detail 字段。

- [ ] **Step 4: 全量回归**

Run: `cd C:/Users/lif3n/src/docs-compare && npm run typecheck && npm test && npm run selftest && npm run selftest:layout && npm run selftest:multiwindow`
Expected: 全部 exit 0。(core 冒烟确认没被波及;live 自测依赖外网,不强制。)

- [ ] **Step 5: Commit**

```bash
git add apps/tauri/frontend/controller.ts apps/tauri/package.json package.json
git commit -m "测试:multiwindow 自测——开窗/独立导航/互不干扰/标题跟随"
```

---

### Task 5: 文档同步(README + 两个 skill)

**Files:**
- Modify: `README.md`(Tauri 版小节)
- Modify: `.claude/skills/tauri/SKILL.md`
- Modify: `.claude/skills/run-tests/SKILL.md`

- [ ] **Step 1: README Tauri 小节**

`## Tauri 版` 的功能列表(「站点配置」行之前)加两行:

```markdown
- 工具条「新窗口」按钮:一键再开一个对照窗口,各窗口独立选站/导航/分隔条,互不干扰
- 窗口标题跟随左侧(原站)文档标题,切页即变(未打开文档时为「Docs Compare」)
```

自测命令块(53-57 行)加一行:

```bash
npm run selftest:multiwindow  # 多窗口:开窗/独立导航/互不干扰/标题跟随
```

- [ ] **Step 2: .claude/skills/tauri/SKILL.md 自测清单**

自测一节(26-29 行命令块)加一行:

```bash
npm run selftest:multiwindow # 多窗口:开窗/独立导航/互不干扰/标题跟随
```

- [ ] **Step 3: .claude/skills/run-tests/SKILL.md 矩阵表**

端到端自测层表格(28-33 行)加一行:

```markdown
| `npm run selftest:multiwindow` | Tauri 多窗口:开窗/隔离/标题跟随 | cargo |
```

- [ ] **Step 4: Commit**

```bash
git add README.md .claude/skills/tauri/SKILL.md .claude/skills/run-tests/SKILL.md
git commit -m "文档:README 与 skill 同步多窗口/标题跟随/新自测"
```

---

## 计划自审记录

1. **Spec 覆盖**:窗口隔离标签(Task 1)、spawn_window/dc_new_window(Task 1)、dc_set_title + controller 跟随 + reporter title(Task 2)、按钮(Task 3)、multiwindow selftest(Task 4)、capabilities w*(Task 1)、layout_selftest 标签(Task 1)、文档(Task 5)——spec 各节均有任务。spec「窗口关闭残留条目不清理」无需代码(HashMap 留着即行为)。
2. **占位符**:无 TBD/TODO;Task 1 Step 4 有自我修正说明(fixture 中间态推迟到 Task 2),非占位。
3. **类型一致**:`dc_new_window -> Result<String,String>`、`dc_window_title(app,label) -> Result<String,String>`、`resolve_view`、`spawn_window(app,n,flag)` 在 Task 1 定义、Task 4 使用一致;controller `parseView`/`applyWindowTitle` 命名前后一致;`query(target)` 直接透传字符串与逃生门兼容。
