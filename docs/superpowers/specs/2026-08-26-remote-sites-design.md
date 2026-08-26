# 远程站点列表(共用 JSON URL)— 设计

日期:2026-08-26
状态:已确认(三节设计均获用户通过)

## 背景与目标

站点列表目前打包在各客户端内(扩展 DEFAULT_SITES、tauri/cdp 各自 sites.json),
新增站点要等用户更新客户端。目标:站点列表(含锚点表)放 GitHub 固定地址,
扩展与 Tauri 共用同一 JSON URL,新增站点合入 main 后客户端**下次启动即得**,零发版。

## 分发:GitHub Release latest 固定地址

CI 每次 push main 在 Release latest 追加上传:

- `sites.json` — 站点列表;`anchorMapUrl`/`pageMapUrl` 写 **Release 绝对地址**,
  如 `https://github.com/lif3ng-vibe/docs-compare/releases/download/latest/anchor-maps/orca.json`
- `anchor-maps/<id>.json`、`anchor-maps/<id>.page-map.json` — 全部锚点表资产

固定 URL 模式 `releases/download/latest/<file>`(Release 滚动重建 URL 不变),
仓库 public 无需鉴权。

构建源:`packages/core/src/defaults.ts`(内置即事实源)生成 sites.json ——
tauri/cdp 两份手工 sites.json 不再是事实源(CI 从 defaults.ts 生成下发)。

## 加载策略:打包兜底 + 远程热更

共同协议(core 新模块 `remote-sites.ts`):

```ts
export const REMOTE_SITES_URL =
  'https://github.com/lif3ng-vibe/docs-compare/releases/download/latest/sites.json';
export async function fetchRemoteSites(timeoutMs = 5000): Promise<SitePair[] | null>;
// fetch + parseSites 校验;任何失败(网络/超时/非法/errors 非空)返回 null
```

**Tauri(controller.ts)**:启动加载打包 sites.json 立即可用 → 后台
`fetchRemoteSites()` → 成功则 `sites = 远程` 并重渲染下拉。锚点表零改动:
远程 SitePair 的 anchorMapUrl 是绝对 URL,`resolveAnchorMapUrl` 现有逻辑直通。

**扩展(background.ts)**:SW 启动后台拉一次,存
`chrome.storage.local.dc_sites_remote`;`getSites()` 优先级
**用户手存(dc_sites)> 远程(dc_sites_remote)> 打包 DEFAULT_SITES**:
远程按 id 覆盖同名内置/追加新站;用户手存过的 id 永远用用户的。
锚点表零改动:`tableLocation()` 对绝对 URL 直通。

**CDP**:不接远程(开发工具,`--sites` 可覆盖),保持读打包 sites.json。

## 错误处理

- 拉取失败/超时 5s/JSON 非法/parseSites errors → 静默继续用本地,console warn
- 扩展每次 SW 冷启动试一次(天然节流);Tauri 每次窗口启动试一次;无重试定时器
- 远程某站锚点表 404 → 现有兜底(空表,锚点原样透传)

## 测试

- core:`fetchRemoteSites` 校验逻辑单测(非法输入 → null)
- CI 断言:下发的 sites.json 中 anchorMapUrl/pageMapUrl 全为 Release 绝对 URL
- 手测:改 Release sites.json 加假站 → Tauri 启动/扩展重载 → 下拉出现新站;
  断网 → 打包版照常工作

## 明确不做(YAGNI)

- 不做版本号/增量更新(整文件替换,几百 KB 级)
- 不做用户端「禁用远程更新」开关
- CDP 不接远程
- 不把远程列表写回打包文件(仅内存/存储热更)
