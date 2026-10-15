# AGENTS.md — 项目全局编码规则
> 本项目严格依据 `docs/client/MVP_code_implementation_plan.md` 执行，所有开发任务以该文档为唯一真相源。
> SDD基线文档：`docs/client/SDD.md`
> 不要参考 `docs/web/` 目录下的任何文档。

## 🔒 锁定技术栈，禁止擅自修改
1. Node版本 **≥22**；使用 systemd 管理普通 Node 进程；**禁止使用 Bun**。
2. 桌面SQLite：**推荐 better-sqlite3**（同步 API，成熟稳定，原生预编译二进制覆盖 linux-x64 / linux-arm64 / win32-x64）；
   - 有 `db.transaction(fn)` 事务闭包，也可手动 `BEGIN / COMMIT / ROLLBACK`；
   - 有 `db.backup(path)` 热备份 API，也可手动 `PRAGMA wal_checkpoint(TRUNCATE)` + `VACUUM INTO`；
   - `node:sqlite`（Node 25+ 内置）为备选方案，当 better-sqlite3 原生依赖在目标平台编译失败时使用；
3. 包管理：**npm workspaces**，不使用pnpm；monorepo 根 `package.json`：
   ```jsonc
   {
     "workspaces": ["packages/*", "apps/*"],
     "scripts": { "test": "vitest run", "test:coverage": "vitest run --coverage" }
   }
   ```
   **固定目录结构（禁止擅自新增/删除 workspace）**：
   - `packages/core` —— 核心复用层（ESM + CJS 双格式 + d.ts），**零业务依赖**，存放移动加权成本、RSI/MACD、插件接口契约等纯算法代码
   - `apps/backend` —— Fastify 后端（systemd 管理普通进程），**依赖 core**；包含 C1-C12 校验、插件引擎、API handler、备份 cron（@fastify/schedule，17:01-17:05）
   - `apps/frontend` —— Vite + React + TS SPA 前端，**只发静态资源**，零 Node 运行时

   **跨 workspace 依赖规则**：
   ```mermaid
   graph LR
       C["packages/core<br/>（零依赖）<br/>移动加权成本<br/>RSI/MACD<br/>插件接口契约"]
       B["apps/backend<br/>Fastify 后端"] --> C
       F["apps/frontend<br/>React SPA"] -.->|"fetch('/api/...')"| B
       TDX2DB["tdx2db Go 二进制<br/>（systemd timer 17:00 触发）"] --> DUCKDB["DuckDB 行情层"]
       B --> DUCKDB
       subgraph Backend["apps/backend 内部"]
           Cron["@fastify/schedule<br/>（校验 / 信号 / 除权 / 备份）"] --> SQLITE["SQLite 业务层"]
           Handler["API handlers"] --> SQLITE
           Handler --> DUCKDB
           Handler --> C
       end
   ```
   **apps/frontend 禁止直接 import packages/core**——前后端通过 HTTP API 通信，算法口径一致性靠 golden 数据集在 CI 里验证；**行情更新由独立的 tdx2db Go 二进制 + systemd timer 触发**（17:00），Fastify 进程只负责后续 4 段（校验 / 信号 / 除权 / 备份，@fastify/schedule 内部调度）。
4. 后端web框架：Fastify；前端Vite+React+TS；（微信小程序 + 云函数为 V2 Out-Scope，MVP 不实现）。
5. core包输出 ESM + CJS 双格式 + d.ts 类型声明（当前仅桌面后端使用 CJS 格式，ESM 供后续前端 SSR 或 V2 云函数预留）。

## 📜 开发流程纪律
1. 严格按照MVP计划文档的 **Phase1→Phase2→Phase3→Phase4** 顺序；优先执行对应Txxx任务ID；**禁止超前实现Out‑Scope功能**。
2. TDD优先；核心算法复用 `tests/fixtures/golden` 黄金数据集做双端一致性校验，防止计算口径漂移。
3. DDL、索引优先于业务代码；全部业务记录**软删除 is_deleted=true，禁止物理删除**。
4. `user_asset_rel` 唯一索引固定三列：`(user_openid, asset_code, rel_type)`，**不能改为两列**，保证watch/hold/candidate可独立共存。
5. 桌面Node服务**仅监听127.0.0.1；CORS仅允许127.0.0.1**，禁止监听0.0.0.0。
6. 行情约束：云端云数据库**不存储全市场日线**；全市场日线仅存在桌面本地 **DuckDB + SQLite 双数据库**（DuckDB 行情层只读、可重建；SQLite 业务层可写、不可重建）。
7. 行情时间链（**MVP 阶段，systemd timer + Fastify 内部 cron 混合调度**）：`17:00 systemd timer 触发 tdx2db Go 二进制 → 17:01-17:03 Fastify @fastify/schedule 触发 C1-C12 校验 + 插件信号生成 → 17:05 Fastify cron 触发双库备份`。**tdx2db 独立进程化**，不受 Node 进程生命周期影响；Fastify 内部 4 段任务共享同一数据库连接池和插件引擎实例。
8. 任务粒度控制1‑3人天；大任务不要继续膨胀，可拆分子任务。
9. 新增npm依赖必须说明理由，禁止随意引入第三方库。

#### 🤖 Agent 开发流程硬约束（本项目专用，违反直接卡死）

> 本项目 Session 里实炸过的坑，写进规则保证任何后续接手者（人或 Agent）都知道。

**后台进程收尾三步**：任何时候用 Shell `run_in_background=true` 起的服务（后端 / vite dev server / 自动化 smoke 测试），**收尾必须完整走完**：
- Step 1: `StopCommand(command_id)` — 停后台命令包装层
- Step 2: **按端口段强杀残留子进程**（见下端口分配表）— StopCommand 停的是 cmd/包装层，不保证 node.exe 子进程退出
- Step 3: `Get-NetTCPConnection -State Listen` 确认端口全部 LISTEN=空

每次漏做这步 → 下次 `npm run dev` 端口冲突 → ConfigStore 持久化漂移 → 排查 30 分钟以上。

**端口分配固定段**（避免与用户其他项目冲突，也避免我们自己测试冲突）：

| 用途 | 端口 | 说明 |
|------|------|------|
| Fastify 后端默认 | 8080 | ConfigStore 持久化；vite.config.ts proxy target 写死这个 |
| Vite 前端 dev server | 5173 | vite.config.ts 固定 |
| smoke-m1（自动化联调） | 51100 | startServer({ startPort: 51100 }) |
| 其他测试 / 临时联调 | 51200‑51999 | 预留段，每次临时起新服务在这个范围内 |

清残留端口段的固定 PowerShell（一行）：
```powershell
@(8080,5173) + (51100..51999) | ForEach-Object { Get-NetTCPConnection -State Listen -LocalPort $_ -EA SilentlyContinue } | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -EA SilentlyContinue }
```

**里程碑边界每阶段最后一条 commit**（用户要求，便于 review / 回滚 / 追责）：
- 每个 M1/M2/M3/M4 最后一次 commit → `fix:` 或 `docs:` 或 `test:` 前缀，然后验收清卡
- 每个 smoke-mX.test.ts 实装完成后单独一条 commit
- 禁止多个"半拉子改动"攒成一个大 commit

## 🚫 Out‑Scope，绝对不要实现
1. 分钟K线、分钟周期策略、盘中实时信号；
2. 小程序端K线图表；
3. 微信云托管CloudBase‑Run常驻服务；
4. 实盘对接、交易下单；
5. 小程序消息订阅推送（MVP不做）；
6. schema_migrations迁移表，MVP不做数据库迁移机制，DDL使用 `CREATE TABLE IF NOT EXISTS`。

## 🔐 安全编码强制约束
1. Tushare token、device凭证、绑定token禁止打印明文日志；禁止前端渲染明文token；token统一加密保存在桌面配置层单例。
2. 减仓、清仓必须做持仓充足校验，业务错误码固定 `HOLDING_INSUFFICIENT`。
3. 配置文件敏感字段做加密，配置文件存于`%APPDATA%/InvestAssistant/config.json`。

## 🧩 编码输出约定
1. 实现任务前先阅读对应Txxx任务描述、开发要点、测试要点、卡点；
2. 生成代码同时思考单测要点；关键逻辑给出单测示例；
3. 修改数据库表必须同步更新DDL脚本；
4. 数据库全部使用预编译参数化语句，禁止字符串拼接SQL，防止注入；
5. 无云函数（MVP 不实现）；V2 引入微信云函数时再补充 core 包 CJS 产物 + esbuild 配置；
6. 黄金测试数据集：`tests/fixtures/golden/*.json`，移动加权成本、RSI、MACD、实现盈亏，双端算法必须复用同一套golden数据断言，保证双端计算误差=0。

## ⚠️ better-sqlite3 使用注意事项（必须记住）
1. better-sqlite3 v13+ 自带原生预编译二进制（prebuild-install），npm install 时根据当前平台自动下载，**不需要本地编译**；目标平台 linux-arm64 已有预编译包；
2. 事务：优先用 `db.transaction(fn)` 闭包（自动 BEGIN/COMMIT/ROLLBACK）；若需手动控制，可执行 `db.exec("BEGIN IMMEDIATE")` + `try-finally` 封装；
3. 备份：优先用 `db.backup(path)` 一键热备份；也可手动 `PRAGMA wal_checkpoint(TRUNCATE)` + `VACUUM INTO`；
4. 连接初始化：开启 WAL 模式、`busy_timeout=5000`、`foreign_keys=ON`（放在 `new Database(path)` 之后立即执行，只执行一次）；
5. 数据库测试：优先使用 `:memory:` 内存数据库，比临时文件更快且更干净；
6. 类型断言：`db.prepare(sql).all(params)` 返回 `any[]`，需自行 `as Trade[]` 断言（better-sqlite3 查询返回一次类型断言即可，比 node:sqlite 少一次）。

**备选：node:sqlite 注意事项（当 better-sqlite3 原生依赖在目标平台编译失败时切换）**
- 无 `db.transaction(fn)`，需手动 BEGIN/COMMIT/ROLLBACK；
- 无 `db.backup()`，需 PRAGMA wal_checkpoint + VACUUM INTO；
- 查询返回两次类型断言 `as unknown as T[]`；
- 要求 Node ≥25。

## ⚠️ DuckDB 行情层硬约束（必须记住）
1. Fastify 进程对 DuckDB **只有 SELECT 权限**，禁止从 Node.js 代码里写入 DuckDB；写入权仅 **tdx2db Go 二进制** 持有（systemd timer 17:00 触发）；
2. 批量查询必须用 `IN (...)` 一次拿 100+ 标的日线（SDD §5.3 插件引擎流程图"1 次 IN 查询 → N 插件共享"），禁止逐标的循环查询；
3. DuckDB 按需打开关闭，**不常驻连接**（文件锁机制，多进程不能同时写）；
4. 禁止在 DuckDB 里写业务状态（全部业务数据写 SQLite）。

## ⚠️ 插件引擎硬约束（必须记住）
1. `execute()` 硬限制 **50ms**（Promise.race + reject），禁止死循环/阻塞操作；
2. 沙盒禁止清单：`global` / `process` / `require` 全部不可访问；禁止文件系统 / 网络操作；
3. `paramSchema` 声明的参数类型 + 范围，调用前必须先 validate（SDD §5.3 ParamField interface）；
4. 自定义插件只能放 `/opt/invol/plugins/strategies/` 且仅限 `.js`；禁止动态 eval 用户上传的代码。

## 📐 编码、命名、测试简要约束（完整详见 docs/coding‑standards.md）
1. 命名：TS/JS 遵循通用TS约定；数据库表、字段全部`snake_case`；接口RESTful；常量全大写SNAKE_CASE。
2. 类型：优先TypeScript严格模式；禁止`any`，尽量使用明确类型；禁止隐式`any`。
3. SQL：全部使用预编译prepared statement，禁止字符串拼接SQL。
4. 错误处理：业务异常使用结构化错误对象；原始异常必须捕获，不允许顶层裸throw泄露内部细节。
5. 测试：
   - 核心逻辑必须编写单元测试，使用 **Vitest 5.x**（前后端统一框架，复用 Vite config；coverage via @vitest/coverage-v8）；
   - 核心算法必须跑 golden 黄金数据集；
   - 数据库相关测试优先使用 `:memory:`内存数据库；
6. 格式化：遵循项目 .eslintrc / .prettierrc，不要私自修改格式化规则。
7. 注释：复杂业务算法必须写注释说明业务口径；简单逻辑无需冗余注释。

> 完整编码风格、命名、测试细则：`docs/coding‑standards.md`

## 📎 参考文档路径（**权威源，以此为准**）
> 所有开发、评审、验收均以 `docs/client/` 目录下的文档为基准，`docs/web/` 目录已弃用。
> SDD 已完成补全（含 P0 参数修正、插件接口契约、C1-C12 SQL、writeSystemLog 设计、前端架构、测试策略、CI/CD），详见 `docs/client/SDD.md`。

| 文档 | 路径 | 定位 |
|------|------|------|
| 需求权威源 | `docs/client/Requirements_simplified.md` | 业务规则唯一真相源（WHAT，非 HOW）|
| PRD | `docs/client/PRD.md` | 用户视角产品需求（用户故事、交互体验、成功指标）|
| SDD 设计文档 | `docs/client/SDD.md` | 工程落地设计（技术选型 Trade-off、DDL、时序图、测试策略、运维）|
| MVP 实施计划 | `docs/client/MVP_code_implementation_plan.md` | 开发任务拆解（Txxx 任务 ID，Phase1-4 顺序）|
| 编码规范 | `docs/coding-standards.md` | 命名、类型、SQL、错误处理、测试规范 |
| 编码规则摘要 | `AGENTS.md`（本文） | AI agent 行为规则 + 架构硬约束 + 禁止 Out-Scope |
| 黄金测试数据集 | `packages/core/tests/fixtures/golden/` | 移动加权成本、RSI、MACD 双端一致性断言用 |
| ADR 决策归档 | `docs/adr/` | 架构决策记录（当前为空，后续重要决策归档到这里）|