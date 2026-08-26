import UIKit

/// 布局模式:对照(split)/ 单文档(single)
enum LayoutMode: String {
    case split
    case single
}

/// 单文档模式看哪一侧
enum SingleSide: String {
    case origin
    case mirror
}

struct PaneFrames {
    let controller: CGRect
    let left: CGRect
    let right: CGRect
    let leftHidden: Bool
    let rightHidden: Bool
}

/// 三视图帧计算(纯函数,layout selftest 的断言对象)。
/// 语义与 Tauri 版 main.rs 的 relayout() 一致:
/// - controller 铺满整窗(工具条 CSS 自己用 env() 避让安全区)
/// - 内容区 y = insets.top + 工具条高(44);左栏从 insets.left 起,
///   右栏到 insets.right 止;中间留 gap=8 的缝给拖拽手柄
/// - 单文档:可见侧占满内容区,另一侧 hidden(保留帧,JS 照跑,静默同步)
enum LayoutMath {
    static let toolbarH: CGFloat = 44
    static let gap: CGFloat = 8
    static let minPane: CGFloat = 120
    static let ratioMin: Double = 0.05
    static let ratioMax: Double = 0.95

    static func clampRatio(_ r: Double) -> Double {
        min(max(r, ratioMin), ratioMax)
    }

    static func computeFrames(
        bounds: CGRect,
        insets: UIEdgeInsets,
        ratio: Double,
        mode: LayoutMode,
        visibleSide: SingleSide
    ) -> PaneFrames {
        let contentX = insets.left
        let contentW = max(bounds.width - insets.left - insets.right, 2 * minPane)
        let y0 = insets.top + toolbarH
        let h = max(bounds.height - insets.top - insets.bottom - toolbarH, minPane)

        switch mode {
        case .single:
            let pane = CGRect(x: contentX, y: y0, width: contentW, height: h)
            return PaneFrames(
                controller: bounds,
                left: pane,
                right: pane,
                leftHidden: visibleSide != .origin,
                rightHidden: visibleSide != .mirror
            )
        case .split:
            let dividerX = contentX + CGFloat(clampRatio(ratio)) * contentW
            let lw = max(dividerX - gap / 2 - contentX, minPane)
            let rx = dividerX + gap / 2
            let rw = max(bounds.width - insets.right - rx, minPane)
            return PaneFrames(
                controller: bounds,
                left: CGRect(x: contentX, y: y0, width: lw, height: h),
                right: CGRect(x: rx, y: y0, width: rw, height: h),
                leftHidden: false,
                rightHidden: false
            )
        }
    }
}
