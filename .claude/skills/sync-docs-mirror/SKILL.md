---
name: sync-docs-mirror
description: Use when 检查/同步翻译镜像与原站的映射(锚点漂移、原站更新后的补译闭环、docs-cn 收录新翻译站后接入 docs-compare)。触发词:检查更新、锚点漂移、原站更新了、新翻译站接入、同步锚点表。
---

# sync-docs-mirror — 镜像映射同步(漂移检测 / 补译闭环 / 新站收录)

两个仓库协同工作,先认清位置:

- **翻译仓库** `C:\Users\lif3n\src\docs`(GitHub `lif3ng-vibe/docs-cn`,master):每站一个 `<站名>-docs-cn/` 子目录(Starlight),push 触发 Pages 部署(workflow `deploy-pages.yml`)
- **本仓库** `C:\Users\lif3n\src\docs-compare`(main):对照工具,锚点表/页面映射表打包在各实现里,`scripts/anchor-map.config.json` 是两仓库的桥

## 前置:环境自检

- GitHub API 匿名限额 60/h,走漂移检测**必须**有认证(5000/h):
  - `gh auth token` 可读?不行则看 `C:\Program Files\GitHub CLI\gh.exe`(刚装完 gh 不在会话 PATH 是常态,anchor-scan.mjs 已按此路径兜底)
  - 都没有 → 让用户 `winget install GitHub.cli` + `gh auth login`,停在这里
- 两个仓库都要先 `git fetch` 确认与远端同步再动手

## 流程 A:日常检查 + 补译闭环(原站更新了)

```
node scripts/check-anchor-drift.mjs     # 全部干净 exit 0;有漂移 exit 1
```

按报告分类处置(报告里「标题数量不齐」不计漂移,但它是**漏译信号**,要追):

1. **值变化 N 条 + 页面 h 数量不齐**(典型:原站某页加了小节)
   - 漂移报告会给出页面逻辑路径;抓原站线上 HTML 对比两侧标题列表,定位新增/删除的小节内容(用 `fetchText` from `scripts/lib/anchor-scan.mjs`,或直接 curl)
   - 去翻译仓库对应 `<站名>-docs-cn/src/content/docs/<路径>.md` 补译/删除小节:
     - 术语查该站 `GLOSSARY.md`;排版:全角标点、中英文间半角空格、菜单名保留英文加粗
     - 锚点:新标题会生成中文 slug,不用手算——构建后 grep dist 的 `id=` 即得
   - `npm run build`(翻译仓库子目录)零错误 → commit → **push(需用户确认)**
2. **页面下线/整页未入表**:先判断是原站删页还是镜像漏部署,再动
3. **`Error: … → HTTP 404`**:frontmatter `source:` 写错(如点号该归一成连字符:`agents.md` → `agents-md`,以线上真实 URL 为准),修翻译仓库该页 source 字段
4. **补译 push 后必须等 Pages 部署完成再重生成锚点表**(顺序坑):
   - `gh api repos/lif3ng-vibe/docs-cn/actions/runs?per_page=1` 轮询(status=completed;或浏览器看 Actions)
   - 部署完跑 `node scripts/gen-anchor-map.mjs`——提前跑会按旧镜像错位配对
5. 终验 `check-anchor-drift.mjs` exit 0;锚点表 diff 应只含预期增删
6. 本仓库 commit(推送与否听用户的)

## 流程 B:收录新翻译站(docs-cn 多了新站)

翻译仓库 `sites.json`/README 出现新站时(或用户明说):

1. 确认两侧线上可达:镜像 `https://lif3ng-vibe.github.io/docs-cn/<slug>/` 200;原站 URL 从新站 frontmatter `source:` 读到
2. `scripts/anchor-map.config.json` 加条目:
   ```json
   { "id": "<slug>", "dir": "<slug>-docs-cn", "origin": "<原站>", "mirror": "<镜像>", "useSourceFrontmatter": true }
   ```
3. 跑 `node scripts/gen-anchor-map.mjs`。看警告逐个处理:
   - **标题数量不齐 → 该级映射已丢弃**(配对纪律:硬配会产出语义错位映射)。正文页数量不齐 = 漏译,回流程 A 补;**落地页**数量不齐通常是重组,走 manualOverrides(下述)
   - **落地页重组**:核对两侧小节语义,在站点条目加 `manualOverrides`(键=镜像锚点,值=原站锚点;`null` = 剔除镜像新增节的错配)。词典落地页 7 个 Section h3 配原站 7 个 h2 即先例
4. **两侧路径形态不同**(原站扁平 `/skills-x` ↔ 镜像分组 `/dir/x/`):生成器自动产 `page-map.json`,但要接上配置才生效——五处同步(漏一处某实现就 404):
   - `apps/chrome-extension/src/options/options.ts` EXAMPLE(+`name` 中文名、`anchorMapUrl`、`pageMapUrl`)
   - `apps/tauri/config/sites.json`、`apps/cdp/config/sites.json`
   - `README.md` 内置站点对示例
   - (anchor-map.config.json 已在步骤 2 加过)
5. `npm run typecheck && npm test && npm run build` 全绿后 commit;用户确认后 push(push 后 CI 出 Release latest 新 zip)

## 常量速查

- 翻译仓库远端:`https://github.com/lif3ng-vibe/docs-cn.git`(master)
- Pages 部署轮询:`gh api "repos/lif3ng-vibe/docs-cn/actions/runs?per_page=1"` 看 status/conclusion
- 漂移检测 ~2-4 分钟(四站全抓);生成器同量级
- 生成器产物:`out/<siteId>/anchor-map.json` + `page-map.json`,自动同步 `copyTo`(chrome-extension static)
