# 项目状态（生成物）

> ⚠️ **本文件由 `npm run docs:gen` 生成，禁止手改**。事实源：`docs/tasks/**` front-matter（ADR-018 D4）。
> 口径：活跃卡 = `status ∈ {open, in_progress, blocked}`；开放偏差/决策来自 plan_v2 §13 与 v3-pending（只统计未关闭项）。
> 图例：卡状态 `open` 待开工 / `in_progress` 进行中 / `blocked` 阻塞（`closed` 不进本表）；
> 「开放偏差」= plan_v2 §13.1–§13.3 明细行中**行内无 ✅**、且**未以行首列登记在 §13.4–§13.5 / 附录 A 收口表**的行；
> 「开放决策」= v3-pending 状态列非 ✅ 的行（🟡 = 待裁决；「已登记 → Txx」表示有承接任务，但仍未收口）。

## 概览

| 项 | 数量 |
|---|---|
| 任务卡（全部） | 5 |
| 活跃卡 | 4 |
| 开放偏差（plan_v2 §13） | 17 |
| 开放决策（v3-pending） | 27 |

## 活跃卡

| ID | 优先级 | 标题 | 状态 | gate | 关联 T |
|---|---|---|---|---|---|
| [D-32](./tasks/v3/D-32.md) | P2 | t55「真实 DuckDB 数据」板块表前置断言过期（断言 0 行 vs 实测 89928 行） | open | G6 | T55 |
| [D-37](./tasks/v3/D-37.md) | P2 | 推导回放的起点与期前持仓口径（SDD_v3 §9.3 未定义） | open | G4 | T129 |
| [D-38](./tasks/v3/D-38.md) | P2 | 单行判定异常分支（buy 且 balance_after < quantity）保守判 buy | open | G4 | T129 |
| [D-49](./tasks/v3/D-49.md) | P1 | T138 字段归一化（INV-S2-14/15/17~20/52）代码补零改动已回退，待重做 + G5 回归 | open | G5 | T138 |

## 核验锚（已核验关闭的卡）

| ID | 核验日期 | 核验提交 |
|---|---|---|
| [D-35](./tasks/v3/D-35.md) | 2026-11-04 | 6ae0e09 |

## 阅读入口

- 文档路由与 5 触发规则：[INDEX.md](INDEX.md)
- 开放项清单（只链接不复述）：[backlog.md](backlog.md)
- T 状态索引：[tasks/INDEX.md](tasks/INDEX.md)
