---
name: apple
description: Use when 运行 iOS/Catalyst 版应用、跑 apple 自测(fixture/live/layout)、模拟器调试、真机安装、Catalyst 冒烟。触发词:跑 iOS、apple 自测、模拟器、Catalyst、真机调试。
---

# apple — 运行 / 自测 / 调试(docs-compare iOS + Mac Catalyst 实现)

位置:`apps/apple/`;Swift 壳在 `apps/apple/ios/App/`(7 个文件,~700 行),TS 侧 `frontend/controller.ts` + `inject/reporter.ts`(Tauri 版平移,通道换 WKScriptMessageHandler)。工具链(2026-08-27 实测):Xcode 16.4 ✓、xcodegen(brew)✓、iOS 18.6 模拟器运行时(精简 Xcode 需 `xcodebuild -downloadPlatform iOS` 手动装,~9GB 磁盘)。

## 日常链路

```bash
npm run sim:apple            # 构建+安装+模拟器正常启动(手动过 UI 用)
npm run selftest:apple       # fixture 离线自测(模拟器里跑完自动退出,exit 0/1)
npm run selftest:apple:live  # 真实站点(外网:onorca.dev ↔ GitHub Pages)
npm run selftest:apple:layout # 纯 Swift 布局断言(不起 UI,也走模拟器)
```

前置顺序固定:改了 TS(`frontend/`、`inject/`)→ `npm run build:apple` 重新出 `web/`;改了 Swift 或首次 → `cd apps/apple && xcodegen generate` 后 xcodebuild(scripts 会自动判断,直接跑上面命令即可)。

生成目录均不入库:`web/`、`DocsCompare.xcodeproj/`、`build/`。

## 手动过 UI 要点

- iPhone:竖屏=单文档(工具条「原/译」切换看哪侧),横屏=对照(可再切「单文」)
- iPad:横竖屏都支持对照+单文档;旋转后分隔条按比例跟随
- 下拉选站 → 两侧打开;拖中间分隔条调比例;两侧点链接/标题看同步
- 单文档模式下隐藏侧仍被静默驱动(切回对照即已同步)

## 真机调试

模拟器构建免签(`CODE_SIGNING_ALLOWED=NO`);真机需要:用 Xcode 打开 `apps/apple/DocsCompare.xcodeproj` → target DocsCompare → Signing & Capabilities 勾自动签名选自己的 team(免费个人 team 即可,7 天过期)→ 选设备 Run。工程是 xcodegen 生成的,project.yml 为事实源,改动回写 project.yml 再重新 generate。

## Catalyst(macOS 同套布局)

```bash
cd apps/apple
xcodegen generate   # 若未生成
xcodebuild -project DocsCompare.xcodeproj -scheme DocsCompare \
  -destination 'platform=macOS,variant=Mac Catalyst' -derivedDataPath build \
  CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO build
open build/Build/Products/Debug-maccatalyst/DocsCompare.app
```

Mac 上桌面分发仍以 Tauri dmg 为准,Catalyst 是"同套布局"验证渠道。

## 相关事实

- 站点配置/fixture 直接取自 tauri 实现单一事实源:build.mjs 拷 `../tauri/config/sites.json`、`../tauri/fixtures/`、`../tauri/frontend/blank.html`
- 通道约定:所有跨 Swift↔JS 消息都是 JSON 字符串(dcInvoke/dcReport 上行,`window.__dcDispatch` 下行),与 CDP binding 同款
- 自测入口由 Swift 按 `ProcessInfo.arguments`(simctl launch 传 `--selftest[=live|layout]`)注入 `window.__DC_SELFTEST__`
- CI 有 macos-14 job 跑 `npm run selftest:apple`(fixture 模式);live 不进 CI
- 多窗口:iOS v1 不支持(`dc_new_window` 返回错误,按钮 CSS 隐藏,代码路径保留待 iPad scenes)
