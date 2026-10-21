# 架构决策记录（ADR）

> 本目录记录**已做出的技术决策及其理由**。决策一旦接受即不可静默修改 ——
> 若需推翻，应新增一份 ADR 并标注「取代 ADR-NNN」。
>
> **决策的来源**：2026-10-17 所有者对 `code_implementation_plan_v2.md` §13.1 所列
> **13 项阻断级偏差**的逐项裁决（实施计划内记为 DEC-12）。
>
> **与实施计划的关系**：实施计划 §13 是**待办工作清单**（偏差登记 + 落地任务），
> 本目录是**决策归档**（结论 + 理由 + 代价）。二者不重复：plan 说「做什么」，ADR 说「为什么这么做」。

## 索引

| ADR | 标题 | 涵盖裁决 | 落地任务 |
|---|---|---|---|
| [ADR-001](ADR-001-frontend-backend-stack.md) | 前端与后端技术选型（指标库 / 图表库 / 测试框架版本） | DEC-1、DEC-3、DEC-11 | T51、T52、T61、T86 |
| [ADR-002](ADR-002-api-envelope-and-error-codes.md) | 统一响应封装与错误码契约 | B-9、B-10、I-2、I-15 | T84、T89a、T89b、T90 |
| [ADR-003](ADR-003-trade-dedup-semantics.md) | 交易记录去重语义 —— 追加而非拒绝 | B-11 | T87、T84 |
| [ADR-004](ADR-004-data-validation-integrity.md) | 数据校验完整性（C4/C5 实现 + 测试映射补齐） | B-1、B-2、B-4 | T85、T91 |
| [ADR-005](ADR-005-plugin-contract-and-timeout.md) | 插件契约字段、50ms 计时边界与热重载归属 | B-3、B-8、B-13 | T88、T93、T94 |
| [ADR-006](ADR-006-engineering-gates-and-wave-acceptance.md) | 工程门槛暂缓项与验收分层 | B-5、B-6 | T86、T86b、§12.7 Gate |
| [ADR-007](ADR-007-route-contract-and-candidate-migration.md) | 路由契约与候选池迁移语义 | B-7、B-12、I-1 | T90、T92 |
| [ADR-008](ADR-008-test-market-data-strategy.md) | 测试行情库策略 —— 迷你 DuckDB + 三档切换 + 两层开关 + 视图使用约束 | Wave 5 实施期性能诊断 | T60b、T60 剩余项、视图物化反模式修复 |

**13 项阻断裁决覆盖情况**：B-1 ~ B-13 全部已裁决并归档（8 份 ADR）。

**实施期新增**：ADR-008 来自 Wave 5 实施期的性能诊断与 owner 裁决（非 §13.1 阻断项）。

## 文档分层（各文档的职责边界）

| 层 | 文档 | 只管什么 | 明确不管什么 |
|---|---|---|---|
| L1 业务 | `docs/client/Requirements_simplified.md` | WHAT —— 业务规则唯一真相源 | 任何技术内容 |
| L2 体验 | `docs/client/PRD.md` | 用户可见行为与交互 | 技术实现 |
| L3 设计 | `docs/client/SDD.md` | **技术契约唯一权威**：API / DDL / 插件 / 验收标准 | 任务拆解 |
| L4 计划 | `docs/client/code_implementation_plan_v2.md` | 任务拆解 + 排期 + **偏差待办清单** + Wave Gate | **不重述技术契约** |
| 决策 | `docs/adr/`（本文档目录） | **为什么这么定** + 代价 | 具体怎么做 |
| 旁路 | `AGENTS.md` | agent 硬约束**摘要 + 指针** | 不复述细节 |
| 旁路 | `docs/coding-standards.md` | 编码风格 + 命名 | 不复述架构与验收 |

**真相源优先级**（冲突时从高到低）：
`Requirements_simplified` > `PRD` > `SDD` > 实施计划 > ADR

> ⚠️ 例外：**已接受 ADR 优先于 SDD 的旧表述** —— 出现分歧时应先按 ADR 更新 SDD
> （SDD 回写已于 2026-10-17 完成首轮，共 9 组）。

## 状态取值

| 状态 | 含义 |
|---|---|
| 提议中 | 已提出，未裁决 |
| ✅ 已接受 | 所有者已裁决，落地任务已派 |
| 已取代 | 被后续 ADR 推翻（需注明取代者）|
| 已废弃 | 时效性过期，不再适用 |
