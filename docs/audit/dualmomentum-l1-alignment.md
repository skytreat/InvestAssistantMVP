# DualMomentum L1 实现说明（DAS-2 / DAS-2.1 对齐核对）

> 状态：L1 已实现并自测通过（29/29）。**2026-11-09 更新**：已接入 `Strategy` 适配器与纸面白名单，
> 当前状态见 §8；纸面保真边界见 §9（方案 D 显式接受）；§7 保留为 L1 阶段的历史方案。
> **对齐结论未成立**：指标 golden 只证明公式等价，数据源尚未同源（见 §4.5），需等 §5 快照。
> 规格权威源：`docs/audit/decision_alignment_spec.md`（DAS-3.1）。
> 记录时间：2026-11-08（§8–§10 追加于 2026-11-09）。

## 1. 交付物

| 文件 | 作用 |
|---|---|
| `apps/backend/src/services/backtest/strategies/dualmomentum/l1/types.ts` | 类型：`PriceBar` / `SymbolSeries` / `MarketSlice` / `RejectReason` / `L1DecisionRow`（§6.2 第 1–25 列） |
| `.../l1/params.ts` | §2 锁定参数、池顺序、jq 代码映射、`INDICATOR_LOOKBACK=60`、三种 combo 槽位 |
| `.../l1/indicators.ts` | WSM V2 / NDAY / RSRS Z / MA，`precalcIndicators` 复刻「不足 60 根整体短路」 |
| `.../l1/series.ts` | `F(t)` 归一、窗口前复权、`prev_close_adj`、停牌取「最近可用 bar」 |
| `.../l1/decisions.ts` | 过滤链（§3.3 第 1–9 步，可逐条单测）+ 排名/截断（第 10 步）+ 逐日行 |
| `.../l1/csv.ts` | `decisions.csv` 序列化（§6.1/§6.2，33 列，L2 列占位） |
| `.../l1/format.ts` | 复刻 Python `format(v,'.17g')` |
| `apps/backend/tests/fixtures/dualmomentum/l1_indicator_golden.json` | 由 QuantInvest `indicators.py` 生成的指标 golden（21 个 60 根窗口） |
| `apps/backend/tests/fixtures/dualmomentum/gen_l1_golden.py` | 上述 golden 的生成脚本（保可复现） |
| `apps/backend/tests/unit/dualmomentumL1Indicators.test.ts` | 指标 golden 逐位 + 短路/退化守卫（8 例） |
| `apps/backend/tests/unit/dualmomentumL1Decisions.test.ts` | 过滤链/排名/边界（16 例） |
| `apps/backend/tests/unit/dualmomentumL1Csv.test.ts` | 列序/`.17g`/空值/占位（4 例） |

设计取向：**L1 是纯函数库，零 IO**。数据切片 `MarketSlice` 由调用方注入，本层不读实时行情库
（对应用户要求「不要默认取实时库」）。

## 2. 已对齐 DAS-2 的判据

### 2.1 指标（§3.2）

| 判据 | 实现 |
|---|---|
| WSM 窗口 25、`w=linspace(1,2,25)`、V2 | `calcWeightedSlopeMomentum`，`USE_WSM_V2=true` |
| `np.polyfit(...,w=w)` 的**法方程权重是 w²** | 闭式解全部用 `w2 = w[i]*w[i]`（§3.2(a) 明示「注意是 w²，不是 w」） |
| 年化 `exp(slope*250)-1`；`score=annualized*r2` | 同式；非有限 → `0` |
| V2 的 R² 用**一次方 w** 加权残差 | `ssResidual/ssTotal` 用 `w[i]`，非 `w2`（照 Python 参考实现） |
| NDAY 25 年化 `(close[-1]/close[-25])^(250/25)-1` | `calcNdayReturnMomentum` |
| RSRS 25/25、总体矩（÷25）、`raw=slope*r2`、`Z` 用**当前值之前** 25 个 raw、总体标准差 `ddof=0`、有效历史 <2 → `0` | `calcRsrsZ` |
| RSRS 质量过滤锁定关闭 | `RSRS_ENABLE_QUALITY_FILTER=false`，代码内分支保留但永不生效 |
| MA 5/10/20/60 | `calcMa` |
| `needed=max(25,25,25+25,60)=60` | `INDICATOR_LOOKBACK` |
| **`len<60` 整体短路返回 0，不是逐指标退化** | `precalcIndicators` 直接返回 `{wsm:0,nday:0,rsrs:0,ma:{}}`；`ma` 留空 → 后续必然 `BELOW_MA20`（单测断言） |

指标 golden 用 21 个窗口与 `indicators.py` 逐位比对，相对容差 `1e-9`，全部通过。

### 2.2 连续序列与复权（§3.1a / §9.14）

| 判据 | 实现 |
|---|---|
| `adj(t)=raw(t)×F(t)/F(T)`，O/H/L/C 同式 | `forwardAdjustWindow` |
| `prev_close_adj(T)=raw(T−1)×F(T−1)/F(T)` | `calcPrevCloseAdj` |
| `adj(T)==raw(T)`（MA 与 raw 快照价同量纲可直接比） | 窗口末位因子归一为 1 |
| 停牌用「最近可用 bar」序列，**不得置空** | `lastIndexOnOrBefore` + `has_bar` 只表示「T 日有没有 bar」 |
| 停牌时 `hfq_factor` 取最近有效 bar 的因子 | `normalizeFactor(bar.hfqFactor)` |
| 不假设因子单调（§9.14） | 只做乘法，不做单调性判断 |
| `lastIndex==0` 时无前收 → 前收=当日收盘（短路 `prev_close=close[-1]`） | `calcPrevCloseAdj` |
| 前复权**只用于指标**；涨跌幅/涨跌停/成交价用 raw | `close_raw` 与 `prev_close_adj` 分开存 |

### 2.3 过滤链与排名（§3.3）

顺序与短路完全照抄，`evaluateL1Filters` 为导出的纯函数（单测逐条打）：

`POOL_ABSENT → SUSPENDED → COOLDOWN → AT_LIMIT → DAILY_CHANGE_OUT_OF_RANGE →
BELOW_MA20 → MA_NOT_BULLISH → MOMENTUM_OUT_OF_RANGE → BELOW_BENCHMARK → RANK_TRUNCATED`

| 陷阱 | 处理 |
|---|---|
| §9.3 涨跌停「触及即算」 | `price >= upLimit \|\| price <= downLimit`（`up/down = prev_close_adj×(1±limit)`，limit 默认 `0.10`，不 `round`） |
| §9.5 涨跌幅 `1e-9` 容差 | `DAILY_CHANGE_EPSILON=1e-9`，闭区间 `[-0.05,+0.05]` |
| §9.4 MA 全严格 | `price > MA20`；`MA5>MA10>MA20>MA60` |
| §2.3 槽位量纲随 combo 变 | `MOMENTUM_OUT_OF_RANGE` 作用在**槽位**上：`[wsm_min,wsm_max]=[0,5]` 作用于主槽（wsm 或 nday），`[rsrs_min,rsrs_max]=[0,2]` 作用于次槽（rsrs 或 wsm） |
| §9.2 基准 `>=` 含等于 | `primary >= benchmarkPrimary` |
| §9.6 并列靠稳定排序 + 池内顺序 | `Array.prototype.sort((a,b)=>b.primary-a.primary)`（V8 稳定）+ 输入顺序即 `POOL_ORDER` |
| 排名只给通过 1–9 步的行；`selected = rank ≤ 6` | 同 |
| `RANK_TRUNCATED` 行仍 `filter_pass=1`、`rank` 有值、`selected=0` | 同（单测断言 `rows[0].filter_pass=true` 且 `selected=false`） |
| 不得增加表外过滤（如「零成交量不得入选」） | 零量 bar **照常参与 L1**：`tradable_today=0`，步骤 4/5/6 的 `price` 顺延「最近有效收盘」（D1） |

### 2.4 导出格式（§6.1 / §6.2）

- 33 列表头逐列照抄（第 8 列名 `prev_close_raw` 但语义是「除权调整后前收」，按规格照抄命名）。
- 数值 `format(v,'.17g')`（自实现，非 `toPrecision`）：`0.1→0.10000000000000001`、
  `1e-5→1.0000000000000001e-05`、`Math.PI→3.1415926535897931` 均逐字符断言。
- 布尔 `0/1`；空值 = **空字段**（不是 `nan`/`None`/`NULL`）。
- 行序 `trade_date` 升序、同日按 `POOL_ORDER`；7 只每天都有且仅有 1 行（未上市/停牌用 `in_pool=0/has_bar=0` 表示，不省略行）。
- 第 26–33 列（L2 字段）本层占位：`target_weight=0`、`action=NONE`，其余空。

## 3. 留给 L2 的项（本层不实现）

| 项 | 原因 |
|---|---|
| 第 26–33 列真实值：`target_weight` / `action` / `action_reason` / `blocked_reason` / `days_since_entry` / `position_qty` / `unit_cost` / `high_watermark` | 需要组合状态；Python 侧正在把成交时点改成 **T+1 开盘**（DAS-3），语义未稳定 |
| §3.4 全部组合逻辑（卖出优先级 STOP_LOSS / TAKE_PROFIT / NORMAL_REBALANCE / OVERWEIGHT、买入预算 33% 上限、均分含已持仓） | 同上 |
| §4 执行层（T+1 开盘成交、一字板买不进、停牌当日订单失效不顺延） | 同上 |
| **COOLDOWN 步骤的真实触发** | 冷却只由 L2 的 `STOP_LOSS`/`TAKE_PROFIT` 卖出产生；L1 只留了注入点 `cooldownUntil(symbol, tradeDate)`，默认 `null` ⇒ 第 3 步恒不触发、`cooldown_until` 列恒空 |
| §9.1 `min_hold_days` / `days_since_entry` **自然日**差 | 纯 L2 概念，本层不产出该列（避免把「注释写交易日、代码算自然日」的坑写进 L1 又被误用） |
| §9.7–§9.12（现金均分含已持仓、超限减仓分母不含现金、部分减仓 <100 股转全卖、加仓不重置成本/最高价、冷却只由止盈止损触发、冷却窗口 `sell_date < T ≤ end_date`） | 全部依赖持仓与成交 |
| §9.15 分红/折算分列（`c1` 每 10 份、`c3` 份额乘子）、bfq 账本调股数 | 记账层（L2 / 数据适配），L1 只用 `F(t)` 做前复权 |

## 4. 数据同源：可行性判断与结论

### 4.1 实测证据（2026-11-08，`data/quotes.duckdb`，`read_only`）

| 探测 | 结果 |
|---|---|
| `SELECT * FROM _meta` | `[('schema_version','6.0')]` —— **只有 schema 版本，没有数据版本号/批次号** |
| 8 只标的（7 只池 + `sh000300`）`max(date)` | 全部 `2026-11-06`；bar 数 1788（513000，2019-06-25 上市）～ 5304（000300） |
| `raw_adjust_factor` 覆盖 | 逐日全量（条数与 bar 数一致、无重复），可与 `raw_kline_daily` 按 `(symbol,date)` 直连 |
| `v_etf_qfq` 类视图 | 锚点是**最新因子** ⇒ 新分红会改写历史数值，**不可用于对齐** |

### 4.2 两个层面要分开看

**(1) 数值层面：L1 对未来 bar 不敏感。** L1 每个决策行只回看截至 T 的 bar（指标回看窗口、
`prev_close_adj` 只用 T−1），所以**追加新 bar 不会改变已冻结 cutoff 的历史决策行**。
因此「锁 `cutoff_date` 的库内数据 + 每次查询带 `date <= cutoff`」在数学上足以得到同一批数值。

**(2) 可复现层面：库内数据无法自证「历史未被改写」。** `_meta` 无版本号，
而 `tdx2db` 每次运行可能重刷历史 bar、`hfq_factor` 也会在分红/折算事件后重算。
既然没有版本字段，事后**无法证明**某次对齐用的历史行与今天一致。⇒ 不能只锁 cutoff。

### 4.3 结论

**对齐阶段必须用 DAS-2 §5 的一次性快照（4 文件 + `meta.json` 里的 sha256），不能读实时库。**
理由有三条：

1. **唯一能证明「双方输入完全相同」的手段**：Python 参考端 `local_data.py` 当前从 **AKShare**
   （`fund_etf_hist_em` / `fund_etf_hist_sina`）下载并缓存到 `data_cache/daily/*.csv`，
   与 MVP 的 DuckDB（tdx2db 来源）不是同一份物理数据 —— 即使重叠区间数值一致（见 §4.5），
   也无法覆盖全区间、无法给出可追溯的版本凭证。不导出同一份物理快照，逐位对齐的前提就不成立。
2. 库内**没有**数据版本号/导出时间，无法事后追溯（见 4.2(2)）。
3. §5.2 要求的 `calendar` / `holidays` / `bars` / `suspensions` 四份分离结构，
   是「停牌日不得从日历消失」的载体；直接从库里算「有效交易日」会把停牌合成掉，
   导致年化持有天数与 T+1 目标日错位（§5.2 末段已说明）。

### 4.4 因此本层的输入约定（已按此实现，未越界）

```
L1 只消费注入的 MarketSlice：
  tradingDays     ← 快照 calendar 里 is_trading_day=true 的日期（升序）
  symbols[].bars  ← 快照 bars 的 raw OHLC + volume/amount + hfq_factor（缺失即停牌，不前向填充）
  benchmarkBars   ← sh000300 的 raw bar
```

⚠️ **待办（接入时必须做）**：`tradingDays` 应取「快照 calendar」而非「基准 bar 日期」。
本地验证脚本临时用了 `sh000300` 的 bar 日期；当前库里 2019–2026 两者差 0（§5.2 已核对 1902=1902），
但换标的/换区间后不等价 —— 已按 D3 裁定写进规格（`DAS-2.1` §5.2），接入时不可沿用。

### 4.5 golden 的来源，以及它能证明什么

| 问题 | 答案 |
|---|---|
| 谁生成的 | 我在 worktree 里用 `apps/backend/tests/fixtures/dualmomentum/gen_l1_golden.py` 生成，产物入库 |
| 吃什么数据 | **确定性合成序列**（80 根，`3.0*exp(0.0006i + 0.03*sin(i/7))` 加 O/H/L 的确定性扰动），**不读任何真实行情源**，与 AKShare / DuckDB 都无关 |
| 在什么环境跑出期望值 | 本机 Python + numpy，直接 import QuantInvest `indicators.py`（`calc_weighted_slope_momentum` / `calc_nday_return_momentum` / `calc_rsrs` / `calc_ma`） |
| 它能证明什么 | **只证明公式等价**（w² 法方程权重、R² 一次方权重与未加权 `ȳ`、RSRS 总体矩、NDAY 年化、MA） |
| 它不能证明什么 | **不能证明数据同源**，也不能替代端到端决策序列比对 |

所以「单测全绿」和「L1 与 Python 端到端一致」是两件事。下面是对数据源的独立核对。

**两源 bar 逐根核对（2026-11-08，`data_cache/daily/*.csv` vs `DuckDB raw_kline_daily`）**

| 项 | 结果 |
|---|---|
| 缓存实际是 **raw，不是 hfq** | 逐根比对 csv 与 `raw_kline_daily`：7 只 ETF 在 **1138 个重叠日**上 OHLC **相对差 = 0**（逐位相同）。代码虽传 `adjust='hfq'`，落盘的是不复权价 |
| 日期对齐 | 重叠 1138 = CSV 全部行数，**无缺日、无多余日** |
| 成交量（ETF） | `db/csv` 中位数 = **1**（单位一致） |
| 成交量（基准 `sh000300`） | `db/csv` 中位数 = **0.01** ⇒ **单位差 100×** |
| 价格精度（基准 `sh000300`） | 相对差最大 **1.5e-6**（4511 个字段 > 1e-9）⇒ **逐位对齐会失败** |
| 覆盖区间 | CSV 仅 **2022-01-04 ~ 2026-09-11**（1138 根）；DuckDB 自 2012 起、截至 **2026-11-06** ⇒ **Python 侧当前产不出 2019-01-02~2026-11-06 窗口** |

结论：重叠区间内「日期 + ETF 的 OHLCV」确实逐根逐位相同（不是巧合），但：

1. 缓存是 **raw**，而 DAS-2 要求指标用「前复权到当日」⇒ 在有公司行为的 4 只
   （`sh510300` 年度分红、`sh510500`/`sh513100`/`sh513500` 份额折算）上，两侧指标**输入必然不同**，
   端到端不可能一致。这是 Python 侧数据适配层的缺陷（`adjust='hfq'` 未落到缓存），
   与他们切换到 §5 快照的工作正好一致。
2. 覆盖区间不足 §7.6 的窗口。
3. 基准有 1e-6 精度差 + 100× 成交量单位差。

因此：**当前 golden 通过不等于 L1 对齐结论成立**；正式对齐必须等 §5 四文件快照 + `sha256`
到手后两侧读同一份快照重做。在此之前不注册 `BUILTINS`。

## 5. 三处差异的裁定结果与实现

规格（DAS-2）已按裁定更新为 `DAS-2.1`（2026-11-08）：§3.2(a) 明确 `ȳ` = 未加权均值、
§3.3 补充规定写入快照价口径、§5.2 写入「日历只取 `calendar.parquet`」、§10.1 记录数据源核对。

| # | 项 | 裁定 | 本层实现 |
|---|---|---|---|
| D1 | 零成交量占位 bar 的快照价 | 跟 Python：取 `last_valid_close`；`tradable_today=0` 控制可成交性；过滤照常。**规格标注为「对齐选择，非数学唯一解」** | `decisions.ts` 新增 `lastUsableCloseOnOrBefore`，`L1FilterInput.snapshotPrice` 承担步骤 4/5/6 的 `price`；列 8 `close_raw` 仍记当日 bar 自身收盘 |
| D2 | WSM R² 分母 `ȳ` | 跟 Python：未加权均值。**规格标注为「已知偏差点」**，理由：现阶段对齐是唯一可验证判据 | 未改动（原本即如此），`indicators.ts` 注释保留该理由 |
| D3 | 交易日历 | **必须取 `calendar.parquet`**，禁止由 `sh000300` bar 推断 | 代码已接受注入的 `tradingDays`（未自造日历）；接入时由快照 calendar 提供 |
| D4 | `in_pool` 语义 | 采「T 日或之前有 bar」 | 与 §6.2 列 4 注释（513000 于 2019-06-25 前为 0）一致 |

D1 的数据核对（本次实测）：池内零成交量 bar 恰好 **3 根** —— `sh510500 2015-04-13`、
`sh513100 2022-01-13`、`sh513500 2022-03-29`，全部 `O=H=L=C` 且**收盘价等于前一有效收盘**。
其中 2 根落在 2019-01-02~2026-11-06 区间内。因此两种口径在现有数据上**结果完全相同**，
D1 是为「未来出现非 `O=H=L=C` 形态的占位 bar」预留的正确性，不是当前数值的修正。

**残余差异（非本层职责）**：参考实现 `min_hold_days` 按**自然日**差计算（代码与注释都写「交易日」），
属 L2；本层不产出该列，避免把该坑带进 L1。

## 6. 验证记录

| 项 | 结果 |
|---|---|
| 单测 | `dualmomentumL1Indicators` 8 + `dualmomentumL1Decisions` 17 + `dualmomentumL1Csv` 4 = **29/29 PASS**（Prettier 后重跑仍全绿） |
| `npm run typecheck -w @invest/backend` | PASS（`tsc --noEmit`，无输出） |
| 真实库切片（`2019-01-02 ~ 2026-11-06`，7 只 + 基准） | **13,314 行 = 1902 交易日 × 7 标的**，耗时 **916ms** |
| 原因码分布 | `BELOW_MA20` 5571 / `MA_NOT_BULLISH` 3783 / `MOMENTUM_OUT_OF_RANGE` 1873 / `PASS` 1574 / `BELOW_BENCHMARK` 285 / `POOL_ABSENT` 114 / `DAILY_CHANGE_OUT_OF_RANGE` 105 / `AT_LIMIT` 8 / `SUSPENDED` 1 |
| 每日选中数分布 | 1:550 / 2:277 / 3:107 / 4:23 / 5:9 / 6:2（有选中的交易日 968 天） |
| 首条选中行 | `2019-01-02 sh518880`（`wsm_v2=0.52515…`，该日其余标的均 `BELOW_MA20`，符合 60 根预热后的首日行为） |
| 边界单测覆盖 | 恰好 ±5%（含 `1e-9` 容差内/外）、涨跌停（3.3003 / 2.6997）、停牌、零量 bar（`tradable_today=0` + 快照价顺延）、冷却、513000 未上市、不足 60 根、MA20 缺失、动量开闭区间、基准 ≥、7 只全通过时的排名与截断、序列乱序抛错 |
| **对齐结论状态** | **未成立**：golden 仅证明公式等价；数据源核对发现 Python 缓存为 raw（非 hfq）、区间不足、基准有 1e-6 精度差与 100× 成交量单位差（§4.5）。等 §5 快照到手后重做 |

`POOL_ABSENT=114` ≈ 513000 上市前（2019-01-02 ~ 2019-06-24）的交易日数，与 §6.2 列 4 的说明一致。
上表的切片结果在 D1 改动前后**不变** —— 区间内 2 根占位 bar 的收盘价等于前一有效收盘，
两种口径同值（见 §5）。

## 7. 若要接入 `BUILTINS`（仅方案，未实施）

> 2026-11-09：本节是 L1 阶段的留档；实际接入方式与状态见 §8，**不要按本节实施**。

用户要求「若需要注册进 `BUILTINS`，先单独说明方案」。当前**未注册**，L1 是纯函数库；
且按裁定 **§5 快照到手、正式对齐通过之前不注册**。接入需三步，
且**不在本次范围内**：

1. **适配器**：`buildMarketSlice(cutoffDate)` —— 从快照/或锁 cutoff 的行情层一次 `IN (...)` 取
   7 只 + 基准的 raw OHLCV 与 `hfq_factor`（遵守「批量一次查询、DuckDB 只读、按需开关」）。
2. **策略壳**：把 L1 的 `selected` 转成插件 `Signal[]`；此时**必须**先确定 L2 的语义（T+1 开盘），
   否则 `action`/`blocked_reason` 无从填。
3. **注册与沙盒**：`BUILTINS` 注册 + `execute()` 50ms 硬限。L1 全窗口 1902 天 916ms，
   单日约 0.48ms，50ms 余量充足；但**不能**把全量决策行塞进插件返回值，应只返回当日的行。

在此之前不动 `BUILTINS`、`pluginEngine.ts`、`routes/signal.ts`、`signalService.ts`、`SDD.md`。

## 8. 当前接入状态（Strategy 适配器 + 纸面白名单）

| 位置 | 状态 |
|---|---|
| `apps/backend/src/services/backtest/strategies/dualmomentum/index.ts` | `Strategy` 适配器：`id=dualmomentum`、`version=das-3.1`、`priceMode=open`、`warmupDays=60` |
| `apps/backend/src/services/backtest/strategies/dualmomentum/params.ts` | 参数 schema；默认值**引用** `l1/params.ts` 锁定常量，不另抄 |
| `apps/backend/src/services/backtest/cli.ts` | 回测入口注册；fixed 模式装载池内 7 只 + `sh000300` 指数轨 |
| `apps/backend/src/services/paper/strategies.ts` | 纸面白名单注册（方案 D 降级，见 §9） |
| 信号侧 | **不实现**：不做 `Plugin`、不进 `builtinPlugins`、不碰 `routes/signal.ts` |

DAS §4.3「停牌当日订单失效、不顺延」由执行层 `simulator` 的 `suspended` 分支实现，
适配器不需要额外表达。

## 9. 纸面账户已知不保真（方案 D：显式接受，不修公共回放）

### 9.1 契约冲突

`paper/decision.ts` 对纸面策略的契约（原文）：

> 回放中间日使用空组合（只重建策略状态），最终日 T 才使用检查点组合。
> 契约：**纸面策略的 `decide()` 内部状态不得依赖持仓**，否则回放会失真。

DualMomentum 的 L2 是**有状态**的（建仓日、高水位、冷却表），这些状态只能由成交事件累积；
回放期不产生成交、不调用 `onFill`，最终日 T 的持仓又是从检查点直接装入的 ⇒ 契约不成立。

**方案 D 的处置**：`params.ts` 与适配器内的 L2 规则**全部保留**（回测需要），纸面只是跑不全；
`paper/decision.ts` 的公共回放机制一行不改，wufu / combo 路径不受影响。

### 9.2 四条永不触发的规则

| 规则 | 纸面实际结果 | 原因 |
|---|---|---|
| 止盈（持有 ≥5 交易日且含费收益 ≥30%） | **永不触发** | `entryDate` 为空 → 兜底为 `asOf` → `days_since_entry=0` |
| 再平衡（跌出候选且持有 ≥5 交易日） | **永不触发** | 同上，`days_since_entry` 恒为 0 |
| 高水位止损（自持有期最高收盘回撤 ≥12%） | **永不触发** | `highWater` 为空 → 兜底取当日收盘 → 回撤恒为 0 |
| 止损 / 止盈冷却（3 / 5 交易日） | **永不生效** | 回放不调用 `onFill` → 冷却表恒为空 |

纸面仍可用的部分：成本止损（只读 `costBasis`）、超配减仓（只读持仓市值）、池内选股与权重分配。

`paper_position` 现有列（`avg_cost` / `cost_basis` / `last_buy_date`）**不足以重建**上述状态：
没有首次建仓日、没有高水位、没有冷却计数。

### 9.3 结论与禁令

- **纸面结果不得与回测结果互相校验** —— 两者口径不同，互相校验只会产出假缺陷。
- 纸面仅用于验收三件事：能选中该策略、能读到参数 schema、能按当日上下文出一次决策。
- 回测（`cli.ts backtest` + `optimize`）是 DAS 口径的唯一有效验收入口。
- 若未来要求纸面保真，走 §10 的 A 方案，**不在适配器或 `decision.ts` 里打补丁**。

### 9.4 两个「基准」不要合并

| 字段 | 值 | 用途 |
|---|---|---|
| `paper_account.benchmark_asset_code` | `sh510300` | 账户层展示与超额口径（ETF，来自 `v_etf_*`） |
| `params.benchmark`（策略内） | `sh000300` | DAS §3.3 市场过滤（指数，来自 `raw_kline_daily` 的 `class='index'`） |

二者不是同一概念，**不要合并、不要当 bug 修**。

## 10. 待立项：纸面回放改为全量成交模拟（方案 A）

### 10.1 问题陈述

纸面回放为了「重建策略状态」而使用空组合，导致任何**依赖持仓或成交历史**的策略在纸面上
系统性失真（本文 §9.2 是 DualMomentum 的实例）。该问题不是 DualMomentum 独有，
只是前两个内置策略（buy-and-hold / combo-signal）恰好无状态，所以一直没有暴露。

### 10.2 影响面

- `paper/decision.ts` 是同一条公共回放路径，wufu-rotation、combo-signal、dualmomentum **全部经过它**。
- 改造会改变历史决策的可复现口径，已有纸面账户的历史 `paper_order` 不补记。

### 10.3 为什么必须单独设计

1. **语义**：回放期是否允许成交、成交价用哪个口径（T+1 开盘 / T 收盘）、滑点与费用是否叠加，
   都会改变最终决策的目标权重，必须先定义。
2. **性能**：把「单日重建」升级为「逐日带成交模拟」，回放长度直接决定单次决策耗时
   （长生命周期账户可能需要重放数百个交易日），需评估是否引入状态快照。
3. **兼容**：wufu / combo 的有状态字段（若有）与历史口径必须同时审计，不能只测 DualMomentum。
4. **备选方案**：持久化策略状态（`paper_account` 增列）与全量模拟是两条不同路线，
   前者受「DDL 已定稿」约束，后者改动面更大 —— 需要单独 ADR 裁定。

> 本立项**只登记在此文件**；`docs/client/code_implementation_plan_v3.md` 有其它分支在改，
> 正式条目待该分支合并后再安排。

## 11. 框架级待修项（2026-11-09 回测实测发现，不影响寻优）

> 两条都不是 DualMomentum 的问题，而是 `apps/backend/src/services/backtest/` 的**框架公共路径**问题，
> 影响所有策略的回测统计口径。**只登记，本次不改代码**（寻优只做分析，不动语义）。

### 11.1 F-1：`bt_round_trip` 按「每笔卖出」计数，胜率名不符实

- **位置**：`account/portfolio.ts:211` —— `sell()` 每次成交都 `roundTrips.push(...)`，
  没有「持仓归零才成回合」的判定。
- **实测（dualmomentum 基线 2019-01-02~2026-11-06）**：卖出成交 **1073 笔**，
  `bt_round_trip` 行数 **1073 条**，两者逐一相等；其中 `rebalance-replace` 767、
  `out-of-candidate` 306。
- **后果**：`closedRoundTrips` / `winRate` 实际是「**每笔卖出**的盈利占比 + 卖出笔数」，
  含超配减仓、再平衡的部分卖出。真实「建仓→清仓」回合数远小于 1073。
- **影响面**：所有策略的 `bt_metric.winRate` / `closedRoundTrips` / 平均持有天数。

### 11.2 F-2：减仓分支未按 `lotSize` 取整，削出零股后被最低佣金放大

- **位置**：`execution/simulator.ts:350` —— `const targetQty = Math.floor(targetNotional / base);`
  买入分支（同文件 `:395`）是 `Math.floor(rawQty / rules.lotSize) * rules.lotSize`，
  卖出/减仓分支**没有这层取整**，也没有「残余不足 1 手则整笔清」的兜底。
- **后果链**：超配反复减仓 → 持仓削成 1/6/11/18 股 → 下一次卖出成交额仅 5~30 元 →
  按 `minCommission = 5` 抽佣 → `return_pct` 出现 −99.99%。
- **实测**：16 笔 `qty < 100` 的卖出，极端值 `sh518880 2024-03-20` qty=1、pnl=−4.93、
  `return_pct=−0.99999`、proceeds=4.99。
- **影响面**：所有策略的**成交笔数、费用明细、单笔收益率分布**；
  对权益曲线影响极小（本轮 8 年累计费用 17,454 元 ≈ 本金的 1.7%，其中零股部分仅数十元）。

### 11.3 为什么这两条不阻塞参数寻优

1. 本次寻优的目标函数是 **CAGR / Calmar / 最大回撤 / 对 `sh510300` 前复权的超额**，
   四个都由**权益曲线**（`bt_equity`）与基准序列算出，**不经过** `bt_round_trip`；
2. F-2 的费用在成交时已计入现金，权益曲线是「真实发生」的；
   零股只让**单笔收益率**失真，不改变累计净值；
3. 唯一会受污染的是「胜率 / 回合数」，本次**不作为目标、也不作为择优依据**；
4. 若后续要修，**必须重跑基线**（数字会变），故与寻优分开、另开任务。

### 11.4 登记去向

两条均为框架级缺陷，正式编号待 `docs/client/code_implementation_plan_v3.md` 的并行分支合并后再补
（当前该文件有其它分支在改，**不得触碰**）。

---

## 12. 后续 / 改进路线（2026-11-09 review 汇总）

> **定位：建议，未实施。** 一维证据与数字见 `dualmomentum-dm-sweep-stage0.md` §4–§10；
> 代码级 review 结论见 PR #143 的 review comments。任何采纳都必须另开 ADR、重跑基线；
> 在此之前默认参数、策略语义、对齐基线均不变（同 §11 口径声明）。

### 12.1 前提：先说清目标函数

如果目标是「跑赢 `sh000300` 的裸收益」，那一个平均暴露 28% 的策略在结构上就不可能赢过
100% 满仓的基准（除非 alpha 极大）；如果目标是「低回撤的绝对收益」，那低暴露是设计意图，
应该用 Sharpe / Calmar / 超额来比，而不是裸收益。下面按「无论哪种目标都值得做」的顺序给建议。

### 12.2 先做 4 个诊断（不改语义，最便宜）

1. **摩擦拆账**：`SUM(bt_trade.slippage_cost)` vs `fees`，确认是不是 ~7.5%/年
   （佣金 1.7 + 滑点 5.8）。这决定「降成本」和「改设计」谁优先。
2. **leave-one-out 消融**：只留 MA / 只留 WSM / 只留 RSRS / 去日涨跌 / 全留，
   看是哪一层把仓位挡在门外。
3. **reject_reason 拆主/次槽 + 每只标的的 selected 计数**：确认 RSRS 层是否常年挡人、
   黄金 `sh518880` 八年是否一次没进过。
4. **相关性矩阵 + 动量排序 IC**（排序与未来 5/10/20 日收益的秩相关）：
   先证明「排序有没有信息」，再谈参数。

### 12.3 档 1：低风险、高 ROI 的改动（建议先做）

1. **给闲置现金收益（最高杠杆）**：平均 ~72% 现金、引擎 0 计息。按 ~2% 货币收益
   ≈ **+1.4pp/年**，几乎正好填平 −0.86pp。实现三选一：引擎现金计息 / 无候选→防御标的回退 /
   放开单标的 cap。⚠️ 单纯把 `511880` 加进 7 只池**无效**（它过不了 MA+动量过滤）。
2. **关掉/弱化超配再平衡**：寻优里最好的那档正是 `overweightThreshold=1.0`（=关掉）。
   它制造大量零股减仓（F-2），换手高、成本高。建议先关掉或改成「只在偏离极大时整手减仓」。
3. **降换手**：`minHoldDays` 5 自然日 + 29x 换手，交易频率超过信号更新频率。
   把再平衡对齐到周频/10 日频（寻优显示 `minHold=20` 能砍 30% 换手）。
4. **成本口径校准**：0.2% 单边滑点对流动性 ETF 偏高；先确认真实成交假设。
   注意别在寻优里扫 `slippage/commission` —— 那是「优化成本模型」，不是优化策略。

### 12.4 档 2：仓位机制（结构性，改这一条最能改善「暴露+回撤」）

现在的形态本质是「要么满仓、要么空仓/部分仓」，没有中间态。建议改成连续仓位，二选一：

- **按候选数缩放**：`targetExposure = min(1, 通过数 / 3)`，再在候选间分配；
  候选 <3 时不再被迫留 67% 现金。
- **波动率目标**：`exposure = targetVol / 实现波动率`，并设上下限。

同时放开/条件化 `single_position_cap`：候选 <3 时允许单只接近满仓，而不是硬卡 33%。

### 12.5 档 3：过滤与退出（改 DAS 规格，需 spec owner 签字）

1. **去掉/放宽上界 `wsm≤5`、`rsrs≤2`**：它们把「最强趋势」排除，和动量策略的初衷相反。
2. **弱化 `wsm≥benchmark` 硬门槛**：它恰好在强市里把候选挡光、压低暴露。
   可改为「仅当基准动量为正时才启用」，或改成软性相对打分。
3. **AND → 评分制**：现在 4 条独立 AND（MA + 日涨跌 + 动量区间 + 基准），任何一条不过就空仓。
   建议只保留「绝对动量>0 + 趋势(MA)」作为硬条件，其余降为打分/排序，按综合分取 top-k。
4. **止盈改追踪**：+30% 固定止盈会截断赢家、还带 5 日冷却（现金）。
   改成「动量转弱才止盈」或移动止盈，且止盈后不冷却。
5. **新增「动量衰减退出」**（针对 2021 −38%）：现在只有掉出候选/超配/止损/止盈，
   缺「趋势转弱就减仓」。加一条可绕过 `minHoldDays` 的退出：主槽动量转负 / 跌破 MA20 /
   动量排名跌出 top-(k+2) → 减仓或清仓。

### 12.6 档 4：结构性（若前三档仍不达标）

- **扩池**：7 只太窄，且 A 股三只（300/500/创业板）高度冗余；扩到更多跨资产
  （债券、商品、更多区域）才有分散价值。
- **加一层择时**：用基准自身的趋势/波动做整体仓位开关（而不是逐标的 AND），
  既提暴露质量又控回撤。

### 12.7 明确不建议

- 继续在 62 组网格上调参数：锯齿状响应 + 收益集中 2024–2026，越调越拟合最近三年，是过拟合入口。
- 用裸收益和满仓基准比：必须同时报平均暴露、换手、摩擦，并用 Sharpe / Calmar / 超额。

### 12.8 建议的落地顺序

1. 诊断 1–4（半天）；
2. 现金收益 + 关超配 + 降换手 + 成本校准（档 1，每项单独跑、单独记效果）；
3. 连续仓位（档 2）；
4. 过滤/退出重构（档 3，需改 DAS 并逐条消融）；
5. 仍不达标再扩池/择时（档 4）。

关键纪律：一次只改一个变量、每次记「暴露/换手/摩擦/超额」四个数，
否则又会变成「规则换了但说不清是哪条起作用」。
