# MVP 代码实施计划（Phase 1-4 任务拆解）

> **唯一真相源**（按优先级排序）：
> 1. [`Requirements_simplified.md`](Requirements_simplified.md) — **业务规则权威**（WHAT，MVP In-Scope 边界、双口径公式、验收标准）
> 2. [`PRD.md`](PRD.md) — **用户体验权威**（用户故事、交互细节、页面布局）
> 3. [`SDD.md`](SDD.md) — **工程落地权威**（技术选型、DDL、时序图、API 设计）
> 4. [`MVP_code_implementation_plan.md`](MVP_code_implementation_plan.md) — **实施顺序**（本文档，T 任务拆解）
>
> **架构硬约束**：AGENTS.md 锁死 3 个 workspace（`packages/core` / `apps/backend` / `apps/frontend`）、better-sqlite3 推荐、Node ≥22、禁止前端直接 import core
> **任务粒度**：1-3 人天；每个 Phase 最后一条 commit 打 `fix:` 或 `test:` 前缀后验收清卡
> **里程碑边界**：M1/M2/M3/M4 各阶段最后一条 commit → 验收清卡
> **Commit 规范**：
> - **每个 T 任务一个 commit**（T1 / T2 / ... / Txx 各自独立提交），禁止多个半拉子攒一个大 commit
> - commit message 前缀：`feat:` 新功能 / `fix:` 修复 / `refactor:` 重构 / `test:` 测试 / `docs:` 文档 / `build:` 构建
> - 格式：`<prefix>: T<编号> <任务一句话描述>`，例：`feat: T3 移动加权成本算法 core 包实现`
> - **smoke-mX.test.ts 实装后单独一条 commit**
> - **每个 M 里程碑最后一条 commit** 必须是 `fix:` 或 `docs:` 或 `test:` 前缀（收尾整理），打 tag `M1`/`M2`/`M3`/`M4`

---

## ⚠️ v2 变更记录（2026-10-16）

**变更原因**：v1 计划与 Requirements §4.2 In-Scope 清单严重不一致——T 任务表砍了 F6 复盘统计、asset-stat 查询链路、插件管理 API、Settings 页、管理员角色/备份恢复等，但 Requirements 和 PRD 里这些还是 MVP 必交付。

**v2 修正**：

| # | 修正内容 | 涉及 Phase |
|---|---------|-----------|
| 1 | Phase 3 T33 Dashboard 补全：从"持仓汇总+信号"→ 增加**总资产卡（双口径收益切换）** + 资产饼图 | Phase 3 |
| 2 | Phase 3 新增 **T37 资产快照查询 API**：`GET /api/asset-stat/latest` + `GET /api/asset-stat/history` | Phase 3 |
| 3 | Phase 3 新增 **T38 复盘页** `/review`：交易列表+筛选+4字段编辑弹窗+胜率盈亏比统计 | Phase 3 |
| 4 | Phase 3 新增 **T39 交易分页+筛选+软删除+PATCH**：补齐 Requirements §5.1/§5.2 要求 | Phase 3 |
| 5 | Phase 3 新增 **T40 插件管理 API + Settings 页**：插件列表/启停/参数配置 | Phase 3 |
| 6 | Phase 3 新增 **T41 管理员：角色管理 + 备份恢复 API** | Phase 3 |
| 7 | **每个 Phase 末尾新增 T-GAP 审计任务**：系统性 diff Requirements/PRD/SDD vs 代码实现，输出 gap report 并闭合 | Phase 1-4 |
| 8 | Phase 4 任务编号后移：原 T37-T43 → T42-T48 | Phase 4 |
| 9 | T 任务总数：43 → 48 + 4 个审计任务 | 全局 |

---

## Phase 1：基础骨架 + 行情层打通（M1）

### 目标
搭 workspace 骨架 → 跑通 `tdx2db init` → Fastify 启动能读到 DuckDB 行情 → Core 算法有单测

| ID | 任务 | 交付物 | 测试要点 | 卡点 |
|---|---|---|---|---|
| T1 | 根 package.json + npm workspaces 配置 | 根目录 `package.json`（`"workspaces": ["packages/*", "apps/*"]`）+ `.gitignore`（已就绪） | `npm workspaces list` 能看到 3 个 workspace | 无 |
| T2 | **packages/core** 骨架：tsconfig + tsup + vitest + 零依赖约束 | `packages/core/package.json`（ESM+CJS dual format + d.ts）+ `tsconfig.json`（strict）+ `tsup.config.ts` | ① `npm run build` 产出 `dist/esm/index.js` + `dist/cjs/index.js` + `dist/index.d.ts`；② `import { SMA } from '@invest/core'` ESM 和 CJS 都能 import；③ `package.json` 里 `dependencies:{}` 空对象 | tsup ESM+CJS 双格式配置容易写错 |
| T3 | **packages/core**：移动加权平均成本算法 | `src/movingWeightedCost.ts` + 单元测试 | golden 数据集断言；精度误差 = 0 | 加权成本的除权修正口径（SDD §2.4） |
| T4 | **packages/core**：RSI 算法（Wilder 法） | `src/indicators/rsi.ts` + 单元测试 | golden 数据集断言；14 周期默认 | 无 |
| T5 | **packages/core**：MACD 算法 | `src/indicators/macd.ts` + 单元测试 | golden 数据集断言（EMA12/26 + DEA9） | EMA 初始值口径（用首值还是 SMA） |
| T6 | **packages/core**：插件接口契约（纯类型） | `src/plugin.ts`（`Plugin` interface：`name`, `execute(ctx, params)`）+ `ctx` 类型 | TypeScript 编译通过；禁止 import `node:*` 内置模块 | 无 |
| T7 | **apps/backend** 骨架：Fastify 4.x + better-sqlite3 + @fastify/schedule | `apps/backend/package.json` + `tsconfig.json` | ① `npm run dev` 监听 127.0.0.1:8080；② `/health` 返回 200；③ SQLite WAL 模式开启 | Fastify + better-sqlite3 ESM 兼容 |
| T8 | **apps/backend**：ConfigStore 单例（better-sqlite3 连接 + system_log 初始化） | `src/config/configStore.ts` + DDL | ① `PRAGMA WAL + busy_timeout=5000 + foreign_keys=ON`；② DDL 全部 `CREATE TABLE IF NOT EXISTS` | MVP 无迁移机制，禁止 schema_migrations |
| T9 | **apps/backend**：DuckDB 只读连接模块 | `src/db/duckdb.ts` | ① `SELECT 1` 正常；② 读 `v_stock_qfq` 有数据；③ 5 秒超时 + retry 2 次 | Node DuckDB bindings Windows/Linux arm64 |
| T10 | **Phase 1 部署：服务器上跑通 tdx2db** | systemd unit + 实测 DuckDB | ① `tdx2db init` 成功；② `duckdb .tables` 有 10 raw_ 表 + 6 视图 | hsjday.zip 首次几百 MB；Linux arm64 预编译二进制 |
| T11 | **apps/backend**：基础 API 骨架 + 鉴权中间件 | `src/routes/`（health + data_check）+ auth hook | ① `/api/health` 无需鉴权；② `/api/*` 需 JWT；③ 无 token → 401 | MVP 单用户，JWT 可简化 |
| T12 | **smoke-m1.test.ts**：Phase 1 冒烟测试 | E2E：启动 Fastify → `/api/health` → DuckDB 读 `v_stock_qfq` 最新一行 | 全 PASS → 打 `test:` commit | 无 |
| **T-GAP-1** | **Phase 1 系统审计**（验收项） | 输出 `docs/audit/M1-audit-report.md` | ① 列 Requirements §4.2 In-Scope 全 14 项，标注 M1 应实现的（Phase 1 只交付底座，In-Scope 大部分在后续 Phase）；② 列出 T1-T12 每项交付物 vs SDD/PRD/Requirements 的对应关系；③ 检查 AGENTS.md 硬约束是否全部遵守（3 workspace、better-sqlite3、127.0.0.1、禁止前端 import core）；④ 零 gap 确认后打 tag M1 | 容易漏查：core 包零依赖约束、DuckDB 只读权限 |

**M1 验收标准**：
- `npm run build` 在 3 个 workspace 全绿
- Core 包算法 golden 数据集零误差
- Fastify 监听 127.0.0.1:8080，能读 DuckDB `v_stock_qfq`
- SQLite system_log 表存在，WAL 模式开启
- smoke-m1 全 PASS
- **T-GAP-1 审计报告零 gap → 打 tag M1**

---

## Phase 2：数据校验引擎 + 插件引擎 + 除权自动导入（M2）

### 目标
跑通 5 段自动化里的前 3 段——数据质量先有、插件可跑、除权自动同步

| ID | 任务 | 交付物 | 测试要点 | 卡点 |
|---|---|---|---|---|
| T13 | **apps/backend**：指标计算 wrapper（SMA/RSI/MACD） | `src/services/indicators.ts` | 调 SMA 返回 golden 数据集一致结果；wrapper 层统一导出 | 禁止直接 import third-party 包 |
| T14 | **apps/backend**：插件引擎核心（沙盒 + 50ms 超时） | `src/services/pluginEngine.ts` | ① 禁止 `global/process/require`；② **Promise.race 50ms 超时硬杀**；③ paramsSchema 校验 | 50ms 低端 CPU 可能不够；MVP 硬超时，V2 VM2 |
| T15 | **apps/backend**：行情查询统一入口 | `src/services/marketData.ts` | ① `batchGetDaily` **1 次 IN 查询**（SDD §5.3）；② DuckDB 按需 open/close | IN 查询 100+ 标的 DuckDB 可能慢 |
| T16 | **apps/backend**：DataValidator C1-C6 | `src/services/validator.ts` | ① C1 行数；② C2 raw_holidays 交易日；③ C6 前复权 | C2 逻辑：有行=交易日 |
| T17 | **apps/backend**：DataValidator C7-C10 | 继续补 validator.ts | ① C7 价格合理性；② C8 除权跳变；③ C9 复权因子数学；④ C10 除权覆盖 | C8 跳变率公式注意口径 |
| T18 | **apps/backend**：DataValidator C11（Tushare） | validator.ts + API 调用 | ① 30 只抽样；② SKIP 条件：429/503/token 无效；③ 100ms 节流 | 每天 1 次 30 只够 |
| T19 | **apps/backend**：DataValidator C12（东财） | validator.ts + HTTP 调用 | ① 20 只抽样；② 10s 超时 + 200ms→400ms 退避；③ ≥5 只失败 → SKIP | 东财防爬虫，加 User-Agent |
| T20 | **apps/backend**：除权自动导入 cron | `src/jobs/exDividendSync.ts` | ① 每天 17:04 跑；② 读 raw_gbbq category=1；③ UNIQUE 防重 | T+1 除权除息日当天写入 |
| T21 | **apps/backend**：4 段 cron 调度器 | `src/jobs/scheduler.ts` | ① 17:02 校验；② 17:03 信号；③ 17:04 除权；④ 17:05 备份 | 共享同一 Fastify 实例 |
| T22 | **apps/backend**：writeSystemLog 三层降级 | `src/services/logger.ts` | SQLite → journald → 文件降级 | 每个分支单测 |
| T23 | **apps/backend**：C1-C12 结果写 system_log | 改 validator.ts | PASS/WARN/ERROR 各写一条 system_log；ERROR 输出 console | 索引 idx_system_log_date |
| T24 | **smoke-m2.test.ts**：Phase 2 冒烟测试 | 自动触发校验 → 查 system_log | 全 PASS → 打 `test:` commit | mock DuckDB 固定数据 |
| **T-GAP-2** | **Phase 2 系统审计**（验收项） | 输出 `docs/audit/M2-audit-report.md` | ① 列表 Requirements §4.2 #9/#10/#12（校验/三层防线/定时自动化）是否实现；② 检查 5 段 cron 链路完整性（validator → signal → exDividend → assetStat snapshot → backup）；③ 检查 AGENTS.md DuckDB 只读约束是否违反（写操作只允许 tdx2db）；④ 检查除权幂等性（ON CONFLICT DO NOTHING + UNIQUE 约束）；⑤ 零 gap 确认后打 tag M2 | 容易漏查：assetStat snapshot cron 钩子（17:02 信号生成末尾插入）、除权幂等是否正确 |

**M2 验收标准**：
- 插件能 execute，50ms 超时生效
- C1-C12 全部能跑，结果写 system_log
- 除权自动导入能从 raw_gbbq 同步
- smoke-m2 全 PASS
- **T-GAP-2 审计报告零 gap → 打 tag M2**

---

## Phase 3：前端 SPA + 交易闭环 + 复盘统计（M3）⚠️ v2 重大扩展

### 目标（v2 重写）
交易录入 → 持仓聚合 → 信号生成 → **复盘统计（双口径+胜率+盈亏比）** → 插件管理 → 管理员功能

> **v1 砍了什么导致本 Phase 要加任务**：Requirements §4.2 #2 写了"交易记账+持仓+移动加权成本+复盘统计完整闭环"，但 v1 计划 T33 Dashboard 只给了"持仓汇总+信号"、没给复盘页、没给 asset-stat 查询 API、没给插件管理 Settings 页、没给管理员角色/备份恢复。v2 全部补齐。

| ID | 任务 | 交付物 | 测试要点 | 卡点 |
|---|---|---|---|---|
| T25 | **apps/backend**：交易录入 API（含持仓充足校验 + TRADE_REASON_REQUIRED） | `src/routes/trade.ts` + DDL | ① 买入/加仓/减仓/清仓 + 7 种类型；② sell/reduce/clear **校验 HOLIDING_INSUFFICIENT**；③ TRADE_REASON_REQUIRED 校验；④ UNIQUE(user+symbol+trade_date+seq) 防重 | 持仓充足校验要实时查 SQLite |
| T26 | **apps/backend**：持仓聚合（基于交易记录动态算） | `src/services/positionCalculator.ts` | ① 从 user_trade_record 动态算 position；② 移动加权成本（调 core）；③ 除权后自动更新 | MVP 不持久化持仓表 |
| T27 | **apps/backend**：信号生成 cron（17:03） | `src/jobs/signalGenerate.ts` | ① 加载自选/持仓标的；② 跑 RSI/MACD；③ UNIQUE 防重；④ 50ms 超时 | 紧接 17:02 校验 |
| T28 | **apps/backend**：信号查询 API | `src/routes/signal.ts` | ① trade_date + plugin_id + direction 筛选；② 分页 | 无 |
| T29 | **apps/backend**：管理员 API v1（手动触发 + system_log 查看） | `src/routes/admin.ts` | ① POST run-datacheck；② POST run-signal；③ GET system-log 分页 | MVP 单用户，role=admin 同 JWT |
| T30 | **apps/backend**：17:05 双库备份 cron | `src/jobs/backup.ts` | ① SQLite db.backup() 热备份；② DuckDB VACUUM INTO；③ 本地保留 3 天；④ 可选 OCI rclone upload；⑤ 降级：OCI 不可用 → 本地保留 | rclone 配置提前 mount |
| T31 | **apps/frontend**：Vite + React + Zustand 骨架 | `apps/frontend/` | ① dev 监听 5173；② proxy `/api` → 8080；③ fetch('/api/health') 正常 | vite.config.ts proxy target 写死 8080 |
| T32 | **apps/frontend**：全局状态 + API client | `src/store/user.ts` + `src/api/client.ts` | ① token localStorage；② 401 → 跳登录；③ 错误 toast | 无 |
| T33 | **apps/frontend**：仪表盘页面（v2 补齐） | `src/pages/Dashboard.tsx` | ① **总资产卡**：总资产、总盈亏、总收益率、**双口径切换**（PRD §5.3）；② 资产组成饼图（股票 vs ETF）；③ 持仓卡片列表（每只：代码+名称+现价+持仓+avgCost+盈亏+收益率+仓位占比）；④ 最新插件信号列表；⑤ 最近 system_log 摘要 | 总资产卡需要调 T37 的 asset-stat API |
| T34 | **apps/frontend**：交易录入页面 | `src/pages/TradeInput.tsx` | ① 代码输入；② trade_reason 必填（买入类/卖出类动态）；③ fee 字段（默认 0）；④ price step=0.0001；⑤ 实时预估新均价；⑥ 减仓超持仓禁用提交 | TRADE_REASON_REQUIRED 前端联动后端 |
| T35 | **apps/frontend**：信号查看 + K 线图 + 选股 | `src/pages/Signals.tsx` + `src/pages/Kline.tsx` + `src/pages/StockScan.tsx` | ① 信号列表筛选；② K 线前复权 + MA/MACD/RSI 副图；③ 选股插件下拉 + 动态参数表单 + 结果≤100 | K 线图后端算好 MACD/RSI 一起返回（AGENTS.md 禁止前端 import core）|
| T36 | **apps/frontend**：管理员面板 | `src/pages/Admin.tsx` | ① 12 项校验仪表盘四色 + 详情展开；② 手动触发 run-datacheck/run-signal；③ system_log 分页 + 日期/类型过滤 | role=admin 才能访问 |
| **T37** ⚠️v2新增 | **apps/backend**：资产快照查询 API（双口径收益最后一公里） | `src/routes/assetStat.ts` | ① `GET /api/asset-stat/latest`：返回当前用户最新快照（price_yield + actual_yield + total_cost + market_value + realized_pnl）；② `GET /api/asset-stat/history?days=30`：返回近 N 天快照数组（用于收益曲线）；③ 需要 assetStat.ts 写层已实现（M2 末尾已加 17:02 cron 快照钩子） | **M2 实现阶段 assetStat.ts 已经写了 calc + snapshot 写入 + DDL，本任务只补查询路由——工作量 0.5 天** |
| **T38** ⚠️v2新增 | **apps/frontend**：复盘页 `/review`（交易列表 + 4 字段编辑 + 胜率盈亏比） | `src/pages/Review.tsx` + App.tsx 加路由 | ① 顶部 Tab：**价格收益率 / 实际收益率**切换（PRD §5.5）；② 交易列表：按 trade_type/strategy_match/is_stop_loss/日期范围筛选；③ 每笔交易可编辑复盘 4 字段（PRD §T6）：复盘总结、是否符合策略、是否止损、备注（三态字段默认未标记显示灰色）；④ 大卡片展示：胜率、盈亏比（平均盈利/平均亏损） | 复盘归因统计需要后端 `/api/trades?reviewed=true/false` 筛选 + 前端聚合胜率 |
| **T39** ⚠️v2新增 | **apps/backend**：交易列表分页 + 筛选 + 软删除 + PATCH 复盘字段 | 改 `src/routes/trade.ts` | ① `GET /api/trades` 加 page/limit/asset_code/trade_type/start_date/end_date/strategy_match/is_stop_loss/has_review（复盘字段有值的交易）筛选；② `PATCH /api/trades/:id` 只允许改 review_note/strategy_match/is_stop_loss/remark（trade_type/price/quantity 禁止修改）；③ `DELETE /api/trades/:id` 软删除（is_deleted=1）；④ `POST /api/trades/:id/restore` 恢复（is_deleted=0）；⑤ 所有 PATCH/DELETE 写 system_log | Requirements §5.1 永久留痕 + §5.2 复盘补充字段 |
| **T40** ⚠️v2新增 | **apps/frontend**：Settings 页 + 插件管理（列表/启停/参数配置） | `src/pages/Settings.tsx` + App.tsx 加路由 + 后端 `src/routes/plugin.ts` | ① **后端**：`GET /api/plugins` 返回内置+自定义插件列表（含分类、参数 schema、enabled）；`POST /api/plugins/:id/config` 保存用户参数；`POST /api/plugins/:id/toggle` 启用/禁用；② **前端**：插件列表卡片 + 点击展开参数表单 + 保存按钮；全局设置（交易成本默认值等） | MVP 只做内置插件 RSI/MACD 的参数配置 + 启停；自定义插件热加载 V2 Out-Scope |
| **T41** ⚠️v2新增 | **apps/backend**：管理员角色管理 + 备份恢复 API | 改 `src/routes/admin.ts` | ① `GET /api/admin/users`：列出所有用户 + role；② `PATCH /api/admin/users/:id/role`：升级/降级（admin 只能有 1 人，可转移，禁止降级自己）；③ `POST /api/admin/backup`：手动触发备份（复用 backup.ts 逻辑）；④ `GET /api/admin/backups`：列出备份文件（日期+体积）；⑤ `POST /api/admin/backup/:file/restore`：恢复备份（二次确认 + system_log 记录） | Requirements §5.9 管理员权限完整闭环 |
| T42 | **smoke-m3.test.ts**：Phase 3 冒烟测试 | E2E：交易录入 → 持仓正确 → 信号生成 → 复盘页能看收益 | 全 PASS → 打 `test:` commit | mock DuckDB + Fastify cron |
| **T-GAP-3** ⚠️v2新增 | **Phase 3 系统审计**（验收项） | 输出 `docs/audit/M3-audit-report.md` | ① Requirements §4.2 In-Scope 14 项逐项核对：1-10 项全部 PASS（Phase 3 核心交付），11-14 项依赖 Phase 4；② SDD §12.5 验收项功能 10 项（F1-F11）逐项核对，标注 PASS/PARTIAL/FAIL；③ **重点核对双口径收益链路**：assetStat.ts 写层（M2）→ snapshot 写入 cron（M2）→ 查询 API T37 → Dashboard T33 展示 → 复盘页 T38 切换，整条链路从 DB 到 UI 零断点确认；④ 检查复盘 4 字段（review_note/strategy_match/is_stop_loss/remark）DDL 列存在 + PATCH 路由 + 前端编辑弹窗，三端闭环；⑤ 检查 trade_reason TRADE_REASON_REQUIRED 前后端双重校验；⑥ 检查软删除 is_deleted 列 DDL + DELETE 路由 + 恢复路由；⑦ 零 gap 确认后打 tag M3 | **这是 v2 最重要的审计**——Phase 3 新增任务最多、gap 风险最大、影响 MVP 交付判定 |

**M3 验收标准（v2 重写）**：
- ✅ 能录入 7 种交易 → 持仓正确计算 → 信号自动生成（T25-T28）
- ✅ 前端完整可用：持仓页（双口径总资产卡）+ K 线图 + 信号列表 + 选股 + 交易录入 + 管理员面板 + **复盘页** + **Settings 插件管理**（T33-T36 + T37-T40）
- ✅ **复盘页双口径切换 + 4 字段编辑 + 胜率盈亏比统计**（T38）
- ✅ **管理员角色管理 + 备份恢复**（T41）
- ✅ 5 段定时自动化打通（T21 + T30）
- ✅ smoke-m3 全 PASS
- ✅ **T-GAP-3 审计报告零 gap → 打 tag M3**

---

## Phase 4：部署 + 验收 + 文档（M4）

### 目标
部署到 Linux arm64 服务器 → 全链路跑通 → Requirements 10.1 全部验收标准全过

| ID | 任务 | 交付物 | 测试要点 | 卡点 |
|---|---|---|---|---|
| T43 | systemd unit：tdx2db + tdx2db-update.timer + Fastify + Caddy | `deploy/` 目录下 unit 文件 | ① tdx2db.service `Type=oneshot` + timer `OnCalendar=*-*-* 17:00:00`；② invest-assistant.service；③ Caddy 自动 HTTPS | ExecStart 绝对路径 |
| T44 | CI Pipeline（GitHub Actions） | `.github/workflows/ci.yml` | ① install → build → test（vitest run）→ coverage ≥70%；② Node 22 + ubuntu-latest | coverage-final.json 先本地跑一次 |
| T45 | Security hardening：CORS + 监听 127.0.0.1 + Caddy HTTPS | Fastify listen 127.0.0.1 + CORS localhost | Fastify 禁止 0.0.0.0；Caddy 301 HTTP → HTTPS | AGENTS.md 硬约束 |
| T46 | **Requirements §10.1 验收走查**（正式验收） | 逐项 PASS 记录 | 功能 11 项 + 性能 6 项 + 安全 6 项 + 合规 1 项；**双口径收益、复盘、备份恢复必须全 PASS** | 逐条跑 |
| T47 | 文档补齐：README.md + 运维手册 | 根 README + `docs/deploy.md` | README 含快速开始 + 架构图 + 目录结构 | |
| T48 | **smoke-m4.test.ts**：端到端完整验收 | 从登录 → 交易 → 信号 → 复盘 → 备份恢复 全链路 | 全 PASS → 打 `test:` commit | |
| **T-GAP-4** ⚠️v2新增 | **Phase 4 系统审计**（最终验收） | 输出 `docs/audit/M4-final-audit-report.md` | ① Requirements §4.2 In-Scope 14 项**全部** PASS；② SDD §12.5 全部验收项 PASS；③ 检查 Out-Scope 功能（分钟 K、推荐交易、微信小程序等）没有被偷偷实现；④ 检查备份恢复完整流程（手动备份 → 恢复验证 → 业务数据完整性）；⑤ 检查安全（CORS、监听 127.0.0.1、日志脱敏、密码不明文）；⑥ CI Pipeline 全绿；⑦ systemd timer 每天 17:00 自动触发 tdx2db；⑧ 零 gap → 打 tag M4 + 合并 main | 最终守门人，任何一项 FAIL 不能交付 |

**M4 验收标准**：
- Requirements §10.1 验收全 PASS
- CI Pipeline 全绿
- systemd timer 每天 17:00 自动触发完整链路
- **T-GAP-4 最终审计零 gap → 打 tag M4**

---

## 里程碑时间线（v2 参考：单人开发）

```
Week 1  [M1] T1-T12 + T-GAP-1   骨架 + core 算法 + backend 基础 + DuckDB 读取
Week 2  [M2] T13-T24 + T-GAP-2  插件引擎 + 数据校验 + 除权导入 + 4 段 cron
Week 3  [M3a] T25-T36           交易录入 + 信号生成 + 前端 SPA + 仪表盘(双口径)
Week 4  [M3b] T37-T42 + T-GAP-3 资产快照查询 + 复盘页 + 插件管理 + 管理员角色 + smoke-m3
Week 5  [M4] T43-T48 + T-GAP-4  部署 + CI + 最终验收 + 审计
```

---

## 阻塞点前置清单（Phase 1 启动前必须解决）

| # | 内容 | 状态 |
|---|---|---|
| 1 | tdx2db schema（表名/列名/视图逻辑） | ✅ 已实测 |
| 2 | Node ≥22 + better-sqlite3 v13+ | ✅ 已锁定 |
| 3 | tdx2db 预编译二进制 | ✅ 已确认 |
| 4 | 远程备份 OCI Object Storage | ✅ 已选定 |
| 5 | Tushare token + `.env.local` | ✅ 已创建模板 |
| 6 | 东财 C12 接口 URL | ✅ 已实测 |
| 7 | 插件沙盒方案（new Function + Proxy globalThis）| ✅ 已决 |
| 8 | **复盘页交互原型（v2 新增）** | ⚠️ Phase 3 前设计 |
| 9 | **Settings 页插件管理交互原型（v2 新增）** | ⚠️ Phase 3 前设计 |

---

## 禁止 Out-Scope 功能（AGENTS.md 硬约束）

- ❌ 微信小程序 / 云函数
- ❌ 分钟 K 线 / 盘中实时信号
- ❌ VM2 硬隔离插件沙盒（V2）
- ❌ 多用户 SaaS 模式（MVP 单用户）
- ❌ 交易下单对接券商
- ❌ Prometheus/Grafana 监控
- ❌ `schema_migrations` 迁移表（DDL 用 `CREATE TABLE IF NOT EXISTS`）
- ❌ `node:sqlite` 替代 better-sqlite3
- ❌ **插件热重载运行时扫描自定义 .js 文件**（V2 Out-Scope，MVP 只做内置插件参数配置）

---

## T-GAP 审计模板（每个 Phase 末尾必填）

```markdown
## Phase X 系统审计报告

### 1. Requirements §4.2 In-Scope 14 项核对
| # | 功能 | 对应 Phase | 状态 | 证据（代码文件+行号） |
|---|------|-----------|------|---------------------|

### 2. SDD §12.5 验收项核对
| 验收项 | 标准 | 状态 | 说明 |
|--------|------|------|------|

### 3. PRD 用户故事核对
| 用户故事 | 功能 | 状态 | 说明 |
|----------|------|------|------|

### 4. AGENTS.md 硬约束检查
| 约束 | 状态 | 说明 |
|------|------|------|

### 5. Gap 清单
| # | Gap | 优先级 | 归属 Phase |
|---|-----|--------|-----------|

### 6. 结论
- Phase X 交付是否符合 Requirements §10.1 验收标准？是/否
- Gap 是否全部闭合？是/否
- 是否可以打 tag MX？是/否
```
