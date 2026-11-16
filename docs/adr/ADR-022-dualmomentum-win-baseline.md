# ADR-022 —— DualMomentum 跑赢档成为正式基线（目标函数 = 跑赢 `sh510300`）

| 项 | 值 |
|---|---|
| **状态** | ✅ 已接受（2026-11-12，owner 选定「跑赢档」目标函数并签字） |
| **落地** | `apps/backend/src/services/backtest/strategies/dualmomentum/params.ts`（`DUALMOMENTUM_DEFAULTS`）+ `docs/audit/dualmomentum-l1-alignment.md` §13.10~§13.15 |
| **关联文档** | `docs/audit/dualmomentum-l1-alignment.md` §12.1（目标函数前提）、§12.8（落地顺序）、§13.6~§13.13（各档实测）、§13.10（最终结论 + 纪律底线） |
| **取代** | 取代「DAS-3.1 §2.2 锁定参数作为 DualMomentum 缺省基线」的实现口径（**不取代** DAS 规格正文与 `l1/params.ts` 的锁定常量——那些仍是 `POOL_ORDER` / `WSM_MAX` 等**对齐契约**的可回退目标） |

---

## 1. 背景

### 1.1 DAS 锁定基线的实测表现不满足目标函数

`docs/audit/dualmomentum-l1-alignment.md` §12.8 按 §12.8 五步（诊断 → 档 1 → 档 2 → 档 3 → 档 4）走完后，
§12.1 的目标函数二选一定义了两条互斥的路线：

| 目标 | 工作点 | CAGR | MDD | Calmar | 超额 |
|---|---|---|---|---|---|
| 低回撤绝对收益 | 档 1（关超配 + cash 2%） | 6.62% | 11.86% | 0.56 | +0.58pp |
| **跑赢 `sh510300`** | **T3c + mh=20 + cash 2% + vol(0.12)** | **11.65%** | **26.46%** | **0.44** | **+5.63pp** |
| （DAS 锁定基线） | 默认 | 2.25% | 13.11% | 0.17 | **−3.79pp** |

**owner 选定「跑赢档」**（2026-11-12）。在该目标下，DAS 锁定基线**跑输基准 3.79pp**，不可接受。

### 1.2 §13.10 的纪律底线要求先开 ADR

§13.10 原文：「以上任何一条若要成为基线，**必须另开 ADR + 重跑对齐基线**（spec owner 签字）；
本次交付全部是 **opt-in 研究参数**，缺省值逐位等于 DAS 锁定语义（`--check-baseline` 持续可验 `final=1,189,224.15`）」。

本 ADR 即该纪律底线的落地。

---

## 2. 决策

### 2.1 采纳的缺省参数（`DUALMOMENTUM_DEFAULTS`）

相对 DAS-3.1 §2.2 锁定值，**7 项**改变：

| 参数 | DAS 锁定值 | 采纳值 | 来源 |
|---|---|---|---|
| `wsmMaxResearch` | 5（= `wsmMax`） | **100** | 档 3 §12.5 第 1 条（放宽上界） |
| `rsrsMaxResearch` | 2（= `rsrsMax`） | **100** | 档 3 §12.5 第 1 条 |
| `scoreMode` | `and` | **`scored`** | 档 3 §12.5 第 3 条（AND → 评分制） |
| `benchmarkGateMode` | `hard` | **`soft`** | 档 3 §12.5 第 2 条（实测零效果，为口径完整保留） |
| `minHoldDays` | 5 | **20** | 档 1 §12.3 第 3 条（降换手） |
| `cashInterestRate` | 0 | **0.02** | 档 1 §12.3 第 1 条（闲置现金 2% 计息） |
| `exposureMode` | `fixed` | **`vol`**（`targetVol=0.12`, `volWindow=20`） | 档 2 §12.4 第 2 方案（波动率目标） |

**保持 DAS 锁定值不变**（未采纳的项）：`momentumCombo` / `wsmPeriod` / `useWsmV2` / `ndayReturn*` / `rsrsPeriod` /
`rsrsStdPeriod` / `rsrsQualityFilter` / `wsmMin` / `rsrsMin` / `maPeriod*` / `dailyChange*` / `maxHoldings` /
`singlePositionCap` / `overweightThreshold` / `takeProfit*` / `stopLoss*` / `commissionRate` / `minCommission` /
`slippage` / `lotSize` / `etfExemptTax` / `benchmark`。
**且明确不采纳**（实测否决，见 §13.12/§13.14/§13.15）：`capRelaxBelow`（负向）、`momentumDecayExit`（−1.76pp）、
`trailingTakeProfit`（逐位等价 / 紧档负向）、`symbolWeights` 黄金腿加权（MDD +1.5~1.7pp 拉低 Calmar）。

### 2.2 新基线锚点（重跑 `--check-baseline` 实测）

```console
$ DUCKDB_PATH=/opt/invol/quotes.duckdb \
    node_modules/.bin/tsx apps/backend/src/services/backtest/optimize/dmSweep.ts --check-baseline
面板：116 只 / 基准 sh000300 1951 根 / sh510300 1951 根 / 指数 4 只
BASELINE final=2363029.30 cum=136.30% cagr=11.65% mdd=26.46% trades=4657 equityDays=1891
```

| 项 | DAS 锁定基线（旧锚点） | **跑赢档基线（新锚点）** |
|---|---|---|
| `final` | 1,189,224.15 | **2,363,029.30** |
| `cum` | 18.92% | **136.30%** |
| `cagr` | 2.25% | **11.65%** |
| `mdd` | 13.11% | **26.46%** |
| `trades` | 1780 | **4657** |

> ⚠️ **本次决策连带修复了一个隐性缺陷**：`resolveDualMomentumParams` 的
> `exposureMode` / `benchmarkGateMode` / `scoreMode` 三项此前用**字面量 fallback**
> （`'fixed'` / `'hard'` / `'and'`）而非回落到 `DUALMOMENTUM_DEFAULTS`，
> 导致**改 DEFAULTS 不生效**。已改为回落 `d.xxx`（否则本 ADR 无法落地）。

---

## 3. 代价（明写，供日后回退判断）

| 代价 | 量化 | 缓解 |
|---|---|---|
| **最大回撤翻倍** | MDD 13.11% → **26.46%**（+13.35pp） | 波动率目标已内含减仓逻辑（波动冲高日自动降暴露）；`stopLossHigh=0.12` 不变 |
| **换手翻倍** | 1780 → 4657 笔；摩擦 6.68%/yr → 8.62%/yr | `minHoldDays=20` 已把换手压到 24.4（vs 基线 29）；`cashInterestRate=2%` 吃掉部分摩擦 |
| **对 DAS 对齐契约的偏离** | `wsmMax` / `rsrsMax` / 过滤语义 3 项 | 全部保留为 **opt-in 可回退参数**（`wsmMaxResearch` / `rsrsMaxResearch` / `scoreMode`），显式传回旧值即可复原 DAS 语义 |
| **样本期依赖** | 2019-01-02 ~ 2026-11-06 单区间，7 只池，1 次回测 | 未做样本外/滚动窗口验证；§12.7 已明确不建议在网格上继续调参（过拟合入口） |

---

## 4. 被否决的备选方案

| 备选 | 否决理由 |
|---|---|
| **维持 DAS 锁定基线不变**（现状） | 在「跑赢 `sh510300`」目标下**跑输基准 3.79pp**，与 owner 选定目标直接冲突 |
| **采纳低回撤档**（档 1：关超配 + cash 2%） | CAGR 6.62% / 超额 +0.58pp，仅微幅跑赢；owner 已选定跑赢档 |
| **采纳跑赢档 + vol(0.12) + 黄金腿加权** | §13.15 实测 MDD +1.5~1.7pp，Calmar 0.44 → 0.41/0.42（**降**） |
| **采纳跑赢档 + vol + volWindow=10** | §13.15 实测 CAGR +0.21pp / 超额 +5.84pp 最高，但 Calmar **持平 0.44**，优势不显著（不足以推翻 §13.13 已判定的 vol(0.12)） |
| **采纳追踪止盈 / 动量衰减退出** | §13.14 / §13.12 实测：逐位等价或负向（−1.76pp / −0.16pp） |
| **扩池加债券 ETF**（§12.6 档 4） | 唯一还能把 Calmar 推过 0.44 的结构性路径，但 owner 明确「不引入新 ETF」；留作后续 ADR 候选 |
| **改 `l1/params.ts` 的 `WSM_MAX` / `RSRS_MAX` 锁定常量** | 那是**对齐契约**（DAS-2），改动会让 L1 逐位对齐失效；本 ADR 只改**研究上界参数**，锁定常量保留为可回退目标 |

---

## 5. 回退方案

```bash
# 回退到 DAS 锁定基线：revert 本 ADR 对应 commit（params.ts 那一处改动）
git revert <本 PR 的 squash commit>
# 回退后基线锚点应恢复：final=1189224.15 cum=18.92% cagr=2.25% mdd=13.11% trades=1780
```

**不需要**改 `l1/params.ts`、不需要改 `POOL_ORDER`、不需要迁移数据、不需要改 DDL。
所有被采纳的参数都保留为可显式覆盖的 opt-in 字段。

---

## 6. 影响面

| 范围 | 影响 |
|---|---|
| `DUALMOMENTUM_DEFAULTS` | 7 项缺省值改变（§2.1） |
| `resolveDualMomentumParams` | 3 项字面量 fallback 改为回落 `d.xxx`（缺陷修复） |
| 纸面账户（方案 D） | 建户缺省即跑赢档组合；`paramSchema` 透出新的缺省值 |
| 回测 CLI / `--check-baseline` | 新锚点 `final=2363029.30 / trades=4657` |
| `docs/audit/dualmomentum-l1-alignment.md` | §13.10 纪律底线解除；§13.6~§13.15 实测记录保留为采纳依据 |
| DDL / API / 路由 / 前端 | **无变更** |

---

## 7. 签字

| 角色 | 决定 | 日期 |
|---|---|---|
| owner（目标函数选定 + 签字） | 跑赢档 | 2026-11-12 |
| 实施 agent（落盘 + 重跑基线） | ADR-022 + `DUALMOMENTUM_DEFAULTS` 改动 + 新锚点 | 2026-11-12 |

---

## 8. 后续更正（2026-11-13，指向 **ADR-030**）

> 本节为**事后更正**，不改写 §1~§7 的原文（决策记录不静默修改，见 `docs/adr/README.md`）。
> 冲突的完整事实、实测评估与三条处置路线见 **ADR-030**（`docs/adr/ADR-030-ma-filter-spec-conflict.md`）。

### 8.1 需要更正的表述（3 处）

| # | 原文位置 | 原表述 | 更正 |
|---|---|---|---|
| ① | §2.1「保持 DAS 锁定值不变」清单 | 列有 `maPeriod*` / `dailyChange*` | **参数值**确实未改；但**用这些参数的过滤在缺省下不执行**（见 8.2）⇒ 该表述字面正确、**语义误导** |
| ② | §4 代价表「对 DAS 对齐契约的偏离」行 | 「全部保留为 opt-in 可回退参数…**显式传回旧值即可复原 DAS 语义**」 | ❌ **实测不成立**：`resolveDualMomentumParams` 会把显式传入的 `'hard'` / `'and'` **回落**为 `'soft'` / `'scored'` ⇒ **DAS 语义当前不可复原** |
| ③ | §2.1 的收益归因 | 把主要收益归给「档 3 放宽上界」 | 实测：**放宽上界只值 +0.74pp CAGR**；主要来源是**旁路 MA / 日涨跌 / 停牌 / 涨跌停**（+9.51pp）⇒ 归因与实测不符 |

### 8.2 缺省下的实际过滤语义（2026-11-13 实测）

缺省走「档 3 重建路径」，该路径**只判 3 个条件**（动量区间用 research 上界 / 次槽 / 基准门槛），
**不判**完整过滤链里的 `SUSPENDED` / `COOLDOWN` / `AT_LIMIT` / `DAILY_CHANGE` / `BELOW_MA20` / `MA_NOT_BULLISH`
⇒ **MA 趋势过滤、停牌、涨跌停、日涨跌幅、冷却在跑赢档基线下均不生效**。

- 旁路频次（真库 1891 交易日 × 7 只池）：MA 层 2871 次（占纳入 48.8%）、日涨跌幅 45、冷却 31、涨跌停 6、停牌 1。
- 实测影响（同一套本 ADR 其余缺省）：补 MA 层 ⇒ CAGR 10.57% → **1.06%**、超额 +4.55pp → **−4.96pp**。

### 8.3 关联的伪结论（需重测）

本 ADR §2.1 采纳 `benchmarkGateMode='soft'` 的理由是「**实测零效果**，为口径完整保留」。
该「实测」是**伪对照**：`hard` 被 `resolve` 回落成 `soft`，两组本就是同一套参数
（见 ADR-030 §2.6 / §2.7）⇒ **「基准软化是否真的零效果」从未被真正验证**，
须在修好 `resolve` 后重测（ADR-030 §6.2 第 6 项）。

### 8.4 本 ADR 的效力

本 ADR 的**决策本身**（选「跑赢 `sh510300`」为目标函数、采纳 7 项参数、锚定新基线）**不撤销**；
但 §2.1 的**归因**与 §4 的**可回退承诺**需按上表更正，且「跑赢档是否允许以放弃 MA 过滤为代价」
这一**规格层问题**待 owner 在 ADR-030 §5 三条路线中裁决。
