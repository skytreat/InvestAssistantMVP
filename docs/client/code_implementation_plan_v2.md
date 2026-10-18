# 代码实施计划 v2（全栈 gap 闭合）

> **基线 commit**：`cba9556`（`fix(security): /api/auth/seed 可被任意请求注册管理员账号（P0）+ T41⑤ 备份恢复 + T48 smoke-m4`）
> **产出日期**：2026-10-17
> **取代**：`docs/audit/frontend-gap-audit-2026-10-16.md`（结论已失效，见 §2）、`docs/client/frontend_ux_v2.md`（部分结论已失效）
>
> ✅ **本文档自包含**：两份归档文档中**仍然有效**的内容已内联保全于 **附录 B-2**（Design Token 具体数值、按钮变体、全站内联颜色清单、a11y 明细、架构决策）。执行 T61-T79 **无需打开 `docs/archive/`**；archive 仅作审计历史留档。
>
> 📁 **`docs/HANDOVER.md` 已于 2026-10-17 归档**至 `docs/archive/HANDOVER_SUPERSEDED-2026-10-16.md`（内容停在 M3，且「239 tests / 行情层正常」已被本轮审计推翻）。该文件原本**无任何文档引用**，归档不产生断链。**接手本项目请以本文档为准。**
> **与前序关系**：本文档是 `MVP_code_implementation_plan.md`（T1-T48，已归档至 `docs/archive/`）的**后续增量计划**，任务编号从 **T49** 起延续，不重排、不作废已完成的 T1-T48。
> **决策归档**：已接受的技术决策、理由与代价记在 **`docs/adr/`**（8 份 ADR）。本文档只**引用**决策，不重复决策理由 —— 避免计划文档同时充当「计划」与「决策记录」。

**真相源优先级**（不变）：

| 序| 文档 | 定位 |
|----|------|------|
| 1 | `Requirements_simplified.md` | 业务规则权威（§4.2 In-Scope 14 项 / §5.1-5.5 / §10.1） |
| 2 | `PRD.md` | 体验权威（§5.1-5.9 交互 / §6.1-6.4 指标） |
| 3 | `SDD.md` | 工程权威（§2.12 前端架构 / §3.2 DDL / §4.4 API 清单 / §12.5 验收） |
| 4 | `AGENTS.md` | 架构硬约束（**本文档 §4 对其提出 1 处修订**） |
| 5 | 本文档 | 实施顺序 |

---

## 1. 审计方法与可信度声明

| 项 | 说明 |
|---|---|
| 方法 | 静态源码审计（**不依赖任何历史 audit 文档的结论**），全部结论均带 `文件:行号` 证据 |
| 覆盖 | `apps/frontend/src` 14 文件 3250 行 / `apps/backend/src` 29 文件 4798 行 / `packages/core` 5 文件 / `.github/workflows/ci.yml` / 根 `package.json` |
| 交叉验证 | 14 项关键结论用 `Select-String` 二次复核（见附录 B） |
| **未覆盖** | 未启动 dev server 做浏览器实测，未做真机部署验证。Canvas 绘制效果、响应式断点表现、PRD §6.3 性能指标（PE1-PE5）**未经实测**，计划内已排实测任务 |
| 动态审计 | ✅ **已完成两层**（API 41 端点 + 浏览器 52 项断言 / 三视口），见 §11。新增发现 **P0-10、P0-11、F-Q12、F-Q13、F-Q14** |
| **仍未覆盖** | ① 真机部署验证（systemd unit / Caddy HTTPS）；② PRD §6.3 性能 PE1-PE5 实测（需生产级数据规模）；③ 移动端真机触摸 |

---

## 2. 对 `frontend-gap-audit-2026-10-16.md` 的失效修正（重要）

该审计基线是 `559d671`。此后已合入 `6c2c8b6` / `8ab6e9d` / `1f99502` / `00a3349` / `501e56b` / `cba9556`，**其 16% 完成率结论已失效**。逐条修正：

| 旧审计结论 | 实际状态（`cba9556`） | 证据 |
|-----------|---------------------|------|
| 复盘页仅 50%，R1/R2/R6 缺失 | **已完成**：双口径 Tab + SVG 收益曲线 + 月/季/年切换 | `Review.tsx:95-148`（`YieldCurve`）、`:267-279`、`:286-294` |
| `/settings` 路由不存在 | **已存在**（266 行，含 schema 驱动参数编辑器 + 插件启停） | `App.tsx:29`、`Settings.tsx` |
| Admin A1 校验卡片、A2 手动触发行情 缺失 | **已完成**：12 卡片五色 + 详情 JSON 折叠 + `rerun-quotes` | `Admin.tsx:181-243` |
| G2 合规声明缺失 | **已完成**：琥珀色横幅常驻 Navbar | `_shared.tsx:67-70` |
| G3 响应式 0% | **部分完成**：`useIsMobile` + MobileTabBar + K 线副图 Tab + 画布自适应；**但仍 0 个 CSS 文件 / 0 条 media query**，桌面多列布局未做 | `_shared.tsx:6,83-139` |
| 第 1 波 T37+T39 后端 2 天 | **已闭合**（`501e56b` G1/G2） | `routes/assetStat.ts`、`routes/trade.ts:98-212` |
| 第 6 波 T40+T41 后端 1 天 | **后端已闭合**，**前端 3 个 API 从未被调用** | `routes/admin.ts:91,100,168,188` 全是死路由 |

**反向修正**：本次审计新查出 6 项旧审计**完全没有发现**的后端正确性缺陷 + 2 项 P0 级合规缺失（见 §3.1、§3.2）。

---

## 3. Gap 清单

优先级：**P0** = 阻塞 MVP 验收 / 数据正确性；**P1** = PRD §5 明文要求但未实现；**P2** = 体验与工程质量。

### 3.1 P0 — 后端正确性缺陷（11 项 + 1 项方法论）

| # | Gap | 违反 | 证据 | 影响 |
|---|-----|------|------|------|
| **P0-1** | **加仓（`add`）交易类型完全不存在**。DDL CHECK 白名单是 `('buy','sell','reduce','clear','dividend','bonus','transfer')`，用 `sell` 顶掉了「加仓」 | Requirements §5.1 明文 7 种类型含**加仓** | `configStore.ts:26`（3 处 CHECK） | 7 种类型只落地 6 种。`exDividendSync.ts:61-64` 有 `add` 分支但 `add` 不是合法值 → **死分支**，持仓前数量算错会让除权分红金额算错。✅ **DEC-2 已定**：白名单改 7 种，移除 `sell`、加入 `add`（T49） |
| **P0-2** | **候选池基准价从未固化**。`candidate_base_price` / `candidate_reason` / `migrated_price_mode` 3 列在 DDL 里定义，**全仓无任何 INSERT/UPDATE** | Requirements §4.2 #8「基准价固化」；PRD S4「加入日收盘价固化」；SDD §4.4 `/api/candidate`「基准价自动取当日收盘价」 | `configStore.ts:58,59,62`（仅 DDL）；`routes/watch.ts:29-46` body 只收 `asset_code` | 候选池**没有基准价**，「跟踪有基准」核心价值不成立；PRD S5 迁移选 base/current 也无从选择 |
| **P0-3** | **黄金测试数据集完全缺失**。`packages/core/tests/fixtures/golden/` 只有 `README.txt`，README 自述「golden 数据集 Phase 1 之后生成」，Phase 1 早已完成 | AGENTS.md §编码输出约定 6「双端算法必须复用同一套golden数据断言，保证双端计算误差=0」 | 目录内 0 个 `.json`（全仓 `*.json` 仅 8 个，全是 `package.json`/`tsconfig.json`） | **跨端口径一致性零保障**。DEC-1 后一致性主保障升级为「同库同版本锁定」，但 golden 仍是**防库升级 / 防适配层改错**的唯一回归网，必须落地（归入 T51） |
| **P0-4** | **前端零测试**。无 `test` script、无 vitest/jsdom/testing-library，根 `npm test` 不覆盖 frontend，CI 也不跑 | AGENTS.md §5「核心逻辑必须编写单元测试，Vitest 5.x」；SDD §12.5 F5 要求 `frontend.test.tsx → kline_render` | `apps/frontend/package.json` 无 test script；`*.test.*` 计数 = 0 | 双口径切换、收益曲线、donut 计算、Canvas 绘制、移动端断点 —— 全部 UI 行为零回归保护 |
| **P0-5** | **`GET /api/signals` 无 `asset_code` 过滤**。K 线图信号 overlay 只能拉 top-20 全量再前端按日期匹配 | PRD §5.2 策略信号标记；§3.1-A 建议 A（持仓卡直显信号） | `routes/signal.ts:17-31`（仅 `trade_date`/`plugin_id`/`direction`） | 持仓 10+ 只时 K 线 overlay 会漏标；`routes/kline.ts` 内嵌的 `signals` 还返回**倒序**而 klines 是**升序**，映射脆 |
| **P0-6** | **`metrics_json` / `is_final` 从不写入**。`persistSignals` 的 INSERT 只有 8 列 | Requirements §5.5「指标明细（可选，数值键值对）」；PRD §5.2 信号 hover 显示「指标明细」 | `services/signalService.ts`（两处 INSERT 均无该2 列） | K 线信号 hover 无明细可展示；插件 `params`（`pluginEngine.ts:112` 已产出）数据落地丢失 |
| **P0-9** 🔴 | **DuckDB 连接泄漏 → 后端自锁死行情库**（**动态审计发现，静态审计漏判**）。`queryDuckDB()` 每次 `DuckDBInstance.create(path)` 新建连接，注释声称「不常驻连接 → 交给 GC 回收」，但**从不 `closeSync()`**。首个查询成功后文件锁被**同进程**持有 | AGENTS.md「DuckDB 行情层硬约束」第 3 条：**「DuckDB 按需打开关闭，不常驻连接（文件锁机制，多进程不能同时写）」** —— 「打开」做了，「关闭」没做 | `db/duckdb.ts:52-70`（`queryDuckDB`）、`:29-48`（`duckdbHealthCheck`，同样泄漏） | **实测后果**：后端启动后第一次行情查询成功，**之后所有 DuckDB 端点永久 500/502** —— `/api/market/latest` 502、`/api/kline/:symbol`（含 4 种 fq 全试）500 `KLINE_QUERY_FAILED`、`/api/symbols/search` 500 `SEARCH_FAILED`、`/api/stockscan` 无法执行。实测错误：`IO Error: Cannot open file ".../quotes.duckdb": File is already open in node.exe (PID <后端自身>)`。直接验证：同文件用 `@duckdb/node-api` 独立进程可正常打开，16 张表/视图齐全 → **不是数据问题，是代码缺陷**。✅ **已修复（T80）** |
| **P0-10** ✅**已修** | **股票 K 线 100% 返回 500：DuckDB `BIGINT` → JS `BigInt` 无法 JSON 序列化**（**动态审计发现；且被 P0-9 长期掩盖**）。`v_stock_qfq.volume` 列类型为 `BIGINT`，`@duckdb/node-api` 返回 JS `BigInt`，Fastify `JSON.stringify` 抛错 | PRD §5.2 K 线图（股票是主资产类别）；AGENTS.md「错误处理：不允许顶层裸 throw 泄露内部细节」 | `routes/kline.ts:40-117`（SELECT 含 `volume`，直接透传给前端）；`db/duckdb.ts` 的 `queryDuckDB` | **原始实测**：`sh600519` / `sz000001` 全部 `500 "Do not know how to serialize a BigInt"`；ETF/指数返回 200（但 klines 为空，见 F-K10）。**✅ 已在 `db/duckdb.ts` 的 `normalizeValue()` 统一修复**（T80 同批） |
| **P0-12** ✅**已修** | **DuckDB 并发互抢：并发行情查询互相抢文件锁**（**T80 回归测试用例抓出**）。`DuckDBInstance.create()` 是**排他**的，每次查询都新建 instance 时，并发查询会互相抢锁，第 2~N 个报「另一个程序正在使用此文件」。真实现 Dashboard 首屏就并发打 `/positions` + `/asset-stat/latest` + `/signals` + `/system-log` | PRD §6.3 PE4（API p99 ≤ 200ms）；AGENTS.md「DuckDB 按需打开关闭」 | `db/duckdb.ts`（原实现每次 `DuckDBInstance.create()`） | **原始实测**：5 路并发 → 1 成功 4 失败（`File is already open in`）。**✅ 已修为「instance 进程内单例（挂 `globalThis`）+ 每个并发分支独立 connection」**。挂 `globalThis` 而非模块变量的原因：vitest 每测试文件是独立 module graph，模块变量不共享会导致全量跑时跨文件互抢（单跑通过、全量失败）。**实测：单 instance + 多 connection 并发读全部成功**（5 路返回一致结果） |
| **P0-13** 🔴 | **持仓充足性校验用「全日期累计总量」而非「卖出发生当天的持仓」，日期交错时可写入超卖**（**动态审计 + 运行时复现发现**）。`validateSufficientHolding` 调 `calcPosition`，后者按 `trade_date ASC, id ASC` 回放**全部已写入**记录，返回的是「所有日期加总的总量」；校验式 `totalQuantity >= sellQty` 因此会用**未来的买入**去支撑**过去的卖出**。叠加 core 层无防护：`calculateMovingWeightedCost` 的 sell 分支只挡 `totalQuantity <= 0`（完全空仓），不检查单笔是否超持仓，`totalQuantity` 与 `totalCostBasis` 均可变负 | Requirements §5.2「**减仓数量不得超过当前实际持仓 → 服务端拒绝保存**」；AGENTS.md 安全编码约束第 2 条；需求原文「交易永久留痕，负持仓脏数据一旦写入将永久污染聚合结果」 | `services/positionCalculator.ts:72-76`（`validateSufficientHolding`）、`:39-53`（`calcPosition`）；`packages/core/src/movingWeightedCost.ts:43-50`（sell 分支无超卖防护） | **精确成因**（以库中真实数据说明，`sh600000` 在 id=7 写入前有 id=1 `2026-10-16 buy 100` 与 id=5 `2026-08-01 buy 100`）：<br>① 校验回放 → `08-01 buy100 =100` → `10-16 buy100 =200`，返回 **200**，`200 >= 105` **通过**<br>② 但该卖出发生在 `08-06`，此刻 `10-16` 的买入**尚未发生**，真实持仓只有 **100**<br>③ 写入后回放 → `08-01 buy100=100` → `08-06 sell105=**-5**` → `10-16 buy100=95`，**负持仓已落库**<br>**拦截并非完全失效**（实测）：空仓卖 500 → ✅400 拒绝；`reduce 99999` → ✅400 拒绝。仅当**多笔买入日期交错**时才绕过（单笔买入时校验值恰好等于时点持仓）<br>**库中已有 2 笔此类脏数据**：id=7（`08-06 sell 105` > 当时持仓 100）、id=13（`08-21 sell 120` > 当时持仓 110）<br>**危害**：`totalCostBasis` 变负会污染 `avgCost`，进而污染持仓卡、双口径收益率、复盘胜率/盈亏比全部下游计算 |
| **P0-14** ⚠️**审计方法论缺陷** | **我在追查 P0-13 时连续 4 次给出错误描述**（① 判「不是 bug」→ ② 判「日期回放可绕过」→ ③ 判「单笔卖出永远不会被拦截」→ ④ 向用户解释时仍用错的口径），每次都基于推测而非读代码。读到 `movingWeightedCost.ts:43-50` + 用库中真实数据逐步回放后才确认 | AGENTS.md「关键逻辑给出单测示例」；本项目根本问题是**缺少能暴露此类缺陷的测试** | 审计过程记录见 §11.8 | **教训**：① 静态审计与运行时验证都不可省略；② 对「数值异常」类问题必须**先读实现 + 用真实数据逐步回放**，再看数据；③ **描述一个缺陷时必须区分「完全失效」与「特定条件下失效」** —— 我曾把「特定条件下绕过」夸大成「永远不被拦截」，若用户据此决策会误判严重性 |
| **F-K10** ⚠️**动态新发现** | **ETF / 指数 K 线恒返回空**（**不是本次引入的回归**） | SDD §3.3 明确要求「按 `raw_symbol_class.class` 路由：stock → `v_stock_*`，etf → `v_etf_*`」；PRD §5.2 未排除 ETF | `routes/kline.ts:44`：`const table = fq === 'raw' ? 'raw_kline_daily' : 'v_stock_qfq';` —— **硬编码 v_stock_qfq，从不路由到 v_etf_*** | ETF 在 `v_stock_qfq` 中 0 行 → `klines: []`。**首次动态审计时我误判为「ETF 正常」**（只看了 HTTP 200 与响应字段结构，没看 `klines` 是否为空）—— 本次审计第 6 次「只看状态码不看数据」。**修复归属 T53**（fq 四值 + ETF 视图路由打包在一起）。⚠️ 实测确认 ETF 视图本身有数据，故这是路由 bug 不是数据缺失 |
| **P0-11** 🔴 | **「全市场条件选股」无任何可用插件，功能实际不可用**（**动态审计发现**）。`GET /api/stockscan/plugins` 返回 2 个插件，但**两者 `category` 均为 `monitor`**，且 `paramSchema` 中 `symbol` 为 `required:true` | Requirements §4.2 #7「全市场条件选股」；PRD §5.6；SDD §5.3 插件接口契约要求区分 `monitor`/`filter` 两类 | `services/pluginEngine.ts`（`builtinPlugins` 仅 `rsi_oversold`/`macd_cross` 两个 monitor 插件）；`routes/stockscan.ts:78-83` 按 `plugin_id`/`plugin_name` 找插件但不校验 category | **实测**：`POST /api/stockscan` 返回 200 但 `{"totalCandidates":0,"total":0,"results":[]}` —— 无候选池可扫。即使 T55 补齐公共过滤、T56 补齐批量入池，**没有 filter 类插件仍然扫不出任何东西**。这是 Requirements §4.2 #7 的**功能性缺失**，不只是 UI/接口缺失 |

### 3.2 P0 — 后端功能缺失（2 项）

| # | Gap | 违反 | 证据 |
|---|-----|------|------|
| **P0-7** | **`POST /api/auth/register` 不存在**。建号只能走 `/api/auth/seed`，且 `cba9556` 已把 seed 锁死为「已有任何用户即 403」 | SDD §4.4；PRD D5「首个注册用户自动成为管理员」 | `routes/auth.ts:16,40`（仅 login + seed）；`:66-73` 管理员存在即 403 |
| **P0-8** | **`POST /api/auth/refresh` 不存在**。access token 7d 硬过期，store 里无 refresh token；401 处理器 `window.location.href='/login'` 而 **`/login` 路由不存在** → 整页刷新 | SDD §4.4「refresh（30d）」；PRD §5.9「支持刷新自动续期」+「过期后自动跳转登录页并保留当前页面路径」 | `routes/auth.ts`；`apps/frontend/src/App.tsx:22-32` 无 login 路由；`api/client.ts:15-23` |

> ⚠️ P0-7 与 `cba9556` 的安全加固直接冲突：该 commit 把 `/api/auth/seed` 改成 public + 首用户锁定。正确解法是**新增 register 路由**（首用户自动 admin，后续注册强制 user 或仅 admin 可建号），**不是**回退 seed 的加固。

### 3.3 P1 — PRD §5 明文要求但未实现（前端，26 项）

**§5.3 Dashboard（6）**

> ✅ **动态审计修正（2026-10-17）**：D1 的「双口径切换」、D2 的「资产组成图」**已存在**，初稿误列为缺失。浏览器 DOM 实测：按钮文字为「价格口径/实际口径」（**不是**初稿假设的「价格收益率/实际收益率」），资产组成为 `conic-gradient` div（**不是** `<svg>`）。下表已按实际修正。

| # | Gap | 证据 |
|---|-----|------|
| F-D1 | **「总资产」大字显示的语义错误**：标签写「总资产」但取值为 `posSummary?.totalCostBasis`（**持仓总成本**），应为 `totalMarketValue`；`stat.total_assets_price_yield`/`total_assets_actual_yield` **声明了但从不渲染** | `Dashboard.tsx:241`（`fmt(posSummary?.totalCostBasis)`）+ `:243` 标签「总资产」；声明于 `:20-21`。⚠️ **动态无法验证数值** —— 实测该卡显示「暂无资产快照（每日 17:02 信号生成后自动写入）」，`asset_stat` 表为空（cron 未跑）。属**数据语义 bug**，非功能缺失 |
| F-D2 | 持仓仍是 `<table>`，PRD §5.3 要求「持仓**卡片列表**」 | `Dashboard.tsx:304-342`；✅ 动态确认 `tables=3`、`th` 为 9 列 |
| F-D3 | 仓位占比**只有文字无进度条** | `Dashboard.tsx:314,335`；✅ 动态实测进度条元素数 = **0** |
| F-D4 | 持仓行无【买入】【卖出】快捷按钮 → 交易录入弹窗 | `Dashboard.tsx:319-340` 全是 `<td>`；✅ 动态实测「买入/卖出」按钮数 = **0**（整个 Dashboard 无任何含此二字的按钮） |
| F-D5 | 无排序（盈亏/收益率/仓位占比）、无过滤（标的类型/行业） | ✅ 动态实测排序控件 = **false**；`Dashboard.tsx` 无任何 `onClick` handler |
| F-D6 | 资产组成图**已存在**（`conic-gradient` donut，股票/ETF 两段），但**无「点击下钻过滤持仓列表」** | `Dashboard.tsx:93-117`；✅ 动态实测 `conic-gradient` 元素 = 1 |

**§5.4 TradeInput（6）**

| # | Gap | 证据 |
|---|-----|------|
| F-T1 | 交易类型是 `<select>` 下拉，PRD §5.4 要求「顶部 **Tab** 切换：买入/加仓/减仓/清仓/除权补充」 | `TradeInput.tsx:249-262` |
| F-T2 | `trade_reason` 无 `required`、无前端阻止；提交时 `trim() \|\| undefined` 送后端吃 400 | `TradeInput.tsx:212,312-321` |
| F-T3 | 无实时预估新均价（只在提交**后**显示 `result.position.avgCost`） | `TradeInput.tsx:332`；全文无 `useMemo` |
| F-T4 | 减仓超持仓无红色禁用（`GET /api/positions/:asset_code` 已存在却从不调用） | `TradeInput.tsx` 无该调用 |
| F-T5 | 无「除权补充」独立入口，无理由自动固化置灰 | 后端 `trade.ts:45-46` 已自动填，前端零实现 |
| F-T6 | 无 PRD §5.4「预设标签按钮（策略触发/止损/抄底）」快捷填充 | `TradeInput.tsx:314-320` 纯文本框 |

**§5.5 Review（2）**

> ✅ **动态审计修正（2026-10-17）**：R1「双口径切换」**已存在**（初稿误列）。R6「4 色标签」为**彩色文字非 pill**（初稿判断成立）。R2「收益曲线」的容器与周期切换**已存在**，当前因无快照数据而走空态。

| # | Gap | 证据 |
|---|-----|------|
| F-R1 | 无日期范围筛选（后端 `start_date`/`end_date` 已支持） | `Review.tsx` 无 date input；✅ 动态实测 `input[type=date]` = **0** |
| F-R2 | 标签是彩色文字非 pill/badge | ✅ 动态实测：标签以 `<td>` 彩色文字呈现，`span[style*=borderRadius]` 数 = **0**（无 pill 组件）。另 `transfer` 在 Review 标「转增」、TradeInput 标「转托管」——**分类法不一致**（`Review.tsx:49` vs `TradeInput.tsx:22`） |

> 🐛 **附带缺陷**：`Review.tsx:155` 的 `page` state **从不 `setPage`**，`fetchTrades(page±1)` 后「第 N/M 页」永不推进。`Review.tsx:428,430`

**§5.1+§5.2 Kline（8）**

| # | Gap | 证据 |
|---|-----|------|
| F-K1 | fq 只有 前复权/不复权，缺**后复权**（`v_stock_hfq` 在 `marketData.ts:10-17` 已映射但路由挡掉） | `routes/kline.ts:44` `fq==='raw'?'raw_kline_daily':'v_stock_qfq'`；✅ **动态实测选项为 `前复权\|不复权`**，确认无后复权 |
| F-K2 | **MA60 缺失**（PRD §5.2 明确 MA(5/10/20/60)） | 全仓 `ma60` 命中 = 0；✅ 动态实测页面无「MA60」字样 |
| F-K3 | MA 不可隐藏（无开关） | `Kline.tsx:138-140` 硬编码 |
| F-K4 | **KDJ 全栈不存在**（后端 + core + 前端全无） | 全仓 `kdj` 命中 = 0；✅ 动态实测无「KDJ」字样 |
| F-K5 | 桌面端副图不可切换（只有移动端有 Tab） | `Kline.tsx:421-453` |
| F-K6 | 无十字光标 + OHLCV 悬浮窗（PRD §5.2 明文） | ✅ **动态实测 `canvas=3` 但带 mouse handler 的 = 0** —— Canvas 完全无鼠标事件 |
| F-K7 | 无周 K / 月 K（PRD §5.2「日/周/月，周月基于日线聚合」） | ✅ 动态实测周期选项仅 `近60日\|近120日\|近1年\|近500日` |
| F-K8 | 信号标记无 hover tooltip（方向+强度+指标明细） | `Kline.tsx:154-173` 只画三角 |
| **F-K9** ⚠️**动态新增** | **股票 K 线整体不可用**，且错误提示无意义 | P0-10：`sh600519`/`sz000001` → `500 "Do not know how to serialize a BigInt"`，页面原样显示「请求失败: Do not know how to serialize a BigInt」。ETF/指数正常 |

> 🐛 **附带缺陷**：`Kline.tsx:354-358` 每次依赖变化都重新注册 resize 监听（监听器泄漏）；无 `ResizeObserver`，容器尺寸变化（侧栏折叠）不重绘。

**§5.6 StockScan（5）**

| # | Gap | 证据 |
|---|-----|------|
| F-S1 | 公共过滤缺 标的类型/排除ST/行业（**前后端双缺**，`routes/stockscan.ts:86-88` 只收 `min_amount`） | 同上 |
| F-S2 | 参数输入是裸 JSON textarea。**`Settings.tsx:144-189` 已有完整 schema 驱动渲染器未复用** | `StockScan.tsx:251-260` |
| F-S3 | 「结果 ≤100」未强制，UI 允许到 **500**（违反 PRD §5.6） | `StockScan.tsx:245,247` |
| F-S4 | 无批量加入候选池（无 checkbox / 全选 / 批量按钮）；后端也无批量接口 | `StockScan.tsx:342-355` 仅逐行 |
| F-S5 | 结果表缺 名称/现价/涨跌幅/成交额 + 无分页（PRD §5.6 明文） | `StockScan.tsx:315-322` |

> 🐛 **附带缺陷**：`StockScan.tsx:77-80` 在**成功分支**判 `res.status===409`，但 axios 对 409 走 reject → 重复加入候选池显示「加入候选失败」而非「已在候选池」。

**§5.7 Admin（3）**

| # | Gap | 证据 |
|---|-----|------|
| F-A1 | system_log 无日期过滤、无类型过滤（后端 `log_type`/`level`/`trade_date` 已支持，从未传） | `Admin.tsx` 全文无筛选控件 |
| F-A2 | **备份列表 + 恢复 UI 完全缺失**。`GET /api/admin/backups`、`POST .../restore` 是死路由 | `Admin.tsx` 从不调用 |
| F-A3 | **角色管理 UI 完全缺失**。`GET /api/admin/users`、`PATCH .../role` 是死路由 | 同上 |

> 🐛 `Admin.tsx:140` 用**阻塞式 `alert()`** 反馈备份结果。

**§5.8 全局（4）**

| # | Gap | 证据 |
|---|-----|------|
| F-G1 | **无当前页高亮**（`NavLink`/`useLocation` 全仓命中 = 0），用户不知身在何处 | `_shared.tsx:59` 纯 `<Link>` |
| F-G2 | **桌面端左侧导航栏缺失**（PRD §5.8 #7：持仓/K线/选股/复盘/**候选池**/设置）；现有顶栏也缺候选池入口 | `_shared.tsx:17-26` |
| F-G3 | **候选池页 `/candidates` 完全不存在**。后端 `GET /api/candidate`、`GET /api/watch`、`DELETE /:asset` 全是死路由 | `App.tsx:22-32` 无路由 |
| F-G4 | 错误提示不友好：仅 `HOLDING_INSUFFICIENT` 映射中文，`TRADE_REASON_REQUIRED`/`FORBIDDEN`/`INVALID_SYMBOL`/`CONFIRM_REQUIRED` 全部裸码（违反 PRD §5.8 #9） | `TradeInput.tsx:221-233` |

### 3.4 P1 — 无障碍（PRD §5.8 #10，8 项）

| # | Gap | 证据 |
|---|-----|------|
| F-A11 | 零 `:focus-visible` 样式，键盘导航无视觉反馈（全仓 `focus-visible`/`outline` 仅 1 处，是 Admin 选中卡高亮） | `_shared.tsx` 无 |
| F-A12 | `<label>` 无 `htmlFor`，input 无 `id`（全页） | `TradeInput.tsx:245-246`、`Review.tsx:331-337` |
| F-A13 | `<th>` 无 `scope` | `_shared.tsx:196-201` |
| F-A14 | 零 `aria-*`：无 `aria-live`（异步结果）、无 `aria-expanded`（Admin 卡片/Settings 折叠）、无 `role="dialog"`（Review 弹窗）、无 `aria-current`（导航） | 全仓命中 = 0 |
| F-A15 | Review 弹窗无焦点锁定、无 ESC 关闭 | `Review.tsx:437` |
| F-A16 | 语义标签缺失：无 `<header>`/`<main>`/`<footer>`/`<section>` | 仅 2 个 `<nav>` |
| F-A17 | 零 Loading spinner / skeleton（全仓 `spinner`/`keyframes`/`animate` = 0），12 处纯文字「加载中...」 | 各页 |
| F-A18 | Loading/Empty 态未组件化，散落各页硬编码 | 各页 |

### 3.5 P2 — 工程质量（14 项）

| # | Gap | 证据 |
|---|-----|------|
| F-Q1 | **无 Design Token 层**。14+ 个 raw hex 跨页重复（`#2563eb` ×14、`#6b7280` ×25）；`borderRadius` 4/6/8/10 混用；`maxWidth:1200` 在 `App.tsx:19` 和 `_shared.tsx:146` 重复 | 全前端 |
| F-Q2 | **零 CSS 文件**（inline style 全覆盖），导致 `@media` 无法表达，只能 JS 判宽（`_shared.tsx:80-82` 注释自承） | 全前端 |
| F-Q3 | `types.ts` 69 行**死代码**（0 引用）；各页重复声明本地类型且已漂移 | `types.ts` |
| F-Q4 | ~25 处 `any`，且**全仓无 ESLint/Prettier 配置**（AGENTS.md §编码约束 6 要求遵循 `.eslintrc`/`.prettierrc` —— 文件不存在） | 全前端 |
| F-Q5 | 死代码：`TradeInput.tsx:106-107` `hasPrefix`/`displayName` 两分支完全相同；`_shared.tsx:142,153` 两个导出 0 引用 | 同左 |
| F-Q6 | 无路由级代码分割（SDD §2.12.5 要求 KLinePage/AdminPage `React.lazy`） | `App.tsx:22-32` |
| F-Q7 | `@fastify/jwt` 已安装但**全仓 0 引用**（自研 HS256 手写 JWT） | `apps/backend/package.json` |
| F-Q8 | `calcAllPositions` 对 SQLite **N+1**（N 次全量 replay），持仓 30 只 → 每请求 30 次全表扫描。PE4 要求 p99 ≤200ms | `services/positionCalculator.ts:59-66` |
| F-Q9 | `rel_type='hold'` **从无任何路由写入**；`exDividendSync.ts:139-141` 查它再靠 `:150-155` 兜底扫交易表 | `configStore.ts:56` 仅 DDL |
| F-Q10 | `/api/positions` 与 SDD §4.4 及历史文档的 `/api/holding`、`/api/trades/positions` 三处命名不一致 | `routes/trade.ts:234` |
| F-Q11 | **后端测试存在顺序依赖/污染：全量跑与单跑结果不一致**（**T80 验证时发现**）。`validator.test.ts` 的「TUSHARE_TOKEN 未设置 → C11 结果 SKIP」用例**单独跑通过、全量跑失败** —— 已 `git stash` 掉本次改动复现，确认与 duckdb.ts 无关，是既有问题。疑似有其它测试设置了 `process.env.TUSHARE_TOKEN` 后未还原 | `tests/unit/validator.test.ts`（C11 SKIP 条件用例）；`tests/setup.ts` 只在 `!(key in process.env)` 时注入，**不会覆盖也不会清理**已存在的值 | CI 里是全量跑，所以这条用例在 CI 上大概率一直红/靠顺序侥幸通过；掩盖真实回归 |
| **F-Q13** | **失效 token 的 401 处理会导致「登录页不存在 + 整页刷新 + 丢路径」**（**动态审计发现**）。`api/client.ts:17-22` 的 401 分支执行 `logout()` + `window.location.href = '/login'`，但 **`/login` 路由不存在** —— `App.tsx:22-32` 的 `*` 兜底重定向到 `/`，而 `/` 因 `App.tsx:15-16` `if (!token) return <Login />` 又渲染登录组件。净效果：整页刷新而非 SPA 路由跳转，**且原始路径丢失** | `api/client.ts:17-22`、`App.tsx:15-16`、`App.tsx:22-32` | 实测 B6：注入坏 token 后能弹回登录框（功能上没死循环，因为 logout 已清 token），但走的是**浏览器整页刷新**。违反 PRD §5.9「过期后自动跳转登录页并**保留当前页面路径**（登录后可返回原页面）」。另缺 `_retry` 幂等标志，并发 401 会多次触发跳转。**注：T57（refresh token）+ T64（真实 `/login` 路由 + 保留路径）是本项的前置** |
| **F-Q14** | **Dashboard / Admin 把正常业务数值渲染成红色**（**动态审计发现，我的断言也曾因此误报**）。扫描 `[style*=dc2626]` 命中的是**持仓盈亏数字**（`-29.70`、`-3.30%`）与**校验状态词**（`ERROR`），并非错误提示 | `Dashboard.tsx` 持仓表浮动盈亏列的红色；`Admin.tsx` `RESULT_COLOR`（`:19-21`） | 语义混淆：用户在 a11y 上无法区分「这是错误消息」与「这是亏损数值」。本项由我自己的 B3 断言误报暴露 —— 说明**用颜色选择器判断语义本身不可靠**，已在 §11.0 记录方法论 |
| **F-Q12** ⚠️**动态新增** | **响应式横向溢出**（违反 PRD §5.8 #1「全站响应式，桌面和手机功能对等」）—— 浏览器动态实测 `documentElement.scrollWidth − clientWidth`：

| 视口 | dashboard | trade | review | kline | stockscan | admin |
|---|---|---|---|---|---|---|
| **手机 375** | **+163px** | 0 | **+250px** | 0 | **+39px** | **+416px** |
| **平板 768** | 0 | 0 | 0 | 0 | 0 | **+23px** |
| 桌面 1440 | 0 | 0 | 0 | 0 | 0 | 0 |

6 个页面中 **4 个在手机视口溢出**，最严重 Admin 溢出 **416px**（表格 `min-width` 所致）；平板下 Admin 仍溢出 23px。根因叠加 F-Q2（零 CSS 文件 → 无 media query 能力）+ 固定 `maxWidth:1200` 双份硬编码 |

---

## 4. 架构决策 ADR-001：**已决议** —— 前后端统一用 `fast-technical-indicators`

> **决议日期**：2026-10-17。**决策人**：项目所有者。**状态**：✅ 已锁定，`T71` 解锁。

### 4.1 原始冲突（保留存档）

| 来源 | 原文 | 倾向 |
|------|------|------|
| `AGENTS.md` §3 | 「apps/frontend 禁止直接 import packages/core——前后端通过 HTTP API 通信，算法口径一致性靠 golden 数据集在 CI 里验证」 | 后端算 |
| `PRD.md` §5.2 | 「参数实时生效：改 RSI period 或超买阈值 → 图表即时重绘，**零网络请求**」 | 前端算 |
| `PRD.md` §6.3 | 「策略参数调整后重绘 ≤ 300ms，**客户端计算**」 | 前端算 |
| `Requirements` §5.5 | 「指标计算位置：前端 K 线图 / 用户改参数时**实时计算**」 | 前端算 |
| `M3-audit-report.md` §7 | 「F8 属**有意偏离**，非缺陷」 | 回避 |

**决议落地方式**：不放开「前端 import core」，而是让**前端和后端各自直接依赖同一个第三方指标库 `fast-technical-indicators`**。

```
packages/core  ──依赖──> fast-technical-indicators@1.1.6 (pinned)
apps/backend   ──依赖──> @invest/core（core 的适配层）
apps/frontend  ──依赖──> fast-technical-indicators@1.1.6 (pinned，同版本)
```

**这个方案意外地同时解决了三方冲突**：
- ✅ 前端本地算指标 → 满足 PRD §5.2「零网络请求」+ §6.3「≤300ms」
- ✅ 前端**不 import core** → AGENTS.md §3 的禁令**原文保持有效，无需修订**
- ✅ 前后端同一库同一版本 → 口径一致性由**版本锁定**保证，比「靠 golden 数据集事后校验」更强；golden 数据集降级为**回归网**（防库升级 / 防适配层改错），不再是一致性的唯一保障

### 4.2 库选型实测结论（2026-10-17 探测，非推测）

| 项 | 实测结果 |
|---|---|
| 包名/版本 | `fast-technical-indicators@1.1.6`，MIT，**零依赖** |
| 维护活跃度 | 最后发布 **2026-08-24**（对比 `technicalindicators@3.1.0` 停在 **2022-01-26**，已停更）→ **选它而非 SDD §2.6 原推荐的 `technicalindicators`** |
| 导出符号 | **221 个**，含 `RSI` `MACD` `SMA` `EMA` `WMA` `BollingerBands` `Highest` `Lowest` `Stochastic` `VolumeProfile` `getAvailableIndicators` |
| **`KDJ`** | **❌ 不在 221 个导出里**。库的 `Stochastic` 是美式随机指标，**与 A 股 KDJ 口径不同**（实测 K=78.58/D=76.05 vs A股 KDJ K=72.05/D=65.24）→ **KDJ 必须手写**，见 §4.3 |

### 4.3 迁移期差异：库与现有手写实现的实测对比

> ⚠️ **重要澄清（2026-10-17 修正）**：本节初稿把下面两点称为「陷阱」，措辞有误 —— 它们**不影响前后端一致性**。既然 core 与 frontend 都用同一个库同一个版本，一致性由版本锁定保证。下面两项是另外两件事：**（a）产品口径正确性**、**（b）迁移导致的行为变更**。

用同一确定性序列实测 `packages/core` 现有手写实现 vs `fast-technical-indicators`：

| 指标 | core 手写 | 库 | 性质 |
|---|---|---|---|
| **RSI** | `52.5658, 56.8962, 61.6476` | `52.57, 56.90, 61.65` | ✅ **数值一致**。500 根实测最大绝对偏差 `4.99e-3`（bar 181），其余位为 0 |
| **MACD DIF** | `4.2888` | `4.2556` | ⚠️ **EMA 播种不同**导致 warm-up 瞬态，见 §4.3.1 |
| **MACD 柱** | `-3.0360`（= `2×(DIF−DEA)`） | `-1.5019`（= `DIF−DEA`） | 🔴 **美式 vs A 股约定差异**，见 §4.3.2 |

#### 4.3.1 EMA 播种差异 = warm-up 瞬态，会收敛（**非风险，仅需一次性核对**）

core 用**首值**播种 EMA，库用**前 N 期 SMA** 播种。相对偏差随 bar 指数衰减（实测 500 根缓变日线序列）：

| bar index | 40 | 60 | 80 | 120 | 200 | 300+ |
|---|---|---|---|---|---|---|
| DIF 相对偏差 | 7.77% | 1.50% | 0.43% | **0.024%** | **0.000%** | 0.000% |

**含义**：
- K 线图展示 120-500 根 → 差异在 bar 150 之后完全不可见，**无需任何处理**
- 但 `macd_cross` 插件检测的正是 DIF/DEA 零轴附近的**穿越**，边界 case 可能因此改变**触发日期**（实测在 warm-up 区会出现 core 有、库无的穿越）。这是**数据语义变更**，不是代码不一致
- → **一次性动作**：迁移前用真实行情回放一遍 `executeAllPlugins`，比对 `user_strategy_signal` 中已持久化 MACD 信号的 `trade_date` 是否漂移；有差异则归档到 `docs/adr/` 记为「口径变更」并接受，**不阻塞迁移**

#### 4.3.2 MACD 柱 ×2 = 约定差异，**库需要被修正**（产品正确性）

实测确认库的 `histogram === DIF − signal`（`true`，全部样本）。而 **A 股通达信标准是 `MACD : 2*(DIF-DEA), COLORSTICK`**（已核对通达信公式原文与多方资料），核心是取「均线的均线的均线差」。

| | 约定 | 公式 |
|---|---|---|
| A 股（通达信/东财/同花顺） | `BAR` | `2 × (DIF − DEA)` |
| 库（`technicalindicators` 兼容 = 美式 Wilder） | `histogram` | `DIF − DEA` |

**core 现在的 `2×(DIF−DEA)` 是对的，库是「美式」的。** 所以这**不是「保持旧行为」，而是「把库修正到 A 股口径」** —— 本产品是 A 股工具，必须用 A 股约定。

#### 4.3.3 数组长度 = 形状契约，与一致性和 MACD 都无关

库的 `RSI.calculate()` / `MACD.calculate()` 返回**尾部对齐的短数组**（500 根 → 476 个值，offset 25），core 返回**全长数组**（不足处填 50）。

原因纯属 API 风格差异，与算法无关。而 `Kline.tsx` 用同一 index 索引 `klines` 与 `indicators`，`routes/kline.ts` 又把 `indicators` 直接透传给前端 —— 所以**必须有 somewhere 把数组补齐**，否则整条指标线错位。

#### 4.3.4 结论：适配层只做两行形状/约定变换，**不计算 MACD**

```ts
// packages/core/src/indicators/adapters.ts
import { MACD, RSI, SMA } from 'fast-technical-indicators';

export function calculateMACD(closes, fast = 12, slow = 26, signal = 9): MACDResult {
  const r = MACD.calculate({ values: closes, fastPeriod: fast, slowPeriod: slow, signalPeriod: signal });
  const pad = closes.length - r.length;                      // ← §4.3.3 补齐
  return {
    dif:  padFill(r.map(o => o.MACD), pad),
    dea:  padFill(r.map(o => o.signal), pad),
    macd: padFill(r.map(o => o.histogram * 2), pad),         // ← §4.3.2 A 股约定 ×2
  };
}
```

**core 不自己算 EMA/DIF/DEA —— 全部由库算。** 适配层只做：① 数组补齐 ② 柱值 ×2。**没有任何 MACD 算法实现。**

> **所以「core 不应该有额外代码计算 MACD 和数组长度」这个直觉是对的**：它确实**不算 MACD**。但数组补齐这 5 行是**无法回避**的（前端要按下标对齐 K 线），且它属于**形状适配**而非算法。至于 ×2，那是**把库从美式约定修正到 A 股约定**的一次性常数变换。

**因此 DEC-6（适配层放 core 还是前端各写一份）不是风险决策，只是放置决策**：放 core 则两处复用一份；各写一份则 5 行代码写两遍，且日后改约定要记得改两处。**分量远小于初稿所写。**

### 4.4 建议的落地形态（避免前后端各写一遍适配）

把「库调用 + 长度补齐 + 语义对齐 + KDJ 手写」全部收敛到 `packages/core/src/indicators/`：

```ts
// packages/core/src/indicators/adapters.ts（新增）
export function calculateRSI(closes: number[], period?: number): number[]        // 全长，库结果补齐
export function calculateMACD(closes, fast?, slow?, signal?): MACDResult          // dif/dea/macd(=2×柱)
export function calculateSMA(closes: number[], period: number): number[]
export function calculateKDJ(highs, lows, closes, n=9, m1=3, m2=3): KDJResult    // 手写，见下
export function calculateBoll(closes, period=20, mult=2): BollResult
```

**KDJ 手写口径**（库里没有，必须自实现并写进注释锁定）：
```
RSV = 100 × (C − Ln) / (Hn − Ln)     Hn/Ln = 近 n 根最高/最低（用库 Highest/Lowest）
     分母为 0（横盘）→ RSV 沿用前值，首值取 50
K   = (2/3)·K_prev + (1/3)·RSV        K_0 = 50
D   = (2/3)·D_prev + (1/3)·K          D_0 = 50
J   = 3K − 2D
```
初值 50 与 `1/3` 递归权重是 A 股 KDJ 与美式 Stochastic 的分水岭，**必须由 golden 数据集锁定**（`T51`）。

**关于「前端能否 import core」**：为了让前后端复用同一份适配层（而非各写一遍），建议放开 `apps/frontend` import `@invest/core` 的**纯算法导出**。这是对 AGENTS.md §3 的**窄化修订**（只放开纯函数，仍禁止 `node:*` 与 I/O），需所有者确认（§9 DEC-6）。若不接受，则前端自行复制一份 —— 代价仅是 §4.3.3/§4.3.2 的两处形状与约定变换各写两遍（6 行），**不含算法实现**。

### 4.5 ⚠️ 连带影响：AGENTS.md 需同步修订

AGENTS.md §3 现写「`packages/core` …… **零业务依赖**」以及「黄金测试数据集……保证双端计算误差=0」。引入 `fast-technical-indicators` 后：

| 约束 | 现状 | 需要修订为 |
|---|---|---|
| core「零业务依赖」 | core 将新增 1 个第三方运行时依赖 | 「零**业务**依赖；**纯数学指标库白名单**（当前仅 `fast-technical-indicators`），禁止引入任何含 I/O / 网络 / 数据库能力的依赖」 |
| 「口径一致性靠 golden 数据集在 CI 里验证」 | 实际保障已升级为「同库同版本锁定」 | 补充：golden 数据集降级为**回归网**，职责改为「防库升级 / 防适配层回归」，不再是一致性唯一保障 |

**AGENTS.md 是本项目最高约束文件，本计划不擅自修改**，提请 §9 DEC-6 确认。

---

## 5. 实施计划（T49-T94，48 个任务，其中 T89 拆为 T89a/T89b）

> **任务粒度**：1-3 人天。**每个 T 任务一条 commit**，格式 `<prefix>: T<编号> <描述>`。
> **依赖标记**：🔒 = 有前置阻塞任务。
> **T85-T94 是 2026-10-17 所有者裁决 §13 阻断项后新增的**（见 §13.4），编号接续 T84，不改动既有编号。**§13.1 的 13 项阻断已全部裁决并派任务**（见 §13.5）。

### Wave 1 — 数据与规则纠偏（后端 + core）

> 🚦 **出口门槛 G1**（§12.7）—— 6 条 🔒 数据正确性项**不可豁免**。这是全计划最严的一波：静默污染类错误一旦漏过，后续 6 波的持仓成本/收益率/复盘胜率全部错位且不报错。

> **这一波必须先做**。P0-1/P0-2 是 Requirements 明文业务规则缺失，P0-3 是 ADR-001 的安全前提，P0-9 是行情可用性的前置，且 Wave 3-7 大量前端任务依赖本波产出的接口。
> **T80 已实装并验证**（DuckDB 泄漏修复），T81 待做。

| ID | 任务 | 交付物 | 测试要点 | 卡点 |
|---|---|---|---|---|
| 🔒 **T49** | **加仓（`add`）交易类型补齐 —— 7 种类型对齐 Requirements §5.1** | **前置：清空重建开发库（DEC-9）** —— 先备份 `data/business.db` 到 `data/business.db.bak-<日期>`，确认无真实数据后删除，让 `configStore` 首次启动时按新 DDL 重建；**无需写数据订正脚本**。随后：`configStore.ts` DDL CHECK 白名单改为 **7 种**：`('buy','add','reduce','clear','dividend','bonus','transfer')`；`_ensureTradeTypeAddColumn()` 幂等表重建（旧 CHECK → 新 CHECK，供已有部署升级用）；`routes/trade.ts` + `positionCalculator.ts` + `TradeInput.tsx` 的 `TRADE_TYPES` + `Review.tsx` 的 `TRADE_TYPE_LABEL` 四处同步；`exDividendSync.getHoldingBeforeDate` 的 `'add'` 分支从死代码复活 | ① `add` 类型 POST → 201（**此前必然 400**，DDL CHECK 拦截）；② `sell` 应为 400 非法值；③ 加仓后移动加权成本与 golden 一致；④ `exDividendSync` 遇含 `add` 的持仓走主分支、不再落 `getHoldingBeforeDate` 兜底；⑤ 四处类型清单一致性断言 | ✅ **DEC-2 已定**：严格 7 种，`sell` 移除、`add` 加入。⚠️ **DEC-9 前置动作是破坏性的**，执行前必须先备份并人工确认库内无真实数据 |
| 🔒 **T80** | **DuckDB 连接泄漏修复（P0-9）** ✅**已实装并验证** | `db/duckdb.ts` 两个函数都改为 **`try/finally` 确定性关闭**：抽出 `openDuckDB()` 统一管理句柄，`queryDuckDB()` 与 `duckdbHealthCheck()` 内 `finally` 中先 `conn.closeSync()` 再 `instance.closeSync()`；修正注释（原注释误称「无 `.close()` 方法，依赖 GC」，实际 API 是 `closeSync()`）；给 `queryDuckDB` 补短退避重试应对 tdx2db 写库瞬时锁。**保留「每次查询按需 open/close」语义，刻意不改常驻单例**以符合 AGENTS.md | ① **连续 3 次 `queryDuckDB()` 全部成功**（核心回归断言）；② 混合 SQL 连打 10 次全成功；③ 查询**故意失败**后下一条仍成功（证明 finally 不被异常吞掉）；④ `duckdbHealthCheck()` 连续 3 次通过 | ✅ **已验证**：新增 `tests/unit/duckdbLeak.test.ts`（4 用例）。**git 原始版本跑 → 4 failed（`File is already open in`）；修复版 → 4 passed**（用 `git show HEAD:` 做的对照，非模拟）。集成测试 58/58 全通过，`tsc --noEmit` 0 error |
| 🔒 **T81** | **后端测试隔离修复（F-Q11）** | ① 定位污染源：全仓搜 `TUSHARE_TOKEN` 的 `process.env` 写入点，找出设置后未 `delete`/未还原的测试；② 每个污染测试改为 `beforeEach/afterEach` 保存并还原原值，或统一用 `vi.stubEnv()` + `vi.unstubAllEnvs()`；③ `tests/setup.ts` 增加 `afterEach` 强制清理本项目关心的环境变量（`TUSHARE_TOKEN` / `DUCKDB_PATH` / `SQLITE_DB_PATH` / `ENABLE_OCI_BACKUP` 等），避免新增测试再踩同类坑；④ CI 增加**顺序敏感守卫**：`--sequence.shuffle` 连跑 2 次，结果必须一致 | ① `vitest run apps/backend/tests/unit` 全绿无 skip；② 单独跑与全量跑结果一致；③ shuffle 连跑 2 次结果稳定；④ CI 不再有"靠顺序侥幸通过"的用例 | ⚠️ 修隔离可能暴露**更多此前被掩盖的失败**，属预期行为，逐个判定是真 bug 还是断言过紧。**建议与 T60 同批做**（同属「测试补齐」），但排在 T60 之后，避免掩盖 T60 新增用例的问题 |
| **T50** | **候选池基准价固化 + 迁移价格模式** | `POST /api/candidate` body 扩 `{asset_code, candidate_reason?, candidate_base_price?}`，缺省则 1 次 DuckDB 批量查加入日收盘价写入；`POST /api/candidate/:asset_code/promote` body 收 `price_mode: 'base'\|'current'` 并写 `migrated_price_mode`；`GET /api/candidate` 返回基准价 + 相对收益 | ① 手动加标的基准价 = 加入日收盘价；② 显式传 `candidate_base_price` 时尊重用户值；③ promote base 模式写 `migrated_price_mode='base'`；④ DuckDB 无该日数据时返回明确错误而非静默 NULL | 批量查收盘价要复用 `marketData.batchGetLatestClose`；禁止在 Node 写 DuckDB |
| 🔒 **T51** | **指标库接入 + 适配层 + 黄金数据集（P0-3 + DEC-1）** | ① `packages/core` + `apps/frontend` 各加 `fast-technical-indicators@1.1.6` **精确锁版本**（禁 `^`）；② `packages/core/src/indicators/adapters.ts`：现有 `calculateRSI`/`calculateMACD` 改为**库的薄适配层**，只做两件事——(a) **数组补齐**到 `closes.length`（§4.3.3，5 行，无法回避）；(b) **柱值 `histogram × 2`** 修正为 A 股通达信约定（§4.3.2，1 行）。**不实现任何 EMA/DIF/DEA 算法**；③ `golden/{movingWeightedCost,rsi,macd}.json` 落地（README 替换为生成脚本说明） | ① 柱值 ×2 语义有专门回归断言；② 数组长度恒等于输入长度；③ RSI 稳定区偏差 ≤1e-3；④ core 与 frontend 对同一 golden 逐位相同；⑤ 移动加权成本 5 场景 golden | ✅ **不是高风险任务**（初稿判断有误，已按 §4.3 修正）。EMA 播种 warm-up 瞬态**仅需一次性核对**：迁移前用真实行情回放 `executeAllPlugins`，比对已持久化 MACD 信号的 `trade_date` 是否漂移，有差异归档 `docs/adr/` 记为口径变更，**不阻塞迁移**。golden 须人工构造可手算的确定性序列，**禁随机数** |
| 🔒 **T52** | **KDJ + 布林带手写实现** | `packages/core/src/indicators/kdj.ts`：库里**没有 KDJ**（§4.2 实测 221 个导出无 KDJ，库的 `Stochastic` 是美式口径，K/D 与 A 股差 ~7 个点）→ 按 §4.4 公式手写，用库的 `Highest`/`Lowest` 取窗口极值，K/D 初值 50、`1/3` 递归权重写进注释锁定；`bollinger.ts` 用库 `BollingerBands` 包适配层；`routes/kline.ts:29` 私有 `sma()` 删除改走 core | ① KDJ golden 数据集断言（含 K_0=D_0=50 首值）；② `Hn−Ln=0`（横盘）不产生 NaN/Infinity，RSV 沿用前值；③ 布林带 golden | KDJ 是唯一递归平滑指标，初值口径（50 vs 首值）是 A 股与美式分水岭，**必须 golden 锁死** |
| **T53** | **K 线路由能力补齐** | `routes/kline.ts`：`fq` 支持 `qfq`/`bfq`/`hfq`/`raw` 四值**白名单校验**（映射 `v_stock_qfq`/`v_stock_bfq`/`v_stock_hfq`/`raw_kline_daily`）；`indicators` 增加 `ma60`（走 core 适配层）；`rsi`/`macd` period 支持 query 参数；`signals` 改**升序**返回 | ① 四种 fq 各返回 200 且首行 close 符合预期；② 非法 `fq` → 400 而非静默回落 qfq；③ `ma60` 数组与 golden 一致；④ signals 与 klines 同序 | ETF 需按 `raw_symbol_class.class` 路由到 `v_etf_*`；不能硬编码 `v_stock_*` |
| **T54** | **signals 路由增强** | `routes/signal.ts` 加 `asset_code`、`start_date`、`end_date` 筛选（全部参数化 prepared statement）；`ORDER BY trade_date ASC` 可选 | ① 单 symbol 过滤只回该标的；② 日期范围边界闭合；③ 组合筛选（symbol+plugin+范围）正确；④ 无匹配返回空数组非报错 | `idx_signal_user_asset_date` 已建，走索引 |
| **T55** | **stockscan 公共过滤** | `routes/stockscan.ts` body 加 `asset_type:'stock'\|'etf'\|'all'`、`exclude_st:boolean`、`industry_code?`、`market_cap_max?`；SQL 侧 JOIN `raw_symbol_class`（`is_st`）/ `raw_basic_daily`（`totalmv`）/ `raw_tdx_blocks_member`（行业）；结果补 `name`（`raw_symbol_name`）。**✅ SDD §3.3 已修订放行这两张表** | ① `exclude_st=true` 时结果无 ST；② `asset_type='etf'` 只回 ETF；③ 市值上限过滤正确；④ 行业过滤命中正确；⑤ 各过滤叠加后 ≤3s（PE2） | ✅ DEC-4 已定，SDD §3.3 已改。行业字段用板块表近似（`block_type` 需甄别），MVP 标注为「板块口径」 |
| **T56** | **候选池批量接口** | `POST /api/candidates/batch` body `{asset_codes: string[]}`（上限 100）；`db.transaction()` 包裹，`INSERT OR IGNORE` 幂等；返回 `{added,skipped,duplicates[]}`；写 `system_log` | ① 100 条批量 < 200ms；② 重复项进 `duplicates` 不报错；③ 事务中途失败全量回滚；④ 超过上限 400 | 与 T50 同表，注意事务粒度 |
| **T57** | **鉴权补 register + refresh**（DEC-10：两个都补齐） | `POST /api/auth/register`：首个用户自动 admin，其后仅 admin 可建号或强制 `role='user'`；`POST /api/auth/refresh`：access 7d + **refresh 30d** 双 token（SDD §4.4），refresh token 落 `user_account` 新列并轮换（旧 refresh 立即失效） | ① 首用户注册自动 admin；② 第二用户不能自升 admin；③ refresh 换新 access 且旧 refresh 失效；④ 过期 refresh → 401；⑤ **注册入口的越权用例必须齐**（对应 `cba9556` 修复的同类漏洞，不得重开） | ⚠️ **勿回退 `cba9556` 对 `/seed` 的加固**（那是安全修复）；`register` 是**新增路由**，与 seed 加固并存。`user_account` 加列走幂等 ALTER |
| **T58** | **信号落库字段补全 + 持仓关系同步** | `persistSignals`/`persistBatchSignals` INSERT 补 `metrics_json`（序列化 `signal.params`）与 `is_final=1`；`routes/trade.ts` 写入/删除交易时同步 `user_asset_rel` 的 `rel_type='hold'`；清仓时软删 hold 关系 | ① `metrics_json` 内容 = 插件 `params`；② 买入后 `rel_type='hold'` 存在；③ 清仓后软删；④ `exDividendSync` 不再走交易表兜底分支（打日志断言） | `metrics_json` 内含数值，禁止塞 token 等敏感字段（logger.ts 有脱敏工具） |
| **T59** | **system_log 日期范围 + 管理员全流程触发** | `GET /api/admin/system-log` 加 `start_date`/`end_date`（替换单值 `trade_date`，保留向后兼容）；新增 **`POST /api/admin/datacheck/trigger`**（**§13.4 B-12 裁决：以 SDD §4.4:1274 为准**；代码现为 `/api/admin/run-datacheck`，本计划初稿曾另起名 `run-pipeline`，**均作废**）：串行跑 rerun-quotes → datacheck → signal → 除权 → 备份，返回各段结果数组 | ① 日期范围闭区间正确；② `run-pipeline` 各段串行且单段失败不中断后续；③ 二次鉴权 + 写 `trigger_manual` 日志 | 串行总耗时可能超前端超时；需返回 `jobId` + 轮询，或前端设长超时 |
| 🔒 **T80** | **DuckDB 连接泄漏 + 并发互抢 + BigInt 归一化（P0-9 / P0-12 / P0-10）** ✅**已实装并验证** | ① `db/duckdb.ts`：**instance 进程内单例**（挂 `globalThis`，惰性创建 + Promise 去重；挂 globalThis 是因为 vitest 每测试文件独立 module graph，模块变量会导致全量跑时跨文件互抢锁）；**connection 每次查询开关 + `finally` 中 `conn.closeSync()`**；② `normalizeValue()` 在 `queryDuckDB` 唯一出口统一归一化：`bigint → number`、**DATE → `'YYYY-MM-DD'`**（实测 `@duckdb/node-api` 的 DATE 返回 `{days: epoch天数}`，与其类型声明的 `Date` **不符**，故两种形态都兼容；epoch 转换必须走 `toISOString()` 否则本地时区会偏移一天）；③ 导出 `closeDuckDBInstance()` 供测试 `afterAll` 与优雅退出；④ 补短退避重试应对 tdx2db 写库瞬时锁 | ① 串行连续 3 次查询全成功（原第 2 次起必失败）；② **并发 5 次 / 8 次（含失败分支混合）/ healthCheck 与查询共存**全成功（原 5 路并发 4 失败）；③ 查询**故意失败**后下一条仍成功（证明 finally 不被异常吞掉）；④ **结果不含 bigint 且可被 `JSON.stringify`**（回归 P0-10 原始症状）；⑤ **DATE 归一化为 `'YYYY-MM-DD'`**，含 epoch 0 边界（`1970-01-01`）与跨月边界（`2026-03-01`）防时区偏移；⑥ 全量 `unit` + `integration` + `core` 全绿（跨测试文件不互抢） | ✅ **已验证**：`tests/unit/duckdbLeak.test.ts` 11 用例全通过。**双版本对照**：HEAD 版跑同一组用例 → **5 failed**（`File is already open` + BigInt 序列化）。`tsc --noEmit` 0 error；`unit` **17/17 文件 137/137**、`integration` 58/58、`core` 24/24。端到端：股票 K 线 `sh600519`/`sz000001`/`sz002594` 由 500 → **200**，并发 5 端点全 200，串行连续 5 次全 200。⚠️ 测试**不依赖行情库内容**（用 `SELECT 1` / `1::BIGINT` / `DATE '...'`），CI 环境无 `data/quotes.duckdb` 也能跑 |
| 🔒 **T82** | ~~DuckDB BigInt 序列化修复~~ → **已并入 T80 完成**，本任务关闭 | — | — | ✅ **关闭**：BigInt 与 DATE 归一化已在 `duckdb.ts` 的 `normalizeValue()` 实现并通过 11 个回归用例。**唯一残留项**：ETF/指数视图路由（见 F-K10）留在 T53 |
| 🔒 **T83** | **补齐 filter 类选股插件（P0-11）** | 新增至少 2 个 `category='filter'` 内置插件（PRD §5.6「条件选股」+ Requirements §4.2 #7 的实际前提）：`turnover_filter`（换手率 > X）、`market_cap_filter`（总市值 < X 亿）；二者的 `paramSchema` **不得含 `symbol` 字段**（这是 monitor 与 filter 的本质区别）；`routes/stockscan.ts` 增加 **category 过滤校验**（只接受 `category==='filter'` 的插件，传 monitor 插件返回 400 而非静默扫不出）；`pluginEngine.executeAllPlugins` 已只跑 monitor（`scheduler.ts:755`），确认 filter 插件不会被误纳入每日信号生成 | ① `GET /api/stockscan/plugins` 返回中含 `category:'filter'` 项；② `POST /api/stockscan` 用 filter 插件时 **`totalCandidates > 0`**（当前恒为 0）；③ 用 monitor 插件调 scan → 400 且中文提示「该插件是监控类，不能用于选股」；④ filter 插件**不出现在每日信号生成**里；⑤ 选股 5000 标的 ≤3s（PRD PE2）；⑥ 动态执行结果数 ≤100 | ⚠️ **T55（公共过滤）+ T56（批量候选池）都不解决这个** —— 没有 filter 类插件，扫不出任何东西。建议与 T55 同批交付，否则 T73 的前端工作量无法验收 |
| 🔒 **T84** | **持仓充足性校验修复（P0-13）** | ① `services/positionCalculator.ts` 的 `validateSufficientHolding` **改为时点校验**：按 `trade_date ASC, id ASC` 回放时**停在目标卖出交易之前**（同日按 `id` 序），判断那一刻的持仓是否 ≥ 卖出量；当前实现回放全部记录并用**所有日期的累计总量**，会用未来买入支撑过去卖出。② `packages/core/src/movingWeightedCost.ts` 的 sell 分支加**最后一道防线**：`totalQuantity -= qty` 后若为负则抛错，避免任何调用方绕过校验写脏数据。③ `routes/trade.ts` 的 `REDUCE_TYPES` 分支加 `try/catch`，把 core 抛出的超卖异常映射为 `HOLDING_INSUFFICIENT` **409**（`trade.ts:58` 现为 `reply.code(400)`，按 §13.4 B-10 裁决改为 409 —— SDD §4.3 错误码表明确 `HOLDING_INSUFFICIENT → HTTP 409`；**SDD §12.3 B1 写的 400 属 SDD 自身笔误，需同步改为 409**） | ① **构造日期交错场景**：先写 `10-16 buy 100`，再写 `08-01 buy 100`，然后 `08-06 sell 105` → **400 拒绝**（当前 201 通过）<br>② 单笔买入场景回归：`buy 100` 后 `sell 150` → 400（时点持仓 100）<br>③ 合法卖出：`buy 100` 后 `sell 99` → 201 且持仓 1<br>④ 恰好清仓：`buy 100` 后 `sell 100` → 201 且持仓 0<br>⑤ 空仓卖出任意量 → 400<br>⑥ core 层直接传入超卖序列 → 抛错而非返回负数<br>⑦ **回放后全库无负持仓**（数据订正后断言） | 🔴 **必须在 T49 之前或同期完成** —— 两者改同一批 `switch` 分支。<br>⚠️ **`clear` 类型口径待确认**：`trade.ts:35` 要求 `quantity > 0`，但「清仓」语义是卖全部，其校验逻辑与 `reduce` 不同；需先读 `calculateMovingWeightedCost` 对 `clear` 的处理（当前 `mapToCoreTrade` 把 `clear` 与 `sell` 同映射为 `direction:'sell'`，**数量语义在 DDL/前端上未区分**），再决定校验写法 |
| **T60** | **后端测试补齐 + smoke 测试 DB 隔离 + 测试分层归位 + 持仓查询性能** | **① smoke-m1~m4 必须像 integration 一样隔离 DB** —— 实测 `data/business.db` 被污染（35 个 `seed_*`/`int_*` 用户、2310 条 datacheck 日志、5 笔测试交易），原因是集成测试有隔离（`tests/integration/_helpers.ts:17-21` 的 `mkdtempSync` + `SQLITE_DB_PATH` 覆盖 + `ConfigStore._instance` 归零）而 **smoke 测试没有**；把 smoke 的 bootstrap 统一到 `_helpers.ts` 同款隔离<br>**② 测试分层归位（2026-10-17 实测结论，原 plan 遗漏）** —— integration 测试全部走 `app.inject()`（实测 6 个文件 75 次 `inject()`、**0 次 `listen()`、0 个端口字面量**），`createTestApp()` 只 `registerRoutes(app)` 不 `listen`，是**刻意的无端口设计**（避免 singleFork 下 `EADDRINUSE`）。**但 `inject()` 绕过网络层，以下三类测不了，必须真起服务**：<br>· **CORS 是否只允许 127.0.0.1**（AGENTS.md 硬约束；`@fastify/cors` 的 Origin 处理与预检在 HTTP 层）<br>· **SE1 HTTPS 强制 / 301 跳转**（需真实 socket）<br>· **PE1-PE5 性能指标**（`inject()` 少一次序列化往返，测出来偏乐观）<br>→ **动作**：① 建 `tests/http/` 目录（或明确归 smoke），放 CORS / HTTPS / 性能测试，**并在文件头注释「本目录必须真 listen，占用 51200-51999 段，收尾按 AGENTS.md 三步」**；② `tests/integration/` 文件头加注释「本目录不占端口；CORS/HTTPS/性能勿放此处，否则得到假绿」；③ 删除 `smoke-m2.test.ts:50` 的死常量 `TEST_PORT = 51101`（实测定义后从未使用）<br>③ 新增 `tests/unit/{kline,stockscan,kdj,positionPerf}.test.ts`、`tests/integration/{candidates,authRegister,signalFilter}.test.ts`；④ `calcAllPositions` 改单次 `IN` 查询取候选标的 + 内存聚合，消除 N+1；⑤ 补 `restoreSQLiteBackup` 白名单单测；⑥ `assetStat.test.ts` 补双口径数学用例 | ① **跑完全部 smoke 后 `data/business.db` 行数不变**（隔离回归断言）<br>② **反证隔离有效性**：故意在 smoke 里写一行数据，跑完确认真实库无此行<br>③ **`tests/http/` 的 CORS 测试**：Origin=`http://evil.com` 必须被拒；`http://127.0.0.1:5173` 必须放行 —— **若放进 integration 用 inject() 测则此项恒绿，等于没测**，须断言该测试文件确实调了 `listen()`<br>④ 30 只持仓 `/api/positions` p99 < 200ms（PE4，**必须在 `tests/http/` 真 listen 下测**）<br>⑤ KDJ/MA60/fq 四值断言<br>⑥ 双口径数值与 golden 一致<br>⑦ `grep -r "TEST_PORT" tests/` 归零 | ⚠️ AGENTS.md 硬约束：批量查必须 `IN (...)` 一次。**隔离修复应先于任何会碰开发库的任务**（含 T49 的清库动作）。<br>⚠️ **「文件名带 integration 就有网络层语义」是错的** —— 本目录测的是「进程内完整路由链路」，不含 HTTP 传输层。误放会得到假绿，这正是 B-4 发现的「测试映射缺失」的具体成因之一。<br>⚠️ 新增 `tests/http/` 会引入端口依赖，**必须同步更新 AGENTS.md 收尾流程**（已落地：按端口段强杀 + 查 `tsx watch` 残留）。 |
| 🔒 **T85** | **对齐 C1-C12 口径 + 补齐与 Requirements 一致的新鲜度校验（B-14 裁决=A 重写）** | ⚠️ **本任务已因 B-14 裁决整体重写** —— 初版任务是「实现 C4 退市标记 / C5 ST 状态」，但按 `Requirements_simplified.md` §7.1（真相源最高层）+ PRD §6.4，**C3-C8 实为「数据新鲜度」校验**：<br>① **C1** 按 Requirements 改为「当日标的数 ≥ 3000 → PASS / >0 但不足 → WARN / =0 → ERROR」（**不再是**初稿的「偏离平均 ±10%」）；失败 ERROR → 自动补跑<br>② **C3** 复权因子新鲜度：`MAX(date) = 当日` → 否则 WARN → 自动补跑。⚠️ **复权因子表名待实测**（初稿曾假设 `raw_hfq_factor`，**从未经代码验证**，须先 `DESCRIBE`）<br>③ **C4** 除权除息新鲜度：`MAX(ex_date) >= 当日 - 7 天`（源 `raw_gbbq`）；⚠️ 除权事件稀疏，**须与交易日历联查**，否则淡季/长假会误报<br>④ **C5** 板块/概念完整性：总量相对前 7 日均值降幅 < 10% → 否则 WARN，**仅记录不自动补跑**；⚠️ 板块成分表名待实测<br>⑤ **C6** 市值数据存在性：当日非空市值标的数 ≥ 3000 → 否则 WARN → 自动补跑；市值列名待实测<br>⑥ **C7** 日线价格合理性：`close ≠ 0` 且 `open ≤ close × 2` → 否则 WARN，**仅记录**<br>⑦ **C8** 行情更新执行时长 ≤ 120s → 否则 WARN。**本项不查 DuckDB**，读 `system_log` 行情更新条目的起止时间戳差<br>⑧ **`runAllChecks()` 返回 12 条**且 `checkId` 覆盖 C1-C12 **无重复无占位**（当前 `checkC3toC5` 一律返回 `'C3'`）<br>⑨ **原「扩展校验」6 条**（停牌/退市/ST/价差/成交量/滞后，SDD §5.7 末节）**不占用 C 编号、不计入 12 项主表**；代码当前实现的正是这套，**需逐条决定：实现 / 合并进 C9 / 移出代码**，并在 SDD §5.7 附表登记去向 | ① `runAllChecks()` 长度 **= 12**（硬断言 `toHaveLength(12)`）<br>② **C1 三态各自可触发**：正常日 ≥3000 → PASS；构造 1500 只 → WARN；构造 0 只 → ERROR<br>③ **C3/C4/C6/C8 各自验证 WARN 会自动补跑**（mock `runAllChecks` + 断言 rerun 被调用）<br>④ **C5/C7 验证只记录不补跑**（这两条 Requirements §7.1 明确「记录，人工确认 / 记录异常标的」）<br>⑤ **C8 实测**：跑一次真实行情更新，把耗时读出来断言 ≤120s 判定路径可通<br>⑥ **C4 淡季不误报**：构造「最近除权日在 30 天前」且**该窗口内确无除权事件** → 应 PASS<br>⑦ **每条校验四态齐**（PASS/WARN/ERROR/SKIP），数据源缺失一律 SKIP **不得计 PASS**<br>⑧ **扩展校验 6 条的去向逐条落 SDD §5.7 附表**，无「悬空未处置」项<br>⑨ SDD §5.7 全部占位表名（`raw_hfq_factor` / `<复权因子表>` / `<板块成分表>` / `<市值列>`）在实现前**全部替换为实测表名** | 🔴 **PRD D1「12 项校验」与 §6.2「C1-C10 通过率」的唯一解锁项**，且本任务现在是 **B-14 裁决=A 的落地**。<br>⚠️ **本条为数据新鲜度类校验，语义是「更新成功了吗」，不是「数值对不对」** —— 扩展校验那 6 条仍需另行处置，否则会整体丢失。<br>⚠️ **不要照抄本文档的 SQL 表名** —— C3/C5/C6 的源表从未经代码验证，须先 `DESCRIBE`；这是本轮审计中反复踩到的坑（SDD §5.3 的 `/opt/invest/`、T85 初版的 `raw_symbol_class` 均属此类）。<br>⚠️ 与 T88 同批更省事：两者都改 validator / 调度链的判定与计时边界。 |
| 🔒 **T87** | **`trade_time` 输入 + UNIQUE 改键为「同日同刻」语义（§13.4 B-11 裁决：追加；**成交时间进主键，份额不进**）** | ① **DDL**（`configStore.ts:25-47`，已核对真实列名）：`user_trade_record` 加 **`trade_time TEXT NOT NULL`**（格式 `HH:mm:ss`，秒级，**无 DEFAULT**）；`configStore.ts:45` 的 `UNIQUE(user_id, asset_code, trade_type, trade_date)` → **`UNIQUE(user_id, asset_code, trade_type, trade_date, trade_time)`**（**注意：`quantity` 不进主键** —— 所有者裁决明确只加成交时间）；走 `CREATE TABLE IF NOT EXISTS` + 幂等表重建（与 T49 的 `_ensureTradeTypeAddColumn()` 同款套路，**两次表重建合并为一次**）<br>② **API**：`POST /api/trade` / `PATCH /api/trade/:id` 接受 `trade_time`，**必填**（正则 `^\d{2}:\d{2}:\d{2}$` + 时/分/秒范围校验，参数化语句不拼 SQL）；`routes/trade.ts:69` 的 INSERT 字段列表加 `trade_time`<br>③ **语义翻转**：`TRADE_DUPLICATE` 文案（`trade.ts:91` 现「同日同标的同方向交易已存在」）改为「**该标的在该时刻已有同类型交易**」<br>④ **前端** `TradeInput.tsx` 加「成交时间」`<input type="time" step="1" required>`，默认当前时刻；**提交前预检**：拉当日同标的同类型已用时间集合，命中则禁用提交并提示「该时刻已被占用，请修改成交时间」<br>⑤ **新增错误码登记**：`TRADE_DUPLICATE` 在 SDD §4.3 错误码表中**不存在**（该表只有 10 个码），需补一行 `TRADE_DUPLICATE \| 同标的同类型同时刻重复 \| 409` | ① **同日同标的同类型、不同时间 → 两笔都 201 成功并存**（当前第二笔 409 —— 这是本任务的核心断言）<br>② 同日同标的同类型、**同时间** → 409 `TRADE_DUPLICATE`（幂等仍生效）<br>③ **同日同标的同类型、同时间、不同份额 → 仍 409**（验证份额确实**不在**主键内，这是裁决的反向断言）<br>④ 缺 `trade_time` → 400 `PARAM_INVALID`（**必填，不给默认值**）<br>⑤ `trade_time` 非法格式（`25:00:00` / `abc`）→ 400 `PARAM_INVALID`<br>⑥ 回放持仓时同日交易**按 `trade_time ASC, id ASC` 排序**（T84 的时点回放同步采纳）<br>⑦ 旧数据（无 `trade_time`）迁移时按 `created_at` 的时分秒回填，避免违反新 UNIQUE | 🔴 **必须在 T49 之前或同期** —— 同改 `user_trade_record` DDL 与 CHECK/UNIQUE。<br>⚠️ **`trade_time` 必须必填、不能留空**：裁决把份额移出主键后，唯一区分「同日同标的同类型多笔」的字段就只剩时间。若允许留空（落 `00:00:00`），则同一天同一标的同一类型**仍只能录一笔** —— **与「追加」裁决直接冲突**。故本任务改为必填 + 前端预检拦截，代价见下。<br>⚠️ **已知代价（裁决的直接后果，已登记）**：粒度从「天」细化到「秒」，**同一标的同一天同一类型只能有一笔**。补录历史交易时用户若对多笔填了相同时间（如都填 `09:30` 表达「同一天买」），第二笔会 409 —— 需前端预检提前拦截并提示改时间，而不是让用户提交后才吃错误码。<br>⚠️ 份额不进主键是所有者明确指定的设计（初版曾误加 `quantity`，已按裁决移除）。 |
| 🔒 **T88** | **插件 50ms 计时边界修正（§13.4 B-3 裁决：行情查询不计入）** | **口径定义**：50ms 预算**只覆盖插件自身 `execute()` 的纯计算**，**行情查询（DuckDB IO）、JSON 序列化、DB 写入一律不计入**。实现：<br>① 把 `buildPluginContext` 的行情查询从 `executeAllPlugins` 的 `Promise.race` 计时窗口内**移到窗口外**（先批量取好行情 → 构造 context → 再开始计时 → 调 `execute`）<br>② `Promise.race` 的计时起点改为「进入 `execute()` 那一刻」，并在 `plugin.test.ts` 里对内置插件断言 `execute` 自身耗时 < 50ms<br>③ **保留**「插件内部死循环必须被 reject」的保护 —— 这是 SDD §12.3 P3 的安全约束，与 IO 无关<br>④ `signalType` 枚举去掉超范围的 `ALERT`（SDD §5.3 无此项），或补 SDD 确认 | ① **`POST /api/admin/run-signal` 返回 `{total:2, success:2, timeout:0}`**（当前 `{2, 0, 2}`）—— 这是本任务的核心断言<br>② `user_strategy_signal` 新增行数 > 0（当前 0 条）<br>③ **`while(true){}` 插件仍被 reject 且标记 TIMEOUT**（证明没把安全约束一起放掉）<br>④ 计算耗时 > 50ms 的插件（用注入 sleep 模拟）仍被判 TIMEOUT<br>⑤ 每个内置插件单独断言 `execute` 耗时 < 50ms（逐个记录实测值） | 🔴 **实测两个内置插件 100% 超时 → `user_strategy_signal` 0 条 → F8「每日自动跑策略信号」与 PE6 双双不可达**。<br>⚠️ **建议先于 T83**：T83 新增的 filter 插件应在正确的计时口径下交付，否则新插件会重蹈覆辙。<br>⚠️ 修完必须把实测耗时写进 §11.8 证据表，替换「当前猜测 DuckDB 查询计入预算」的表述 |
| 🔒 **T89a** | **后端 envelope 统一（加 `code`/`timestamp`）+ 错误码归一 17→10 + 状态码校正（B-9 / B-10 裁决；Wave 1 阶段）** | **阶段划分理由**：SDD §4.2 的 `{code, data, timestamp}` 里，只有**删 `success`** 是破坏性的，而当前前端 `success` 在 **20 处**、`error` 在 **36 处**被依赖（实测 9 个 page 文件），且**前端测试基座 T61 在 Wave 2** —— Wave 1 改破坏性契约等于零回归保护。故拆两阶段。<br>**① 新增 `src/lib/envelope.ts`**：<br>· `ok(data)` → `{ code: 0, data, timestamp, success: true }`<br>· `fail(status, code, message)` → `{ code, message, data: null, timestamp, success: false, error: code }`<br>· 全站 63 处 `reply.code(...)` 改为经此出口（`server.ts:27-30` 的 cors 与 `registerRoutes` 不算）<br>**② 统一 `error` 字段语义为错误码**（2026-10-17 实测发现该字段**语义不一致**：`auth.ts:28` 放中文「用户名或密码错误」，`trade.ts:60` 放 `HOLDING_INSUFFICIENT`；中文一律移入 `message`）<br>**③ 错误码归一 17 → 10**（SDD §4.3）：<br>· 已对齐：`TRADE_REASON_REQUIRED` / `HOLDING_INSUFFICIENT` / `FORBIDDEN` / `INTERNAL_ERROR` / `DUPLICATE_IMPORT` / `SYMBOL_NOT_FOUND` / `UNAUTHORIZED`<br>· 需改名：`INVALID_TOKEN` + `NO_TOKEN` → **`UNAUTHORIZED`**；`INVALID_SYMBOL` → **`SYMBOL_NOT_FOUND`**；`DUPLICATE`(watch) / `NOT_FOUND` / `PLUGIN_NOT_FOUND` → SDD 补码<br>· 需新增：**`PARAM_INVALID`（代码中根本不存在，却是 SDD §4.3 首个码）** / `DB_UNAVAILABLE` / `EXTERNAL_SOURCE_UNAVAILABLE` / `TRADE_DUPLICATE`（T87 需要）<br>· 需裁决：插件/搜索/备份类专有码（`PLUGIN_NOT_FOUND`/`SEARCH_FAILED`/`KLINE_QUERY_FAILED`/`RESTORE_FAILED`/`CONFIRM_REQUIRED`/`ADMIN_ALREADY_EXISTS`/`SEED_PASSWORD_REQUIRED`）保留还是并入 `INTERNAL_ERROR`<br>**④ 状态码按 SDD §4.3 HTTP 列校正**：`routes/trade.ts:58` 实测 `reply.code(400)` → **409**（B-10）；`PARAM_INVALID` 400；`SYMBOL_NOT_FOUND` 404；`DB_UNAVAILABLE` 503。`auth.ts:81`（用户名已存在）与 `watch.ts:41`（重复关注）的 **409 保留**（语义冲突非参数错误）<br>**⑤ 同步修 SDD §12.3 B1** 的 `400` 笔误 → 409<br>**⑥ 前端最小适配（36 处）**：`res.data.error` → **`res.data.message ?? '未知错误'`**。**这一步有正收益** —— 现状用户会看到裸错误码（实测 401 返回 `NO_TOKEN`，而 `Login.tsx:43` 直接把它 `setError` 上屏） | ① 契约测试遍历全部路由：成功体含 `code===0` + `data` + `timestamp` + `success===true`；错误体含字符串 `code` + `message` + `data===null` + `timestamp` + `success===false`<br>② **前端 36 处全部改读 `message`** —— `grep -rn 'data\.error' apps/frontend/src` 归零<br>③ **正向验证**：登录密码错误 → 页面显示「用户名或密码错误」**而非** `INVALID_CREDENTIALS`（证明 §② 生效）<br>④ **正向验证**：持仓不足 → 显示中文文案而非 `HOLDING_INSUFFICIENT`<br>⑤ SDD §4.3 每个码都有 ≥1 用例；**无「SDD 有码而代码不用」，也无「代码有码而 SDD 未登记」**<br>⑥ `grep -rn 'HOLDING_INSUFFICIENT' --include=*.ts -A2 \| grep 'code(400)'` 归零<br>⑦ **故意漏 `timestamp` → 契约测试必须失败**（证明约束生效）<br>⑧ **本阶段仍保留 `success` 字段** —— 删它属 T89b | 🔴 裁决「改代码」即采纳 SDD §4.2。**本阶段为增量**：`success`/`error` 全部保留，前端只改「读哪个字段」而非「读什么字段」。<br>⚠️ **63 处 `reply.code(...)` 必须逐个过，禁止正则批量替换** —— 各路由 `data` 形态不同（有对象、有数组、有 `null`）。<br>⚠️ ② 会改变 36 处前端显示内容，但**方向是从裸码变中文**，是正向修复而非回归。<br>⚠️ 依赖 T90 同批（都改全部路由文件）。**建议顺序：T89a 封装 → T90 路由 → 前端 36 处适配**。 |
| 🔒 **T89b** | **删除 `success` 字段 + 前端切 `code === 0`（B-9 收尾；Wave 8）** | **前置条件：T61 前端测试基座已落地**（Wave 2），否则删除 `success` 仍无回归保护。<br>① `lib/envelope.ts` 的 `ok`/`fail` 删除 `success` 字段<br>② 前端 **20 处** `if (res.data.success)` → **`if (res.data.code === 0)`**（实测分布：Admin 5 / Dashboard 5 / Review 4 / TradeInput 1 / Login 1 / Signals 1 / StockScan 1 / Settings 1 / Kline 1）<br>③ `api/client.ts` 统一读 `code` 判定，401 → 提示条 + `Navigate('/login', {state:{from}})`（承接 T64）<br>④ 契约测试改为**强制断言响应体无 `success` 键** | ① `grep -rn '\.success' apps/frontend/src` 中响应判定类归零（注意与 §11.3b 无关的同名字段需甄别）<br>② `grep -rn "success:" apps/backend/src/lib/envelope.ts` 归零<br>③ 契约测试遍历全部路由断言 `'success' in body === false`<br>④ **前端测试全绿**（T61 提供的保护网在此生效）<br>⑤ 登录 → 持仓 → 交易 → 复盘 四条主流程浏览器实测无回归 | 🔴 这是 B-9 的**最后一步**，也是唯一有破坏性的一步，故推到 Wave 8。<br>⚠️ **T89a 已把 36 处前端改读 `message`**，本任务只改 `success` 判定，两阶段职责不重叠。<br>⚠️ 若 Wave 2 的 T61 未落地，**本任务不得开工** —— 届时应先补 T61，而不是硬删。 |
| 🔒 **T90** | **路由契约对齐 SDD §4.4（§13.4 B-12 裁决：以 SDD 为准）** | SDD §4.4 的 **22 条路由**是唯一权威。实测代码命名与之不符的有 15 处（§13.2 I-1），逐条对齐：<br>① **B-12 手动触发**：`routes/admin.ts` 现 `/api/admin/run-datacheck` → **`/api/admin/datacheck/trigger`**（SDD §4.4:1274）。**T59 原计划新增的 `/api/admin/run-pipeline` 取消**；同时把 SDD §5.1.1 的简写 `/api/admin/datacheck` 统一为同一路由（属 SDD 内部矛盾修正，非改名）<br>② **校验结果读取**：代码 `/api/datacheck/latest` → **`/api/admin/datacheck/result`**（SDD §4.4:1273）<br>③ **交易**：`/api/trades` → **`/api/trade`**；`POST /api/trades/:id/soft-delete` 路径对齐<br>④ **持仓**：`/api/positions` → **`/api/holding`**<br>⑤ **K 线**：`/api/kline/:symbol` → **`/api/quote/:symbol/kline`**<br>⑥ **插件**：`/api/plugins` → **`/api/strategy/plugins`**；配置 PATCH → **PUT `/api/strategy/plugins/:id/config`**<br>⑦ **信号**：`/api/signals` → **`/api/signal`**<br>⑧ **复盘**：`/api/review/stats` → **`/api/review/yield`**<br>⑨ **候选池迁移**：`/api/candidate/:asset_code/promote` → **`/api/candidate/:id/migrate`**（注意 `:id` 与 `:asset_code` 的语义切换）<br>⑩ **角色**：`/api/admin/users/:id/role` → **PATCH `/api/admin/role/:userId`**<br>⑪ 计划新增路由**补登记进 SDD §4.4**：`/api/candidates/batch`（T56）<br>⑫ **T59 的 `run-pipeline` 取消** | ① **契约测试遍历 SDD §4.4 全 22 条路由，逐条断言存在且方法/鉴权匹配**<br>② 反向断言：旧名全部 404（SDD 里没有的路由不得残留）<br>③ 旧名保留 1 个版本 `@deprecated` 别名 + 响应头 `Deprecation: true`，下版本删除<br>④ 前端 `api/client.ts` 全部 base path 同步，无 404<br>⑤ `auth.ts:81` 的 409（用户名已存在）与 `watch.ts:41` 的 409（重复关注）**保留 409**（语义冲突非参数错误，与 SDD §4.3 不冲突） | 🔴 「以 SDD 为准」= **改代码**，不改 SDD 的路由名（仅统一 §5.1.1 的内部简写）。<br>⚠️ **与 T89a 高度耦合**（都改全部路由文件），**必须同批**。<br>⚠️ **B-13 已由 T94 落地**（`/api/strategy/reload` 属 MVP），本任务只需保证契约测试涵盖该路由。 |
| 🔒 **T91** | **SDD §12.5 测试映射补齐 + 新建 4 个缺失测试文件（B-4）** | ① §12.1 补第三列「SDD 指定测试载体」，逐项标注 `✅ 已有` / `❌ 待建`；② **实测缺口**（已全仓核对）：`holding.test.ts` **不存在**（现有 `positionCalculator.test.ts` 不覆盖 SDD 指定的 `avg_cost_calc_5_scenarios`）、`scan.test.ts` **不存在**、`frontend.test.tsx` **不存在**（前端 0 测试）；`packages/core/tests/plugin.test.ts` **只有 1 个用例**（插件可实例化），SDD §12.5 要求的**状态机 4 路径 + `plugin_timeout_50ms` 均无**；③ **F11 `backup_restore_duckdb` 全仓无测试** —— 实测 `apps/backend/tests/unit/backup.test.ts` 只覆盖 `backupSQLite`（`_deleteOldBackups` / 成功路径 / `db.backup` 失败 / `db.backup` 返回 undefined），**DuckDB 备份恢复零覆盖**；④ 新建 `tests/unit/{holding,scan}.test.ts` + 扩展 `core/tests/plugin.test.ts`；⑤ `backup.test.ts` 补 DuckDB 用例（`COPY TO PARQUET GZIP` → 恢复 → `COUNT(*)` 一致）；⑥ 前端用例依赖 T61 基建，另行交付 | ① §12.1 每项都有测试载体标注，无空白格<br>② `avg_cost_calc_5_scenarios` 5 个场景逐个命名<br>③ `state_machine_4_paths` 4 条路径（PASS/WARN/ERROR/SKIP）齐<br>④ `plugin_timeout_50ms` 覆盖 T88 的计时边界<br>⑤ **`backup_restore_duckdb` 用例真实跑通恢复并断言 `COUNT(*)` 相等**（不能只 mock）<br>⑥ SDD §12.5 的每个用例名在全仓可 grep 到 | 🔴 **F11 目前「通过」是无证据的** —— 测试文件不存在却未被 §12.1 捕获，说明验收标准与实际测试之间无映射。<br>⚠️ DuckDB 备份恢复测试会真读写文件，**必须用临时目录**，不得碰 `data/quotes.duckdb`。 |
| 🔒 **T92** | **候选池迁移改为「只打标记，不建关联」（B-7，PRD S5 明文）** | `routes/watch.ts:62-104` 的 promote 处理器**删除 `watch.ts:85-88` 的 INSERT 分支**：目标 `rel_type` 行不存在时**不再新建**，只把来源行打 `migrated_from_candidate=1`（配合 T50 的 `migrated_price_mode`）；已存在（含软删）时的「恢复 + 标记」分支保留；返回值语义改为 `{ marked: true, autoCreated: false }`，并**响应文案明示「不会自动加入自选」**；`tests/integration/watchPromote.test.ts:35` 的断言「watch 出现」**必须改为「watch 不出现」**；`watch.ts:96` 的 `logType: 'trade'` 是误用（这不是交易），改用合适的 log_type | ① promote 后 **watch 关联不存在**（核心断言，与当前行为相反）<br>② 来源 candidate 行 `migrated_from_candidate=1`<br>③ **目标已存在（含软删）时仍走恢复分支**，标记被正确置位<br>④ 事务性：标记失败时来源行不得被改<br>⑤ 响应体含 `autoCreated:false` 与中文提示<br>⑥ **`watchPromote.test.ts` 旧断言已被改写**（若仍断言「watch 出现」则本任务未完成） | 🔴 **PRD S5 整句强调「MVP 迁移只在候选记录上打标记，不会自动创建自选关联（用户需手动从候选池加入自选）」**，SDD §12.3 B6 同 —— 当前代码直接违反明文需求。<br>⚠️ `watch.ts:62` 的处理器由 `relType` 闭包复用，**同一份逻辑同时服务 `/api/watch/:asset_code/promote`（反向 watch→candidate）**；PRD S5 只约束 candidate→watch 方向，**反向是否也禁 INSERT 需一并裁决**（本任务默认两个方向都只打标记，更保守）。<br>⚠️ 与 T50 同改 promote 路由（`price_mode`），**建议同批**。 |
| 🔒 **T93** | **补齐插件契约字段（B-8，SDD §5.3「所有插件必须严格遵循」）** | ① `services/pluginEngine.ts:62-72` 的 `Plugin` 接口补 SDD §5.3 要求的缺失字段：`version` / `author` / `period` / `sub_category` / `complexity` / `defaultParams` / `chartOverlay`；**`paramSchema` 已有，SDD 另有的 `defaultParams` 与之语义重叠，需裁决是并存还是合并**（建议：`defaultParams` 为只读默认视图，`paramSchema[].default` 为实际来源，**禁止两处各写一份默认值**）<br>② `PluginSignal`（`:50-59`）：SDD 叫 `metrics`，代码叫 `params` —— 统一命名（建议改代码为 `metrics`，需同步 `signalService.ts` 落库与 T58 的 `metrics_json`）；`signalType` 的 `'ALERT'`（`:52`）**SDD §5.3 无此项**，裁决删除或补 SDD<br>③ `pluginEngine.ts:398-402` 的自定义插件字段映射函数同步补全，避免自定义插件缺字段时被静默填 `undefined`<br>④ 内置插件（`rsi_oversold` / `macd_cross`，`:85` / `:125`）补齐字段 | ① **「插件对象字段完备性」单测**：遍历 `getAllPlugins()` 全部插件，逐个断言 7 个新字段存在且类型正确<br>② **内置插件与自定义插件走同一断言**（不得对自定义插件放宽）<br>③ `defaultParams` 与 `paramSchema[].default` **一致性断言**（值必须相同，防两处漂移）<br>④ `PluginSignal` 字段名统一后，落库与前端断言同步通过 | 🔴 SDD §5.3 开篇写「**本节为插件引擎的核心设计契约，所有内置插件与自定义插件必须严格遵循**」—— 当前字段缺失近半。<br>⚠️ `paramSchema` → `defaultParams` 的取舍**必须一次定死**，否则后续每个插件都要在两处默认值上做取舍判断。<br>⚠️ `params` → `metrics` 改名会牵动 `signalService.ts` 与 T58 的 `metrics_json`，**建议与 T58 同批**。<br>⚠️ **建议与 T83 同批**：T83 新增 filter 插件时直接按补齐后的契约写，避免返工。 |
| 🔒 **T94** | **实现 `POST /api/strategy/reload`（B-13 裁决：属 MVP）+ §8 判定纠正** | ⚠️ **实测：底层能力已实装，本任务只是补路由壳**。已核对 `services/pluginEngine.ts`：`PLUGIN_ALLOWED_PATH = '/opt/invol/plugins/strategies'`（`:17`，与 AGENTS.md 一致）、`PLUGIN_FILENAME_RE`（`:185`）、`loadPluginsFromDir()`（`:201`）、`createPluginSandbox()`（`:291`，已用 Proxy 屏蔽 `globalThis` 并把 `global/process/require/module/exports/fetch/XMLHttpRequest` 置 `undefined`）、`getAllPlugins()`（`:412`）。**全仓 grep「reload」零命中 —— 缺的只有 admin HTTP 入口**。实现：① 新增 `POST /api/strategy/reload`（SDD §4.4:1267，**仅 admin**），调 `loadPluginsFromDir()` 后返回 `{ loaded: n, plugins: [...] }`；② **二次鉴权**（admin）+ 写 `system_log`（`logType: 'plugin_execute'`）；③ **单个插件加载失败不得影响已加载插件**（逐文件 try/catch 隔离，错误单独列出）；④ **§8 Out-of-Scope 表删除「插件热重载扫描自定义 .js → V2」这一条** —— 初稿引 AGENTS.md「只能放该目录且仅限 .js」当禁用依据，**那是路径/扩展名/eval 约束，不是功能禁令** | ① admin 调用 200，返回已加载插件列表<br>② **普通用户调用 → 403**<br>③ 目录不存在 → 返回 `loaded:0` 而非 500<br>④ **放一个语法错误的 .js → 其余插件仍正常加载**，响应里单独列出该文件错误<br>⑤ 放一个访问 `process.env` 的 .js → **沙盒内 `process` 为 `undefined`**，取不到值且不抛出未捕获异常<br>⑥ 放一个 `require('fs')` 的 .js → 同上被拒<br>⑦ **§8 表格中该条已删除**（若仍在则本任务未完成） | 🔴 **PRD M5「安装自己写的策略插件」+ SDD §4.4:1267 均属 MVP**，初稿误判为 V2。<br>✅ **好消息：不需要新建沙盒或加载器**，AGENTS.md 的三条硬约束（目录固定 / 仅 .js / 禁 eval）代码已全部满足，本任务工作量远低于初版估计（**0.5d**）。<br>⚠️ **路径口径仍待统一**：SDD §5.3 写 `/opt/invest/plugins/`，代码与 AGENTS.md 写 `/opt/invol/`（§13.3 S-8）—— 本任务以 **AGENTS.md 的 `/opt/invol/`** 为准，并同步修 SDD §5.3。 |

### Wave 2 — 前端基座（token + 基建 + 测试）

> 🚦 **出口门槛 G2**（§12.7）—— 重点是证明 **lint 不是空跑**（G2.2 反向验证）与 **CI Stage 2 真会阻断**（G2.5）。

> **这一波在所有历史计划里都是缺失的**。前端目前 0 测试、0 token、0 CSS、0 lint —— 不补这层，后面 5 个 Wave 的 UI 改动全无回归保护。

| ID | 任务 | 交付物 | 测试要点 | 卡点 |
|---|---|---|---|---|
| 🔒 **T61** | **前端测试基建 + 首批用例** | `apps/frontend` 加 `vitest@2.x`（**与 core/backend 同版本，DEC-3 不升级**）+ `jsdom` + `@testing-library/react` + `@vitest/coverage-v8`；`vitest.config.ts`；`test` 脚本；根 `package.json` `test` 串联 frontend；CI 加一步。首批用例覆盖：双口径 Tab 切换、收益曲线 bucket 分组、donut 角度计算、Review 3 态弹窗、信号键盘导航、**指标适配层对 golden 的断言**（SDD §12.5 F5 `kline_render` 入口） | ① CI 跑通；② 覆盖率 ≥60%；③ 全绿；④ **指标断言走 golden 不走快照** | ⚠️ AGENTS.md §5 写「Vitest 5.x」，实际仓库 core+backend 用 2.x。**DEC-3 已定暂不升级** → 本计划登记为已知偏差，建议在 AGENTS.md 把版本表述改为「与仓库实际版本对齐（当前 2.x）」，避免后续 agent 误升级导致配置分裂 |
| **T62** | **Design Token 层 + global.css** | 新建 `src/theme/tokens.ts`（`COLORS`/`SPACING`/`RADIUS`/`TYPO`/`MAX_WIDTH`/`Z`/`CHART`）按 `frontend_ux_v2.md` §2.4 建议值落地；`src/styles/global.css`（body 背景 `#f8fafc`、`box-sizing` reset、`:focus-visible` 全局 ring、`#root` 高度）；新增 `dangerButtonStyle`/`ghostButtonStyle`/`secondaryButtonStyle`/`buttonDisabledStyle`/`tableRowHoverStyle`；替换全部 raw hex | ① `tokens.ts` 导出无 raw hex 泄漏；② grep `#[0-9a-f]{6}` 在 `.tsx` 命中归零（token 文件除外）；③ 视觉回归截图对比 | ⚠️ `apps/frontend` 需引 `index.html` 引 CSS；不引第三方 CSS 框架（保持零依赖内联风格，仅加 1 个自有 css） |
| **T63** | **导航激活态 + 语义化 + a11y 基线** | `<Link>`→`<NavLink>` + `activeStyle`（浅蓝底 + 深蓝字 + 600 字重）；引入 `useLocation`；`<header>/<main>/<footer>` + 现有 2 个 `<nav>`；所有 `<label htmlFor>` + input `id`；`<th scope="col">`；`focusRingStyle` 应用到可聚焦元素；`aria-current="page"` | ① 每个页面导航项有可见高亮；② axe 核心规则 0 critical | 12 个表单/表格文件需逐个改 id，工作量偏碎 |
| **T64** | **错误码统一映射 + 会话过期体验** | 新建 `src/api/errorMessages.ts`：`Record<errorCode, 中文文案 + 操作建议>` 覆盖当前全部 20 个错误码；`api/client.ts` 统一走此映射；401 → 提示条 + `Navigate('/login', {state:{from}})` 保留路径（**需 T57 的 refresh**）；`Login` 落地为真实 `/login` 路由 | ① 20 个码各有中文文案；② 过期跳登录且登录后回原路径；③ 并发 401 只触发一次刷新（去重标志位） | T64 依赖 T57；若 T57 延后，先做错误码映射，401 部分留 stub |
| **T65** | **Loading / Empty / 禁用态组件化** | `components/{Spinner,EmptyState,ConfirmDialog}.tsx`；12 处文字「加载中...」全部替换；`Review` 统计空值渲染 `--` 而非 `0`；禁用态统一 `buttonDisabledStyle` | ① 无裸「加载中...」文本；② 空态有引导文案+动作按钮 | 依赖 T62 token |
| **T66** | **路由级代码分割 + 死代码清理** | `React.lazy + Suspense` 拆 `Kline`/`Admin`（SDD §2.12.5）；删 `types.ts` 或接入全页共享类型（消除类型漂移）；删 `_shared.tsx:142,153` 死导出、删 `TradeInput.tsx:106-107` 死逻辑；`maxWidth:1200` 单点化 | ① 首屏 chunk 不含 Kline；② `any` 从 ~25 降到 0（需先配 ESLint）；③ 无死导出 | `any` 清零要动全前端，建议与 T67-73 同 commit 收敛，不单独开任务 |
| 🔒 **T86** | **ESLint + Prettier + `lint`/`build` 脚本 + CI Stage 2（§13.4 B-6 裁决：补）** | ① 根 `.eslintrc.cjs`（或 flat config，按已装的 ESLint 大版本选）；**先确认 lint 相关依赖是否已存在，禁止擅自引入未评估的第三方库**（AGENTS.md §开发流程 9）<br>② TypeScript ESLint + `react-hooks` + `no-explicit-any`；`prettier` 规则与 `.prettierrc` 对齐，**不私自改格式化规则**（AGENTS.md §编码约束 6）<br>③ 根 `package.json` 补 `lint` / `lint:fix` / `build` 脚本；`build` 须验证 core→backend→frontend 三段产物顺序依赖（`.github/workflows/ci.yml` 已有顺序检查，纳入脚本）<br>④ `.github/workflows/ci.yml` 加 **Stage 2「Lint + TypeScript Check」**：`npm run lint` + 三个 workspace 的 `tsc --noEmit`<br>⑤ 存量违规分级：先以 `warn` 全量盘点一次，**只对新增代码强制 `error`**，存量登记进 §9.3 逐步收敛（避免一次性把 CI 打红） | ① `npm run lint` 可执行且退出码 0<br>② `npm run build` 三段产物齐备<br>③ CI Stage 2 步骤存在且失败会阻断<br>④ **故意写一个 `any` + 一处格式错误 → lint 必须失败**（证明规则真生效，不是空跑）<br>⑤ 存量违规清单落 §9.3（含文件数与条数） | 🔴 **T66「`any` 降到 0」与 E6「无死代码」的前置** —— 二者原本都以「需先配 ESLint」为前提，但此前无任务负责。<br>⚠️ 「Lint 失败阻断合入」是 SDD §12.6 明文阻断点，**CI 必须实装**而非只在本地跑。 |

### Wave 3 — Dashboard（PRD §5.3）

> 🚦 **出口门槛 G3**（§12.7）—— PRD §5.3 零 gap + F-D1~F-D6 关闭 + 375px 无横向溢出。

| ID | 任务 | 交付物 | 测试要点 | 卡点 |
|---|---|---|---|---|
| **T67** | **Dashboard 持仓页重写**（F-D1~F-D6 + ux_v2 §3.1 + 建议 A/B/C/D/E/F） | ① 总资产大字改市值（修 F-D1 数据 bug，`total_assets_*` 真正参与展示或删除死声明）；② 持仓改卡片网格（桌面 3 列/平板 2/手机 1，复用 T62 断点）；③ 每卡补 名称/现价/持仓/成本/盈亏/收益率/**仓位占比进度条**/**信号标记**（**建议 A**：批量 `IN` 查信号，需后端在 `/api/positions` enrich）；④ 卡片【买入】【卖出】→ **TradeForm Modal**（**建议 B**）；⑤ 排序（盈亏/收益率/仓位占比）+ 过滤（标的类型/行业）；⑥ 饼图支持点击下钻；⑦ **建议 D 今日动态概览卡（P0，ux_v2 §3.1.A-D）**：窄条时间线 —— 总资产变化（对比昨收）/ 今日信号 ▲▼· 统计 / 今日成交前 1-2 条 / 今日除权导入 / 重点关注（持仓+候选有信号），需后端 `/api/positions` enrich 加昨收 + `/api/signals` 加今日 count；⑧ **建议 C 标的详情 Modal**：点标的名弹窗（持仓概览 + 今日信号 + 最近交易 + K 线小图 + 「进入完整 K 线页」），小图复用 Kline Canvas；⑨ **建议 E 信号→交易一键链路**：持仓卡信号标记 hover → Mini-Menu（插件名+参数摘要+【立即买入/卖出】）→ 触发 Modal 且全部字段预填（代码/类型/现价/理由「MACD 金叉买入 (日期)」） | ① 卡片字段齐全断言；② 排序三档正确；③ Modal 预填代码+类型；④ 进度条宽度 = weight%；⑤ 净值与手算一致；⑥ **今日动态卡 5 个数据块各自非空/有降级文案**；⑦ **建议 E 预填后 5 个字段值正确**；⑧ 详情 Modal 含 K 线小图且 120 天默认 | ③⑦ 需后端 `/api/positions` 加 signal enrich + 昨收（归入 T67 内提后端改动或 T60 一并）；⑥ 行业源依赖 T55。⚠️ ⑦⑧⑨ 合计 +4.5d，ux_v2 原估 |

### Wave 4 — TradeInput（§5.4）+ Review（§5.5）

> 🚦 **出口门槛 G4**（§12.7）—— PRD §5.4/§5.5 零 gap + 复盘三态 + `trade_time` 预检生效。

| ID | 任务 | 交付物 | 测试要点 | 卡点 |
|---|---|---|---|---|
| **T68** | **TradeInput 全量重写**（F-T1~F-T6 + ux_v2 §3.2 + §6 Phase 1） | ① 交易类型改 Tab 组：主 Tab 买入/加仓/减仓/清仓 + 「除权补充」次级入口（展开 dividend/bonus/transfer）；② **label 中文化：`trade_reason` → 「操作理由」（P0，ux_v2 §3.2-5；实测 `TradeInput.tsx:313` 仍是英文变量名）**；③ `trade_reason` required + 空值阻止提交 + 字段级红框 + 错误文案紧贴字段下方；④ **实时预估面板**（本次金额/手续费/新均价/新数量，监听 qty/price/fee）—— 移动加权成本公式走 T51 适配层；⑤ 减仓/清仓实时校验 `GET /api/positions/:asset_code`，超持仓红字 + 禁用按钮；⑥ 除权补充 Tab 理由自动填「人工补充 - {除权日} {类型}」且 disabled；⑦ 预设标签按钮（策略触发/止损/抄底/长期持有，按交易类型动态）；⑧ **响应式（ux_v2 §6 Phase 1）**：`formRowStyle` 在 `<768px` 垂直堆叠（label 在 input 上方，取消 `minWidth:80`），实测当前 `formRowStyle` 无 `flexDirection` | ① 5+2 Tab 切换字段联动；② **所有 label 为中文无英文变量名残留**（含 trade_reason）；③ 空理由提交被拦；④ 预估新均价与 core golden 一致；⑤ 超持仓按钮 disabled；⑥ 除权理由不可编辑；⑦ 标签按类型出现/消失；⑧ **375px 视口下 formRow 垂直排列无横向溢出** | ④ 若 DEC-6 选 (b) 则预估需复制一份适配；⑧ 依赖 T62 的断点常量 |
| **T69** | **Review 补全 + bug 修复**（F-R1/F-R2 + ux_v2 §3.3-3/§3.3-4 + 附带缺陷） | ① 日期范围筛选（start/end → 已有后端参数）；② **4 色 pill 标签**（未复盘灰/系统信号绿/主观决策橙/止损红）+ 图例；③ **修 `setPage` 缺失**（`Review.tsx:155,428,430`）；④ 交易类型筛选项改用统一 `TRADE_TYPE_LABEL` 并统一 `transfer` 命名；⑤ 收益曲线悬浮 tooltip 显示具体数值；⑥ **筛选即时生效（ux_v2 §3.3-3）**：4 个 select 的 `onChange` 加 300ms debounce 自动重查，**删除「筛选」按钮**（实测 `Review.tsx:356` 仍为手动触发）；⑦ **三态字段选中态视觉加强（ux_v2 §3.3-4）**：选中按钮加 `fontWeight:600` + `borderWidth:2px`（当前浅蓝 `#dbeafe`/浅红 `#fee2e2` 与未选中差异过小） | ① 日期范围过滤生效；② 4 色映射正确（止损红 > 系统绿 > 主观橙 > 未复盘灰）；③ 分页可推进；④ tooltip 值与曲线数据一致；⑤ **改 select 后 300ms 内自动出结果，无需点按钮**；⑥ 选中态与未选中态视觉可区分 | ⑥ 需防抖组件（不引第三方 debounce 库，10 行自实现） |

### Wave 5 — Kline（§5.1/§5.2）+ Signals

> 🚦 **出口门槛 G5**（§12.7）—— **SDD §12.5 功能组 F1-F8 全部 PASS（非抽查）** + 指标与 golden 双端误差 = 0。

| ID | 任务 | 交付物 | 测试要点 | 卡点 |
|---|---|---|---|---|
| **T70** | **Kline 交互增强**（F-K1~F-K8） | ① fq 四值（依赖 T53）；② MA60 叠加 + **MA 开关 checkbox**；③ 副图 Tab（MACD/RSI/KDJ/**成交量** + 「全部」），桌面默认并排、手机单图（依赖 T51/T52）；④ **十字光标 + OHLCV+指标+信号悬浮窗**（mousemove → 索引 → 十字虚线 + 信息窗）；⑤ **周 K / 月 K**（基于日线聚合，前端 reduce 即可，不动后端）；⑥ 信号标记 **hover tooltip**（方向+强度+指标明细，依赖 P0-6 的 `metrics_json`）；⑦ 用 `ResizeObserver` 替代 window resize，修监听器泄漏 | ① 四种 fq 切换；② KDJ 副图绘制；③ 十字光标索引计算正确（含边界）；④ 周/月 K 聚合与后端日线一致；⑤ 监听器只注册 1 次 | 依赖 T51/T52/T53/T58 三波后端 |
| 🔓 **T71** | **Kline 指标参数实时生效**（DEC-1 已解锁） | MA 周期编辑、MACD(12,26,9)/RSI(period, 超买超卖)/KDJ(N,M1,M2) 参数面板 → 改值即时重绘，**零网络请求** | ① 改 period 后重绘 < 300ms（PRD §6.3）；② 前端与后端对同一 `(closes, params)` 结果**逐位相同**（走 golden）；③ **柱值 ×2 与 A 股约定一致**（§4.3.2 回归断言） | ✅ **DEC-1 已决议：前端本地算**。实现路径取决于 DEC-6：**(a)** 前端复用 `@invest/core` 适配层（推荐，6 行形状变换只写一遍）；**(b)** 前端直接用库并复制一份变换。**两条路都不含算法实现**。前置依赖 T51 golden + T52 KDJ |
| **T72** | **Signals 页增强** | ① 进页自动加载（今日+全部策略+全部方向），删「请点击查询」空态；② 方向彩色 pill + 强度进度条/星 + 标签 tag；③ **分页**（后端已返回 `pagination` + 接受 `page`，前端当前丢弃）；④ 筛选改 debounce 即时生效；⑤ 加 `asset_code` 过滤（依赖 T54） | ① 自动加载触发一次；② 分页可用；③ 筛选即时生效 | — |

### Wave 6 — StockScan（§5.6）+ 候选池

> 🚦 **出口门槛 G6**（§12.7）—— **`totalCandidates > 0`**（当前恒为 0，P0-11 判定锚点）+ PE2 5000 标的 ≤3s。

| ID | 任务 | 交付物 | 测试要点 | 卡点 |
|---|---|---|---|---|
| **T73** | **StockScan 全量重写**（F-S1~F-S5 + 附带缺陷） | ① **参数动态表单复用 `Settings.tsx` 的 `renderField`**（抽到 `components/PluginParamForm.tsx` 共用），保留「JSON 模式」切换；② 公共过滤区：标的类型/排除ST/成交额下限/行业/市值（依赖 T55）；③ **强制 ≤100**（移除 500 上限）；④ 结果表补 名称/现价/涨跌幅/成交额 + **分页**；⑤ **批量加入候选池**（checkbox + 全选 + 批量按钮，依赖 T56）；⑥ 修 409 判断位置（移到 catch） | ① 参数表单按 `paramSchema` 渲染且校验生效；② 各公共过滤生效；③ 上限 100 不可调；④ 批量加入成功/重复提示正确 | 名称列需放开 `raw_symbol_name`（T55 一并处理） |
| **T74** | **候选池页 `/candidates`**（F-G3） | 新页面 + 路由 + Navbar/移动 Tab 入口；候选列表（代码/名称/基准价/现价/相对收益/跟踪天数/最新信号）；自选列表分区；【迁移自选】按钮带 base/current 价格模式选择（依赖 T50）；【移除】软删；批量操作 | ① 基准价与加入日收盘价一致；② base/current 两种迁移模式可区分；③ 移除后 watch 不受影响（三列独立共存） | PRD §5.8 #7 要求候选池在桌面导航 |

### Wave 7 — Admin（§5.7）+ 全局导航（§5.8）

> 🚦 **出口门槛 G7**（§12.7）—— **DuckDB 备份恢复真实跑通**（不得 mock）+ **12 项校验卡片真实渲染 12 条**。

| ID | 任务 | 交付物 | 测试要点 | 卡点 |
|---|---|---|---|---|
| **T75** | **Admin 补全**（F-A1~F-A3 + ux_v2 §4.3） | ① system_log **日期范围 + 类型下拉 + level 下拉**（依赖 T59）；② **备份列表**（日期+体积）+ 手动备份 + **恢复**（二次确认弹窗，POST `{confirm:true}`）；③ **用户角色管理**（用户列表 + 升级/降级按钮，admin 仅 1 人约束提示）；④ `alert()` → 内联状态条 + **[重试] 按钮**（ux_v2 §4.3）；⑤ 手动触发行情更新按钮加二次确认（PRD §5.7 明文） | ① 三类筛选正确；② 恢复前二次确认且 `confirm:true` 必传；③ 降级自己被拒；④ 后端 3 个死路由全部接通；⑤ **无 `alert()` 阻塞式弹窗残留** | 角色管理按钮的二次确认（PRD §5.9 管理员双重鉴权） |
| **T76** | **桌面侧边导航 + 全站 a11y 收尾 + 响应式基础**（F-G2/F-G1/F-A11~F-A18 + ux_v2 §6 Phase 1） | ① **桌面端左侧导航栏**（持仓/K线/选股/复盘/候选池/设置，PRD §5.8 #7）；`<1024px` 折叠为移动 Tab 栏；② 移动 Tab 补「候选池/设置」；③ **`<768px` Navbar 折叠 hamburger 菜单**（ux_v2 §6 Phase 1，实测当前只有 MobileTabBar、无折叠菜单）；④ **容器改 fluid**（消除 `App.tsx:19` 与 `_shared.tsx:146` 双份固定 `maxWidth:1200`，改 `maxWidth` + `width:100%` + 断点 padding）；⑤ `aria-live="polite"` 包异步结果区；`aria-expanded`（Admin 卡片/Settings 折叠/移动 Tab/hamburger）；`role="dialog"` + 焦点锁定 + ESC 关闭（Review 弹窗、TradeForm Modal、ConfirmDialog）；`aria-busy` on loading；⑥ 隐私声明上设置页（PRD §5.9）；插件安全承诺文案上设置页插件区；⑦ **h1/h2 层级统一**（ux_v2 §3.4-1，实测 `Kline.tsx:362`、`StockScan.tsx:197` 仍是 `<h2>`，全站统一 `titleStyle` + `h1`）；⑧ **导航按业务流程重排**（ux_v2 §1-2：仪表盘 → 交易录入 → 条件选股 → K线 → 策略信号 → 复盘 → 候选池 → 设置 → 管理员） | ① 三断点布局正确；② axe 核心规则 0 critical；③ 键盘可完整走查主流程；④ **全站无 `maxWidth:1200` 硬编码**；⑤ **375px 视口无横向滚动条**；⑥ 全站 h1 层级一致 | ③④ 依赖 T62 的 `global.css` 与断点常量；⑦ 与 T63 语义化改造同批做 |
| **T79** ⚠️新增 | **响应式 Phase 2/3 + P2 体验收尾**（ux_v2 §6 Phase 2/3 + §1-3 + §3-1-4 + §3-1-5 + 建议 F） | ① **表格手机端改卡片列表**（Review 交易列表 / Signals / Admin 日志 在 `<768px` 每行变一卡片）；② **touch 友好尺寸**（可点击元素 ≥ 44×44px，`@media (pointer: coarse)`）；③ **信号空状态引导**（ux_v2 §3-1-4：文案改「今日暂无策略信号」+ 浅色小字「收盘后 **17:02** 自动运行信号生成」+ 管理员额外显示【立即运行信号】跳 Admin）。⚠️ **时刻必须是 17:02 而非 17:03** —— SDD §5.1 与 `scheduler.ts:126`（`'2 17 * * 1-5'`）均为 17:02 信号生成，17:03 是除权导入；初稿误写 17:03 属**面向用户的错误文案**，会把用户引到错误时间 |；④ **面包屑**（ux_v2 §1-3，Kline 页与标的详情 Modal 等深层页面）；⑤ **Dashboard 概览页重定位**（ux_v2 §3-1-5：持仓/信号/日志三卡片堆叠 → 资产汇总 / 今日快捷操作区 / 持仓 Top3 / 策略信号 Top5，信号详情交给 Signals 页）；⑥ **候选池联动面板**（ux_v2 建议 F：Dashboard 底部可折叠窄条「候选池 N 只 · M 只有信号」，展开 Top 5 按「有信号优先 → 跟踪时间长优先」，每只含 现价+信号+跟踪天数+【买入】→ 触发 TradeForm Modal 预填） | ① 375px 下表格以卡片渲染且可读；② 触摸目标尺寸断言；③ 空态三要素齐全；④ 深层页面有面包屑；⑤ 首屏只呈现概览四块；⑥ 候选池面板折叠/展开 + 买入联动预填 | ⑤⑥ 依赖 T67（信号 enrich）与 T74（候选池 API）。本任务整体**可后置，不阻塞 MVP 验收** |
| **T77** | **smoke-m5.test.ts + 前端 E2E** | API 级：全流程再走一遍（注册→交易 7 类型→持仓→K 线四 fq→signals symbol 过滤→选股公共过滤→批量候选→复盘 4 色→插件参数→备份恢复→角色管理）；前端级：Playwright 骨架 + 3 条关键路径（登录→记一笔→看持仓；改 RSI 参数重绘；减仓超持仓禁用） | 全部 PASS → `test:` commit | 前端 E2E 引入 Playwright 需评估 CI 成本；可先只做 API 级，前端 E2E 标 V2 |

### Wave 8 — 收尾验收

> 🚦 **出口门槛 G8**（§12.7）—— G1-G7 全 PASS 且各有落档文件，方可进入 T78。

| ID | 任务 | 交付物 | 测试要点 |
|---|---|---|---|
| 🔒 **T86b** | **恢复 SDD §12.2 覆盖率门槛 + 90% 阻断 Gate（§13.4 B-5 裁决：暂缓执行，届时补齐）** | ① 把 §12.4 E3 从「frontend ≥60% / backend 不低于当前基线」改回 **SDD §12.2 原值**：核心算法 ≥90% / C1-C12 校验 ≥85% / 插件引擎 ≥90% / 前端 ≥70%<br>② `.github/workflows/ci.yml` 恢复 SDD §12.6 的 **90% 阻断 Gate**（「核心算法 + 插件引擎 <90% 阻断合入」）<br>③ 补齐到门槛所需的测试（缺口清单由 T60/T61 盘点结果给出）<br>④ 同步修回 SDD §12.6 判定规则中被本轮下调的部分 | ① `npm run test:coverage` 输出满足全部门槛<br>② **故意把某模块覆盖率压到 89% → CI 必须红**<br>③ §12.6 判定规则恢复覆盖率条款<br>④ B-5 从 §13.1 关闭 | ⚠️ **这是「暂缓」不是「取消」** —— B-5 裁决明确「先下调，后面再补」，本任务是补的那一步。**未完成前 §12.6 判定规则不因覆盖率判 FAIL**（已按裁决调整）。<br>🔒 依赖 T60 / T61 的测试存量，否则无从判断缺口。 |
| **T78** | **T-GAP-5 全栈最终审计 + 文档**（验收标准见 **§12**，判定规则见 §12.6） | `docs/audit/fullstack-audit-v2.md`：① Requirements §4.2 In-Scope **14 项**逐项；② Requirements §5.1-5.5 业务规则逐条；③ PRD §5.1-5.9 **交互 9 节**逐条；④ SDD §12.5 **功能 11 + 性能 6 + 安全 6 + 合规 1** 共 24 项；⑤ AGENTS.md 硬约束（含 §4 修订后的新表述）；⑥ Out-Scope 未被偷跑；⑦ 性能指标 PE1-PE6 实测数据；⑧ §13 全部偏差登记的关闭状态 | 按 §12.6 判定规则给出 PASS/COND/FAIL → PASS 才打 tag `M4`；任一 FAIL 不能交付 |

---

## 6. 任务汇总与工作量

| Wave | 任务 | 范围 | 后端 | core | 前端 | 小计 |
|------|------|------|------|------|------|------|
| 1 | T49-T60 + T80-T94 | 数据与规则纠偏 + **指标库接入** + DuckDB 三修 + **超卖校验** + filter 插件 + 测试隔离 + **C4/C5 + 交易追加语义 + 插件计时边界 + 响应封装 + 路由对齐 + 测试映射补齐 + 候选池迁移纠正 + 插件契约字段 + reload 路由** | 19.0d | **3.5d** | 0.8d | **23.3d** |
| 2 | T61-T66 + **T86** | 前端基座 + **lint/build 基建** | **0.5d** | 0 | **7.5d** | **8.0d** |
| 3 | T67 | Dashboard（含 ux_v2 建议 C/D/E） | 0.5d | 0 | **6.5d** | **7.0d** |
| 4 | T68-T69 | TradeInput + Review | 0 | 0 | 3.2d | **3.2d** |
| 5 | T70-T72 | Kline + Signals | 0 | 0 | 3.5d | **3.5d** |
| 6 | T73-T74 | StockScan + 候选池 | 0 | 0 | 2.5d | **2.5d** |
| 7 | T75-T76 | Admin + 全局导航/a11y/响应式基础 | 0 | 0 | **4.3d** | **4.3d** |
| 8 | T77-T78 + **T86b** + **T89b** | smoke-m5 + **覆盖率门槛恢复** + **删 `success` 字段** + 最终审计 | **1.0d** | 0 | 0.5d | **2.0d** |
| 9 | **T79** ⚠️ | **响应式 Phase 2/3 + P2 体验收尾**（可后置） | 0 | 0 | **4.2d** | **4.2d** |
| | **合计** | **48 个任务**（T89 拆为 T89a/T89b） | **21.0d** | **3.5d** | **32.5d** | **~60 人天** |

> **已完成**：T80（DuckDB 泄漏 + 并发 + BigInt/DATE，0.3d）、T82（已并入 T80 关闭）
> **Wave 1 后续未开始**：T49 加仓 / T50 候选池基准价 / T51 指标库 / T52 KDJ / T53 K线路由 / T54 signals 过滤 / T55 公共过滤 / T56 批量候选 / T57 auth / T58 落库字段 / T59 日志范围 / T60 测试补齐 / T81 测试隔离 / T83 filter 插件 1.0d / T84 超卖校验 0.5d / **T85 C4/C5 校验 1.0d** / **T87 交易追加语义 + trade_time 1.0d** / **T88 插件计时边界 0.5d** / **T89a envelope+错误码归一+前端36处适配 2.0d** / **T90 路由对齐 SDD §4.4 1.5d** / **T91 测试映射 + 缺失测试文件 + F11 DuckDB 用例 2.0d** / **T92 候选池迁移纠正 0.5d** / **T93 插件契约字段 1.0d** / **T94 reload 路由壳 0.5d**
> **Wave 2 新增**：**T86 lint/build 基建 1.5d**；**Wave 8 新增**：**T86b 覆盖率门槛恢复 0.5d**（工作量随 T60/T61 缺口浮动）
> ⚠️ **T89a + T90 必须同批**（都改全部路由文件，共 63 处 `reply.code(...)`），且**前端 36 处改读 `message` 需一并交付**，否则前端全量 404 / 白屏。**T89b（删 `success`）在 Wave 8，且必须等 T61 前端测试基座落地**。
> ⚠️ **T91 的工作量随 T60/T61 的测试存量浮动** —— 若 T60 已建 `scan.test.ts` 则本任务减 0.5d。

> **v2 plan → v2 plan（含 ux_v2 补全）增量**：`docs/archive/frontend_ux_v2_SUPERSEDED-2026-10-16.md` 交叉审计发现 13 项初稿遗漏，已全部并入：
> - **P0 ×2**：T68 ②（`trade_reason` label 中文化，ux_v2 §3.2-5，实测未做）、T67 ⑦（今日动态概览卡，ux_v2 建议 D，初稿完全漏掉）
> - **P0 响应式 ×3**：T76 ③（hamburger）、T76 ④（容器 fluid）、T68 ⑧（formRow 垂直堆叠）—— ux_v2 §6 Phase 1，初稿只做了持仓卡片响应式
> - **P1 ×6**：T67 ⑧（标的详情 Modal + K线小图，建议 C）、T67 ⑨（信号→交易一键链路，建议 E）、T69 ⑥（筛选 debounce，即时生效）、T79 ①（表格手机端卡片化）、T79 ⑥（候选池联动面板，建议 F）、T79 ⑤（Dashboard 概览页重定位）
> - **P2 ×4**：T69 ⑦（三态选中态视觉）、T76 ⑦（h1/h2 统一）、T76 ⑧（导航按流程重排）、T79 ②③④（touch 尺寸 / 面包屑 / 信号空态文案）
>
> ⚠️ **工作量从 31.6 人天增至 ~42 人天**，主因是 T67 从 2.0d 涨到 7.0d（ux_v2 建议 C+D+E 合计 +4.5d，其中建议 D 是 P0）。
>
> **与历史估算对比**：`frontend-gap-audit-2026-10-16.md` 估 8.5 人天（基于失效基线，且未发现 8 项 P0 后端缺陷）、`frontend_ux_v2.md` Tier1 估 17.6 人天（未含响应式 Phase 1 的 3.0d，也未含前端基座）。本计划把两者合并去重后为 42 人天。

**并行压缩建议**（单人开发 → 若两人）：
- Wave 1 内 T49/T50/T56（数据规则）与 T51/T52（指标库）无相互依赖，可拆 2 人并行
- Wave 1 的 T57/T58/T59（后端功能）与 Wave 2（前端基座）完全无依赖，可全程并行
- **T79 整体后置**，不进入关键路径
- **T86（lint/build 基建）可与 Wave 1 全程并行**，且是 T66 的前置
- **T85 / T87 / T88 是 §13.4 裁决后新增的三项阻断修复，均在 Wave 1 内**，建议与 T84 同批开工
- 压缩后关键路径约 **34 人天**

**建议的最小可交付切片**（DEC-11 已定：**先做切片 A**）：
- **切片 A = W1 + W2 + W7** = T49-T66 + T75-T76 + **T80-T88（含 T86/T86b）** = **~28 人天**
  交付「业务规则正确（7 种类型 / 候选池基准价 / 信号落库 / **同日分笔交易可追加**）+ **12 项校验齐备** + **信号插件不再全超时** + 指标口径统一（库 + golden）+ 前端有回归保护（测试 + token + a11y + **lint 阻断**）+ 管理员功能齐全（日志过滤 / 备份恢复 / 角色管理）+ 桌面侧导航」
- **切片 B = W3 + W4 + W5 + W6** = T67-T74 ≈ **16 人天**：Dashboard 全量（含 4 个建议）/ 交易录入 / 复盘 / K 线 / 选股 / 候选池页
- **切片 C = W8 + W9** = T77-T79 ≈ **5.2 人天**（T86b 的覆盖率恢复若未做完，顺延到切片 C）

---

## 7. 依赖图

```
T80(DuckDB 泄漏)─✅已完成─┬─→ T82(BigInt 序列化)─┬─→ 一切依赖股票行情的验证
                          │                      ├─→ 浏览器动态审计（§11 已完成首轮）
                          │                      └─→ F-K1~F-K9 可动态验证
T88(插件 50ms 计时边界)─────────→ T83(filter 选股插件)──┴─→ T55(公共过滤)→ T73(StockScan)
                                                          ※ 无 T83 则 T73 无法验收

T85(C4/C5 校验)─────────────┐
T87(trade_time+UNIQUE 追加)───┼─→ T49(加仓7种)─┐
T84(超卖时点校验)─────────────┘               │
T89a(envelope+错误码归一)──→ T90(路由对齐 SDD §4.4) ┘
T50(基准价)─────────────────────────────────┼─→ T73(StockScan)─┐
T51(指标库+适配+golden)─┬→ T52(KDJ+布林)──→ T53(K线路由)──┐
                        ├→ T70(Kline 交互)──────────────┤
T54(signal 过滤)────────┼→ T72(Signals)────────────────┤
T55(公共过滤)───────────┼→ T73                          │
T56(批量候选)───────────┼→ T73                          │
T57(auth register/refresh)─┬→ T64(错误码+401 会话过期)   │
T58(落库 metrics_json)────┴→ T70(Kline 信号 hover)      │
T59(system-log 范围+datacheck/trigger)─┬→ T75(Admin)          │
T60(后端测试+smoke隔离+持仓性能)───┼→ T81(测试隔离)→ T77  │
T81(测试隔离修复)──────────────────┴→ T77                 │
                                  T60/T61 → T86b(覆盖率门槛恢复) │
                                                               │
T86(lint/build 基建+CI Stage 2)─┬─→ T66(代码分割+any 清零)  │
T61(前端测试基建, vitest 2.x)─┬─→ T62(token+global.css)─┬─→ T65(Loading/Empty)┐
T63(导航激活+语义化+a11y)────┤                         ├──→ T67(Dashboard)───┤
T64(错误码映射)──────────────┴─────────────────────────┼──→ T68(TradeInput)───┤
                                                       ├──→ T69(Review)──────┤
                                                       ├──→ T70(Kline)──────┤
                                                       ├──→ T72(Signals)────┤
                                                       └──→ T73/T74/T75/T76 ─┤
                                                                              ↓
DEC-1(已定) ──→ T51 适配层 ──→ T71(Kline 参数实时生效)
DEC-6(待定) ──→ 决定 T71 是 import core 适配层 还是 前端复制适配
DEC-12(已定, §13.4) ──→ T85-T94
```

**数据正确性三角**（`T84 + T87 → T49`，三者必须有序）：`T84` 修时点超卖、`T87` 修同日分笔被拒与成交时刻、`T49` 才把 `sell` 改名 `reduce` 并改 CHECK 白名单。三者同改 `user_trade_record` DDL 与持仓回放分支，**顺序错会把已知漏洞换个名字保留**。

**插件链**：`T88 → T83`。T88 修正 50ms 计时边界后，T83 新增的 filter 插件才会在正确口径下交付；否则新插件会重蹈「100% 超时」的覆辙。

**契约链**：`T89a + T90`（必须同批）→ **前端 36 处改读 `message`** → **`T89b`（Wave 8，删 `success`）**。前两环改全部 63 处 `reply.code(...)` 与路由路径，是 Wave 1 里**风险面最广**的一段；最后一环是唯一破坏性变更，**必须等 T61 前端测试基座落地后才能做**。

**关键路径**：`T51 → T52 → T53 → T70 → T77 → T78`（约 11.5 人天）。T51 是整条链的咽喉 —— 它必须在 T53/T70 之前落地，因为 K 线路由和 Kline 组件都直接消费 `core` 的指标适配层输出（`routes/kline.ts` 算 ma60/rsi/macd，前端 `Kline.tsx` 按下标对齐）。但 T51 本身**不是高风险**（§4.3.4：适配层只有数组补齐 + 柱值 ×2 两处形状/约定变换，不含算法实现）。

**次关键路径**：`T60 → T81 → T77`（测试链）。T80 已完成并解除了行情可用性阻塞，是 T53/T55/T70 能在真实数据上验证的前提。

**新增前置**：`T84 → T49` —— 两者都改 `positionCalculator.ts` / `movingWeightedCost.ts` 的同一批 `switch` 分支。**必须 T84 先做或同期做**，否则在「超卖不被拦截」的前提下把 `sell` 改名 `reduce`，等于把一个已知漏洞换个名字保留下来。

---

## 8. Out-of-Scope 确认（沿用 AGENTS.md，本计划不实现）

| 项 | 判定 |
|---|-----|
| 暗色模式（PRD §5.8 #8 自带「MVP 可选」） | V2，**不做** |
| 移动端底部 Tab 栏 | **已做**（`_shared.tsx:83-124`），本计划只补候选池/设置入口 |
| 周 K / 月 K | **MVP 做**（PRD §5.2 明文，PRD §5.2 括注「MVP 仅日线」指行情采集非图表周期）→ 归入 T70 |
| 收益曲线 ECharts/Recharts | 沿用手写 SVG + Canvas，**不引第三方图表库** |
| ~~插件运行时热重载扫描自定义 `.js`~~ | ✅ **撤销 V2 判定 —— 属 MVP**（§13.4 B-13 裁决）。初稿引 AGENTS.md「只能放该目录且仅限 `.js`；禁止动态 eval」当禁用依据是**误读**：那是**路径/扩展名/eval 约束，不是功能禁令**。SDD §4.4:1267 列了 `POST /api/strategy/reload`，PRD M5 要求「安装自己写的策略插件」→ 归入 **T94**。实测沙盒与加载器已实装（`pluginEngine.ts` 的 `createPluginSandbox` / `loadPluginsFromDir` / `PLUGIN_ALLOWED_PATH`），**T94 只补 admin 路由壳** |
| 分钟 K / 盘中实时 / 实盘下单 / 小程序 / 云函数 | V2+ |
| `schema_migrations` 迁移表 | 禁止，继续 `CREATE TABLE IF NOT EXISTS` + 幂等 ALTER |

---

## 9. 决策台账

### 9.1 已锁定（2026-10-17，项目所有者拍板）

| # | 决策 | 落地方式 | 影响任务 |
|---|------|---------|---------|
| **DEC-1** | **前后端统一用 `fast-technical-indicators@1.1.6`**（不使用手写指标），精确锁版本 | 见 §4。前端本地算指标 → 满足 PRD §5.2「零网络请求」+ §6.3「≤300ms」；前端不 import core → AGENTS.md §3 禁令原文保持有效 | T51/T52/T71 解锁 |
| **DEC-2** | **7 种交易类型严格对齐 Requirements §5.1**：DDL 白名单 `(buy, add, reduce, clear, dividend, bonus, transfer)`，**移除 `sell`、加入 `add`** | 含一次性数据订正（历史 `sell` → `reduce`，语义等价） | T49 |
| **DEC-3** | **暂不升级 Vitest**，前端跟随仓库现状用 2.x | AGENTS.md §5 的「Vitest 5.x」表述与实际不符，登记为已知偏差；建议后续统一改 AGENTS.md 表述而非升版本 | T61 |
| **DEC-4** | **修订 SDD §3.3**，开放 `raw_symbol_name` + `raw_tdx_blocks_info`/`_member` | ✅ **本次已改**（见 SDD.md §3.3「MVP 访问边界」变更记录）。原标注与代码不符 —— `routes/symbolSearch.ts:29` 与 validator C3 早已在用 | T55/T73 |
| **DEC-5** | **性能实测环境**：需一台已执行 `tdx2db init` 的服务器 | 若无，T78 的 **PE1-PE5** 标「未实测」，不得宣称 PASS（PE6 由单测覆盖，不受此限） | T78 |
| **DEC-9** | **开发库 `data/business.db` 直接清空重建**，不写 `sell` 数据订正脚本 | 实测确认该库为 **smoke/集成测试污染**：5 笔交易 `trade_reason` 全为「smoke买入」「集成测试买入」「dup1」，35 个用户全为 `int_admin`/`seed_*`，2 条候选基准价均为 NULL，无真实业务数据 | T49 |
| **DEC-10** | **`/api/auth/register` 与 `/api/auth/refresh` 两个都补齐** | 严格遵循 SDD §4.4 + PRD D5。**注意：不回退 `cba9556` 对 `/seed` 的安全加固** —— register 是新增路由，与 seed 加固并存 | T57 |
| **DEC-11** | **先做切片 A（W1 + W2 + W7）** = T49-T66 + T75-T76 + **T80-T88（含 T86/T86b）**，约 **28 人天** | W3/W4/W5/W6/W8 的功能部分暂缓。切片 A 交付「业务规则正确（7 类型 / 同日分笔可追加 / 12 项校验 / 信号不超时）+ 指标口径统一 + 前端有回归保护 + lint 阻断 + 管理员功能齐全」，是 MVP 验收信任度最高的组合 | 全部 |
| **DEC-12** | **§13 所有者裁决（2026-10-17，共 13 项阻断全裁）**：B-1 实现 C4/C5；B-3 插件 50ms **不计入**行情查询；B-4 补测试映射与缺失测试；B-5 覆盖率门槛**暂缓下调、由 T86b 补回**；B-6 **补 Wave 2 lint 任务**；B-7 候选池迁移**只打标记不建关联**；B-8 **补齐插件契约字段**；B-9 **改代码**采纳 SDD §4.2 envelope；B-10 `HOLDING_INSUFFICIENT` 用 **409**；B-11 交易改**追加** + `trade_time` 进主键（**份额不进**）；B-12 路由**以 SDD §4.4 为准**；B-13 `/api/strategy/reload` **属 MVP** | 裁决优先于本计划此前的任何推断；对应 T85-T94。**§13.5 裁决收口** | T85-T94 |
| **DEC-12** | **过期审计文档归档到 `docs/archive/`** + 顶部加失效声明横幅 | ✅ **本次已执行**：`frontend_ux_v2.md` → `docs/archive/frontend_ux_v2_SUPERSEDED-2026-10-16.md`；`frontend-gap-audit-2026-10-16.md` → `docs/archive/frontend-gap-audit_SUPERSEDED-2026-10-16.md`。两份均加了失效原因 + 仍有效部分 + 指向本文档的链接 | — |

### 9.2 待确认

| # | 决策 | 背景 | 建议 |
|---|------|------|------|
| **DEC-6** | **适配层放 core 还是前端各写一份** | §4.3.4：适配层只有「数组补齐 5 行 + 柱值 ×2 1 行」，**不实现算法**。放 core 则两处复用一份；各写一份则 6 行写两遍，日后改约定要记得改两处 | **放 core**（窄化放开 AGENTS.md §3 只允许 import 纯算法函数，仍禁 `node:*` 与 I/O）。`packages/core` 本就零依赖、ESM+CJS+d.ts 齐全，Vite 可直接打包。**分量：低，是放置决策不是风险决策**（初稿判断已修正） |
| **DEC-7** | **AGENTS.md 同步修订**（§4.5） | ① core「零业务依赖」→ 需为纯数学指标库开口子，否则后续 agent 可能「修复」掉这个依赖；② 「口径一致性靠 golden」→ 主保障已是「同库同版本锁定」，golden 降级为回归网 | 建议一并修订。AGENTS.md 是最高约束文件，本计划不擅自改 |
| **DEC-8** | **MACD warm-up 瞬态是否需要数据订正** | §4.3.1：EMA 播种不同导致 bar<120 区间有瞬态，可能让 `macd_cross` 的**已持久化信号** `trade_date` 漂移 | 建议**接受漂移 + 归档**（`docs/adr/` 记口径变更），不做数据订正。真实日线序列震荡频率低，漂移概率低；回放实测后若漂移 >5 条再重新评估 |

### 9.3 已知偏差登记（不改需求文档，写入验收结论）

| 偏差 | 需求原文 | 现状 | 处置 |
|------|---------|------|------|
| Vitest 版本 | AGENTS.md §5「Vitest 5.x」 | 仓库全用 2.x，DEC-3 定不升级 | 建议改 AGENTS.md 表述为「与仓库实际版本对齐」 |
| 行业口径 | PRD §5.6「行业选择」 | MVP 用通达信板块表近似，非严格申万/中信行业分类 | T55 交付时在 UI 标注「板块口径」，T78 审计如实记录 |

## 10. 交叉审计记录：ux_v2 + frontend_audit 覆盖核对

> 审计日期 2026-10-17。核对对象：`docs/archive/frontend_ux_v2_SUPERSEDED-2026-10-16.md`（约 40 项）、`docs/archive/frontend-gap-audit_SUPERSEDED-2026-10-16.md`（30 项）。

### 10.1 覆盖情况总览

| 来源 | 条目数 | 已覆盖 | 本次补入 | 未采纳 |
|---|---|---|---|---|
| `frontend_ux_v2.md` | ~40 | 27 | **13** | 0 |
| `frontend-gap-audit-2026-10-16.md` | 30 | 30 | 0 | 0（1 项与 PRD 冲突，见 §10.3） |

### 10.2 本次补入的 13 项（全部已在 §5 任务表落地）

| # | 来源 | 项 | ux_v2 优先级 | ux_v2 估值 | 落地任务 | 代码验证 |
|---|---|---|---|---|---|---|
| 1 | §3.2-5 | `trade_reason` label → 「操作理由」 | **P0** | 0.1d | T68 ② | ❌ `TradeInput.tsx:313` 仍是字面量 `trade_reason` |
| 2 | §3.1.A 建议 D | **今日动态概览卡**（资产变化/今日信号/今日成交/除权导入/重点关注） | **P0** | 0.8d | T67 ⑦ | 完全未实现 |
| 3 | §6 Phase 1 | `<768px` Navbar hamburger 折叠菜单 | P0 | 0.8d | T76 ③ | ❌ 仅 `MobileTabBar`，无折叠菜单 |
| 4 | §6 Phase 1 | 容器改 fluid（去固定 `maxWidth`） | P0 | 0.2d | T76 ④ | ❌ `App.tsx:19` + `_shared.tsx:146` 双份 `maxWidth:1200` |
| 5 | §6 Phase 1 | TradeInput `formRow` 手机端垂直堆叠 | P0 | 0.3d | T68 ⑧ | ❌ `formRowStyle` 无 `flexDirection` |
| 6 | §3.1.A 建议 C | 标的详情 Modal + K 线小图 | P1 | 2.0d | T67 ⑧ | 完全未实现 |
| 7 | §3.1.A 建议 E | 信号 → 交易 一键快捷链路（Mini-Menu 预填） | P1 | 0.5d | T67 ⑨ | 完全未实现 |
| 8 | §3.3-3 | Review 筛选即时生效（debounce，删「筛选」按钮） | P1 | 0.3d | T69 ⑥ | ❌ `Review.tsx:356` 仍为手动触发 |
| 9 | §6 Phase 2 | 表格手机端改卡片列表 | P1 | 0.8d | T79 ① | 完全未实现 |
| 10 | §3.1-5 | Dashboard 重定位为概览页（资产/快捷区/持仓Top3/信号Top5） | P1 | 1.5d | T79 ⑤ | 完全未实现 |
| 11 | §3.1.A 建议 F | Dashboard 候选池联动面板（折叠窄条 + Top5） | P1 | 1.2d | T79 ⑥ | 完全未实现 |
| 12 | §3.4-1 / §3.3-4 / §1-2 | h1/h2 层级统一 / 三态选中态视觉 / 导航按流程重排 | P2 | 0.6d | T76 ⑦⑧ + T69 ⑦ | ❌ `Kline.tsx:362`、`StockScan.tsx:197` 仍是 `<h2>` |
| 13 | §6 Phase 3 / §1-3 / §3-1-4 | touch 44×44 / 面包屑 / 信号空态引导文案 | P2 | 1.1d | T79 ②③④ | — |

### 10.3 一处文档冲突（按真相源优先级裁决）

| 冲突 | `frontend-gap-audit` 的说法 | PRD §5.8 #7 | 裁决 |
|---|---|---|---|
| 桌面端左侧导航栏 | 「不变更的范围」表列为「当前 Navbar 水平链接够用」 | 明文要求「桌面端左侧导航栏：持仓/K线/选股/复盘/候选池/设置」 | **采纳 PRD** → T76 ① 保留左侧导航 |
| 移动端底部 Tab 栏 | 列为「V2 不做」 | PRD §5.8 #6 明文要求 | 已实现（`_shared.tsx:83-124`），T76 ② 仅补候选池/设置入口 |

**依据**：真相源优先级 Requirements > PRD > SDD > 本文档（见 §0）。审计报告不是真相源，其「不变更」判断不能推翻 PRD 明文要求。

### 10.4 排除的疑似问题（核实后确认非缺陷）

| 疑似 | 核实结果 |
|---|---|
| `Admin.tsx:59` 与 `:178` 重复渲染 `<h1>管理员面板</h1>` | **非缺陷**。`:59` 位于无权限 early-return 分支（`role !== 'admin'` 提前返回「无权限」卡），与 `:178` 互斥，不会同时渲染 |
| 「其余 4 张视图 MVP 暂不访问」 | **原标注与代码不符**，已在 §SDD 3.3 修订；`marketData.ts:8-15` 早已映射 `v_stock_hfq`/`v_stock_bfq` |
| 「`raw_symbol_name` MVP 不访问」 | **原标注与代码不符**，`routes/symbolSearch.ts:29` 早已查询；已在 SDD §3.3 修订 |

---

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

## 12. 验收标准

> 本章定义「什么算通过」。前面各章是「做什么」与「为什么」，此处是「做完如何判定合格」。
> **门槛来源**：SDD §12.5（24 项验收）+ Requirements §4.2/§5.1-5.5 + PRD §5.1-5.9 + AGENTS.md 硬约束；D 组为本轮审计新增（因本轮 3 个 P0 全部靠测试抓出，暴露的正是工程门槛缺失）。

### 12.1 功能验收（SDD §12.5，24 项 · 门槛 24/24 PASS）

| 组 | 项 | 通过标准 |
|---|---|---|
| **功能 F1-F11** | F1 注册/登录/JWT | 200+Token / 401 |
| | F2 7 种交易类型 | 每种 201，CHECK 拦截非法值 400 |
| | F3 持仓移动加权成本 | 与手算对比误差 < 0.001 元 |
| | F4 双口径收益率 | 价格/实际口径独立可查 |
| | F5 K线+副图渲染 | 无异常，MACD/RSI 覆盖层正确 |
| | F6 信号状态机 | UNIQUE 触发 ON CONFLICT DO NOTHING |
| | F7 全市场选股 ≤3s | `curl -X POST /api/stockscan` ≤ 3.0s |
| | F8 5 段自动化触发 | mock system time，验证按序执行 |
| | F9 除权导入+候选池迁移 | 幂等，迁移只打标记 |
| | F10 SQLite 备份恢复 | `VACUUM INTO` → 恢复 → integrity_check 全绿 |
| | F11 DuckDB 备份恢复 | `COPY TO PARQUET GZIP` → 恢复 → COUNT(*) 一致 |
| **性能 PE1-PE6** | PE1 首屏 ≤1.5s | Lighthouse Performance ≥90 |
| | PE2 选股 ≤3s（5000+标的） | `curl -w %{time_total}` ≤3.0s |
| | PE3 K线首渲染 ≤500ms | Chrome FP ≤500ms |
| | PE4 API p99 ≤200ms | autocannon 100 并发 |
| | PE5 SQLite WAL 10 并发 | 无 SQLITE_BUSY |
| | **PE6 插件 50ms 超时不拖垮主流程** | `while(true){}` 插件 → `Promise.race` reject，标记 TIMEOUT，主流程正常完成。对应测试 `plugin.test.ts → plugin_timeout_50ms` ⚠️ **当前实测 `run-signal` 返回 `{total:2, success:0, timeout:2}` —— 两个插件 100% 超时，`user_strategy_signal` 0 条**（见 §11.8，本项是当前最危险的验收项） |
| **安全 SE1-SE6** | SE1 HTTPS 强制 | HTTP 自动 301 |
| | SE2 bcrypt cost=12 | 代码 grep + 单测 |
| | SE3 JWT 密钥 env 注入 | 不在代码库明文 |
| | SE4 插件沙盒 | global/process/require 被拒且不影响外部 |
| | SE5 system_log 金额脱敏 | 末 4 位替换 `****` |
| | SE6 admin 二次鉴权 | 普通用户 403 |
| **合规 CO1** | 数据文件权限 | 600 + owner=nobody |

> ⚠️ **PE1-PE5 必须真机实测**（PE6 靠单测即可，见 T88）。DEC-5 服务器未就绪时，T78 只能标注「**未实测**」，**不得宣称 PASS**。

### 12.2 需求覆盖（门槛：零 gap）

| 范围 | 检查项 |
|---|---|
| Requirements §4.2 | In-Scope **14 项**逐项（响应式前端 / 记账持仓成本复盘闭环 / 7 种交易类型 / 除权自动导入 / 双口径 / 插件引擎 / 全市场选股 / 候选池 / 12 项校验 / 三层防线 / 管理员角色 / 定时自动化 / 分级备份 / 用户鉴权） |
| Requirements §5.1-5.5 | 业务规则逐条（交易类型 / 强制约束 / 成本口径 / 收益双口径 / 策略引擎） |
| AGENTS.md | 硬约束逐条（3 workspace / better-sqlite3 / Node≥22 / 禁止前端 import core / DuckDB 只读+单例 / CORS 127.0.0.1 / 禁止物理删除 / token 不落日志） |
| Out-of-Scope | 分钟K / 盘中实时 / 实盘下单 / 小程序 / 云函数 / 暗色模式 —— **确认未偷跑** |

### 12.3 交互覆盖（PRD §5.1-5.9，门槛：零 gap）

| 节 | 内容 | 豁免 |
|---|---|---|
| §5.1 | 响应式（桌面多副图 / 手机 Tab） | — |
| §5.2 | K线（复权三选 / MA 5-10-20-60 / 副图切换 / 信号标记 / 参数实时生效 / 周月K / 十字光标） | — |
| §5.3 | 持仓页（总资产卡 / 饼图 / 卡片列表 / 快捷操作 / 筛选排序） | — |
| §5.4 | 交易录入（Tab / 理由必填 / 实时预估 / 标签 / 除权补充 / 系统vs人工标签） | — |
| §5.5 | 复盘页（双口径 / 收益曲线 / 胜率盈亏比 / 筛选 / 4色标签 / 编辑弹窗） | — |
| §5.6 | 选股页（公共过滤 / 插件下拉+动态表单 / ≤100条 / 批量加入 / 结果表） | — |
| §5.7 | 管理员（12项校验四色 / 手动触发 / 日志过滤 / 备份恢复 / 角色管理） | — |
| §5.8 | 全局体验（响应式 / 算法一致 / 性能 / 合规声明 / 无刷新 / 移动Tab / 桌面侧栏 / 暗色 / 错误提示 / 无障碍） | 暗色模式（PRD 自带「MVP 可选」，归 V2）；移动端底部 Tab 与桌面左侧栏**本 plan 已实现** |
| §5.9 | 安全合规 UX（HTTPS / 登录态过期保留路径 / 隐私声明 / 插件安全承诺 / 管理员双重确认） | — |

### 12.3b UX 专项（源自 `frontend_ux_v2`，PRD 未覆盖 · 门槛：P0/P1 零遗漏）

> 12.3 只覆盖 PRD §5.1-5.9，但 `frontend_ux_v2` 有 **17 类 PRD 未提及**的内容 —— 它们是 PRD §5.8 #10「无障碍」与 §5.8 #1「响应式」的具体化，**不能因 PRD 没写就不验收**。
> 依据：`docs/archive/frontend_ux_v2_SUPERSEDED-2026-10-16.md`（结论已失效，但有效部分已内联保全于**附录 B-2**）。

| # | ux_v2 出处 | 项 | 门槛 | 落地任务 |
|---|---|---|---|---|
| U1 | §2.1 + [ui-spec §1](ui-spec.md#1-design-token-具体数值) | **Design Token 层**：`tokens.ts` 导出 COLORS/SPACING/RADIUS/TYPO/MAX_WIDTH；`.tsx` 中 raw hex 归零（token 文件除外） | P0 | T62 |
| U2 | §2.2 + [ui-spec §3](ui-spec.md#3-全站-14-类颜色清单) | 全站 14 个内联颜色收敛为 token | P0 | T62 |
| U3 | §2.3 + [ui-spec §2](ui-spec.md#2-按钮规格) | 按钮 5 变体（primary/danger/ghost/secondary/disabled）+ `focusRingStyle` | P1 | T62/T63 |
| U4 | §2.1 | **`global.css`** 存在且定义 `:focus-visible` / body 背景 / margin 重置（inline style 无法表达这些） | P0 | T62 |
| U5 | §1.1 | **NavLink 激活态**：当前页有可见高亮（`aria-current` 或 active 样式） | P0 | T63 |
| U6 | §1.2 | 导航按业务流程重排（仪表盘→交易→选股→K线→信号→复盘→候选池→设置→管理员） | P2 | T76 |
| U7 | §1.3 | 面包屑（K线页等深层页面） | P2 | T79 |
| U8 | §3.2-5 | `trade_reason` label 中文化为「操作理由」 | **P0** | T68 |
| U9 | §3.1-A 建议 D | **今日动态概览卡**（资产变化/今日信号/今日成交/除权导入/重点关注） | **P0** | T67 |
| U10 | §3.1-A 建议 B | 交易录入改为 Modal（持仓卡快捷按钮触发，非整页跳转） | P0 | T67/T68 |
| U11 | §3.1-A 建议 C | 标的详情 Modal + K 线小图（不跳路由丢上下文） | P1 | T67 |
| U12 | §3.1-A 建议 E | 信号 → 交易一键链路（Mini-Menu 预填全部字段） | P1 | T67 |
| U13 | §3.1-A 建议 F | Dashboard 候选池联动面板（折叠窄条 + Top5） | P1 | T79 |
| U14 | §3.1-5 | Dashboard 重定位为概览页（资产/今日动态/持仓Top3/信号Top5） | P1 | T79 |
| U15 | §3.3-3 | Review 筛选**即时生效**（debounce，无「筛选」按钮） | P1 | T69 |
| U16 | §3.3-4 | 三态按钮选中态视觉加强（fontWeight 600 + borderWidth 2px） | P2 | T69 |
| U17 | §4.1-4.4 | Loading spinner / Empty 状态引导 / Error **[重试] 按钮** / 字段级错误高亮 | P1 | T64/T65/T68 |
| U18 | §5（7 项） | 可访问性：焦点锁定 / `aria-live` / `th[scope]` / `label[for]` / 语义标签 / 焦点锁定关闭 / 颜色对比度 | P0 | T63/T76 |
| U19 | §6 Phase 1 | 响应式基础：hamburger 菜单 / **容器 fluid（去固定 maxWidth）** / formRow 垂直堆叠 / **三视口零横向溢出** | **P0** | T68/T76 |
| U20 | §6 Phase 2/3 | 表格手机端卡片化 / touch ≥44×44px | P2 | T79 |
| U21 | §8.3 | **架构决策**：inline style 保留（不切 CSS Module/Tailwind）/ 不引图表库（K线继续手写 Canvas）/ 收益曲线手写 SVG | 约束项 | 全程 |

**判定补充**：
- U1-U5、U8-U11、U18-U19 为 **P0**，任一未完成 → **§12.6 判 FAIL**
- U6/U7/U16/U20 为 P2，可按 §9.3 登记豁免后判 COND
- U21 是**约束而非交付物** —— 若有人引入 ECharts/Tailwind/CSS Module 破坏该决策，即使功能齐全也判 FAIL

### 12.4 工程门槛（本轮审计新增）

| # | 项 | 门槛 | 为什么加 |
|---|---|---|---|
| E1 | 测试全绿 | `unit` + `integration` + `core` 全 PASS，**用例数只增不减** | 本轮实测发现 `validator.test.ts` 存在顺序依赖，靠单跑发现不了 |
| E2 | 新增代码有测试 | 每个 T 任务的「测试要点」列**全部**落地为可执行用例 | P0-9/10/12 三个全是测试抓出来的；P0-13 若有测试也不必靠人工复现 |
| E3 | 覆盖率 | frontend ≥60%（当前 0）；backend 不低于当前基线。⚠️ **SDD §12.2 原值（核心算法 ≥90% / C1-C12 ≥85% / 插件引擎 ≥90% / 前端 ≥70%）与 §12.6 的 90% 阻断 Gate 已按 §13.4 B-5 裁决暂缓，恢复由 T86b 承担** | frontend 零测试是 PRD §5.2「参数实时生效」无法安全实现的前置障碍 |
| E4 | CI 稳定 | 连续 3 次 CI 全绿（T81 未完成前不满足） | 顺序依赖会让 CI 飘红 |
| E5 | 双版本对照 | 修 bug 的任务须保留「修复前失败 / 修复后通过」的对照证据 | 本轮 T80 已建立此惯例，避免"测试本身是错的" |
| E6 | 无死代码 | 无未引用的导出/常量；`any` 数量降到 0（F-Q3/F-Q4） | — |

### 12.5 阻塞门槛（不满足则不得进入 T78）

| # | 项 | 说明 |
|---|---|---|
| B1 | **P0-1~P0-14 全部关闭** | 其中 P0-14 需有对应的**测试基建补强**（不能只是文档记录） |
| B2 | T81 完成 | 否则 CI 仍可能因测试顺序依赖飘红，E4 不成立 |
| B3 | T84 先于 T49 完成 | 两者改同一批 `switch` 分支，顺序错会把已知漏洞换个名字保留 |
| B4 | 黄金数据集落地（T51） | AGENTS.md 硬约束；也是 ADR-001 的安全前提 |
| B5 | DEC-6~8 已决策 | 影响 T71/T51 实现路径 |
| B6 | **§13 剩余阻断项已裁决或已分派任务** | B-4（测试映射 + 4 个缺失测试文件）、B-7（候选池迁移违反 PRD S5）、B-8（插件契约字段）**必须有对应任务且完成**；B-9/B-10/B-12/B-13 **必须有一句话裁决**（否则 §12.1 无法逐条判 PASS） |
| B7 | **T85 完成（PRD D1「12 项校验」可达）** | `runAllChecks` 返回 12 条是 PRD D1 与 §6.2 通过率指标的唯一前提 |
| B8 | **G1-G7 各有落档文件且全 PASS** | §12.7 Wave 出口门槛（硬阻断）。**T78 不是首次验收** —— 未过 gate 的波次不得合入 `main`，见 §12.8 |

### 12.6 判定规则

```
✅ PASS   A 组 24/24 + B 组零 gap + C 组零 gap + C' 组(U1-U5/U8-U11/U18-U19/U21) 零遗漏
          + D 组工程门槛全达标 + E 组阻塞项全清
⚠️ COND   仅 P2 级项未完成（U6/U7/U16/U20 或 §9.3 已登记的偏差），且已在 §9.3 列明
❌ FAIL   A 组任一项不达标 / C' 组任一 P0 未完成 / E 组任一阻塞项未清
```

> **§13.4 裁决对判定规则的两处豁免**（裁决优先于原判定）：
> 1. **覆盖率不参与本轮判定** —— SDD §12.2 门槛与 §12.6 的 90% Gate 已按 B-5 裁决暂缓，D 组 E3 只按现值（frontend ≥60% / backend 不低于基线）判。恢复由 **T86b** 承担。
> 2. **C4/C5 由「结构性缺项」改为「任务未完成」** —— B-1 裁决为需要实现，故 A 组 C4/C5 两项按 **T85 是否完成**判定，而非按「计划未覆盖」直接判 FAIL。

> ⚠️ **本节是最终验收，不是首次验收。** §12.7 定义了 8 个 **Wave 出口门槛（G1-G8，硬阻断）**，§12 的多数条目已前移到对应 Wave gate 逐波止损。
> **本节 PASS 的前提是 G1-G8 全部 PASS**。若某波 gate FAIL，该波 commit 不合入 `main`（§12.8 流程），**不允许带着未通过的 Wave 走到 T78 再判**。

**T78 的产出**（`docs/audit/fullstack-audit-v2.md`）必须逐条列出上述判定结果，并附：
- 测试用例数变化（起始 137+58+24 = 219）
- 性能实测原始数据（curl / autocannon 输出，非转述）
- 未实测项的**明确标注**，不得省略

### 12.7 Wave 出口门槛（**硬阻断**）

> **为什么有这一节**：本计划 48 个任务、~60 人天，若只在 T78 一次性判定，则 Wave 1 的**静默污染类**错误（T84 超卖 / T87 追加语义 / C4-C5 / 插件计时）会一路带到底 —— 到 T78 才发现时，`user_trade_record` 已脏，所有 Wave 3-7 算出的持仓成本、收益率、复盘胜率**全部错位且不报错**，已无干净切分点。
> **本节把 §12 的一部分验收前移到每个 Wave 结束处**，作为逐波止损点。**T78 不是第一次验收，是最后一次。**

**总则**

| 项 | 规则 |
|---|---|
| **时机** | 本波最后一个 commit 完成后、进下一波第一个 commit **之前** |
| **判定** | 只有 **PASS / FAIL**。**无 COND** —— COND 会让硬阻断形同虚设 |
| **落档** | 结果写入 `docs/audit/wave-N-gate.md`，含逐条 PASS/FAIL/豁免 + **实测原始数据** + 本波 commit 范围。**无落档文件 = 未执行 = FAIL** |
| **阻断** | 任一条 FAIL → **本波全部 commit 一律不合入 `main`** |
| **不可豁免** | **数据正确性类门槛永久不可豁免**（下表标 🔒 者） |
| **豁免条件** | 客观原因无法达成时（如 DEC-5 服务器未就绪导致 PE1-PE5 不可实测），须在 gate 文档写明「豁免哪条 / 理由 / 指向 §9.3 或 §13 的具体条目」。**同一门槛最多豁免 1 个 Wave，连续 2 波豁免自动升级为阻塞项** |

---

#### G1 · Wave 1 出口（数据与规则纠偏，23.3 人天 —— **全计划最严**，6 条 🔒 不可豁免）

| # | 门槛 | 验证方式 |
|---|---|---|
| 🔒 **G1.1** | **三项数据正确性断言全过**：T84 时点超卖拒绝 / T87 同日同标的同类型**不同时间可并存** / T49 7 种类型 + 四处 `TRADE_TYPES` 清单一致 | `tests/unit/positionCalculator.test.ts` + `tests/integration/trade.test.ts` |
| 🔒 **G1.2** | **`runAllChecks()` 返回长度 = 12**（硬断言 `toHaveLength(12)`），且 `checkId` **覆盖 C1-C12 无重复无占位**（当前 `checkC3toC5` 一律返回 `'C3'`）。⚠️ **口径以 `Requirements_simplified.md` §7.1 为准**（C3-C8 为数据新鲜度类），详见 §13.1 B-14 | T85 新增用例 + 浏览器探针 |
| 🔒 **G1.3** | 信号段返回 **`{total:2, success:2, timeout:0}`**，且 `user_strategy_signal` 新增行数 **> 0** | T88 + 动态探针 |
| **G1.4** | **响应契约全绿**：全部路由成功体含 `code===0`+`data`+`timestamp`+`success===true`；错误体含字符串 `code`+`message`+`data===null`+`timestamp`+`success===false` | T89a 契约测试遍历全部路由<br>⚠️ **本阶段 `success` 仍保留**（删它属 T89b / Wave 8） |
| **G1.4b** | **前端不再把裸错误码显示给用户**：`grep -rn 'data\.error' apps/frontend/src` 归零；登录密码错误显示「用户名或密码错误」而非错误码 | T89a ⑥ 的 36 处适配 |
| **G1.5** | **路由契约 22 条全绿**（SDD §4.4 逐条）+ 旧名全部 404 | T90 契约测试 |
| 🔒 **G1.6** | **全库数据体检**：无负持仓 / 无负成本 / 无「同日+同标的+同类型+同时刻」重复 | 只读脚本 + 断言 |
| **G1.7** | 用例数**只增不减**（对比 Wave 1 起始基线 219） | `vitest run` 计数 |
| **G1.8** | `tsc --noEmit` 三 workspace **0 error** | CI |
| **G1.9** | SDD §12.5 每个指定用例名在全仓可 grep 到（T91 交付物） | grep 自检 |

> ⚠️ **G1.4/G1.5 必须同批交付前端适配** —— 否则前端全量 404 / 白屏，Wave 2 无法在其上作业。

#### G2 · Wave 2 出口（前端基座）

| # | 门槛 | 验证方式 |
|---|---|---|
| **G2.1** | `npm run lint` 退出码 **0** | CLI |
| 🔒 **G2.2** | **反向验证**：故意写一个 `any` + 一处格式错误 → lint **必须非 0**（证明规则真生效，不是空跑） | 临时改动后跑 lint |
| **G2.3** | `npm run build` 三段产物齐备（core → backend → frontend 顺序依赖成立） | CLI |
| **G2.4** | 前端测试用例数 **> 0**，coverage **≥60%**（§12.4 E3 现值） | `test:coverage` |
| **G2.5** | CI Stage 2 步骤存在**且失败会阻断**（用故意破坏验证） | CI 实跑 |
| **G2.6** | CI 连续 **2 次**全绿（T81 未完成前可豁免，须登记） | CI |

#### G3 · Wave 3 出口（Dashboard，PRD §5.3）

| # | 门槛 | 验证方式 |
|---|---|---|
| **G3.1** | §12.3 中 **PRD §5.3 对应行零 gap** | 逐条勾对 |
| **G3.2** | **F-D1~F-D6 全部关闭**（附录 A） | 逐条勾对 |
| **G3.3** | 今日动态概览卡 **5 个数据块各自非空或有降级文案** | 组件测试 + 浏览器 |
| **G3.4** | a11y：**axe 核心规则 0 critical** | axe |
| **G3.5** | **375px 无横向溢出**（F-Q12） | 浏览器动态探针 |

#### G4 · Wave 4 出口（TradeInput + Review，PRD §5.4/§5.5）

| # | 门槛 | 验证方式 |
|---|---|---|
| **G4.1** | §12.3 中 **PRD §5.4 + §5.5 对应行零 gap** | 逐条勾对 |
| **G4.2** | **F-T1~F-T6 + F-R1/F-R2 + Review page bug 关闭** | 逐条勾对 |
| **G4.3** | 复盘**三态弹窗**（PASS/WARN/ERROR）正确分流 | 组件测试 |
| **G4.4** | 筛选 debounce 即时生效（§10.2 P1） | 组件测试 |
| **G4.5** | **`trade_time` 提交前预检生效**：已占用时刻禁用提交并提示（T87） | 组件测试 |

#### G5 · Wave 5 出口（Kline + Signals，PRD §5.1/§5.2）

| # | 门槛 | 验证方式 |
|---|---|---|
| 🔒 **G5.1** | **SDD §12.5 功能组 F1-F8 全部 PASS**（8 项全过，不是抽查） | T91 测试映射逐条 |
| **G5.2** | **F-K1~F-K8 关闭**；ETF/指数视图按 `raw_symbol_class.class` 正确分流（F-K10） | 动态探针（各取一只 stock + 一只 ETF） |
| 🔒 **G5.3** | **`ma60`/`rsi`/`macd` 与 golden 逐位相同**，core 与 frontend **双端误差 = 0** | golden 数据集断言 |
| 🔒 **G5.4** | **KDJ 手写实现 golden 断言通过**（含 `K_0=D_0=50` 首值 + `Hn−Ln=0` 不产生 NaN） | golden 数据集断言 |
| **G5.5** | signals 升序 + `asset_code`/`start_date`/`end_date` 筛选正确 | 用例 |

#### G6 · Wave 6 出口（StockScan + 候选池，PRD §5.6）

| # | 门槛 | 验证方式 |
|---|---|---|
| **G6.1** | SDD §12.5 **F9 PASS**（候选池迁移**幂等且只打标记不建关联**） | T92 用例 |
| **G6.2** | **F-S1~F-S5 关闭**（含 409 bug） | 逐条勾对 |
| 🔒 **G6.3** | **filter 插件可用，`totalCandidates > 0`**（当前恒为 0 —— 这是 P0-11 的判定锚点） | 动态探针 |
| **G6.4** | **5000 标的选股 ≤3s**（PE2） | `curl -w %{time_total}` 原始输出 |
| 🔒 **G6.5** | **promote 后 watch 关联不存在**（T92 反向断言 —— 与旧行为相反） | `watchPromote.test.ts` |

#### G7 · Wave 7 出口（Admin，PRD §5.7）

| # | 门槛 | 验证方式 |
|---|---|---|
| **G7.1** | SDD §12.5 **F10 PASS**（备份恢复） | 用例 |
| **G7.2** | §12.3 中 **PRD §5.7 对应行零 gap** | 逐条勾对 |
| **G7.3** | **F-A1~F-A3 关闭** | 逐条勾对 |
| **G7.4** | **管理员二次鉴权**：普通用户访问全部 admin 端点均 **403** | 集成测试逐端点 |
| 🔒 **G7.5** | **DuckDB 备份恢复用例真实跑通**（`COPY TO PARQUET GZIP` → 恢复 → `COUNT(*)` 相等），**不得只 mock** | T91 用例，临时目录 |
| 🔒 **G7.6** | **12 项校验卡片真实渲染 12 条**（不再是空态/ `checkId` 只有 2 个），且卡片显示的**校验名称与 SDD §5.7 主表一致**（停牌/退市/ST 等扩展校验**不得占用 C 编号**）| 浏览器探针 |

#### G8 · Wave 8 出口（收尾）

| # | 门槛 | 验证方式 |
|---|---|---|
| **G8.1** | T77 smoke-m5 全绿 | `npm test` |
| **G8.2** | T86b 覆盖率达标，或已按 §12.7 豁免规则登记 | `test:coverage` |
| **G8.3** | G1-G7 全部 PASS 且各有落档文件 | 目录检查 |

---

### 12.8 Wave Gate 执行流程（硬阻断）

```
本波最后一个 commit 完成
        │
        ├─→ ① 跑本波 Gate 清单（G1~G7 对应节）
        │
        ├─→ ② 写 docs/audit/wave-N-gate.md
        │      必含：逐条 PASS/FAIL/豁免 + 实测原始数据（非转述）+ 本波 commit 区间
        │
        ├─→ ③ 判定
        │      ├─ 全 PASS（或豁免合规）→ ④ 允许合入 main
        │      └─ 任一 FAIL        → ⑥ 阻断，本波 commit 不合入 main
        │
        ├─→ ④ PR 合并（gate 文档的 commit 与本波 commit 同一个 PR）
        │
        └─→ ⑥ 回滚：git revert 本波 commit 区间
```

**规则**

1. **禁止绕过**：不得「先合入再补 gate」。`wave-N-gate.md` 的 commit 必须与本波 commit 在**同一个 PR** 内。
2. **合并粒度**：Wave 内 commit 保持原子性（同 PR 或连续 commit），使整体 revert 可行。
3. **回滚可行性**：因「**每个 T 任务一条 commit**」（AGENTS.md §开发流程纪律）的粒度保证，一波内的 commit 区间可整体 revert 而不留半拉子改动 —— **这是本流程成立的前提，不可把多个任务合并成一条 commit**。
4. **静默污染优先**：任一 🔒 门槛 FAIL 时，**先查数据再查代码**（`user_trade_record` / `user_asset_rel` 是否已脏），不要先改逻辑。
5. **与 T78 的关系**：§12.6 的全局判定是**最终验收**，其前提是 **G1-G8 全部 PASS**。Wave gate 是逐波止损点，**T78 不是第一次验收**。

**Wave Gate 与 §12 的覆盖关系**

| §12 分组 | 前移到哪些 Wave gate |
|---|---|
| 12.1 A 组（F1-F11 功能） | F1-F8 → **G5.1**；F9 → **G6.1**；F10 → **G7.1**；F11 → **G7.5** |
| 12.1 A 组（PE1-PE6 性能） | PE2 → **G6.4**；PE6 → **G1.3**；PE1/PE3/PE4/PE5 → T78（需 DEC-5 真机，可豁免） |
| 12.2 B 组（需求覆盖） | 逐波拆分 → **G3.1 / G4.1 / G7.2** |
| 12.3 C 组（PRD 交互） | 逐章拆分 → **G3.1 / G4.1 / G6.x / G7.2** |
| 12.3b C' 组（UX） | **G3.3 / G3.5 / G4.3 / G4.4 / G4.5** |
| 12.4 D 组（工程门槛 E1-E6） | E1 → 各波**G*.7**；E3 → **G2.4**；E6 → **G2.1/G2.2**；E4 → **G2.6** |
| 12.5 E 组（阻塞门槛） | **G8.3** 汇总校验 |
| 12.6 全局判定 | **T78**（最终验收，非首次验收） |

---
---

## 13. 与 PRD / SDD 的已知偏差登记

> 本章登记**计划或代码与真相源（PRD / SDD）不一致**之处。每项标注：现状、真相源原文、严重度、建议裁决方式。
> **本计划不擅自修改 PRD/SDD** —— 它们是权威文档，改动需所有者决定。此处的作用是让 T78 审计与后续开发**不至于按错误的权威行动**。
>
> 登记日期 2026-10-17，基线 `3ee48d6`。

### 13.1 阻断级（不裁决则 §12.6 必然判 FAIL）

| # | 项 | 现状 | 真相源 | 建议 |
|---|---|---|---|---|
| **B-1** | **C4/C5 两条校验从未实现** | `validator.ts:157` 注释「MVP 只实现 C3，C4/C5 SDD 是"略"」，`checkC3toC5` 只返回 `checkId:'C3'`、`detail`「C4/C5 MVP 暂缺」。`runAllChecks` 返回 **10 条** | SDD §5.7 `C3-C5：停牌日/退市标记/ST 状态一致性`；PRD D1「**12 项**校验」、§6.2「C1-C10 通过率 ≥99.9%」 | ✅ **已裁决（2026-10-17）：需要实现** → 新增 **T85**。见 §13.4 |
| **B-2** | **PE6 缺失于本计划 §12.1** | 初版 §12.1 写「24 项」但只列 23 项，PE6（插件 50ms 超时）被漏 | SDD §12.5 PE6 `plugin.test.ts → plugin_timeout_50ms` | ✅ **已裁决（2026-10-17）：已修复** —— §12.1 已补回 PE6（本 PR 内完成，无需任务）。但实测 `{total:2, success:0, timeout:2}` 说明 PE6 相关**运行时问题**需独立立案，归 **B-3 / T88** |
| **B-3** | **两个内置插件 100% 超时，信号 0 条** | `run-signal` → `{total:2, success:0, timeout:2}`；`user_strategy_signal` 0 条 | SDD §5.3「execute() 硬限制 50ms」、§12.3 P3「`while(true){}` → reject」、§12.5 F8「每日自动跑策略信号」 | ✅ **已裁决（2026-10-17）：不应该计入** —— 50ms 预算**只覆盖插件自身 `execute()` 的计算**，行情查询（DuckDB IO）**不计入**。→ 新增 **T88** 改造计时边界。见 §13.4 |
| **B-4** | **SDD §12.5 的「对应测试 Case」映射被丢弃** | 本计划 §12.1 只有「项/通过标准」两列，无测试文件与用例名 | SDD §12.5 每项均指定测试载体 | ✅ **已裁决（2026-10-17）：派任务** → **T91**。实测缺口：`holding.test.ts` / `scan.test.ts` / `frontend.test.tsx` 三个文件**不存在**；`packages/core/tests/plugin.test.ts` **只有 1 个用例**（SDD 要求的状态机 4 路径 + `plugin_timeout_50ms` 均无）；`backup.test.ts` **只覆盖 `backupSQLite`，DuckDB 备份恢复零覆盖**（F11 无测试）。见 §13.4 |
| **B-5** | **覆盖率门槛被下调 + 90% Gate 被删** | §12.4 E3「frontend ≥60%；backend 不低于当前基线」（= 无门槛）；§12.6 判定规则不提覆盖率；`ci.yml` 无 gate 步骤 | SDD §12.2 核心算法 ≥90% / C1-C12 ≥85% / 插件引擎 ≥90% / 前端 ≥70%；§12.6「核心算法 + 插件引擎 <90% **阻断合入**」 | ✅ **已裁决（2026-10-17）：暂维持下调，但登记为待补** → §12.4 E3 保留现值并加「⚠️ 待补」标记 + 新增 **T86b** 收尾（覆盖率达标后恢复 SDD 门槛与 90% Gate）。见 §13.4 |
| **B-6** | **Lint 阻断阶段无任务** | 根 `package.json` 无 `lint` 脚本；全仓无 `.eslintrc*` / `.prettierrc*`；`ci.yml` 无 lint 步骤。但 E6/T66 均以「需先配 ESLint」为前提 | SDD §12.6 CI Stage 2「Lint + TypeScript Check」，阻断点含「Lint 失败」；AGENTS.md §编码约束 6 | ✅ **已裁决（2026-10-17）：补 Wave 2 任务** → 新增 **T86**。见 §13.4 |
| **B-7** | **候选池迁移违反 PRD 明文** | `watch.ts:62-104` 的 promote **在 `:85-88` 直接 INSERT 目标行**；`watchPromote.test.ts:35` 断言「watch 出现」 | PRD S5「**MVP 迁移操作只在候选记录上打标记，不会自动创建自选关联**（用户需手动从候选池加入自选）」；SDD §12.3 B6 同 | ✅ **已裁决（2026-10-17）：派任务** → **T92**，删除 INSERT 分支并改写 `watchPromote.test.ts:35` 断言。见 §13.4 |
| **B-8** | **插件契约字段几乎全缺** | `pluginEngine.ts:62-72` 的 `Plugin` 只有 `id/name/description?/category/paramSchema?`；缺 `version/author/period/sub_category/complexity/defaultParams/chartOverlay`；`PluginSignal`（`:50-59`）SDD 叫 `metrics` 而代码叫 `params`；`signalType`（`:52`）多 `ALERT` | SDD §5.3「**本节为插件引擎的核心设计契约，所有内置插件与自定义插件必须严格遵循**」 | ✅ **已裁决（2026-10-17）：派任务** → **T93**，含「插件字段完备性」单测。见 §13.4 |
| **B-9** | **统一响应封装（SDD §4.2）全链路缺失** | 代码统一 `{success, data/error, message}`；实测 `reply.code(...)` 共 63 处。实测前端 `.success` 有 **20 处**依赖、`.error` 有 **36 处**依赖且被直接上屏（`.message` 仅 2 处）；本计划 0 处提及，§12.1 无对应验收项 → **拆 T89a/T89b 两阶段** | SDD §4.2「所有 API 返回统一 envelope `{code,data,timestamp}`」，业务错误体含 `code` 字段 | ✅ **已裁决（2026-10-17）：改代码** → 新增 **T89**（采纳 SDD 的 envelope）。见 §13.4 |
| **B-10** | **`HOLDING_INSUFFICIENT` 状态码 400 vs 409，且 SDD 自相矛盾** | `routes/trade.ts:58` 实测 `reply.code(400)` | SDD §4.3 错误码表 `HOLDING_INSUFFICIENT → 409` + §5.1 时序图 `409`；但 SDD §12.3 B1 写 **400** | ✅ **已裁决（2026-10-17）：409** → T84/T89a 改用 409，并**修掉 SDD §12.3 B1 的 400 笔误**。见 §13.4 |
| **B-11** | **`UNIQUE(user_id, asset_code, trade_type, trade_date)` 与 SDD §12.3 B4 矛盾** | 代码有该约束，同日同标的同类型第二次 → **409 TRADE_DUPLICATE** | SDD §12.3 B4「同一日内同一 symbol 多次买入（幂等）→ **不触发 UNIQUE 冲突，正常追加**」 | ✅ **已裁决（2026-10-17，两次修订）**：① 改**追加**；② 首次要求「成交时间与标的代码、**份额**共同进主键」，后修订为「**成交时间进主键，份额不进**」→ **`UNIQUE(user_id, asset_code, trade_type, trade_date, trade_time)`**，`trade_time` 变必填。→ 新增 **T87**。见 §13.4 |
| **B-12** | **手动触发端点出现第四个名字** | 本计划 T59 新增 `/api/admin/run-pipeline`；代码 `routes/admin.ts` 是 `/api/admin/run-datacheck` | SDD §4.4:1274 **`/api/admin/datacheck/trigger`**；SDD §5.1.1 简写 `/api/admin/datacheck` | ✅ **已裁决（2026-10-17）：以 SDD 为准** → 统一为 **`/api/admin/datacheck/trigger`**，T59 的 `run-pipeline` 取消；连带 I-1 的 15 处路由一并对齐 → 新增 **T90**。见 §13.4 |
| **B-13** | **`/api/strategy/reload` 被我误判为 V2** | 本计划 §8「插件热重载扫描自定义 `.js` → V2（AGENTS.md 禁止）」 | AGENTS.md 原文「自定义插件**只能**放 `/opt/invol/plugins/strategies/` 且**仅限** `.js`；禁止动态 eval」—— 这是**路径/扩展名/eval 约束，不是功能禁令**；PRD M5「安装自己写的策略插件」；SDD §4.4:1267 列了 `/api/strategy/reload` | ✅ **已裁决（2026-10-17）：属 MVP** → **T94**。**实测底层已实装**：`pluginEngine.ts` 已有 `PLUGIN_ALLOWED_PATH`（`:17`）、`PLUGIN_FILENAME_RE`（`:185`）、`loadPluginsFromDir()`（`:201`）、`createPluginSandbox()`（`:291`）、`getAllPlugins()`（`:412`）；全仓 grep「reload」零命中，**缺的只有 admin 路由壳**。§8 该条同步删除。见 §13.4 |

### 13.2 重要级（会造成实现偏差或文档互斥）

| # | 项 | 现状 vs 真相源 | 建议 |
|---|---|---|---|
| I-1 | **路由命名 15 处不一致** | SDD §4.4 的 `/api/trade`、`/api/holding`、`/api/quote/:symbol/kline`、`/api/strategy/plugins`、`/api/review/yield`、`/api/candidate/:id/migrate`、`/api/admin/datacheck/result`、`/api/admin/role/:userId` 等，代码用的是复数/新名。**本计划只登记了 F-Q10 一条，且登记后未派任务** | ✅ **已裁决（B-12：以 SDD 为准）** → **T90** 对齐全部 22 条 |
| I-2 | **错误码集合三方不一致** | SDD §4.2 定义 10 个；代码 16 个；`DUPLICATE_IMPORT` vs `DUPLICATE`/`TRADE_DUPLICATE`、`SYMBOL_NOT_FOUND` vs `INVALID_SYMBOL`、`UNAUTHORIZED` vs `NO_TOKEN`/`INVALID_TOKEN`、`PARAM_INVALID` 代码中不存在 | T64 的 20 个错误码映射应以**代码实际集合**为准，并同步修 SDD §4.2 |
| I-3 | **`user_trade_record.strategy_match` / `user_asset_rel.is_deleted` / `user_strategy_signal.is_deleted` 不在 SDD §3.2** | 代码有（且有幂等 ALTER），SDD DDL 无 | 补进 SDD §3.2（这三列是 AGENTS.md「全部业务记录软删除」的落地） |
| I-4 | **`system_log.log_type` CHECK：SDD 6 值 vs 代码 9 值** | 代码多 `plugin_execute`/`startup`/`trade`；PRD §5.7 列的 5 类与两者都不吻合 | 同步 SDD §3.2 与 PRD §5.7 的枚举 |
| I-5 | **插件 `category`：SDD §3.2 单值 vs SDD §5.3 双值** | §3.2 `CHECK (category IN ('monitor','filter'))` 单值；§5.3 内置 `rsi` 的 category 写「monitor **+** filter」双值。T83 按单值实现并拒绝 monitor 插件 | 统一为单值（按 §3.2 DDL），改 SDD §5.3 |
| I-6 | **内置插件 id/参数名与 SDD 不符** | SDD `id='rsi'`、参数 `oversold/overbought`；代码 `id='rsi_oversold'`、参数 `threshold`、多一个必填 `symbol` | 裁决后端 id（`user_strategy_signal.plugin_id` 已持久化，改 id 等于换插件） |
| I-7 | **C1-C12 的判定阈值/抽样/节流无任务承载** | SDD §5.7 规定 C6 `<0.01`、C8 `0.005`、C9 `<0.0001`+抽样100+`mismatch≤5→WARN`、C11 抽样30+`≤2→WARN/≥3→ERROR`、C12 每只间隔500ms+`<0.02`+退避200→400ms+`≤3→WARN/≥4→ERROR`。`validator.ts:11-18` 容差与 SDD 一致，但**Wave 1 的 16 个任务无一负责判定阈值与四态** | 新增任务覆盖每条校验的 PASS/WARN/ERROR/SKIP 四态 |
| I-8 | **PRD §6.2 与 SDD §5.7 的跨源容忍度不一致** | PRD C11 `≤3/30`、C12 `≤5/20`；SDD C11 `≤2→WARN/≥3→ERROR`、C12 `≤3→WARN/≥4→ERROR` | 按真相源优先级取 PRD，或裁决后统一 |
| I-9 | **SDD §12.4 集成测试 8 场景，5 项无载体** | 5 段自动化全链路（mock time）/ C12 东财降级（需 `msw`，`package.json` 无）/ SQLite `chmod 000` 降级 + `log-recover`（**代码根本没有 `log-recover` 实现**）/ 插件 `while(true){}` 超时 / `DB_UNAVAILABLE` 503 / 批量选股 ≤3s | 并入 T60/T81，或单列 |
| I-10 | **技术选型单方面推翻且未同步** | SDD §2.5 选 `klinecharts`，本计划 U21 把「不引图表库」设为**一票否决判据**；SDD §2.6 选 `technicalindicators`，DEC-1 改用 `fast-technical-indicators` | 两者都需同步改 SDD（§2.5 / §2.6 / §2.12.5），否则 SDD 与代码长期矛盾 |
| I-11 | **分级备份与恢复演练无任务** | SDD §6.5 行情 7 天/业务 30 天/远程 90 天 + 每月恢复演练 + CI 每月触发；代码 `backup.ts:98` 注释「OCI 上传 MVP T30 暂缓」；PRD §6.2「备份恢复验证通过率 100%」 | 需明确 MVP 是否交付远程备份；否则 PRD §6.2 该指标不可达 |
| I-12 | **前端 AuthGuard/AdminGuard 缺失** | SDD §2.12.2 定义 `AuthGuard` + `AdminGuard`（role!=='admin' → 重定向）；代码 `App.tsx:15` 只有 `if(!token) return <Login/>`，`/admin` 无角色守卫（靠后端 403） | 补前端守卫，或裁决「仅后端鉴权」并同步 SDD |
| I-13 | **PRD §5.7 两项细节漏做** | 「手动触发行情更新」漏**进度轮询显示**；「日志查看」漏**系统日志降级记录展示**（`logger.ts` 三层降级写文件，但无读取端点） | 并入 T75 |
| I-14 | **周K/月K 计划单方面解释 PRD 括注** | PRD §5.2「日/周/月（**MVP 仅日线**，周/月基于日线聚合）」；计划判为「MVP 做」并归 T70 | 裁决；若确认做，登记进 §9.3 |
| **I-15** | **`error` 字段语义不一致 + 前端把裸错误码直接上屏（2026-10-17 动态探针 + 静态核对新发现）** | 同一字段 `error` 有两种内容：`auth.ts:28` 放中文「用户名或密码错误」，`trade.ts:60` 放 `HOLDING_INSUFFICIENT`。前端 `Login.tsx:43` 等 **36 处**直接 `setError(res.data.error)`，`.message` **仅 2 处**被读 → **用户实际会看到 `NO_TOKEN` 这类裸码**（实测 401 响应即为此）。这直接导致 T64 的 `errorMessages.ts` 无法按「码」建表 | ✅ **已并入 T89a** —— `error` 统一为错误码、中文一律移入 `message`；前端 36 处改读 `message`。**这一步有正收益：立刻修掉一个线上 UX bug**（登录失败会重新显示「用户名或密码错误」而非错误码） |

### 13.3 次要级（口径/命名层面）

| # | 项 | 说明 |
|---|---|---|
| S-1 | SDD §4.1 的 10 组路由前缀分类法整体废弃 | 实际 22 个前缀，`/api/quote/*` 与 `/api/strategy/*` 两组为空 |
| S-2 | 索引名不符 | SDD `idx_trade_type`（代码**无此索引**）、`idx_signal_user_asset` vs 代码 `idx_signal_user_asset_date` |
| S-3 | `migrated_from_candidate` 未被计划提及 | 代码 `watch.ts:80,86` 在写，T50 只提 `migrated_price_mode` |
| S-4 | 计划内部矛盾 | DEC-2 落地方式写「含一次性数据订正」，DEC-9 与 T49 写「**不写**订正脚本」→ 应删除 DEC-2 的「含一次性数据订正」 |
| S-5 | SDD C12 节流数值自相矛盾 | §1.2 `200ms` / §5.6 `200ms/只` / §5.7 `每只间隔 500ms` |
| S-6 | SDD §5.7 开头写「第 2 段（17:02）调度校验」，与 §5.1「第 2 段 = 17:01 校验」矛盾 | 统一 |
| S-7 | React Query（SDD §2.12.3 强制）缺失 | `package.json` 无 `@tanstack/react-query`，计划无任务 |
| S-8 | 插件目录路径不统一 | SDD §5.3 `/opt/invest/plugins/` vs AGENTS.md 与 SDD 其他处 `/opt/invol/` |
| S-9 | Playwright | SDD §12.1「MVP 可选，Phase 4 启用」；T77 标「前端 E2E 标 V2」→ 登记偏差 |
| S-10 | PE4 未指定被压测路由 | SDD 指定 `/api/holding/current`（不存在），计划写 `/api/positions` |

---

### 13.4 所有者裁决结果（2026-10-17）


> 📌 **裁决的完整理由、代价与备选方案已归档至 `docs/adr/`**（2026-10-17 建立，8 份 ADR）。
> 本节只保留**待办清单**（哪条判了什么、派给哪个任务、SDD 需不需要改），**不重复决策理由** ——
> 避免计划文档同时充当「计划」与「决策记录」两种角色。索引见 `docs/adr/README.md`。

> | 主题 | ADR |
> |---|---|
> | 技术选型（指标库 / 图表库 / 测试框架） | [ADR-001](../adr/ADR-001-frontend-backend-stack.md) |
> | 响应封装与错误码契约 | [ADR-002](../adr/ADR-002-api-envelope-and-error-codes.md) |
> | 交易记录去重语义 | [ADR-003](../adr/ADR-003-trade-dedup-semantics.md) |
> | 数据校验完整性（C4/C5 + 测试映射） | [ADR-004](../adr/ADR-004-data-validation-integrity.md) |
> | 插件契约 / 50ms 计时边界 / 热重载 | [ADR-005](../adr/ADR-005-plugin-contract-and-timeout.md) |
> | 工程门槛暂缓与 Wave 验收分层 | [ADR-006](../adr/ADR-006-engineering-gates-and-wave-acceptance.md) |
> | 路由契约与候选池迁移语义 | [ADR-007](../adr/ADR-007-route-contract-and-candidate-migration.md) |
> 本节记录所有者对 §13.1 阻断项的**逐项裁决**。裁决即新约束，**优先于本计划此前的任何推断**。

| # | 裁决 | 落地任务 | 对真相源的影响 |
|---|---|---|---|
| **B-1** | ✅ **已裁决（2026-10-17 两轮）**：第一轮「需要实现 C4/C5」；第二轮因发现 **B-14**（C1-C12 编号定义与 Requirements §7.1 完全冲突）**整体重写为「对齐 Requirements 口径 + 补新鲜度校验」** → **T85（已重写）** | ✅ SDD §5.7 已按 Requirements 重写 C1-C8，并新增「📎 扩展校验」小节存放原 6 条内容校验（不占 C 编号）。SDD §5.7 C4/C5 的「略」占位已删除 |
| **B-14** | **C1-C12 编号定义：Requirements 与 SDD 完全不同** | SDD §5.7 的 C3-C8 为「数据**内容**校验」（停牌/退市/ST/价差/成交量/滞后）；`Requirements_simplified.md` §7.1 的 C3-C8 为「数据**新鲜度**校验」（复权因子/除权除息/板块/市值/价格合理性/更新时长）。**C1 判定式亦不同**（SDD 偏离均值 ±10% vs RQ ≥3000）。代码 `validator.ts` 遵循 SDD；**PRD §6.4「内部校验 C8 监控」站在 RQ 一边** | `Requirements_simplified.md` §7.1（最高优先级）+ PRD §6.4，**两层对一** | ✅ **已裁决（2026-10-17）：选 A —— 以 Requirements 为准**。SDD §5.7 已重写 C1-C8，原 6 条内容校验移入「📎 扩展校验」（不占 C 编号）；**T85 已整体重写**；G1.2 / G7.6 已同步 |
| **B-3** | ✅ **不应该计入** —— 50ms 预算**只覆盖插件自身 `execute()` 的计算**，**行情查询（DuckDB IO）不计入** | **T88** | SDD §5.3「硬限制 50ms」需补一句口径定义，否则每个实现者都会像初版那样把 IO 算进去 |
| **B-5** | ⏸️ **暂维持下调的覆盖率门槛，后续再补** | §12.4 E3 保留现值 + 标注待补；收尾由 **T86b** 承担 | SDD §12.2 与 §12.6 的 90% Gate 暂时冻结，**属已知偏差，§12.6 判定时不再据此判 FAIL** |
| **B-6** | ✅ **补 Wave 2 任务**（ESLint / Prettier / lint 脚本 / CI Stage 2） | **T86** | 恢复 SDD §12.6 CI Stage 2 的可达性 |
| **B-9** | ✅ **改代码** —— 采纳 SDD §4.2 的 `{code, data, timestamp}` envelope。**拆两阶段**：T89a（Wave 1，加字段 + 错误码归一，保留 `success`）/ T89b（Wave 8，删 `success`） | **T89a + T89b** | **无 SDD 改动**（代码向 SDD 靠拢）。SDD 错误码表实为 **§4.3**（非 §4.2），T89a 同步对齐 17(代码) → 10(SDD) 的码集差异。**拆阶段理由**：删 `success` 是唯一破坏性变更，而前端 `success` 有 20 处依赖、`error` 有 36 处，且前端测试基座 T61 在 Wave 2 —— Wave 1 做破坏性变更等于零回归保护 |
| **B-10** | ✅ **409** | **T84 / T89a** | 采纳 SDD §4.3 的 409；**需修掉 SDD §12.3 B1 的 400 笔误**（SDD 自身矛盾） |
| **B-11** | ✅ **追加**；**成交时间进主键，份额不进** | **T87** | 落地 SDD §12.3 B4「正常追加」。新 UNIQUE = `(user_id, asset_code, trade_type, trade_date, trade_time)`；`trade_time` **必填无默认**。**需给 SDD §4.3 补 `TRADE_DUPLICATE` 码**（现表 10 码不含它） |
| **B-12** | ✅ **以 SDD 为准** | **T90**（连带 I-1 的 15 处路由） | 路由名**不改 SDD**；仅统一 SDD §5.1.1 的简写与 §4.4 同名。T59 的 `run-pipeline` 取消 |
| **B-4** | ✅ **派任务补测试** | **T91** | §12.1 补「SDD 指定测试载体」列。实测：3 个测试文件不存在、`plugin.test.ts` 只有 1 个用例、**F11 DuckDB 备份恢复零覆盖** |
| **B-7** | ✅ **派任务改行为** —— 候选池迁移只打标记 | **T92** | 删除 `watch.ts:85-88` 的 INSERT 分支；改写 `watchPromote.test.ts:35` 断言 |
| **B-8** | ✅ **派任务补契约字段** | **T93** | `pluginEngine.ts:62-72` 补 7 个字段 + `PluginSignal.params`→`metrics` 统一；含字段完备性单测 |
| **B-13** | ✅ **属 MVP** | **T94** | §8 该条**删除**（初稿误读 AGENTS.md 的路径/扩展名/eval 约束为功能禁令）。⚠️ 实测沙盒与加载器**已实装**，只缺 admin 路由壳（0.5d） |

**新增任务一览**（均已写入 §5，编号接续 T84 之后）：

| ID | Wave | 任务 | 依赖 |
|---|---|---|---|
| **T85** | Wave 1 | 实现 C4（退市标记）/ C5（ST 状态一致性）两条校验 | 无 |
| **T86** | Wave 2 | ESLint + Prettier + 根 `lint`/`build` 脚本 + CI Stage 2 | 无（**T66 的前置**） |
| **T86b** | Wave 8 | 覆盖率达标后恢复 SDD §12.2 门槛与 90% 阻断 Gate | T60 / T61 |
| **T87** | Wave 1 | `trade_time` 输入（必填）+ UNIQUE 改「同日同刻」语义 | 🔒 **必须在 T49 之前或同期** |
| **T88** | Wave 1 | 插件 50ms 计时边界修正（行情查询移出预算）+ `while(true){}` 回归用例 | 🔒 建议先于 T83 |
| **T89a** | Wave 1 | 后端 envelope 统一（加 `code`/`timestamp`，保留 `success`）+ 错误码归一 17→10 + 状态码校正 + 前端 36 处改读 `message` | 🔒 与 T90 同批 |
| **T89b** | Wave 8 | 删除 `success` 字段 + 前端 20 处切 `code === 0` | 🔒 **必须等 T61**（Wave 2 前端测试基座） |
| **T90** | Wave 1 | 路由契约对齐 SDD §4.4 全 22 条（含 B-12） | 🔒 与 T89a 同批 |
| **T91** | Wave 1 | SDD §12.5 测试映射补齐 + 新建缺失测试文件 + F11 DuckDB 备份恢复用例 | T60 / T61 / T88 |
| **T92** | Wave 1 | 候选池迁移改为「只打标记，不建关联」 | 与 T50 同批 |
| **T93** | Wave 1 | 补齐插件契约字段（7 个）+ `params`→`metrics` 统一 | 🔒 与 T83/T58 同批 |
| **T94** | Wave 1 | 实现 `POST /api/strategy/reload`（仅补 admin 路由壳）+ 删除 §8 误判条目 | 无 |

### 13.5 裁决收口

**§13.1 全部 13 项阻断已裁决并派任务，0 项遗留。**

| 裁决批次 | 项 | 任务 |
|---|---|---|
| 第一批 | B-1 / B-3 / B-5 / B-6 / B-11 | T85 / T88 / T86b / T86 / T87 |
| 第三批 | B-9 / B-10 / B-12 | T89a+T89b / T84+T89a / T90 |
| 第三批 | B-4 / B-7 / B-8 / B-13 | T91 / T92 / T93 / T94 |

其中 **B-2 无需任务**（§12.1 的 PE6 已在本 PR 内补回），其对应的**运行时问题**已并入 B-3/T88。

> **§13.2 的 14 项重要级、§13.3 的 10 项次要级仍未裁决**（其中 I-1 已随 B-12 裁决）。这些多数是「口径命名」类，可在对应任务实施时顺手对齐；**若某项需改动 PRD/SDD 真相源，仍需所有者确认**。

> **13 项阻断已裁决 9 项**，剩 4 项。其中 B-4/B-7/B-8 影响 §12.6 判 PASS，B-13 需口径确认。

---

> **本章不阻塞开工**。原「B-1/B-3/B-5/B-6/B-11 必须在 T78 之前裁决」的限制**已解除**（五项均已裁决，见 §13.4）；剩余 8 项阻断项中，B-4/B-7/B-8 会影响 §12.6 判 PASS，B-9/B-10/B-12/B-13 需先裁决口径。
>
> **推荐开工顺序更新**：**T84（超卖校验）→ T87（交易追加语义 + trade_time）→ T49（7 种交易类型）→ T50/T56（候选池）→ T51/T52（指标库）**。理由：T84 与 T87 都改 `user_trade_record` 与持仓校验，且必须先于 T49 —— 三者改同一批 `switch` 分支与同一张表的 DDL/UNIQUE，先修校验与主键，再改 `sell`→`reduce` 命名，避免把已知漏洞换个名字保留。
>
> **切片 A（T49-T66 + T75-T76 + T80-T88，约 28 人天）**可立即开工。

---

## 附录 A：本计划关闭的 Gap → 任务映射

| Gap | 任务 |
|-----|------|
| P0-1 加仓类型缺失 | T49 |
| P0-2 候选池基准价 | T50 |
| P0-3 golden 数据集 | T51 |
| P0-4 前端零测试 | T61 |
| P0-5 signals 无 symbol 过滤 | T54 |
| P0-6 metrics_json/is_final | T58 |
| P0-7 register 缺失 | T57 |
| P0-8 refresh 缺失 | T57 + T64 |
| F-D1~F-D6 | T67 |
| F-T1~F-T6 | T68 |
| F-R1/F-R2 + page bug | T69 |
| F-K1~F-K8 | T70（+T53/T52/T58 供给） |
| F-S1~F-S5 + 409 bug | T73（+T55/T56 供给） |
| F-A1~F-A3 | T75（+T59 供给） |
| F-G1~F-G4 | T64 / T67 / T68 / T76 |
| F-Q1/F-Q2 | T62 |
| F-Q3~F-Q6 | T66 |
| F-Q7 死依赖 @fastify/jwt | T66（评估移除或改用它替换手写 JWT） |
| F-Q8 持仓 N+1 | T60 |
| F-Q9 rel_type='hold' | T58 |
| F-Q10 路由命名不一致 | T60（统一到 SDD §4.4 或登记偏差） |
| **P0-9 DuckDB 连接泄漏** | **T80（✅ 已实装并验证）** |
| **P0-12 DuckDB 并发互抢** | **T80（✅ 已实装并验证）** |
| **P0-10 DuckDB BigInt/DATE 序列化** | **T80（✅ 已实装并验证）** |
| **F-Q11 测试顺序依赖 / env 污染** | **T81** |
| **P0-10 DuckDB BigInt/DATE 序列化（股票 K 线 500）** | **T80（✅ 已实装并验证；原 T82 已关闭并入 T80）** |
| **P0-11 无 filter 类选股插件** | **T83** |
| **P0-13 持仓时点校验缺失（日期交错可超卖）** | **T84（必须在 T49 之前）** |
| **B-1 C4/C5 两条校验从未实现** | **T85**（§13.4 裁决：需要） |
| **B-3 插件 50ms 预算误含行情查询 → 100% 超时** | **T88**（§13.4 裁决：不计入）+ T83 依赖它 |
| **B-5 覆盖率门槛下调 / 90% Gate 删除** | **T86b**（§13.4 裁决：暂缓执行，届时恢复） |
| **B-6 Lint 阻断阶段无任务** | **T86**（§13.4 裁决：补 Wave 2）+ T66 依赖它 |
| **B-11 UNIQUE 拒绝同日分笔交易** | **T87**（§13.4 裁决：追加 + `trade_time` 进主键，**份额不进**），须先于 T49 |
| **B-9 统一响应封装缺失（SDD §4.2）** | **T89a**（Wave 1，加字段+错误码归一，**保留 `success`**）+ **T89b**（Wave 8，删 `success`） |
| **B-10 HOLDING_INSUFFICIENT 400 vs 409** | **T84 / T89a**（§13.4 裁决：**409**，并修 SDD §12.3 B1 笔误） |
| **B-12 + I-1 路由命名不一致（15 处）** | **T90**（§13.4 裁决：**以 SDD §4.4 为准**） |
| **B-4 SDD §12.5 测试映射丢失 + 3 个测试文件不存在 + F11 零覆盖** | **T91** |
| **B-7 候选池迁移违反 PRD S5（直接 INSERT watch 行）** | **T92** |
| **B-8 插件契约字段缺 7 个** | **T93**（与 T83/T58 同批） |
| **B-13 `/api/strategy/reload` 被误判 V2** | **T94**（属 MVP；底层已实装，只补路由壳） |
| **P0-14 审计方法论缺陷** | 留档，无任务 |
| **F-Q12 响应式横向溢出** | T76（fluid 容器 + 断点）/ T79 ①（表格卡片化）/ T65 |
| **F-Q13 401 跳转到不存在的 `/login`** | T57（refresh token）+ T64（真实 login 路由 + 保留路径） |
| **F-Q14 业务数值误用错误色** | T62（token 语义分层）+ T67/T75 |
| a11y 8 项 | T63 + T76 |

## 附录 B-2：UI 设计规格（已归位）

> 本附录原为「归档文档中仍然有效内容的保全清单」共 128 行。
> 因其内容**不是计划内容**（而是 UI 设计规格），且被 §12.3b 的 U1-U3 与 T62/T63/T67/T68/T76/T79 引用，
> 已于 2026-10-17 **归位为独立文档** → **[`docs/client/ui-spec.md`](ui-spec.md)**。
>
> 归位原因：计划文档只回答「什么时候做什么」，不回答「长什么样」。

| 原小节 | 内容 | 现位置 |
|---|---|---|
| B-2.1 | Design Token 具体数值 | `ui-spec.md` §1 |
| [ui-spec §2](ui-spec.md#2-按钮规格) | 按钮规格（primary/danger/ghost/secondary/disabled）| `ui-spec.md` §2 |
| [ui-spec §3](ui-spec.md#3-全站-14-类颜色清单) | 全站 14 类颜色清单 | `ui-spec.md` §3 |
| B-2.4 | 移动端断点与布局切换 | `ui-spec.md` §4 |
| B-2.5 | 布局宽度约束 | `ui-spec.md` §5 |
| B-2.6 | gap-audit 补充约束 | `ui-spec.md` §6 |


> **文档结束**。执行前请先拍板 §9 的 DEC-1 / DEC-2 / DEC-3（三项均阻塞 Wave 1-2 开工）。
