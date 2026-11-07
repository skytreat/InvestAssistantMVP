# 提案：纸面账户（Paper Account）

> **文档性质：提案（Proposal），不是技术契约。** 本文只回答「纸面账户该怎么记、怎么跑、怎么失败恢复」，
> 不替代 `SDD_v3.md` 的 API/DDL 契约，也不替代 `code_implementation_plan_v3.md` 的排期。
>
> **领域归属**：L1 业务规则（记账口径与不变量）+ L3 技术契约（四表 DDL / 运行接口）的**候选草案**。
> 采纳后按 `AGENTS.md` 的层界拆分：口径进 `InvestAssistantV3_NewRequirements.md` / `SDD_v3.md`，
> 任务进 `code_implementation_plan_v3.md`，关键取舍进 `docs/adr/`。
>
> **关联文档**：
> - `docs/audit/proposal-strategy-backtest-framework.md`（策略回测框架，本文的复用底座）
> - `docs/client/InvestAssistantV3_NewRequirements.md`（V3 业务规则）
> - `docs/client/SDD_v3.md`（V3 技术契约；V1 未覆盖项回 `SDD.md`）
> - `docs/client/code_implementation_plan_v3.md`（V3 任务与 Gate）
>
> **状态**：v2 / 2026-11-07。
> **§6「成交失败与顺延」已由 owner 定稿**（三条规则内容不变，去掉「建议方案，待用户确认」标注）。
> **§11 的 D1–D6 已由 owner 定稿**（2026-11-07），落地条款、副作用应对见 §11–§12，任务拆分见 §13。
> 除 §6 / §11 外，其余章节仍为提案建议。
>
> **本轮交付**：仅文档，不改代码。

---

## 0. 结论速览

| # | 结论 | 一句话 |
|---|---|---|
| C1 | **内部账本，不是模拟盘对接** | 不对接券商、不产生委托、不需要外部成交回填；账本自身是唯一数据来源。 |
| C2 | **两阶段** | 影子运行只写信号意图（`status='shadow'`），不写持仓/净值；落账运行才正式记账。切换默认**冷启动**。 |
| C3 | **每日两段、成交价取次日开盘** | T 收盘后决策（`asOf=T`、`execDate=T+1`）→ T+1 收盘后结算（按 T+1 开盘价模拟成交）。成交价是**事后确认**，不是盘中实时。 |
| C4 | **成交口径完全复用回测** | `executeTargets` + `TradeRules`：**默认基线 = `DEFAULT_TRADE_RULES`**（开盘价 ± 万 1 滑点、佣金万 1/最低 5 元、ETF 免印花税、买入整手 100、卖出可零股、最小成交额 10 元）；账户可按 D3 绑定费用配置，但**建户时快照冻结**。不新造一套。 |
| C5 | **账本恒等式** | `equity = cash + risk_mv + cash_mv`；`cash` 不含现金类 ETF；停牌按最近有效收盘估值并计 `stale`。 |
| C6 | **四张核心表 + 一张配置表** | `paper_account` / `paper_position` / `paper_order` / `paper_equity` + `paper_fee_config`；按 **D1 定稿**放 `backtest.db`（与 `bt_run` / `bt_trial` 同库），备份与清理边界见 §5.5 / §12.1。 |
| C7 | **订单、成交、未成交事件同表** | `paper_order` 用 `status` + `unfilled_reason` 表达；不建第五张表；**不使用** `linked_trade_id`。 |
| C8 | **失败处置（已定稿）** | 涨停买不到/资金不足/流动性不足 → 当日作废、次日重算、不跨日顺延；停牌 → 持仓维持、不计成交、次日重算；每次未成交记事件，报告统计次数与闲置现金。 |
| C9 | **幂等与恢复** | `signal_id` 确定式；单账户单日单事务；同日重跑可覆盖未结算意图，已结算日默认不可变；多日停机逐日补算。 |

---

## 1. 目标与非目标

### 1.1 目标

纸面账户要回答三个问题：

1. **如果按这个策略真的每天调仓，账本会变成什么样？** —— 用初始资金、真实行情、真实费用，逐日记账。
2. **信号到成交之间发生了什么？** —— 哪些目标成交了、哪些没成交、为什么、损失了多少暴露。
3. **这套记账口径和回测是不是同一套？** —— 同一段行情、同一策略、同一初始资金，纸面与回测应逐日逐笔一致。

### 1.2 非目标

- 不对接任何券商、不产生真实委托、不读取外部成交回填。
- 不做分钟线、不做盘中实时成交、不做盘中信号。
- 不做融资融券、不做做空、不做 T+0、不做期权/期货/外汇。
- 不做手工补录成交、不做手工改持仓、不做出入金。
- 不把纸面权益混入真实资产仪表盘（`user_asset_stat`）。
- 不在本期支持股票策略与自定义 `.js` 插件策略（见 §11 D6）。

> **与回测提案的 Out-of-Scope 不冲突**：回测提案排除的是「模拟盘对接/委托」；
> 本文是**内部记账**，没有任何外部系统参与。

---

## 2. 与实盘、回测的关系与边界

### 2.1 三者对照

| 维度 | 实盘 | 回测 | 纸面账户 |
|---|---|---|---|
| 资金来源 | 真实资金 | 虚拟初始资金 | 虚拟初始资金（用户设定） |
| 成交来源 | 券商回填 | `executeTargets` 模拟 | `executeTargets` 模拟 |
| 行情 | 实盘/盘中 | 历史全量面板 | 每日增量（收盘后） |
| 信号→成交关联 | `user_strategy_signal.linked_trade_id` | 同进程内直接传递 | **内部 `signal_id` 自关联** |
| 存储 | `user_trade_record` 等 | `backtest.db` 的 `bt_*`（可删、可重跑） | `backtest.db` 的 `paper_*`（**同库不同前缀**；不可删、可回放校验，见 §5.5） |
| 生命周期 | 不可重建 | 可删除/重跑 | 不可重建；只允许最后一日显式重算 |
| 用户可见 | 真实资产 | 研究结果 | 模拟账本（必须明确标注「非真实交易」） |

### 2.2 复用的四个底座

| 底座 | 现有实现 | 纸面账户怎么用 |
|---|---|---|
| 策略决策 | `backtest/strategy/types.ts` 的 `Strategy` / `TargetSet` / `StrategyContext` | 同一 `decide(ctx)`；同一 `params` 校验；同一 `warmupDays` 窗口 |
| 成交模拟 | `backtest/execution/simulator.ts` 的 `executeTargets` | 直接调用；`priceMode` 固定 `open`；`rules` 用账户创建时的快照 |
| 账户与成本 | `backtest/account/portfolio.ts` 的 `Portfolio` + `packages/core` 移动加权成本 | 同一 `applyFill` / `applyCorporateActions` / `position()`；持久化只是投影 |
| 行情与日历 | `backtest/marketPanel.ts` 的 `getBars` / `isSuspended`；`universe/pointInTime.ts` 的 `resolveUniverseAt` | 同一 ETF 视图、同一时点池、同一停牌判定 |

### 2.3 必须新增的复用前置（纯搬迁/纯新增，不改行为）

| # | 事项 | 为什么必须 |
|---|---|---|
| P1 | 从 `engine.ts` 抽出 `stepBacktestDay()`（含 `targetsOverride` / `equityAtCutoffOverride`） | 纸面结算与回测必须共用「先卖后买、除权先于成交、净值口径」的同一段顺序；复制粘贴必然漂移 |
| P2 | 导出 `makeContext()`（或 `buildStrategyContext()`） | 纸面决策要构造与回测**逐字段相同**的 `StrategyContext`，尤其是 `closeableQty` 的 T+1 视图 |
| P3 | 导出 `capTurnover()` | 策略声明 `maxTurnoverRatio` 时，纸面必须在写订单前应用同一换手缩放 |
| P4 | 新增 `Portfolio.restore(positions, cash)` | 从 `paper_position` 检查点恢复成本基与 `closeableQty`；避免每日全量回放 |
| P5 | 新增**前向**交易日历 `nextTradingDay()` | 现有 `TradingCalendar` 只含历史日期（由 `sh000001` 派生），**无法算出「明天」**；见 §7.3 |
| P6 | 新增 `paper_fee_config` → `TradeRules` 的映射与校验（D3） | `executeTargets` 的 `rules` 是参数，但费率/税种/整手/最小成交额的**取值与校验**必须有单一入口；纸面不能直接读全局常量，否则账户间无法差异化 |

> 这些前置都是**纯重构 + 一个小新增**，不改变回测结果。验收方式：重构前后跑同一组 golden 回测，逐位一致。

### 2.4 硬边界（不得越界）

1. **不写真实交易链路**：不写 `user_trade_record`、`user_asset_stat`、`user_asset_rel`、`user_strategy_signal`。
2. **不使用 `linked_trade_id`**：该字段属于「真实信号 → 真实成交」的外部回填链路；
   纸面成交是内部生成的，用 `linked_trade_id` 会制造一个不存在的真实成交依赖。纸面一律用 `paper_order.signal_id`。
3. **不接受外部成交导入**：`paper_order` 的成交字段只能由 17:04 结算任务写入；API 不提供手工成交接口。
4. **不把纸面持仓算进真实资产**：纸面账户是独立命名空间，前端必须分区展示。
5. **不复用 `asset_class` 做净值拆分**：为与回测逐位一致，风险/现金桶沿用引擎的 `CASH_BUCKET_SYMBOLS`（防御 ETF + 逆回购代码）。
   若未来 `asset_class` 成为唯一权威，必须同时改回测，否则会出现两套分类。

---

## 3. 运行形态与两阶段

### 3.1 影子运行（shadow）

- 每日 T 收盘后，按策略算出 T+1 的目标标的与权重；
- 只写 `paper_order` 的 `status='shadow'` 行（含目标权重、目标金额、意图方向、`signal_id`）；
- **不写** `paper_position`、**不写** `paper_equity`、**不写**成交字段；
- 不参与结算；次日不会产生任何持仓或现金变化。

影子期的价值：
- 验证信号稳定性（目标是否频繁翻转）、目标数量、换手规模；
- 验证数据完整性（目标标的是否有 bar、是否停牌）；
- 给用户一个「先看信号、再决定是否落账」的观察窗口。

> 影子期不统计「未成交」——因为没有结算。若需要「假设成交」诊断，只能在报告层做只读模拟，**不得写入账本**。

### 3.2 落账运行（ledger）

- 每日 T 收盘后：先结算 T 的 pending（按 T 开盘价），再决策 T+1；
- 结算写入 `paper_order` 成交字段、`paper_position`、`paper_equity`、`paper_account.cash`；
- 决策写入 `paper_order` 的 `status='pending'` 行。

### 3.3 阶段切换（shadow → ledger）

- **单向**：`phase` 只允许 `shadow` → `ledger`，不回退；
- **默认冷启动**：切换后从空仓 + `initial_cash` 重新开始，`ledger_start_date` 记为切换后的首个决策日，写一条种子净值点（`equity = cash = initial_cash`）；
- 影子期 `paper_order` 行永久保留（`status='shadow'`），只读可查；
- 切换在每日决策前生效；若当日决策已执行，则从下一交易日起落账。

> 为什么冷启动：影子期没有持仓与现金流水，把「假设持仓」折成现金再落账会引入一个任意估值点，
> 使账本起点不可复现。影子期只用于信号质量对照，落账期从干净状态开始。

### 3.4 每日时序（成交价与记账时点的关系）

```text
T-1 17:04  决策（asOf=T-1, execDate=T）  → paper_order(pending, trade_date=T)
T   17:04  结算 T（按 T 开盘价成交）      → fills / positions / paper_equity(T)
T   17:04  决策（asOf=T,   execDate=T+1）  → paper_order(pending, trade_date=T+1)
```

**关键事实**：
- 成交价是 **T 日开盘价**，但账本在 **T 日收盘后**（17:04）才写入；
  因此用户看到的是「当日收盘后的账本 + 当日开盘的成交」，不是盘中实时成交。
- 当日净值点 `paper_equity(T)` 是「T 开盘成交已入账 + T 收盘估值」的状态；
- T 的决策使用 `paper_equity(T)` 的权益，所以必须**先结算、后决策**，否则会用旧持仓/旧现金算目标。

### 3.5 决策视图与执行视图的 T+1 差异（必须照搬）

现有回测引擎有一个容易踩的细节：**决策上下文在 `startDay()` 之前构造**，而成交在 `startDay()` 之后执行。

- `ctx.positions[].closeableQty` = `qty − 当日买入`（T 日买入在 T 日收盘后的决策视图里仍显示「不可卖」）；
- `executeTargets` 的 `positionOf` 在 `startDay()` 之后，T 日买入在 T+1 变为可卖。

纸面账户必须**按同一顺序**构造：

1. 决策阶段（T 收盘后）：从检查点恢复 `Portfolio`（`boughtToday = qty − closeable_qty`），**不调用** `startDay()`，构造 `ctx`；
2. 结算阶段（T+1 收盘后）：从检查点恢复，**调用** `startDay()`（清空 `boughtToday`），再应用除权、执行成交。

否则策略在纸面账户里的卖出时机会比回测晚一天，造成系统性漂移。

---

## 4. 账本口径

### 4.1 初始资金、可用现金与持仓市值

| 项 | 口径 |
|---|---|
| `initial_cash` | 用户设定，`> 0`，创建后不可改；建议 `< 1000` 时给出警告（可能买不起一手） |
| `cash` | **已结算可用现金**；不含在途、不含现金类 ETF、不含待成交订单的冻结 |
| `risk_mv` | 非现金类持仓按「最近有效收盘价」计算的市值 |
| `cash_mv` | 现金类 ETF（`CASH_BUCKET_SYMBOLS`）按最近有效收盘计算的市值 |
| `equity` | `cash + risk_mv + cash_mv`（逐日断言） |
| `exposure` | `risk_mv / equity`（`equity ≤ 0` 时记 0 并报 ERROR） |
| 入金/出金 | **V1 不做**；分红进 `cash`，不自动再投资 |

**决策阶段不冻结现金**：目标只是意图；结算阶段按模拟器的「先卖后买」顺序实际扣减。

### 4.2 成交价与成交时点

- **基准价**：当日开盘价（`bar.open`，bfq）；
- **成交价**：买入 `open × (1 + slippageRate)`，卖出 `open × (1 − slippageRate)`；
- 默认 `slippageRate = 0.0001`（与回测 `DEFAULT_TRADE_RULES` 一致）；
- `slippage_cost = qty × |fill_price − open|`，单独写入 `paper_order.slippage_cost`，报告单列；
- 若用户要求「严格等于开盘价」，可在账户创建时把 `slippageRate` 覆盖为 `0`；但这会与回测默认口径不一致，需在账户详情中标注。

> **为什么保留滑点**：本文的第一原则是「复用同一套成交模拟口径」。回测默认含万 1 滑点；
> 若纸面去掉滑点，纸面与回测就无法逐位对账。滑点不是隐藏费用，它在报告里单独可见。

### 4.3 费用、整手与最小成交额

| 项 | 默认值 | 说明 |
|---|---|---|
| 佣金率 | `0.0001`（万 1） | `commission = max(5, notional × 0.0001)`，四舍五入到分 |
| 最低佣金 | `5` 元 | 卖出时费用封顶为成交额，避免出现负现金 |
| 印花税 | `0` | ETF 免印花税；股票策略另议（见 §11 D6） |
| 过户费 | `0` | ETF 不计；股票策略另议 |
| 滑点 | `0.0001` | 见 §4.2 |
| 买入整手 | `100` 份/股 | 目标金额不足 1 手但 ≥ 1 份时，先按 1 手上限，再由现金约束回退 |
| 卖出整手 | 不取整 | 允许零股/送转产生的碎股一次性卖出 |
| 最小成交额 | `10` 元 | `qty × price < 10` → `below-min-notional` |
| 涨跌停幅度 | `0.10` | 与回测默认一致；20% 档 ETF 的已知偏差见 §10 R5 |
| 分红 | 不计费 | 现金分红直接进 `cash` |
| 现金利息 | `0` | V1 不计 |

**取值顺序（D3 定稿）**：建户时依次尝试 ① 账户显式绑定的 `paper_fee_config` → ② 该用户的默认配置 → ③ 系统默认行（`is_system_default=1`）→ ④ 内置 `DEFAULT_TRADE_RULES`。命中的配置**序列化快照进 `paper_account.fee_snapshot_json`**，同时冗余写入 `fee_config_id`（溯源用）。

- **快照冻结**：之后修改配置表**不影响已开账户**；要换费率只能新建账户（与 D4/D5 的不可变原则一致）；
- **校验入口唯一**：`paper_fee_config` 的写接口与 `feeSnapshotToTradeRules()` 共用同一套校验（费率区间、最低佣金 ≥ 0、税率为 0 时视为不适用、整手 ∈ [1,1000]、最小成交额 ≥ 0）；
- **与回测逐位对账的前提**：验收用的账户必须使用「系统默认 + 内置默认」这条路径，即 `fee_snapshot_json` 与 `DEFAULT_TRADE_RULES` 逐字段相等；否则只能做口径对比，不能做逐位断言（见 §9.1）。

### 4.4 T+1 可卖与卖出款可用

- **先卖后买**：`executeTargets` 先处理卖出，再把卖出款计入可用现金，然后处理买入；
- 当日买入的份额当日不可卖（`Portfolio.boughtToday`）；
- 次日结算开始时 `startDay()` 清空 `boughtToday`，前一日买入全部解冻；
- 卖出款**当日可用于买入**（与 A 股资金 T+0 可用一致），但纸面账户没有「提现」；
- 送转份额**不占用 T+1 冻结**（`applyCorporateActions` 不计入 `boughtToday`，与 core 一致）。

### 4.5 除权除息与份额调整

复用 `loadCorporateActions()`（`raw_gbbq.category = 1`）与 `Portfolio.applyCorporateActions()`：

| 事件 | 口径 |
|---|---|
| 现金分红 | `cash += qty × (c1 / 10)`；`core` 记一笔 `dividend`；**成本基不变** |
| 送转 | `qty += qty × (c3 / 10)`；`core` 记一笔 `bonus`（price=0）；**成本基不变**，均价下降 |
| 同日顺序 | **先送股后分红**，分红基数 = 送转后股数；`applyCorporateActions` 内部已排序，纸面不要再排 |
| 费用 | 分红/送转不计佣金 |
| 时点 | 在成交日开盘前应用，按**前一交易日收盘持仓**生效；当日买入不享受当日除权 |
| 停牌 | 除权照常应用（分红进现金、送转加份额），只是不成交 |
| 配股/合并/拆分 | **本期不支持**；`raw_gbbq` 只取 category=1 的现金分红与送转 |

### 4.6 估值与停牌

- 估值价 = `closeAtOrBefore(execBars, D)`：当日有 bar 用当日收盘，无 bar 用最近有效收盘；
- 停牌判定复用 `isSuspended()` 默认 `{missingBar: true, zeroVolume: true}`；
- 停牌持仓**不强制卖出、不按 0 估值**；`paper_equity.stale_symbol_count` 记录「当日无有效成交的持仓数」；
- 若某持仓**从未有过任何有效收盘价**：中止当日结算事务并报 ERROR，不写一条按 0 估值的假净值；
- 基准缺失：`benchmark_close` 沿用最近有效值，`benchmark_stale = 1`，并在报告中排除该日的 alpha/beta 成对统计（与 `EquityPoint.benchmarkStale` 口径一致）。

### 4.7 复权口径

| 用途 | 口径 | 原因 |
|---|---|---|
| 信号/指标 | **qfq**（`v_etf_qfq`） | 与回测策略输入一致，避免除权跳空污染指标 |
| 成交/估值/现金 | **bfq**（`v_etf_bfq`） | 成交按真实价格与真实份额；分红另记现金流 |
| 除权事件 | `raw_gbbq` 原始事件 | 不复权调整已把分红折进价格，若再记分红会**双重计算** |

> 一句话：**信号用前复权，账本用不复权，分红单独进现金**。这是回测既有的组合，纸面照搬。

### 4.8 口径清单（10 条不变量）

1. `equity = cash + risk_mv + cash_mv`，逐日断言，容差 `1e-6`；
2. `cash >= -0.01`（分位容差）；`qty >= 0`；`closeable_qty <= qty`；
3. 成交价 = 开盘价 ×（1 ± 滑点）；成交日 = 决策日的下一个交易日；
4. 买入整手 100；卖出可零股；最小成交额 10 元；
5. 佣金 = `max(5, notional × 0.0001)`；ETF 无印花税/过户费；卖出费用封顶成交额；
6. 先卖后买；当日买入不可卖；次日解冻；卖出款当日可用；
7. 除权先送转后分红；分红基数 = 送转后股数；成本基不变；
8. 停牌不成交、持仓维持、按最近有效收盘估值、计 `stale`；
9. 信号 qfq、账本 bfq、分红进现金；不得混用；
10. 影子期不写持仓/净值；落账期才记账；`signal_id` 确定式自关联。

---

## 5. 数据模型（四张核心表）

### 5.1 总览

| 表 | 角色 | 权威性 |
|---|---|---|
| `paper_account` | 账户参数、阶段、状态、当前现金、日期水位 | 权威 |
| `paper_position` | 当前持仓（截至 `last_settled_date` 的检查点） | 权威检查点（可由 `paper_order` 全量回放校验） |
| `paper_order` | 信号意图 + 成交 + 未成交事件（同表不同状态） | **账本的唯一事实来源** |
| `paper_equity` | 每日净值快照 | 权威历史（可由 orders + 行情回放校验） |

命名说明：
- 按 **D1 定稿**放 `backtest.db`（与 `bt_run` / `bt_trial` 同库），用 `paper_` 前缀，**不**混入 `user_*` 真实交易表；
- 字段风格对齐现有业务 DDL：`snake_case`、`is_deleted`、`created_at/updated_at`、`CHECK`、`FOREIGN KEY`；
- `asset_code` 与回测的 `symbol` **同值**；本文 DDL 用业务侧的 `asset_code`，服务层做 1:1 映射。

### 5.2 DDL（设计稿）

```sql
-- ─────────────────────────────────────────────────────────────
-- 纸面账户（D1 定稿：与回测同库 backtest.db；与 bt_* 同库不同前缀）
-- D6 定稿：单用户单账户；该账户锁定一个策略与一个版本。
-- ⚠️ 跨库限制：user_account 在 business.db，此处**不能**建到 user_account 的外键，
--    用户归属由服务层在建户时校验（见 §12.3）。
-- ─────────────────────────────────────────────────────────────
-- ─────────────────────────────────────────────────────────────
-- 费用配置（D3 定稿）：允许用户/券商配置；建户时快照冻结
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paper_fee_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,                 -- NULL = 系统级配置（所有用户可用）
    broker_name TEXT,                -- 「券商配置」展示标签；NULL = 用户手工配置
    name TEXT NOT NULL,
    commission_rate REAL NOT NULL DEFAULT 0.0001
        CHECK (commission_rate >= 0 AND commission_rate <= 0.003),
    min_commission REAL NOT NULL DEFAULT 5
        CHECK (min_commission >= 0 AND min_commission <= 100),
    stamp_duty_rate REAL NOT NULL DEFAULT 0     -- 0 = 不适用；非 0 需模拟器支持（首期建户拒绝）
        CHECK (stamp_duty_rate >= 0 AND stamp_duty_rate <= 0.001),
    transfer_fee_rate REAL NOT NULL DEFAULT 0   -- 0 = 不适用；非 0 需模拟器支持（首期建户拒绝）
        CHECK (transfer_fee_rate >= 0 AND transfer_fee_rate <= 0.001),
    slippage_rate REAL NOT NULL DEFAULT 0.0001
        CHECK (slippage_rate >= 0 AND slippage_rate <= 0.02),
    lot_size INTEGER NOT NULL DEFAULT 100
        CHECK (lot_size >= 1 AND lot_size <= 1000),
    min_notional REAL NOT NULL DEFAULT 10
        CHECK (min_notional >= 0 AND min_notional <= 10000),
    price_limit_pct REAL NOT NULL DEFAULT 0.10
        CHECK (price_limit_pct >= 0 AND price_limit_pct <= 0.5),
    is_system_default INTEGER NOT NULL DEFAULT 0 CHECK (is_system_default IN (0, 1)),
    is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 系统默认行全库至多一条（回退链的第 ③ 层）
CREATE UNIQUE INDEX IF NOT EXISTS ux_paper_fee_config_system_default
    ON paper_fee_config (is_system_default) WHERE is_system_default = 1 AND is_deleted = 0;

-- 同一用户下配置名唯一（系统级配置 user_id 为 NULL，靠 name 区分）
CREATE UNIQUE INDEX IF NOT EXISTS ux_paper_fee_config_user_name
    ON paper_fee_config (COALESCE(user_id, -1), name) WHERE is_deleted = 0;

CREATE TABLE IF NOT EXISTS paper_account (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    strategy_id TEXT NOT NULL,
    strategy_version TEXT NOT NULL,  -- D4 定稿：锁定版本；运行时按 (id, version) 精确解析
    strategy_name TEXT NOT NULL,
    name TEXT NOT NULL,
    params_json TEXT NOT NULL,       -- 建户时参数快照，之后不可变
    rules_json TEXT NOT NULL,        -- 其它交易规则快照（先卖后买/涨跌停等）
    fee_config_id INTEGER,           -- 溯源用；NULL = 走内置默认
    fee_snapshot_json TEXT NOT NULL, -- D3 定稿：建户时冻结的费用快照，结算只读它
    phase TEXT NOT NULL DEFAULT 'shadow' CHECK (phase IN ('shadow', 'ledger')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'closed')),
    initial_cash REAL NOT NULL CHECK (initial_cash > 0),
    cash REAL NOT NULL CHECK (cash >= -0.01),
    start_date TEXT,                 -- 影子期首个决策日
    ledger_start_date TEXT,          -- 落账期首个决策日（手动切换时写入）
    last_decision_date TEXT,
    last_settled_date TEXT,
    benchmark_asset_code TEXT NOT NULL DEFAULT 'sh510300',
    is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (fee_config_id) REFERENCES paper_fee_config(id)
);

-- D6 定稿：一个用户至多一个在用纸面账户（软删除后允许重建）
CREATE UNIQUE INDEX IF NOT EXISTS ux_paper_account_live_user
    ON paper_account (user_id) WHERE is_deleted = 0 AND status <> 'closed';

CREATE INDEX IF NOT EXISTS ix_paper_account_user_status
    ON paper_account (user_id, status);

-- D5 定稿：不做出入金 ⇒ 初始资金建户后不可变（DB 级兜底，API 也不提供改额接口）
CREATE TRIGGER IF NOT EXISTS trg_paper_account_initial_cash_immutable
BEFORE UPDATE OF initial_cash ON paper_account
FOR EACH ROW
WHEN OLD.initial_cash <> NEW.initial_cash
BEGIN
    SELECT RAISE(ABORT, 'paper_account.initial_cash is immutable (D5)');
END;

-- ─────────────────────────────────────────────────────────────
-- 当前持仓（截至 last_settled_date 的检查点）
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paper_position (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    asset_code TEXT NOT NULL,
    qty REAL NOT NULL DEFAULT 0 CHECK (qty >= 0),
    avg_cost REAL NOT NULL DEFAULT 0 CHECK (avg_cost >= 0),
    cost_basis REAL NOT NULL DEFAULT 0 CHECK (cost_basis >= 0),
    -- 结算完成后的「次日可卖量」= qty − 当日买入量；下一结算日开始时先视为全部可卖
    closeable_qty REAL NOT NULL DEFAULT 0 CHECK (closeable_qty >= 0 AND closeable_qty <= qty),
    last_buy_date TEXT,
    last_price REAL,                 -- 展示用，不参与记账
    last_price_date TEXT,
    is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE (account_id, asset_code),
    FOREIGN KEY (account_id) REFERENCES paper_account(id)
);

-- ─────────────────────────────────────────────────────────────
-- 订单 / 成交 / 未成交事件（同一张表，用 status 区分）
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paper_order (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    signal_id TEXT NOT NULL,         -- 内部自关联：psig_<account_id>_<decision_date>_<asset_code>
    decision_date TEXT NOT NULL,     -- 决策日 T
    trade_date TEXT NOT NULL,        -- 预期成交日 T+1
    seq INTEGER NOT NULL,            -- 保留 TargetSet.targets 的原始顺序；禁止按 symbol 重排
    asset_code TEXT NOT NULL,
    intent_kind TEXT NOT NULL CHECK (intent_kind IN ('target', 'liquidate')),
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    rebalance_mode TEXT NOT NULL CHECK (rebalance_mode IN ('replace', 'incremental')),
    target_weight REAL CHECK (target_weight IS NULL OR (target_weight >= 0 AND target_weight <= 1)),
    target_notional REAL NOT NULL DEFAULT 0 CHECK (target_notional >= 0),
    cutoff_equity REAL NOT NULL CHECK (cutoff_equity >= 0),
    intent_notional REAL NOT NULL DEFAULT 0 CHECK (intent_notional >= 0),
    status TEXT NOT NULL CHECK (status IN ('shadow', 'pending', 'noop', 'filled', 'unfilled', 'superseded')),
    filled_qty REAL NOT NULL DEFAULT 0 CHECK (filled_qty >= 0),
    fill_price REAL CHECK (fill_price IS NULL OR fill_price >= 0),
    filled_notional REAL NOT NULL DEFAULT 0 CHECK (filled_notional >= 0),
    fee REAL NOT NULL DEFAULT 0 CHECK (fee >= 0),
    slippage_cost REAL NOT NULL DEFAULT 0 CHECK (slippage_cost >= 0),
    unfilled_reason TEXT CHECK (unfilled_reason IS NULL OR unfilled_reason IN (
        'suspended', 'limit-up', 'limit-down', 't-plus-1', 'no-position',
        'round-lot-zero', 'below-min-notional', 'insufficient-cash',
        'no-target-value', 'turnover-capped'
    )),
    unfilled_detail TEXT,
    is_replayed INTEGER NOT NULL DEFAULT 0 CHECK (is_replayed IN (0, 1)),
    settled_at TEXT,                  -- 墙钟时间；NULL = 尚未结算
    is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE (account_id, signal_id),
    UNIQUE (account_id, decision_date, asset_code),
    FOREIGN KEY (account_id) REFERENCES paper_account(id)
);

CREATE INDEX IF NOT EXISTS ix_paper_order_due
    ON paper_order (account_id, trade_date, status);

CREATE INDEX IF NOT EXISTS ix_paper_order_decision
    ON paper_order (account_id, decision_date, status);

-- ─────────────────────────────────────────────────────────────
-- 每日净值快照（镜像 bt_equity 的字段口径）
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paper_equity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    trade_date TEXT NOT NULL,
    equity REAL NOT NULL CHECK (equity >= -0.01),
    cash REAL NOT NULL CHECK (cash >= -0.01),
    risk_mv REAL NOT NULL DEFAULT 0,
    cash_mv REAL NOT NULL DEFAULT 0,
    exposure REAL NOT NULL DEFAULT 0,
    benchmark_close REAL,
    benchmark_stale INTEGER NOT NULL DEFAULT 0 CHECK (benchmark_stale IN (0, 1)),
    drawdown_ratio REAL,
    stale_symbol_count INTEGER NOT NULL DEFAULT 0,
    is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE (account_id, trade_date),
    FOREIGN KEY (account_id) REFERENCES paper_account(id)
);

CREATE INDEX IF NOT EXISTS ix_paper_equity_account_date
    ON paper_equity (account_id, trade_date);
```

### 5.3 `signal_id` 设计与自关联

- 生成时机：决策阶段，每个目标/清算意图一行；
- 格式：`psig_<account_id>_<decision_date>_<asset_code>`（确定式，便于同日重跑幂等）；
- 自关联：`paper_order.signal_id` 就是这笔意图的身份证；
  **成交与未成交事件都在同一行上**，不需要再通过 `linked_trade_id` 找回真实成交；
- 不使用 UUID：确定式 ID 让「同一天重跑」可以 UPSERT，不会产生重复信号；
- 一个 `signal_id` 只对应一个 `asset_code` 的一个方向意图；同一标的当日不会同时出现 target 与 liquidate 两行。

### 5.4 状态机

```text
shadow ──（切换落账后不再产生）──────────────────────────────► 终态
pending ──结算成功──► filled
        ├─结算未成交──► unfilled（带 unfilled_reason）
        ├─目标已达成──► noop
        └─同日重算被替代──► superseded
```

- `shadow`：影子期，不结算；
- `pending`：已写意图、等 `trade_date` 结算；
- `noop`：结算时既无成交也无未成交事件（目标已被当前持仓满足）；
- `filled`：有成交（可能缩量，见 §6.6）；
- `unfilled`：有未成交事件（含停牌、涨停、资金不足等）；
- `superseded`：同日重算时被新意图替代，**不计入未成交统计**。

### 5.5 落位：`backtest.db`（D1 定稿）

**结论**：`paper_*` 与 `bt_run` / `bt_trial` 放**同一个 SQLite 文件** `data/backtest.db`，用前缀区分；
不再考虑独立 `paper.db`，也不会退回 `business.db`。

同库带来的三条硬性约束（详细应对见 §12.1）：

1. **备份**：现有 17:05 只备份 `business.db`，`paper_*` 会**裸奔** ⇒ 必须把 `backtest.db` 纳入备份清单（与 `business.db` 同一套 `db.backup()` 机制）；
2. **清理/重置脚本**：所有「删库/重建/重新导入」脚本必须**显式白名单**只作用于 `bt_*`；禁止删文件、禁止 `DROP TABLE paper_*`。落地前加一条守卫查询（见 §12.1）；
3. **写并发**：回测批量写与 17:04 日更写共享一个写者锁 ⇒ `busy_timeout` + 有限重试 + 时间窗规避，不能假设「两个进程各写各的」；
4. **跨库外键不可用**：`user_account` 在 `business.db`，`paper_account.user_id` **没有外键**，归属校验放服务层。

> 与 §2.1「不可删、可回放校验」不冲突：**不可删**指的是「不随回测清理被删除」，不是「文件永不清理」。
> `backtest.db` 可以由用户整体删除以重置研究数据 —— 但那会**同时删掉纸面账本**，因此删除入口必须二次确认并单独告警（§12.1）。

### 5.6 检查点 vs 全量回放

- **日常**：从 `paper_position` + `paper_account.cash` 恢复 `Portfolio`（`restore`），再结算当日；
- **审计/重建**：从 `paper_order` 的 `filled` 行 + `loadCorporateActions()` 全量回放，逐日与 `paper_equity` 对账；
- **重算最后一日**：全量回放到 D-1，再重结算 D（仅允许最后一日，见 §7.7）；
- 日常不回放的理由：成本低但没必要；全量回放会把「历史除权数据修订」带进账本，破坏不可变性。

`Portfolio.restore(positions, cash)` 的实现要点：
- 每个持仓压一笔 `buy` 合成成交：`qty = qty`、`price = avg_cost`、`fee = 0` → core 重算出同样的 `costBasis/avgCost`；
- `boughtToday[symbol] = qty − closeable_qty` → 复现决策视图的 T+1 冻结；
- 结算阶段随后调用 `startDay()` → 清空冻结，全部可卖；
- 日结算的 `Portfolio` 不用于报告 round trips（`openDate` 会是恢复日）；报告用全量回放算 round trips。

---

## 6. 成交失败与顺延【已定稿】

> 本节已由 owner 确认（2026-11-07）；三条规则内容不变，去掉「建议方案，待用户确认」标注。

### 6.1 三条规则

| 情形 | 处置 | 是否顺延 |
|---|---|---|
| 涨停买不到 / 资金不足 / 流动性不足 | **当日作废** | **不跨日顺延**；次日按最新数据重算 |
| 停牌（当日无价格） | **不算信号失效**；持仓维持、不计成交 | 不把卖出意图顺延；次日重算 |
| 每一次未成交 | 记为事件（标的、原因、金额） | 报告中单独统计未成交次数与闲置现金比例 |

**「不跨日顺延」的含义**：作废/停牌的意图只留在当天的 `paper_order` 行里作为事件，
**不会**变成 T+2 的 pending 订单；T+2 的订单只来自 T+1 收盘后的**新决策**。
因此「次日重算」不是「重试同一笔订单」，而是「用最新持仓 + 最新行情重新算目标」。

### 6.2 用户口径 → 模拟器原因码映射

| 用户口径 | 模拟器 `SkipReason` | 触发条件（与回测一致） | 报告分组 |
|---|---|---|---|
| 涨停买不到 | `limit-up` | 买入且 `open ≥ preclose × (1 + priceLimit)` | 作废类 |
| 跌停卖不出（对称情形） | `limit-down` | 卖出且 `open ≤ preclose × (1 − priceLimit)` | 作废类 |
| 资金不足 | `insufficient-cash` | 买入按整手递减到 0 手仍不够 | 作废类 |
| 流动性不足（最小成交额） | `below-min-notional` | 可成交名义金额 `< minNotional`（10 元） | 作废类 |
| 流动性不足（整手不足） | `round-lot-zero` | 目标金额折算后不足 1 手（且未触发 v5.2 的 100 份兜底） | 作废类 |
| 停牌/无价格 | `suspended` | 当日无 bar（`missing-bar`）或 `volume = 0`（`zero-volume`） | 停牌类 |
| 换手被截断 | `turnover-capped` | 策略声明 `maxTurnoverRatio`，缩放后增仓 `< 1 元` | 风控类 |
| 目标无金额 | `no-target-value` | `targetWeight` 与 `targetNotional` 都未给 | 异常类（策略 bug） |
| T+1 不可卖 | `t-plus-1` | 卖出量超过 `closeableQty` | 异常类（不应发生） |
| 无持仓可卖 | `no-position` | 卖出意图但持仓为 0 | 异常类（不应发生） |

> **「资金不足」的精确定义**：不是「没达到目标金额」，而是「按整手递减后仍不足 1 手」。
> 若只是买少了（例如目标 1000 份、现金只够 700 份），模拟器会成交 700 份，状态是 `filled`（缩量），
> 不是 `unfilled`。缩量成交在报告中单独统计（§6.6），不混入「未成交次数」。

### 6.3 当日作废的落地

1. 结算时 `executeTargets` 返回 `SkippedOrder`，按 `(asset_code, 方向)` 匹配到 `pending` 行；
2. 该行 `status='unfilled'`、`unfilled_reason=<原因>`、`unfilled_detail=<detail>`、`settled_at=<墙钟>`；
3. `intent_notional` 保持决策时点的意图金额（**事件金额口径**，不是失败订单的名义额）；
4. 该行**不产生**任何后续 pending；次日决策重新生成新的 `signal_id`；
5. 若某标的在次日仍被策略选中，会得到一个新的 `signal_id` 和新的 `pending` 行 —— 这在报告里是「新一次尝试」，不是「同一笔顺延」。

### 6.4 停牌的落地

- 停牌持仓：`qty` 不变、`avg_cost` 不变、`cash` 不变；当日净值用最近有效收盘估值，`stale_symbol_count + 1`；
- 停牌买入目标：`status='unfilled'`、`reason='suspended'`，不建仓；
- 停牌卖出意图：`status='unfilled'`、`reason='suspended'`，持仓保留；**不把卖出意图顺延**；
- 次日策略重新决策：如果仍要卖，会生成新的 `signal_id`；如果不要卖，持仓继续保留；
- 停牌不是「信号失效」：不删除目标、不标记策略失败、不触发风控降级；只在报告里计一次停牌事件。

### 6.5 未成交事件与金额

事件就是 `paper_order` 的 `status='unfilled'` 行，字段直接可用：

| 事件要素 | 字段 |
|---|---|
| 标的 | `asset_code` |
| 原因 | `unfilled_reason` + `unfilled_detail` |
| 金额 | `intent_notional`（决策时点的目标增量金额；绝对值） |
| 方向 | `side`（决策意图方向；若跳空反向，以结算实际方向写回） |
| 日期 | `decision_date` / `trade_date` |
| 信号 | `signal_id` |

> **跳空反向的边界**：决策时判断为「买入」的目标，若 T+1 开盘大幅高开，使当前市值已超过目标，
> 模拟器会走卖出分支。此时 `side` 以**实际成交方向**为准，`intent_notional` 仍保留决策时点的意图金额；
> 若既未成交也未产生 skip，则记为 `noop`。这是已知边界，不影响账本，只影响展示。

### 6.6 报告口径

| 指标 | 口径 | 数据源 |
|---|---|---|
| 未成交次数（总） | `count(status='unfilled')` | `paper_order` |
| 作废次数 | `unfilled_reason ∈ {limit-up, limit-down, insufficient-cash, below-min-notional, round-lot-zero}` | `paper_order` |
| 停牌次数 | `unfilled_reason = 'suspended'` | `paper_order` |
| 风控/策略类 | `turnover-capped` / `no-target-value` | `paper_order` |
| 异常类 | `t-plus-1` / `no-position` | `paper_order`（应告警） |
| 缩量成交次数 | `status='filled'` 且 `filled_notional < intent_notional × 0.99` | `paper_order` |
| 闲置现金比例（严格） | `cash / equity` | `paper_equity` |
| 现金桶比例 | `(cash + cash_mv) / equity` | `paper_equity` |
| 未成交买入意图占比 | `Σ(unfilled 且 side='buy' 的 intent_notional) / equity` | `paper_order` + `paper_equity` |

**「闲置现金」必须区分三种来源**：
1. **策略设计闲置**：目标权重本身没有满仓；
2. **未成交造成闲置**：买入意图被作废/停牌，现金没花出去；
3. **缩量成交造成闲置**：买少了（现金约束/整手约束）。

报告并列展示 `cash/equity`、`(cash+cash_mv)/equity`、`未成交买入意图/equity`，
**不做因果归因**（因为同日多笔买入会互相占用现金），由用户结合明细判断。

### 6.7 本节的边界

- **不引入成交量占比上限**：回测模拟器没有「订单金额/当日成交额」闸门；纸面若新增，就会破坏逐位对账。
  「流动性不足」在本期只映射到 `below-min-notional` 与 `round-lot-zero`。
- **不做部分成交**：除「按整手缩量」外，不模拟盘口/排队/冲击成本。
- **不做失败重试队列**：没有「重试 N 次」；次日是新决策。
- **不手工改状态**：`unfilled` 是终态，不能由 API 改成 `filled`。

---

## 7. 每日运行时序与失败恢复

### 7.1 时序（新增 17:04 一段）

| 时间 | 现有/新增 | 任务 | 与纸面的关系 |
|---|---|---|---|
| 17:00 | 现有 | `tdx2db` 写 T 日线（systemd timer） | 纸面的数据前置 |
| 17:01 | 现有 | C1-C12 校验（`enqueueStage`，等待行情哨兵） | 纸面**不**用股票口径 C1-C12 作为门禁 |
| 17:02 | 现有 | 插件信号（`user_strategy_signal`） | 与纸面无关 |
| 17:03 | 现有 | 除权事件同步（`importDividendEvents`） | 纸面直接读 `raw_gbbq`，不依赖此步 |
| **17:04** | **新增** | **纸面账户：先结算 T，再决策 T+1** | 本文主体 |
| 17:05 | 现有 | 备份（`business.db` + **新增 `backtest.db`** + 受控的 DuckDB） | 必须覆盖 `paper_*`（D1 定稿） |

纸面阶段必须挂在同一个 `enqueueStage` 串行队列上，并 `waitForQuoteUpdate=true`，
避免在 `tdx2db` 写完之前读到半截行情。

> **写窗口（D1 约束）**：17:00–17:10 内不允许触发回测批量任务（CLI / API / sweep）。
> 纸面日更与回测批量共用 `backtest.db` 的单写者锁，错峰会以 `SQLITE_BUSY` 失败；
> 串行化与重试细节见 §12.1。

### 7.2 单账户、单日、单事务

每个账户的「结算 T」必须在**一个 `db.transaction`** 内完成：

1. 从检查点恢复 `Portfolio`；
2. `startDay()`；
3. `loadCorporateActions(heldSymbols, T, T)` → `applyCorporateActions()`；
4. 取 T 日 bfq bar（`getBars`，一次 `IN` 查询）→ `executeTargets`；
5. 按 `(asset_code, 方向)` 匹配 `pending` 行，写成交/未成交；
6. `applyFill` 更新 `Portfolio`；
7. 写 `paper_position`、`paper_account.cash`、`paper_equity(T)`；
8. 更新 `last_settled_date`。

任何一步抛错 → 全部回滚，`pending` 保留，等下次重跑。**不允许半结算**。

### 7.3 行情未更新

分两层判定，不能混：

| 层级 | 判定 | 处置 |
|---|---|---|
| **全市场未更新** | `D` 是交易日（工作日 + 不在 `raw_holidays`），但 `TradingCalendar.has(D) = false`，或基准 bar 缺失 | **阻塞**：不结算、不决策；`pending` 保留；WARN；下次重试 |
| **单标的无数据** | 该标的 `findBarByDate(execBars, D)` 为空，或 `isSuspended` 为真 | **不算全市场故障**：该标的记 `suspended`，其余正常结算 |

**前向日历缺口（必须解决）**：
- 现有 `TradingCalendar` 是**历史日期集合**（由 `sh000001` 的 bar 派生），不能计算「T+1」；
- 纸面决策需要 `nextTradingDay(T)`，必须新增**前向**日历：`工作日 && 不在 raw_holidays`；
- `raw_holidays` 覆盖到 2030；超出范围 → 报 `CALENDAR_OUT_OF_RANGE`，不猜；
- 临时休市若未入库：按「全市场未更新」阻塞并告警，**不自动顺延**；
- 已知节假日（在 `raw_holidays` 中）导致 T+1 非交易日：决策时直接取下一个交易日，不生成无效订单。

**预开盘顺延的唯一允许场景**：
若订单 `trade_date = D`，但 D 在决策后被确认是**已知节假日**（数据未更新、且 `raw_holidays` 命中），
且该订单**尚未发生任何撮合**（`settled_at IS NULL`），允许把 `trade_date` 改为下一个交易日；
这是「日历修正」，不是「成交失败顺延」。一旦 D 有行情并尝试撮合，失败即按 §6 作废，不再改日期。

### 7.4 部分标的无数据

- 单标的缺失 bar → `unfilled_reason='suspended'`、`unfilled_detail='missing-bar'`；
- 单标的 `volume=0` → `suspended`、`zero-volume`；
- 持仓停牌 → 持仓保留、按最近有效收盘估值、`stale_symbol_count + 1`；
- 若**所有**持仓与基准都无 bar → 升级为「全市场未更新」，阻塞，不按停牌处理；
- 若持仓**从未有过有效收盘价** → 中止事务、ERROR、人工核查（不写 0 估值）。

### 7.5 同一天重复跑（幂等矩阵）

| 场景 | 已有状态 | 行为 |
|---|---|---|
| 决策重跑（同日、未结算） | `pending`/`shadow` 行，`settled_at IS NULL` | UPSERT 覆盖；不再出现的标的置 `superseded` |
| 决策重跑（同日、已结算） | 存在 `settled_at` 非空的行 | **锁定**，拒绝重跑（返回 `ALREADY_SETTLED`） |
| 结算重跑（已写 equity） | `paper_equity(account, D)` 存在 | 默认 **SKIP**（幂等） |
| 结算重跑（`force=true`，仅最后一日） | 最后结算日 | 全量回放到 D-1 → 重结算 D；同一事务内 UPSERT；写 WARN |
| 结算重跑（崩溃未写 equity） | `pending` 行仍在 | 直接重做；事务保证原子 |
| 次日发现前一日 pending | `trade_date < 今天` | **先补结算**，再决策；不允许跳过 |
| 账户暂停 | `status='paused'` | 不产生新决策；已有 `pending` 仍结算 |
| 账户关闭 | `status='closed'` | 只读；不再结算/决策 |

### 7.6 多日停机补算

设 `last_settled_date = L`，当前行情最新日为 `T`：

```text
for d in 交易日(L+1 .. T):
    if 存在 pending(trade_date = d):
        结算 d
    else if phase = ledger and catchUp:
        用 asOf = d-1 重放决策 → 生成 pending(trade_date = d) → 结算 d
    else:
        标记 gap（报告中注明「账本断点」）
决策 T+1
```

- **默认 `catchUp = true`（仅 ledger）**：逐日回放「决策 + 结算」，保证账本连续；
- `catchUp = false`：只补已有 pending，缺失的决策日留断点，报告中明确标注；
- 影子期停机**不补算**：影子没有账本，直接从当前日恢复决策；
- 补算行写 `is_replayed = 1`，报告可区分「实时跑」与「事后补算」；
- 补算要求策略版本一致（见 §7.7），否则拒绝并告警；
- 补算使用**当前**标的名称快照（`raw_symbol_name`），可能与停机期间的历史快照不同；
  这是已知偏差，报告中标注 `replayed`，不假装与实时完全一致。

### 7.7 数据修订与账本不可变

- 已结算的历史日**默认不可变**：`tdx2db` 事后修订 T 日 bar，不重写 T 日账本；
- 修订只影响 T 之后的决策与结算；
- 唯一例外：**最后结算日**允许 `force` 重算（全量回放到 D-1 + 重结算 D）；
- 策略代码/版本变化：账户绑定 `(strategy_id, strategy_version)`；不匹配则**拒绝运行**，**只能新建账户**（见 §12.3）；
- 任何「重算」都必须写 `system_log`，记录账户、日期、原因、操作者。

### 7.8 故障分级与 `system_log`

| 级别 | 场景 | 是否阻塞 |
|---|---|---|
| INFO | 每日结算/决策摘要（账户、日期、成交数、未成交数、equity） | 否 |
| WARN | 全市场行情未更新、停牌、缩量成交、重跑跳过、补算 | 部分阻塞（行情未更新会阻塞当日） |
| ERROR | 除权数据读取失败、策略版本不匹配、现金/权益不变量破裂、事务失败 | 阻塞当日，需人工 |

日志复用现有 `system_log`，`category='paper_account'`；不打印 token/密码/完整参数中的敏感值。

---

## 8. 接口与前端（最小）

### 8.1 API 草案

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/paper/accounts` | 创建（`strategy_id`、`strategy_version`、`params`、`initial_cash`、`fee_config_id?`、`name`）；默认 `phase='shadow'`；D6 重复创建 → 409 |
| GET | `/api/paper/accounts` | 当前用户的账户（D6 下至多一条在用） |
| GET | `/api/paper/accounts/:id` | 详情（现金、权益、持仓数、`last_*`、阶段、状态、**策略版本**、费用快照摘要） |
| POST | `/api/paper/accounts/:id/phase` | `shadow → ledger`（手动、单向、冷启动；见 §12.6） |
| POST | `/api/paper/accounts/:id/pause` | 暂停/恢复（`active ↔ paused`） |
| POST | `/api/paper/accounts/:id/close` | 关闭（只读；历史保留；关闭后可新建账户） |
| GET | `/api/paper/accounts/:id/positions` | 当前持仓 |
| GET | `/api/paper/accounts/:id/orders?from&to&status` | 订单/成交/未成交事件 |
| GET | `/api/paper/accounts/:id/equity?from&to` | 净值曲线 |
| GET | `/api/paper/accounts/:id/report` | 指标 + 未成交统计 + 闲置现金 |
| POST | `/api/paper/accounts/:id/run` | 手动补跑（`settle` / `decide` / `catchup`，`force`）；复用同一把进程内锁 |
| GET/POST | `/api/paper/fee-configs` | 当前用户的费用配置（含券商标签；**不含**系统默认行的改权限） |
| PATCH | `/api/paper/fee-configs/:id` | 改配置（仅影响**之后新建**的账户；已开账户走快照） |

约束：
- 所有读接口只返回 `request.user` 自己的账户（`user_id` 过滤）；
- 手动补跑仅 owner（或 admin）；
- 统一 `ok/fail` 包装，与现有路由一致；
- 不提供「手工成交」「改持仓」「改现金」「改初始资金」「出入金」接口；
- 不提供「换策略」「换版本」接口（D4）。

### 8.2 前端

- 独立「纸面账户」页面/卡片，**不混入真实资产仪表盘**；
- 必须固定展示提示：「模拟成交，非真实交易；成交价 = 当日开盘价，账本在当日收盘后更新」；
- 影子期：只展示目标标的/权重/信号，展示「切换为落账运行」按钮（二次确认）；
- 落账期：持仓、订单、未成交事件、净值曲线、指标、未成交次数、闲置现金比例；
- 不做 K 线图（Out-of-Scope 一致）。

---

## 9. 口径一致性与验收

### 9.1 与回测逐位对账（最重要的验收）

**方法**：同一策略、同一参数、同一初始资金、同一区间 `[start, end]`：

0. **前提**：纸面账户的费用快照必须与 `DEFAULT_TRADE_RULES` 逐字段相等（D3 回退链的第 ③/④ 层）；绑定自定义费率的账户**不参与逐位对账**；
1. 跑一次 `runBacktest`，得到逐日 `equity/cash/riskMv/cashMv`、逐笔 `fills`、`skipped`；
2. 用同一份数据、同一策略，逐日跑纸面「决策 → 结算」；
3. 断言：
   - 逐日 `equity`、`cash`、`risk_mv`、`cash_mv` 完全一致（`1e-6`）；
   - 逐笔成交的 `date/symbol/side/qty/price/fee` 完全一致（金额 `0.01`）；
   - 逐笔 `unfilled_reason` 一致；
   - `paper_equity` 的 `benchmark_close/benchmark_stale/exposure/drawdown_ratio` 一致。

这是「没有新造一套口径」的唯一硬证明。

### 9.2 验收清单

| # | 断言 | 类型 |
|---|---|---|
| A1 | 回测 vs 纸面逐日逐笔一致（§9.1） | golden 对拍 |
| A2 | `equity = cash + risk_mv + cash_mv`；`cash >= -0.01`；`qty >= 0` | 每日断言 |
| A3 | 成交价 = 次日 `open × (1 ± 0.0001)`；佣金 = `max(5, notional×0.0001)` | 3 笔手算 |
| A4 | 当日买入不可卖；次日可卖；卖出款当日可用于买入 | 单测 |
| A5 | 涨停买入 → `unfilled`；次日新决策；不产生跨日订单 | 单测 |
| A6 | 停牌 → 持仓不变、无成交、净值沿用最近价、`stale_symbol_count + 1` | 单测 |
| A7 | 同日重跑 → 行数不增、equity 不变、`superseded` 不计入未成交 | 单测 |
| A8 | 崩溃注入 → 事务回滚、`pending` 保留、下次补齐 | 集成 |
| A9 | 除权：先送转后分红、分红基数 = 送转后、成本基不变 | golden |
| A10 | 多日停机补算 vs 一次性回测同区间一致 | 集成（真库） |
| A11 | 影子期不写 `paper_position`/`paper_equity` | 单测 |
| A12 | 全市场无行情 → 阻塞、pending 保留、不误记停牌 | 故障注入 |
| A13 | 策略版本不匹配 → 拒绝运行、不写账本 | 单测 |
| A14 | 改 `paper_fee_config` 后重跑已开账户 → 结算仍用 `fee_snapshot_json`，结果不变 | 单测 |
| A15 | 同一用户建第二个在用账户 → 409 `PAPER_ACCOUNT_EXISTS`；关闭旧账户后可新建 | 集成 |
| A16 | 重置脚本只删 `bt_*`：预置一条 `paper_equity` 后跑清理 → 纸面行仍在 | 单测（临时库） |
| A17 | 回测批量与 17:04 同时写 → 纸面整体重试成功，且无半结算 | 集成（并发注入） |

### 9.3 测试数据

- 复用 `tests/fixtures/golden/*.json`（移动加权成本、RSI/MACD、实现盈亏）；
- 回测 vs 纸面对账需要**真库**（`MARKET_DATA_MODE=full`）或迷你库的数值子集；
- 规模/性能断言必须真库，不能拿迷你库冒充（AGENTS.md 的 `numeric/scale/performance` 三档）。

---

## 10. 风险与不做的事

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | 前视：决策误读 T+1 数据 | 信号虚高 | 决策 loader 截止 `T`；结算 loader 只取 `D`；测试断言决策阶段 `getBars` 的 `end = T` |
| R2 | 用户以为盘中实时成交 | 体验误解 | UI 固定提示「成交价 = 当日开盘价，账本收盘后更新」 |
| R3 | 行情事后修订 | 历史账本与当前数据不一致 | 历史不可变；只允许最后一日 `force`；写日志 |
| R4 | 策略代码/版本漂移 | 纸面与回测/补算不一致 | 账户绑定 `(strategy_id, strategy_version)`；版本缺失 → `paused` + ERROR，不回退最新；**变更只能新建账户**（D4） |
| R5 | 涨跌停 10% 对 20% ETF 误判 | 科创/创业 ETF 可能被误判涨停 | 与回测同一已知偏差；报告标注；未来按标的分档 |
| R6 | 无成交量占比闸门 | 大额订单在纸面上「无限流动性」 | 本期不做（与回测一致）；作为后续账户级可选参数，不默认启用 |
| R7 | 停牌长期不成交 | 持仓卡住、净值 stale | `stale_symbol_count` + 报告告警；不强制清仓 |
| R8 | 除权覆盖不全（配股/合并） | 成本基/份额漂移 | 本期只取 `category=1`；报告标注；人工核查入口 |
| R9 | 订单行增长 | `backtest.db` 体积 | 300 标的 × 250 日 ≈ 7.5 万行/年/账户，可接受；不自动清理 |
| R10 | 并发重跑 | 双写/重复结算 | 复用 `enqueueStage` 串行 + 进程内账户锁；事务 + `paper_equity` 幂等 |
| R11 | `restore` 合成成交丢失 `openDate` | round trips 的持有期不准 | 日结算不用 round trips；报告用全量回放 |
| R12 | 权重和 > 1 | 超配 | 不新增硬校验（与回测一致）；现金约束吸收；WARN 提示策略作者 |
| R13 | 回测清理脚本误删 `paper_*` | 账本不可恢复 | 白名单只删 `bt_*` + 删除前守卫查询 + 专项测试（§12.1） |
| R14 | 回测批量与 17:04 抢写 `backtest.db` | 纸面结算失败/半写 | `busy_timeout` + 有限重试 + `BEGIN IMMEDIATE` + 17:00–17:10 禁跑回测（§12.1） |
| R15 | `backtest.db` 整体删除 | 纸面账本与回测结果一起丢失 | 删除入口二次确认 + 告警；备份默认强制包含 `backtest.db` |
| R16 | 自定义费率与回测口径分叉 | 无法逐位对账 | 仅默认快照参与 A1 对账；自定义费率走「口径对比」，报告标注 |

### 明确不做

- 券商对接、真实委托、外部成交回填；
- 分钟线、盘中实时、盘中信号；
- 融资融券、做空、T+0、期权/期货/外汇；
- 手工补录成交、手工改持仓/现金；
- 出入金、分红再投资、现金利息；
- 股票策略与自定义 `.js` 插件策略（首期）；
- 配股/合并/拆分等非 `category=1` 公司行为；
- 盘口/排队/冲击成本/部分成交（除整手缩量）；
- 纸面权益混入真实资产仪表盘。

---

## 11. 决策定稿（2026-11-07）

> 原文口径照录；「落地条款」是本文的执行翻译，不改原意。**D1–D6 已全部关闭**，不再有「待决策」项。

| # | 定稿口径（原文） | 落地条款 | 影响入口 |
|---|---|---|---|
| D1 | 和 backtest 放一个 db 文件 | `paper_*` 与 `bt_*` 同放 `data/backtest.db`；前缀隔离；备份必须新增 `backtest.db`；清理脚本白名单只作用于 `bt_*`；两进程写需串行化/重试 | §5.5、§12.1 |
| D2 | 手动 | 影子 → 落账**只提供手动 API**；无自动切换、无「N 天后自动转」、无定时任务；切换即冷启动 | §12.6 |
| D3 | 允许用户/券商配置 | 新增 `paper_fee_config`；账户建户时按「账户绑定 → 用户默认 → 系统默认 → 内置 `DEFAULT_TRADE_RULES`」解析并**快照冻结**；写接口统一校验 | §4.3、§12.2 |
| D4 | 锁定版本 | 账户绑定 `(strategy_id, strategy_version)`；运行时**精确匹配**，版本缺失 → `paused` + ERROR，**不回退最新**；版本或参数变更**只能新建账户**，首期不提供原地升级 | §12.3 |
| D5 | 首期不做 | 不做入金/出金：不建 `paper_cash_flow` 表、不提供出入金 API；`initial_cash` 建户后**不可变**（DB 触发器 + API 缺失双保险）；要追加资金只能新建账户 | §12.4 |
| D6 | 单策略单用户 | 一个用户**至多一个在用账户**；该账户**锁定一个策略**；唯一索引 `(user_id) WHERE is_deleted=0 AND status<>'closed'`；重复创建 → 409 `PAPER_ACCOUNT_EXISTS` | §12.5 |

> **D6 理解确认**：本文按「一个用户 → 一个纸面账户 → 该账户锁定一个策略」执行，
> **不是**「每个策略各开一个账户」。若 owner 原意是后者，唯一索引需改为 `(user_id, strategy_id)`，
> 且 §12.5 的 409 语义随之调整 —— **本轮按前者落地**。

---

## 12. 定稿决定的副作用与应对

### 12.1 D1：与回测同库（`backtest.db`）

#### 12.1.1 备份

| 项 | 现状 | 定稿后的要求 |
|---|---|---|
| 备份范围 | 17:05 只备份 `business.db` + 受控 DuckDB | **新增 `backtest.db`**，默认强制，不提供关闭开关（否则纸面账本裸奔） |
| 机制 | `db.backup(path)` 热备份 | 同一机制，按数据库逐个备份；失败逐个记 `system_log` ERROR |
| 体积 | 回测结果 + 纸面账本同文件 | 体积随回测次数增长；若成问题，先归档 `bt_*`（导出/删除旧 run），**不是**关掉备份 |
| 恢复 | 单库恢复 | 恢复顺序：`business.db` → `backtest.db`；两者时间点不一致时以较早者为准并告警 |

改动落点：`apps/backend/src/services/backup.ts`（目标清单）+ `docs/deploy.md`（运维口径，**本文不改**，采纳时同步）。

#### 12.1.2 清理 / 重置 / 重新导入脚本的删除范围

**规则（三条，缺一即缺陷）**：

1. **白名单**：脚本只允许操作 `sqlite_master` 中 `name LIKE 'bt_%'` 且**显式枚举**的表
   （当前至少 `bt_run` / `bt_equity` / `bt_trade` / `bt_round_trip` / `bt_attribution` / `bt_trial` / `bt_metric`）；
2. **删除前守卫**：任何批量删除前先跑
   ```sql
   SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'paper_%';
   ```
   命中 `paper_%` 时，**若本次删除目标集合包含任一 `paper_` 表 → 直接 abort**（不是警告）；
3. **禁止删文件**：`backtest.db` 是纸面账本的载体，`rm` / `del` / `DROP DATABASE` 一律不允许；
   若用户坚持整体重置，必须走独立入口 `--include-paper --i-understand`（二次确认 + 先备份 + 单独审计日志）。

其他要求：
- 重新导入（如「清空回测结果再重跑」）必须在**一个事务**内完成 `DELETE FROM bt_*` + 重插，失败整体回滚；
- `VACUUM` / `ANALYZE` 可执行，不影响 `paper_*`；
- 新增专项测试 A16：预置一条 `paper_equity` → 跑清理脚本 → 断言纸面行仍在。

#### 12.1.3 回测批量写与纸面日更的写冲突

**冲突来源**：两者是不同进程（后端 Fastify / 回测 CLI），共享同一个 SQLite 文件的**单写者锁**；
本仓库历史上出现过行情库句柄占用（DuckDB 文件锁）导致测试与后端互斥，同类问题在 SQLite 上表现为
`SQLITE_BUSY` / `SQLITE_LOCKED`，在 DuckDB 上表现为 `Could not set lock on file`。

**应对（四层，按顺序生效）**：

| 层 | 措施 | 参数/位置 |
|---|---|---|
| 1. 连接层 | `journal_mode=WAL`、`busy_timeout=5000`、`foreign_keys=ON`；连接初始化只做一次 | `store/backtestDb.ts` + 新增 `services/paper/paperDb.ts`（同文件、各自连接） |
| 2. 事务层 | 纸面「单账户单日」用 `BEGIN IMMEDIATE`（避免读→写升级死锁）；整段失败整体回滚，**不半写** | §7.2 |
| 3. 重试层 | 仅对 `SQLITE_BUSY` / `SQLITE_LOCKED` 重试 3 次（50ms / 200ms / 800ms 退避）；其它错误不重试 | `services/paper/retry.ts` |
| 4. 调度层 | **17:00–17:10 禁止触发回测批量**（CLI / API / sweep）；纸面 17:04 与备份 17:05 优先 | `services/scheduler.ts` + CLI 入口校验 |

**失败语义**：重试耗尽 → 纸面当日任务整体失败，`system_log` 记 `PAPER_DB_BUSY`，`pending` 保留，等下一次补算；
**绝不**把写失败降级成「停牌 / 未成交」写进账本。

**DuckDB 句柄**（同库不同系统，单独一条）：
- 纸面每个查询用现有 `queryDuckDB`（按需打开、用完即关），**不在 17:04 阶段持有句柄**；
- 回测批量若长时间持有 DuckDB 读句柄，纸面遇到 `Could not set lock on file` 时视为**环境冲突**，
  按 `PAPER_QUOTE_DB_BUSY` 重试（默认 60s 后重试 2 次），仍失败则整体失败并告警；
- 该错误**不得**映射为 `unfilled_reason='suspended'`（否则会伪造停牌事件）。

### 12.2 D3：费用可配置

**表与关联**

- 配置表：`paper_fee_config`（与 `paper_*` 同库，DDL 见 §5.2）；
- 账户关联：`paper_account.fee_config_id`（溯源）+ `paper_account.fee_snapshot_json`（**执行唯一依据**）；
- 系统默认行：`is_system_default=1`，全库至多一条（部分唯一索引兜底）；
- 用户/券商配置：`user_id` + `broker_name` 标记来源，`is_deleted` 软删除。

**回退链（建户时求值一次）**

```text
账户显式 fee_config_id
  → 该用户 is_system_default=0 的默认配置（约定：同一用户按 created_at 取最早一条，需在 UI 明确“设为默认”）
  → 系统默认行 is_system_default=1
  → 内置 DEFAULT_TRADE_RULES
```

**参数校验（写接口与快照映射共用同一函数）**

| 字段 | 默认 | 允许范围 | 适用性 |
|---|---|---|---|
| `commission_rate` | `0.0001` | `[0, 0.003]` | 买卖双边 |
| `min_commission` | `5` | `[0, 100]` | 每笔最低佣金 |
| `stamp_duty_rate` | `0` | `[0, 0.001]` | **仅卖出**；首期**只允许 0**（见下） |
| `transfer_fee_rate` | `0` | `[0, 0.001]` | 买卖双边；首期**只允许 0** |
| `slippage_rate` | `0.0001` | `[0, 0.02]` | 买 +、卖 − |
| `lot_size` | `100` | `[1, 1000]` | 买入取整 |
| `min_notional` | `10` | `[0, 10000]` | 低于则 `below-min-notional` |
| `price_limit_pct` | `0.10` | `[0, 0.5]` | 涨跌停判定 |

**关键约束（必须写进实现，否则会静默失真）**：

1. **模拟器当前没有印花税/过户费分量**（`TradeRules` 只有 `commissionRate/minCommission/slippageRate/lotSize/minNotional/priceLimit`）。
   因此首期建户时 `stamp_duty_rate != 0` 或 `transfer_fee_rate != 0` → **拒绝**，错误码 `FEE_RULE_UNSUPPORTED`。
   **不允许「存了但不算」** —— 那会让用户以为费率生效。
2. 若未来要支持非零税/费，必须**同时**扩展 `TradeRules` + `simulator` + `packages/core` 的费用口径与 golden，
   并同步回测；否则 A1 逐位对账失效（记为一次口径变更，进 ADR）。
3. **快照冻结**：修改 `paper_fee_config` 不影响已开账户；要换费率 → 新建账户（与 D4/D5 一致）。
4. `fee_snapshot_json` 参与 A1 对账的前提：与 `DEFAULT_TRADE_RULES` **逐字段相等**；否则只做口径对比。

### 12.3 D4：策略版本锁定

**规则（无“视情况”）**

1. 账户创建时写入 `strategy_id`、`strategy_version`、`params_json`，三者共同构成**不可变身份**；
2. 每日运行时按 `(strategy_id, strategy_version)` **精确解析**策略实现；解析不到（版本被删/改名/代码不兼容）→
   `status='paused'` + `system_log` ERROR，**当天不决策、不结算**，`pending` 保留；
3. **不自动跟随最新版本、不回退到“最接近的版本”**；
4. **版本升级 / 参数变更的唯一路径 = 新建账户**：关闭旧账户（`status='closed'`，历史保留）→ 建新账户（冷启动）；
5. 首期**不提供** `POST /paper/accounts/:id/upgrade-version`；若未来要做原地升级，必须单独立项（涉及历史重算与不可变性），不在本期范围；
6. UI 必须展示 `strategy_version` 与建户时间，报告页脚带版本，便于解释「为什么同一策略两个账户结果不同」。

### 12.4 D5：不做出入金

- **不建表**：没有 `paper_cash_flow` / `paper_deposit` / `paper_withdraw`；
- **不提供接口**：没有入金、出金、改初始资金、分红再投资、现金利息的 API；
- **不可变兜底**：`trg_paper_account_initial_cash_immutable`（DDL 见 §5.2）在 DB 层拒绝 `UPDATE initial_cash`；
- **现金变动只有两条来源**：成交（含费用）与现金分红；实现收益留在 `cash`，**不可提现**；
- **追加资金**：只能关闭旧账户 → 新建账户（新初始资金、冷启动）；旧账户账本永久保留供对比；
- 报告必须明确「本账户无可入金/出金，现金变化全部来自模拟成交与分红」。

### 12.5 D6：单用户、单账户、单策略

| 约束 | 实现 | 失败语义 |
|---|---|---|
| 一个用户至多一个在用账户 | 部分唯一索引 `ux_paper_account_live_user (user_id) WHERE is_deleted=0 AND status<>'closed'` | 建户返回 409 `PAPER_ACCOUNT_EXISTS`，提示先关闭旧账户 |
| 账户锁定一个策略 | `strategy_id` + `strategy_version` 建户后不可变；无「换策略」接口 | 换策略 = 新建账户 |
| 用户归属校验 | `user_account` 在 `business.db`，**无跨库外键**；建户时服务层查 `user_account` 存在且 `is_deleted=0` | 不存在 → 400 `USER_NOT_FOUND` |
| 关闭与重建 | `status='closed'` 允许新建；软删除（`is_deleted=1`）同样允许新建；历史行永久保留 | — |

> 🔒 **不要用 `UNIQUE(user_id, strategy_id, name)` 代替**：那等于允许同一用户对同一策略开多个账户，与 D6 冲突。

### 12.6 D2：手动切换（补充）

- 唯一入口：`POST /api/paper/accounts/:id/phase`，`{ to: "ledger", confirm: true }`；
- 前置条件（全部满足才允许）：`phase='shadow'`、`status='active'`、无 `pending` 未结算行、`ledger_start_date IS NULL`；
- 切换动作（同一事务）：`phase='ledger'`、`cash=initial_cash`、清空 `paper_position`、`ledger_start_date=nextTradingDay(T)`、`last_decision_date/last_settled_date=NULL`；
- 影子期 `paper_order` 行**永久保留**，不删除、不改状态；
- 无自动切换：不按天数、不按信号质量、不按 Gate 通过自动转。

---

## 13. 实现任务拆分（提案）

> 任务 ID 用 `PA-xx` 前缀，避免与 `plan_v3` 的 `Txxx` 冲突；采纳后由 owner 映射进 `code_implementation_plan_v3.md`。
> 每个任务都要求「一次可完成 + 可独立验收」；未过本阶段验收不得进入下一阶段。

### 13.1 阶段与依赖

```text
S0 底座抽取（不改行为）
  PA-01 → PA-02
  PA-03（独立）
  PA-04（独立）
        ↓
S1 表与配置
  PA-05 → PA-06 → PA-07
        ↓
S2 影子运行
  PA-08 → PA-09
        ↓
S3 落账运行
  PA-10 → PA-11 → PA-12
        ↓
S4 前端与验收
  PA-13 → PA-14
  PA-15（收口）
```

### 13.2 任务清单

| ID | 阶段 | 改哪些文件/模块 | 依赖 | 产出（可验证） |
|---|---|---|---|---|
| **PA-01** | S0 | `apps/backend/src/services/backtest/engine.ts`：抽出 `stepBacktestDay()`（含 `targetsOverride` / `equityAtCutoffOverride`），`runBacktest` 改为调用它 | 无 | 重构前后同一组 golden 回测**逐位一致**；新增单测覆盖「除权→成交→净值」顺序 |
| **PA-02** | S0 | 同上：导出 `makeContext()` / `capTurnover()`（命名按仓库风格） | PA-01 | 回测全量测试全绿；纸面可直接调用且不复制逻辑（导出函数被回测自身复用即证明） |
| **PA-03** | S0 | `apps/backend/src/services/backtest/account/portfolio.ts`：新增 `restore(positions, cash)` | 无 | 单测：恢复后 `equity/avgCost/costBasis/closeableQty` 与原 `Portfolio` 完全一致；`boughtToday = qty − closeable_qty` 可复现 T+1 冻结 |
| **PA-04** | S0 | `apps/backend/src/services/backtest/calendar.ts` + `raw_holidays`：新增 `nextTradingDay()` | 无 | 单测：周五→周一、节假日前夕、长假、跨年；与历史日历交叉验证（历史日期上 `nextTradingDay` 必须等于下一根 bar） |
| **PA-05** | S1 | `apps/backend/src/services/backtest/store/backtestDb.ts`（或新增同库 `paperSchema.ts`）：建 `paper_account/position/order/equity/fee_config` + 索引 + 触发器 | PA-03（restore 的字段要求） | 临时库连续执行两次 schema 无差异；`ux_paper_account_live_user` 与 `initial_cash` 触发器各有单测；`paper_*` 与 `bt_*` 同文件共存 |
| **PA-06** | S1 | 新增 `apps/backend/src/services/paper/fees.ts`：配置 CRUD + 校验 + `feeSnapshotToTradeRules()` + 回退链 | PA-05 | 四层回退链单测；非法值拒绝；`stamp/transfer != 0` → `FEE_RULE_UNSUPPORTED`；快照冻结测试（A14） |
| **PA-07** | S1 | 新增 `apps/backend/src/services/paper/accountService.ts` + `apps/backend/src/routes/paper.ts`：建户、查询、关闭、手动切阶段 | PA-05、PA-06 | A15（409 `PAPER_ACCOUNT_EXISTS`）；跨库用户校验；切阶段冷启动断言（cash/position/水位重置） |
| **PA-08** | S2 | `apps/backend/src/services/scheduler.ts` 新增 17:04 段 + 新增 `services/paper/decision.ts`：影子决策，写 `paper_order(status='shadow')` | PA-02、PA-04、PA-07 | A11（影子不写 `paper_position`/`paper_equity`）；`waitForQuoteUpdate=true`；同日重跑行数不增；17:00–17:10 回测禁跑校验 |
| **PA-09** | S2 | 新增 `services/paper/report.ts` + 只读路由：影子期信号稳定性/目标数/无 bar 统计 | PA-08 | 报告数值与 `paper_order` 对账；不读 `paper_position`（影子期为空） |
| **PA-10** | S3 | 新增 `services/paper/settle.ts`：恢复 `Portfolio` → `startDay` → 除权 → `executeTargets` → 写成交/持仓/现金/净值（单事务） | PA-01、PA-03、PA-06、PA-08 | A2/A3/A4；崩溃注入回滚（A8）；账本恒等式逐日断言 |
| **PA-11** | S3 | `services/paper/settle.ts` + `report.ts`：未成交事件、缩量成交、三项闲置现金口径 | PA-10 | A5/A6；`unfilled_reason` 与 §6.2 映射逐条一致；报告指标可复算 |
| **PA-12** | S3 | `settle.ts` + `scheduler.ts` + 新增 `services/paper/retry.ts`：幂等、补算、`SQLITE_BUSY` 重试、DuckDB 句柄冲突语义 | PA-10、PA-11 | A7/A10/A12/A17；`PAPER_DB_BUSY` / `PAPER_QUOTE_DB_BUSY` 不落成 `suspended` |
| **PA-13** | S4 | `routes/paper.ts` 只读接口：账户、持仓、订单（含未成交）、净值曲线、报告摘要 | PA-09、PA-11 | 集成测试（`app.inject()`）；权限隔离（只能看自己账户） |
| **PA-14** | S4 | `apps/frontend/src/api/*` + `apps/frontend/src/pages/*`：纸面账户页，分区展示 + 「非真实交易」固定提示 | PA-13 | 组件测试；与真实资产仪表盘分区；文案固定 |
| **PA-15** | S4 | `apps/backend/tests/**` + `scripts/**`：A1 逐位对账、A14–A17、清理守卫、`backtest.db` 备份包含性 | PA-12、PA-13 | 全量测试绿；对账报告落 `docs/audit/`；备份清单含 `backtest.db` |

### 13.3 各阶段 Gate（不过不得进下一阶段）

| 阶段 | Gate | 硬指标 |
|---|---|---|
| S0 | 回测行为不变 | golden 逐位一致；后端全量测试绿 |
| S1 | 表与配置只增不改行为 | schema 幂等；费用回退/校验/冻结全绿；现有回测与业务接口零回归 |
| S2 | 影子不落账 | 影子期 `paper_position`/`paper_equity` 行数为 0；同日重跑幂等 |
| S3 | 账本正确 | A1–A8、A10、A12、A17；`equity` 恒等式零漂移 |
| S4 | 可用与可解释 | A14–A16；前端提示到位；备份/清理守卫有测试 |

> 与 `AGENTS.md` 的关系：本文是**提案**；采纳后 D1–D6 进 `SDD_v3.md`，任务映射进 `code_implementation_plan_v3.md`，
> 关键取舍（同库、费用可配置、版本锁定）进 `docs/adr/`。

---

## 附录 A：术语

| 术语 | 含义 |
|---|---|
| 影子运行 | 只写信号意图，不写持仓/净值 |
| 落账运行 | 正式写成交、持仓、现金、净值 |
| 意图（intent） | 决策阶段生成的一行目标/清算计划，带 `signal_id` |
| 未成交事件 | `paper_order.status='unfilled'` 的行，含标的、原因、金额 |
| 检查点 | `paper_position` + `paper_account.cash`，截至 `last_settled_date` |
| 缩量成交 | 有成交但 `filled_notional < intent_notional`（按整手/现金约束） |
| 现金桶 | 现金 + 现金类 ETF 市值 |
| 全市场未更新 | 交易日但全市场基准/日历无数据；阻塞，不按停牌处理 |
| 费用快照 | 建户时把命中的费率/规则序列化进 `fee_snapshot_json`，之后只读它 |
| 版本锁定 | 账户身份绑定 `(strategy_id, strategy_version, params_json)`，不自动跟随最新 |
| 同库前缀隔离 | `paper_*` 与 `bt_*` 同放 `backtest.db`，靠前缀划分清理/备份边界 |

## 附录 B：代码锚点

| 主题 | 文件 | 关键点 |
|---|---|---|
| 策略接口 | `apps/backend/src/services/backtest/strategy/types.ts` | `Strategy` / `TargetSet` / `TargetPosition` / `StrategyContext` / `warmupDays` |
| 成交模拟 | `apps/backend/src/services/backtest/execution/simulator.ts` | `DEFAULT_TRADE_RULES`、`executeTargets`、`SkipReason`、`Fill`、`SkippedOrder` |
| 账户/成本/除权 | `apps/backend/src/services/backtest/account/portfolio.ts` | `startDay`、`applyFill`、`applyCorporateActions`、`position()`、`roundTrips` |
| 日循环 | `apps/backend/src/services/backtest/engine.ts` | `runBacktest` 的日内步骤、`capTurnover`、`makeContext`、`closeAtOrBefore` |
| 历史日历 | `apps/backend/src/services/backtest/calendar.ts` | 仅历史日期；无前向 `nextTradingDay` |
| 除权装载 | `apps/backend/src/services/backtest/corporateActions.ts` | `loadCorporateActions`（`raw_gbbq.category=1`，`c1/10`、`c3/10`） |
| 行情面板 | `apps/backend/src/services/backtest/marketPanel.ts` | `getBars`（一次 `IN`）、`isSuspended`、`findBarByDate` |
| 时点池 | `apps/backend/src/services/backtest/universe/pointInTime.ts` | `resolveUniverseAt`（ETF 口径） |
| 指标 | `apps/backend/src/services/backtest/metrics/metrics.ts` | `EquityPoint`、`computeMetrics` |
| 调度 | `apps/backend/src/services/scheduler.ts` | 17:01/17:02/17:03/17:05、`enqueueStage`、`waitForQuoteUpdate`；**新增 17:04 纸面段** |
| 业务 DDL 风格 | `apps/backend/src/config/configStore.ts` | `user_account`、`is_deleted`、`created_at`、部分唯一索引约定 |
| 真实信号链路 | `apps/backend/src/services/signalService.ts` | `user_strategy_signal.linked_trade_id`（纸面**不复用**） |
| 备份 | `apps/backend/src/services/backup.ts` | `business.db` 每日备份；**D1 后须新增 `backtest.db`** |
| 回测库 | `apps/backend/src/services/backtest/store/backtestDb.ts` | `BacktestStore`、`resolveBacktestDbPath`（`paper_*` 同库落位） |
