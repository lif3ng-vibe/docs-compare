---
name: tauri
description: Use when 运行 Tauri 版应用、跑 Tauri 自测(fixture/live/layout)、或打包 Tauri 安装包。触发词:跑 tauri、tauri 自测、打包 tauri、出 exe。
---

# tauri — 运行 / 自测 / 打包(docs-compare Tauri v2 实现)

位置:`apps/tauri/`;Rust 壳在 `apps/tauri/src-tauri/`。工具链现状(2026-08):cargo 1.97 ✓,**tauri-cli 未安装**,`target/release` 无产物(从未打过包)。

## 运行(dev)

```bash
cd C:/Users/lif3n/src/docs-compare
npm run build:tauri          # 前端 bundle → frontend-dist/(cargo 前必跑,漏跑白屏)
cd apps/tauri/src-tauri && cargo run
```

窗口弹出后:工具条粘贴任一侧 URL →「对照打开」(回车同效);分隔条可拖。

改了 `frontend/` 或 `inject/` 下的 TS:重跑 `npm run build:tauri` 再 `cargo run`(无热更)。
改了 `src-tauri/src/*.rs`:cargo 增量编译即可。

## 自测(跑完自动退出,exit code 0/1)

```bash
npm run selftest           # fixture 双语站(离线、快):导航/锚点/语义滚动同步
npm run selftest:live      # 真实站点(外网:onorca.dev ↔ GitHub Pages)
npm run selftest:layout    # 布局:5 组尺寸+最大化+连续 resize,断言等宽/贴边
```

注意:窗口会真实弹出,跑完自动关;fixture 模式离线可跑,live 依赖外网。

## 打包(首次需先装 tauri-cli)

```bash
# 一次性安装(用户确认后):
cargo install tauri-cli --locked    # 或 npm i -g @tauri-apps/cli

cd C:/Users/lif3n/src/docs-compare
npm run build:tauri                  # 前端产物必须先就位
cd apps/tauri/src-tauri
cargo tauri build                    # 产物在 target/release/bundle/
# NSIS 安装包: bundle/nsis/*.exe;单文件 exe: target/release/docs-compare.exe
```

Windows 打包依赖:NSIS(Tauri 会自动下载)、WebView2(系统自带)。首次打包 cargo 全量编译较久(10+ 分钟属正常)。

⚠️ 本 skill 的打包命令**未在本机实测过**(工具链缺口)。首次执行时以实际输出为准修正本文件:产物路径、是否需要签名配置、bundle 目标(msi/nsis 在 tauri.conf.json 的 bundle.targets)。

## 相关事实

- 站点配置:`apps/tauri/config/sites.json`(schema 同扩展,锚点表 `anchor-maps/` 由 build.mjs 从 chrome-extension static 拷贝)
- 自测入口由 Rust 注入 `window.__DC_SELFTEST__`,见 `src-tauri/src/main.rs`
- CI 不跑 Tauri(只有前端打包 `npm run build:tauri` 进 CI);cargo 侧无 CI 覆盖
