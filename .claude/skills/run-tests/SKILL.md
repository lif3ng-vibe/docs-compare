---
name: run-tests
description: Use when 跑本仓库测试(core 冒烟、扩展打包、Tauri/CDP 自测)、CI 前本地验证、或改动后要全面回归。触发词:跑测试、回归、验证构建、全绿。
---

# run-tests — 测试与验证矩阵

全部在仓库根 `C:/Users/lif3n/src/docs-compare` 下执行。

## 快速层(改任何代码后必跑,<1 分钟)

```bash
npm test          # core 冒烟(url 映射/锚点表/page-map/滚动数学),esbuild+node 零依赖
npm run typecheck # 全部 workspace tsc --noEmit
```

## 打包层

```bash
npm run build         # Chrome 扩展 → apps/chrome-extension/dist/
npm run build:tauri   # Tauri 前端 bundle → frontend-dist/(不编译 Rust)
```

## 端到端自测层(会弹真窗口,跑完自动退出,exit 0/1)

| 命令 | 覆盖 | 依赖 |
|---|---|---|
| `npm run selftest:cdp` | CDP 版:fixture 双语站导航/锚点/语义滚动同步 | 离线 ✓ CI 在跑(加 `--headless`) |
| `npm run selftest:cdp:live` | CDP 版:真实站点 | 外网,仅本地 |
| `npm run selftest` | Tauri 版:fixture | 需 cargo,弹 Tauri 窗口 |
| `npm run selftest:live` | Tauri 版:真实站点 | 外网 + cargo |
| `npm run selftest:layout` | Tauri 布局:5 组尺寸+最大化+resize | cargo |
| `npm run selftest:multiwindow` | Tauri 多窗口:开窗/隔离/标题跟随 | cargo |

headless 跑 CDP(无窗口):`npm run selftest --workspace @docs-compare/cdp -- --headless`(CI 同款,env `CI=1`)

## 组合建议

- **改了 core(`packages/core/`)**:test + typecheck + 两个 build + `selftest:cdp`(全链路,core 被全部实现共享)
- **改了扩展(`apps/chrome-extension/`)**:typecheck + build;行为变化再人工验(extension-install skill 有 1 分钟验证清单)
- **改了 CDP(`apps/cdp/`)**:typecheck + `selftest:cdp`
- **改了 Tauri 前端/inject**:typecheck + build:tauri + `npm run selftest`
- **改了 Rust(`src-tauri/`)**:cargo 侧无 CI;`npm run selftest` + `selftest:layout`
- **改了 scripts/(锚点表管线)**:直接跑 `node scripts/gen-anchor-map.mjs` + `node scripts/check-anchor-drift.mjs` 看产物与报告

## CI 对照(`.github/workflows/ci.yml`)

push/PR 自动:typecheck + test + build + build:tauri + selftest:cdp(headless)。
本地全绿但 CI 红时先看:Node 版本(CI=22)、平台差异(本地 win32/CI linux)、live 依赖(不会是它,CI 不跑 live)。
