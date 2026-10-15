# MVP 代码实施计划（Phase 1-4 任务拆解）

> **唯一真相源**：[`SDD.md`](SDD.md)（工程设计）+ [`Requirements_simplified.md`](Requirements_simplified.md)（业务规则）+ [`tdx2db_schema.md`](../tdx2db_schema.md)（DuckDB 实测字段）
> **架构硬约束**：AGENTS.md 锁死 3 个 workspace（`packages/core` / `apps/backend` / `apps/frontend`）、better-sqlite3 推荐、Node ≥22、禁止前端直接 import core
> **任务粒度**：1-3 人天；每个 Phase 最后一条 commit 打 `fix:` 或 `test:` 前缀后验收清卡
> **里程碑边界**：M1/M2/M3/M4 各阶段最后一条 commit → 验收清卡

---

## Phase 1：基础骨架 + 行情层打通（M1）

### 目标
搭 workspace 骨架 → 跑通 `tdx2db init` → Fastify 启动能读到 DuckDB 行情 → Core 算法有单测

| ID | 任务 | 交付物 | 测试要点 | 卡点 |
|---|---|---|---|---|
| T1 | 根 package.json + npm workspaces 配置 | 根目录 `package.json`（`"workspaces": ["packages/*", "apps/*"]`）+ `.gitignore`（已就绪） | `npm workspaces list` 能看到 3 个 workspace | 无 |
| T2 | **packages/core** 骨架：tsconfig + tsup + vitest + 零依赖约束 | `packages/core/package.json`（ESM+CJS dual format + d.ts）+ `tsconfig.json`（strict）+ `tsup.config.ts`（entry `src/index.ts`） | ① `npm run build` 产出 `dist/esm/index.js` + `dist/cjs/index.js` + `dist/index.d.ts`；② `import { SMA } from '@invest/core'` ESM 和 CJS 都能 import；③ `package.json` 里 `dependencies:{}` 空对象 | tsup ESM+CJS 双格式配置容易写错 |
| T3 | **packages/core**：移动加权平均成本算法 | `src/movingWeightedCost.ts` + 单元测试 | golden 数据集断言（`tests/fixtures/golden/movingWeightedCost.json`）；精度误差 = 0 | 加权成本的除权修正口径（SDD §2.4） |
| T4 | **packages/core**：RSI 算法（Wilder 法） | `src/indicators/rsi.ts` + 单元测试 | golden 数据集断言；14 周期默认 | 无 |
| T5 | **packages/core**：MACD 算法 | `src/indicators/macd.ts` + 单元测试 | golden 数据集断言（EMA12/26 + DEA9） | EMA 初始值口径（用首值还是 SMA） |
| T6 | **packages/core**：插件接口契约（纯类型） | `src/plugin.ts`（`Plugin` interface：`name`, `execute(ctx, params)`）+ `ctx` 类型 | TypeScript 编译通过；禁止 import `node:*` 内置模块 | 无 |
| T7 | **apps/backend** 骨架：Fastify 4.x + better-sqlite3 + @fastify/schedule | `apps/backend/package.json`（依赖：`fastify`、`@fastify/schedule`、`better-sqlite3`、`@fastify/cors`）+ `tsconfig.json` | ① `npm run dev` 启动监听 127.0.0.1:8080；② `/health` 返回 200；③ SQLite WAL 模式开启（`PRAGMA journal_mode=wal`） | Fastify + better-sqlite3 ESM 兼容（better-sqlite3 v13 支持 Node 22 ESM） |
| T8 | **apps/backend**：ConfigStore 单例（better-sqlite3 连接 + system_log 初始化） | `src/config/configStore.ts`（better-sqlite3 new Database + PRAGMA 初始化）+ DDL | ① SQLite 启动时自动 `PRAGMA WAL + busy_timeout=5000 + foreign_keys=ON`；② `system_log` 表 `CREATE TABLE IF NOT EXISTS` 存在 | DDL 全部用 `CREATE TABLE IF NOT EXISTS`（MVP 无迁移机制，AGENTS.md 明确禁止 schema_migrations） |
| T9 | **apps/backend**：DuckDB 只读连接模块 | `src/db/duckdb.ts`（按需 open/close，禁止写入）+ 连接超时 | ① `SELECT 1` 返回正常；② 读 `v_stock_qfq LIMIT 1` 有数据（需先跑 T10）；③ 5 秒超时 + retry 2 次 | Node DuckDB bindings 在 Windows 开发机 vs Linux arm64 目标机都要装对 |
| T10 | **Phase 1 部署：服务器上跑通 tdx2db** | systemd unit + 实测 DuckDB 文件 | ① `tdx2db init` 成功；② `duckdb .tables` 看到 10 raw_ 表 + 6 视图；③ `duckdb DESCRIBE raw_kline_daily` 确认列名是 `date` 不是 `trade_date` | ⚠️ 第一次拉 hsjday.zip 可能几百 MB，注意网络；Linux arm64 预编译二进制要对 |
| T11 | **apps/backend**：基础 API 骨架 + 鉴权中间件 | `src/routes/`（health + data_check + 占位交易）+ `src/middleware/auth.ts` | ① `/api/health` 无需鉴权返回 200；② `/api/*` 需 JWT；③ 无 token 返回 401 | MVP 单用户，JWT 可简化为硬编码 token 验证（不查 DB） |
| T12 | **smoke-m1.test.ts**：Phase 1 冒烟测试 | E2E 测试：启动 Fastify → `/api/health` → DuckDB 读 `v_stock_qfq` 最新一行 | 全部 PASS → 打 `test:` commit 后 M1 清卡 | 无 |

**M1 验收标准**：
- `npm run build` 在 3 个 workspace 全绿
- Core 包算法 golden 数据集零误差
- Fastify 监听 127.0.0.1:8080，能读 DuckDB `v_stock_qfq`
- SQLite system_log 表存在，WAL 模式开启
- smoke-m1 全 PASS

---

## Phase 2：数据校验引擎 + 插件引擎 + 除权自动导入（M2）

### 目标
跑通 5 段自动化（校验 / 信号 / 除权 / 备份）里的前 3 段——数据质量先有、插件可跑、除权自动同步

| ID | 任务 | 交付物 | 测试要点 | 卡点 |
|---|---|---|---|---|
| T13 | **apps/backend**：`fast-technical-indicators` 集成 | `package.json` 依赖声明 + `src/services/indicators.ts`（wrapper 层暴露 SMA/RSI/MACD） | ① 调 SMA 返回 golden 数据集一致结果；② wrapper 层禁止直接 import 原包（通过 wrapper 统一导出方便切换） | 原包零依赖但 API 签名可能有差异，先写 wrapper 再测 |
| T14 | **apps/backend**：插件引擎核心（热加载 + 沙盒 + 50ms 超时） | `src/services/pluginEngine.ts` | ① 从 `/opt/invol/plugins/strategies/*.js` 加载；② 禁止 `global/process/require`（`new Function()` 构造器限制 + `Function.prototype.constructor = null`）；③ **Promise.race 50ms 超时硬杀**；④ paramsSchema 声明校验（SDD §5.3 ParamField） | ⚠️ 50ms 超时可能让插件在低端 CPU 上跑不完；MVP 用硬超时，V2 上 VM2 |
| T15 | **apps/backend**：行情查询统一入口（插件和校验共用） | `src/services/marketData.ts` | ① `getDailyBySymbol(date, symbol)` → 查 `v_stock_qfq`；② `batchGetDaily(date, symbols[])` → **1 次 IN 查询**（SDD §5.3：1 次 IN → N 插件共享，禁止逐标的循环查）；③ DuckDB 按需 open/close | IN 查询超过 100 标的时 DuckDB 可能慢，MVP 不需要分批 |
| T16 | **apps/backend**：DataValidator C1-C6 实现 | `src/services/validator.ts`（6 个校验函数） | ① C1 行数统计 SQL → 跑通；② C2 `raw_holidays` 只有 date 列（无 is_trading_day）→ 用 `EXISTS (SELECT 1 FROM raw_holidays WHERE date = ?)`；③ C6 前复权公式对齐 `v_stock_qfq.qfq_factor` | C2 逻辑：有 raw_holidays 行 = 交易日，之前 SDD 写反了一次，注意别再写反 |
| T17 | **apps/backend**：DataValidator C7-C10 实现 | 继续补 validator.ts | ① C7 成交量异常 SQL；② C8 除权跳变（`raw_gbbq.category=1`, `c1/10`, `c3/10`）；③ C9 `raw_adjust_factor.hfq_factor`（不是 factor）；④ C10 除权覆盖完整性 | C8 跳变率公式：`(c1/10)/prev_close - (c3/10)/(1+c3/10)`，容差 0.5% |
| T18 | **apps/backend**：DataValidator C11（Tushare） | `src/services/validator.ts` + Tushare API 调用 | ① 限流 50 次/分钟（实测）；② 调 daily 接口拿 pre_close；③ 30 只抽样比对 DuckDB vs Tushare；④ SKIP 条件：429/503/token 无效 | 每天 1 次 30 只，`100ms` 节流够吗？够（3 秒完成）；但别并发调，顺序调 |
| T19 | **apps/backend**：DataValidator C12（东财） | 同上 + 东财 HTTP 调用 | ① fqt=1 前复权；② 20 只抽样、单只 10s 超时、退避重试 2 次（200ms → 400ms）；③ 外部源连续 ≥5 只失败 → 整项 SKIP | 东财 HTTP 接口可能防爬虫，MVP 直接 `fetch`，可能需要设置 User-Agent |
| T20 | **apps/backend**：除权自动导入 cron | `src/jobs/exDividendSync.ts` | ① 每天 17:04 跑（校验+信号之后）；② 读 `raw_gbbq WHERE category=1 AND date = ?`；③ 写入 `user_stock_event` 表（UNIQUE user+symbol+date+type）；④ ON CONFLICT DO NOTHING | 除权自动导入逻辑是 **T+1**——除权除息日当天写入 |
| T21 | **apps/backend**：Fastify 内部 4 段 cron 调度器串起来 | `src/jobs/scheduler.ts`（@fastify/schedule） | ① 17:02 校验；② 17:03 信号；③ 17:04 除权；④ 17:05 备份；⑤ 共享同一 DuckDB 只读连接池 | 4 段用同一个 Fastify 实例 → 同一进程 → 同一 DuckDB 连接池，没问题 |
| T22 | **apps/backend**：writeSystemLog 三层降级 | `src/services/logger.ts` | ① 正常：写 SQLite system_log；② SQLite 不可用：降级写 `journald`（`console.error` 触发 systemd 捕获）；③ 都不可用：降级写 `/var/log/invol/err.log` 文件 | 降级路径每个分支都要单元测试 |
| T23 | **apps/backend**：C1-C12 结果写 system_log | 改 validator.ts | ① 每条校验 PASS/WARN/ERROR 写一条 system_log；② WARN 写 detail 说明；③ ERROR 触发管理员告警（MVP 阶段先 console 输出，V2 加邮件） | system_log DDL：`CREATE INDEX idx_system_log_date ON system_log(log_date, log_type, level)` |
| T24 | **smoke-m2.test.ts**：Phase 2 冒烟测试 | 自动触发 17:02 校验 → 查 system_log 验证 | 全部校验有结果写 system_log；至少 3 条日志记录 | 可能要 mock DuckDB 返回固定数据保证断言稳定 |

**M2 验收标准**：
- 插件能从 `/opt/invol/plugins/strategies/` 加载并 execute
- C1-C12 全部能跑，结果写 system_log
- 除权自动导入 cron 能从 raw_gbbq category=1 同步
- smoke-m2 全 PASS → 打 `test:` commit

---

## Phase 3：前端 SPA + 交易录入 + 信号生成 + 备份 cron（M3）

### 目标
交易记录、策略信号、前端 UI 三件套补齐，MVP 核心功能闭环

| ID | 任务 | 交付物 | 测试要点 | 卡点 |
|---|---|---|---|---|
| T25 | **apps/backend**：交易录入 API（含持仓充足校验） | `src/routes/trade.ts` + DDL 补齐 user_trade_record | ① 买入：校验资金充足；② **卖出**：**校验持仓充足**（`HOLDING_INSUFFICIENT` 业务错误码）；③ UNIQUE(user+symbol+trade_date+seq) 防重 | 持仓充足校验要实时查 SQLite user_holding 表（可能需要 INSERT/UPDATE 表结构） |
| T26 | **apps/backend**：持仓聚合逻辑（基于交易记录） | `src/services/positionCalculator.ts` | ① 从 user_trade_record 实时算 position；② 移动加权成本（调 core 包）；③ 除权自动导入后调 positionCalculator | MVP 不持久化持仓表（从交易记录动态算）；如果性能不够再加 user_holding 表 |
| T27 | **apps/backend**：信号生成 cron（17:03） | `src/jobs/signalGenerate.ts` | ① 加载用户自选/持仓标的；② 跑所有插件（RSI/MACD/SMA 等）；③ UNIQUE(user+symbol+plugin_id+trade_date) 防重；④ 触发 50ms 超时保护 | 17:03 紧接 17:02 校验，要在 validator 完成后触发 |
| T28 | **apps/backend**：信号查询 API | `src/routes/signal.ts` | ① 支持 trade_date + plugin_id + direction 筛选；② UNIQUE 约束确保每天每标的每插件最多一条 | 无 |
| T29 | **apps/backend**：管理员 API（手动触发 + system_log 查看） | `src/routes/admin.ts` | ① POST `/api/admin/run-datacheck` 手动跑 C1-C12；② GET `/api/admin/system-log` 分页查询日志 | MVP 单用户，管理员 API 可以用同一个 JWT 鉴权（加 admin role 字段） |
| T30 | **apps/backend**：17:05 双库备份 cron | `src/jobs/backup.ts` | ① SQLite：better-sqlite3 `db.backup(path)` 热备份；② DuckDB：`COPY v_stock_qfq TO '/tmp/backup.parquet'`（只读副本）；③ 本地 `/opt/invol/backup/` 保留 3 天；④ 上传 OCI Object Storage（rclone copyto）；⑤ 失败日志写 system_log | OCI rclone 配置要在部署时提前 mount 好；备份脚本要处理"OCI 不可用 → 本地保留 3 天"的降级 |
| T31 | **apps/frontend**：Vite + React + Zustand 骨架 | `apps/frontend/package.json`（依赖：`react`、`zustand`、`@tanstack/react-query`）+ `vite.config.ts`（proxy `/api` → localhost:8080） | ① `npm run dev` 监听 5173；② proxy 正确转发；③ 组件能 fetch('/api/health') | vite.config.ts proxy target 写死 8080（AGENTS.md 端口分配） |
| T32 | **apps/frontend**：全局状态管理 + API client | `src/store/user.ts`（Zustand）+ `src/api/client.ts`（统一封装 fetch + JWT header + 错误处理） | ① 登录后 token 存 localStorage；② 401 自动跳登录页；③ API 错误 toast 提示 | 无 |
| T33 | **apps/frontend**：仪表盘页面 | `src/pages/Dashboard.tsx` | ① 最近 system_log 摘要；② 持仓汇总；③ 最新插件信号列表 | 无 |
| T34 | **apps/frontend**：交易录入页面 | `src/pages/TradeInput.tsx` | ① 代码输入（支持 sh600000/sz000001 格式）；② 方向/数量/价格；③ 提交后持仓实时更新；④ 卖出不足给 HOLDING_INSUFFICIENT 提示 | 无 |
| T35 | **apps/frontend**：信号查看 + 管理员面板 | `src/pages/Signals.tsx` + `src/pages/Admin.tsx` | ① 信号列表（可按日期/插件/方向筛选）；② 管理员面板看 system_log 分页 + 手动触发数据校验 + toast 通知校验结果 | 管理员面板需要 role=admin 才能访问 |
| T36 | **smoke-m3.test.ts**：Phase 3 冒烟测试 | E2E：交易录入 → 信号生成 → 前端 fetch → 备份触发 | 全部 PASS → 打 `test:` commit 后 M3 清卡 | 可能需要 mock DuckDB + systemd timer |

**M3 验收标准**：
- 能录入一笔交易 → 持仓正确计算 → 第二天插件能给出信号
- 前端页面能展示持仓和信号
- 17:05 备份能自动触发并上传 OCI
- smoke-m3 全 PASS

---

## Phase 4：部署 + 验收 + 文档（M4）

### 目标
部署到 Linux arm64 服务器 → 全链路跑通 → 24 项验收标准全过

| ID | 任务 | 交付物 | 测试要点 | 卡点 |
|---|---|---|---|---|
| T37 | systemd unit：tdx2db + tdx2db-update.timer + Fastify + Caddy | `deploy/` 目录下 4 个 unit 文件 | ① tdx2db.service `Type=oneshot` + tdx2db-update.timer `OnCalendar=*-*-* 17:00:00` + `Persistent=true`；② invest-assistant.service `Type=simple` `User=invol`；③ caddy.service 自动 HTTPS | systemd unit 里路径要对；`ExecStart=` 写绝对路径 |
| T38 | CI Pipeline（GitHub Actions） | `.github/workflows/ci.yml` | ① install → build → test（vitest run）→ coverage gate；② coverage-final.json 路径实测；③ Node 22 runner + ubuntu-latest amd64（target arm64 不交叉编译） | coverage-final.json schema 要先本地跑一次确认（D14） |
| T39 | Security hardening：CORS + 监听 127.0.0.1 + Caddy 反代 HTTPS | Fastify `listen({ port: 8080, host: '127.0.0.1' })` + CORS 只允许 `127.0.0.1` + Caddy 监听 80/443 | ① Fastify 只接受 localhost 连接；② Caddy 自动续签（acme.email 设管理员邮箱）；③ 外部 HTTP 请求经过 Caddy → 301 到 HTTPS | AGENTS.md 硬约束：**禁止监听 0.0.0.0** |
| T40 | 手动运行 `vitest run --coverage` 锁定 coverage-final.json schema | 本地输出 + CI 脚本适配 | coverage-final.json 里的 path 和字段结构写入 CI 脚本 | D14 确认后回来补 |
| T41 | **24 项验收标准全过**（SDD §12.5） | 逐项 PASS 记录 | 功能 11 项 + 性能 6 项 + 安全 6 项 + 合规 1 项 | 逐条跑，一条不过不能交付 |
| T42 | **文档补齐**：README.md + API 用例 + 运维手册 | 根 README + `docs/deploy.md` | README 包含：快速开始（npm i workspaces → tdx2db init → npm run dev）、架构图（引用 SDD）、目录结构 | 不要主动创建文档，但 Phase 4 必须 |
| T43 | **smoke-m4.test.ts**：端到端完整验收 | 从登录 → 仪表盘 → 交易 → 信号 → 备份恢复 全链路 | 全部 PASS → 打 `test:` commit 后 M4 清卡 | 可能在服务器上跑完整 tdx2db cron 周期（17:00-17:05） |

**M4 验收标准**：
- 24 项原始需求验收标准全 PASS（SDD §12.5）
- CI Pipeline 全绿
- systemd timer 每天 17:00 自动触发 tdx2db → Fastify 4 段 cron
- 首次部署指南文档完整

---

## 里程碑时间线（参考：单人开发）

```
Week 1  [M1] T1-T12 骨架 + core 算法 + backend 基础 + DuckDB 读取
Week 2  [M2] T13-T24 插件引擎 + 数据校验 + 除权导入 + 4 段 cron
Week 3  [M3] T25-T36 交易录入 + 信号生成 + 前端 SPA + 备份 cron
Week 4  [M4] T37-T43 部署 + CI + 验收 + 文档
```

---

## 阻塞点前置清单（Phase 1 启动前必须解决）

| # | 内容 | 已解决？ | 状态 |
|---|---|---|---|
| 1 | tdx2db schema（表名/列名/视图逻辑） | ✅ 已实测 | `docs/tdx2db_schema.md` |
| 2 | Node 版本 ≥22 + better-sqlite3 v13+ | ✅ 已锁定 | AGENTS.md |
| 3 | tdx2db 预编译二进制下载 + init 命令 | ✅ 已确认 | D1/D9 |
| 4 | 远程备份 OCI Object Storage | ✅ 已选定 | D7 |
| 5 | Tushare token + `.env.local` 格式 | ✅ 已创建 `.env.local` 模板 | 填值即可 |
| 6 | 东财 C12 接口 URL + 字段 | ⚠️ 待 curl 实测 | D4 已部分确认 |
| 7 | 插件沙盒实现库（isolated-vm / fastjs / 原生 Function） | ⚠️ Phase 2 前决策 | D10 |
| 8 | 管理员 Web Dashboard 完整交互 | ⚠️ 前端开发时设计 | Phase 3 前 |

---

## 禁止 Out-Scope 功能（AGENTS.md 硬约束）

- ❌ 微信小程序 / 云函数
- ❌ 分钟 K 线 / 盘中实时信号
- ❌ VM2 硬隔离插件沙盒（V2）
- ❌ 多用户 SaaS 模式（MVP 单用户）
- ❌ 交易下单对接券商
- ❌ Prometheus/Grafana 监控（MVP 暂不）
- ❌ `schema_migrations` 迁移表（DDL 用 `CREATE TABLE IF NOT EXISTS`）
- ❌ `node:sqlite` 替代 better-sqlite3（better-sqlite3 v13 预编译二进制零编译）
