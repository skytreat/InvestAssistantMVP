# 文档入口（INDEX）

> **本文件是全仓文档的唯一入口**（ADR-018 D5）。所有「读哪份文档」的路由都在这里，**其它文档不再各自维护索引**。
> 找不到该读什么 → 回本文件；本文件也没写 → 先提 issue，**不要凭记忆猜权威源**。

## 1. 五分钟入口

| 你要做什么 | 先读 | 再读 |
|---|---|---|
| 改代码（V3 范围） | [`AGENTS.md`](../AGENTS.md) 硬约束 | `docs/client/code_implementation_plan_v3.md` 对应任务 |
| 改代码（V3 外 / Wave 1-8） | [`AGENTS.md`](../AGENTS.md) 硬约束 | `docs/client/code_implementation_plan_v2.md` 对应 T |
| 判断某个行为「应该是什么」 | `docs/client/InvestAssistantV3_NewRequirements.md`（V3）/ `Requirements_simplified.md`（V3 外） | — |
| 判断接口 / 表结构 / SQL 怎么落地 | `docs/client/SDD_v3.md`（V3）/ `SDD.md`（V1 未覆盖项） | — |
| 判断界面怎么呈现 | `docs/client/PRD_v3.md` / `PRD.md`；视觉规格 `docs/client/ui-spec.md` | — |
| 查行情层真实表结构 | `docs/tdx2db_schema.md`（⚠️ 实现前必须 `DESCRIBE` 实测） | — |
| 查「为什么这么定」 | [`docs/adr/README.md`](adr/README.md) | — |
| 查当前进度 / 待办 | [`status.md`](status.md)（生成物）、[`backlog.md`](backlog.md)（生成物） | — |
| 查某个 D / T 的历史 | [`docs/tasks/INDEX.md`](tasks/INDEX.md)（生成物） | — |
| 运维 / 部署 / 起停服务 | `docs/deploy.md`；操作细则 `docs/runbooks/agent-playbook.md` | — |

## 2. 版本与文档栈

| 版本 | 状态 | 文档栈 |
|---|---|---|
| **V3**（当前主线） | 实施中（T119+） | 需求 `InvestAssistantV3_NewRequirements.md` · PRD `PRD_v3.md` · 契约 `SDD_v3.md` · 计划 `code_implementation_plan_v3.md` |
| **V1 / MVP**（基线） | Wave 1-12 已合入 | 需求 `Requirements_simplified.md` · PRD `PRD.md` · 契约 `SDD.md` · 计划 `code_implementation_plan_v2.md` |
| V4 候选 | 未启动 | 见 `docs/audit/v3-pending-decisions.md` 中标注「V4 候选」的 D 项 |

> **V3 是增量契约**：同一行为同时有 V1/V3 定义时，**V3 范围内以 V3 为准**；V3 未覆盖项回 V1。

## 3. 两类实体（ADR-018 D3）

- **D 卡**（`docs/tasks/v3/D-*.md`）＝**活跃实体**，一张卡 = 一个偏差 / 决策 / 待办，带 front-matter（`status`/`priority`/`owner`/`sources`）。
- **T-ID**（`T49`…`T152`）＝**历史计划号索引**，只用于追溯计划与 commit，**不再新增为活跃卡**。
- D-ID **不复用**；关闭后保留原卡（`status: closed` + `verified_commit`）。

## 4. 生成物与命令（禁手改）

| 文件 | 内容 | 生成命令 |
|---|---|---|
| [`status.md`](status.md) | 当前阶段 / 活跃卡 / 核验锚 | `npm run docs:gen` |
| [`backlog.md`](backlog.md) | 开放卡 + 开放偏差 + 开放决策（**只链接不复述**） | `npm run docs:gen` |
| [`tasks/INDEX.md`](tasks/INDEX.md) | 全部 D 卡索引 | `npm run docs:gen` |

校验：`npm run docs:lint`（生成物是否同步 / 卡字段完整 / D-ID 不重复 / `related_tasks` 存在 / **开放决策已上浮**）。

## 5. `docs/audit/` 的加载规则（默认不加载）

`docs/audit/` 是**证据层**（审计记录、benchmark、动态探针），**默认不作为执行依据**，也不进默认检索范围（`opencode.jsonc` 已排除 `docs/audit/**`、`docs/archive/**`）。
仅在下列 5 种情形加载：

1. 用户**显式点名**某个 audit 文件；
2. 怀疑某偏差**已被裁决**（用 D-ID 追认，避免复活已否决叙述）；
3. **本层事实冲突**，需要取证；
4. 要改某条**硬约束的出处**（找实测原始数据）；
5. 写 / 复核 **Wave gate** 或 **benchmark 报告**。

## 6. 权威源速查（详细版见 playbook §6）

| 层 | 文档 | 只回答 |
|---|---|---|
| L1 业务 | `InvestAssistantV3_NewRequirements.md` / `Requirements_simplified.md` | 业务规则与不变量（WHAT） |
| L2 体验 | `PRD_v3.md` / `PRD.md`、`ui-spec.md` | 用户可见旅程与交互 |
| L3 契约 | `SDD_v3.md` / `SDD.md` | API / DDL / SQL / 性能与安全门槛（HOW） |
| L3.5 行情 | `docs/tdx2db_schema.md` | DuckDB 真实表结构（只读） |
| L4 计划 | `code_implementation_plan_v3.md` / `code_implementation_plan_v2.md` | 任务拆解 / 排期 / Gate |
| L5 运维 | `docs/deploy.md`、`docs/runbooks/agent-playbook.md` | 部署、起停、实测坑位 |
| 决策 | `docs/adr/` | 为什么这么定 + 代价 |
