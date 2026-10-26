# V3-1 验收 —— 券商文件导入与对账（T119~T127 / V3.0 + V3.1）

> **判定人**：V3-1 实施 agent
> **日期**：2026-10-25
> **波次范围**：**T119** 送股/现金分红成本语义（V3.0）+ **T120** 标的资产分类（V3.0b）+ **T121** 解析器 / **T122** 事实层三表 / **T123** 事件归一化 / **T124** 去重回填 / **T125** 资金校验 / **T126** 对账报告 / **T127** 现金类建模（V3.1）
> **上游**：[`code_implementation_plan_v3.md`](../client/code_implementation_plan_v3.md) §4.1/§4.2（V3.0 门槛 G1~G6 + V3.1 门槛 G1~G10）+ §4.5（通用门槛）
> **判定规则**：V3.1 数据正确性门槛 **G1~G10**；**只有 PASS / FAIL，无 COND**
> **Base**：`main` `6f4ca01`（docs(v3) spec 合并）
> **本波已落 commit**：`e25471b` T119 / `933bfce` style / `732b9f4` T120 / `70400e1` style / `787f372` fixtures / `3d4a1bf` T121 / `5cd5d34` T123 / `d4df10c` T122 / `2cb7900` T124 / `4469396` T125 / `8ffbf85`+`5db3e32` T127；**本 PR 新增**：T126 + 既有测试回归清零 + lint 清理 + 本文档（见 §6 commit 区间）
> **载体**：`tests/fixtures/broker-samples/`（6 文件 / 1627 行，脱敏，V3-B7）

---

## 0. 判定结论

### 0.1 V3.1 数据正确性门槛（G1~G10）

| 门槛 | 判定 | 实测依据 |
|---|---|---|
| 🔒 **G1** 解析覆盖 | ✅ **PASS** | 6/6 样本 `parseBrokerFile` ok=true，合计 1627 行（§1） |
| 🔒 **G2** 编码与包装 | ✅ **PASS** | 伪 `.xls`（GB18030 TSV / CRLF / `="..."` 包裹）×2 + 真 xlsx（前 4 行元数据、第 5 行列名）×4 + 非首行表头 全部正确解析（§1） |
| 🔒 **G3** 幂等 | ✅ **PASS** | 同文件重复导入 `duplicateFile=true` 且 0 新行；同内容多笔不被误判（§3） |
| 🔒 **G4** 跨文件去重 | ✅ **PASS** | 同券商成交+交割单不双计：`dedupeAcrossFiles` 冗余腿软标记，「同组交割与成交侧同时有活动行 = 0」（§4） |
| 🔒 **G5** 时间回填 | ✅ **PASS** | 国泰 4 份回填 **109/109 全 L1**、0 低置信度、unmatched 0；成交独有 0 行（§4） |
| 🔒 **G6** 资金校验 | ✅ **PASS** | 国泰交割侧 **139/139 命中**（≥ 基线 145/148 口径换算 100%≥97.98%）；3 处不适用（现金分红）单列；无账户级闭合断言（§5） |
| 🔒 **G7** 差额归因 | ✅ **PASS** | T126 报告归因 7 桶逐项可下钻、无「其他」兜底、residual 恒置顶、覆盖区间声明；latest 与 run 幂等一致（§7） |
| 🔒 **G8** 敏感信息 | ✅ **PASS** | 原始敏感标识 + 实测交易明细全仓（含 md）grep = 0；脱敏 manifest 不枚举原值；D-21/D-24 交易明细已泛化（D-33 两轮）；去重/回填键不含敏感字段（§8） |
| 🔒 **G9** 现金类建模 | ✅ **PASS** | 华宝 2 份逆回购 **配对 180/180**、未配对 0、**利息 7,501.46 ±0.5**、0 负利息（§6） |
| 🔒 **G10** 性能 | ✅ **PASS** | 导入 1627 行 **0.1s**（<30s）；单文件解析 **≤26ms**（<3s）（§9） |

```
✅ G1~G10 = PASS（十条全过，0 COND）
```

> 🔒 **G1~G10 全部为数据正确性 / 性能类门槛，零豁免。**

### 0.2 V3.0 成本语义门槛（G1~G6，随 T119 落地）

| 门槛 | 判定 | 实测依据 |
|---|---|---|
| 🔒 **V3.0-G1** 送股语义 | ✅ **PASS** | 送股后股数 +n、均价按比例摊薄、不产生价差盈亏（`t119-cost-semantic.test.ts` + golden B 组） |
| 🔒 **V3.0-G2** 分红语义 | ✅ **PASS** | 分红后 `cashReceived` 正确、均价不变、不产生价差盈亏 |
| 🔒 **V3.0-G3** 口径一致 | ✅ **PASS** | core 与上层 `mapToCoreTrade` 口径统一（bonus 不再被忽略），两处相反口径消除 |
| 🔒 **V3.0-G4** 双口径呈现 | ✅ **PASS** | 价差盈亏（realizedPnL）与含分红净利（+cashReceived）分别呈现且可加 |
| 🔒 **V3.0-G5** 回归 | ✅ **PASS** | `movingWeightedCost` / `positionCalculator` 既有 golden 零回归 |
| **V3.0-G6** 构建 | ✅ **PASS** | `npm run build -w @invest/core` 后 core/backend/frontend 三处 typecheck 0 错误 |

> ⚠️ **V3.0 口径变更引发的既有测试期望更新**（非 src 缺陷，逐处实测确认为「旧口径期望过期」）：
> `holding.test.ts` 场景5、`t67-dashboard-enrich` weight/总市值、`trade.test.ts` G5 bonus 期望、
> `smoke-m5` 清仓量+日期+realizedPnL —— 见 §10 与 [`v3-pending-decisions.md`](./v3-pending-decisions.md) **D-28**。

### 0.3 通用门槛（§4.5）

| 门槛 | 判定 | 说明 |
|---|---|---|
| **通用-G1** 一个 T 一条 commit | ✅ **PASS** | 每个 T 任务独立 commit（本波 11 条已落 + 本 PR 新增 T126/回归清零/lint/docs 4 条） |
| **通用-G2** lint+typecheck+test 全绿 | ✅ **PASS** | `npm run typecheck` 0 错；`npx eslint .` 0 错；`npx prettier --check .` 通过；`npm test` 全绿（唯 `t55`「真实 DuckDB 数据」板块表前置断言在**本机 full 档**过期，CI mini/none 档**自动跳过**、不阻断 gate，见 §11） |
| **通用-G3** 不变量 ≥1 用例 | ✅ **PASS** | INV-S2-40~65 / S4-18~26 等均有对应用例；无法断言项已在 SDD_v3 降级为「约定」 |
| **通用-G4** 阶段审计文档 | ✅ **PASS** | 本文档 `docs/audit/v3-1-audit.md` 与本波 commit 同 PR |
| **通用-G5** CI + Gate 全 PASS 方可 squash | ⏳ | 待 `build-and-test` 绿 + 本文档 PASS（§0.1/§0.2 已 PASS） |

---

## 1. G1/G2 —— 解析覆盖 + 编码包装

6 份样本全部 `parseBrokerFile` ok=true（§9 实测行数列）：

| 文件 | 券商 | 真实格式 | 解析行数 | 编码/包装要点 |
|---|---|---|---|---|
| 国泰ETF交割单.xlsx | 国泰 | 真 xlsx（zip/XML） | 134 | 前 4 行元数据 + 第 5 行列名（非首行表头） |
| 国泰ETF成交.xlsx | 国泰 | 真 xlsx | 125 | 同上 |
| 国泰股票交割单.xlsx | 国泰 | 真 xlsx | 14 | 同上 |
| 国泰股票成交.xlsx | 国泰 | 真 xlsx | 12 | 同上 |
| 华宝交割单.xls | 华宝 | **伪 .xls**（GB18030 TSV，CRLF） | 671 | 单元格 `="..."` 包裹 + 第 1 行即列名 |
| 华宝成交.xls | 华宝 | **伪 .xls**（GB18030 TSV，CRLF） | 671 | 同上 |
| **合计** | | | **1627** | 与 Requirements 附录 A 全集实测一致 |

`broker_parser.test.ts`（9 用例）+ `broker_event_normalize.test.ts`（7 用例）全绿，覆盖「编码/包裹/表头定位/敏感丢弃/映射建议 + 40 种实测表述 0 UNKNOWN」。

## 2. T123 事件归一化

`broker-event-phrases.json`（40 种实测短语）→ 13 种枚举，**0 UNKNOWN**；`normalizeEvent` 纯函数可单测。

## 3. G3 —— 幂等

`broker_import.test.ts`（8 用例）：同一文件重复上传 `duplicateFile=true` + 0 新行（file_hash 拦截）；同内容多笔（真实分笔）不被误判为重复。

## 4. G4/G5 —— 跨文件去重 + 时间回填

`broker_reconcile.test.ts`（5 用例）：
- **G4**：华宝 2 份 `dedupeAcrossFiles` 冗余成交腿软标记 EXCLUDED，「同组（标的+日期+方向+价+量）交割与成交侧同时有活动行 = 0」（不双计）。
- **G5**：国泰 4 份回填 **109/109 全 L1（精确内容键）**、unmatched=0、lowConfidence=0；「成交独有 0 行」基线成立。
- ⚠️ 回填是**一次性操作**（trade_time 已填 ⇒ totalNeeded=0），故「国泰 4 份」断言回填计数的用例改用**专属 user 7104**（shuffle-safe，见 D-31）。

## 5. G6 —— 资金校验

`broker_fundcheck.test.ts`：国泰交割侧校验范围 = ETF 125 + 股票 14 = **139 行，命中 139/139**（基线 145/148 的分母 148 含 9 行非买卖事件，换算 139/139 = 100% ≥ 97.98%）；3 处不适用 = 现金分红，单独归类；**无账户级闭合断言**（§6.2 明确「资金余额列 = 全账户总资产，不得当现金余额用」）。

## 6. G9 —— 现金类建模（逆回购 + 货币 ETF）

`repo_model.test.ts`：华宝 2 份逆回购 **配对 180/180**、未配对出资/收回 = 0、**利息 7,501.46 ±0.5**、0 负利息。
- 配对算法 = 金额带 [0.995,1.02] + 最小差值贪心 + 同开仓日 2~3 笔合并收回拆分（D-24，3 轮实测驱动，终态 0 负利息）。
- 隐含年化 = 本金×天数加权 **1.44%**（非规格 2.04% 日均口径，口径差异已登记 D-23）。

## 7. G7 —— 差额归因（T126 对账报告）

`broker_reconcile_report.test.ts`（7 用例）：
- **报告结构完整**：coveredRange（归一化 YYYY-MM-DD，兼容 YYYYMMDD）+ coverageNote（「区间外不构成已核对」）+ matchSummary + attribution（7 桶）+ fundCheck + timeBackfill + repoModel + returnSummary。
- **归因逐项可下钻**：`attributionDrilldown` 6 类（repo/cashLikeEtf/dividend/offExchange/unknown/unmatched）分页下钻；**无「其他」兜底**；**residual 恒 order[0] 置顶**。
- **latest 与 run 幂等一致**（D-25：按需重算，不落报告表）。
- **华宝交叉断言**：报告内嵌 repoModel = 180/180 + 利息 7501.46（与 T127 G9 基线同源，G7 引 G9 证据）。

## 8. G8 —— 敏感信息

脱敏映射 manifest（`broker-samples/README.md`）**不枚举原始敏感值**（D-33，2026-10-26 收紧）——只列「列 + 格式 + 占位值」，原值不入仓（manifest/决策文档/审计文档均不复述，避免反查表使脱敏失效）。
校验口径：原始敏感值全仓 grep = 0（含 .xls/.xlsx 数据文件 + .md 文档）；去重键/回填键 = 标的+日期+方向+价格+数量（SDD_v3 §5），**不含**敏感字段，脱敏不影响 G4/G5。
⚠️ 历史说明：`787f372`（fixtures 入库）曾把 8 个原值写进 README 映射表 + D-3 + v3-spec-gate.md，本波 D-33 commit 已脱敏；squash merge 后 main 不含这些 commit，原值不落到 main 历史。
② **第二轮（D-33 扩围）**：`v3-pending-decisions.md` D-21/D-24 的「实测理由」曾复述真实逆回购交易明细
（出资腿金额、开仓/收回日期、时刻）—— 属**个人财务数据**，已泛化（保留决策结论 + gate 基线 180/180、
利息 7501.46，去掉逐笔数字）。决策文档只承载「选了什么 + 为什么」，实盘数字由测试/fixture 断言承载。
残留（owner 决）：D-3 源路径 `/home/ubuntu/brokertrades/成交交割单`（owner 本机路径）是否也需隐去。

## 9. G10 —— 性能（实测，2026-10-25）

```
PARSE 国泰ETF交割单.xlsx : 134 rows 26ms ok=true
PARSE 国泰ETF成交.xlsx   : 125 rows 11ms ok=true
PARSE 国泰股票交割单.xlsx:  14 rows  5ms ok=true
PARSE 国泰股票成交.xlsx  :  12 rows  1ms ok=true
PARSE 华宝交割单.xls     : 671 rows 11ms ok=true
PARSE 华宝成交.xls       : 671 rows 15ms ok=true
TOTAL data rows = 1627
IMPORT all 6 files: 1627 rows, 0.1s
```
- 单文件解析 **≤26ms**（门槛 <3s）✅
- 导入 1627 行 **0.1s**（门槛 <30s）✅

## 10. 既有测试回归清零（V3.0/V3.1 口径变更的下游）

T119（bonus 计入移动加权）+ T122/T126（新表 + 新路由）使 4 个既有测试文件的**旧口径期望**失效。逐处按 AGENTS「改既有代码前先证明现状是错的」实测确认为**期望过期（非 src 缺陷）**后更新，**未改动任何 src 业务逻辑**：

| 文件 | 过期期望 | 更新后（T119/V3 口径） |
|---|---|---|
| `holding.test.ts` 场景5 | 送转后数量 100 / 均价 10 | 110 / 1000÷110（bonus 摊薄） |
| `t67-dashboard-enrich.test.ts` | weight=1200/6780、总市值 6780 | 总市值 13530（sh600002 bonus300 ⇒ 市值 9000） |
| `trade.test.ts` G5 | bonus expectQty 100 | 110（transfer 仍被过滤 → 100） |
| `smoke-m5.test.ts` | 清仓 1100、realizedPnL 7592 | 清仓 1200（含 bonus100）、realizedPnL 9192；除权事件日期移至清仓前 |
| `smoke-m1.test.ts` | 7 张业务表 | 11 张（+asset_class + broker_* 3 表） |
| `envelopeContract.test.ts` | T89b 遍历表无 broker 路由 | 补入 10 条（7 导入 + 3 对账） |

判定：全部为**测试期望同步**，src 行为符合 T119/T122 设计。

## 11. 已知环境问题（不阻断 gate，已登记）

`tests/unit/t55-stockscan-filter.test.ts`「真实 DuckDB 数据」的**板块表前置断言**（`raw_tdx_blocks_member COUNT=0`）在**本机 full 档**（真库 `/opt/invol/quotes.duckdb`，板块表现 89,928 行）过期报红；该 describe 由 `MARKET_DATA_NUMERIC_AVAILABLE` 守卫、T60c 由 `marketDataTier()==='full'` 守卫 —— **CI（无 DUCKDB_PATH ⇒ mini/none 档）自动跳过**，不阻断 `build-and-test`。
板块表新数据属 tdx2db 数据层变更；「行业过滤在真数据上的行为」应单独立任务并实测后再写断言（D-32，待 owner 确认）。

## 12. commit 区间

- 已落（`e25471b..5db3e32`）：T119/T120/fixtures/T121/T123/T122/T124/T125/T127
- **本 PR 新增**：
  - `feat(T126)` 对账报告 + 差额归因（`brokerReconcileReport.ts` + `routes/brokerReconcile.ts` + `routes/index.ts` 注册 + `broker_reconcile_report.test.ts`）
  - `test` 既有回归清零（§10 六文件）
  - `style` T122/T123 遗留 lint（`eventNormalize` DIRECTIONS/ctx、`brokerImport` rowDeduped、`broker_import.test` prettier）
  - `docs(audit)` 本文件 + `v3-pending-decisions.md` D-27~D-32

> 合并条件：`build-and-test` CI 绿 + §0.1/§0.2 全 PASS ⇒ squash merge。
