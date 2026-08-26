---
name: tauri
description: Use when 运行 Tauri 版应用、跑 Tauri 自测(fixture/live/layout)、或打包 Tauri 安装包。触发词:跑 tauri、tauri 自测、打包 tauri、出 exe。
---

# tauri — 运行 / 自测 / 打包(docs-compare Tauri v2 实现)

位置:`apps/tauri/`;Rust 壳在 `apps/tauri/src-tauri/`。工具链(2026-08-21 实测):cargo 1.97 ✓,tauri-cli 2.11.4 ✓(`cargo install tauri-cli --locked`,装在 `~/.cargo/bin/cargo-tauri.exe`)。

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
npm run selftest:multiwindow  # 多窗口:开窗/独立导航/互不干扰/标题跟随
```

注意:窗口会真实弹出,跑完自动关;fixture 模式离线可跑,live 依赖外网。

## 打包(2026-08-21 已实测 ✓)

前置(已完成,除非环境重置):tauri-cli 已装;`tauri.conf.json` 的 `bundle.active: true` + `targets: ["nsis"]`;`icons/` 有全套图标(首次曾因缺 `icon.ico` 失败——cargo run 不需要它,release 打包的资源编译需要;`cargo tauri icon icons/icon.png` 从源图一次生成全套,Android/iOS 产物可不管)。

```bash
cd C:/Users/lif3n/src/docs-compare
npm run build:tauri                  # 前端产物必须先就位
cd apps/tauri/src-tauri
cargo tauri build
```

产物(实测):

- NSIS 安装包:`target/release/bundle/nsis/docs-compare_<version>_x64-setup.exe`(v0.1.0 实测 2.2 MB)
- 单文件 exe:`target/release/docs-compare-tauri.exe`(实测 9.7 MB,绿色免装)

耗时:首次全量 ~5.5 分钟(此前 tauri-cli 编译安装另花 ~11 分钟);增量重打包快得多(NSIS 自动下载一次后缓存)。

## 相关事实

- 站点配置:`apps/tauri/config/sites.json`(schema 同扩展,锚点表 `anchor-maps/` 由 build.mjs 从 chrome-extension static 拷贝)
- 自测入口由 Rust 注入 `window.__DC_SELFTEST__`,见 `src-tauri/src/main.rs`
- CI 不跑 Tauri(只有前端打包 `npm run build:tauri` 进 CI);cargo 侧无 CI 覆盖
- `target/` 不入库;`icons/` 全套入库(打包依赖)
