# Wave 8 验收 —— 收尾（T77 / T78 / T86b / T89b）

> **判定人**：T78 实施 agent
> **日期**：2026-10-21
> **波次范围**：**T89b**（删 `success` 字段）+ **T86b**（恢复覆盖率门槛 + CI Gate）+ **T77**（smoke-m5 + 前端 E2E）+ **T78**（本审计）
> **上游**：[`wave-7-audit.md`](./wave-7-audit.md)（G7 判定 PASS 7/7）
> **Wave 8 commit 区间**：`863e850..3c8b33e` —— **3 条 commit**
> **判定规则**：`code_implementation_plan_v2.md` §12.7（G8）+ §12.6（全局判定）
> **判定形态**：**只有 PASS / FAIL，无 COND**（§12.7 总则：「COND 会让硬阻断形同虚设」）
> 🔴 **收口补记（2026-10-21，Wave 8 文档收口）**：
> ① **§12.6 的全局判定由 ❌ FAIL 改判 ⚠️ COND**（依据：SE1 实测 301 + CO1 口径 ADR-009 + B5 由 ADR-010/011 关闭 + 其余非 PASS 项全部具名登记为偏差 D-1 ~ D-9）—— **G8 的判定（PASS）不变**；
> ② 本文档 §0.2 的「两项残留」中，**SE1 已关闭**（Caddy v2.11.7 实测 301），**仅剩 PE4 并发档**（已登记为 §9.3 **D-4** / §13.2 **I-28**）；
> ③ **T60 交付方的实测数据已并入** [`fullstack-audit-v2.md`](./fullstack-audit-v2.md) §9.5（初版未落档）。

---

## 0. 判定结论

| 门槛 | 判定 | 实测依据（原始数据见 §1 / §2 / §3） |
|---|---|---|
| **G8.1** | T77 smoke-m5 全绿 | ✅ **PASS** —— `npm test` 中 `tests/smoke-m5.test.ts` **56 个用例全过、0 skip**（默认档 = 真库 full） |
| **G8.2** | T86b 覆盖率达标（或按 §12.7 豁免规则登记） | ✅ **PASS** —— 本审计**独立复跑** `MARKET_DATA_MODE=mini npm run test:coverage`（EXIT=0）+ **逐字复刻 CI `coverage-gate` 脚本**（GATE_EXIT=0）：四模块行/分支全部过线，**无需豁免** |
| **G8.3** | G1-G7 全部 PASS 且各有落档文件 **+ T60 的 3 个未完成验收项** | ✅ **PASS（附 1 项必须跟进的残留）** —— G1-G7 **7/7 PASS**；T60 三项余项**全部有实测结果**：① `tests/http/` 目录**已建，7 文件 / 29 用例全绿**（交付方口径：9 文件 / 2056 行）；② **PE4 单请求 p99 达标**（交付方 77.7ms / 审计方 125.7ms，均 ≤ 200ms；**并发档 `-c 100` p99 ≈3.0s 未达标，已登记为偏差 D-4 / I-28，不降门槛**）；③ **N+1 已消除**（5 只与 30 只持仓的查询次数**完全相同**） |

### 0.1 G8 判定

```
✅ G8 = PASS（G8.1 / G8.2 / G8.3 三项全过，0 COND）
```

> **⇒ 按 §12.8 流程：Wave 8 的 commit 可进入合入流程（PR 内必须同时含 gate 文档）。**
> ⚠️ **§12.6 的全局判定（T78）在初版审计时判 FAIL，经 Wave 8 文档收口后改判 ⚠️ COND** —— G8 只覆盖「Wave 出口」，A 组 / D 组 / E 组的缺口在 T78 全局判定里。完整判定见 [`fullstack-audit-v2.md`](./fullstack-audit-v2.md)。

### 0.2 G8.3 PASS 的**必须跟进的残留**（不改变 G8.3 判定）

| # | 残留 | 说明 |
|---|---|---|
| 1 | **`tests/http/` 套件在审计结束时**尚未 commit** | 本审计的 G8.3 结论建立在**未提交**的工作树改动上（`git status`：`?? apps/backend/tests/http/`、`?? apps/backend/vitest.http.config.ts`、4 个 `M` 文件）。§12.8 规则 1 要求「gate 文档的 commit 必须与本波 commit 在**同一个 PR** 内」⇒ **交付方必须把它提交进 Wave 8 的 commit 序列**（见 `fullstack-audit-v2.md` §13 M-3b）<br>⚠️ **收口新增**：`.github/workflows/ci.yml` 新增的 `tests/http/` **可离线子集** CI 步骤**依赖该套件已提交** ⇒ 未提交 ⇒ CI 会因找不到 `vitest.http.config.ts` 而红 |
| 2 | **PE4 的并发档口径未达标**（`-c 100` p99 ≈3.0s） | 不属 G8.3 的三个子项（子项判据只写「30 只持仓 p99 < 200ms」⇒ **单请求口径已达标**），但进 §12.6 的 A 组 ⇒ **已按 §9.3 D-4 / §13.2 I-28 登记为具名偏差**（根因 = 行情层无进程内缓存；加缓存属**设计级改动**，需所有者裁决是否纳入 MVP）<br>✅ **收口关闭**：**SE1 的「HTTP 层真实 301 未实测」已由真起 Caddy v2.11.7 实测关闭**（实测 **301**，见 `fullstack-audit-v2.md` §9.5.2） |

---

## 1. G8.1 —— T77 smoke-m5 全绿（✅ PASS）

### 1.1 实测原始输出

```
$ npm test
...
 ✓ tests/smoke-m5.test.ts (56 tests) 17294ms

 Test Files  61 passed (61)
      Tests  911 passed | 1 skipped (912)
   Duration  357.12s (transform 2.18s, setup 637ms, collect 5.41s, tests 349.85s, environment 0ms, prepare 124ms)

EXIT=0
```

| 项 | 实测 |
|---|---|
| smoke-m5 用例数 | **56** |
| smoke-m5 失败 | **0** |
| smoke-m5 跳过 | **0**（默认档 = 真库 full ⇒ 规模型守卫 `marketDataSupports('scale')` 为 true ⇒ **不 skip**） |
| 全量后端 | 61 文件 / 911 passed + 1 skipped = **912** |
| 全量 core | 11 文件 / **92 passed** |
| 全量前端 | 43 文件 / **632 passed + 1 todo = 633** |
| **全量合计** | **1637**（基线 219 ⇒ **+1418 / +647%**） |
| 退出码 | **EXIT=0** |

### 1.2 smoke-m5 覆盖的 7 段流程（SDD §12.5 的 F1-F11 串成一条端到端链）

| 步 | 内容 | 用例数 |
|---|---|---|
| 第 1 步 | 注册 / 登录 / 鉴权 | 12 |
| 第 2 步 | 交易 7 类型 + 同日分笔并存 + 持仓 | 20 |
| 第 3 步 | 持仓聚合 + 双口径 | 6 |
| 第 4 步 | K 线四 fq | 8 |
| 第 5 步 | signals symbol 过滤 | 4 |
| 第 6 步 | 选股公共过滤 | 5 |
| 第 7 步 | 复盘 4 色 / 插件参数 / 备份恢复 / 角色管理 | 1 |

> ⚠️ **mini 档（CI 口径）下 smoke-m5 是 56 tests | 1 skipped** —— 跳过的是**规模型**用例（迷你库只有 250 只标的，撑不起「5000 候选」）。**这是设计内的能力分级，不是失败**（`tests/_marketData.ts` 的 `scale` / `performance` 两层开关）。

### 1.3 T77 的另一项交付：前端 E2E

`apps/frontend/tests/e2e/run-e2e.ts`（**759 行**，T77 commit 交付）—— **脚本骨架**，按 SDD §12.1「Playwright MVP 可选 / Phase 4 启用」与 §13.3 **S-9（已登记偏差：Playwright 保持登记，不引入）**，**未纳入 vitest 套件**（vitest `include: ['tests/**/*.test.{ts,tsx}']` 不匹配 `.ts` 脚本名）⇒ **不计入 G8.1 的「全绿」口径**。

---

## 2. G8.2 —— T86b 覆盖率达标（✅ PASS，**无需 §12.7 豁免**）

### 2.1 口径

| 项 | 取值 | 理由 |
|---|---|---|
| 命令 | `MARKET_DATA_MODE=mini npm run test:coverage` | **= CI `coverage-gate` job 的同一脚本**（`ci.yml:63`），且 CI 无 `.env.local` ⇒ `auto` 档也落到 mini ⇒ **本地与 CI 同档可比**（ADR-008） |
| 测量环境 | **独立 git worktree**（`/tmp/opencode/t78/wt`，基线 `3c8b33e`，symlink 根 `node_modules`） | 共享工作树里**另一个 agent 正在并行改 `apps/backend/src/` 与 `apps/backend/tests/http/`** ⇒ 直接在共享树跑会被污染 |
| 判定脚本 | **逐字复制 `.github/workflows/ci.yml` 的 `coverage-gate` 内联脚本**（`ci.yml:67-184`），只把 `ROOT` 指向 worktree | 保证「本地数字 = CI 数字」，不引入第二套口径 |

### 2.2 实测原始输出

```
$ MARKET_DATA_MODE=mini npm run test:coverage      # 干净 worktree
 Test Files  61 passed (61)
      Tests  905 passed | 7 skipped (912)
 Test Files  11 passed (11)
      Tests  92 passed (92)
 Test Files  43 passed (43)
      Tests  632 passed | 1 todo (633)
EXIT=0

$ node <CI coverage-gate 脚本副本> /tmp/opencode/t78/wt
PASS  核心算法层（packages/core/src）
      行覆盖   246/248 = 99.19%（门槛 >=90%）
      分支覆盖 59/64 = 92.19%（门槛 >=85%）
PASS  插件引擎（pluginEngine.ts + packages/core/src/indicators）
      行覆盖   1074/1083 = 99.17%（门槛 >=90%）
      分支覆盖 329/343 = 95.92%（门槛 >=85%）
PASS  数据校验引擎 C1-C12（validator.ts）
      行覆盖   640/666 = 96.10%（门槛 >=85%）
      分支覆盖 176/198 = 88.89%（门槛 >=80%）
PASS  前端（apps/frontend/src）
      行覆盖   10304/10904 = 94.50%（门槛 >=70%）
      分支覆盖 2251/2744 = 82.03%（门槛 >=65%）

覆盖率 Gate 通过（SDD §12.2 / §12.6）
GATE_EXIT=0
```

### 2.3 四模块汇总（行 + 分支双维度）

| 模块 | 行覆盖（实测 / 门槛） | 分支覆盖（实测 / 门槛） | 判定 |
|---|---|---|---|
| 核心算法层 `packages/core/src` | **246/248 = 99.19%** / ≥90% | **59/64 = 92.19%** / ≥85% | ✅ |
| 插件引擎 `pluginEngine.ts` + `core/src/indicators/` | **1074/1083 = 99.17%** / ≥90% | **329/343 = 95.92%** / ≥85% | ✅ |
| C1-C12 校验 `validator.ts` | **640/666 = 96.10%** / ≥85% | **176/198 = 88.89%** / ≥80% | ✅ |
| 前端 `apps/frontend/src` | **10304/10904 = 94.50%** / ≥70% | **2251/2744 = 82.03%** / ≥65% | ✅ |

**⇒ 余量最小的一项也有 +12.03pp（前端行）/ +17.03pp（前端分支），远大于 SDD §12.2 记录的 ±0.1~0.3pp 顺序抖动 ⇒ Gate 不会飘红。**
**⇒ 不触发 §12.6「E3 不达标 ⇒ FAIL」。**
**⇒ 不需要 §12.7 豁免登记。**

> ⚠️ 与 T86b 落档数字的差异（顺序抖动，同 SDD §12.2 已记录的区间）：前端 **93.93%/81.93% → 94.50%/82.03%**（略升）、C1-C12 分支 **88.94% → 88.89%**（略降）、插件引擎分支 **95.91% → 95.92%**。

### 2.4 CI 侧 Gate 的落地状态（**证据缺口，如实登记**）

| 项 | 状态 |
|---|---|
| `coverage-gate` job 已在 `.github/workflows/ci.yml` | ✅ 存在（`ci.yml:39`，`exit 1` 真阻断 + `Reverse check` 反向验证步骤 `ci.yml:187`） |
| 本地复刻脚本实测 | ✅ **GATE_EXIT=0** |
| **在 CI 上真跑过** | ❌ **没有** —— `git branch -r --contains 3c8b33e` → **空**；Wave 8 三个 commit **未推送 origin** ⇒ `coverage-gate` job **从未在 CI 执行过**（E4 的同源证据缺口，见 `fullstack-audit-v2.md` §6 E4 / §13 M-7） |

---

## 3. G8.3 —— G1-G7 全 PASS + T60 三项余项（✅ PASS）

### 3.1 G1-G7 落档核查（**7/7 PASS ⇒ 本子项通过**）

| 波 | 落档文件 | 判定 | 门槛条数 | 逐条有实测原始数据 | 子项 |
|---|---|---|---|---|---|
| Wave 1 | `docs/audit/wave-1-audit.md`（183 行） | ✅ PASS | 9/9 | ✅ | ✅ |
| Wave 2 | `docs/audit/wave-2-audit.md`（330 行） | ✅ PASS | 6/6 | ✅ | ✅ |
| Wave 3 | `docs/audit/wave-3-audit.md`（244 行） | ✅ PASS | 5/6（+G3.5b 归属前移至 G7.7，已在 G7 判 PASS） | ✅ | ✅ |
| Wave 4 | `docs/audit/wave-4-audit.md`（280 行） | ✅ PASS | 6/6 | ✅ | ✅ |
| Wave 5 | `docs/audit/wave-5-audit.md`（265 行） | ✅ PASS | 6/6 | ✅ | ✅ |
| Wave 6 | `docs/audit/wave-6-audit.md`（220 行） | ✅ PASS | 6/6 | ✅ | ✅ |
| Wave 7 | `docs/audit/wave-7-audit.md`（253 行） | ✅ PASS | 7/7 | ✅ | ✅ |

**⇒ G1-G7 子项 = PASS。**（两点如实登记：① 落档文件名实际是 `wave-N-audit.md` 而非 §12.7 写的 `wave-N-gate.md`；② G1.9 的字面标准「每个指定用例名可 grep」有 3 个名字仍 grep 不到 —— 见 `fullstack-audit-v2.md` §10。）

### 3.2 T60 的 3 个未完成验收项（**归属 G8.3 ⇒ 本子项 PASS**）

> 权威来源：§12.7「未完成验收项 → 归属门槛（机制修正，2026-10-20）」表 —— 三项**全部归属 G8.3 / Wave 8**。
> ⚠️ **交付形态**：三项由**并行 agent** 在审计期间交付，**审计结束时仍为未提交的工作树改动**（`git status`：`?? apps/backend/tests/http/`、`?? apps/backend/vitest.http.config.ts`、`M apps/backend/{package.json,vitest.config.ts}`、`M apps/backend/src/services/{marketData,positionCalculator}.ts`）。
> **本审计在共享工作树上亲跑了该套件**（见 §3.3），**跑了 2 轮**（21:58 / 22:19），**两轮均 7 文件 / 29 用例全过、EXIT=0**。

| # | T60 未完成验收项 | 判据 | 本审计实测 | 判定 |
|---|---|---|---|---|
| **①** | 建 `tests/http/` 目录，放 **CORS / HTTPS / PE1-PE5**（**必须真 listen**） | CORS：`Origin=http://evil.com` 必拒 / `http://127.0.0.1:5173` 必放行；**须断言该测试文件确实调了 `listen()`**（放进 `integration/` 用 `inject()` 测则恒绿 = 没测） | 目录**已建**（9 个文件：`cors.test.ts` / `https-se1.test.ts` / `pe1-pe3-browser.test.ts` / `pe2-scan.test.ts` / `pe4-holding-p99.test.ts` / `pe5-sqlite-concurrency.test.ts` / `holding-nplus1.test.ts` + `_helpers.ts` + `_browser.ts`）+ 独立配置 `vitest.http.config.ts`（`include: ['tests/http/**/*.test.ts']` / `singleFork` / 不 shuffle）+ `npm run test:http` 脚本 + 主套件 `exclude: ['tests/http/**']`。<br>实测：**7 文件 / 29 用例全过，EXIT=0**；CORS 9 例全过（含「确实 listen」守卫与「测试白名单 == 生产 `server.ts` 白名单」的口径守卫） | ✅ **PASS** |
| **②** | **PE4**：30 只持仓 `/api/holding` p99 < 200ms | 依赖 T60c（真库视图物化反模式）+ T60b（30 只持仓的可复现数据）；**必须在 full 档真库上测** | **full 档真库实测，跑了 2 轮**：<br>**单请求口径**（并发 1，3 轮 × 100 次）：第 1 轮 **p99 = 125.7ms**（n=300，mean=69.3ms p50=65.8ms p95=113.3ms max=160.2ms）；第 2 轮 **p99 = 99.6ms**（n=300，mean=63.9ms p50=61.4ms p95=88.9ms max=112.5ms）⇒ **两轮均 ≤ 200ms ✅**<br>**交付方实测**（另一次运行）：`p50=51.8 p90=66.8 p95=71.6 **p99=77.7** max=85.9ms`（三轮 p99 = 76.1 / 83.0 / 71.8ms）；**改前对照 3904 / 3487 / 3676 / 3493 / 3500ms** ⇒ 修复后**降一个数量级**<br>口径等价性：`视图 60 行 / 基表 60 行 / 仅视图有 0 / 仅基表有 0`（`EXCEPT ALL` 双向差集 = 0）<br>⚠️ **并发档**（SDD §12.5 载体 `autocannon -c 100`）：审计方第 1 轮 **p99 = 3522.9ms** / 第 2 轮 **p99 = 3358.1ms**；交付方 `-c 10` → **456.6ms** / `-c 100` → **3040.0ms** ❌ **均未达标** —— 交付方明确「**不降门槛凑绿**」并登记为待办（根因：行情层在本进程内几乎串行，吞吐上限约 30 req/s ⇒ 需进程内缓存，属设计级改动） | ✅ **PASS**（§12.7 判据文字「30 只持仓 p99 < 200ms」已满足；并发档差异 ⇒ **已登记 §9.3 D-4 / §13.2 I-28**，见 `fullstack-audit-v2.md` §2.2 PE4 / §11 U-3） |
| **③** | **N+1 消除**：`calcAllPositions` 的查询次数不随标的数线性增长（spy 计数） | 30 只持仓的持仓查询**查询次数不随标的数线性增长** | **实测 2 轮结论一致**：`5 只持仓：返回 5 条 / SQLite 2 次 / DuckDB 2 次` **vs** `30 只持仓：返回 30 条 / SQLite 2 次 / DuckDB 2 次` ⇒ **查询次数完全相同**（旧实现 `codes.map(calcPosition)` 会有 **31 次** SQLite 查询）；`calcAllPositions(94002) → 30 个持仓 / SQL 1 条`；交付方实测亦为 **2 / 2 次**（改前 **7 / 32 次**） | ✅ **PASS** |

### 3.3 G8.3 判定

```
✅ G8.3 = PASS
```

**理由**：G1-G7 子项 **7/7 PASS**；§12.7 明确归属 G8.3 的 **T60 三项余项全部有可判的通过结果**（① 目录已建且 29/29 全绿；② PE4 单请求 p99 达标；③ N+1 已消除）。
**⇒ 一项残留必须跟进（不改变 G8.3 判定）**：
① **`tests/http/` 套件在审计结束时未 commit** —— §12.8 规则 1 要求 gate 文档与本波 commit 同 PR ⇒ 交付方须把它提交进 Wave 8 的 commit 序列（`fullstack-audit-v2.md` §13 M-3b）；
② **PE4 并发档口径未达标** ⇒ **已按 §9.3 D-4 / §13.2 I-28 登记为具名偏差**（根因 = 行情层无进程内缓存 ⇒ 属设计级改动，需所有者裁决）。
✅ **收口关闭**：**SE1 的「HTTP 层真实 301 未实测」已由真起 Caddy v2.11.7 实测关闭**（实测 **301**）⇒ §12.6 的全局判定**改判 ⚠️ COND**（详见 `fullstack-audit-v2.md` §0.2 / §16）。

---

### 3.4 补充实测 —— PE2 / F7 复测（6 轮，**与 G6.4 的落档一致，但余量很薄**）

> PE2 不属 G8 的门槛，但 T78 审计必须给出**性能实测原始数据**（§12.6 明文），故在此一并落档。

**命令**（独立 worktree，真库档，独占进程）：`MARKET_DATA_MODE=full DUCKDB_PATH=/opt/invol/quotes.duckdb npm run test:pe2 -w @invest/backend`

| 轮次 | 机器状态 | 客户端耗时 | 服务端耗时 | 门槛 3000ms | 退出码 |
|---|---|---|---|---|---|
| 1 | ❌ 并发（另一 agent 的 vitest 占 CPU 93.8%，load 3.94） | **3172ms** | 3148ms | ❌ 超 172ms | 1 |
| 2 | ⚠️ load 3.59（并发余波） | **3031ms** | 2998ms | ❌ 超 31ms | 1 |
| 3 | ✅ 较安静 | **2732ms** | 2709ms | ✅ 通过 | 0 |
| 4 | ✅ 较安静 | **2709ms** | 2690ms | ✅ 通过 | 0 |
| 5 | ❌ 并发 agent 的 vitest 持 DuckDB 锁 | — | — | ⚠️ **SKIP（假绿）** | 0 |
| 6 | ❌ 同上 | — | — | ⚠️ **SKIP（假绿）** | 0 |

**⇒ 结论**：无并发时 **2732ms / 2709ms ≤ 3000ms**（与 Wave 6 落档 2741ms / 2725ms **一致**）⇒ **G6.4 的 PASS 判定成立、可复现**。
**⇒ 但两条必须记录的残留**：① **余量只有 ~10%**，并发下即超门槛 ⇒ **已登记 §9.3 D-5 / §13.2 I-29**；② **DuckDB 文件被锁时规模/性能用例会「静默 skip」且退出码 = 0**（详见 `fullstack-audit-v2.md` §12 发现 F-8）—— 这是**新的门禁假绿风险**，CI 侧应把「规模/性能用例被跳过」判为红 ⇒ **已登记 §9.3 D-8 / §13.2 I-32**（本 Wave 不改代码，留待 Wave 9 或后续任务）。

---

## 4. 本波 commit 区间

```
$ git log --oneline 863e850..3c8b33e
3c8b33e fix(T77): 修 T89b 挖出的 4 个真缺陷 —— 插件 toggle 必 404 / 非法 enabled 吐非 envelope / USER_EXISTS 语义 / 死代码
0376021 feat(T86b): 恢复 SDD §12.2 覆盖率门槛 + CI 90% 阻断 Gate（B-5 关闭）
65707c8 feat(T89b): 删除响应体 `success` 字段 + 前端切 `code === 0`（B-9 收尾）
```

| commit | 任务 | 变更规模 | 本波 gate 关联 |
|---|---|---|---|
| `65707c8` | **T89b** | 删 `success` 字段 + 前端 20 处切 `code === 0` | G8.1（smoke-m5 覆盖 envelope） |
| `0376021` | **T86b** | 恢复 SDD §12.2 门槛 + `ci.yml` 新增 `coverage-gate` job（+243 行） | **G8.2** |
| `3c8b33e` | **T77** | smoke-m5.test.ts（1349 行）+ 前端 E2E 骨架（759 行）+ 修 4 个真缺陷 | **G8.1** |
| （未提交） | **T78** | 本波落档 + `fullstack-audit-v2.md` | G8.3 汇总 |
**区间合计**：**3 条 commit，73 文件，+4778 / −284**（不含 T78 的文档产出）。

> ⚠️ **原子性检查**（§12.8 规则 3：「每个 T 任务一条 commit」不可合并）：3 条 commit 分别对应 T89b / T86b / T77 三个任务，**粒度保持** ⇒ 一波内可整体 `git revert 863e850..3c8b33e` 而不留半拉子改动。
> ⚠️ **推送状态**：3 条 commit **未推送 origin**（`git branch -r --contains 3c8b33e` → 空）⇒ **CI 从未跑过本波代码**。

---

## 5. 豁免登记

| 门槛 | 是否豁免 | 理由 |
|---|---|---|
| G8.1 | **不豁免**（实测 PASS） | — |
| G8.2 | **不豁免**（实测 PASS，四模块全过线） | §12.7 总则允许豁免，但**没有必要** —— 数字全部达标 ⇒ 不登记豁免 |
| G8.3 | **不豁免（判 PASS）** | 三项余项客观可达成且**已达成**（① 目录已建且 29/29 全绿；② PE4 单请求 p99 达标；③ N+1 已消除）⇒ **无需豁免** |

---

## 6. 关联文档

| 文档 | 内容 |
|---|---|
| [`fullstack-audit-v2.md`](./fullstack-audit-v2.md) | **T78 最终审计**：A 组 24 项 / B / C / C' / D / E 组逐条 + §12.6 判定（**⚠️ COND**）+ §9.3 偏差登记（D-1 ~ D-9）+ 移交清单 |
| [`wave-1-audit.md`](./wave-1-audit.md) … [`wave-7-audit.md`](./wave-7-audit.md) | G1-G7 落档 |
| [`../client/code_implementation_plan_v2.md`](../client/code_implementation_plan_v2.md) | §9.2 决策台账 / §9.3 偏差登记 / §12.7 G8 门槛 / §12.8 Wave Gate 流程 / §13.2 偏差条目 |
| [`../adr/ADR-009-co1-permission-target.md`](../adr/ADR-009-co1-permission-target.md) | CO1 权限目标口径（`nobody` 作废 ⇒ 专用服务账号） |
| [`../adr/ADR-010-dec7-frontend-core-adapter-copy.md`](../adr/ADR-010-dec7-frontend-core-adapter-copy.md) | DEC-6 / DEC-7 收口（前端复制适配层 ⇒ AGENTS.md 不修订） |
| [`../adr/ADR-011-dec8-macd-warmup-drift.md`](../adr/ADR-011-dec8-macd-warmup-drift.md) | DEC-8 收口（接受 MACD warm-up 漂移） |
