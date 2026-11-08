# DualMomentum L1 实现说明（DAS-2 对齐核对）

> 状态：L1 已实现并自测通过，**尚未接入任何注册点**（未改 `BUILTINS`、未改 `pluginEngine.ts` /
> `routes/signal.ts` / `signalService.ts` / `SDD.md`、未改现有策略）。
> 规格权威源：`d:\workspace\QuantInvest\Strategy\DualMomentum\JointQuant\docs\decision_alignment_spec.md`（DAS-2）。
> 记录时间：2026-11-08。

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
| 不得增加表外过滤（如「零成交量不得入选」） | 零量 bar **照常参与 L1**，只把 `tradable_today` 置 0 |

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
   与 MVP 的 DuckDB（tdx2db 来源）**非同源**。不导出同一份物理快照，逐位对齐的前提就不成立。
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
但换标的/换区间后不等价，接入时不可沿用。

## 5. 与 Python 参考实现 / 规格的差异（需规格方裁定）

| # | 项 | 现状 | 影响 |
|---|---|---|---|
| D1 | **零成交量占位 bar 的「快照价」** | DAS-2 §3.3 明确「零成交量只影响执行层是否可成交，**不影响 L1 决策**」；本实现 `has_bar=1`、`close_raw`=当日 raw close、过滤照常、`tradable_today=0`。参考 Python 用 `last_valid_close` 当快照价 | 若占位 bar 满足 `O=H=L=C=前收`（库内池内仅 3 根，见 §5.2 样本）则无差别；若非此形态则会分歧。**本层按规格实现**，接入前需用真实快照核对这 3 根 |
| D2 | **WSM R² 分母的 `ȳ`** | §3.2(a) 写 `Σ w_i(y_i−ȳ)²` 但未指明 `ȳ` 是否加权均值；Python 用**未加权** `np.mean(y)`。本实现照 Python | 若规格本意是加权均值，指标数值会变（对齐立刻失败）。建议在 DAS-2 里明确为「未加权均值」 |
| D3 | 交易日历来源 | 见 §4.4 待办 | 接入期修正 |
| D4 | `in_pool` 语义 | 本实现 = 「T 日或之前有 bar」；与 §6.2 列 4 注释（513000 于 2019-06-25 前为 0）一致 | 无 |

## 6. 验证记录

| 项 | 结果 |
|---|---|
| 单测 | `dualmomentumL1Indicators` 8 + `dualmomentumL1Decisions` 16 + `dualmomentumL1Csv` 4 = **28/28 PASS**（Prettier 后重跑仍全绿） |
| `npm run typecheck -w @invest/backend` | PASS（`tsc --noEmit`，无输出） |
| 真实库切片（`2019-01-02 ~ 2026-11-06`，7 只 + 基准） | **13,314 行 = 1902 交易日 × 7 标的**，耗时 **916ms** |
| 原因码分布 | `BELOW_MA20` 5571 / `MA_NOT_BULLISH` 3783 / `MOMENTUM_OUT_OF_RANGE` 1873 / `PASS` 1574 / `BELOW_BENCHMARK` 285 / `POOL_ABSENT` 114 / `DAILY_CHANGE_OUT_OF_RANGE` 105 / `AT_LIMIT` 8 / `SUSPENDED` 1 |
| 每日选中数分布 | 1:550 / 2:277 / 3:107 / 4:23 / 5:9 / 6:2（有选中的交易日 968 天） |
| 首条选中行 | `2019-01-02 sh518880`（`wsm_v2=0.52515…`，该日其余标的均 `BELOW_MA20`，符合 60 根预热后的首日行为） |
| 边界单测覆盖 | 恰好 ±5%（含 `1e-9` 容差内/外）、涨跌停（3.3003 / 2.6997）、停牌、零量 bar、冷却、513000 未上市、不足 60 根、MA20 缺失、动量开闭区间、基准 ≥、7 只全通过时的排名与截断、序列乱序抛错 |

`POOL_ABSENT=114` ≈ 513000 上市前（2019-01-02 ~ 2019-06-24）的交易日数，与 §6.2 列 4 的说明一致。

## 7. 若要接入 `BUILTINS`（仅方案，未实施）

用户要求「若需要注册进 `BUILTINS`，先单独说明方案」。当前**未注册**，L1 是纯函数库。接入需三步，
且**不在本次范围内**：

1. **适配器**：`buildMarketSlice(cutoffDate)` —— 从快照/或锁 cutoff 的行情层一次 `IN (...)` 取
   7 只 + 基准的 raw OHLCV 与 `hfq_factor`（遵守「批量一次查询、DuckDB 只读、按需开关」）。
2. **策略壳**：把 L1 的 `selected` 转成插件 `Signal[]`；此时**必须**先确定 L2 的语义（T+1 开盘），
   否则 `action`/`blocked_reason` 无从填。
3. **注册与沙盒**：`BUILTINS` 注册 + `execute()` 50ms 硬限。L1 全窗口 1902 天 916ms，
   单日约 0.48ms，50ms 余量充足；但**不能**把全量决策行塞进插件返回值，应只返回当日的行。

在此之前不动 `BUILTINS`、`pluginEngine.ts`、`routes/signal.ts`、`signalService.ts`、`SDD.md`。
