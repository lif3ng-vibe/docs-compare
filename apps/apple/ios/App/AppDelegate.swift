import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        NSLog("[dc] argv=%@ mode=%@", ProcessInfo.processInfo.arguments, String(describing: SelftestController.mode))
        // 布局自测是纯 Swift 数学断言,不起 UI,打完即退
        if SelftestController.mode == .layout {
            SelftestController.runLayoutSelftest()
        }
        // fixture/live 自测的看门狗(模拟器比桌面慢,宽于 controller 的 90s)
        if SelftestController.mode == .fixture || SelftestController.mode == .live {
            SelftestController.startWatchdog()
        }
        return true
    }

    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
