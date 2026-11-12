# ADR-021 —— 信号标的域的「持仓」来源改为交易流水实时计算（不再依赖 `user_asset_rel` 派生关系）

| 项 | 值 |
|---|---|
| **状态** | ✅ 已接受（2026-11-12，生产事故驱动） |
| **落地** | 本次修复（`apps/backend/src/services/signalService.ts` + `tests/unit/t85b-signal-scope.test.ts`，无新 T 号） |
| **关联偏差** | §13.2 **I-38**（新增）；遗留 **I-39**（除权导入链路的两个已知遗留，与本决策无关） |
| **关联文档** | Requirements §「监控覆盖范围」、PRD M4、SDD §5.1（17:02 段时序） |
| **不取代** | 不取代 ADR-016（现金类资产建模）、ADR-018（校验补跑） |

---

## 1. 背景（生产实测，非估计）

### 1.1 现象

2026-11-12 生产 `system_log`（`log_type='signal_generate'`）：

```
INFO  插件信号生成开始
INFO  信号生成跳过：用户无自选/持仓标的（signal 域为空）   detail={"userId":1}
SUCCESS 信号生成完成: signals=0 inserted=0 skipped=0 persist_errors=0
```

而该用户**明明有持仓**。

### 1.2 实测数据（`/opt/invol/IA_Prod/data/business.db`）

| 检查项 | 结果 |
|---|---|
| `user_asset_rel` | **0 行**（连自选都没有） |
| `user_trade_record` | 438 条（2025-08-29 ~ 2026-11-11），**全部来自 5 批券商导入** |
| `broker_trade_record` | 1019 条 |
| 净持仓 > 0 的标的（core 口径） | **35 只** |
| `asset_class` | 0 行（`ASSET_CLASS_SYNC_MODE` 默认 `dry-run` 不写库，非本次问题） |

### 1.3 结构性断链

信号域的「持仓」侧取自 `user_asset_rel` 的 `rel_type='hold'` —— 一个**派生关系**：

- 写入方**只有**手工录入路径：`POST /api/trade` → `syncHoldRelation`（`routes/trade.ts:410/684/723`）；
- 券商导入路径 `services/broker/brokerConfirm.ts:448` **只写 `user_trade_record`，从不写 `user_asset_rel`**；
- ⇒ 事实表与派生表之间**没有任何一致性保证** ⇒ 生产 `user_asset_rel` 恒为 0 行
  ⇒ 17:02 每日信号生成**恒定跳过**，且**不报错**（只写 INFO）。

这不是"某个环境的数据脏"，而是**任何只用券商导入建立持仓的部署都会中招**。

## 2. 决策

1. **信号域 = 自选 ∪ 持仓**，两侧各自取**最可靠来源**：
   - 自选：`user_asset_rel` 的 `rel_type='watch'` 且未软删（自选本就只存在这张表）；
   - 持仓：**由 `user_trade_record` 实时计算**的净持仓 > 0。
2. 持仓口径**直接复用** `calcAllPositions(userId)`（core `calculateMovingWeightedCost`）
   ⇒ 与 `GET /api/positions`、插件持仓快照（`pluginEngine.loadPositionSnapshot`）**完全同源**，
   查询次数恒为 1（与标的数无关，T60 已消除 N+1）。
3. `hold` 派生关系**不再参与任何业务决策**；写入路径保留（向后兼容 / 展示用）。
4. 现金类排除（T133 / INV-S4-15）、候选池不计入 —— 口径不变。

## 3. 后果

**正面**

- 生产信号生成恢复（部署后 17:02 段 `signals=N inserted=M`，N>0）；
- 信号域与持仓视图同源 ⇒ 不再存在"标的域说没有、持仓说有"的自相矛盾；
- 消除「派生关系漏维护 ⇒ 功能静默失效」这一整类结构性风险。

**负面 / 代价**

- 「持仓」从"关系行"变成"事实计算" ⇒ 每次解析要扫该用户全部交易（实测 **8ms**，可接受）；
- `user_asset_rel` 的 `hold` 行在**信号域**不再被使用；`exDividendSync`（17:03）仍会读它，
  但**已有 `user_trade_record` 兜底** ⇒ 不受影响（见 §6 与 I-39）；
- 除权导入链路的**两处已知遗留**（`transfer` 不计入分红基数 / 券商补录的跨文件重复行）与本决策无关，登记在 I-39。

## 4. 备选方案与否决理由

| 方案 | 否决理由 |
|---|---|
| **A. 保持读派生关系，只在券商导入后补 `syncHoldRelation`** | 能修今天的现象，但「每条写入路径都必须记得维护派生表」的结构性风险保留；未来新增写入路径（批量导入、纸面账户、V2 云函数）会再犯一次同样的静默失效 |
| **B. 信号域改为「自选 ∪ 持仓事实计算」**（本决策） | 口径与 `/api/positions` 同源；无派生状态；实测成本 8ms |
| **C. 连除权导入一起改口径** | 本轮**否决**：除权导入链路的持有人来源与防重逻辑**本来就不依赖 `hold` 派生关系**（`user_asset_rel` 为空时回落 `user_trade_record`，`exDividendSync.ts:207-220`；且有 ±3 天「手动优先」预检 `:149-193`，均为 PR #92 / `9dc4626` 落地）⇒ 它**不受本决策影响**、也**不存在本决策担心的重复插入风险**；它另有两处独立遗留（I-39），与本决策的风险面耦合没有收益 |
| **D. 新建 `user_holding` 持仓缓存表** | MVP 明确不持久化持仓表（`positionCalculator.ts:12`「后续性能不够再加」）；本次实测 8ms，无性能理由新增派生状态 |

## 5. 验证

- **单测** `apps/backend/tests/unit/t85b-signal-scope.test.ts`（12 用例）：
  自选计入 / 交易流水持仓计入 / **`hold` 派生关系不再计入** / 生产事故回归（只有券商导入持仓、无关联行 ⇒ 域非空） /
  清仓不计入 / core 口径（分红不加股数，送股转增加股数）/ 软删排除 / 候选池排除 / 现金类排除 / 空域 /
  插件标的域注入（信号不越界）/ `stats.total` 口径。
- **生产实测**（部署后）：17:02 段 `信号生成完成: signals=N inserted=M`（N>0）。
- **性能实测**（本地同款 1.24GB 行情库，生产同一份文件）：
  `calcAllPositions(1)` **8ms**；`batchGetDailyRange(41, 120d)` **2.45s**；
  `batchGetLatestClose(41)` **0.57s** ⇒ 17:02 段总耗时仍在 cron 窗口内。

## 6. 后续（不在本次范围）

1. **I-39**：除权导入链路的**两个已知遗留**（与本决策无关）：
   ① `getHoldingBeforeDate` 不把 `transfer` 计入分红基数（core 口径里 `transfer → +n`；owner 2026-11-06 裁决「另案处理」）；
   ② 券商补录路径的「同日同标的同类型」跨文件重复（实例：`sh515070 / 2026-07-03` 两条 `bonus` 各 100 股 ⇒ 净持仓多算 100 股）。

   > ⚠️ **2026-11-13 订正**：本节初版写「除权路径生产失效 / 会重复插入 bonus」—— **不成立**。
   > 持有人兜底（`:207-220`）与 ±3 天「手动优先」预检（`:149-193`）均由 PR #92（`9dc4626`，2026-11-06）落地；
   > 生产 2026-11-12 实测 `除权导入完成: events=6 imported=0 skipped=0 errors=0` ⇒ 链路正常工作。
2. **生产 `asset_class` 0 行** ⇒ 现金类排除当前不生效（`ASSET_CLASS_SYNC_MODE` 默认 `dry-run`）；
   是否切到 `execute` 属配置决策，另议。
