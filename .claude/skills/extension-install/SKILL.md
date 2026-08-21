---
name: extension-install
description: Use when 安装/更新 Chrome 扩展(下载 Release zip 或本地构建)、加载到 Chrome、验证插件工作。触发词:装插件、更新插件、下载扩展、插件不生效。
---

# extension-install — Chrome 扩展安装/更新

## 方式一:下载 Release(免本地构建,推荐)

```
https://github.com/lif3ng-vibe/docs-compare/releases/download/latest/docs-compare-extension.zip
```

- main 每次 push CI 自动重建此附件(滚动 release,链接恒定,匿名可下)
- 下载 → 解压到任意固定目录(别放 Downloads 里就地解压,升级要覆盖)

## 方式二:本地构建

```bash
cd C:/Users/lif3n/src/docs-compare && npm run build    # 产物 apps/chrome-extension/dist/
```

## 加载 / 更新(Chrome)

1. `chrome://extensions` → 开「开发者模式」
2. 首次:「加载已解压的扩展程序」→ 选解压目录 / `dist/`
3. 更新:同页面点该扩展卡片上的「**刷新**」图标(↻)——**只重新构建不刷新 = 还在跑旧代码**

## 装完验证(1 分钟)

1. 打开任一镜像页(如 `https://lif3ng-vibe.github.io/docs-cn/orca/agents/codex`)→ 点扩展图标 → 状态应显示「站点:orca(汉化站)」
2. popup 站点下拉应列出四站中文名;选站点「打开所选站点对照」→ 左右分屏打开
3. 一侧点标题 → 对侧滚到对应标题

## 常见「不生效」排查(按命中率排序)

| 症状 | 原因 | 处置 |
|---|---|---|
| 词典/技能站互跳 404 | storage 里是**旧站点配置**(无 pageMapUrl;约定回退已兜底,极旧版本则没有) | 配置页点「示例」重新保存;再刷新扩展 |
| 行为没变 | 构建了但没在 chrome://extensions 点刷新 | 点扩展卡片 ↻ |
| 「当前页不匹配任何站点配置」 | 该站未配置 | 配置页加站点对(照 README 内置四站格式) |
| popup 报无法连接后台 | service worker 挂了 | chrome://extensions 刷新扩展;还不行看 SW 日志 |

## 存储清理(调试用)

扩展配置在 `chrome.storage.local`:key `dc_sites`(站点对)、`dc_sites_raw`(配置页原文)、`dc_settings`。要重置:配置页清空重存,或 DevTools(扩展的 service worker → Console)执行 `chrome.storage.local.clear()`。
