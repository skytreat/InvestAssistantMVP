# 动态审计记录（2026-10-17：API 探针 + 浏览器双通道）

> 本文档由实施计划 §11 迁出（2026-10-17）。属**审计发现记录**，非计划内容。
> 其中影响验收判定的结论已前移到 §12 Wave 出口门槛（G1-G8）。

## 11. 动态审计记录（2026-10-17，API + 浏览器双层）

> **API 层方法**：真实启动后端（127.0.0.1:8080，`admin/admin123`），对 41 个端点逐个发真实 HTTP 请求。真实 DuckDB 行情库 `data/quotes.duckdb`（1.19 GB / 2026-10-15）。
> **浏览器层方法**：Playwright + Chromium（`ms-playwright/chromium-1217`），1440×900 主视口 + 375/768/1440 三视口响应式，逐页 DOM 断言 + innerText dump + CSSOM `:focus` 规则扫描 + console/network 监听。Playwright 装在**临时目录**（仓库外），未污染 `package.json`。
> 截图与原始 JSON 见 `%TEMP%/opencode/shots/`、`%TEMP%/opencode/browser-audit.json`。

### 11.0 ⚠️ 动态审计自身的误报已修正（方法论记录）

首轮 44 项断言报出「PASS 6 / FAIL 36」，其中 **4 项是断言写错导致的误报**，经 DOM dump 复核后修正：

| 项 | 首轮误报 | 修正后 | 误报根因 |
|---|---|---|---|
| D1 总资产卡+双口径 | FAIL | **PASS** | 我搜 `价格收益率`，实际文案是「价格**口径**/实际**口径**」 |
| D2 资产组成图 | FAIL | **PASS** | 我搜 `<svg>`，实际是 `conic-gradient` div |
| R1 双口径 Tab | FAIL | **PASS** | 同 D1 标签词 |
| R2 收益曲线 | FAIL | **PARTIAL** | 容器与月/季/年切换**已存在**，但 `asset_stat_history` 为空数组 → 走空态未渲染 SVG |
| G1f h1/h2 一致 | PASS | **FAIL** | 该断言只跑了 Dashboard（恰好 h2=0）；代码证实 `Kline.tsx:362`、`StockScan.tsx:197` 仍是 `<h2>` |

**教训**：动态审计同样会产生假阴性/假阳性。**每条 FAIL 必须用 DOM dump 或代码交叉复核后才能写进 plan**，否则会把「已有功能」误列为 gap。本次 4 项误报全部通过 dump 原文比对发现。

### 11.1 浏览器动态审计最终结论（修正后）

| 页面 | PASS | PARTIAL | FAIL |
|---|---|---|---|
| 全局/a11y | 3 | 0 | 5 |
| Dashboard | 3 | 0 | 3 |
| TradeInput | 0 | 0 | 6 |
| Review | 1 | 2 | 3 |
| Kline | 0 | 0 | 5 |
| StockScan | 0 | 0 | 5 |
| Admin | 0 | 1 | 3 |
| Signals | 0 | 0 | 2 |
| Settings | 1 | 0 | 0 |

**全局层实测数据**：`aria-live`/`aria-expanded`/`aria-current`/`role=dialog`/`label[for]`/`th[scope]` **全部为 0**；`<header>/<main>/<footer>` **全部为 0**（仅 1 个 `<nav>`）；CSSOM 扫描 `:focus` 规则 **0 条**；导航无任何 active 标记；候选池入口缺失。

**正面样本**：Settings 页 schema 驱动表单**已实现**（2 个插件 + checkbox，无 textarea）—— 这是全站唯一做对动态参数渲染的地方，StockScan 应复用它。

### 11.2 动态审计发现的 3 个新 P0

| # | Gap | 实测证据 |
|---|---|---|
| **P0-9** | DuckDB 连接泄漏 → 后端自锁死 | `File is already open in node.exe (PID <自身>)`；修复前第 2 次查询起全挂。✅ **已修复（T80）**，修复后 `market/latest` 连续 3 次全成功 |
| **P0-10** | **股票 K 线 100% 500**：`v_stock_qfq.volume` 是 `BIGINT` → JS `BigInt` → `JSON.stringify` 抛错 | `sh600519`/`sz000001` → `500 "Do not know how to serialize a BigInt"`；**ETF（`sh510300`/`sz159915`）与指数（`sh000001`）正常 200**。K 线页对该错误原样显示。**长期被 P0-9 掩盖** |
| **P0-11** | **「全市场条件选股」无可用插件**：2 个内置插件均为 `category='monitor'` 且 `paramSchema.symbol` 为 `required` | `POST /api/stockscan` 返回 `200 {"totalCandidates":0,"total":0,"results":[]}` |

### 11.3 响应式横向溢出实测（新增 F-Q12）

`documentElement.scrollWidth − clientWidth`：

| 视口 | dashboard | trade | review | kline | stockscan | admin |
|---|---|---|---|---|---|---|
| **手机 375** | **+163** | 0 | **+250** | 0 | **+39** | **+416** |
| **平板 768** | 0 | 0 | 0 | 0 | 0 | **+23** |
| 桌面 1440 | 0 | 0 | 0 | 0 | 0 | 0 |

6 页中 4 页手机溢出，Admin 最严重 416px。违反 PRD §5.8 #1。

### 11.3b 补跑断言（造数据后，11 项）

为触达「数据为空时看不出」的分页/信号/校验卡片逻辑，已向 `apps/backend/data/business.db` **写入测试数据**：25 笔交易尝试（成功 12 笔，`sell` 因 `HOLDING_INSUFFICIENT` 被拒属正确行为）+ 12 笔 PATCH 复盘字段 + 5 只标的加 watch/candidate。

| # | 项 | 结果 | 实测 |
|---|---|---|---|
| B1 | Review 列表渲染 | **PASS** | `tbody tr = 16`（16 笔交易） |
| B2 | 3 态字段（未标记/是/否） | **PASS** | 页面含「未标记」 |
| B3 | 8 页错误提示友好度 | **FAIL ×2 / N/A ×4 / PASS ×2** | 唯一真实失败是 **K 线页 `请求失败: Do not know how to serialize a BigInt`**（P0-10 透传到 UI，印证 F-G4）。dashboard/admin 的红色元素是**正常业务数值**（F-Q14，我的断言误报） |
| B4 | 未知路由重定向 | **PASS** | `/nonexistent-route-xyz` → 重定向到 `/` |
| B5 | 无 token 访问 `/admin` | **PASS**（首轮误报 FAIL） | 渲染登录框，URL 保持 `/admin` 不变；登录后正常进入管理员面板 |
| B6 | token 失效提示 | **PARTIAL** | 能弹回登录框但**无任何提示文案**；且走整页刷新 → 见 F-Q13 |
| B7 | Signals 进页自动加载 | **FAIL** | `table=false`、`行=0`，仍显示「请点击查询按钮加载数据」 |
| B8 | Admin 12 项校验卡片 | **FAIL**（初版误判为 PARTIAL） | 状态词仅 6 个、`checkId` 只有 `C1,C12`，显示「暂无校验记录」空态。**⚠️ 初版结论「缺的是数据、卡片渲染逻辑存在」是错的** —— 真实原因有二：① `services/validator.ts:157` 注释「MVP 只实现 C3，**C4/C5 SDD 是"略"**」，函数名 `checkC3toC5` 但 `checkId` 返回 `'C3'`、`detail` 写「C4/C5 MVP 暂缺」→ **代码只有 10 条校验，C4（退市标记）/ C5（ST 状态一致性）从未实现**；② 本库 `system_log` 校验日志为空。后果：**PRD D1「12 项校验」与 §6.2「C1-C10 通过率 ≥99.9%」不可达**，且 §5 全部任务中无任何一个负责 C4/C5 → 见 §13 B-1 |

**并发观察**：全站 4xx/5xx 请求**仅 1 条** —— `GET /api/kline/sh600519?days=120&fq=qfq` → 500 BigInt。说明除 K 线外无其它隐藏接口错误。

### 11.4 静态结论的动态实证（8 项 P0 全部成立）

| 探针 | 实测 | 印证 |
|---|---|---|
| `POST /api/trades` `trade_type=add` | **400 `trade_type 非法`** | P0-1 |
| `POST /api/trades` `trade_type=sell` | 400 `HOLDING_INSUFFICIENT`（**sell 合法**） | DEC-2 |
| `POST /api/trades` 空 `trade_reason` | 400 `TRADE_REASON_REQUIRED` | 后端校验在 |
| `POST /api/candidates/batch` | **404** | T56 |
| `POST /api/auth/register` | **404** | P0-7 |
| `POST /api/auth/refresh` | **404** | P0-8 |
| `POST /api/admin/run-pipeline` | **404** | T59 → **§13.4 B-12 已裁决改名为 `/api/admin/datacheck/trigger`，归 T90** |
| `POST /api/candidate` | 201，响应体仅 `{id}`，**无基准价** | P0-2 |

### 11.5 顺带修正的三处判断

| 项 | 原判断 | 动态实测修正 |
|---|---|---|
| **DEC-9 开发库路径** | 指认根目录 `data/business.db`（污染库）需清空 | 后端实际用 `apps/backend/data/business.db`（干净：1 admin / 3 笔 buy / 0 信号）。根目录那个是**孤儿**，后端根本不会碰到 |
| Dashboard 双口径 + 资产组成图 | 列为缺失（F-D1「总资产语义错误」/ F-D6「饼图只有 2 段」） | 双口径切换与 `conic-gradient` 组成图**均已实现**；F-D1 收窄为**语义 bug**（显示 `totalCostBasis` 却标「总资产」）；F-D6 收窄为**缺点击下钻** |
| Review 双口径 + 收益曲线 | R1 缺失 | 均**已实现**；收益曲线因无快照数据走空态。`/api/asset-stat/history` 返回 `array[0]` —— 需先跑一次 17:02 cron 写入快照才能验证曲线渲染 |

### 11.6 实测发现的既有缺陷

- **F-Q11 测试顺序依赖**：`validator.test.ts` C11 用例单跑通过、全量跑失败。已 `git stash` 掉 T80 改动复现，确认无关。`tests/setup.ts` 只在 `!(key in process.env)` 时注入，既不覆盖也不清理 → 记为 T81。
- **Review 分页 `setPage` 从未被调用**：`Review.tsx:155` 定义 `[page, setPage]`，但 `:428/:430` 的按钮只调 `fetchTrades(page±1)`，**`setPage` 全文件仅出现 1 次（即定义处）**。实测数据仅 4 条（`totalPages=1`）故控件未渲染（`Review.tsx:426` 条件渲染），需 >20 条才能看到，但 bug 本身已确认 → 归入 T69。

### 11.7 开发库当前状态（**用户已确认保留**）

动态审计期间向 `apps/backend/data/business.db` **写入了测试数据，用户明确指示保留**。后续接手者需知道库内现状：

| 数据 | 数量 | 说明 |
|---|---|---|
| `user_account` | 1（`admin` / admin） | 原生账号 |
| `user_trade_record` | 16 笔（12 笔本轮造的 `批量造数-*` + 4 笔历史） | `trade_type` 分布 `{buy:12, sell:4}`。⚠️ 含 `sell` 类型 —— **T49 改 DDL 白名单时需一并处理**（本库为开发库，允许重建） |
| 复盘字段 | 12 笔已 PATCH（`review_summary` / `remark` / `strategy_match` / `is_stop_loss`） | 三态值含 `1`/`0`/`null` |
| `user_asset_rel` | 5 组 watch + 5 组 candidate（`sh600000` / `sh600036` / `sz000001` / `sh510300` / `sz159915`） | `candidate_base_price` 全为 NULL（P0-2 实证） |
| `user_strategy_signal` | **0 条** | `run-signal` 实测 `{total:2, success:0, timeout:2}` → **两个插件全部 50ms 超时**，一条信号都没产出 |
| `user_asset_stat` | 0 条 | 17:02 cron 未跑，Dashboard 显示「暂无资产快照」 |

**⚠️ 新发现（未立案，待确认严重程度）**：`POST /api/admin/run-signal` 返回 `{"stats":{"total":2,"success":0,"timeout":2,"timeout":2}}` —— **两个内置插件 100% 超时**，`PLUGIN_TIMEOUT_MS = 50`。可能是：
- 环境因素（本机 Node 25 + tsx，首跑 JIT 未预热 / DuckDB 查询耗时计入）
- 或 `buildPluginContext` 的 DuckDB 拉取被计入 50ms 预算

**影响**：M4 的「每日收盘后自动跑一遍策略信号」（Requirements §4.2 #12、F8）在本环境**无法产出信号**。因涉及 SDD §12.5 验收项 F8/PE6，建议在 T78 实测环境（DEC-5 服务器）**优先复核**此项，再决定是否需要独立 T 任务。

### 11.8 当前测试基线

| 套件 | 结果 |
|---|---|
| `tests/unit/duckdbLeak.test.ts`（T80 新增） | **4/4 通过**（git 原始版本 → 4/4 失败） |
| `tests/unit` 全量 | 16/17 文件、**129/130 用例通过**（唯一失败 = F-Q11） |
| `tests/integration` 全量 | **6/6 文件、58/58 用例通过** |
| `tsc --noEmit -p apps/backend` | **0 error** |

> 上述基线在 T80 修复后测得；此后未再改动生产代码（T81-T83 未开始）。

---


### 11.9 本次审计的 14 项二次复核命令与结果

> 记录可复现的复核命令，供后续 audit 时对照。**命令与结果均为 2026-10-17 实测**。

| # | 复核项 | 命令 | 结果 |
|---|--------|------|------|
| 1 | positions 路由路径 | `Select-String trade.ts "\.(get|post|patch|delete)\("` | 8 条；`/api/positions`（:234）非 `/api/trades/positions` ✅ 确认 |
| 2 | KDJ 全仓 | `Select-String -Pattern "kdj\|KDJ"` | **0** ✅ |
| 3 | MA60 全仓 | `Select-String -Pattern "ma60\|MA60"` | **0** ✅ |
| 4 | stockscan body 参数 | `Select-String -Pattern "body\."` | 4 条，仅 `plugin_id`/`plugin_name`/`params`/`min_amount`/`max_results` ✅ |
| 5 | signals 筛选参数 | 读 `signal.ts:17-31` | 仅 3 个，无 `asset_code` ✅ |
| 6 | auth 路由 | `Select-String -Pattern "\.(get|post)\("` | 仅 login + seed ✅ |
| 7 | kline fq 分支 | `Select-String -Pattern "fq"` | `fq==='raw'?'raw_kline_daily':'v_stock_qfq'` ✅ 无 hfq/bfq |
| 8 | NavLink | `Select-String -Pattern "NavLink"` | **0** ✅ |
| 9 | 前端测试文件 | `Get-ChildItem -Include *.test.*,*.spec.*` | **0** ✅ |
| 10 | trade_type CHECK | `Select-String -Pattern "trade_type IN"` | 3 处，均无 `'add'` ✅ |
| 11 | candidate_base_price 写入 | `Select-String -Pattern "candidate_base_price\|candidate_reason\|migrated_price_mode"` | 仅 DDL 3 行，**0 写入** ✅ |
| 12 | rel_type='hold' 写入 | `Select-String -Pattern "hold"` | 仅 DDL + `exDividendSync` 查询 + 无关 `HOLD` 方向 ✅ |
| 13 | metrics_json 写入 | 读 `signalService.ts` INSERT | 8 列，无 `metrics_json`/`is_final` ✅ |
| 14 | indicator 依赖 | 4 个 `package.json` grep `technicalindicators\|talib` + `node_modules` | **0** ✅ |


---

