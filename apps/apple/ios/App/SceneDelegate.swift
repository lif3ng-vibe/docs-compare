import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        let vc = CompareViewController()
        // 标题跟随:left webview 的 title KVO → 窗口标题(Catalyst 可见)
        vc.onTitle = { [weak scene] title in
            scene?.title = title
        }
        window.rootViewController = vc
        window.makeKeyAndVisible()
        self.window = window
    }
}
