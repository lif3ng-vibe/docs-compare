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
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};

use tauri::{
    Emitter, Listener, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewBuilder,
    WindowBuilder,
};

/// 每窗分隔条比例(0~1),键 = 窗口标签:窗口 resize 时按比例重排而不是钉死像素,
/// 多窗口各拖各的互不覆盖(多窗口:替换单例 DIVIDER_RATIO;HashMap 非 const,用 LazyLock)
static DIVIDER_RATIOS: std::sync::LazyLock<Mutex<HashMap<String, f64>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

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
            let handle = app.handle().clone();
            spawn_window(&handle, next_window_id(), selftest_flag)?;

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
        let mut builder = WebviewBuilder::new(label, WebviewUrl::App("blank.html".into()))
            .initialization_script(init)
            .on_page_load(|wv, payload| {
                if std::env::var_os("DC_DEBUG").is_some() {
                    eprintln!("[dc] load: {} {}", wv.label(), payload.url());
                }
            });
        // 标题跟随:left(原站)文档标题 → 本窗口标题。原生事件,整页导航/SPA/
        // 动态 title 全覆盖——JS 层信号(cs:nav 在导航前发、title 是旧页的;
        // cs:hello 在 WebView2 首载不可靠)都拿不到导航后的准确时机。
        if side == "left" {
            let app2 = app.clone();
            let wl = win_label.clone();
            builder = builder.on_document_title_changed(move |_wv, title| {
                if let Some(win) = app2.get_window(&wl) {
                    let t = if title.is_empty() { "Docs Compare".to_string() } else { title };
                    let _ = win.set_title(&t);
                }
            });
        }
        window.add_child(
            builder,
            LogicalPosition::new(0.0, TOOLBAR),
            LogicalSize::new(w / 2.0 - GAP / 2.0, (h - TOOLBAR).max(120.0)),
        )?;
    }
    Ok(window)
}

/// target 解析:语义名(left/right)拼本窗口前缀;完整标签(w2-left)直达。
/// 逃生门仅 selftest 跨窗口操作使用,普通路径 target 无 '-'。
fn resolve_view(window_label: &str, target: &str) -> String {
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
fn dc_eval(
    app: tauri::AppHandle,
    window: tauri::Window,
    target: String,
    js: String,
) -> Result<(), String> {
    if std::env::var_os("DC_DEBUG").is_some() {
        eprintln!("[dc] eval → {target}: {}", js.chars().take(120).collect::<String>());
    }
    let full = resolve_view(window.label(), &target);
    let wv = app
        .get_webview(&full)
        .ok_or_else(|| format!("no webview: {full}"))?;
    let r = wv.eval(&js).map_err(|e| e.to_string());
    if let Err(e) = &r {
        eprintln!("[dc] eval FAILED → {full}: {e}");
    }
    r
}

/// 导航指定视图(比 JS location.href 可靠,尤其自定义 scheme)
#[tauri::command]
fn dc_navigate(
    app: tauri::AppHandle,
    window: tauri::Window,
    target: String,
    url: String,
) -> Result<(), String> {
    let full = resolve_view(window.label(), &target);
    let wv = app
        .get_webview(&full)
        .ok_or_else(|| format!("no webview: {full}"))?;
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

/// 按分隔条位置排布左右视图(参数化窗口标签:多窗口各排各的)
/// controller 铺满窗口(顶部落入标题栏下方),可见高度正好等于内容区高;
/// 每次设置相同尺寸不会再触发 resize 事件,无反馈环
fn relayout(app: &tauri::AppHandle, win_label: &str) -> tauri::Result<()> {
    let win = app
        .get_window(win_label)
        .ok_or_else(|| tauri::Error::WindowNotFound)?;
    let (iw, ih) = content_metrics(&win);
    let divider = divider_of(win_label).clamp(0.05, 0.95) * iw;
    let (toolbar, gap, tb) = (TOOLBAR, GAP, titlebar_h());

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
        eprintln!(
            "[dc] layout[{win_label}]: divider={divider:.0} 内容区 {iw:.0}x{ih:.0} titlebar={tb}"
        );
    }
    Ok(())
}

/// 按分隔条位置排布发起窗口的视图(controller 传入自身 CSS 逻辑像素)
#[tauri::command]
fn dc_layout(
    app: tauri::AppHandle,
    window: tauri::Window,
    divider: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
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
    // 比例只用于除宽度;取首窗 scale 为基准(与旧版取 main 一家的行为一致)
    app.get_window("w1")
        .and_then(|w| w.scale_factor().ok())
        .unwrap_or(1.0)
}

/// 开新窗口(多窗口):分配下一个序号,干净初始态(blank.html 两视图 + 独立 controller)。
/// 返回新窗口标签(如 "w2"),selftest 与 UI 状态栏提示都用它。
///
/// 必须 async:Tauri 2 在 Windows 上,同步命令/事件回调里建 webview 会死锁
/// (add_child 内部 run_on_main_thread + channel 同步等待,而同步命令本身
/// 占着主线程,自己等自己;官方文档 "Known issues" 明示要 async 命令建窗)。
/// async 命令跑在线程池,主线程空闲,channel 才能回包。
#[tauri::command]
async fn dc_new_window(app: tauri::AppHandle) -> Result<String, String> {
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
    let win = app
        .get_window(&label)
        .ok_or_else(|| format!("no window: {label}"))?;
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
