# DualMomentum 跑赢档成为正式基线 验收（PR #164，ADR-019）

> **判定人**：Agnes AI（实施 agent）
> **日期**：2026-11-12
> **波次**：DualMomentum 基线切换（ADR-019 落地）
> **PR**：#164 `feat/dm-win-baseline` → `main`
> **上游**：[ADR-019](../../../docs/adr/ADR-019-dualmomentum-win-baseline.md) + `docs/audit/dualmomentum-l1-alignment.md` §13.10（目标函数二选一 + 纪律底线）
> **Base**：`main`（#163 已合入，HEAD `29cfd93`）

---

## 0. 判定结论

| 门槛 | 判定 | 实测依据 |
|---|---|---|
| **G-BL1**（ADR 已开 + 签字留档） | ✅ **PASS** | `docs/adr/ADR-019-dualmomentum-win-baseline.md`（决策 + 代价 + 7 项备选否决 + 回退方案 + 签字表）；`docs/adr/README.md` 索引已更新 |
| **G-BL2**（新基线锚点已重跑） | ✅ **PASS** | `--check-baseline` → `final=2363029.30 cum=136.30% cagr=11.65% mdd=26.46% trades=4657`，与 §13.13 跑赢档+vol(0.12) 实测**逐位一致** |
| **G-BL3**（缺省参数落地无隐性缺陷） | ✅ **PASS** | 修复 `resolveDualMomentumParams` 的 3 项字面量 fallback（`exposureMode`/`benchmarkGateMode`/`scoreMode`）→ 改为回落 `d.xxx`；否则改 DEFAULTS 不生效（首轮实测 cagr=4.66% 与预期 11.65% 不符，定位后修复） |
| **G-BL4**（单测零回归） | ✅ **PASS** | `dualmomentumStrategy.test.ts` 12/12 + `dualmomentumL1Diagnostics.test.ts` 16/16 = 28/28 本地绿；`schema 覆盖全部默认参数` 用例断言新缺省值 |
| **G-BL5**（lint + typecheck 全绿） | ✅ **PASS** | eslint 0 错；tsc 0 错 |
| **G-BL6**（无 DDL / API / 路由 / 前端变更） | ✅ **PASS** | 本波仅改 `params.ts` + 测试 + 3 份文档；`POOL_ORDER` / `l1/params.ts` 锁定常量未动 |

### 0.1 判定

```
✅ PASS（G-BL1 ~ G-BL6 六条全过，0 豁免）
```

---

## 1. G-BL2 —— 新基线锚点

```console
$ DUCKDB_PATH=/opt/invol/quotes.duckdb \
    node_modules/.bin/tsx apps/backend/src/services/backtest/optimize/dmSweep.ts --check-baseline
面板：116 只 / 基准 sh000300 1951 根 / sh510300 1951 根 / 指数 4 只
BASELINE final=2363029.30 cum=136.30% cagr=11.65% mdd=26.46% trades=4657 equityDays=1891
```

| 项 | DAS 锁定基线（旧锚点） | **跑赢档基线（新锚点）** | §13.13 预期 | 判定 |
|---|---|---|---|---|
| `final` | 1,189,224.15 | **2,363,029.30** | — | ✅ |
| `cum` | 18.92% | **136.30%** | — | ✅ |
| `cagr` | 2.25% | **11.65%** | 11.65% | ✅ 逐位一致 |
| `mdd` | 13.11% | **26.46%** | 26.46% | ✅ 逐位一致 |
| `trades` | 1780 | **4657** | 4657 | ✅ 逐位一致 |

---

## 2. G-BL3 —— 缺省参数落地（含隐性缺陷修复）

### 2.1 发现的问题（首轮实测不符）

首轮改完 `DUALMOMENTUM_DEFAULTS` 后跑 `--check-baseline` 得 `cagr=4.66% / mdd=21.14% / trades=3189`，
**与 §13.13 预期的 `11.65% / 26.46% / 4657` 不符**。

### 2.2 根因

`resolveDualMomentumParams` 的三项参数用了**字面量 fallback**，而非回落到 `DUALMOMENTUM_DEFAULTS`：

```ts
// 修复前 —— 改 DEFAULTS 对这三项完全不生效
exposureMode: src.exposureMode === 'scale' || src.exposureMode === 'vol' ? src.exposureMode : 'fixed',
benchmarkGateMode: src.benchmarkGateMode === 'soft' ? 'soft' : 'hard',
scoreMode: src.scoreMode === 'scored' ? 'scored' : 'and',

// 修复后 —— 回落 d.xxx（DEFAULTS）
exposureMode: src.exposureMode === 'scale' || src.exposureMode === 'vol' ? src.exposureMode : d.exposureMode,
benchmarkGateMode: src.benchmarkGateMode === 'soft' ? 'soft' : d.benchmarkGateMode,
scoreMode: src.scoreMode === 'scored' ? 'scored' : d.scoreMode,
```

> ⚠️ 这个缺陷在 §13.6~§13.13 全部 opt-in 实验中**不可见**（那些实验都显式传了参数），
> 只有「把 opt-in 转成缺省」时才会暴露 —— 若不靠基线数字比对就会被静默带进基线。

### 2.3 修复后

`--check-baseline` 与 §13.13 逐位一致（见 §1），且 4 项仍走缺省语义的参数
（`cashInterestRate` / `targetVol` / `volWindow` / `minHoldDays`）本就走 `num(src, k, d.k)` 路径，不受影响。

---

## 3. G-BL1 —— ADR 内容核对

| ADR 必备项 | 落地位置 |
|---|---|
| 决策 | §2.1（7 项采纳参数 + 明确不采纳项） |
| 理由 | §1（目标函数二选一 + owner 选定） |
| 代价 | §3（MDD 翻倍 / 换手翻倍 / 偏离对齐契约 / 样本期依赖，4 项量化 + 缓解） |
| 备选方案否决 | §4（7 项，逐条给理由） |
| 回退可行性 | §5（`git revert` 单 commit，无 DDL / 无数据迁移） |
| 影响面 | §6（含「DDL / API / 路由 / 前端：无变更」） |
| 签字 | §7（owner + 实施 agent，2026-11-12） |

---

## 4. G-BL4 / G-BL5 —— 测试与静态检查

```console
$ node_modules/.bin/vitest run \
    apps/backend/tests/unit/dualmomentumStrategy.test.ts \
    apps/backend/tests/unit/dualmomentumL1Diagnostics.test.ts \
    --config apps/backend/vitest.config.ts --pool=forks --poolOptions.forks.singleFork=true
 Tests  28 passed (28)

$ node_modules/.bin/eslint apps/backend/src/services/backtest/strategies/dualmomentum/ \
    apps/backend/tests/unit/dualmomentumStrategy.test.ts
 # 0 错

$ node_modules/.bin/tsc --noEmit -p apps/backend/tsconfig.json
 # 0 错
```

---

## 5. 合并条件核对

| 条件 | 状态 |
|---|---|
| CI `build-and-test` 通过 | ⏳ 待 push 后 CI 结果 |
| G-BL1 ~ G-BL6 全 PASS | ✅ 本审计已落 |
| ADR 与本波 commit 同 PR | ✅ `docs/adr/ADR-019-*.md` + README 索引 |
| 验收落档与本波 commit 同 PR | ✅ 本文件 |

**判定：本审计 PASS。CI 全绿后可 squash merge。**
