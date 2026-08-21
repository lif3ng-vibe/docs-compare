---
name: check-anchor-drift
description: Use when 只想跑一次锚点漂移检查看结果(只读不改码)。触发词:检查漂移、锚点检查、挂定时检查镜像是否过期。要补译/重生成走 sync-docs-mirror。
---

# check-anchor-drift — 只读漂移检查

```bash
cd C:/Users/lif3n/src/docs-compare && node scripts/check-anchor-drift.mjs
```

- exit 0 = 四站全部干净;exit 1 = 有漂移(报告已打印)
- **前置**:`gh auth token` 可读(或 `C:\Program Files\GitHub CLI\gh.exe`;脚本已兜底该路径)。无认证撞匿名限额 60/h,报 HTTP 403 → 让用户装/登录 gh
- Windows 注意:两个脚本曾因裸 `C:\` 路径 import 挂过,已修;若再遇 `ERR_UNSUPPORTED_ESM_URL_SCHEME` 属回归

## 报告读法

| 输出 | 含义 | 要不要动 |
|---|---|---|
| `✓ 无漂移` | 干净 | 否 |
| `新页面/新增映射(表缺)` | 翻译站更新后没重跑生成器 | 走 sync-docs-mirror 流程 A 第 4 步 |
| `失效映射(表多余)` | 标题被删/改 ID | 同上 |
| `值变化` | 同键映射目标变了 | 同上;若伴随数量不齐 = 漏译,先补译 |
| `页面下线` | 表里的页面两侧都没了 | 核实后从表移除 |
| `ℹ 标题数量不齐 N 处` | **不计漂移**,是漏译/多译信号 | 需要时走 sync-docs-mirror 补译 |
| `⚠ 生成器产物 out/ 与打包表不同步` | 跑过生成器没提交 | commit 打包表 |
| `页面抓取失败 … HTTP 404` | frontmatter source 写错 | 修翻译仓库 source 字段 |
| `✗ 打包表不存在` | copyTo 没有 <id>.json | 先跑生成器 |

定时任务场景:本命令可直接挂 cron(有漂移 exit 1);发现漂移后转 sync-docs-mirror 处置。
