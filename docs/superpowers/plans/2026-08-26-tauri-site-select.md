# Tauri 工具条站点下拉 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tauri 版工具条增加站点下拉,选中即打开该站点原站/镜像首页对照,并与 URL 输入框双向联动。

**Architecture:** 纯前端改动(`apps/tauri/frontend/` 3 个文件),controller 加 `renderSiteSelect()`/`openSitePair()`/`syncSelectFromUrl()` 三个函数;首页 URL 用 core 的 `buildUrl(site, side, '/')` 拼出,导航复用现有 `navigateTo()`;Rust 侧零改动。

**Tech Stack:** TypeScript + esbuild(iife bundle)、Tauri v2 webview、`@docs-compare/core`。

**Spec:** `docs/superpowers/specs/2026-08-26-tauri-site-select-design.md`

## Global Constraints

- 仓库根目录:`C:\Users\lif3n\src\docs-compare`,bash 里用 `/c/Users/lif3n/src/docs-compare` 或直接相对路径。
- UI 文案全部中文,注释风格与现有文件一致(中文、`/** */` 或行内)。
- 选项文案:`name ?? id`;`official: true` 的站点后缀「(官方)」(与扩展 popup.ts:80 一致)。
- 占位项:「选择文档站点…」,`value=""`,`disabled selected`,启动不自动导航。
- selftest 模式(`window.__DC_SELFTEST__` 为真)不渲染下拉、不加载 sites.json(现有分支保持)。
- 程序化设 `select.value` 不触发 `change`——回填天然无回环。
- commit 信息不带 Co-Authored-By/任何 Claude 署名(用户全局规则)。
- 验证命令(仓库根):`npm run build:tauri`、`npm run typecheck --workspace @docs-compare/tauri`、`npm run selftest`(会弹窗,跑完自动退出,期望 exit 0)。

## 现状速览(给零上下文工程师)

- `apps/tauri/frontend/index.html`:工具条 `#toolbar`(44px 高):`.brand` + `#url-left`(输入框)+ `#open-pair`(按钮)+ `#status`;`<script src="controller.js">`。
- `apps/tauri/frontend/controller.ts`:
  - 模块级状态:`let sites: SitePair[] = []`(第 35 行附近)。
  - `navigateTo(view: 'left'|'right', url: string)`(94 行):设 `viewUrls[view]` 后 `invoke('dc_navigate', …)`。
  - `wireUi()`(206 行):绑分隔条、`#open-pair` 点击、`#url-left` 回车 → `openPair()`(247 行:mapUrl 归一左右后 navigateTo + 状态栏提示)。
  - `syncFrom(view, rawUrl)`(100 行):导航同步状态机,开头 `if (pendingUrl.get(view) === rawUrl)` 去重,`viewUrls[view] = rawUrl`,然后 `mapUrlWithPages(rawUrl, sites)` 映射。
  - `main()`(462 行):加载 `sites.json` → `parseSites` → `sites = parsed`(仅非 selftest 分支);之后 `wireUi()`。
- `apps/tauri/frontend/style.css`:`#url-left` 的样式是工具条输入控件基准(圆角 6px、边框 `#cfd4da`、字号 12px)。
- `SitePair` 类型(core):`{ id, name?, official?, origin, mirror, anchorMapUrl?, … }`。
- `buildUrl(site: SitePair, side: 'origin'|'mirror', path: string): string` 来自 `@docs-compare/core`(controller.ts 尚未 import,需要加)。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `apps/tauri/frontend/index.html` | Modify | 工具条插入 `<select id="site-select">` |
| `apps/tauri/frontend/style.css` | Modify | `#site-select` 样式 |
| `apps/tauri/frontend/controller.ts` | Modify | 渲染/打开/联动三函数 + import `buildUrl` |

单任务特性(3 文件、一次交付、回归一套 selftest),不拆多任务。

---

### Task 1: 工具条站点下拉(渲染 + 选中即开 + 双向联动)

**Files:**
- Modify: `apps/tauri/frontend/index.html`
- Modify: `apps/tauri/frontend/style.css`
- Modify: `apps/tauri/frontend/controller.ts`

**Interfaces:**
- Consumes: `navigateTo(view, url)`、`mapUrlWithPages(rawUrl, sites)`、`parseSites`(controller.ts 现有);`buildUrl(site, side, path)`(core 现有,新 import)。
- Produces: `renderSiteSelect(): void`、`openSitePair(site: SitePair): Promise<void>`、`syncSelectFromUrl(siteId: string | null): void`(均 controller.ts 内部函数,无外部消费者)。

注:本仓库 Tauri 前端无 JS 测试框架(selftest 是 Rust 驱动的 E2E,且不渲染下拉)。测试策略 = typecheck + build + 三套 selftest 回归 + 手测清单。

- [ ] **Step 1: index.html 插入 select**

`apps/tauri/frontend/index.html` 工具条在 `<span class="brand">` 与 `<input id="url-left">` 之间插入:

```html
  <select id="site-select" aria-label="站点对"><option value="" disabled selected>选择文档站点…</option></select>
```

改后工具条:

```html
<div id="toolbar">
  <span class="brand">Docs Compare</span>
  <select id="site-select" aria-label="站点对"><option value="" disabled selected>选择文档站点…</option></select>
  <input id="url-left" placeholder="原站 URL,粘贴后回车" spellcheck="false">
  <button id="open-pair">对照打开</button>
  <span id="status"></span>
</div>
```

- [ ] **Step 2: style.css 加 select 样式**

`apps/tauri/frontend/style.css` 在 `#url-left` 规则后追加(风格对齐 `#url-left`,见该文件 17-24 行):

```css
#site-select {
  width: 180px;
  box-sizing: border-box;
  padding: 5px 6px;
  border: 1px solid #cfd4da;
  border-radius: 6px;
  font: 12px system-ui, -apple-system, sans-serif;
  background: #fff;
  color: #333;
  text-overflow: ellipsis;
}
```

- [ ] **Step 3: controller.ts — import buildUrl**

`apps/tauri/frontend/controller.ts` 顶部 import 列表(13-21 行)加入 `buildUrl`:

```ts
import {
  AnchorIndex,
  PageIndex,
  buildUrl,
  defaultAnchorMapUrl,
  defaultPageMapUrl,
  mapUrl,
  normalizePathKey,
  parseSites,
} from '@docs-compare/core';
```

- [ ] **Step 4: controller.ts — 三个新函数**

在 `wireUi()` 之前(约 205 行,`// ---------- 布局 ----------` 区块之后、`wireUi` 定义之前)插入:

```ts
// ---------- 工具条站点下拉 ----------
/** 渲染站点下拉选项;sites 为空则禁用(仅剩占位项) */
function renderSiteSelect(): void {
  const sel = document.getElementById('site-select') as HTMLSelectElement | null;
  if (!sel) return;
  sel.replaceChildren();
  const ph = document.createElement('option');
  ph.value = '';
  ph.disabled = true;
  ph.selected = true;
  ph.textContent = '选择文档站点…';
  sel.appendChild(ph);
  for (const s of sites) {
    const opt = document.createElement('option');
    opt.value = s.id;
    // 官方双语站(origin/mirror 都是官方维护)打「官方」后缀,与我们维护的汉化镜像区分
    opt.textContent = s.official ? `${s.name ?? s.id}(官方)` : (s.name ?? s.id);
    sel.appendChild(opt);
  }
  sel.disabled = sites.length === 0;
}

/** 下拉选站:左右各开该站点首页(原站/镜像) */
async function openSitePair(site: SitePair): Promise<void> {
  const leftUrl = buildUrl(site, 'origin', '/');
  const rightUrl = buildUrl(site, 'mirror', '/');
  await navigateTo('left', leftUrl);
  await navigateTo('right', rightUrl);
  const input = document.getElementById('url-left') as HTMLInputElement | null;
  if (input) input.value = leftUrl;
  syncSelectFromUrl(site.id);
  const status = document.getElementById('status');
  if (status) status.textContent = `${site.id}:已对照打开`;
}

/** 导航后回填下拉:命中站点则切过去,否则回占位项(程序化赋值不触发 change,无回环) */
function syncSelectFromUrl(siteId: string | null): void {
  const sel = document.getElementById('site-select') as HTMLSelectElement | null;
  if (!sel) return;
  sel.value = siteId && sites.some((s) => s.id === siteId) ? siteId : '';
}
```

注意 `openSitePair` 里调用 `navigateTo` 会设 `viewUrls` 但**不**设 `pendingUrl`——两侧首页加载后 `cs:hello`/`cs:nav` 事件会把 `viewUrls` 再写一遍同值,`syncFrom` 走正常映射(首页 ↔ 首页,samePage 或互跳同一 URL 的 split 相同不重导航),与现有 `openPair()` 行为一致,无需额外处理。

- [ ] **Step 5: controller.ts — wireUi 挂 change**

`wireUi()` 内部(分隔条绑定之后、`const input = …` 之前)插入:

```ts
  const siteSelect = document.getElementById('site-select') as HTMLSelectElement | null;
  siteSelect?.addEventListener('change', () => {
    const site = sites.find((s) => s.id === siteSelect.value);
    if (site) void openSitePair(site);
  });
```

- [ ] **Step 6: controller.ts — openPair 联动 + syncFrom 联动**

1. `openPair()`(wireUi 内,247-261 行)末尾 `show(\`${src.site.id}:已对照打开\`);` 之前加一行:

```ts
    syncSelectFromUrl(src.site.id);
```

2. `syncFrom()` 里 `viewUrls[view] = rawUrl;` 之后(107 行后)加:

```ts
  const hitSite = (await mapUrlWithPages(rawUrl, sites))?.site.id ?? null;
  syncSelectFromUrl(hitSite);
```

但注意:第 108 行已有 `const src = await mapUrlWithPages(rawUrl, sites); if (!src) return;`。为不重复解析,直接改为在该行后插入联动:

原:

```ts
  viewUrls[view] = rawUrl;
  const src = await mapUrlWithPages(rawUrl, sites);
  if (!src) return;
```

改后:

```ts
  viewUrls[view] = rawUrl;
  const src = await mapUrlWithPages(rawUrl, sites);
  syncSelectFromUrl(src?.site.id ?? null);
  if (!src) return;
```

(`syncFrom` 开头的 pendingUrl 去重分支会提前 return,自导航回填不会触发,行为正确。)

- [ ] **Step 7: controller.ts — main() 渲染下拉**

`main()` 里非 selftest 分支(512-522 行)加载 sites 成功后调用渲染。原:

```ts
  if (mode) {
    // selftest 自带站点配置
  } else {
    try {
      const res = await fetch('sites.json');
      if (res.ok) {
        const { sites: parsed, errors } = parseSites(await res.json());
        if (errors.length) console.warn('[dc] 站点配置问题:', errors);
        sites = parsed;
      }
    } catch (e) {
      console.warn('[dc] sites.json 加载失败:', e);
    }
  }
```

改后(仅加最后一行):

```ts
  if (mode) {
    // selftest 自带站点配置,不渲染下拉(避免干扰测试 UI)
  } else {
    try {
      const res = await fetch('sites.json');
      if (res.ok) {
        const { sites: parsed, errors } = parseSites(await res.json());
        if (errors.length) console.warn('[dc] 站点配置问题:', errors);
        sites = parsed;
      }
    } catch (e) {
      console.warn('[dc] sites.json 加载失败:', e);
    }
    renderSiteSelect();
  }
```

- [ ] **Step 8: typecheck + build**

Run(仓库根):

```bash
npm run typecheck --workspace @docs-compare/tauri
npm run build:tauri
```

Expected: 两条命令均无报错退出(esbuild 输出 `frontend-dist/controller.js` 等)。

- [ ] **Step 9: selftest 回归**

Run(仓库根,会弹 Tauri 窗口,跑完自动退出):

```bash
npm run selftest
npm run selftest:layout
```

Expected: 两条命令 exit 0(fixture 模式 5 用例通过;layout 模式布局断言通过——下拉不渲染,不影响)。

- [ ] **Step 10: 手测清单(交付前走一遍)**

Run(仓库根):

```bash
npm run build:tauri && cd apps/tauri/src-tauri && cargo run
```

清单:
1. 启动:下拉显示「选择文档站点…」,两侧空白,未自动导航。
2. 下拉应有 6 个站点(orca/codegraph/mattpocock-skills/ai-coding-dictionary/ai-memory/herdr 文档),herdr 显示「Herdr 文档(官方)」。
3. 选 orca:左开 `https://www.onorca.dev/docs/`,右开 `https://lif3ng-vibe.github.io/docs-cn/orca/`,URL 框 = 原站首页,状态栏「orca:已对照打开」。
4. 改 URL 框为 onorca.dev 任意文档页回车:两侧跳转,下拉保持 orca。
5. 两侧点链接互相跳转:下拉跟随正确站点不变(已是 orca)。
6. 选 herdr:两侧开 herdr.dev/docs 与 /zh-cn/docs,下拉显示「Herdr 文档(官方)」。

- [ ] **Step 11: Commit**

```bash
git add apps/tauri/frontend/index.html apps/tauri/frontend/style.css apps/tauri/frontend/controller.ts
git commit -m "tauri:工具条加站点下拉,选站即开对照并与 URL 框联动"
```

---

## Self-Review 记录

- Spec 覆盖:占位项/选项文案(官方后缀)/选中即开/buildUrl 首页/双向联动(选站填 URL 框、导航回填下拉)/空 sites 禁用/selftest 不渲染/布局不变——Step 1-7 全覆盖;错误处理「选中 id 不存在」由 `sites.find` 空值忽略天然满足;手测清单覆盖 spec 测试节。
- 无占位符;所有代码块完整可抄。
- 命名一致:`renderSiteSelect`/`openSitePair`/`syncSelectFromUrl` 三处引用一致;`buildUrl` 与 core 导出名一致(`packages/core/src/url.ts:64`);id `site-select` 全计划统一。
