# ADR-028 —— 废弃 `user_asset_rel` 中 `rel_type='hold'` 派生关系

| 项 | 值 |
|---|---|
| **状态** | ✅ 已接受（2026-11-13） |
| **落地** | 移除 `routes/trade.ts` 的 `syncHoldRelation` 及其在交易写入/软删/恢复中的调用；`exDividendSync.ts` 持有人查询改为直接读 `user_trade_record` |
| **关联 ADR** | ADR-021（信号域持仓来源改为交易流水实时计算）；ADR-027（信号分组视图） |
| **取代** | T58 中「买入/清仓同步 `user_asset_rel` hold 关系」的派生维护逻辑 |
| **编号注记** | ADR-026 已由 asset_class 增量初判取走，本 ADR 使用 ADR-028 |

## 1. 背景

`user_asset_rel` 同时承担 `watch`（自选）、`candidate`（候选池）与 `hold`（持仓派生）三类关系。
其中 `hold` 是**派生表**：由 `routes/trade.ts` 的 `syncHoldRelation` 在手工交易写入后维护，
但券商导入路径（`services/broker/brokerConfirm.ts`）只写 `user_trade_record`，从不写 `user_asset_rel`。
结果：

- 生产环境中 `user_asset_rel` 可能恒为 0 行或仅包含手工录入的少量持仓，`hold` 派生关系与 `user_trade_record` 事实表**无一致性保证**；
- ADR-021 已将信号域持仓来源切到 `user_trade_record` 实时计算，`hold` 不再参与信号生成；
- 唯一仍读取 `hold` 的地方是 `exDividendSync.ts`（除权自动导入的持有人查询），且已有交易表兜底。

保留 `hold` 会持续制造「派生表 vs 事实表」漂移风险，且新增写入路径（纸面、云函数等）容易再次漏同步。

## 2. 决策

**彻底废弃 `user_asset_rel` 中 `rel_type='hold'` 的派生维护**：

1. `user_asset_rel` 只保留 `watch` 与 `candidate` 两种业务关系；`hold` 不再作为持仓来源。
2. 移除 `syncHoldRelation` 函数及其在 `POST /api/trade`、`POST /api/trade/:id/soft-delete`、`POST /api/trade/:id/restore` 中的调用。
3. `exDividendSync.ts` 的持有人来源改为直接查询 `user_trade_record`（`SELECT DISTINCT user_id WHERE asset_code = ? AND is_deleted = 0`），不再读 `user_asset_rel`。
4. DDL 层 `rel_type CHECK` 仍保留 `'watch','hold','candidate'` 以兼容历史数据；未来需要可通过幂等表重建移除 `'hold'`，但本轮不改动 DDL。
5. 所有持仓相关口径（信号、除权、API）统一以 `user_trade_record` 实时计算为准（与 ADR-021 一致）。

## 3. 后果

**正面**

- 消除派生表与事实表脱节：无论手工录入还是券商导入，持仓口径一致；
- 减少 `user_asset_rel` 写入路径，降低未来新增导入渠道漏同步的风险；
- 除权导入的持有人查询更直接，无「hold 主分支 + 兜底」双路径。

**负面 / 代价**

- API 响应字段 `hold_rel` 移除，前端若依赖该字段需同步清理；
- 历史 `user_asset_rel` 中已存在的 `hold` 行不再被维护（可能残留软删/激活状态），但不影响业务；
- DDL 仍允许 `'hold'` 值，需靠代码纪律避免新写入。

## 4. 备选方案与否决理由

| 方案 | 否决理由 |
|---|---|
| 券商导入后补调 `syncHoldRelation` | 保留结构性风险：每条写入路径都必须记得维护派生表；未来新增路径仍会再犯 |
| 完全删除 `rel_type='hold'` 的 DDL 约束 | 需表重建，影响存量数据；当前代码已不再写 `hold`，可先废弃逻辑，DDL 后续再清理 |
| 保留 `hold` 但作为只读冗余字段 | 与 `user_trade_record` 实时计算重复，维护成本高且容易漂移 |

## 5. 验证

- `apps/backend/tests/unit/t58-signal-persist.test.ts` 已移除 hold 同步用例，保留信号落库字段断言；
- `apps/backend/tests/integration/trade.test.ts` 不再断言 `hold_rel`；
- 本地受影响测试全绿：`t58-signal-persist` / `t85b-signal-scope` / `assetClassSync` / `integration/trade`；
- `npm run typecheck -w @invest/backend` 通过；
- `eslint` 对改动文件无告警。

## 6. 后续（不在本次范围）

- 未来 DDL 清理：通过幂等表重建把 `rel_type` CHECK 收窄为 `('watch','candidate')`，并清理历史 `hold` 行；
- 前端 `hold_rel` 字段引用（若有）清理；
- 生产部署脚本/文档若提及 `syncHoldRelation` 或 `hold` 关系，需同步更新。
