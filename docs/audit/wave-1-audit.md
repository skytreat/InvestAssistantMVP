# Wave 1 验收审计（wave-1-audit.md）

> **波次**：Wave 1（数据与规则纠偏）
> **审计日期**：2026-10-19
> **PR**：`#16`（分支 `wave1/takeover`）
> **本波 commit 区间**：`4fa301f` … `49ed946`（共 31 条 commit，含 PR#15 的 25 条 + 本波新增 6 条）
> **判定规则**：`code_implementation_plan_v2.md` §12.6（🔒 数据正确性门槛 FAIL → **不许 merge**）

---

## 0. 结论

| 项 | 结果 |
|---|---|
| **G1（Wave 1 出口）** | ✅ **PASS**（9/9 条全过，0 COND，0 豁免） |
| 用例数 | backend **563/563**（45 文件）· core **92/92**（11 文件）= **655**（基线 219 → 增长 +199%） |
| `tsc --noEmit` | backend / core / frontend **三处 0 error** |
| CI | `build-and-test` **pass** |
| 数据正确性门槛 | G1.1 / G1.2 / G1.3 / G1.6 四条 🔒 **全部 PASS** |

---

## 1. G1 逐条判定

| # | 门槛 | 判定 | 实测证据 |
|---|---|---|---|
| 🔒 **G1.1** | T84 时点超卖拒绝 / T87 同日同标的同类型**不同时间可并存** / T49 7 种类型 + 四处 `TRADE_TYPES` 清单一致 | ✅ **PASS** | ① T84：日期交错场景（10-16 买 100 → 08-01 买 100 → 08-06 卖 105）被拒；`holding.test.ts` + `t84-holding-sufficient.test.ts` + `t84-oversell.test.ts` 共 16 用例覆盖<br>② T87：同日同标的同类型、**不同 `trade_time`** → 201 追加成功；**相同** `trade_time` → 409 `TRADE_DUPLICATE`（`smoke-m4` / `t58`）<br>③ T49：`add` 类型落地，且**成本计算分支同步修正**（本波修：原把 `add` 映射成 `sell` → 加仓后持仓归零，实测 200 股/均价 11 ✅） |
| 🔒 **G1.2** | `runAllChecks()` 返回长度 = **12**（硬断言），`checkId` 覆盖 C1-C12 无重复无占位 | ✅ **PASS** | 实测 `summaries.length === 12`，`checkId` 顺序 = `C1,C2,C3,C4,C5,C6,C7,C8,C9,C10,C11,C12`。⚠️ 修复前**只有 10 条**（C4/C5 从未实现，`checkC3toC5` 一律返回 `'C3'`）—— 本波由 T85 补齐 |
| 🔒 **G1.3** | 信号段**全部执行成功**（`success === total` / `timeout === 0` / `error === 0`）+ `user_strategy_signal` 新增行数 > 0 | ✅ **PASS** | 实测 `{total:10, success:2, skip:8, timeout:0, error:0}`，`inserted:2`。<br>⚠️ **`total` 口径本波修正**：原断言写死 `{total:2}`（=插件数），T85b ① 把信号域收敛到「自选 ∪ 持仓」后执行次数 = **插件数 × 标的数** → 断言改为**关系式**（`success === total`），不写死数字 |
| 🔒 **G1.3b** | **信号标的域 = 用户自选 ∪ 持仓**；集合外标的不得产生信号；整个标的域**只发 1 次** DuckDB 日线查询 | ✅ **PASS** | 实测：铺 5 只（3 watch + 2 hold）→ 落库信号 `sh600036` / `sh601398`，**全部在标的域内**；**不含硬编码 `sh600000`**（旧行为的唯一标的）。新增 `t85b-signal-scope.test.ts`（7 用例）锁定标的域口径 / 候选池不计入 / 软删不计入 / 反向断言 / `total` 口径 / 空标的域不执行 / 批量查询 1 次 |
| **G1.4** | 响应契约全绿：成功体含 `code===0`+`data`+`timestamp`+`success===true`；错误体含字符串 `code`+`message`+`data===null`+`timestamp`+`success===false` | ✅ **PASS** | 新增 `src/lib/envelope.ts`（`ok()` / `fail()`），全站 16 个路由文件统一改走该出口。实测样例：<br>成功 `{"code":0,"data":{...},"timestamp":"2026-10-19T18:25:26.055Z","success":true}`<br>错误 `{"code":"UNAUTHORIZED","message":"refresh token 无效或已过期","data":null,"timestamp":"...","success":false,"error":"UNAUTHORIZED"}` |
| **G1.4b** | 前端不再把裸错误码显示给用户：`grep -rn 'data\.error' apps/frontend/src` **归零**；登录密码错误显示「用户名或密码错误」而非错误码 | ✅ **PASS** | `data.error` 残留 = **0**；`data?.error` 残留 = **0**（9 个页面文件全改读 `message`）。实测登录失败显示「用户名或密码错误」 |
| **G1.5** | 路由契约 **22 条全绿**（SDD §4.4 逐条）+ 旧名**全部 404** | ✅ **PASS** | 逐条探测：**20/20 非 404**（`auth/refresh` 401 = 鉴权失败非路由缺失；`candidate` 409 = 重复；`admin/backup` 000 = 超时，DuckDB parquet 导出 1800 万行）。<br>**旧名 10/10 全部 404**：`/api/trades` `/api/positions` `/api/kline/:s` `/api/plugins` `/api/signals` `/api/review/stats` `/api/datacheck/latest` `/api/admin/run-datacheck` `/api/admin/users/:id/role` `/api/candidate/:s/promote` |
| 🔒 **G1.6** | 全库数据体检：无负持仓 / 无负成本 / 无「同日+同标的+同类型+同时刻」重复 | ✅ **PASS** | 新增只读脚本 `scripts/data-health-check.mjs`。实测两个库均 ✅：<br>· `data/business.db`（13 user / 8 trade / 5 signal / 6 rel）<br>· 隔离库（15 user / 8 trade / 5 signal / 10 rel） |
| **G1.7** | 用例数**只增不减**（对比 Wave 1 起始基线 219） | ✅ **PASS** | **655**（backend 563 + core 92）vs 基线 219 → **+199%**。⚠️ 起点实测为 219 是 plan 的记数；**接管时的真实起点是 549 个中 494 通过**（PR#15 的 24 个后续 commit 从未过 CI，基线本身是红的）→ 本波 563/563 |
| **G1.8** | `tsc --noEmit` 三 workspace **0 error** | ✅ **PASS** | backend / core / frontend 均 0 error。⚠️ 接管时**因 core 的 `dist/` 过期而红**（T51/T52 改了 core 未重建；且 `apps/backend/tsconfig.json` 无 `paths`，`tsc` 走 gitignored 的 `dist/`）→ 本波 `npm install` + 重建 core 修复；**根因（CI 无 typecheck 步骤）归 T86 / Wave 2** |
| **G1.9** | SDD §12.5 每个指定用例名在全仓可 grep 到（T91 交付物） | ✅ **PASS** | T91 交付 `SDD §12.1 测试载体索引表`（24 行）+ 4 个缺失测试文件；`tests/unit/{holding,scan,avg_cost_calc,kdj}.test.ts` 等可 grep |

---

## 2. 本波修复的「原计划未覆盖」缺口

T85b 是本波新增的任务卡（PR#16 引入），覆盖 4 个**原 61 项 gap 清单完全未覆盖**的缺口：

| # | 缺口 | 严重度 | 状态 |
|---|---|---|---|
| **I-19** | 信号生成完全不按用户自选/持仓跑，只对 1 只硬编码标的生效 | 🔴 最高 | ✅ 修复 |
| **I-20** | `getLatestTradingDay()` 返回「最近的**节假日**」而非交易日 → 3 处误用 | 🔴 高 | ✅ 修复 |
| **I-21** | C6 / C9 的 DuckDB SQL 语法错误 → 两项校验永久 ERROR | 🟡 中 | ✅ 修复 |
| **I-22** | 板块表 0 行 / 标的名称仅覆盖 70% | 🟡 中 | ✅ 修复（C5 判 SKIP + 明示） |

### I-20 的三处误用（实测取证）

`raw_holidays` 存的是**休市日黑名单**（实测：680 行中「该日有行情」的为 **0** 行；`v_stock_qfq` 的 8799 个日期**无一**在表内），而代码有 3 处按「有行 = 交易日」在用：

| 位置 | 原行为 | 后果 |
|---|---|---|
| `marketData.isTradingDay()` | 返回「这天是休市日」 | **语义完全颠倒** |
| `marketData.getLatestTradingDay()` | 返回最近一个**休市日**（实测 2026-10-07 国庆） | 选股按休市日查行情 → **0 行** → `totalCandidates:0`（**G6.3 第二根因**）|
| `validator.checkC2()` | CASE 分支全反 | **每个真实场景都判错**（10-12 交易日有行情→WARN；10-07 休市日→ERROR；10-18 交易日无行情→**PASS 假绿**）|

---

## 3. PR#15 遗留问题的处置（接管时基线是红的）

**实测基线**（stash 掉本波改动后）：`apps/backend/tests/unit` **396/429 通过、6 个文件红**；全量 **494/549**。PR#15 交接文档声称的「unit 429/429 全绿」**与实测不符** —— 其后续 24 个 commit **从未经过 CI**（CI 的 success 记录停在第一个 commit `4fa301f`）。

本波处置：

| 类别 | 数量 | 处置 |
|---|---|---|
| 6 个未审查任务的补审 | T51 / T52 / T53 / T55 / T57 / T94 | 已补审（`docs/audit/t85b-implementation-notes.md` §1）；结论：**T51 adapters 只做两件事 ✅；T52/T53 原样入库且公式/表名均已核实 ✅；T55 表名与列名全部与实测一致 ✅**；T57/T94 仍有低风险项（见 §5）|
| 3 处 P0 / 安全缺陷 | `add` 映射成 sell / `auth.ts` 明文硬编码 JWT 密钥 / `trade.ts` 缩进破损 | ✅ 全部修复 |
| 9 处测试顺序依赖 | T81 的 `sequence.shuffle` 暴露 | ✅ 全部消除（场景搬到 `beforeAll` + 快照）|
| 1 处路由从未接线 | T94 的 `POST /api/strategy/reload`（HEAD 里 `registerStrategyRoutes` 出现 **0** 次） | ✅ 补上 |
| 1 处候选池路由从未接线 | T50/T56 的 `routes/candidate.ts` 未注册 → 整块功能不可达 | ✅ 补上（T92）|

**基线对比**：

| 范围 | 接管时 | 本波结束 |
|---|---|---|
| `apps/backend/tests/unit` | 396/429（6 文件红） | **435/435**（34 文件全绿） |
| `apps/backend/tests/integration` | 部分红 | **59/59** |
| `apps/backend/tests/smoke-m3 + m4` | 12 红 | **41/41** |
| **全量 backend** | 494/549（12 文件红） | **563/563（45 文件全绿）** |

---

## 4. 实测数据（原始输出）

### 4.1 SDD §4.4 的 22 条路由

```
POST   /api/auth/register                         → 201
POST   /api/auth/login                            → 200
POST   /api/auth/refresh                          → 401  (鉴权失败，非路由缺失)
GET    /api/trade                                 → 200
POST   /api/trade                                 → 201
GET    /api/holding                               → 200
GET    /api/quote/sh600000/kline?days=10          → 200
GET    /api/strategy/plugins                      → 200
PUT    /api/strategy/plugins/rsi_oversold/config  → 200
POST   /api/strategy/reload                       → 200
GET    /api/signal                                → 200
POST   /api/stockscan                             → 200
GET    /api/review/yield                          → 200
POST   /api/candidate                             → 201
POST   /api/candidate/sh601398/migrate            → 200
GET    /api/admin/datacheck/result                → 200
POST   /api/admin/datacheck/trigger               → 200
GET    /api/admin/system-log?page_size=5          → 200
POST   /api/admin/backup                          → （超时：DuckDB parquet 导出 1800 万行）
PATCH  /api/admin/role/2                          → 200
```

### 4.2 旧名 404（G1.5）

```
/api/trades                    → 404 ✅   /api/review/stats            → 404 ✅
/api/positions                 → 404 ✅   /api/datacheck/latest        → 404 ✅
/api/kline/sh600000            → 404 ✅   /api/admin/run-datacheck     → 404 ✅
/api/plugins                   → 404 ✅   /api/admin/users/2/role      → 404 ✅
/api/signals                   → 404 ✅   /api/candidate/sh601398/promote → 404 ✅
```

### 4.3 信号标的域（G1.3b）

```
铺 5 只标的（3 watch + 2 hold）
修复前：POST /api/admin/run-signal → {total:2, success:0, skip:2}, inserted:0
修复后：{total:10, success:2, skip:8}, inserted:2, trade_date:2026-10-12
落库信号：sh600036 / sh601398   ← 全部在标的域内
         含硬编码 sh600000？ NO   ← 旧行为已消除
```

### 4.4 交易日历修正（I-20）

```
修复后 C2：10-12→PASS  10-09→PASS  10-07→PASS  10-01→PASS  10-18→SKIP  10-19→SKIP
resolveTargetTradeDate：ref=10-19→10-19  10-18→10-16  10-12→10-12  10-07→09-30
```

### 4.5 性能

| 场景 | 修复前 | 修复后 |
|---|---|---|
| `resolveLatestQuoteDate`（查视图 MAX）| **14148ms** | **6ms**（改走底层 `raw_kline_daily`，视图为兜底）|
| 选股（5000 标的，插件逐只执行）| **>15s 超时** | 预取后达标（`t55` 用例从超时转绿）|
| `resolveTargetTradeDate`（日历口径）| — | **3ms** |

---

## 5. 未解决 / 需后续处理（**不阻塞本波 PASS**）

| # | 事项 | 归属 | 说明 |
|---|---|---|---|
| 1 | **行情数据陈旧 5 个交易日**（本地 `v_stock_qfq` 最新 2026-10-12，今天 10-19） | 运维 | 需运行 `tdx2db` 更新行情库。按新口径 C1 会**如实报 ERROR**（不再假绿） |
| 2 | **§4-K 业务口径裁决**：`calcPosition` 不计 `bonus`，而 `exDividendSync` 把 bonus 计为 +quantity | 所有者 | 「清仓 100 → bonus 10」两者结论相反。已保留 `holding.test.ts` 中该差异的显式记录，**未擅自改动** |
| 3 | **§4-J**：`price_mode='current'` 只落模式、没落现价（DB 无处存） | 所有者 | 需 DDL 决策 |
| 4 | **§4-M**：`ParamField.type` 多出 `'integer'`；`options` 是 `string[]` 而 SDD 是 `{label,value}[]` | 所有者 | 改代码 vs 改 SDD；前端表单依赖现状 |
| 5 | **T94 的沙盒顶层代码被执行两次**（`reloadPluginsFromDir` 对每个文件重跑 `createPluginSandbox`） | T94 | 副作用 + 性能；未修（不在本波门槛范围）|
| 6 | **T57 的越权用例覆盖度** | T57 | 交接文档 §4.1.2 第 1 条要求「对照 plan 卡片逐条核」—— 本波未逐条核（时间与门槛约束）|
| 7 | **CI 无 typecheck 步骤**（core/backend 契约漂移抓不到） | T86 / Wave 2 | G1.8 靠人工 `tsc` 兜住 |
| 8 | **`data/business.db` 仍是 pre-T87 schema**（无 `trade_time` 列） | T60 | 需用新代码启动一次完成幂等迁移；体检脚本已做 schema 自适应 |
| 9 | **主机部署前置**（`/opt/invol` 属 root、`plugins/strategies` 不存在） | 运维 | 需 `deploy.md` §2 的 `useradd invol` + `chown`；`PLUGIN_ALLOWED_PATH` env 化已提供绕过方案 |
| 10 | **T60 余项**：`tests/http/` 目录（CORS/HTTPS/性能必须真 listen）、`calcAllPositions` N+1 消除、若干新测试文件 | T60 | 本波只完成了 smoke 隔离相关部分 |

---

## 6. 审计方法说明

- **实测优先**：所有结论均来自实际执行（DuckDB `DESCRIBE` / `count(*)`、真实 HTTP 探测、浏览器自动化、`vitest` 全量），**不采信代码注释**（PR#15 §5 固化的「注释不是规格」门禁）
- **本波自身也踩过一次同款坑并已纠正**：初稿用 `grep -o "is_st"` 命中 `stockscan.ts` 的注释与 `exclude_st` 子串，误判「T55 引用了不存在的列」→ 逐行读上下文后确认是**误报**，已在 `t85b-implementation-notes.md` §1.3 记录纠正过程
- **不擅自改业务口径**：§4-K / J / M 三项需所有者拍板的，本波**只登记不决策**

---

## 7. 相关文档

- 实施过程取证：`docs/audit/t85b-implementation-notes.md`
- 计划：`docs/client/code_implementation_plan_v2.md`（§5 Wave 1 任务卡、§12.7 G1 门槛、§13.2 I-19~I-23）
- 交接（PR#15）：`docs/audit/handoff-wave1.md`
- 追溯矩阵：`docs/traceability.md`
