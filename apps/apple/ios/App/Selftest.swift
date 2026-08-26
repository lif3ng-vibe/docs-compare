import Foundation
import UIKit

/// 调试日志开关:模拟器经 SIMCTL_CHILD_DC_DEBUG=1 xcrun simctl launch …,
/// 真机/Catalyst 在 scheme 环境变量里设 DC_DEBUG
let DC_DEBUG = getenv("DC_DEBUG") != nil

/// selftest 模式解析与出口(启动参数 --selftest[=live|layout],与 Tauri 版
/// CLI 约定一致;模拟器经 `simctl launch booted <bundle-id> --selftest` 传入)。
enum SelftestMode {
    case none
    case fixture
    case live
    case layout
}

enum SelftestController {
    static let mode: SelftestMode = {
        for arg in ProcessInfo.processInfo.arguments.dropFirst() {
            if arg == "--selftest" { return .fixture }
            if arg == "--selftest=live" { return .live }
            if arg == "--selftest=layout" { return .layout }
        }
        return .none
    }()

    private static var finished = false
    private static var watchdog: Timer?

    /// 看门狗:模拟器首启比桌面慢,给 120s(controller JS 侧另有 90s 兜底)
    static func startWatchdog() {
        DispatchQueue.main.async {
            watchdog = Timer.scheduledTimer(withTimeInterval: 120, repeats: false) { _ in
                finish(resultsJSON: SelftestResults.fail("看门狗超时(120s)"))
            }
        }
    }

    /// dc_selftest_done 落点:stdout 打 JSON,按 pass==total 定退出码
    static func finish(resultsJSON: String) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !finished else { return }
        finished = true
        watchdog?.invalidate()

        print(resultsJSON)
        fflush(stdout)

        var pass = -1
        var total = -1
        if
            let data = resultsJSON.data(using: .utf8),
            let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
            let p = obj["pass"] as? Int,
            let t = obj["total"] as? Int
        {
            pass = p
            total = t
        }
        exit(pass > 0 && pass == total ? 0 : 1)
    }

    // MARK: - 布局自测(纯 Swift,不起 UI)

    static func runLayoutSelftest() {
        var results: [SelftestResults.Item] = []

        func check(
            _ name: String,
            bounds: CGRect,
            insets: UIEdgeInsets,
            ratio: Double,
            mode: LayoutMode,
            side: SingleSide,
            _ f: (PaneFrames) -> String?
        ) {
            let frames = LayoutMath.computeFrames(
                bounds: bounds, insets: insets, ratio: ratio, mode: mode, visibleSide: side
            )
            if let bad = f(frames) {
                results.append(.init(name: name, pass: false, detail: bad))
            } else {
                results.append(.init(name: name, pass: true, detail: ""))
            }
        }

        // iPhone SE 横屏 667×375,无安全区
        check("iPhone SE 横屏 50/50", bounds: CGRect(x: 0, y: 0, width: 667, height: 375),
              insets: .zero, ratio: 0.5, mode: .split, side: .mirror) { fr in
            if abs(fr.left.width - fr.right.width) > 0.5 { return "两侧不等宽 \(fr.left.width) vs \(fr.right.width)" }
            if fr.left.minX != 0 || fr.right.maxX != 667 { return "未贴边" }
            if fr.left.minY != LayoutMath.toolbarH { return "y 应为工具条下缘" }
            if fr.left.width < LayoutMath.minPane { return "栏宽 < minPane" }
            return nil
        }
        // iPhone Pro Max 横屏 932×430,刘海侧 59、底部 21
        check("iPhone ProMax 横屏避让刘海", bounds: CGRect(x: 0, y: 0, width: 932, height: 430),
              insets: UIEdgeInsets(top: 0, left: 59, bottom: 21, right: 59),
              ratio: 0.5, mode: .split, side: .mirror) { fr in
            if fr.left.minX != 59 { return "左未避让刘海" }
            if fr.right.maxX != 932 - 59 { return "右未避让刘海" }
            if fr.left.height != 430 - 21 - 44 { return "高度未扣底条" }
            return nil
        }
        // iPhone 竖屏 390×844 单文档:隐藏原、显示译
        check("iPhone 竖屏单文档", bounds: CGRect(x: 0, y: 0, width: 390, height: 844),
              insets: UIEdgeInsets(top: 59, left: 0, bottom: 34, right: 0),
              ratio: 0.5, mode: .single, side: .mirror) { fr in
            if !fr.leftHidden || fr.rightHidden { return "可见侧错误" }
            if fr.right != CGRect(x: 0, y: 59 + 44, width: 390, height: 844 - 59 - 34 - 44) {
                return "单文档帧 \(fr.right)"
            }
            return nil
        }
        // iPad 竖屏 768×1024 上下安全区 20
        check("iPad 竖屏对照", bounds: CGRect(x: 0, y: 0, width: 768, height: 1024),
              insets: UIEdgeInsets(top: 20, left: 0, bottom: 0, right: 0),
              ratio: 0.5, mode: .split, side: .mirror) { fr in
            if fr.left.minY != 20 + 44 { return "y 应为 top+工具条" }
            if abs(fr.left.width - fr.right.width) > 0.5 { return "两侧不等宽" }
            return nil
        }
        // 极端比例钳制:0.01 → 0.05,左栏仍 ≥120
        check("极端比例钳制", bounds: CGRect(x: 0, y: 0, width: 1024, height: 768),
              insets: .zero, ratio: 0.01, mode: .split, side: .mirror) { fr in
            if fr.left.width < LayoutMath.minPane { return "左栏 \(fr.left.width) < \(LayoutMath.minPane)" }
            if fr.right.width < LayoutMath.minPane { return "右栏 \(fr.right.width) < \(LayoutMath.minPane)" }
            return nil
        }

        let pass = results.filter(\.pass).count
        let obj: [String: Any] = [
            "pass": pass,
            "total": results.count,
            "results": results.map { ["name": $0.name, "pass": $0.pass, "detail": $0.detail] },
        ]
        let json = SelftestResults.encode(obj)
        print(json)
        fflush(stdout)
        exit(pass == results.count && pass > 0 ? 0 : 1)
    }
}

/// 小工具:失败结果 JSON / 数组编码
enum SelftestResults {
    struct Item {
        let name: String
        let pass: Bool
        let detail: String
    }

    static func fail(_ why: String) -> String {
        encode([
            "pass": 0,
            "total": 1,
            "results": [["name": "selftest 执行", "pass": false, "detail": why]],
        ])
    }

    static func encode(_ obj: [String: Any]) -> String {
        guard
            let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]),
            let s = String(data: data, encoding: .utf8)
        else { return "{\"pass\":0,\"total\":1,\"results\":[]}" }
        return s
    }
}
