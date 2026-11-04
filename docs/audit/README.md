# docs/audit —— 证据层（默认不加载）

> **层定位**：证据 / 实验协议 / 验收留档（ADR-018 D1）。**不作为执行依据**；执行依据以 [`../INDEX.md`](../INDEX.md) 的路由为准。
> **加载规则**：本目录不进默认上下文，仅在 5 种情形检索 —— ① 用户显式点名；② 怀疑历史已裁决（D-ID 追认）；③ 本层事实冲突需取证；④ 要改某条硬约束的出处；⑤ 写/复核 Wave gate 或 benchmark。

## 命名约定

| 前缀 / 后缀 | 含义 |
|---|---|
| `wave-N-audit.md` | Wave 出口验收（G1~G8 逐条 PASS/FAIL + 实测原始数据） |
| `v3-N-audit.md` | V3 阶段验收 |
| `v3-spec-gate.md` | V3 规格 Gate |
| `*-2026-XX-XX.md` | 按日期落档的审计 / 探针 / UX 交叉核对 |
| `v3-pending-decisions.md` | 开放决策**事实源**（被 `docs:gen` 读取，勿改名） |
| `doc-optimization-baseline.md` | 文档优化前后**基准协议与数据** |
| `doc-optimization-report-2026-11-04.md` | 同一实验的**分析报告**（结论 + 局限） |
| `doc-optimization-pilot-plan.md` | opencode 试点**方案**（N=1 可行性验证，待确认） |

## 入口

- 开放项总览（生成物，勿手改）→ [`../backlog.md`](../backlog.md)
- 项目状态（生成物）→ [`../status.md`](../status.md)
- 文档路由与 5 触发规则 → [`../INDEX.md`](../INDEX.md)
