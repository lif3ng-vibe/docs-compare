import UIKit
import WebKit

/// controller 主页加载完成的回调(用于首推安全区)
final class ControllerNavDelegate: NSObject, WKNavigationDelegate {
    var onFinish: (() -> Void)?

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        onFinish?()
    }
}

/// 三视图容器(controller 工具条页 + left/right 文档页),Tauri 版
/// spawn_window/relayout 的平移。布局走纯 frame(viewDidLayoutSubviews +
/// 安全区变化触发),不用 autolayout——与 Rust 侧 Resize→relayout 同构。
final class CompareViewController: UIViewController {
    let bridge = Bridge()
    private let reportRelay = ReportRelay()

    private(set) var controllerWebView: WKWebView!
    private(set) var leftWebView: WKWebView!
    private(set) var rightWebView: WKWebView!

    /// 标题跟随:left 的 title KVO → scene.title(SceneDelegate 注入)
    var onTitle: ((String) -> Void)?
    private var titleObservation: NSKeyValueObservation?

    /// controller 页安全区推送:env() 与 UIKit 安全区在 Catalyst 窗口模式
    /// 不一致(WebKit 报 0,UIKit 报标题栏 41),以原生值为准推送
    private var controllerNavDelegate = ControllerNavDelegate()
    private var lastPushedInsets: UIEdgeInsets?

    /// 三视图共享进程池(cookie/会话一致)
    static let processPool = WKProcessPool()

    override var prefersStatusBarHidden: Bool { false }

    // MARK: - 生命周期

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        bridge.owner = self
        reportRelay.owner = self

        let reporterJS = Self.loadResource("reporter.js")

        controllerWebView = makeWebView(config: makeControllerConfig())
        controllerWebView.scrollView.bounces = false
        controllerWebView.scrollView.alwaysBounceVertical = false
        // 工具条页是应用 UI:禁缩放(双击/捏合),内容文档页保留缩放便于阅读
        controllerWebView.scrollView.minimumZoomScale = 1
        controllerWebView.scrollView.maximumZoomScale = 1
        controllerWebView.navigationDelegate = controllerNavDelegate
        controllerNavDelegate.onFinish = { [weak self] in
            self?.pushInsetsToController()
        }

        leftWebView = makeWebView(config: makeContentConfig(view: "w1-left", reporterJS: reporterJS))
        rightWebView = makeWebView(config: makeContentConfig(view: "w1-right", reporterJS: reporterJS))
        for wv in [leftWebView!, rightWebView!] {
            wv.allowsBackForwardNavigationGestures = true
        }

        // 层序:controller 在底(工具条+分隔条),内容页盖上
        view.addSubview(controllerWebView)
        view.addSubview(leftWebView)
        view.addSubview(rightWebView)

        // 标题跟随:原生 KVO,比 JS 信号(cs:nav 在导航前、cs:hello 时机漂)可靠
        titleObservation = leftWebView.observe(\.title, options: [.new]) { [weak self] _, change in
            guard let t = change.newValue ?? nil, !t.isEmpty else { return }
            DispatchQueue.main.async {
                self?.bridge.recordTitle(t)
                self?.onTitle?(t)
            }
        }

        // 初始导航:controller 主页 + 两侧待命页(about:blank 在 WKWebView
        // 上不提交导航,与 Tauri/macOS wry 同坑,用 blank.html)
        controllerWebView.load(URLRequest(url: Self.bundleURL("controller.html")))
        leftWebView.load(URLRequest(url: Self.bundleURL("blank.html")))
        rightWebView.load(URLRequest(url: Self.bundleURL("blank.html")))
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        relayout()
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        relayout()
    }

    // MARK: - 布局

    /// 生效模式:用户请求优先;iPhone 竖屏强制单文档(对照需横屏)。
    /// selftest 强制对照:同步语义测试要两侧都可见(隐藏 webview 的渲染
    /// 节流会干扰滚动同步用例),与桌面 Tauri 自测同语义。
    private func effectiveModeForCurrentTraits() -> LayoutMode {
        if SelftestController.mode == .fixture || SelftestController.mode == .live {
            return .split
        }
        guard bridge.modeRequested == .split else { return .single }
        let isPhone = traitCollection.userInterfaceIdiom == .phone
        let isPortrait = view.bounds.height > view.bounds.width
        return (isPhone && isPortrait) ? .single : .split
    }

    /// 把原生安全区推给 controller 页(CSS 变量 --dc-sa-*);
    /// 页面未加载完成时 eval 被 __dcDispatch 守卫静默跳过,靠重试点补推
    func pushInsetsToController() {
        let insets = view.safeAreaInsets
        if let last = lastPushedInsets,
           abs(last.top - insets.top) < 0.5,
           abs(last.left - insets.left) < 0.5,
           abs(last.bottom - insets.bottom) < 0.5,
           abs(last.right - insets.right) < 0.5 {
            return
        }
        lastPushedInsets = insets
        if DC_DEBUG {
            NSLog("[dc] push insets t:%.0f l:%.0f b:%.0f r:%.0f", insets.top, insets.left, insets.bottom, insets.right)
        }
        dispatchToController([
            "t": "dc:insets",
            "top": insets.top,
            "left": insets.left,
            "bottom": insets.bottom,
            "right": insets.right,
        ])
    }

    func relayout() {
        guard isViewLoaded, view.bounds.width > 1, view.bounds.height > 1 else { return }
        if DC_DEBUG {
            NSLog("[dc] relayout bounds=%@ insets=t:%.0f l:%.0f b:%.0f r:%.0f mode=%@",
                  String(describing: view.bounds), view.safeAreaInsets.top,
                  view.safeAreaInsets.left, view.safeAreaInsets.bottom, view.safeAreaInsets.right,
                  effectiveModeForCurrentTraits().rawValue)
        }
        let mode = effectiveModeForCurrentTraits()
        bridge.applyEffective(mode, side: bridge.sideRequested)

        let frames = LayoutMath.computeFrames(
            bounds: view.bounds,
            insets: view.safeAreaInsets,
            ratio: bridge.dividerRatio,
            mode: mode,
            visibleSide: bridge.sideRequested
        )
        // 安全区变化(全屏切换/旋转/Stage Manager)时同步给 controller 页
        pushInsetsToController()
        if controllerWebView.frame != view.bounds {
            controllerWebView.frame = view.bounds
        }
        if leftWebView.frame != frames.left || leftWebView.isHidden != frames.leftHidden {
            leftWebView.frame = frames.left
            leftWebView.isHidden = frames.leftHidden
        }
        if rightWebView.frame != frames.right || rightWebView.isHidden != frames.rightHidden {
            rightWebView.frame = frames.right
            rightWebView.isHidden = frames.rightHidden
        }
    }

    // MARK: - 命令实现(Bridge 回调)

    /// 语义目标 left/right 或完整标签 w1-left/w1-right(selftest 直达)
    private func resolveView(_ semantic: String) -> WKWebView? {
        switch semantic {
        case "left", "w1-left": return leftWebView
        case "right", "w1-right": return rightWebView
        default: return nil
        }
    }

    func evalInView(
        semantic: String,
        js: String,
        completion: @escaping (Error?) -> Void
    ) {
        guard let wv = resolveView(semantic) else {
            completion(NSError(domain: "dc", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "no webview: \(semantic)",
            ]))
            return
        }
        wv.evaluateJavaScript(js) { _, error in completion(error) }
    }

    func navigateView(semantic: String, url: URL) -> String? {
        guard let wv = resolveView(semantic) else {
            return "no webview: \(semantic)"
        }
        wv.load(URLRequest(url: url))
        return nil
    }

    // MARK: - 下行推送

    /// 把对象推给 controller 的 window.__dcDispatch。
    /// JSON 序列化结果本身是合法 JS 字面量,只需再处理 U+2028/2029。
    func dispatchToController(_ obj: [String: Any]) {
        guard
            let data = try? JSONSerialization.data(withJSONObject: obj),
            var json = String(data: data, encoding: .utf8)
        else { return }
        json = json
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
        controllerWebView.evaluateJavaScript(
            "window.__dcDispatch && __dcDispatch(\(json))"
        )
    }

    // MARK: - webview 构造

    private func makeWebView(config: WKWebViewConfiguration) -> WKWebView {
        let wv = WKWebView(frame: .zero, configuration: config)
        wv.translatesAutoresizingMaskIntoConstraints = true
        return wv
    }

    private func makeControllerConfig() -> WKWebViewConfiguration {
        let config = WKWebViewConfiguration()
        config.processPool = Self.processPool
        config.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: "dcapp")
        let ucc = WKUserContentController()
        ucc.add(bridge, name: "dcInvoke")
        // selftest 模式注入标记(值与 Tauri 版协议一致:true / "live")。
        // 必须 documentStart:controller.js 在 body 末尾就跑 main() 读标记
        switch SelftestController.mode {
        case .fixture:
            ucc.addUserScript(WKUserScript(
                source: "window.__DC_SELFTEST__ = true;",
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            ))
        case .live:
            ucc.addUserScript(WKUserScript(
                source: "window.__DC_SELFTEST__ = 'live';",
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            ))
        default:
            break
        }
        config.userContentController = ucc
        return config
    }

    private func makeContentConfig(view: String, reporterJS: String) -> WKWebViewConfiguration {
        let config = WKWebViewConfiguration()
        config.processPool = Self.processPool
        config.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: "dcapp")
        let ucc = WKUserContentController()
        ucc.add(reportRelay, name: "dcReport")
        ucc.addUserScript(WKUserScript(
            source: "window.__DC_VIEW__ = '\(view)';\n\(reporterJS)",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        config.userContentController = ucc
        return config
    }

    // MARK: - 资源

    static func bundleURL(_ path: String) -> URL {
        URL(string: "dcapp://bundle/\(path)")!
    }

    private static func loadResource(_ name: String) -> String {
        let ns = name as NSString
        guard
            let url = Bundle.main.url(
                forResource: ns.deletingPathExtension,
                withExtension: ns.pathExtension,
                subdirectory: "web"
            ),
            let s = try? String(contentsOf: url, encoding: .utf8)
        else {
            NSLog("[dc] 资源缺失:%@(先 npm run build 生成 web/)", name)
            return ""
        }
        return s
    }
}
