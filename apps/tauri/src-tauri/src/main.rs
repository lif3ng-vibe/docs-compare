// Docs Compare —— Tauri 实现入口。
// 职责刻意保持"哑中继":一个窗口 + 三个子 webview(controller/left/right)、
// 事件转发、dc_eval / dc_layout / dc_selftest_done 三个命令。
// 同步状态机全部在 controller(frontend/controller.ts,复用 @docs-compare/core)。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use tauri::{
    Emitter, Listener, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewBuilder,
    WindowBuilder,
};

/// 分隔条比例(0~1):窗口 resize 时按比例重排,而不是钉死绝对像素
static DIVIDER_RATIO: Mutex<f64> = Mutex::new(0.5);

/// 注入 left/right 的上报脚本(esbuild 产物,build.mjs 先于 cargo 生成)
const REPORTER: &str = include_str!("../../frontend-dist/reporter.js");

const TOOLBAR: f64 = 44.0;
const GAP: f64 = 8.0;

fn main() {
    let live = std::env::args().any(|a| a == "--selftest=live");
    let layout_test = std::env::args().any(|a| a == "--selftest=layout");
    let selftest = std::env::args().any(|a| a == "--selftest" || a.starts_with("--selftest="));
    let selftest_flag = if live {
        "window.__DC_SELFTEST__ = 'live';"
    } else if layout_test {
        "" // 布局自测纯 Rust 侧驱动,无需 controller 标记
    } else if selftest {
        "window.__DC_SELFTEST__ = true;"
    } else {
        ""
    };

    tauri::Builder::default()
        .setup(move |app| {
            let window = WindowBuilder::new(app, "main")
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
                eprintln!("[dc] 初始几何: sf={sf} logical={w}x{h}");
            }

            // controller:宿主 UI(工具条+分隔条),铺满窗口,后创建的内容视图盖在上面
            window.add_child(
                WebviewBuilder::new("controller", WebviewUrl::App("index.html".into()))
                    .initialization_script(selftest_flag),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(w, h),
            )?;

            // 左右内容视图:初始加载本地占位页(about:blank 在 macOS 多 webview 下
            // 不会提交导航,后续 eval 会全部失效),内容由 controller 导航
            for label in ["left", "right"] {
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

            // 中继:内容视图上报 → controller。
            // 转发必须换事件名(dc-signal):同名会再次触发本监听器,同步递归直到栈溢出
            let handle = app.handle().clone();
            app.listen("dc-report", move |e| {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(e.payload()) else {
                    return;
                };
                if std::env::var_os("DC_DEBUG").is_some() {
                    eprintln!("[dc] report: {}", e.payload());
                }
                let _ = handle.emit_to("controller", "dc-signal", v);
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
            if let tauri::WindowEvent::Resized(_) = event {
                let _ = relayout(&window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![dc_eval, dc_navigate, dc_layout, dc_selftest_done])
        .run(tauri::generate_context!())
        .expect("error while running docs-compare");
}

/// 在指定视图执行 JS(任意 origin;init script 保证 __dcApply/__dcTest 存在)
#[tauri::command]
fn dc_eval(app: tauri::AppHandle, target: String, js: String) -> Result<(), String> {
    if std::env::var_os("DC_DEBUG").is_some() {
        eprintln!("[dc] eval → {target}: {}", js.chars().take(120).collect::<String>());
    }
    let wv = app
        .get_webview(&target)
        .ok_or_else(|| format!("no webview: {target}"))?;
    wv.eval(&js).map_err(|e| e.to_string())
}

/// 导航指定视图(比 JS location.href 可靠,尤其自定义 scheme)
#[tauri::command]
fn dc_navigate(app: tauri::AppHandle, target: String, url: String) -> Result<(), String> {
    let wv = app
        .get_webview(&target)
        .ok_or_else(|| format!("no webview: {target}"))?;
    let parsed = url.parse().map_err(|e| format!("bad url {url}: {e}"))?;
    wv.navigate(parsed).map_err(|e| e.to_string())
}

/// 按分隔条位置排布左右视图(controller 传入自身 CSS 逻辑像素)
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

fn relayout(app: &tauri::AppHandle) -> tauri::Result<()> {
    let win = app
        .get_window("main")
        .ok_or_else(|| tauri::Error::WindowNotFound)?;
    let (iw, ih) = content_metrics(&win);
    let divider = DIVIDER_RATIO.lock().unwrap().clamp(0.05, 0.95) * iw;
    let (toolbar, gap, tb) = (TOOLBAR, GAP, titlebar_h());

    // controller 铺满窗口(顶部落入标题栏下方),可见高度正好等于内容区高;
    // 每次设置相同尺寸不会再触发 resize 事件,无反馈环
    if let Some(c) = app.get_webview("controller") {
        c.set_position(LogicalPosition::new(0.0, 0.0))?;
        c.set_size(LogicalSize::new(iw, ih + tb))?;
    }

    let y0 = tb + toolbar;
    let h = (ih - toolbar).max(120.0);
    let left_w = (divider - gap / 2.0).clamp(120.0, (iw - gap - 120.0).max(120.0));
    let right_x = divider + gap / 2.0;
    let right_w = (iw - right_x).clamp(120.0, iw);

    if let Some(left) = app.get_webview("left") {
        left.set_position(LogicalPosition::new(0.0, y0))?;
        left.set_size(LogicalSize::new(left_w, h))?;
    }
    if let Some(right) = app.get_webview("right") {
        right.set_position(LogicalPosition::new(right_x, y0))?;
        right.set_size(LogicalSize::new(right_w, h))?;
    }
    if std::env::var_os("DC_DEBUG").is_some() {
        eprintln!("[dc] layout: divider={divider:.0} 内容区 {iw:.0}x{ih:.0} titlebar={tb}");
    }
    Ok(())
}

#[tauri::command]
fn dc_layout(app: tauri::AppHandle, divider: f64, width: f64, height: f64) -> Result<(), String> {
    let _ = (width, height); // 尺寸一律以 Rust 侧实时 inner_size 为准
    let iw = app
        .get_window("main")
        .and_then(|w| w.inner_size().ok())
        .map(|s| s.width as f64 / w_scale(&app))
        .unwrap_or(1280.0);
    *DIVIDER_RATIO.lock().unwrap() = (divider / iw).clamp(0.05, 0.95);
    relayout(&app).map_err(|e| e.to_string())
}

fn w_scale(app: &tauri::AppHandle) -> f64 {
    app.get_window("main").and_then(|w| w.scale_factor().ok()).unwrap_or(1.0)
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
fn layout_selftest(app: tauri::AppHandle) {
    use std::time::Duration;

    fn view_rect(app: &tauri::AppHandle, label: &str) -> (f64, f64, f64, f64) {
        let sf = app.get_window("main").and_then(|w| w.scale_factor().ok()).unwrap_or(1.0);
        let wv = app.get_webview(label).unwrap();
        let p = wv.position().unwrap_or_default();
        let s = wv.size().unwrap_or_default();
        (p.x as f64 / sf, p.y as f64 / sf, s.width as f64 / sf, s.height as f64 / sf)
    }

    std::thread::sleep(Duration::from_millis(1500)); // 等 controller 首次 layout
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
        if let Some(win) = app.get_window("main") {
            let _ = win.set_size(tauri::LogicalSize::new(w, h));
        }
        std::thread::sleep(Duration::from_millis(900));
        let win = app.get_window("main").unwrap();
        let sf = win.scale_factor().unwrap_or(1.0);
        let inner = win.inner_size().unwrap_or_default();
        let (iw, ih) = (inner.width as f64 / sf, inner.height as f64 / sf);
        let (lx, ly, lw, lh) = view_rect(&app, "left");
        let (rx, ry, rw, rh) = view_rect(&app, "right");
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
        if let Some(win) = app.get_window("main") {
            let _ = if maximize { win.maximize() } else { win.unmaximize() };
        }
        std::thread::sleep(Duration::from_millis(1000));
        let win = app.get_window("main").unwrap();
        let sf = win.scale_factor().unwrap_or(1.0);
        let inner = win.inner_size().unwrap_or_default();
        let (iw, ih) = (inner.width as f64 / sf, inner.height as f64 / sf);
        let (lx, ly, lw, lh) = view_rect(&app, "left");
        let (rx, ry, rw, rh) = view_rect(&app, "right");
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
    if let Some(win) = app.get_window("main") {
        for i in 0..12 {
            let w = 1100.0 + (i as f64) * 45.0;
            let _ = win.set_size(tauri::LogicalSize::new(w, 760.0 + (i as f64) * 12.0));
            std::thread::sleep(Duration::from_millis(60));
        }
    }
    std::thread::sleep(Duration::from_millis(900));
    {
        let win = app.get_window("main").unwrap();
        let sf = win.scale_factor().unwrap_or(1.0);
        let inner = win.inner_size().unwrap_or_default();
        let (iw, ih) = (inner.width as f64 / sf, inner.height as f64 / sf);
        let (lx, ly, lw, lh) = view_rect(&app, "left");
        let (rx, ry, rw, rh) = view_rect(&app, "right");
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
