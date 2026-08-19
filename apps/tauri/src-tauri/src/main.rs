// Docs Compare —— Tauri 实现入口。
// 职责刻意保持"哑中继":一个窗口 + 三个子 webview(controller/left/right)、
// 事件转发、dc_eval / dc_layout / dc_selftest_done 三个命令。
// 同步状态机全部在 controller(frontend/controller.ts,复用 @docs-compare/core)。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    Emitter, Listener, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewBuilder,
    WindowBuilder,
};

/// 注入 left/right 的上报脚本(esbuild 产物,build.mjs 先于 cargo 生成)
const REPORTER: &str = include_str!("../../frontend-dist/reporter.js");

const TOOLBAR: f64 = 44.0;
const GAP: f64 = 8.0;

fn main() {
    let live = std::env::args().any(|a| a == "--selftest=live");
    let selftest = std::env::args().any(|a| a == "--selftest" || a.starts_with("--selftest="));
    let selftest_flag = if live {
        "window.__DC_SELFTEST__ = 'live';"
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
            Ok(())
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
#[tauri::command]
fn dc_layout(app: tauri::AppHandle, divider: f64, width: f64, height: f64) -> Result<(), String> {
    let (toolbar, gap) = (TOOLBAR, GAP);
    // controller 全幅(初始尺寸可能因创建时序不准,这里一并以 CSS 逻辑像素校正)
    if let Some(c) = app.get_webview("controller") {
        let _ = c.set_position(LogicalPosition::new(0.0, 0.0));
        let _ = c.set_size(LogicalSize::new(width, height));
    }
    let h = (height - toolbar).max(120.0);
    let left_w = (divider - gap / 2.0).clamp(120.0, (width - gap - 120.0).max(120.0));
    let right_x = divider + gap / 2.0;
    let right_w = (width - right_x).clamp(120.0, width);

    let left = app.get_webview("left").ok_or("no left")?;
    left.set_position(LogicalPosition::new(0.0, toolbar))
        .map_err(|e| e.to_string())?;
    left.set_size(LogicalSize::new(left_w, h))
        .map_err(|e| e.to_string())?;

    let right = app.get_webview("right").ok_or("no right")?;
    right
        .set_position(LogicalPosition::new(right_x, toolbar))
        .map_err(|e| e.to_string())?;
    right.set_size(LogicalSize::new(right_w, h))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// selftest 结束:打印结果并以 0/1 退出
#[tauri::command]
fn dc_selftest_done(app: tauri::AppHandle, results: String) {
    println!("{results}");
    let failed = results.contains("\"pass\": false");
    app.exit(if failed { 1 } else { 0 });
}
