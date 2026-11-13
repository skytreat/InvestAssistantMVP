# DualMomentum 基线切换到 ADR-024（基准破位切防御）验收（PR #171）

> **判定人**：Agnes AI（实施 agent）
> **日期**：2026-11-12
> **波次**：DualMomentum 基线切换 #2（ADR-024 采纳）
> **PR**：#171 `feat/dm-breakout-baseline` → `main`
> **上游**：[ADR-024](../../../docs/adr/ADR-024-benchmark-breakout-defensive.md)（owner 选 B）+ §13.17 实测 + §13.18 锚点
> **Base**：`main`（`17ec570`）

---

## 0. 判定结论

| 门槛 | 判定 | 实测依据 |
|---|---|---|
| **G-SW1**（新基线锚点已重跑） | ✅ **PASS** | `--check-baseline` → `final=2189713.16 cum=118.97% cagr=10.57% mdd=18.97% trades=4680`，与 §13.17 实测**逐位一致** |
| **G-SW2**（三方证据一致） | ✅ **PASS** | `dmSweep --check-baseline` = `dmDiagnose` 基线自证 = 独立复核（`loadSweepData` 全市场装载）= **10.57% / 18.97% / 4680 笔** |
| **G-SW3**（单测零回归） | ✅ **PASS** | `dualmomentumStrategy.test.ts` 17/17（新增 1 例：显式关闭两条防御路径）；`paper-*` 74/74 |
| **G-SW4**（lint + typecheck 全绿） | ✅ **PASS** | eslint 0 错；tsc 0 错 |
| **G-SW5**（ADR 已签字 + 锚点同步三处） | ✅ **PASS** | ADR-024 §3/§7 已签字（owner 选 B）；`dmDiagnose.BASELINE` 锚点已更新；§13.17/§13.18 已标注 |
| **G-SW6**（装载层缺陷双修 + 关闭语义修复） | ✅ **PASS** | `dmDiagnose` + `dmSweep` 共用 `collectStrategyExtraSymbols()`；`defensiveSymbol` 改「键存在即用之」 |

### 0.1 判定

```
✅ PASS（G-SW1 ~ G-SW6 六条全过，0 豁免）
```

---

## 1. G-SW1 —— 新基线锚点

```console
$ DUCKDB_PATH=/opt/invol/quotes.duckdb \
    node_modules/.bin/tsx apps/backend/src/services/backtest/optimize/dmSweep.ts --check-baseline
BASELINE final=2189713.16 cum=118.97% cagr=10.57% mdd=18.97% trades=4680 equityDays=1891
```

| 项 | DAS 锁定基线 | ADR-022 | **ADR-024（当前）** |
|---|---|---|---|
| `final` | 1,189,224.15 | 2,363,029.30 | **2,189,713.16** |
| `cagr` | 2.25% | 11.65% | **10.57%** |
| `mdd` | 13.11% | 26.46% | **18.97%** |
| `trades` | 1780 | 4657 | **4680** |
| Calmar | 0.17 | 0.44 | **0.56** |
| 超额 | −3.79pp | +5.63pp | **+4.55pp** |

---

## 2. G-SW2 —— 三方证据一致

| 测量路径 | CAGR | MDD | 笔数 |
|---|---|---|---|
| `dmSweep --check-baseline` | 10.57% | 18.97% | 4680 |
| `dmDiagnose` 基线自证 | 10.57% | 18.97% | 4680 |
| 独立复核（`loadSweepData` 全市场装载） | 10.57% | 18.97% | 4680 |
| ADR-022 对照组（显式关闭破位） | 11.65% | 26.46% | 4657 |

---

## 3. G-SW6 —— 三处工程修复

| # | 问题 | 处置 |
|---|---|---|
| 1 | `dmDiagnose.loadPanel()` 漏装实验标的 ⇒ 防御态下单**成交不了** ⇒ **静默退化成切现金**（首轮虚高 `11.73% / 16.03%`） | 与 #2 一并修 |
| 2 | `dmSweep.loadPanel()` **同样**漏装 ⇒ 切缺省后 `--check-baseline` 报出虚高数字 | 新增 `optimize/marketData.ts` 的 `collectStrategyExtraSymbols()`，**跟随 `DUALMOMENTUM_DEFAULTS` 自动收集**；`dmSweep` + `dmDiagnose` **共用** ⇒ 不会再各漏一次 |
| 3 | `defensiveSymbol` 的 resolve 原为「空串回落默认值」⇒ **无法显式关闭**防御回退（ADR-022 对照组因此跑出 `9.54% / 29.60%` 错误数字） | 改为「**键存在即用之**」：显式传 `''` 即关闭 |

---

## 4. 回退方式

```ts
{ defensiveSymbol: '', benchmarkBreakoutThreshold: 0 }   // → 恢复 ADR-022 语义
```

---

## 5. 合并条件核对

| 条件 | 状态 |
|---|---|
| CI `build-and-test` 通过 | ⏳ 待 push 后 CI 结果 |
| G-SW1 ~ G-SW6 全 PASS | ✅ 本审计已落 |
| ADR-024 签字 + 锚点同步（代码 / dmDiagnose / 文档三处） | ✅ |
| 验收落档与本波 commit 同 PR | ✅ 本文件 |

**判定：本审计 PASS。CI 全绿后可 squash merge。**
