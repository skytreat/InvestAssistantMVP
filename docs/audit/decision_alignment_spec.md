> **迁移说明（2026-11-08）**
>
> - **原位置**：`QuantInvest` 仓库 `Strategy/DualMomentum/JointQuant/docs/decision_alignment_spec.md`。
> - **迁移原因**：本规格的裁定方是 MVP 侧（实现端），每次改口径都要跨仓库编辑，且每次都撞上那边未提交的改动，
>   无法在同一个 commit 里让「规格变更」与「实现变更」同时可追溯。
> - **本文件为唯一正文**：此后所有修订只落在这里。QuantInvest 仓库处保留**指针存根**（只写"已迁移"+指回此处），不再维护正文；
>   历史版本可在该仓库 `docs/decision_alignment_spec.md` 的 git 提交记录中查阅。
> - 迁入时正文**逐字保留**，未做任何删节或重写（含 Python 侧专属的 §2.4 / §4.3 / §4.5 / §6 / §7.6）。

---

# 决策级对齐规格：DualMomentum（QuantInvest → InvestAssistantMVP）

- 规格版本：`DAS-3`
- 适用标的池：7 只 ETF（固定，见 §2.1）
- 基准：沪深300指数 `000300.XSHG`
- 数据截止：`2026-11-06`
- 目标读者：未读过 QuantInvest 代码、需要把 DualMomentum 在 InvestAssistantMVP 里实现成 `Strategy` 的开发者

本规格只定义**可判定的行为契约**。凡是本规格没有写死的地方，一律以实现端"与 Python 参考实现逐日一致"为最高准则；不允许凭经验补规则。

---

## 0. 范围、非目标与两个对齐层

**目标**：MVP 侧实现出的策略，在相同数据快照、相同参数下，逐日逐标的的决策字段与 Python 参考实现一致（容差 1e-9）。

**非目标**：不改 Python 侧策略逻辑与参数值；不在本次改动中新增 Python 导出器；不动 MVP 既有代码之外的模块。

**必须区分两个对齐层**（混在一起会导致"永远对不上"）：

| 层 | 内容 | 是否依赖成交 | 本次可否立即执行 |
|---|---|---|---|
| **L1 信号层** | 指标、过滤、排名、是否选中 | 否 | 可以。Python 现有引擎即可导出 |
| **L2 组合层** | 持仓数量、目标权重、买卖方向、风控排除、停牌阻断 | 是（依赖成交价与成交可行性） | **已满足（DAS-3）** |

**L2 的前置条件（DAS-3 已满足）**：Python 侧原为"T 日收盘信号 + T 日收盘成交"，且 `next_open` 模型只有买入腿用次日开盘、卖出仍是收盘（该模型已在 DAS-1 阶段标记弃用）。`DAS-3` 已把本地回测与聚宽执行端（`joinquant_strategy.py` / `joinquant_onefile.py`）全部改为 §4 定义的 `t1_open` 语义，旧的 `close` / `vwap` / `next_open` 三个 `price_model` 已从代码中删除（`price_model != 't1_open'` 直接抛 `ValueError`）。

**验收口径（DAS-3 起）**：
1. L1 全字段 1e-9 一致；
2. L2 参与跨端比对：`action` / `action_reason` / `blocked_reason` / `target_weight` / `position_qty` 逐键比对；执行日的三种不可成交（§4.2/§4.3）必须两端同因同果。

---

## 1. 总体时序（时间轴必须逐字实现）

```
T 日 15:00 收盘
  └─ 阶段 A：用"截至 T 日收盘"的连续序列（前复权到当日，§3.1a）计算全部指标，产出决策序列 D(T)
T+1 日 09:30 开盘
  └─ 阶段 B1：先执行 D(T) 的卖出意图（成交价 = T+1 真实开盘价，§4）
  └─ 阶段 B2：再执行 D(T) 的买入意图（同上）
  └─ 阶段 B3：以 T+1 收盘价重估持仓，记录当日组合快照
```

硬性约束：

1. **D(T) 只能使用 ≤ T 的数据**。任何用到 T+1 及以后数据的字段，视为未来函数，直接判不通过。
2. **卖出必须先于买入**，因为买入预算依赖卖出所得现金。
3. **决策里的"规划价"用 T 日收盘**（§3.4），**成交用 T+1 开盘**（§4）。两者不得混用。
4. 决策一旦在 T 日收盘产出，T+1 日不得因盘中价格变化重算信号（只允许执行层的价格可用性判定）。

---

## 2. 参数锁定表

### 2.1 标的池（顺序即代码，**顺序会影响并列排名**）

| 序 | jq_code | 规范 symbol | 名称 | 首个 bar |
|---|---|---|---|---|
| 1 | `510300.XSHG` | `sh510300` | 沪深300ETF华泰柏瑞 | 2012-05-28 |
| 2 | `510500.XSHG` | `sh510500` | 中证500ETF南方 | 2013-03-15 |
| 3 | `159915.XSHE` | `sz159915` | 创业板ETF易方达 | 2011-12-09 |
| 4 | `513500.XSHG` | `sh513500` | 标普500ETF博时 | 2014-01-15 |
| 5 | `513100.XSHG` | `sh513100` | 纳指ETF国泰 | 2013-05-15 |
| 6 | `513000.XSHG` | `sh513000` | 日经225ETF易方达 | **2019-06-25** |
| 7 | `518880.XSHG` | `sh518880` | 黄金ETF华安 | 2013-07-29 |
| — | `000300.XSHG` | `sh000300` | 沪深300（基准，不可交易） | 2005-01-04 |

### 2.2 参数取值（对齐阶段全部锁定，**不许改**）

| 参数 | 锁定值 | 说明 |
|---|---|---|
| `momentum_combo` | `wsm_v2_rsrs` | 三选一；其余两种仅用于历史对照 |
| `wsm_period` | `25` | WSM 回归窗口 |
| `use_wsm_v2` | `True` | 使用加权 R² |
| `nday_return_period` | `25` | N 日涨幅窗口 |
| `nday_return_annualize` | `True` | 年化，与 WSM 同量纲 |
| `rsrs_period` | `25` | RSRS 单期回归窗口 |
| `rsrs_std_period` | `25` | Z-Score 历史窗口 |
| `rsrs_enable_quality_filter` | `False` | 不启用 slope/R² 阈值过滤 |
| `wsm_min` / `wsm_max` | `0.0` / `5.0` | **槽位名固定**，量纲随 combo 变化（§3.3） |
| `rsrs_min` / `rsrs_max` | `0.0` / `2.0` | 同上 |
| `ma_periods` | `[5, 10, 20, 60]` | 简单移动平均 |
| `ma_for_price_check` | `20` | "价格 > MA20" 用 |
| `daily_change_min` / `daily_change_max` | `-0.05` / `0.05` | 闭区间 |
| `max_holdings` | `6` | 候选截断上限 |
| `single_position_cap` | `0.33` | 单标的上限（买入时约束） |
| `overweight_threshold` | `0.40` | 持仓期间超限减仓阈值 |
| `min_hold_days` | `5` | 最少持有"天数"（**注意 §9.1**） |
| `take_profit_threshold` | `0.30` | 止盈阈值 |
| `take_profit_cooldown` | `5` | 止盈冷却（交易日） |
| `stop_loss_drawdown` | `0.10` | 相对成本跌幅 |
| `stop_loss_high` | `0.12` | 相对高点回撤 |
| `stop_loss_cooldown` | `3` | 止损冷却（交易日） |
| `commission_rate` | `0.00006` | 万分之 0.6 |
| `min_commission` | `5.0` | 每笔最低 5 元 |
| `slippage` | `0.002` | 单边固定滑点 |
| `etf_exempt_tax` | `True` | ETF 免印花税 |
| `lot_size` | `100` | 整手 |
| `initial_cash` | `1000000.0` | 组合层对齐用 |
| `benchmark` | `000300.XSHG` | 大盘择时基准 |

### 2.3 三种 `momentum_combo` 的槽位语义（**最容易实现错的地方**）

代码内部只有两个槽位：`wsm`（主）和 `rsrs`（次）。combo 只决定把哪个指标塞进哪个槽，**两个过滤阈值始终作用在槽位上，不作用在原始指标上**。

| combo | 主槽 `wsm` | 次槽 `rsrs` | 主槽区间 | 次槽区间 | 基准动量算法 |
|---|---|---|---|---|---|
| `wsm_v2_rsrs`（锁定） | WSM V2 年化 | RSRS Z-Score | `[0, 5]` | `[0, 2]` | WSM V2 年化 |
| `nday_return_rsrs` | N 日年化收益 | RSRS Z-Score | `[0, 5]` | `[0, 2]` | N 日年化收益 |
| `nday_return_wsm_v2` | N 日年化收益 | **WSM V2 年化** | `[0, 5]` | **`[0, 2]`** | N 日年化收益 |

含义：`wsm_min=0` 实际是"主指标必须 ≥ 0"；`rsrs_max=2` 在 combo 3 下是"WSM 年化收益 ≤ 200%"，不是 RSRS 分位。锁定 combo = 1，但 MVP 的 `Strategy` 必须把这三个组合都实现成可枚举，且禁止改变槽位语义。

### 2.4 `price_model`（**唯一支持 `t1_open`**）

| 名称 | 卖出价 | 买入价 | 状态 |
|---|---|---|---|
| `t1_open`（锁定） | `open_raw(T+1) × (1 − 0.002)` | `open_raw(T+1) × (1 + 0.002)` | **唯一支持**（§4） |
| `close` | `close(T) × (1 ∓ 0.002)` | 同左 | **已从代码移除**（`ValueError`） |
| `next_open` | `close(T) × (1 − 0.002)` | `open(T+1) × (1 + 0.002)` | **已删除**（仅买入腿用次日开盘、卖出仍收盘；停牌会静默取复牌日开盘价）；其停牌缺陷由 §4.3 的显式口径取代，**不是启用旧模型** |
| `vwap` | `(O+H+L+C)/4 × (1 ∓ 0.002)` | 同左 | **已从代码移除**（`ValueError`） |

本地回测的 `price_model` 参数只接受 `t1_open`；传入其余任何值即抛 `ValueError`。聚宽两份执行端不暴露 `price_model`，行为固定为 `t1_open`。上述被移除的模型**不得**作为 MVP 默认，也不得作为复现旧结果的开关。

---

## 3. 指标与决策规则（逐条可实现）

### 3.1 输入序列约定

- 所有指标只用**截至 T 日（含）**的 bar；若 T 日停牌（无 bar），则使用"最近可用 bar"序列，等价于把 T−1 的值顺延（**不得置空**）。
- 数值一律 `float64`，禁止 `float32`/Decimal/中间舍入。
- 指标输入不足时返回 `0.0`（不是 NaN，不是空）。
- 价格口径：账本为 **bfq（不复权）账本**——成交、费用基数、持仓估值、涨跌停、涨跌幅全部用 **raw**（§5）；指标输入用**前复权到当日的连续序列** `adj(t) = raw(t) × F(t) / F(T)`（§3.1a），否则 raw 在拆分日跳变会污染动量、均线与涨跌幅判断。

### 3.1a 连续序列（前复权到当日）

```text
F(t)   = 后复权因子（源库 raw_adjust_factor；分红、份额折算当日跳变）
adj(t) = raw(t) × F(t) / F(T)                  # 指标输入（O/H/L/C 同式）
prev_close_adj(T) = raw(T−1) × F(T−1) / F(T)   # 涨跌幅、涨跌停用的"除权调整后前收"
```

- `adj(T) == raw(T)`，因此均线（由 `adj` 计算）与 T 日 raw 快照价同量纲，可直接比较。
- WSM（对数斜率）、RSRS（斜率×R²）、N 日涨幅对标量倍乘均不变，所以"前复权到当日"与"后复权"在这些指标上数值等价；采用前复权的唯一目的是让 MA 与前收落在 raw 量纲。
- 无公司行为的标的上，`adj(t) == raw(t)`、`prev_close_adj == prev_close_raw`。

### 3.2 指标定义

**(a) WSM V2（加权斜率动量）**

```text
n = 25
y_i = ln(close_adj[i]), i = 0..n-1（窗口末位 = T 日）
x_i = i
w_i = linspace(1.0, 2.0, n)          # 最旧 1.0，最新 2.0
加权最小二乘拟合 y = slope*x + intercept，其中权重按"行乘子 w_i"施加
  # 等价的闭式解：Σ(w_i²·x_i·y_i) 形式；注意是 w²，不是 w
annualized = exp(slope * 250) - 1
r2_weighted = 1 - Σ w_i (y_i - ŷ_i)² / Σ w_i (y_i - ȳ)²
score = annualized * r2_weighted
```

- 若任一 `close ≤ 0`、非法、`Σ w_i(y_i−ȳ)² == 0`、`exp` 溢出 → `0.0`。
- 输入为 `close_adj[-(wsm_period):]`（不足 25 根时由"输入不足 → 0.0"兜底，但 `precalc` 会先检查最小长度，见 §3.2(d)）。

> ⚠️ **`np.polyfit(..., w=w)` 的权重语义（DAS-3 核查结论，2026-11-08）**
> `polyfit` 把 `w` 乘在 Vandermonde 设计矩阵的**行**上，法方程等价于最小化 `Σ (w_i·r_i)² = Σ w_i²·r_i²`，
> 所以传入 `w` 得到的斜率实际是 **w² 加权**，不是 w 加权。若要实现 w 加权，必须传 `np.sqrt(w)`。
> - **实现事实**：`indicators.py` 的斜率用 `polyfit(x, y, 1, w=w)` → 斜率权重 `w²`；同函数 R² 用 `Σ w_i·r_i²` → 权重 `w`。
> - **本意判定**：仓库内唯一可追溯的作者描述是"线性权重 `w = linspace(1,2)`"加"加权线性回归"（`design.md` §4.1），
>   且同一函数内 R² 显式写成 `w`。同一指标两处口径不一致（w² vs w），说明作者并未区分行乘子与法方程权重，
>   最合理推断是**本意为 w**，`polyfit(w)` 属实现偏差而非设计选择。
> - **但结论不被采纳为改动**：Python 与 MVP 当前都照此实现，两端一致，L1 对齐不受影响；改成 `sqrt(w)` 会直接改变 WSM 量值
>   （进而改变排名与阈值命中），必须作为一次显式"口径变更"单独决策，不能在本次对齐阶段顺手改。
> - 记录在案的目的是：若日后判定"w² 才是本意"，那不是修 bug 而是确认选择；若判定"w 才是本意"，则两端需**同时**改为
>   `w=np.sqrt(w)` 并重跑所有基线。

> ⚠️ **`ȳ` 取未加权算术均值（已知偏差点，2026-11-08 裁定）**
> `ȳ = mean(y_i)`，即权重 `w_i` 只乘在**残差项**上，分母 `Σ w_i (y_i − ȳ)²` 的 `ȳ` 不带权重。
> 这与 Python `indicators.py`（`np.mean(y)`）一致，但与"严格加权 R²"（分母 `Σ w_i y_i / Σ w_i`）不同。
> **现阶段"与 Python 逐位对齐"是唯一可验证的判据**：为了数学上更"正确"而偏离参考实现，
> 会让判据本身失效。待 L2 稳定、进入策略质量评估阶段后，再单独决策是否统一修正两侧。
> 两侧实现都必须保留这条注释，避免后来者按"加权均值"直觉改错。

**(b) N 日涨幅（年化）**

```text
ret = close_adj[-1] / close_adj[-period] - 1
annualized = (1 + ret) ** (250 / period) - 1
```

`period=25`；`base ≤ 0`、长度不足、非有限 → `0.0`。

**(c) RSRS（Z-Score，无质量过滤）**

```text
需要 n = rsrs_period + rsrs_std_period = 50 根 high/low
对每个 i ∈ [24, 49]：
    win = [i-24, i] 共 25 根
    slope = cov(low, high) / var(low)          # 总体矩（除以 25，不是 24）
    r2    = 1 - ss_res / ss_tot                # ss_tot 用 high 的均值
    rsrs_raw[i] = slope * r2
    # var(low)==0 或 ss_tot==0 → 该 i 保持 NaN，不参与 Z-Score
current = rsrs_raw[49]
history = rsrs_raw[24..48]（25 个，剔除 NaN）
若有效 history < 2 → 0.0
z = (current - mean(history)) / std(history)  # std 为总体标准差 ddof=0
```

- `current` 非有限、`std == 0` → `0.0`。
- 质量过滤锁定关闭，禁止实现 slope∈[0.5,3]、R²≥0.75 的过滤。

**(d) MA 与最小数据长度**

```text
ma[p] = mean(close_adj[-p:])     # 长度不足 → 0.0
needed = max(wsm_period, nday_period, rsrs_period + rsrs_std_period, max(ma_periods)) = 60
若 len(close) < needed：wsm=0.0, rsrs=0.0, ma={}, prev_close=close[-1]（即短路返回 0 值）
```

注意：`len < 60` 时**不是逐指标退化**，而是整体短路返回 0。MVP 必须复刻这个短路，否则 2019 年 6–9 月的预热段会不一致。

### 3.3 候选筛选（顺序固定，短路语义）

按下列**严格顺序**逐条判定，第一条不通过即为 `reject_reason`，后续不再判：

| 步骤 | 规则 | 不通过原因码 |
|---|---|---|
| 1 | 标的存在（有历史 bar） | `POOL_ABSENT` |
| 2 | T 日有 bar 且 `close_raw > 0` | `SUSPENDED` |
| 3 | 不在冷却期：`sell_date < T ≤ end_date` | `COOLDOWN` |
| 4 | 非涨跌停：`price` 严格小于涨停价、严格大于跌停价 | `AT_LIMIT` |
| 5 | 当日涨跌幅 ∈ [−5%, +5%]，`change = price/prev_close − 1`，边界容差 1e-9 | `DAILY_CHANGE_OUT_OF_RANGE` |
| 6 | `price > MA20`（严格大于） | `BELOW_MA20` |
| 7 | `MA5 > MA10 > MA20 > MA60`（全严格） | `MA_NOT_BULLISH` |
| 8 | 主槽 ∈ [`wsm_min`,`wsm_max`] 且次槽 ∈ [`rsrs_min`,`rsrs_max`]（**闭区间**） | `MOMENTUM_OUT_OF_RANGE` |
| 9 | 主槽 ≥ 基准主槽（**含等于**） | `BELOW_BENCHMARK` |
| 10 | 按主槽降序排序后，名次 ≤ `max_holdings` | `RANK_TRUNCATED` |

补充规定：
- 第 4/5/6 步里的 `price` 是**快照价**，`prev_close` 是 `prev_close_adj`（§3.1a），即**除权调整后前收**；无公司行为时两者等于原始前收。快照价按下列口径取（**2026-11-08 裁定 D1**）：

  | T 日情形 | `price`（快照价） |
  |---|---|
  | bar 可成交（`volume_raw > 0` 且 OHLC > 0） | 当日 raw 收盘 |
  | bar 存在但不可成交（`ZERO_VOLUME` 占位 bar / OHLC 非法） | **最近有效收盘**（`last_valid_close`：截至 T 最近一根可成交 bar 的 raw 收盘） |
  | 无 bar（`MISSING_BAR`） | 第 2 步已短路 `SUSPENDED`，不参与 4/5/6 |
  | 从未有过有效收盘 | 第 2 步按 `SUSPENDED` 处理（无价可判） |

  ⚠️ 这是**"与 Python 参考实现 `snapshot_prices` 保持一致"的对齐选择，不是数学上唯一的做法**
  （另一种做法是直接用占位 bar 自身的收盘价）。选前者是因为零成交量日的价格不具可成交性，
  用它去判涨跌幅/涨跌停会产出不可执行的信号。列 8 `close_raw` 仍记**当日 bar 自身的 raw 收盘**，
  因此在占位 bar 日两者可能不同（该值不单独出列）。
  本次核对：池内 3 根占位 bar（`sh510500 2015-04-13`、`sh513100 2022-01-13`、`sh513500 2022-03-29`）
  的 `close_raw` 均等于前一有效收盘，故两种口径在现有数据上**结果相同**；差异仅在未来出现
  非 `O=H=L=C` 形态的占位 bar 时才显现。
- 第 4 步的涨跌停价用 **raw**：`up = prev_close_adj × (1 + limit)`, `down = prev_close_adj × (1 − limit)`，与快照价比较（Python 端不额外 `round`，见 §4.2 的口径差异说明）。
- 排序为**稳定排序**；主槽相等时保持 §2.1 的池内顺序。名次从 1 开始，仅对通过 1–9 步的行编号。
- `selected = rank ≤ max_holdings`。

**不得增加本表以外的过滤条件**（例如"零成交量不得入选"）：零成交量占位 bar 只影响**执行层是否可成交**（§4），不影响 L1 决策。

### 3.4 组合层决策（L2）

**规划价（用于算权重与预算，全部取 T 日收盘）**

```text
plan_price(code) = close_raw(code, T)
sell_est(code,q)  = q × plan_price × (1 − slippage) − max(q × plan_price × commission_rate, 5)
buy_plan(code)    = plan_price × (1 + slippage)
total_value(T)    = cash + Σ qty × plan_price
```

**卖出优先级（顺序不可调换）**

1. `STOP_LOSS`：`(unit_cost − price)/unit_cost ≥ 0.10` **或** `(high_watermark − price)/high_watermark ≥ 0.12` → 全部卖出；**不受最少持有期约束**。冷却 `3` 个交易日。
2. `TAKE_PROFIT`：`days_since_entry ≥ 5` **且** `(price × qty − total_cost)/total_cost ≥ 0.30` → 全部卖出。冷却 `5` 个交易日。
3. `NORMAL_REBALANCE`：不在当日候选集，且 `days_since_entry ≥ 5` → 全部卖出。**不设冷却**。
4. `OVERWEIGHT`：对 1–3 执行后的剩余持仓，若持仓数 ≥ 2 且单只市值占比 > 0.40（分母 = 剩余持仓市值之和，不含现金）→ 目标市值 = 0.40 × 剩余持仓市值之和，卖出超出部分；卖出量向下取整到 100 股；若卖出后剩余 < 100 股 → 改为全部卖出。**不设冷却**。

同一标的当日只允许一个卖出动作（1–3 优先，命中后不再考虑 4）。

**买入**

```text
candidates = selected（已按主槽降序）
N = len(candidates)
per_target = cash_after_sells_est / N
cap_amount = total_value(T) × 0.33
for code in candidates:                       # 按排名顺序执行
    current_value = qty(code) × plan_price(code)
    target_value  = min(per_target, max(0, cap_amount − current_value))
    qty_add       = floor(target_value / buy_plan(code) / 100) × 100
    if cost > 现金: qty_add 降为 floor(现金 / buy_plan / 100) × 100
```

- 买入按候选排名顺序依次执行，先到先得，现金不足时后面的标的可能买不到。
- 已有持仓加仓：数量累加，`unit_cost` 按数量加权平均，`first_trade_date` **不变**，`high_watermark` 不变。
- 新建仓：`unit_cost = 成交价`，`high_watermark = 成交价`，`first_trade_date = 成交日`（即 T+1）。
- `target_weight` 定义为**规划权重**：`(当前市值 + 本次规划买入市值 − 本次规划卖出市值) / total_value(T)`；卖出清仓则为 `0`。

**持仓估值**：`qty × close_raw(T)`；停牌日按最近有效收盘顺延（不得置 0）。

**bfq 记账**（记账空间 = 真实）。持仓跨除权日时，先调账再决策：

```text
现金分红（category=1，d = 源库 c1/10）：
    cash += 除息前份额 × d；unit_cost −= d；high_watermark −= d
份额折算（category=11，k = 源库 c3）：
    new_qty = floor(qty × k)；余股按当日 raw 价折现入 cash
    unit_cost /= k；high_watermark /= k；total_cost = unit_cost × new_qty
```

- 账本记**真实股数、真实现金、真实成交额**，因此净值跨分红/折算连续，无需"分红再投资"假设。
- `first_trade_date` 不因公司行为或加仓改变；`quantity_after == 0` 时持仓归零、价值已全额折现入现金。

---

## 4. 执行层（T+1 开盘）与两条硬约束

### 4.1 成交价

```text
exec_price(code, T+1) = open_raw(code, T+1) × (1 ± slippage)
                       卖出取 (1 − 0.002)，买入取 (1 + 0.002)
```

- 必须使用 **T+1 当日真实 open**；禁止用 `close(T)`、`close(T+1)`、均价、前收盘、或"上一根可用 bar 的开盘价"近似。
- **不乘任何复权因子**。账本是 bfq：成交价、成交额、佣金/印花税基数都是真实 raw 金额。
  （若把 notional 写成 `open_raw × hfq_factor`，在因子 ≠ 1 的标的上佣金与最低佣金 5 元会被系统性放大——这是初版规格的实际漏洞，已废弃。）
- 卖出用 `(1 − slippage)`，买入用 `(1 + slippage)`；佣金 `max(amount × 0.00006, 5)`；ETF 无印花税/过户费。
- 涨跌停价口径差异：Python 端 `calc_limit_prices` 直接 `prev_close × (1 ± 0.10)`，**不 round 到 2 位**；若 MVP 端按交易所规则 round 到分，该差异只在触及涨跌停的极端日体现，按 §7.3 的记录方式登记，不在此阶段强行统一。

### 4.2 硬约束一：一字涨停买不进

判定（用 raw 价；账本即 raw，无空间换算）：

```text
up_limit = prev_close_adj × (1 + limit_ratio)   # limit_ratio 见 §4.4；不额外 round（§4.1）
买不进（BLOCKED_LIMIT_UP）当且仅当：open_raw ≥ up_limit
卖不出（BLOCKED_LIMIT_DOWN）当且仅当：open_raw ≤ down_limit
```

- 采用**保守口径**：开盘即触及涨停 → 视为买不进，不再看盘中是否打开。这是可执行的下界，不允许乐观成交。
- 若需要用 high/low 佐证"一字板"，可作为二级细化，但不得放宽上述保守判定。
- 被阻断的买入意图**不顺延到 T+2**，直接作废（当日决策失效）；被阻断的卖出意图**不顺延**，下一交易日重新按新决策判定。

### 4.3 硬约束二：停牌无价可成交

```text
不可成交（BLOCKED_SUSPENDED）当且仅当 T+1 该标的存在以下任一情况：
  (a) 日历开市但该标的无 bar        → reason = 'MISSING_BAR'
  (b) bar 存在但 volume == 0        → reason = 'ZERO_VOLUME'
  (c) open/high/low/close 任一缺失或 ≤ 0 → reason = 'INVALID_BAR'
```

- 停牌日**绝不允许**用前收盘、上一根 bar 的 open、复牌日 open 代替成交价。
- 停牌期间持仓按最近有效收盘估值（§3.4），净值不塌陷。

**停牌口径（DAS-3 写死）：当日订单失效，不顺延、不跨日挂单。**

三种候选口径的取舍：

| 候选 | 语义 | 是否采用 |
|---|---|---|
| 跳过该笔交易（当日作废，次日由新决策重新判定） | 订单不进入队列，T+1 收盘重新算 D(T+1) | **采用** |
| 顺延到复牌日按开盘价成交 | 保留旧订单直到复牌 | 否决 |
| 放弃该笔交易（含后续不再触发） | 等同于把标的移出池 | 否决 |

选择理由（三条，按重要性排序）：

1. **与聚宽实盘语义一致**：聚宽对停牌标的的市价单在 09:30 直接被拒，策略不会自动挂条件单等到复牌。执行端若实现"顺延"，回测与实盘会在停牌段系统性分叉，L2 不可能对齐。
2. **旧信号在复牌时已过期**：复牌可能隔数日甚至数周，动量排名、权重、止盈止损距离都基于 T 日数据；用旧订单在复牌日成交，等于用一个已经失效的决策下单，属于把回测做"好看"的偏差。
3. **避免订单队列状态机**：顺延需要维护部分成交、多次顺延、与新决策冲突时的优先级，状态复杂度高且难以在聚宽端复刻。

配套规定：

- 卖出意图被停牌阻断时，持仓保留，`days_since_entry` 照常按自然日累计（§9.1），**下一交易日由新的 D(T+1) 重新判定**（若条件仍成立会生成一笔新订单，属新决策而非顺延）。
- 买入意图被停牌阻断时，该标的当日不建仓，`target_weight` 记 `0`，并记录 `blocked_reason = BLOCKED_SUSPENDED`（具体原因码 `MISSING_BAR` / `ZERO_VOLUME` / `INVALID_BAR` 记入执行拒绝记录，见 §4.5）。
- 同一交易日若卖出腿有标的被拦截，**买入腿不整体取消**，而是按当日**实际可用现金**裁剪（裁剪后不足 1 手记 `INSUFFICIENT_CASH`）。原因：本地回测与聚宽端都在开户现金上裁剪，这是两端唯一能保持一致的做法；强行"一单被拦就全停买"会与聚宽端的实际行为分叉。
- 聚宽端特有的一条：卖单**已提交但 `check_order_filled` 返回未成交**时，当日买入腿终止（部分成交是券商侧状态，本地回测无此概念，故不入本地回测口径）。

### 4.4 涨跌停比例表

| 标的 | limit_ratio |
|---|---|
| `510300` / `510500` / `159915` / `518880` | `0.10` |
| `513500` / `513100` / `513000`（跨境 ETF） | `0.10`（按现有实现；若数据源提供 `high_limit/low_limit` 原值，优先用原值） |

对齐阶段以 Python 参考实现的 `calc_limit_prices` 为准，不得更换比例。

### 4.5 执行拒绝记录（本地回测与聚宽端必须可核对）

本地回测把每一次被拦截的意图写入 `BacktestResult.execution_rejections`，列固定为：

| 列 | 含义 |
|---|---|
| `date` | 实际执行日（T+1） |
| `side` | `SELL` / `BUY` |
| `code` | 规范 symbol（`sh510300`） |
| `reason` | `BLOCKED_LIMIT_UP` / `BLOCKED_LIMIT_DOWN` / `BLOCKED_SUSPENDED` / `INSUFFICIENT_CASH` |
| `quantity` | 被拦截的规划数量（股） |
| `detail` | 停牌子原因（`MISSING_BAR` / `ZERO_VOLUME` / `INVALID_BAR`），其余为空 |

聚宽端在 `log.info` 中以同一 `reason` 字符串输出，便于逐日比对时按 `(date, code, reason)` 对齐。

---

## 5. 数据快照约定

### 5.1 来源与一次性导出

- 来源库：`InvestAssistantMVP/data/quotes.duckdb`（DuckDB，schema_version `6.0`），**只读**打开（`read_only=True`），导出后运行时不再依赖该库。
- 导出为 4 个文件放入 QuantInvest 自己的数据目录（建议 `data_snapshot/`），总量约 2.6 万行，可忽略体积。

### 5.2 四份文件（**日历与停牌必须分开，不得合成"有效交易日"**）

**(1) `calendar.parquet` —— 市场交易日历（7 只共用）**

| 列 | 类型 | 说明 |
|---|---|---|
| `date` | date | 区间内每个自然日 |
| `is_trading_day` | bool | `周一~周五 且 不在 holidays` |

**(2) `holidays.parquet` —— 节假日黑名单**

| 列 | 类型 | 说明 |
|---|---|---|
| `date` | date | 与源库 `raw_holidays` 逐条一致 |

导出时附带校验：对 `2013-01-01 ~ 2026-11-06` 逐年核对"日历开市日数"与基准 `sh000300` 的 bar 数，必须逐年相等（本次核对结果：每年差 0；2019–2026 合计 1902 = 1902）。

> ⚠️ **交易日历只能取 `calendar.parquet`（2026-11-08 裁定 D3）**
> 决策行的日期集合 = `calendar.is_trading_day = true` 的日期，**禁止**由 `sh000300` 的 bar 日期推断。
> 上一条的逐年核对只是**校验手段，不是推导依据**：现有实现两边差 0 是当前区间（`2019-01-02 ~ 2026-11-06`）
> 内基准恰好无缺失 bar 的**巧合**。换标的、换区间，或基准自身出现 `MISSING_BAR` 时立刻不等价
> —— 基准若缺一天，按 bar 推断会**少产出一天**的决策行，而快照日历仍要求该日有决策行。

**(3) `bars.parquet` —— 每只标的的日线（缺失即停牌）**

| 列 | 类型 | 说明 |
|---|---|---|
| `symbol` | string | `sh510300` 形式 |
| `date` | date | 交易日 |
| `open_raw/high_raw/low_raw/close_raw` | float64 | 原始不复权价（源库 `raw_kline_daily`） |
| `volume_raw` / `amount_raw` | float64 | 原始成交量/额 |
| `hfq_factor` | float64 | 当日复权因子（源库 `raw_adjust_factor`） |
| `open_hfq/high_hfq/low_hfq/close_hfq` | float64 | `raw × hfq_factor`（源码为 `close*hfq_factor`，禁止用 `v_etf_qfq`） |

**复权口径证据（必须在文档中保留）**：源库 `raw_kline_daily` 是不复权原始价；`v_etf_hfq = raw × hfq_factor`；`v_etf_qfq = raw × hfq_factor / 最新因子`。反证：510300 除息日 2012-12-18，raw 收盘 `2.366`、`raw_basic_daily.preclose = 2.370`、`change_pct = −0.17%`，而 `hfq_factor` 当日由 `1.0 → 1.0139`。只有"原始价 + 调整后 preclose + 跳变因子"自洽。

**禁止使用 qfq**：qfq 的锚点是"最新因子"，日后新增分红会改写历史数值；hfq 锚定上市首日、t 日已知，是唯一不产生未来函数的口径。

**(4) `suspensions.parquet` —— 显式停牌标记**

| 列 | 类型 | 说明 |
|---|---|---|
| `symbol` | string | |
| `date` | date | 必须是"日历开市日" |
| `reason` | enum | `MISSING_BAR` / `ZERO_VOLUME` |

生成规则：
- `MISSING_BAR`：`calendar.is_trading_day = true` 且该标的当日无 bar。
- `ZERO_VOLUME`：bar 存在但 `volume_raw == 0`（占位 bar，通常 `O=H=L=C`）。

本次已确认的样本（用于回归验证）：

| 标的 | 日期 | 类型 |
|---|---|---|
| `sh510500` | 2015-04-14 | `MISSING_BAR`（份额拆分停牌） |
| `sz159915` | 2021-02-08 | `MISSING_BAR` |
| `sh510500` | 2015-04-13 | `ZERO_VOLUME`（拆分前占位） |
| `sh513100` | 2022-01-13 | `ZERO_VOLUME`（拆分前占位） |
| `sh513500` | 2022-03-29 | `ZERO_VOLUME`（拆分前占位） |

**为什么不能合成"有效交易日"**：停牌日若从日历消失，(a) 年化持有天数少算、年化虚高；(b) T+1 会指向错误的日子（某只停牌 3 天，复牌日的 T+1 会跳过这 3 天）。因此日历、bar、停牌必须三份分离。

### 5.3 `meta.json`

必须包含：`schema_version`（源库 6.0）、`cutoff_date`（`2026-11-06`）、`exported_at`（ISO8601 含时区）、`source_db_path`、`calendar_method`（`weekday_minus_holiday_blacklist`）、`adjustment`（`raw_plus_hfq_factor`）、`accounting`（`bfq`：raw 成交价 + 真实股数/现金，分红入现金、折算调股数）、每只标的的 `first_date/last_date/bar_count`、`calendar_days`、`holidays_count`、四个文件的 `sha256`。

---

## 6. 导出格式（Python 侧逐日决策序列）

### 6.1 文件与编码

| 项 | 规定 |
|---|---|
| 主文件 | `decisions.csv` |
| 附属文件 | `portfolio.csv`、`decisions.meta.json` |
| 编码 | UTF-8（无 BOM），LF 换行，逗号分隔，首行表头 |
| 数值 | `format(v, '.17g')`（float64 全精度）；禁止四舍五入到小数位 |
| 布尔 | `0` / `1` |
| 空值 | 空字段（不是 `nan`/`None`/`NULL` 字面量） |
| 行序 | `trade_date` 升序，同日按 §2.1 池内顺序升序 |
| 额外列 | **禁止**。比对工具遇到未登记列直接判失败 |

### 6.2 `decisions.csv` 列定义（顺序固定）

| # | 列名 | 类型 | 缺失表示 | 含义 |
|---|---|---|---|---|
| 1 | `trade_date` | date | 不允许空 | 决策日 T（`YYYY-MM-DD`） |
| 2 | `symbol` | string | 不允许空 | `sh510300` |
| 3 | `jq_code` | string | 不允许空 | `510300.XSHG` |
| 4 | `in_pool` | bool | 不允许空 | 是否已上市（513000 于 2019-06-25 前为 0） |
| 5 | `has_bar` | bool | 不允许空 | T 日是否有 bar |
| 6 | `tradable_today` | bool | 不允许空 | T 日 `has_bar && volume>0 && 价>0` |
| 7 | `hfq_factor` | float | 空 | T 日复权因子（源库 `raw_adjust_factor`），供核对连续序列；停牌则为最近有效 bar 的因子 |
| 8 | `close_raw` | float | 空 | T 日 raw 收盘（决策规划价） |
| 9 | `prev_close_raw` | float | 空 | **除权调整后前收** `prev_close_adj`（§3.1a）；无公司行为时等于前一交易日 raw 收盘 |
| 10 | `open_raw` | float | 空 | T 日 raw 开盘 |
| 11 | `ma5` | float | 空 | |
| 12 | `ma10` | float | 空 | |
| 13 | `ma20` | float | 空 | |
| 14 | `ma60` | float | 空 | |
| 15 | `wsm_v2` | float | 空 | WSM V2 年化 × 加权 R² |
| 16 | `nday_return` | float | 空 | N 日年化收益 |
| 17 | `rsrs_z` | float | 空 | RSRS Z-Score |
| 18 | `momentum_primary` | float | 空 | 主槽值（§2.3） |
| 19 | `momentum_secondary` | float | 空 | 次槽值（§2.3） |
| 20 | `benchmark_primary` | float | 空 | 基准主槽值 |
| 21 | `filter_pass` | bool | 不允许空 | 通过 §3.3 第 1–9 步 |
| 22 | `reject_reason` | enum | 空（通过时） | §3.3 原因码；`RANK_TRUNCATED` 仅用于通过 1–9 但被截断的行 |
| 23 | `rank` | int | 空 | 仅 `filter_pass=1` 的行，1 起 |
| 24 | `selected` | bool | 不允许空 | `rank ≤ 6` |
| 25 | `cooldown_until` | date | 空 | 冷却截止日 |
| 26 | `target_weight` | float | 不允许空（默认 0） | §3.4 规划权重，精度 1e-12 |
| 27 | `action` | enum | 不允许空 | `BUY` / `SELL` / `HOLD` / `NONE` |
| 28 | `action_reason` | enum | 空 | `STOP_LOSS` / `TAKE_PROFIT` / `NORMAL_REBALANCE` / `OVERWEIGHT` / `REBALANCE_BUY` |
| 29 | `blocked_reason` | enum | 空 | `BLOCKED_LIMIT_UP` / `BLOCKED_LIMIT_DOWN` / `BLOCKED_SUSPENDED`（L2） |
| 30 | `days_since_entry` | int | 空（无持仓） | **自然日**差，见 §9.1 |
| 31 | `position_qty` | int | 空（无持仓） | 决策时点持仓数量（T 日收盘） |
| 32 | `unit_cost` | float | 空 | 加权平均成本 |
| 33 | `high_watermark` | float | 空 | 建仓以来最高价 |

行集合规定：**每个 (trade_date, symbol) 必须有且仅有一行**，7 只全部出现，未上市/停牌的也要出现（用 `in_pool=0` / `has_bar=0` 表示），禁止省略行。

### 6.3 `portfolio.csv` 列定义

| # | 列名 | 类型 | 含义 |
|---|---|---|---|
| 1 | `trade_date` | date | |
| 2 | `cash` | float | T 日收盘后现金（决策时点） |
| 3 | `positions_value` | float | Σ `qty × close_raw` |
| 4 | `portfolio_value` | float | `cash + positions_value` |
| 5 | `num_positions` | int | |
| 6 | `target_cash_after` | float | 规划执行后的现金（L2） |

### 6.4 `decisions.meta.json`

```json
{
  "spec_version": "DAS-3",
  "generated_at": "2026-11-08T00:00:00+08:00",
  "params_hash": "<sha256 of locked params>",
  "data_snapshot_sha256": "<sha256 of bars.parquet>",
  "window": ["2019-01-02", "2026-11-06"],
  "row_count": 0,
  "impl": "python-reference"
}
```

---

## 7. 对齐比对方法

### 7.1 比对键与粒度

- 键：`(trade_date, symbol)`，**逐日逐标的**。
- 双方键集合必须完全相等（缺行/多行都判失败）。
- 不比对跨日聚合值（如年化、夏普）；这些属于报告层，不是决策层。

### 7.2 数值容差

```text
|a − b| ≤ 1e-9 × max(1, |a|, |b|)
```

- 对 `target_weight` 用同一公式（权重本身 ≤ 1，故等价于绝对 1e-9）。
- 任一侧为空值时，另一侧必须也为空；空 vs 0 判失败（这两者在语义上不同）。
- `rank`、`position_qty`、`days_since_entry` 为整数，要求**精确相等**。

### 7.3 判定项

| 项 | 判定 |
|---|---|
| 键集合 | 完全一致 |
| `filter_pass` / `selected` / `in_pool` / `has_bar` | 完全一致 |
| `reject_reason` / `action_reason` / `blocked_reason` | 完全一致 |
| 指标与权重 | 1e-9 内 |
| `rank` | 精确 |

### 7.4 标的池变化的处理（513000）

- `2019-01-02 ~ 2019-06-24`：`513000` 必须出现在每天的决策行中，且
  `in_pool=0, has_bar=0, tradable_today=0, 指标列全空, filter_pass=0,
   reject_reason=POOL_ABSENT, rank 空, selected=0, target_weight=0, action=NONE`。
- `2019-06-25` 起：`in_pool=1`；但在其第 60 根 bar 之前，指标按 §3.2(d) 短路为 `0.0`（`ma` 列为空还是 0 由本规格统一规定：**`ma5/10/20/60` 在短路时导出为空**，其余指标导出 `0`）。
- 池子在任何日期都**不缩容**：不因为某只没数据就把别的标的权重按比例放大。

### 7.5 停牌日的处理

| 字段 | 停牌日取值 |
|---|---|
| `has_bar` | 0 |
| `tradable_today` | 0 |
| `close_raw/open_raw` | 空 |
| `hfq_factor` | 最近有效 bar 的因子（**非空**） |
| 指标 | 与前一交易日相同（用最近可用序列计算，**非空**） |
| `filter_pass` / `reject_reason` | 0 / `SUSPENDED` |
| `action` | 持仓则 `HOLD`，否则 `NONE` |
| `target_weight` | 持仓则维持原规划权重，否则 0 |
| `blocked_reason` | 若本应有卖出/买入 → `BLOCKED_SUSPENDED`（L2） |

### 7.6 对齐窗口

- 主窗口：`2019-01-02 ~ 2026-11-06`（覆盖 513000 的上市前后，用于验证池变化）。
- 预热段（`2019-06-25 ~ 首个 60 根 bar 完成的交易日`，约 `2019-09-20`）必须一致，但不参与绩效评估。
- **当前快照的实际起点（2026-11-08 核查）**：`data_cache/daily/*.csv` 中 7 只标的全部起于 `2022-01-04`、止于 `2026-09-11`（冒烟区间）；源库 `quotes.duckdb` 中各标的起点更早（`sz159915` 2011、`sh510300` 2012-12-18、`sh518880`/`sh510500`/`sh513100` 2013、`sh513500` 2014-01-15、`sh513000` 2019-06-25）。即 `2014-01` 起在源库可用、**在当前快照不可用**。本阶段未补采；本地回测实际可用窗口由快照决定，待确认后再定基线区间。

### 7.7 失败诊断输出

比对工具必须输出：
1. 不匹配行数 / 总行数；
2. 按字段统计的不匹配率（定位是哪个规则错）；
3. 前 10 条差异，原样打印 `key`、`column`、`python_value`、`mvp_value`、`abs_diff`；
4. 首次出现差异的日期与标的（用于按时间线回溯）。

---

## 8. 验收流程

```text
1. 导出快照 → 校验 4 个文件 sha256 一致；校验日历与基准 bar 逐年相等。
2. Python 参考端：按 §6 导出 decisions.csv / portfolio.csv（L1 即可）。
3. MVP 端：同快照、同参数导出同格式文件。
4. 比对工具逐键比对：L1 必须 0 差异。
5. L2 前置条件满足后（Python 执行端改为 t1_open），再比对 action / target_weight / position_qty。
6. 抽样人工复核：随机 20 个交易日，人工核对主槽排序与 reject_reason。
```

**L1 通过标准**：0 差异（不是"差异率 < 1%"）。任何 1e-9 以上的差异都必须定位到具体规则，不允许用容差放宽掩盖。

---

## 9. 已确认的语义陷阱（实现端必须照抄）

| 编号 | 陷阱 | 正确处理 |
|---|---|---|
| 9.1 | `min_hold_days` 与 `days_since_entry` 名义上是"交易日"，**代码实际是自然日差** `(current_date − first_trade_date).days` | 必须按**自然日**实现，否则停牌/长假后 `min_hold_days=5` 的触发日会差 1–3 天 |
| 9.2 | `filter_by_benchmark` 用 `>=`（含等于），文档写的是 `>` | 按 `>=` 实现 |
| 9.3 | 涨跌停判定用 `>= up_limit` / `<= down_limit`（触及即算） | 按触及即算 |
| 9.4 | MA 多头是**全严格** `>` 链，不允许 `>=` | 严格 |
| 9.5 | `check_daily_change_range` 有 `1e-9` 边界容差 | 保留容差 |
| 9.6 | 并列排名靠**稳定排序 + 池内顺序**，不是按代码字典序 | 按 §2.1 顺序 |
| 9.7 | `allocate_capital` 的现金是**均分给全部候选（含已持仓）**，再按 33% 上限裁剪 | 不要改成"只给新标的" |
| 9.8 | 超限减仓的分母是"剩余持仓市值之和"，**不含现金**，且持仓数 ≤ 1 时不触发 | 照抄 |
| 9.9 | 部分减仓后剩余 < 100 股 → 改为全部卖出 | 照抄 |
| 9.10 | 加仓不重置 `first_trade_date` 与 `high_watermark`；只有新建仓才初始化 | 照抄 |
| 9.11 | 冷却只由 `STOP_LOSS` / `TAKE_PROFIT` 触发，正常调仓与超限减仓**不设冷却** | 照抄 |
| 9.12 | 冷却窗口是 `sell_date < T ≤ end_date`，`end_date` 由交易日历 `idx + cooldown_days` 求得（含首尾） | 照抄 |
| 9.13 | `len(close) < 60` 时指标整体短路返回 0，不是逐指标退化 | 照抄 |
| 9.14 | hfq 因子在拆分/折算日会**跳变且可升可降**（510500 2015-04-15 由 1.0 → 0.2803；513100 2022-01-14 由 1.0 → 5.0；513500 2022-03-30 由 1.0 → 2.0） | 不得假设因子单调递增；bfq 账本必须按 gbbq 事件调股数，否则净值在折算日凭空缩水 |
| 9.15 | 分红与折算必须分开处理：`c1` 是**每 10 份**派现（故每份 = c1/10），`c3` 是份额乘子 k | 不得把两者混成一个"因子乘子" |

---

## 10. 本规格与现有 Python 实现的差异清单

| 项 | 现有 Python | 本规格 | 状态 |
|---|---|---|---|
| 信号时点 | T 日收盘（实际已如此，注释写错为 T−1） | T 日收盘 | 一致 |
| 成交时点 | T 日收盘（同 bar 成交） | T+1 开盘 | **已改（DAS-3）**：本地回测 + 聚宽两份执行端 |
| `price_model` | `close` / `next_open` / `vwap` 三选 | 仅 `t1_open` | **已改（DAS-3）**：其余值抛 `ValueError`，`next_open` 分支删除 |
| 停牌（执行层） | `next_open` 静默取复牌日开盘价 | 当日订单失效、不顺延（§4.3） | **已改（DAS-3）** |
| 复权与记账 | 使用仓库内不复权 CSV，但未做公司行为 | 账本 bfq（raw 价/真实股数/真实现金）；指标用前复权到当日序列 | **已改（2026-11-08，见 `local_backtest_design.md` §15）** |
| 交易日历 | 由 000300 bar 推断 | 快照 calendar + holidays | **需改（数据适配）** |
| 停牌 | 无标记，持仓按 0 估值（本次已修） | 独立 suspensions + 不可成交 | 部分已修 |
| 决策导出 | 无 | §6 固定格式 | **待实现** |
| 寻优 | `run_param_scan`（已标弃用） | 迁至 MVP | 已标弃用 |
| 超额收益 | 多加 1（本次已修） | 年化差 | 已修 |

> 结论：**DAS-1 阶段 Python 改动只含"修 2 个 bug + 标废 2 个模块"**；`DAS-2` 把本地回测记账口径改为 bfq（见上表与 `local_backtest_design.md` §15）；`DAS-3` 把本地回测与聚宽两份执行端的成交时点统一为 T+1 开盘，并把停牌口径写死为"当日订单失效、不顺延"。旧回测结果不能当基线——成交时点、复权口径、停牌处理三者同时变化，历史收益必然改变。

### 10.1 2026-11-08 数据源核对与三处口径裁定

**（一）三处口径已写进正文**

| 编号 | 事项 | 裁定 | 写在哪 |
|---|---|---|---|
| D1 | 零成交量占位 bar 的快照价 | 跟 Python `snapshot_prices`：取 `last_valid_close`；`tradable_today=0` 控制可成交性；过滤照常。**标注为"对齐选择，非数学唯一解"** | §3.3 补充规定 |
| D2 | WSM V2 的 R² 分母 `ȳ` | 跟 Python：**未加权算术均值**。**标注为"已知偏差点"**：现阶段对齐是唯一可验证判据，为"更正确"而偏离会让判据失效；待 L2 稳定后单独决策 | §3.2(a) |
| D3 | 交易日历 | **必须取 `calendar.parquet`**，禁止由 `sh000300` 的 bar 日期推断；逐年核对只作校验 | §5.2 |

**（二）两源 bar 逐根核对结果（决定"L1 对齐结论是否成立"）**

比对对象：Python 侧 `data_cache/daily/*.csv`（AKShare，`adjust='hfq'` 入参）vs MVP `DuckDB raw_kline_daily`。

| 项 | 结果 |
|---|---|
| **缓存实际是 raw，不是 hfq** | 逐根比对 `csv` 与 `raw_kline_daily`：7 只 ETF 在 **1138 个重叠日**上 OHLC **相对差 = 0**（逐位相同）。故尽管代码传 `adjust='hfq'`，落盘的是不复权价（应为 sina 分支或后续被覆盖） |
| 日期对齐 | 重叠 1138 = CSV 全部行数；**无缺日、无多余日** |
| 成交量（ETF） | `db/csv` 中位数 = **1**（单位一致，股） |
| 成交量（基准 `sh000300`） | `db/csv` 中位数 = **0.01** ⇒ **单位差 100×**（手 vs 股） |
| 价格精度（基准 `sh000300`） | 相对差最大 **1.5e-6**（4511 个字段 > 1e-9）⇒ 基准存的是低位有效数字，**逐位对齐会失败** |
| 覆盖区间 | CSV 仅 **2022-01-04 ~ 2026-09-11**（1138 根）；DuckDB 自 2012 起、截至 **2026-11-06** ⇒ **Python 侧当前产不出 §7.6 的 `2019-01-02 ~ 2026-11-06` 窗口** |

结论：**"日期/OHLCV 逐根对齐"在重叠区间成立（ETF 逐位相同），但这条对齐不构成 L1 的对齐结论** ——
① 缓存是 raw，而 DAS-2 要求指标用"前复权到当日"，`510300`(年度分红)、`510500`/`513100`/`513500`(折算)
这几只上两侧指标输入**必然不同**；② 覆盖区间不足；③ 基准有 1e-6 精度差与 100× 成交量单位差。

**（三）因此的口径**

MVP 侧 L1 的 golden 只证明**公式等价**（golden 输入是确定性合成序列，不依赖任何真实数据源），
**不能**当作"数据同源已验证"。正式对齐必须等 `§5` 四文件快照 + `sha256` 到手后，
两侧读同一份快照重做一次；在此之前不注册 `BUILTINS`、不把当前 golden 通过当最终结论。


---

## 11. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| `DAS-1` | 2026-11-08 | 首版：参数锁定、决策字段、比对方法、快照约定、导出格式 |
| `DAS-2` | 2026-11-08 | **记账空间由 hfq 改为 bfq**（否决 DAS-1 的"成交价 `open_raw × hfq_factor`、分红视为再投资"）：账本记真实股数/现金/成交额，成交价与费用基数用 raw；分红入现金、折算调股数；指标改用"前复权到当日"连续序列（§3.1a）；导出列 `close_hfq` → `hfq_factor`。同时把聚宽执行端改为 T+1 开盘（`joinquant_strategy.py` / `joinquant_onefile.py`，**列为下一步，尚未实施**）。 |
| `DAS-3` | 2026-11-08 | **成交时点统一为 T+1 开盘，已实施**：本地回测（`local_backtest.py`）改为"T 日收盘产出 `ExecutionPlan` → T+1 09:30 按 raw 开盘价执行"，聚宽两份执行端（`joinquant_strategy.py` / `joinquant_onefile.py`）改为 `run_daily(_open_execution, '09:30')` + `after_trading_end` 决策，行为逐条对应。§2.4 收紧为唯一 `t1_open`（`close`/`vwap` 移除、`next_open` 分支删除）。§4.3 **写死停牌口径："当日订单失效、不顺延、不跨日挂单"**，并给出三条理由（与聚宽实盘一致 / 旧信号已过期 / 避免订单队列状态机）。新增 §4.5 执行拒绝记录列定义。L2 前置条件就此满足，进入可跨端比对状态。 |
| `DAS-2.1` | 2026-11-08 | 三处口径裁定并写入正文：**D1** 占位 bar 快照价 = `last_valid_close`（标注"对齐选择，非数学唯一解"，§3.3）；**D2** WSM R² 分母 `ȳ` = 未加权均值（标注"已知偏差点"，§3.2(a)）；**D3** 交易日历必须取 `calendar.parquet`，禁止由 `sh000300` bar 推断（§5.2）。新增 §10.1 两源 bar 逐根核对结果：AKShare 缓存实为 **raw**（非 hfq）、重叠 1138 日 ETF OHLC 逐位相同、基准 `sh000300` 有 1e-6 精度差与 100× 成交量单位差、缓存仅覆盖 `2022-01-04 ~ 2026-09-11`。**推论**：MVP 侧指标 golden 只证明公式等价，不构成数据同源结论；正式对齐须等 §5 快照 + `sha256`，在此之前不注册 `BUILTINS`。 |
