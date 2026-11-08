# F4 策略有效性六项 —— 统计口径与数据可行性方案（定稿，口径已拍板）

> 状态：**口径已拍板（2026-11-08）**；本文件定稿并报评审，**未写业务代码、未开 PR**。评审通过后按 §7 实施。
> 范围：PRD_v3 §4.3 / `INV-S5-1~8` / SDD_v3 §9.6；六项 = 扣费、基准、胜率、分组下钻、CSV 导出、采纳率
> 取证时间：**2026-11-08**；本地行情库最新交易日 **2026-11-06**
> 层归属：本篇属证据与选项（`docs/audit/`），**不是契约**；最终 API 字段须并入 `docs/client/SDD_v3.md` §9.6，业务口径以 `InvestAssistantV3_NewRequirements.md` §3.4/§5 为准
> 取证方式：只读查询本地 `data/quotes.duckdb`、`data/business.db`、`data/backtest.db` + 读源码；未启动后端、未写库

---

## 0. 拍板结果（2026-11-08，不再回头问）

| 决策 | 拍板结论 | 落地要点 |
|---|---|---|
| **D1 费率来源** | **扩展 `TradeRules` 补印花税 + 过户费，回测与纸面账户共用同一套** | `stampDutyRate` 仅卖出计；`transferFeeRate` 买卖双边计；老规则缺省 0/0 以保持 ETF 现状不变 |
| **D1 附：`user_fee_config`** | **本轮不接** | 理由：表只有 DDL、**0 行数据**、全仓无读取调用；且 `asset_class` 仅 `risk/cash`，**分不出股票/ETF**。写入本篇留档，后续如接入需先扩枚举与 CRUD |
| **D3 默认基准** | **保持 `sh510300`** | 回测/纸面/评估三处默认一致；plugin→benchmark 映射**留 P1**，本期不做 |
| **D4 基准价格口径** | **只用库里现有价格序列，不构造全收益** | ETF 用前复权价，指数用原始收盘；不额外合成「全收益指数」 |
| **D8 采纳率分母** | **已处理 = 采纳 + 忽略** | 同时修 `adopted`/`ignored` **互斥**，并新增 `ignored_at` |

**默认值清单**（D2、D5–D10）见 **§6.2**，每条都标注「默认取值」，便于以后单独修改。

> ⚠️ **现实约束（必须贯穿文档与接口说明）**：业务库当前只有 **3 条信号**，且只覆盖 **1 只持仓标的**。因此：
> 1. 任何基于这 3 条的「采纳率 / 胜率」结论**一律不得出现在文档、接口说明、页面文案里**；
> 2. 验证只用**回测数据**或**自造测试数据**；
> 3. 接口必须返回 `sampleSize` 与 `insufficientSample=true`，前端不显示百分比、只显示「样本不足（N 条）」。

---

## 1. 六项完成度与五条判断

### 1.1 六项完成度

| 项 | 现状 | 判断 |
|---|---|---|
| 扣费 | 回测/纸面**已扣佣金+滑点**；无印花税/过户费字段；业务费率表有 DDL 无实现 | **部分**，股票信号会低估成本；本方案将补齐 |
| 基准 | 回测/纸面有基准序列与 `benchmarkStale` 处理；有效性页/接口**无基准** | **缺**（数据有、契约无） |
| 胜率 | 回测有「按笔」净胜率；单信号 T+1/T+5/T+10 有端点；**无聚合胜率/超额胜率** | **部分** |
| 分组下钻 | 行业 L1、市值字段**均已落地**（股票域）；信号无参数快照 | **部分** |
| CSV 导出 | I8 有可复用的 CSV 写法（BOM+CRLF），但**无有效性导出** | **缺** |
| 采纳率 | `adopted`/`ignored` 布尔 + `linked_trade_id` 已有；**无 `trade_status` 四态列**，无 `ignored_at` | **部分**，本方案将修 |

### 1.2 五条判断（均已取证）

1. **扣费**：回测收益**扣了**——佣金（含最低 5 元）与滑点都已进现金/已实现盈亏（[portfolio.ts:183-222](file:///d:/workspace/InvestAssistantMVP/apps/backend/src/services/backtest/account/portfolio.ts#L183-L222)、[movingWeightedCost.ts:100-170](file:///d:/workspace/InvestAssistantMVP/packages/core/src/movingWeightedCost.ts#L100-L170)）；修复前 `TradeRules` **没有印花税/过户费字段**，纸面账户也**显式拒绝**非 0 值。⇒ **ETF 口径正确，股票口径不完整**；**F4 Step A 已补齐（2026-11-08，见 §7.1 实施记录）**。
2. **基准**：库里**同时有指数与 ETF 序列**（hs300/hs905/hs852/hs016/hs001、510300/510500/512760 等），数据能做「每策略配指数」；**但插件契约没有 `benchmark` 字段**（[pluginEngine.ts:218-250](file:///d:/workspace/InvestAssistantMVP/apps/backend/src/services/pluginEngine.ts#L218-L250)）。⇒ 本期**统一默认 `sh510300`**，映射表 P1。
3. **胜率**：三种口径**实测就不同**——同数据同参数的可复现 A/B（400 回合）：按笔 **48.75%**、按成本金额加权 **49.52%**（差 0.77pp）；按持仓周期分桶 **46.02% → 70.00%**（跨度 24pp）。信号侧：同一信号 T+5 绝对 **-0.71%**，基准 **-3.11%**（绝对亏、超额赢）。⇒ **主口径定为「按信号 × 多周期 × 超额胜率」**，绝对胜率并列，按笔作辅助。**（历史快照 514 回合 / 52.33% 已不可复现，见 §3.3 说明，不作依据。）**
4. **分组下钻**：**行业和市值字段都有**（股票域），不需要退到「强度+标的类型」；但 **ETF 无市值、行业仅 313 条成员记录**，ETF 域归「未分类」。行业表**只有当前快照、无历史版本**（无 `date` 列）→ 历史评估存在轻微前视偏差（接受，见 §6.2 D10）。
5. **采纳率**：**不存在 `trade_status` 四态列**。实际是 `adopted` + `ignored` 两个布尔 + `linked_trade_id`。两个 PATCH **不互斥**（可同时为 1），无 `ignored_at`。⇒ 「未处理」用 `adopted=0 AND ignored=0` 派生；分母按拍板取「已处理」。

---

## 2. 取证边界与库现状

| 事实 | 实测值 | 影响 |
|---|---|---|
| 业务库信号行数 | **3 条**（2026-10-15 / 10-22 / 11-04，均为 `sh510760`；`rsi_oversold`×2、`macd_cross`×1；`origin='replay'`） | **无法产出有统计意义的胜率/采纳率** |
| 采纳/忽略/关联 | 3 条全部 `adopted=0, ignored=0, linked_trade_id=NULL` | 采纳率无真实样本 |
| `grade` / `expires_at` | 3 条全部 `NULL` | 按强度分档下钻当前无有效数据 |
| `strength` | 0.015 / 0.00067 / 0.00447（量级很小） | F1 按当日**分位**定档（非绝对阈值），故量级不影响定档 |
| 信号生成标的域 | `user_asset_rel` 仅 **1 条 hold、0 条 watch** | 回放出来的信号只覆盖 1 只标的，策略维度退化 |
| 业务库 schema | `user_strategy_signal` **缺 `sub_category`**（代码已有，`configStore.ts:184` 与 `:513-514`） | 当前库未按最新代码启动/迁移；实施前先启动一次完成幂等 ALTER |
| 行情库 | `raw_kline_daily` **30,022,640 行**，最新 2026-11-06；`v_stock_qfq` 6168 只、`v_etf_qfq` 2944 只 | 后续行情够用 |
| 回测库 | 仅 `bt_*` 表，**无 `paper_*` 表**（`data/backtest.db`） | 「纸面费率快照」是代码能力，不是现有数据 |

> 结论：F4 的第一个阻塞不是代码，而是**样本与口径**。口径已定；样本仍必须靠回放/合成补。

---

## 3. 逐项：现在有什么、缺什么

### 3.1 扣费

**已有**

| 能力 | 位置 | 实测/要点 |
|---|---|---|
| 费用规则 | `backtest/execution/simulator.ts:23-45` | `commissionRate 0.0001`、`minCommission 5`、`slippageRate 0.0001`、`lotSize 100`、`minNotional 10`、`priceLimit 0.1` |
| 佣金计算 | 同文件 `:158-159, :274` | `max(minCommission, notional × rate)`，买卖双边 |
| 成本入账 | `account/portfolio.ts:183-222` | 买入 `cash -= qty×price + fee`；卖出 `cash += qty×price - fee` |
| 净盈亏 | `packages/core/src/movingWeightedCost.ts:100-170` | 买入费用计入成本基、卖出费用从收入扣除 ⇒ `realizedPnL` 为**净额** |
| 分层费率回退 | `paper/fees.ts:70-83, :150-184` | `账户显式 → 用户最早一条 → 系统默认 → 内置默认`；建户冻结 `fee_snapshot_json` |
| 回测规则留痕 | `bt_run.rules_json` | 实测唯一一次回测：0.0001 / 5 / 0.0001（无印花税/过户费） |

**缺 / 不一致（本方案处置）**

| 缺口 | 证据 | 本方案处置 |
|---|---|---|
| 无印花税/过户费字段 | `TradeRules` 仅 6 个字段；`paper/fees.ts:121-137` 直接拒绝 | **扩展字段并接入回测+纸面**（D1 已拍板） |
| 业务费率表空壳 | `user_fee_config` 仅 DDL+索引，**0 行**，无读取调用 | **本轮不接**，理由留档 |
| 费率表分不出股票/ETF | `user_fee_config.asset_class` 仅 `risk/cash`（`configStore.ts:217`） | 同上；改用 `TradeRules` + 品种预设 |
| 三套口径并存 | 回测/纸面 ETF 口径 vs 业务默认 vs 实际成交 `fee` | 评估页固定展示「口径脚注」；不混算 |

**已拍板的费率口径**

- `stampDutyRate`：**仅卖出**按成交额计。
- `transferFeeRate`：**买卖双边**按成交额计。
- 佣金仍为 `max(minCommission, notional × commissionRate)`，双边各计一次。
- 老规则与新账户缺省 `stampDutyRate=0, transferFeeRate=0` ⇒ **ETF 行为与现状逐位一致**。
- 股票预设（评估层按品种选择）：`stampDutyRate=0.001`、`transferFeeRate=0.00002`（来源：`user_fee_config` DDL 默认值，仅作预设常量）。

### 3.2 基准

**已有**

| 能力 | 位置/实测 |
|---|---|
| 逐日基准收盘 + 缺失标记 | 回测 `metrics.ts:22-29, :246-260`：`benchmarkClose`、`benchmarkStale`，缺失沿用上一有效收盘并标记 |
| 基准注入 | `engine.ts:637-648, :682`；CLI 默认 **`sh510300`**（`cli.ts:448-471`） |
| 纸面账户基准 | `backtest/store/paperSchema.ts:89`：`benchmark_asset_code DEFAULT 'sh510300'`；净值表有 `benchmark_close`/`benchmark_stale` |
| 行情可用性 | `sh000300` 5304 根（2005 起）、`sh000905` 5304、`sh000852` 5304、`sh000016` 5547、`sh000001` 8758；`sh510300` 3510（2012 起）、`sh510500` 3314、`sh512760` 1797 |
| 行业指数 | `sh881%` 系列 **468 只**，可作行业基准（本期不下钻到行业基准） |

**缺**

- `/api/strategy/effectiveness` 无基准参数；SDD §9.6 只写端点名与实现约束，无字段级 schema。
- 插件无 `benchmark` 字段 ⇒ 无法按策略自动选指数（**P1**）。
- 计划已登记 **Q5「策略评估的基准标的，待定」**（`code_implementation_plan_v3.md:305`）；本次拍板为 **默认 `sh510300`**。

**已拍板**：默认 `sh510300`；指数/ETF 一律用**库里现有价格序列**（ETF 前复权、指数原始收盘），**不构造全收益**；plugin→benchmark 映射留 P1。

### 3.3 胜率

**已有**

- 回测「按笔」净胜率：`metrics.ts:274-279`；`averageHoldingDays` 同段。
- 单信号后续表现：`GET /api/strategy/signals/:id/outcome`（[strategy.ts:159-209](file:///d:/workspace/InvestAssistantMVP/apps/backend/src/routes/strategy.ts#L159-L209)），返回 T+1/T+5/T+10。
- 前端可逐条打开后续表现（`StrategyEffectiveness.tsx:66-77, :159-192`）。

**缺**

- 无聚合胜率、平均收益、最大回撤、超额收益。
- 现有 `outcome` 用**信号日收盘**作基准价，且用 `raw_kline_daily` 未复权收盘；不是可成交价、除权日会跳变。
- 无「窗未满/停牌/涨跌停」样本状态。

**实测差异（同一批数据，三种口径）**

| 口径 | 历史快照（`bt_run 28574a45`，514 回合，**不可复现**） | 可复现 A/B（当前行情库 + 当前代码，400 回合，2026-11-08 复跑） |
|---|---|---|
| 按笔（等权） | 52.33% | **48.75%** |
| 按金额加权（成本口径） | 49.75% | **49.52%**（差 -0.77pp） |
| 持仓 0–1 天 | 48.95% | **47.47%**（n=198） |
| 持仓 2–3 天 | 49.29% | **46.02%**（n=113） |
| 持仓 4–10 天 | 58.47% | **53.16%**（n=79） |
| 持仓 >10 天 | 82.35% | **70.00%**（n=10，跨度 24pp） |

> ⚠️ **左列是历史快照，不是可复算结果**：存储基线 514 回合 / 52.33%；用**当前行情库 + 改动前代码**重跑同参数只得 **400 回合 / 48.75%**。
> 差异成因**初步判断为代码漂移**（依据：行情库 `quotes.duckdb` 修改时间 2026-11-06 21:51 **早于**该基线运行时刻 21:59，数据未变；而 11-07 连续合入 3 个回测口径提交 `#106`（preclose 缺失 + 短期风控边界对齐 v5.2）/ `#111`（divisor/topN 移出策略参数、holdingsNum 上限推导）/ `#113`（第二批口径对齐 + 扩窗默认关闭））。
> 故**一切百分比论证只用右列（可复现 A/B）**；左列仅作「历史快照」记录，不再作为结论依据。

结论仍然成立：**同口径胜负在三种算法下确实不同** —— 右列「按笔 48.75% vs 成本加权 49.52%」相差 0.77pp；周期分桶 46.02%→70.00%（跨度 24pp）⇒ 报胜率必须同时声明算法与分组，否则不可比。

信号侧（现有 3 条，仅作口径演示，**不足以下结论**）：

| 信号 | 基准价 | T+1 | T+5 | T+10 | 基准 T+5 | 超额 T+5 |
|---|---|---|---|---|---|---|
| #1 2026-10-15 | 1.276 | +0.24% | **-0.71%** | -0.31% | -3.11% | **+2.40pp** |
| #2 2026-10-22 | 1.267 | +0.87% | +0.40% | +1.42% | +1.18% | **-0.78pp** |
| #3 2026-11-04 | 1.285 | 0.00% | 窗未满 | 窗未满 | 窗未满 | — |

⇒ 同一批信号：绝对胜率 #1 输、超额胜率 #1 赢；#2 相反。**定为主口径「按信号 × 多周期 × 超额胜率」**，绝对胜率并列展示。

### 3.4 分组下钻

**已有（实测）**

| 维度 | 是否在库 | 实测 |
|---|---|---|
| 行业（股票） | ✅ | `raw_tdx_blocks_info` 926 板块、`raw_tdx_blocks_member` 90,988 行；`block_type='tdx_research' AND block_level=1` → **5581 只股票 1:1**；样例：机械设备 647、电子 550、医药医疗 512 |
| 行业指数序列 | ✅ | `sh881%` 468 只，2004 年起 |
| 市值（股票） | ✅ | `raw_basic_daily.totalmv/floatmv`；`totalmv>0` 共 **5941 只**；近期每日约 7752 行有值；1990-12-19 起 |
| 标的类型 | ✅ | `raw_symbol_class."class"`：`stock 6168 / etf 2944 / index 801 / block 1128 / bstock 166 / unknown 4718` |
| 强度等级 | ✅ | `grade ∈ {strong, medium, weak}` + `expires_at`（按当日 `strength` 降序**分位**定档；强3/中2/弱1 交易日，[signalService.ts:387-438](file:///d:/workspace/InvestAssistantMVP/apps/backend/src/services/signalService.ts#L387-L438)） |
| 参数 | ❌ | 只存 `metrics_json`（部分参数）；`snapshot_json` 列存在但**全仓无写入** |

**缺 / 注意**

- **ETF 市值缺失**：`raw_basic_daily` 中 ETF 的 `totalmv/floatmv` 实测为 **0**（如 sh510300）⇒ 归「未分类」。
- **ETF 行业只覆盖一部分**：research 板块成员中 ETF 相关记录仅 **313 条**（按 `sh51/sz15/sz16` 前缀近似）⇒ 归「未分类」。
- **行业是当前快照**：`raw_tdx_blocks_info` **无日期列**，历史评估有轻微前视偏差（接受，D10）。
- 你的备选「退到强度+标的类型」**不必要**：股票域行业+市值可用；要退的是 **ETF 域**。

### 3.5 CSV 导出

**已有（可复用写法，不是可复用函数）**

- `GET /api/broker-reconcile/diff/export`（[brokerReconcile.ts:111-142](file:///d:/workspace/InvestAssistantMVP/apps/backend/src/routes/brokerReconcile.ts#L111-L142)）：`text/csv; charset=utf-8`、文件名白名单 + 日期戳。
- `buildDiffCsv`（同文件 `:240-258`）：**UTF-8 BOM + CRLF**。
- ⚠️ 私有函数、无公共 CSV 工具；F4 应抄这三个约定，**不重构券商对账代码**。

**缺**：有效性页无导出按钮、无导出端点。

### 3.6 采纳率

**已有**

| 能力 | 位置 | 要点 |
|---|---|---|
| 采纳 | `PATCH /api/signal/:id/adopt`（[signal.ts:349-362](file:///d:/workspace/InvestAssistantMVP/apps/backend/src/routes/signal.ts#L349-L362)） | 置 `adopted=1, adopted_at=now` |
| 忽略 | `PATCH /api/signal/:id/ignore`（`:364-374`） | 置 `ignored=1`（**不写时间**） |
| 信号↔成交关联 | `PATCH /api/signal/:id/link-trade`（`:375-409`） | 仅同 `asset_code`；手动，不自动关联 |
| 过期 | `expires_at` | 过期只置灰不删除（F1） |

**必须纠正的前提**

- **不存在 `trade_status` 四态列**。实测列为 `adopted`、`ignored`、`adopted_at`、`cooldown_until`、`linked_trade_id`、`origin`；四态只能派生。
- **两个标记可同时为 1**（两个 PATCH 只置自己那一列）⇒ **本方案修复为互斥**。
- **无 `ignored_at`** ⇒ **本方案新增**。
- 实测 3 条信号全为未处理，采纳率无真实样本。

---

## 4. 统计口径（定稿）

### 4.1 通用评估单元与时间窗

| 项 | 口径 | 理由 |
|---|---|---|
| 评估单元 | `direction='buy'`、`is_final=1`、`is_deleted=0`、`sub_category <> 'risk'` 的信号 | 风险提示不是交易建议 |
| 来源 | `origin IN ('live','replay')` 计入，可按 `origin` 过滤 | 回放补历史是唯一补数路径 |
| 时间窗 | `trade_date ∈ [from, to]`；每个周期各自判定是否走完 | 窗未满不能算 0 收益 |
| 周期 | T+1 / T+5 / T+10（交易日），主展示 T+5 | 与 `INV-S5-3` 一致 |
| 入场 | **信号日后第一个可成交交易日的开盘价**（默认 D5） | `INV-S5-5` 可成交价 |
| 出场 | 第 N 个交易日收盘；停牌顺延到下一有效 bar | 避免无成交日造假 0 |
| 复权 | 个股/ETF 用 `v_stock_qfq` / `v_etf_qfq`；指数用 `raw_kline_daily` 原始收盘 | 除权跳变不能算收益 |
| 样本状态 | `ok / incomplete / suspended / no_entry / excluded`，均计数 | 分母可审计 |
| 样本门槛 | `sampleSize < 20` → `insufficientSample=true`，不展示百分比 | 防止 3 条信号产结论 |

### 4.2 边界情况

| 情况 | 处理 |
|---|---|
| 无后续 bar（次日起停牌/退市） | `no_entry`，**剔出分母**，单独计数 |
| 窗内停牌 | 出场顺延到下一有效 bar；超出数据末端 → `incomplete` |
| 窗未满（如 11-04 的 T+5） | `incomplete`，**不进分母**；页脚显示「未满窗 N 条」 |
| 除权除息 | 用前复权序列；分红不单算（qfq 已内含） |
| 次日开盘涨停无法买入 | 顺延到可成交日；仍不可成交 → `excluded` |
| 同标的同日同插件 | 唯一键 `(user, asset, plugin, trade_date)` 已去重（[pluginEngine.ts:1482](file:///d:/workspace/InvestAssistantMVP/apps/backend/src/services/pluginEngine.ts#L1482)） |
| 同标的连续多日信号 | 按条独立计；「按信号簇（首次触发）」仅作参考视图 |
| 停牌/ST/北交所 | 标的类型分组即可；ST 无可靠历史字段，先不细分 |

### 4.3 扣费（定稿）

**净收益 = （卖出净额 / 买入总支出）− 1**

- 买入总支出 = `名义本金 × (1 + 滑点率) + 佣金 + 过户费`，佣金 = `max(最低佣金, 名义本金 × 佣金率)`
- 卖出净额 = `名义本金 × (1 + 毛收益率) × (1 − 滑点率) − 佣金 − 过户费 − 印花税`
- 印花税**仅卖出**；过户费**双边**；最低佣金**双边各计一次**；ETF 印花税/过户费 = 0。

**信号无金额时的默认（D2）**：名义本金默认 **50,000 元**（可配置）；若 `linked_trade_id` 命中实际成交，则优先用实际金额与该笔 `fee` 校准（本期先做名义本金，实际金额兜底留接口位）。

### 4.4 基准（定稿）

- 默认 `sh510300`；ETF 用前复权、指数用原始收盘；**不构造全收益**。
- 基准收益 = 同区间、同周期、同一交易日序列的净值变化。
- 超额收益 = `(1 + 净收益) / (1 + 基准收益) − 1`（几何）。
- 基准 bar 缺失沿用上一有效收盘并标记 `benchmark_stale`（与 `metrics.ts:246-260` 同思路）。

### 4.5 胜率（定稿）

| 口径 | 定义 | 定位 |
|---|---|---|
| **按信号 × 周期（超额）** | `超额收益>0 / 完整样本数`，T+1/T+5/T+10 各一份 | **主口径** |
| 按信号 × 周期（绝对） | `净收益>0 / 完整样本数` | 并列展示 |
| 按笔（成交回合） | 已平仓 `pnl>0 / 已平仓数`，仅限 `linked_trade_id` 命中 | 辅助/印证 |
| 按持仓周期分组 | 实际持仓天数分桶（0–1/2–3/4–10/>10） | 下钻子项 |

> 不把「按笔」当主口径：它剔除未平仓、金额隐式加权、部分卖出拆多回合。实测同数据差 2.6pp，持仓周期分桶差 33pp。

### 4.6 采纳率（定稿）

| 指标 | 分子 | 分母 | 说明 |
|---|---|---|---|
| **采纳率（主）** | `adopted=1` | `adopted=1 + ignored=1`（**已处理**） | 满足「没看的不能算没采纳」 |
| 覆盖率 | `adopted=1 + ignored=1` | 区间内全部合格信号 | 反映用户是否在看 |
| 未处理数 | `adopted=0 AND ignored=0` | — | 单独计数，不参与主采纳率 |
| 强信号采纳率 | 强档 `adopted=1` | 强档已处理 | 附列；不单独作唯一分母 |
| 执行率（补充） | `linked_trade_id IS NOT NULL` | 区间内全部合格信号 | 「标注采纳」≠「真成交」 |
| 冲突状态 | `adopted=1 AND ignored=1` | — | 修复后应为 0；保留计数以便体检 |

过期信号仍计入全部分母，但在「未处理」中单列「已过期未处理」。

**互斥修复口径（D8 已拍板）**

- 采纳：`SET adopted=1, adopted_at=now, ignored=0, ignored_at=NULL`
- 忽略：`SET ignored=1, ignored_at=now, adopted=0, adopted_at=NULL`
- 新增列 `ignored_at TEXT`（幂等 `ALTER`）。
- 对存量「双 1」脏行一次性归一到「采纳优先」：`SET ignored=0, ignored_at=NULL`（只动采纳/忽略两列）。

### 4.7 CSV（定稿）

- 两种粒度：`summary` 与 `detail`；默认 `detail`。
- UTF-8 **BOM + CRLF**；文件名带区间与生成时间；沿用 I8 白名单。

---

## 5. 数据可行性与补齐成本

| 数据项 | 在库？ | 证据 | 补齐 / 成本 |
|---|---|---|---|
| 历史信号 | ⚠️ 仅 3 条 | 业务库实测 | `POST /api/admin/signal-replay`，单次 ≤250 交易日（[signalReplay.ts:38-41](file:///d:/workspace/InvestAssistantMVP/apps/backend/src/services/signalReplay.ts#L38-L41)）；**S** |
| 评估标的域 | ⚠️ 仅 1 只 hold | `user_asset_rel` 实测 | 回放支持显式 `symbols`；**S（运维）** |
| 后续行情 | ✅ | 3002 万行至 2026-11-06 | 0 |
| 前复权序列 | ✅ | `v_stock_qfq` 6168 / `v_etf_qfq` 2944 | 0 |
| 基准序列 | ✅ | 5 宽基 + 3 ETF + 468 行业指数 | 0 |
| 行业（股票） | ✅ | 926 板块 / 90,988 成员 / 5581 只 L1 | 0；无历史版本 |
| 市值（股票） | ✅ | 5941 只 `totalmv>0`，日频 | 0；ETF 为 0 |
| 标的类型 | ✅ | `raw_symbol_class` | 0 |
| 信号参数快照 | ❌ | `snapshot_json` 无写入 | 按 D9 **本期不做** |
| 采纳/忽略时间 | ❌ | 无 `ignored_at` | `ALTER` + 互斥修复；**S** |
| 成交费用 | ⚠️ | `user_trade_record.fee` 有值，310 条、关联 0 | 名义本金兜底 |
| 费率配置 | ⚠️ | `user_fee_config` 空壳；`paper_fee_config` 当前库无表 | 扩展 `TradeRules` |

**结论**：**不需要新采集数据**（行业/市值采集已落地：90,988 行成员、5941 只有市值）。要补的是**历史样本**、**费率字段**、**两个采纳小字段**。

---

## 6. 决策与默认值清单

### 6.1 已拍板（不再问）

| ID | 决策 | 结论 |
|---|---|---|
| D1 | 费率来源 | 扩展 `TradeRules`（`stampDutyRate` 卖出、`transferFeeRate` 双边），回测+纸面共用；`user_fee_config` 本轮不接 |
| D3 | 默认基准 / 策略映射 | 默认 `sh510300`；plugin→benchmark 映射 P1 |
| D4 | 基准价格口径 | 库里现有价格序列，不构造全收益 |
| D8 | 采纳率分母 / 互斥 | 已处理口径；修互斥；补 `ignored_at` |

### 6.2 默认取值（由实施方按最小风险取，后续可改）

| ID | 决策 | **默认取值** | 理由 / 改动成本 |
|---|---|---|---|
| D2 | 无成交金额时的名义本金 | **50,000 元**（可配置） | 让最低佣金 5 元的占比降到可忽略量级（50,000 元单边 = 0.01%）；**若改为 10,000 元，最低佣金 5 元将占到单边 0.05%**，显著压低短线策略收益，故不取 1 万 |
| D5 | 入场价 | **次日开盘**（首个可成交日） | 符合 `INV-S5-5`；比信号日收盘更可复现 |
| D6 | 持有期 | **固定 T+N 主口径**；到期口径暂不做 | 强/中/弱可比；到期口径会引入额外规则，P1 |
| D7 | 评估标的域 | **signal 表内全部合格信号**（不额外按自选/持仓过滤） | 不改信号生成链路；补样本时用回放显式 `symbols` |
| D9 | 参数下钻 | **延后**（本期不写 `snapshot_json`） | 避免改信号写入链路；入场价由行情库现算，不依赖快照 |
| D10 | 行业快照偏差 | **接受当前行业**，页面注明 | tdx2db 不提供历史行业，另建表成本高 |

### 6.3 明确延后（P1）

- plugin→benchmark 映射表 / 插件加 `benchmark` 字段。
- 「按参数下钻」与 `snapshot_json` 写入。
- 历史行业归属表、ETF 行业/市值映射。
- 「到期即视为平仓」的第二套持有期口径。
- `user_fee_config` 接入（需先解决 0 数据与 `asset_class` 枚举）。

---

## 7. 实施顺序与范围（评审通过后执行）

### 7.1 Step A —— 扣费口径补齐（可独立验证）

1. `TradeRules` 增 `stampDutyRate`、`transferFeeRate`（可选，缺省 0）。
2. `simulator` 计费：买入 = 佣金 + 过户费；卖出 = 佣金 + 过户费 + 印花税；`bt_run.rules_json` 落新字段。
3. `paper`：移除「非 0 印花税/过户费」拒绝；买卖按上述口径计费；旧 `fee_snapshot_json` 缺字段按 0 处理（向后兼容）。
4. CLI 增 `--stamp-duty-rate` / `--transfer-fee-rate`，默认 0。
5. 验证：ETF 规则（0/0）回归**逐位不变**；股票规则单测覆盖「印花税仅卖出、过户费双边、最低佣金双边」。

**实施记录（2026-11-08，已完成）**

| 项 | 结果 |
|---|---|
| 代码 | `simulator.ts`（`TradeRules` 增两字段 + `DEFAULT_TRADE_RULES` 0/0 + `buyFeeOf/sellFeeOf`）、`paper/fees.ts`（移除拒绝、旧快照 `?? 0`）、`paperSchema.ts`（列注释）、`cli.ts`（两参数 + 校验 0~0.1） |
| 单测 / 集成 | `backtest-m2-execution` / `paper-fees` / `paper-api` 合计 **50 passed**；`npm run typecheck -w @invest/backend` 通过 |
| **逐位回归** | 同数据同参数跑「改动前代码」与「改动后代码（0/0）」：`bt_trade 801` / `bt_round_trip 400` / `bt_metric 25` / `bt_equity 727` / `bt_attribution 48` / `bt_skipped 5` **全部逐位一致**；`bt_run.rules_json` 仅多出 `stampDutyRate:0, transferFeeRate:0`（预期） |
| **514 基线不可复现** | 存储基线 `28574a45`：514 回合 / 期末 319,537.75 / 胜率 52.33%；**用改动前代码 + 当前行情库**重跑同参数：400 回合 / 296,278.13 / 48.75% ⇒ 差异来自行情库或代码漂移，**与 Step A 无关**；故验收改用「同数据 A/B 逐位对比」而非「对齐历史 514 基线」 |
| **非 0 费率生效** | `2024-01-02~2024-06-28` 同参：`fees` 1,761.49 → 10,472.24（≈5.9×），累计 51.44% → 40.97%，回合数不变（69） |

### 7.2 Step B —— 统计接口（主口径：按信号 × 多周期 × 超额）

1. 新增聚合服务（批量 `IN` 取价，禁止逐信号查询）：业务库取信号 → 行情库批量取前复权价/指数价 → 费用 → 基准 → 多周期 → 分组。
2. `GET /api/strategy/effectiveness`：`from/to/plugin_id/benchmark/horizon/group_by/origin/notional`；返回 `meta`（`sampleSize`、`insufficientSample`、**`fees`**、`benchmark`、状态计数）+ `summary[]` + `groups[]`。
   **`meta.fees` 必须逐项下发实际生效费率**：`commissionRate` / `minCommission` / `stampDutyRate` / `transferFeeRate` / `slippageRate` / `notional`，并附 `feeModelLabel`（如「ETF 口径 0/0」「股票口径 0.001+0.00002」）。理由：真实费率打开后同策略半年 69 回合费用 1,761 → 10,472、收益 51.44% → 40.97%，**是结论级差异**，不标费率则不同结果之间不可比。
3. `GET /api/strategy/effectiveness/export`：`level=summary|detail`，BOM+CRLF；**CSV 每行都带费率列**（或首部元信息行，二者至少一个），文件名/说明里写明口径标签。
4. 前端：筛选栏、汇总表、下钻 tab、导出按钮、口径脚注；**页面必须常显「本次结果基于 X 口径（费率 a/b/c/d/e）」**；`insufficientSample` 时**只显示样本数，不显示百分比**。

**实施记录（2026-11-08，Step B 已完成，PR 基于 Step A 分支，未合并）**

| 项 | 落地结果 |
|---|---|
| 服务 | `services/strategyEffectiveness.ts`：纯计算（`evaluateSignal` / `summarizeHorizon` / `buildReport`）+ 装载（业务库信号筛选 + 行情库**按品种视图族批量 IN**）+ CSV 生成 |
| 接口 | `GET /api/strategy/effectiveness`、`GET /api/strategy/effectiveness/export`（`level=summary|detail`），鉴权同 T135；参数非法一律 400 |
| 费率元信息 | `meta.fees`（五项 + 名义本金）+ `meta.feeModelLabel` + `meta.feeModels[]`；**每行明细/每组汇总均带 `fees` 与 `feeModelLabel`**；CSV 每行同样带费率列 |
| 样本门槛 | `sampleSize < 20` ⇒ `insufficientSample=true`，接口与 CSV **一并清空**胜率/均值（只留样本数与状态计数）；前端显示「样本不足（N 条）」 |
| 统计口径 | 入场 = 信号日后首个可成交开盘（停牌/开盘涨停顺延）；出场 = 第 N 个交易日收盘（停牌顺延）；个股/ETF 前复权、指数原始收盘；超额 = `(1+净)/(1+基准)−1` |
| 费率口径 | ETF 0/0 与股票 `0.001 / 0.00002` 按 `raw_symbol_class` 自动选择；混品种时 `meta.feeModels` 列出各项，明细逐条标注 |
| 测试 | 单测 `tests/unit/strategy-effectiveness.test.ts` **13 passed**（多周期/停牌/窗未满/涨停/基准 stale/超额/样本门槛/CSV）；集成 `tests/integration/strategyEffectiveness.test.ts` **4 passed**（401/400/21 条合成信号/导出）；`typecheck`（backend + frontend）通过 |
| 前端 | 策略有效性页新增筛选栏 + 汇总表 + 分组下钻 + 导出按钮 + **常显口径脚注**；样本不足只显示 N |
| 未做（按约定） | 不改 F1 分级 / 风险过滤 / Top5 / 候选集；不碰 `pluginEngine.ts` / `routes/signal.ts` / `signalService.ts` / `SDD.md`；`plugin→benchmark` 映射仍留 P1 |

### 7.3 Step C —— 采纳口径与互斥修复

1. `ALTER TABLE user_strategy_signal ADD COLUMN ignored_at TEXT`（幂等，先 `PRAGMA table_info` 判存在）。
2. 两个 PATCH 改为互斥写入（见 §4.6）。
3. 存量「双 1」归一（采纳优先），只动 `adopted/ignored/adopted_at/ignored_at`。
4. 验证：`adopt → ignore → adopt` 三次切换后 `adopted/ignored` 状态与时间戳唯一正确；`grade/expires_at` 不变；风险过滤/Top5/候选集不受影响。

---

## 8. 与现有 F1/F6、纸面账户的兼容边界

| 约束 | 说明 |
|---|---|
| **不改 F1 分级** | `assignSignalGrades` 只改 `grade/expires_at`；本次互斥修复**只动采纳/忽略四列**，不碰分级函数与候选集 |
| **不改风险过滤** | 不改 `sub_category='risk'` 的生成、过滤、Top5、风险体检（F6）逻辑；评估层仅在查询时排除 risk |
| **纸面账户兼容** | 旧 `fee_snapshot_json` 无新字段 → 按 0；ETF 既有账户行为不变；仅股票/显式配置时新增费用 |
| **回测兼容** | 旧 `bt_run.rules_json` 无新字段 → 按 0 解读；历史结果不受影响 |
| **API 兼容** | 两个 PATCH 返回值新增字段为附加字段；前端不因缺字段而崩 |

---

## 9. 验证策略（无真实数据约束）

### 9.1 约束

- 业务库 **3 条信号**、**1 只持仓标的** ⇒ **不得**把它们当验证样本，更不得把算出的比率写进文档/接口说明/页面文案。
- 验证载体：**回测数据**（当前可复跑的 400 回合 A/B；历史 514 回合快照不可复现，仅存档）或**自造测试数据**（合成信号 + 合成行情）。
- 页面/接口对 `sampleSize < 20` 一律输出 `insufficientSample=true`，前端只显示「样本不足（N 条）」。

### 9.2 测试数据方案

| 层 | 数据 | 断言 |
|---|---|---|
| 单测（纯函数） | 合成 `TradeRules` + 成交 | 印花税仅卖出、过户费双边、最低佣金双边；ETF 0/0 与旧结果逐位一致 |
| 单测（纯函数） | 合成价格序列 | T+1/T+5/T+10 收益、除权（qfq）不跳变、停牌顺延、窗未满 `incomplete` |
| 集成 | 合成 20+ 条信号（多标的、多日、含未处理/已采纳/已忽略/过期） | 采纳率分母=已处理；未处理单列；冲突为 0；`insufficientSample` 阈值 |
| 集成 | 可复现回测 A/B（400 回合，同数据同参数） | 「按笔」48.75% vs 成本加权 49.52%；分桶 47.47/46.02/53.16/70.00%（仅作历史存档对比，历史 514 快照不作回归基线） |
| 回归 | 既有 ETF 回测 | 加字段后 `bt_metric` 各项**逐位不变** |

> CI 行情库是 12KB 空壳：依赖真实行情的用例沿用 `tests/_marketData.ts` 的「探测表存在 → `it.skipIf`」模式；纯函数与合成数据用例必须**不依赖**真实库。

### 9.3 验收口径（本轮）

- Step A：ETF 回归零差异 + 股票费用单测全绿。
- Step B：合成样本下主口径数值与手算逐条一致；`insufficientSample` 生效；接口文档无任何「采纳率 XX%」示例结论。
- Step C：三次切换状态正确、`ignored_at` 有值、分级/风险逻辑零改动（相关既有测试全绿）。

---

## 10. 风险与未验证项

1. **样本不足**：3 条信号、1 只持仓标的。未补样本前不对外展示任何百分比。
2. **T135 标记与实现不符**：计划标 `T135 ✅`，但现有端点无扣费、无基准、入场价用信号日收盘，未满足 `INV-S5-2/4/5`；建议按 §13 偏差登记补一条（本篇不擅自改计划）。
3. **`snapshot_json` 从未写入**：D9 延后，避免动信号写入链路。
4. **行业快照**：无历史版本，历史分组有前视偏差，页面注明。
5. **ETF 行业/市值缺口**：归「未分类」，分组下钻在 ETF 域退化；本期不建映射。
6. **性能**：行情视图实时计算（2800 万行级），必须按标的集合+日期预过滤，禁止逐信号查询。
7. **多用户**：现为单用户（`SIGNAL_USER_ID=1`），评估按用户字段保留但本期不展开。
8. **费率预设常量**：股票预设 0.001/0.00002 来自 `user_fee_config` DDL 默认值，非实测账户费率；如与真实账户不符，需在配置层覆盖（不改代码）。

---

## 11. 待登记（**尚未落入计划文档**，经确认后再落）

> ⚠️ `docs/client/code_implementation_plan_v3.md` 当前有并行 PR 在改（#129 改 T135 标记、#131 改 T131），
> 为避免冲突，本节内容**暂不写入计划文档**；等确认后再按 §13 偏差登记格式落库。以下为待登记原文。

### 11.1 T135 偏差登记（待落 `code_implementation_plan_v3.md` §13）

| 项 | 内容 |
|---|---|
| 关联任务 | T135（策略有效性六项） |
| 现状标记 | 计划标 ✅（#129 拟改为 ⚠️） |
| 偏差事实 | 现有 `GET /api/strategy/effectiveness` 类端点（`routes/strategy.ts` 的 outcome 计算）**无扣费、无基准、入场价用信号日收盘**，不满足 `INV-S5-2`（扣费）、`INV-S5-4`（基准）、`INV-S5-5`（次日开盘入场） |
| 量化证据 | ① 口径差异（**可复现 A/B**，400 回合）：按笔 **48.75%** vs 按成本金额加权 **49.52%**（差 0.77pp）；持仓周期分桶 **46.02% → 70.00%**（跨度 24pp）。② 扣费差异：同策略 2024-01-02~06-28 同参，ETF 0/0 费用 1,761.49 / 累计 51.44%，股票费率（印花税 0.001 + 过户费 0.00002）费用 **10,472.24** / 累计 **40.97%**（差 10pp 以上）。③ 信号侧 T+5 绝对 −0.71% vs 基准 −3.11%（绝对亏、超额赢）⇒ 不做基准与扣费会给出**相反结论** |
| **证据来源与可复现性** | ①的**存储基线** `bt_run 28574a45` 为 514 回合 / 按笔 52.33% / 金额加权 49.75%，但**用当前行情库 + 改动前代码重跑同参数只得 400 回合 / 48.75%** ⇒ 该快照**不可复算**，不得作为结论依据。**成因初步判断为代码漂移**（行情库 `quotes.duckdb` 修改时间 2026-11-06 21:51 早于基线运行 21:59，数据未变；11-07 合入 `#106`/`#111`/`#113` 三个回测口径提交）。故本表一律改用**同数据同参数 A/B**举证 |
| 处置 | 由本方案 Step A（费率字段）/ Step B（多周期 + 超额 + 基准）/ Step C（采纳互斥）补齐；补齐前 T135 不得视为完成 |
| 验收 | Step A：ETF 0/0 与旧结果逐位一致；Step B：主口径「信号 × 多周期 × 超额」数值与手算一致且 `sampleSize<20` 返回 `insufficientSample`；Step C：采纳/忽略互斥且 `ignored_at` 有值 |

### 11.2 数据库迁移偏差（待落 §13）

| 项 | 内容 |
|---|---|
| 事实 | `data/business.db` 的 `user_strategy_signal` 缺 `sub_category` 列（代码已有幂等 ALTER，但该库未按最新代码启动过） |
| 影响 | 未迁移前，评估层无法按 `sub_category <> 'risk'` 排除风险信号 |
| 处置 | 启动一次后端完成幂等 ALTER 后核验列存在（本方案实施前置步骤，已完成后再动代码） |

---

## 附录 A：实测证据速查

| 结论 | 证据 |
|---|---|
| 信号只有 3 条、全未处理 | `user_strategy_signal` → 3 行；`adopted=0, ignored=0, linked_trade_id=NULL` |
| 无 `trade_status` 列 | `PRAGMA table_info` 仅 `adopted/ignored/adopted_at/cooldown_until/linked_trade_id/origin` |
| 行业已落地 | `raw_tdx_blocks_info` 926 / `raw_tdx_blocks_member` 90,988；research L1 = 5581 只 |
| ETF 无市值 | `raw_basic_daily` 中 `sh510300` 的 `totalmv=0, floatmv=0` |
| 指数/ETF 基准可用 | `raw_kline_daily`：hs300 5304、hs905 5304、hs852 5304、hs016 5547、hs001 8758；510300 3510、510500 3314、512760 1797 |
| 回测扣费且基准=510300 | `bt_run.rules_json`=0.0001/5/0.0001；`benchmark_symbol='sh510300'` |
| 口径差异可复现 | 同数据同参数 A/B（400 回合）：按笔 48.75%（成本加权 49.52%）；分桶 47.47% / 46.02% / 53.16% / 70.00%（n=198/113/79/10） |
| ~~历史快照~~ | `bt_metric`（`bt_run 28574a45`，514 回合 / 52.33%）——**不可复现**，仅存档：同参重跑为 400 回合 / 48.75% |
| 费率结论级影响 | 2024H1 同参：ETF 0/0 fees 1,761.49 / 51.44% vs 股票费率 fees 10,472.24 / 40.97% |
| 纸面费率表不存在 | `data/backtest.db` 仅 `bt_*` 表 |
| 业务费率表空壳 | `user_fee_config` 仅 DDL+索引；0 行；无读取调用 |
| CSV 复用写法 | `brokerReconcile.ts:111-142, :240-258`（BOM+CRLF+文件名白名单） |

## 附录 B：口径自检样例（实现后回归）

以合成数据为准（**不使用**现有 3 条信号作为验收样本）：
1. 构造 T+5 未满窗的信号 → 必须 `incomplete`，不进分母；
2. 除权日前后用 qfq，收益不跳变；
3. 停牌标的 → `suspended`，不按 0% 计；
4. `adopted=1 & ignored=1` 的构造行 → 修复后为 0；若有存量 → 归一到采纳优先；
5. 构造 20 条以下样本 → `insufficientSample=true`，响应无胜率百分比。
