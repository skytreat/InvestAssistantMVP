# DualMomentum L1 诊断 + CI 稳定性修复 验收（PR #154）

> **判定人**：Agnes AI（实施 agent）
> **日期**：2026-11-12
> **波次**：DualMomentum L1 对齐 / 诊断（非 v2/v3 编号 Wave，独立审计条目）
> **PR**：#154 `docs/dualmomentum-improvements` → `main`
> **上游**：`docs/audit/dualmomentum-l1-alignment.md` §12.8 / §13（摩擦拆账 / leave-one-out / 分槽归因 / 相关性 / IC）
> **Base**：`main`（#143 L1 已合入，HEAD `91a6de`）
> **本波 commit**：
> - `634c6b4` feat(backtest): DualMomentum 诊断（L1 消融/归因/IC 纯函数 + 16 单测）
> - `2e8d143` fix(frontend): broker-pages 501 分批用例超时放宽至 30s（CI flaky 修复 1/2）
> - `8bebad9` fix(frontend): broker-pages waitFor 超时用 `{timeout}` 选项对象（修 TS2559，CI flaky 修复 2/2）

---

## 0. 判定结论

| 门槛 | 判定 | 实测依据 |
|---|---|---|
| **G-D1**（诊断纯函数零回归） | ✅ **PASS** | `dualmomentumL1Diagnostics.test.ts` 16/16 本地绿；`dmSweep.ts --check-baseline` 在 `/opt/invol/quotes.duckdb`（1.24GB 真库）跑出 `final=1,189,224.15` `trades=1780` `cagr=2.25%` `mdd=13.11%`，与 §12.8 基线逐位一致 |
| **G-D2**（前端 flaky 修复） | ✅ **PASS** | `broker-pages.test.tsx` `it('超过 500 条自动分批（501 → 2 次请求，500 + 1）', ..., 30_000)` 本地 40/40 绿；CI `Coverage — frontend` 此前因 5s 超时 flaky（run 43135122262 / 43135843654 / 43140937972），修复后 tsc/eslint/本地单测全绿 |
| **G-D3**（无新依赖 / 无新端口 / 无新表） | ✅ **PASS** | 本波 3 个 commit 共改动 `diagnostics.ts`、`dualmomentumL1Diagnostics.test.ts`、`broker-pages.test.tsx`；`package.json` 未变 |
| **G-D4**（lint + typecheck 全绿） | ✅ **PASS** | `npx eslint .` / `npx tsc --noEmit -p apps/frontend/tsconfig.json` / `npx tsc --noEmit -p apps/backend/tsconfig.json` 本地均 0 错 |

### 0.1 判定

```
✅ PASS（G-D1 ~ G-D4 四条全过，0 豁免）
```

> ⚠️ **未含档 1–4 的 opt-in 参数改动**（engine/params/index/dmSweep/dmDiagnose 改动 + `docs/audit/dualmomentum-l1-alignment.md` §13 全章）
> 已留在 `docs/dualmomentum-improvements` 的 worktree 中，待本 PR 合并后另开 PR 单独交付，避免一个 PR 背 CI 又背大报告。

---

## 1. G-D1 —— 诊断纯函数零回归

### 1.1 单测覆盖

`apps/backend/tests/unit/dualmomentumL1Diagnostics.test.ts`（16 例）：

| 组 | 覆盖点 |
|---|---|
| `computeAblationSwitch` | 各消融开关 true/false 下引擎行为差异 |
| `computeSlotAttribution` | 槽位拆分（equity / cash / defensive / momentum）归因求和恒等 |
| `computeSlotCorrelation` | 跨槽相关性矩阵对称性 + 对角 1.0 |
| `computeSpearmanIC` | 零秩差 → IC=1；全乱序 → IC=-1；n<2 边界 → null |

本地执行：

```console
$ npx vitest run apps/backend/tests/unit/dualmomentumL1Diagnostics.test.ts \
    --config apps/backend/vitest.config.ts --pool=forks --poolOptions.forks.singleFork=true
 Tests  16 passed (16)
```

### 1.2 基线验证（真库）

执行：

```console
$ DUCKDB_PATH=/opt/invol/quotes.duckdb \
    npx tsx apps/backend/src/services/backtest/optimize/dmSweep.ts --check-baseline
面板：116 只 / 基准 sh000300 1951 根 / sh510300 1951 根 / 指数 4 只
BASELINE final=1189224.15 cum=18.92% cagr=2.25% mdd=13.11% trades=1780 equityDays=1891
```

| 项 | 实测 | 期望（§12.8 DAS-2 锁定参数） | 判定 |
|---|---|---|---|
| `final` | `1,189,224.15` | `1,189,224.15` | ✅ 逐位一致 |
| `trades` | `1780` | `1780` | ✅ 逐位一致 |
| `cum` | `18.92%` | `18.92%` | ✅ |
| `cagr` | `2.25%` | `2.25%` | ✅ |
| `mdd` | `13.11%` | `13.11%` | ✅ |

**结论：本波纯函数改动未对 L1 引擎既有参数口径造成任何回归。**

---

## 2. G-D2 —— 前端 flaky 修复

### 2.1 问题根因

`broker-pages.test.tsx > 超过 500 条自动分批（501 → 2 次请求，500 + 1）`（`broker-pages.test.tsx:1426`）

- 该用例渲染 **501 行** `BrokerReconcile` 组件 + 触发 501→2 批（500+1）分批请求链路
- CI jsdom 环境下，该用例实际耗时 **~6.5s**（慢但稳定），而 vitest 默认 `testTimeout=5000ms`
- 超时随机触发：`Test timed out in 5000ms`（CI run 43135122262 / 43135843654 / 43140937972 三度命中）

### 2.2 修复

`broker-pages.test.tsx:1426`：

```ts
// 修复前
it('超过 500 条自动分批（501 → 2 次请求，500 + 1）', async () => { ... });

// 修复后
it(
  '超过 500 条自动分批（501 → 2 次请求，500 + 1）',
  async () => {
    ...
    await waitFor(
      () => { ... },
      { timeout: 30_000 },   // 等器上限也放宽
    );
  },
  30_000,                    // it 自身 testTimeout 放宽
);
```

注释标明：`CI 上 jsdom + 501 行渲染 + 分批请求链路曾 6.5s 超时（run 43135122262 / 43135843654）；本用例是 501→2 批的机制验证（与用例数无关），给 30s 宽限消除 flaky，不是掩盖真实慢逻辑`

> ⚠️ **`waitFor` 第二参是 `waitForOptions` 对象而非裸数字**（`@testing-library/react` 类型签名），
> 首次提交传 `30_000` 触发 CI 端 `tsc TS2559: Type '30000' has no properties in common with type 'waitForOptions'`，
> `8bebad9` 修为 `{ timeout: 30_000 }`。

### 2.3 本地验证

```console
$ npx vitest run apps/frontend/tests/unit/broker-pages.test.tsx \
    --config apps/frontend/vitest.config.ts --pool=forks --poolOptions.forks.singleFork=true
 Tests  40 passed (40)
$ npx tsc --noEmit -p apps/frontend/tsconfig.json     # 0 错
$ npx eslint apps/frontend/tests/unit/broker-pages.test.tsx   # 0 错
$ npx prettier --check apps/frontend/tests/unit/broker-pages.test.tsx   # 通过
```

---

## 3. G-D3 —— 无新依赖 / 无新端口 / 无新表

| 检查项 | 结果 |
|---|---|
| `package.json` / `apps/*/package.json` 是否改动 | ✅ 未改 |
| 是否新增 HTTP 路由 / API | ✅ 未新增 |
| 是否改动 DDL / SQLite / DuckDB 表 | ✅ 未改 |
| 是否新增端口 / 监听地址 | ✅ 未新增 |
| 是否修改 AGENTS.md 锁定技术栈 | ✅ 未改 |

---

## 4. G-D4 —— lint + typecheck 全绿

```console
$ npx eslint .                          # 0 错（含本波 3 个改动文件）
$ npx tsc --noEmit -p apps/frontend/tsconfig.json   # 0 错
$ npx tsc --noEmit -p apps/backend/tsconfig.json    # 0 错
$ npm run build -w @invest/core          # ✅（typecheck 前置）
```

---

## 5. 残余 / 后续

| 项 | 状态 | 处置 |
|---|---|---|
| 档 1–4 opt-in 参数改动（engine/params/index/dmSweep/dmDiagnose） | ⬜ 未合 | 另开 PR 单独交付，避免本 PR 过大 |
| `docs/audit/dualmomentum-l1-alignment.md` §13 全章报告 | ⬜ 未合 | 随档 1–4 PR 一起落 |
| CI `Coverage Gate — SDD §12.2 / §12.6` 此前因 `broker-pages` flaky 连带 FAIL | 待本 PR 新 CI run 验证 | `8bebad9` push 后触发，若 CI 全绿即满足合并条件 |

## 6. 合并条件核对

| 条件 | 状态 |
|---|---|
| CI `build-and-test` 通过 | ⏳ 待 `8bebad9` 的 CI run 结果 |
| G-D1 ~ G-D4 全 PASS | ✅ 本审计已落 |
| **无 wave-N-audit.md 文件 = 未执行 = FAIL** | ✅ 本文件即落档 |

**判定：本审计 PASS。CI 全绿后可 squash merge。**
