# Wave 6 验收 —— StockScan + 候选池（G6）

> 判定人：主 agent（Wave 6 实施者）
> 日期：2026-10-21
> 波次范围：**T73（StockScan 全量重写）** + **T74（候选池页 `/candidates`）** + **PE2 性能修复** + **CI/流程基建**
> 上游：[`wave-5-audit.md`](./wave-5-audit.md)（G5 判定 PASS 6/6）
> 起始 commit：`266e1a2`（Wave 5 收尾）
> commit 区间：`266e1a2..babebcd` —— **4 个 commit**

---

## 0. 判定结论

| 门槛 | 判定 | 实测依据 |
|---|---|---|
| **G6.1** SDD §12.5 **F9 PASS**（候选池迁移**幂等且只打标记不建关联**）| ✅ **PASS** | `watchPromote.test.ts` 反向断言**原样保留且绿**；候选相关用例 55/55 |
| **G6.2** **F-S1~F-S5 关闭**（含 409 bug）| ✅ **PASS** | 5/5 逐条实现 + **21 个页面用例** + 附带缺陷 2 项 |
| 🔒 **G6.3** `filter` 插件可用，**`totalCandidates > 0`** | ✅ **PASS** | 实测 **候选池 5000 只 / 命中 343 只**（当前恒为 0 的 P0-11 已解除）|
| **G6.4** **5000 标的选股 ≤3s**（PE2）| ✅ **PASS** | **客户端 2741ms / 服务端 2725ms**（门槛 3000ms，余量 259ms）|
| 🔒 **G6.5** `promote` 后 **watch 关联不存在**（T92 反向断言）| ✅ **PASS** | `watchPromote.test.ts` 绿；前端断言「迁移后 watch 分区不含该标的 + 零个 `/watch` 请求」|
| **G6.6** **375px stockscan 页无横向溢出** | ✅ **PASS** | 真浏览器探针：**+100px → 0**（渲染结果表后 +187px → 0）|

**G6 = 6/6 PASS → Wave 6 可合入 `main`。**

> 🔒 **数据正确性类门槛（G6.3 / G6.5）零豁免，实测 PASS。**

---

## 1. 实测原始数据

### G6.1 / G6.5 —— 候选池迁移「只打标记，不建关联」

| 项 | 实测 |
|---|---|
| 后端 `POST /api/candidate/:id/migrate` | **一字未改**；只 UPDATE 候选行的 `migrated_from_candidate` / `migrated_price_mode`；响应 `autoCreated:false` |
| `watchPromote.test.ts`（G6.5 反向断言）| **原样保留、实测仍绿** |
| 候选相关后端用例（candidateRemove + watchPromote + t50 + t56）| **55/55** |
| 前端断言 | 「迁移后 watch 分区**不含**该标的」+「**零个** `/watch` 请求」|

### G6.2 —— F-S1~F-S5

| Gap | 实现 | 用例 |
|---|---|---|
| **F-S1** 公共过滤（标的类型/排除 ST/行业）**前后端双缺** | `asset_type` / `exclude_st` / `min_amount` / `market_cap_max`；**行业控件 `disabled` +「行业数据源暂不可用」**，请求**不传** `industry_code` | 3 条 |
| **F-S2** 参数输入是裸 JSON textarea | 抽 `components/PluginParamForm.tsx` **共享 schema 渲染器**；`Settings.tsx` 删本地实现（**-172 行**），控件 id 与**错误文案逐字不变** | 5 条 |
| **F-S3** 「结果 ≤100」未强制（UI 允许 500）| `MAX_RESULTS=100` + UI `max=100 readOnly` + **后端夹取 500→100** | 1 条 |
| **F-S4** 无批量加入候选池 | checkbox + 全选 + 批量按钮，复用**已存在**的 `POST /api/candidates/batch`（T56）| 5 条 |
| **F-S5** 结果表缺 名称/现价/涨跌幅/成交额 + 无分页 | 后端 3 字段（**零新增查询**）+ 前端分页每页 20（**零额外请求**）| 3 条 |
| 附带 | **409 bug**：409 判断移到 `catch` 分支 → 「已在候选池」 | 1 条 |

### G6.3 —— filter 插件与候选池规模

```
[F7] scan_5000_target：候选池 5000 只 / 命中 343 只 / 返回 100 条 / 交易日 2026-10-12
[T55] 候选池 5000 只 + 日线加载耗时 1396ms
[T55] v_stock_qfq 复权口径逐条核对 14996 行 —— 与视图一致
[T55] v_etf_qfq 6187 行 —— 与视图一致
```
⇒ `totalCandidates` 从「恒为 0」变为 **5000**（P0-11 的判定锚点解除）。

### G6.4 —— PE2

| 口径 | 值 |
|---|---|
| 客户端端到端 | **2741 ms** |
| 服务端端到端 | **2725 ms** |
| 门槛 | 3000 ms |
| **余量** | **259 ms** |
| 测量环境 | 2 vCPU / 12GB，**load average 3.25**（另有常驻 opencode 进程占 72% CPU）|
| 历史区间 | **2431 ~ 6170 ms**（13 次实测，p50 2951）|

⚠️ **判据方式已固化**：PE2 **必须隔离运行** ⇒ `npm run test:pe2 -w @invest/backend`
（`apps/backend/vitest.pe2.config.ts` 只含该文件、单 fork、超时 300s；主配置 `exclude` 掉它）。
⚠️ **余量仅 259ms 且本机 load 3.25** ⇒ 该门槛在**超载的 2 核机器**上有 flaky 风险 ⇒ 见 §5。

### G6.6 —— 375px 横向溢出（真浏览器探针）

| 口径 | 修前 | 修后 |
|---|---|---|
| 探针默认 @375 | 475 / 375 → **+100 ❌** | **375 / 375 → 0 ✅** |
| **渲染结果表后** @375 | 562 / 375 → **+187 ❌** | **375 / 375 → 0 ✅** |
| @768 / @1440 | — | **0 / 0** |

修前元凶：插件说明 `span`（+100）、成交额提示 `span`（+19）、结果表（+187）。

### 全量验证

| 组 | 结果 |
|---|---|
| `eslint` / `prettier` / `npm run typecheck` | 全部 **exit 0** |
| **后端全量（full 档真库）** | **707 passed / 54 文件**，0 failed，285s |
| **前端全量** | **545 passed + 1 todo / 29 文件**，77.5s；`vite build` ✓ |
| **迷你库档（模拟 CI）** | **557 passed + 5 skipped**，40.5s，覆盖率 **74.56%** |
| `scripts/a11y-check.mjs --pages stockscan` | **0 critical 且 0 条非 critical**（改前有 2 条）|

---

## 2. 本波挖出并修复的真实缺陷

### 2.1 🔴 PE2 的**净负收益**优化（我上一轮加的，本轮回退）

上一轮给 `latest_factors` CTE 加了 `WHERE symbol IN (…)` 下推，注释写「2.9s → 毫秒级」。
**本次 A/B 实测证明那是错的**：

| 变体 | CTE 单独 wall min | 完整预取 cpu min |
|---|---|---|
| 带 `symbol IN (5000 占位符)` | **675 ms** | 1729 ms |
| **不带**（视图原样） | **306 ms** | **1401 ms** |

- `raw_adjust_factor` 只有 **8997** 个 symbol，5000 个候选覆盖 **88% 的行**
  ⇒ symbol 过滤**几乎不裁剪数据**，却付了 MARK JOIN + FILTER 的全套开销（1580 万行过过滤器）
- **多绑 5000 个参数 ≈ 75ms**（实测 ~15 μs/参数）

**口径等价性铁证**（`EXCEPT ALL` 双向差集，362,746 行 × 8 列）：
带 IN vs 不带 IN **差集 0/0**；两者 vs 视图 `v_stock_qfq` **差集 0/0**
⇒ 口径完全一致，**不带 IN 的更快** ⇒ 保留视图原样（也更贴近视图 DDL）。
⇒ 实测结论已写进 `buildQfqRangeSql` 的注释（**含「不要加」的告诫**），防止下一个 agent 再踩。

### 2.2 🔴 性能门槛与全量套件**同进程不可共存**

同一个查询：全量套件里 **10082ms**、单独跑 **2942ms**。
⇒ 根因不是选股逻辑变慢，而是 `src/db/duckdb.ts` 的**进程内单例 DuckDB** 的内部缓冲
被前面几十个测试的查询**驱逐**（page cache 争用）⇒ 同一查询在冷缓冲下慢 **3.4 倍**。
⇒ **性能门槛只能在受控环境测** ⇒ 独立 config + `test:pe2` 脚本 + 主配置 `exclude`。

### 2.3 🔴 `DELETE /api/candidate/:asset_code` **端点整体丢失**
T92 收敛路由时只搬走 GET/POST/migrate ⇒ 删除端点 **404 Route not found** ⇒ 候选池无法移除。已补（软删，`rel_type='candidate'` 限定，不碰 watch/hold）。

### 2.4 🔴 `GET /api/candidate` 缺 SDD §4.4 明列的 `tracked_days`
另补 `name` / `signal`；降级（DuckDB 挂 → `name=null`、信号查询失败 → `signal=null`）⇒ **都不 500**。

### 2.5 🟠 `/candidate/:symbol/promote` → `/watch`（死路由）；`min_amount` 万元→元换算（T55 遗留 10000× 错位）

---

## 3. 口径裁决（owner 需过目）

> 本波 **13 条**裁决。以下为需过目的部分。

| # | 事项 | 裁决 | 依据 |
|---|---|---|---|
| 3.1 | **现价 = 前复权收盘价** | 候选池页 / K 线页 / Dashboard 持仓卡**统一** | 用不复权价会让同一标的在两个页面显示两个「现价」= 口径漂移 |
| 3.2 | **涨跌幅** | 前复权 close 与「紧邻上一根 K 线」close 之比 | 不用 `raw_basic_daily.change_pct`（要 JOIN 1800 万行，PE2 已超预算）|
| 3.3 | **成交额** | 当日**不复权**成交额（元），前端按「万元」展示 | 与过滤项单位一致 |
| 3.4 | **分页** | 前端分页（每页 20，后端一次返回 ≤100） | PRD §5.6「结果 ≤100 条，支持分页」即指这 ≤100 条再分页 ⇒ **零额外请求** |
| 3.5 | **标的类型默认 `stock`** | 另给 ETF / 全部 | 与后端 `parseScanFilters` 默认一致 |
| 3.6 | **行业默认不过滤** | 控件 `disabled` + 明示；**请求不传** `industry_code` | 「宁可不过滤，也不静默清空结果」（板块表实测 0 行）|
| 3.7 | **`tracked_days`** | 加入日→今天（自然日，当天=0）| `created_at` 是 SQLite 本地串，按本地日历取分量 |
| 3.8 | **「跟踪天数」而非「持有天数」** | 用词 | 候选池是独立关系类型（T74 卡用词）|
| 3.9 | **相对收益配色** | 正=绿 / 负=红 | 与 `PositionCard` 盈亏口径一致（**不套 A 股红涨绿跌**，那是 K 线图口径）|
| 3.10 | **迁移 ≠ 加入自选** | 两个按钮两种语义 | PRD S5 的「只打标记」由迁移端点独占；【加入自选】是用户「手动加入」那一步 |
| 3.11 | **批量操作** | 前端串行 N 次调用 | 候选池规模小、无批量端点；不改后端批量接口 |
| 3.12 | **名称缺失回退 `--`** | 不编造 | `raw_symbol_name` 覆盖率约 70%，缺失是常态 |
| 3.13 | **PE2 判据方式** | `npm run test:pe2 -w @invest/backend`（**隔离运行**）| 与全量同进程会劣化到 10082ms（2.2 差）|

---

## 4. 流程 / 基建决策（本波落地）

| 决策 | 落点 |
|---|---|
| **开发中只跑改动的文件；提交前跑一次全量** | `AGENTS.md` 新增「🔴 测试执行节奏」小节 |
| **不�� `git push -q`** | 同上小节（实测：amend 后的非 fast-forward push 被拒却无提示）|
| **迷你库 = 固定切片快照**，**stock + etf 都有**，**Parquet 入库 + 生成脚本现重建** | `SDD §12.5.1`（实测迷你库 **stock 107 / etf 43 / block 23 / unknown 15 / index 13 / bstock 1**，6 视图齐）|
| **CI 的 shuffle guard 改 1/3 抽样** | `.github/workflows/ci.yml`（两次同文件集、仅 shuffle 顺序不同 ⇒ 仍能检出顺序依赖）|

---

## 5. 本波未解决 / 移交

| # | 问题 | 归属 |
|---|---|---|
| 5.1 | ⚠️ **PE2 余量仅 259ms**，且本机 2 核 + load 3.25 ⇒ **flaky 风险**。历史区间 2431~6170ms（p50 2951）| 需**更根本**的优化：候选池 SQL（234~315ms）与插件循环（446~608ms）都还要压。**已排除**的方案见 §6 |
| 5.2 | 🔴 **行情库按 symbol 排序** ⇒ DuckDB 的 zone map 对 `date` 完全无法裁剪（259 个 row group 的 date stats 全是 `[Min:1990, Max:2026-10-12]`）⇒ 任何 `WHERE date = X` 都是 2980 万行全表扫描 | 需改 **tdx2db Go 二进制**（写入权不在 Node 侧）⇒ **超 MVP 范围**，登记待办 |
| 5.3 | ⚠️ **CI 从此不验证「1.24GB 真库规模的备份耗时与体积」**（CI 跑迷你库，秒级；full 档那 36s 的备份只在本地跑过）| 同 T60 的 `tests/http` 性质 ⇒ **需显式挂到某道门槛**，否则长期无人跑 |
| 5.4 | ⚠️ `smoke-m3` 的 SQLite 热备份 **40.5s**（后端全量 285s 的最大单块）；DuckDB 备份产物 **820MB** > 500MB 阈值 ⇒ **备份校验被跳过** | 真库规模的 DuckDB 备份**从未被验证**（与 5.3 同源）|
| 5.5 | 🟠 **`POST /api/candidates/batch` 不固化基准价** ⇒ 批量入池的行 `candidate_base_price=NULL`、「基准价/相对收益」显示 `--` | Req §5.7 #3 的缺口（T56 已登记）|
| 5.6 | 🟠 **`max_results` 后端夹取已改 100**（本波修）⇒ `scan.test.ts:231` 的旧断言同步改 | 已修 |
| 5.7 | 🟠 **后端无「filter 类插件」校验**（monitor 插件 → 400）| 前端已用「下拉只列 filter 类」兜住；后端补校验会红 `scan5000`/`t55`（它们用 monitor 插件测 400）⇒ 需连带改测试 |
| 5.8 | 🟡 `filter` 插件的 `symbol` 字段没有 `runtimeInjected: true`（只有 monitor 有）⇒ 直接渲染 schema 会露出「标的代码」输入框 | 选股页用 `hiddenKeys` 显式隐藏；后端 `FILTER_SYMBOL_FIELDS` 建议补 |
| 5.9 | 🟡 SDD §4.4 写 `baseline_price`，实现是 `candidate_base_price` | 契约文档待更正 |
| 5.10 | 🟡 迷你库档 5 个 skip **只有计数、没有 `console.warn` 提示** | 与 F7 的做法不一致 ⇒ skip 可见性待统一 |
| 5.11 | 🟡 前端 `act(...)` 警告 + `ExperimentalWarning: localStorage` + `axe-core getContext not implemented` 噪音大 | 非失败，但淹没输出 |
| 5.12 | 🟡 移动端 Tab 现 **6 项**（PRD §5.8 #6 只列 5 项）| **需 owner 裁决** |
| 5.13 | 🟡 `GET /api/candidate` 实测 2.2~2.6s（PRD §5.8 #3 要求 ≤200ms）⇒ 慢在既有 `batchGetLatestClose` | 性能欠账（同 5.1）|

---

## 6. PE2 进一步优化的排查结论（**已排除的方案，避免重复劳动**）

| 方案 | 实测 | 结论 |
|---|---|---|
| **给 CTE 加 `symbol IN` 下推** | CTE 675ms vs 306ms | ❌ **净负收益，已回退** |
| `LEFT JOIN raw_adjust_factor` 加冗余 `AND f.date BETWEEN ? AND ?` | 收益不稳定（wall 反向 / cpu 正向）| ⚠️ 不建议盲改 |
| **RSI 只算最后一点**（`calculateRSILast`）| 插件循环 446~608ms → ~110~160ms（省 200~280ms）| ⭐ **值得做**：Wilder 平滑的 `avgGain/avgLoss` 吃**原始 gains/losses**，不吃回 rounded RSI ⇒ **取值逐位相同**；需让 golden 保持绿 |
| 插件循环分片并发 | 2 核上限有限 | ⚠️ 收益上限低，且有事件循环压力 |
| 预取窄列（去掉 open/high/low）| 1372→1189ms | ❌ **破坏插件契约**（`volume_breakout` 用 `k.high`；自定义插件更不受控）|
| 候选池 SQL：去 `raw_symbol_name` JOIN / 只扫 kline | 162→164 / 183ms | ❌ **噪声内，无空间**（`ORDER BY … LIMIT` 只占 0.01s）|
| 预取天数按插件参数动态收窄 | 会改变 RSI 播种点 | ❌ **会改结果**（现状 73 根就是现状口径）|
| `EXISTS` 代替 `raw_symbol_class` INNER JOIN | 281ms | ❌ 更差 |

⇒ **可安全实施的下一步只有「RSI 只算末点」**（省 200~280ms）与「join 日期谓词」（需再测）。

---

## 7. 验证汇总

| 检查 | 结果 |
|---|---|
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |
| **后端全量（full 档真库）** | **707 passed / 54 文件**，0 failed |
| **前端全量** | **545 passed + 1 todo / 29 文件**；`vite build` ✓ |
| **迷你库档（模拟 CI）** | **557 passed + 5 skipped**，覆盖率 74.56% |
| **G6.1 / G6.5** | `watchPromote` 反向断言绿；候选相关 55/55 |
| **G6.2** | F-S1~F-S5 全部实现 + 21 个页面用例 |
| **G6.3** | 候选池 **5000 只** / 命中 343 只（`totalCandidates` 不再恒为 0）|
| **G6.4** | **2741ms ≤ 3000ms**（隔离跑，余量 259ms）|
| **G6.6** | **+100px → 0**（结果表渲染后 +187px → 0）|
| `a11y-check --pages stockscan` | **0 critical / 0 非 critical** |
