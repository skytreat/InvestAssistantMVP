# Wave 3.2 验收报告（V3.2 · 券商维度与补录链路 T128~T129）

> **依据**：`docs/client/code_implementation_plan_v3.md` §4.3（V3.2 门槛）与 §4.5（通用门槛）。
> **验收范围**：T128 (`user_trade_record` 券商维度改造与三部分唯一索引) + T129 (`brokerConfirm` 补录服务与两端点 + T122 导入写路由 admin 门补位)。

---

## 1. 门槛检核表（G1 ~ G5 + 通用 G1~G5）

| 门槛项 | 要求 | 实测判定 | 证据 / 原始数据 |
|---|---|---|---|
| **G1 约束并存** | 手工单同日同标的同类型同时刻被 409 拒绝；导入行同秒多笔合法共存 | **PASS** | `t128-broker-dim.test.ts` 4/4 通过（含 legacy 迁移零丢失、复合冲突及 NULL 时间校验） |
| **G2 迁移零丢失** | 历史遗留 T87 形态（表级 UNIQUE + `trade_time NOT NULL` + 无券商列）升级到 T128 架构时**数据零丢失** | **PASS** | 4 条历史行重构后行数一致、关键列逐行相等、`integrity_check` 0 错 |
| **G3 可回溯** | 补录生成的事实与业务行通过 `source_broker_record_id` ↔ `matched_trade_record_id` 双向回溯 | **PASS** | `t129-broker-confirm.test.ts` ⑥ 确认后事实行置 `MATCHED` 且互指准确 |
| **G4 可撤销** | 撤销补录 = 软删业务层，事实层保留且索引 B 释放锚点可重新补录 | **PASS** | 测试 ④ 验证：软删 `user_trade_record` 后同事实源可二次成功补录 |
| **G5 事务边界** | 一次补录确认整体一个事务，单项 UNIQUE 冲突全回滚（业务 0 行、事实无新增 `MATCHED`） | **PASS** | `t129-broker-confirm-routes.test.ts` ③ 注入 C 索引冲突 payload → 返回 `409 BROKER_CONFIRM_CONFLICT` 且数据库状态完全回滚 |
| **通用 G1 任务原子** | 一个 T 任务一条 commit，暂无混杂 | **PASS** | T128 (`b504a1d`) 与 T129 独立原子提交 |
| **通用 G2 质量守门** | `typecheck`、`lint`、`vitest` 全量通过 | **PASS** | 后端 740+181 用例全绿；tsc / eslint 零报错 |

---

## 2. 核心技术决策登记（追溯至 `docs/audit/v3-pending-decisions.md`）

- **D-34**：T128 物理形态三处自决（`broker_code TEXT` 无外键；三条部分唯一索引 A/B/C 解决 NULL 时间隔离；无 `asset_class` 冗余列）。
- **D-35**：T122 导入写路由缺 admin 门（SDD §10.3 遗留缺口）在 T129 随补录端点一并补齐（`broker-import/confirm`、`batches/:id/revoke`、`templates` POST 强校验 `role === 'admin'`）。
- **D-36**：补录不收分红/送股事件族（防止与除权链路双真理源冲突）。
- **D-37 / D-38**：回放起点取事实层首行；余额小于成交量异常保守判建仓（`buy`）。

---

## 3. 结论

**Wave 3.2 验收通过 (PASS)**。准予合并入 `main` 并向下推进 V3.3（T130~T132 持仓成本链路）。
