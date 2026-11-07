# M3 / M4 口径对齐重跑报告（v5.2-t2）

> 日期：2026-11-07
> 代码基线：`main` @ `7294ea5`（PR #113 squash 合并，父提交 `6bcb646`）
> 对照轮次：`m4-full-v1`（旧口径，2026-11-06）↔ `m4-full-v2`（新口径 `v5.2-t2`，本报告）
> 本报告为新文件，未覆盖 `M3-audit-report.md` / `M4-audit-report.md`

## 0. 结论摘要

1. **M3 无回归、无非 expected 变化**：golden 夹具在 #113 中**逐字节未改**，`backtest-m3-wufu` 57/57、`dynamic-panel + attribution` 10/10、真库规模锚点 16/16 全通过。三个选股场景的候选集与防御选择与期望完全一致，`retained` 的目标字段已确认为 `hold`。
2. **M4 方法学结论不变**：训练段最优仍是同一组参数点 `fn-0388`，样本外 31.18%，落后基线 69.73% **38.55pp**；`lookbackDays` 依旧 `unusable`；**默认参数不应修改**。
3. **本轮改动的影响集中在 ④⑤（引擎层现金分配）**：基线样本外 −3.82pp、2025 测试段 −11.25pp、回合数 −63，同时 `insufficient-cash` 下单拒绝 **95 → 0**、满仓天数 **562 → 666**。
4. **② 与 A 在基线路径上没有可观测量**：`suspended` 拒绝 4 → 4、`limit-up` 1 → 1，无变化；A 只带来新的可观测性（3 年 1,449 次「有效点不足」淘汰），未把结果推向任何一侧。

---

## 1. 环境与命令

| 项 | 值 |
|---|---|
| worktree | `D:\workspace\ia-strategy-batch2`（独立 worktree，未触碰主工作区） |
| 分支 | `run/m4-v2-v52`（从 `origin/main` = `7294ea5` 切出） |
| 行情库 | `D:\workspace\InvestAssistantMVP\data\quotes.duckdb`（1185.8MB，只读） |
| 面板 | 1910 只 / 2,224,088 根 bar，装载起点 2022-09-01，warmup=81 |
| 构建 | `npm run build -w @invest/core` |

**M3**

```bash
npx vitest run apps/backend/tests/unit/backtest-m3-wufu.test.ts \
  --config apps/backend/vitest.config.ts --pool=forks --poolOptions.forks.singleFork=true
npx vitest run apps/backend/tests/unit/backtest-m3-dynamic-panel.test.ts \
  apps/backend/tests/unit/backtest-m3-attribution.test.ts \
  --config apps/backend/vitest.config.ts --pool=forks --poolOptions.forks.singleFork=true
npm run test:anchors -w @invest/backend
```

**M4**

```bash
DUCKDB_PATH=D:/workspace/InvestAssistantMVP/data/quotes.duckdb \
npx tsx apps/backend/src/services/backtest/cli.ts sweep \
  --sweep-id m4-full-v2 --seed 20261107 --mode full --coarse 200 --fine 200 \
  --db data/backtest-m4-v2.db \
  --report data/m4-full-v2-v5.2-t2.json \
  --max-heap-mb 5500
```

> 记忆项：首跑在 `coarse 84/200` 触发内置 RSS 看门狗（默认 2500MB，v2 每试次 RSS 增长约 5MB），以 exit 2 提前退出并写出中断快照。**同一 `sweep-id`、同一库**抬高看门狗后重跑，401 次 `bt_run` 全部完成（exit 0）。搜索参数、seed、库、报告路径均未变更。

---

## 2. M3 结果

### 2.1 golden 夹具未被改动

`git diff 6bcb646 7294ea5 -- apps/backend/tests/fixtures/backtest/wufu-golden.json` 为空。
三个 `targetSelection` 场景的 `expectedSymbols / expectedRegime / expectedWeakDays / expectedDefensive / top10 / candidates` 与上一轮完全一致。

### 2.2 选股结果零偏差

| 场景 | 期望 | 实测 |
|---|---|---|
| 2024-03-05 正常期 | `sh512880`，`normal`，weakDays=0 | 一致 |
| 2024-03-06 正常期（持仓 `sh510300` 0.71× 第一名掉出） | `sh512880`，换仓 | 一致 |
| 2024-03-07 走弱期（3/4 指数破 MA10） | `sh511880`，`weak`，defensive=true | 一致 |

### 2.3 `retained` → `hold` 契约

- 已持有标的：`hold: true`，且 **不再输出** `targetWeight`；
- 新买入：`hold: undefined`，`targetWeight ≈ 1`；
- 两者 `buyBudget === 'remaining-cash-equal'`。

### 2.4 ② 与 A 扩窗的专门用例

- 历史零量日剔除后由更早交易日补足，打分与无停牌序列**逐位一致**（score `1.718282`）。
- 扩窗默认关闭：65 根日历 bar 内有效点不足 → 直接淘汰，并记 `lookbackInsufficient=1 / Total=1`。
- 显式 `expandLookback:true` 才向前扩到 130 根；仍不足则淘汰并回退防御。

### 2.5 测试计数

| 套件 | 结果 |
|---|---|
| `backtest-m3-wufu.test.ts` | 57/57 PASS |
| `dynamic-panel` + `attribution` | 10/10 PASS |
| `test:anchors`（真库规模） | 5 文件 / 16 条 PASS（面板 1894 标的、2,038,316 根 bar、`preclose>0` 覆盖率 100%） |

---

## 3. M4 结果与 v1 逐项对照

### 3.1 运行元信息

| 项 | v1 | v2（v5.2-t2） |
|---|---|---|
| sweepId | `m4-full-v1` | `m4-full-v2` |
| seed / coarse / fine | 20261107 / 200 / 200 | 同左（完全一致） |
| 计入汇总试次 | 390（合格 236） | 390（合格 **252**） |
| `bt_run` 次数 | 401 | 401 |
| 用时 | 1100.9s | 761.0s |
| heap 峰值 | 1801MB | 2951MB |
| 提前停止 | 无 | 无（首跑看门狗退出，已同库续跑完成） |

### 3.2 基线（默认参数）

| 指标 | v1 | v2 | Δ |
|---|---|---|---|
| 训练段 CAGR 均值 | 39.94% | 41.10% | +1.16pp |
| **样本外 CAGR 均值** | **73.55%** | **69.73%** | **−3.82pp** |
| fold1 训练 → 测试 | 17.32% → 125.63% | 17.93% → 129.23% | 测试 +3.60pp |
| fold2 训练 → 测试 | 62.55% → 21.48% | 64.27% → **10.23%** | 测试 **−11.25pp** |
| Sharpe（OOS 均值） | 1.81 | 1.66 | −0.15 |
| Calmar | 3.71 | 3.49 | −0.22 |
| 样本外回合数 | 359 | 296 | −63 |
| 区间总收益（2023-01-03 → 2025-12-31） | 224.12% | 200.53% | −23.59pp |

### 3.3 搜索分布与最优

| 指标 | v1 | v2 |
|---|---|---|
| OOS 分布 min / q1 / median / q3 | −26.54 / 7.13 / 19.99 / 34.67 | −27.26 / 7.63 / **23.22** / 37.99 |
| OOS 最大值 | 80.66 | 70.55 |
| **最优 − 中位差** | **60.66pp** | **47.33pp** |
| 训练段最优 | `fn-0388` 33.16% | `fn-0388` **31.18%** |
| └ 该点 2025 测试段 | **−34.33%** | **−40.46%** |
| └ 是否每折跑赢基线 | 否 | 否 |
| OOS 最优（事后选择，仅披露） | `c-0024` 80.66%（训练 16.24%） | `fn-0245` 70.55%（训练 37.37%） |
| 训练段最优 − 基线 | +14.25pp | +13.99pp |
| 其样本外 − 基线 | −40.39pp | −38.55pp |

> 关键点：**训练段最优点与 v1 完全相同**（11 维参数逐项一致），说明口径改动没有改变「哪里最容易过拟合」，只是把该点的样本外表现又压低 1.98pp。

### 3.4 分年度（训练段最优点 vs 基线）

| 年度 | v1 基线 / 最优 / Δ | v2 基线 / 最优 / Δ |
|---|---|---|
| 2023 | 17.32 / 40.68 / +23.36 | 17.93 / 41.26 / +23.32 |
| 2024 | 125.63 / 100.66 / −24.97 | 129.23 / 102.83 / −26.40 |
| 2025 | 21.48 / −34.33 / −55.81 | **10.23** / **−40.46** / −50.69 |

### 3.5 稳定性曲面（以训练段最优 `fn-0388` 为中心）

| 参数 | 中心 | v1 邻居 → 判定 | v2 邻居 → 判定 |
|---|---|---|---|
| `lookbackDays` | 25 | 20=45.11 / 30=−2.49 → **unusable** | 20=46.02 / 30=**−5.78** → **unusable** |
| `lossThreshold` | 0.96 | 0.95=23.98 / 0.97=33.63 → robust | 0.95=**21.79** / 0.97=31.57 → **unusable** |
| `r2Threshold` | 0.4 | 0.3=33.65 / 0.5=34.12 → robust | 0.3=31.71 / 0.5=32.05 → robust |
| `scoreThresholdRatio` | 0.95 | 0.9=42.20 / 1.0=30.59 → robust | 0.9=39.83 / 1.0=28.43 → robust |
| `volumeRatioThreshold` | 1.5 | 1.2=32.97 / 1.8=67.95 → robust | 1.2=32.14 / 1.8=64.76 → robust |
| `holdingsNum` | 1 | 上邻 2=61.50 → insufficient | 上邻 2=65.97 → insufficient |

**与 v1 唯一实质差异**：`lossThreshold` 由 `robust` 变为 `unusable` —— 下邻 0.95 的样本外从 23.98% 降到 21.79%，相对中心 31.18% 跌 **30.13%**，刚越过 30% 的不可用阈值。

### 3.6 `lookbackDays` 在 25 / 30 / 40 的表现

稳定性邻居（±1 档）只覆盖 20 / 25 / 30；`40` 只有粗搜边际数据，两者都列出：

**稳定性曲面**

| lookbackDays | v1 OOS | v2 OOS |
|---|---|---|
| 20 | 45.11% | 46.02% |
| **25（中心）** | **33.16%** | **31.18%** |
| 30 | −2.49% | −5.78% |
| 邻居中位 | 21.31% | 20.12% |
| 判定 | unusable | unusable |

**粗搜 + 精搜边际（同参数其余维度混合）**

| lookbackDays | v1 n / 中位 / 均值 | v2 n / 中位 / 均值 |
|---|---|---|
| 25 | 95 / 30.27 / 30.92 | 98 / **31.35** / **32.66** |
| 30 | 54 / 7.54 / 9.47 | 55 / **9.86** / 7.89 |
| 40 | 39 / 6.14 / 6.94 | 39 / **4.96** / **3.76** |

结论不变：**有效区间只在 20–25，30 起样本外塌陷，40 最差**。

---

## 4. 三项口径改动的贡献

> 说明：本轮**不改代码**，因此无法做严格消融。下面区分「可直接测量」与「结构上无法分离」两类。

### 4.1 ④ 保留仓不再平衡 + ⑤ 防御吃满现金（可直接测量）

| 指标（基线一次回测） | v1 | v2 | 变化 |
|---|---|---|---|
| `insufficient-cash` 下单拒绝 | 95 | **0** | **−95** |
| 样本外回合数 | 359 | 296 | −63 |
| 满仓天数（exposure ≥ 99%） | 562 | 666 | **+104** |
| 平均暴露 | 91.19% | 91.56% | +0.37pp |
| 平均现金占比 | 1.35% | 1.00% | −0.35pp |
| 样本外 CAGR | 73.55% | 69.73% | −3.82pp |
| 2025 测试段 | 21.48% | 10.23% | −11.25pp |

解读：④ 让已持仓不再参与再平衡，⑤ 让防御标的占用全部现金，两者共同表现为**「换手下降、暴露略升、现金垫变薄」**；代价是 2025 段收益显著回落。`insufficient-cash` 归零是 ④「剩余现金均分」的直接证据。

**⑤ 与 ④ 无法在本轮拆分**：两者都作用于资金分配，且没有独立开关。若需分离，需加两个显式参数（`defensiveFullCash`、`rebalanceRetained`）做 4 组对照 —— 属代码改动，本轮未做。

### 4.2 ② 动量/量比剔除零量日（基线路径无可测影响）

| 指标（基线一次回测） | v1 | v2 |
|---|---|---|
| `suspended` 下单拒绝 | 4 | 4 |
| `limit-up` 拒绝 | 1 | 1 |
| golden 场景零量 bar | 0 | 0 |

零量描点在 ETF 日线中极少，且 `asOf` 当日停牌仍由 `ctx.isPaused` 拦截，因此**②在基线与 golden 上都没有产生可观测差异**。它的价值在长尾停牌密集标的，需要在含此类标的的专项用例中验证（已有 4 条单测覆盖）。

### 4.3 A 扩窗改为默认关闭（新增可观测量，无方向性偏移）

- v2 基线在 727 个交易日里累计 **1,449 次「有效点不足」淘汰**（日均约 2 次），最末累计值与逐日增量之和一致。
- v1 没有该标签（扩窗默认开启），这部分点会被扩窗救回，因此**无法直接对比两轮口径**。
- 效果判定：A 是「可解释性」改动 —— 让被淘汰的标的显式计入，而不是静默扩窗；它没有改变训练段最优点，也没有改变 `lookbackDays` 的可用性判定。

---

## 5. 与 v1 结论的差异

| 结论项 | v1 | v2 | 是否改变 |
|---|---|---|---|
| 默认参数是否应修改 | 不应修改 | 不应修改 | 否 |
| 训练段最优样本外是否跑赢基线 | 否（−40.39pp） | 否（−38.55pp） | 否 |
| `lookbackDays` 可用性 | unusable | unusable | 否 |
| `lossThreshold` 可用性 | robust | **unusable** | **是** |
| 最优 − 中位差 | 60.66pp | 47.33pp（选择偏差略降） | 量级变化，方向不变 |
| OOS 最大值是否超过基线 | 是（80.66% vs 73.55%） | **否**（70.55% vs 69.73%，基本持平） | **是（更保守）** |

最后一条值得强调：v1 中「事后挑最优」还能挑出比基线高 7.11pp 的点；v2 中这个空间几乎消失（+0.82pp），说明 ④⑤ 收紧资金分配后，**偶然跑赢的空间被压缩**，搜索结论更干净。

---

## 6. 数据落档（v1 一律未覆盖）

| 产物 | 路径 |
|---|---|
| v2 报告 JSON | `data/m4-full-v2-v5.2-t2.json` |
| v2 结果库 | `data/backtest-m4-v2.db`（`bt_run 401 / bt_trial 390 / bt_skipped 9,307`） |
| v2 运行日志 | `data/m4-full-v2-run.log`（首跑，看门狗中断）、`data/m4-full-v2-run2.log`（完成） |
| v1 报告 JSON（只读对照） | `D:\workspace\ia-strategy-m4\data\m4-full-v1.json` |
| v1 结果库（只读对照） | `D:\workspace\ia-strategy-m4\data\backtest-m4.db` |

`run_id = <sweepId>-<trialId>`，新 sweepId 与独立库文件保证 v1 的 `bt_run` / `bt_trial` 未被读写覆盖；`data/` 全部为 gitignored 产物，不入库。

---

## 7. 复现

```bash
# 环境
git checkout 7294ea5            # main 含 #113
npm run build -w @invest/core
export DUCKDB_PATH=<path>/quotes.duckdb

# M3
npx vitest run apps/backend/tests/unit/backtest-m3-wufu.test.ts --config apps/backend/vitest.config.ts
npm run test:anchors -w @invest/backend

# M4
npx tsx apps/backend/src/services/backtest/cli.ts sweep \
  --sweep-id m4-full-v2 --seed 20261107 --mode full --coarse 200 --fine 200 \
  --db data/backtest-m4-v2.db --report data/m4-full-v2-v5.2-t2.json --max-heap-mb 5500
```
