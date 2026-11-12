# DualMomentum 黄金腿加权 + volWindow 扫（§13.15 A2/A3）验收（PR #162）

> **判定人**：Agnes AI（实施 agent）
> **日期**：2026-11-12
> **波次**：DualMomentum §13.15 补测（#159 后续 PR）
> **PR**：#162 `feat/dm-gold-boost-volwindow` → `main`
> **上游**：`docs/audit/dualmomentum-l1-alignment.md` §13.13（vol(0.12) 基准）+ owner「基线 Calmar 再高点」要求
> **Base**：`main`（#159 已合入）

---

## 0. 判定结论

| 门槛 | 判定 | 实测依据 |
|---|---|---|
| **G-GV1**（缺省逐位不变） | ✅ **PASS** | `--check-baseline` → `final=1,189,224.15 / trades=1780`，与 #159 基线逐位一致 |
| **G-GV2**（单测零回归） | ✅ **PASS** | `dualmomentumStrategy.test.ts` 12/12 本地绿（新增 1 例：symbolWeights 提权） |
| **G-GV3**（lint + typecheck 全绿） | ✅ **PASS** | eslint 0 错；tsc 0 错 |
| **G-GV4**（无新依赖 / 无新表 / 无新端口 / 不引入新 ETF） | ✅ **PASS** | `package.json` 未改；`POOL_ORDER` 未改（仍 7 只）；仅加 `symbolWeights` opt-in 参数（JSON 字符串，缺省 `'{}'`） |
| **G-GV5**（§13.15 落档 + 结论） | ✅ **PASS** | `dualmomentum-l1-alignment.md` §13.15 已写；**结论：A2 黄金腿加权否决（MDD +1.5~1.7pp 拉低 Calmar）；A3 volWindow=10 微正但不显著（Calmar 持平 0.44），维持 §13.13 vol(0.12) 基准；基线 Calmar 0.44 为当前结构上限** |

### 0.1 判定

```
✅ PASS（G-GV1 ~ G-GV5 五条全过，0 豁免）
```

> ⚠️ **symbolWeights 为 opt-in 研究参数**（缺省 `'{}'` = 候选均分，基线逐位不变），
> 不引入新 ETF、不改 `POOL_ORDER`、不写 `bt_*` 基线记录。
> §13.15 判定 A2 否决、A3 不单独改 ⇒ 本 PR **不改任何默认值**，仅作研究记录。

---

## 1. G-GV1 —— 缺省逐位不变

```console
$ DUCKDB_PATH=/opt/invol/quotes.duckdb \
    node_modules/.bin/tsx apps/backend/src/services/backtest/optimize/dmSweep.ts --check-baseline
BASELINE final=1189224.15 cum=18.92% cagr=2.25% mdd=13.11% trades=1780 equityDays=1891
```

| 项 | 实测 | 期望（#159 基线） | 判定 |
|---|---|---|---|
| `final` | `1,189,224.15` | `1,189,224.15` | ✅ 逐位一致 |
| `trades` | `1780` | `1780` | ✅ 逐位一致 |

**结论：`symbolWeights='{}'` 缺省路径未对 DAS 基线造成任何回归。**

---

## 2. G-GV2 —— 单测

`dualmomentumStrategy.test.ts` 新增 1 例（12/12 全绿）：

| 用例 | 验证点 |
|---|---|
| 按标的权重（§13.15 A2；opt-in） | `symbolWeights='{"sh518880": 3}'` 提权后其 `targetNotional` 高于均分基准；缺省 `'{}'` 时走均分路径 |

---

## 3. G-GV5 —— §13.15 实测（dmDiagnose 真库对照）

跑赢档+vol(0.12)（§13.13 基准 Calmar 0.44）上叠 A2/A3，基准 `sh510300` qfq CAGR 6.02%/年：

| 组合 | CAGR | MDD | Calmar | 超额 | 判定 |
|---|---|---|---|---|---|
| 跑赢档+vol(0.12)（§13.13） | 11.65% | 26.46% | **0.44** | +5.63pp | 基准 |
| A2 黄金腿 2× 权重 | 11.57% | 28.01% | 0.41 | +5.55pp | **MDD +1.55pp，Calmar 降** |
| A2 黄金腿 3× 权重 | 11.81% | 28.14% | 0.42 | +5.79pp | MDD +1.68pp，Calmar 降 |
| A3 volWindow=10 | 11.86% | 27.24% | **0.44** | **+5.84pp** | CAGR +0.21pp / 超额 +0.21pp，Calmar 持平 |
| A3 volWindow=50 | 11.25% | 27.60% | 0.41 | +5.23pp | CAGR −0.40pp，负向 |

**结论**：
1. **A2 黄金腿加权否决**——提权分散收益（相关 0.07–0.19）< 黄金腿自身 2021/2022 回撤代价（MDD +1.5~1.7pp），Calmar 反降。
2. **A3 volWindow=10 微正但不显著**——CAGR +0.21pp、超额 +5.84pp（全组合最高），但 Calmar 与 vol(0.12) 持平（0.44），不足以单独推翻 §13.13 基准；维持 `volWindow=20`。
3. **基线 Calmar 0.44 为当前结构上限**——再往上推需 B1/B2 扩池加债券 ETF（§12.6 档 4，需 ADR），不在本 PR。

---

## 4. 合并条件核对

| 条件 | 状态 |
|---|---|
| CI `build-and-test` 通过 | ⏳ 待 push 后 CI 结果 |
| G-GV1 ~ G-GV5 全 PASS | ✅ 本审计已落 |
| 验收落档与本波 commit 同 PR | ✅ 本文件 |

**判定：本审计 PASS。CI 全绿后可 squash merge。**
