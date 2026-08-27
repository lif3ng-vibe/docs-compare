import Foundation
import WebKit

/// controller 页的上行通道(dcInvoke)与命令分发(Tauri 版 main.rs 的平移)。
/// 约定:所有跨通道消息都是 JSON 字符串,回包走
/// window.__dcDispatch({t:'cmd:result', reqId, ok, value|error})。
final class Bridge: NSObject, WKScriptMessageHandler {
    weak var owner: CompareViewController?

    /// 分隔条比例(0..1,内容区内),controller 拖拽时经 dc_layout 更新
    private(set) var dividerRatio: Double = 0.5
    /// 用户请求的模式/单文档侧(controller 持久化后转发)
    private(set) var modeRequested: LayoutMode = .split
    private(set) var sideRequested: SingleSide = .mirror
    /// 生效模式(竖屏 iPhone 会被裁成 single)
    private(set) var effectiveMode: LayoutMode = .split
    private var pushedMode: LayoutMode?
    private var pushedSide: SingleSide?

    /// 标题跟随的最后值(dc_window_title 用;主路径是 left webview 的 title KVO)
    private(set) var lastTitle: String = "Docs Compare"

    /// 内容缩放级(0.5~3.0),dc_zoom 步进/复位
    private var zoom: CGFloat = 1.0

    // MARK: - WKScriptMessageHandler(controller 页 dcInvoke)

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard
            let body = message.body as? String,
            let data = body.data(using: .utf8),
            let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
            let cmd = obj["cmd"] as? String,
            let reqId = obj["reqId"] as? Int
        else {
            NSLog("[dc] dcInvoke 消息格式异常:%@", String(describing: message.body))
            return
        }
        let args = obj["args"] as? [String: Any] ?? [:]
        handle(cmd: cmd, reqId: reqId, args: args)
    }

    private func handle(cmd: String, reqId: Int, args: [String: Any]) {
        if DC_DEBUG { NSLog("[dc] cmd=%@ reqId=%d", cmd, reqId) }
        switch cmd {
        case "dc_ready":
            reply(reqId: reqId, value: true)

        case "dc_eval":
            let target = args["target"] as? String ?? "left"
            let js = args["js"] as? String ?? ""
            if DC_DEBUG && js.contains("__dcApply") {
                NSLog("[dc] apply → %@ : %@", target, String(js.prefix(160)))
            }
            owner?.evalInView(semantic: target, js: js) { [weak self] error in
                if let error {
                    self?.replyError(reqId: reqId, error: error.localizedDescription)
                } else {
                    self?.reply(reqId: reqId, value: nil)
                }
            }

        case "dc_navigate":
            let target = args["target"] as? String ?? "left"
            guard
                let urlStr = args["url"] as? String,
                let url = URL(string: urlStr)
            else {
                replyError(reqId: reqId, error: "dc_navigate: 无效 URL")
                return
            }
            if let err = owner?.navigateView(semantic: target, url: url) {
                replyError(reqId: reqId, error: err)
            } else {
                reply(reqId: reqId, value: nil)
            }

        case "dc_layout":
            if let d = args["divider"] as? Double, let w = args["width"] as? Double, w > 0 {
                dividerRatio = LayoutMath.clampRatio(d / w)
            }
            owner?.relayout()
            reply(reqId: reqId, value: nil)

        case "dc_zoom":
            let dir = args["dir"] as? Int ?? 0
            let z = applyZoom(dir: dir)
            reply(reqId: reqId, value: z)

        case "dc_set_title":
            if let t = args["title"] as? String, !t.isEmpty {
                lastTitle = t
                owner?.onTitle?(t)
            }
            reply(reqId: reqId, value: nil)

        case "dc_window_title":
            reply(reqId: reqId, value: lastTitle)

        case "dc_set_mode":
            if let m = args["mode"] as? String, let mode = LayoutMode(rawValue: m) {
                modeRequested = mode
            }
            if let s = args["side"] as? String, let side = SingleSide(rawValue: s) {
                sideRequested = side
            }
            owner?.relayout() // 重算生效模式并按需推 dc:mode
            reply(reqId: reqId, value: ["mode": effectiveMode.rawValue, "side": sideRequested.rawValue])

        case "dc_new_window":
            replyError(reqId: reqId, error: "iOS 暂不支持多窗口")

        case "dc_selftest_done":
            // 结果落 stdout、按 pass==total 定退出码,不回包(进程即将退出)
            SelftestController.finish(resultsJSON: args["results"] as? String ?? "{}")

        default:
            replyError(reqId: reqId, error: "未知命令 \(cmd)")
        }
    }

    /// 键盘缩放(Ctrl/Cmd + −/=/0):± 步进 ×1.15,0 复位,钳制 0.5~3.0;
    /// 左右内容视图同步 setPageZoom(对照阅读两侧必须同倍率)
    private func applyZoom(dir: Int) -> Double {
        zoom = dir == 0 ? 1.0 : min(max(zoom * (dir > 0 ? 1.15 : 1 / 1.15), 0.5), 3.0)
        zoom = (zoom * 100).rounded() / 100
        owner?.setContentZoom(zoom)
        if DC_DEBUG { NSLog("[dc] zoom → %.2f", zoom) }
        return Double(zoom)
    }

    // MARK: - 状态回填

    /// relayout 后由 owner 调用:更新生效模式,变化则推 dc:mode 给 controller
    func applyEffective(_ mode: LayoutMode, side: SingleSide) {
        effectiveMode = mode
        if pushedMode != mode || pushedSide != side {
            pushedMode = mode
            pushedSide = side
            owner?.dispatchToController([
                "t": "dc:mode",
                "mode": mode.rawValue,
                "side": side.rawValue,
            ])
        }
    }

    func recordTitle(_ t: String) {
        lastTitle = t
    }

    // MARK: - 回包

    private func reply(reqId: Int, value: Any?) {
        var obj: [String: Any] = ["t": "cmd:result", "reqId": reqId, "ok": true]
        if let value { obj["value"] = value }
        owner?.dispatchToController(obj)
    }

    private func replyError(reqId: Int, error: String) {
        owner?.dispatchToController([
            "t": "cmd:result",
            "reqId": reqId,
            "ok": false,
            "error": error,
        ])
    }
}

/// reporter 上行通道:左右内容页的 dcReport 消息 → 转发 controller。
/// 消息体里的 view 字段(w1-left/right)即路由依据,单一实例可挂两侧。
final class ReportRelay: NSObject, WKScriptMessageHandler {
    weak var owner: CompareViewController?

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard
            let body = message.body as? String,
            let data = body.data(using: .utf8),
            let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else {
            NSLog("[dc] dcReport 消息格式异常:%@", String(describing: message.body))
            return
        }
        owner?.dispatchToController(["t": "signal", "payload": payload])
    }
}
