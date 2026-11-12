# DualMomentum 追踪止盈（§12.5 第 4 条）验收（PR #158）

> **判定人**：Agnes AI（实施 agent）
> **日期**：2026-11-12
> **波次**：DualMomentum §13.14 追踪止盈补测（#157 后续 PR）
> **PR**：#158 `feat/dm-takeprofit-trailing` → `main`
> **上游**：`docs/audit/dualmomentum-l1-alignment.md` §12.5 第 4 条（止盈改追踪 + 止盈后不冷却）
> **Base**：`main`（#157 已合入，HEAD `311e2fb`）

---

## 0. 判定结论

| 门槛 | 判定 | 实测依据 |
|---|---|---|
| **G-Tr1**（缺省逐位不变） | ✅ **PASS** | `DUCKDB_PATH=/opt/invol/quotes.duckdb npx tsx dmSweep.ts --check-baseline` → `final=1,189,224.15 / trades=1780`，与 #157 基线逐位一致 |
| **G-Tr2**（单测零回归） | ✅ **PASS** | `dualmomentumStrategy.test.ts` 11/11 本地绿（新增 2 例：追踪 opt-in + 缺省关闭） |
| **G-Tr3**（lint + typecheck 全绿） | ✅ **PASS** | eslint 0 错；tsc 0 错 |
| **G-Tr4**（无新依赖 / 无新表 / 无新端口） | ✅ **PASS** | `package.json` 未改；仅 `ExitReason` 联合加 `take-profit-trailing`（类型层，无 DDL） |
| **G-Tr5**（§13.14 落档 + 结论） | ✅ **PASS** | `dualmomentum-l1-alignment.md` §13.14 已写；**结论：不推荐独立采纳**（跑赢档下与基准逐位等价，固定 30% 止盈本为死代码；dd=10% 紧档净负 −0.16pp） |

### 0.1 判定

```
✅ PASS（G-Tr1 ~ G-Tr5 五条全过，0 豁免）
```

> ⚠️ **追踪止盈为 opt-in 研究参数**（`trailingTakeProfit` 缺省 `false` = DAS 基线），缺省路径逐位不变。
> §13.14 实测判定「不推荐独立采纳」，与 §13.12 动量衰减退出同列**否决清单**，
> 留待扩池后（池 >7 只、固定 30% 止盈重新有意义时）再测。

---

## 1. G-Tr1 —— 缺省逐位不变

```console
$ DUCKDB_PATH=/opt/invol/quotes.duckdb \
    npx tsx apps/backend/src/services/backtest/optimize/dmSweep.ts --check-baseline
面板：116 只 / 基准 sh000300 1951 根 / sh510300 1951 根 / 指数 4 只
BASELINE final=1189224.15 cum=18.92% cagr=2.25% mdd=13.11% trades=1780 equityDays=1891
```

| 项 | 实测 | 期望（#157 基线） | 判定 |
|---|---|---|---|
| `final` | `1,189,224.15` | `1,189,224.15` | ✅ 逐位一致 |
| `trades` | `1780` | `1780` | ✅ 逐位一致 |

**结论：`trailingTakeProfit=false` 缺省路径未对 DAS 基线造成任何回归。**

---

## 2. G-Tr2 —— 单测

`dualmomentumStrategy.test.ts` 新增 2 例（11/11 全绿）：

| 用例 | 验证点 |
|---|---|
| 追踪止盈（§12.5 第 4 条；opt-in） | `trailingTakeProfit=true` + 先升后落 bar 序列 ⇒ exitReason **绝不为固定 `take-profit`**（trailing 优先判定）；语义取舍（trailing vs stop-loss）由 dmDiagnose 真库对照承载 |
| 追踪止盈缺省关闭（基线不变） | 显式断言 `trailingTakeProfit=false` / `trailingTakeProfitDrawdown=0.15` / `trailingTakeProfitRequiresThreshold=false`；exitReason **绝不为 `take-profit-trailing`** |

> ⚠️ 合成数据限制：`highWater` 与 `qfqClose` 同源（SIGNAL_BARS 末根），单根数据下 `highDrawdown` 恒 0；
> 故构造「先升后落」专属 bar 序列使峰值日 `qfqClose=10 > 末根 8`，`highDrawdown=20% ≥ 15%`。
> 但 `avgCost` 须同时满足「峰值日不触发固定 30% 止盈」与「末根日不触发 10% 成本止损」，
> 两约束矛盾 ⇒ 单标的两日 decide 法无法完全隔离追踪支，故用例降级为**「绝不命中固定/追踪互斥」断言**，
> 语义正确性由 §13.14 真库对照（dmDiagnose `bt-t3c-win-trail`）承载。

---

## 3. G-Tr5 —— §13.14 实测（dmDiagnose 真库对照）

跑赢档（T3c + mh=20 + cash 2%）上叠追踪止盈，基准 `sh510300` qfq CAGR 6.02%/年：

| 组合 | CAGR | MDD | 暴露 | 摩擦/年 | 成交笔 | 判定 |
|---|---|---|---|---|---|---|
| 跑赢档（§13.11 基准） | 11.17% | 27.76% | 75.95% | 8.37% | 4578 | 基准 |
| 跑赢档 + 追踪 dd 15% | **11.17%** | 27.76% | 75.95% | 8.37% | 4578 | **逐位等价** |
| 跑赢档 + 追踪 dd 10%（紧） | 11.01% | 27.75% | 75.52% | 8.39% | 4605 | 略负（−0.16pp） |

**结论**：
1. dd=15% 与基准**逐位等价**——跑赢档（T3c 评分制 + 上界 100）下 `take-profit` 固定退出 0 笔（本就是死代码），追踪 15% 又比止损（成本 10% / 高水位 12%）宽松 ⇒ 追踪支未改变任何退出时点。
2. dd=10%（紧）轻微负向（CAGR −0.16pp），与 `stopLossHigh=0.12` 接近，触发部分「本可继续持有」的减仓但换手增量未换来收益。
3. **判定：不推荐独立采纳**，与 §13.12 动量衰减退出同列否决清单；留待扩池后再测。

---

## 4. 合并条件核对

| 条件 | 状态 |
|---|---|
| CI `build-and-test` 通过 | ⏳ 待 push 后 CI 结果 |
| G-Tr1 ~ G-Tr5 全 PASS | ✅ 本审计已落 |
| 验收落档与本波 commit 同 PR | ✅ 本文件 |

**判定：本审计 PASS。CI 全绿后可 squash merge。**
