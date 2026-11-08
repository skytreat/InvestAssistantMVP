# AGENTS.md — 项目全局编码规则
> **执行依据按范围切换**：V3 范围内优先依据 **`docs/client/code_implementation_plan_v3.md`**；V3 范围外（Wave 1-8 / MVP 完整化）继续依据 **`docs/client/code_implementation_plan_v2.md`**。
> **V3 文档栈**：业务规则 `docs/client/InvestAssistantV3_NewRequirements.md`；交互 `docs/client/PRD_v3.md`；技术契约 `docs/client/SDD_v3.md`；实施计划 `docs/client/code_implementation_plan_v3.md`。
> **V3 是增量契约**：`SDD_v3.md` §0 明确，V1 的 `SDD.md` 等除 V3 覆盖项外继续有效；同一行为同时有 V1/V3 定义时，**V3 范围内以 V3 文档为准**，V3 未覆盖项回 V1。
> **Wave/阶段出口门槛**：v2 计划 §12.7 的硬阻断继续适用于 Wave 1-8；V3 阶段 Gate 见 `code_implementation_plan_v3.md` §4，未过 gate 不得合入 `main`。
> **`docs/client/MVP_code_implementation_plan.md` 已被 v2 超越（Phase1-4 旧体系，T49-T94 已完全重写），禁止作为执行依据；`docs/web/` 与 `docs/archive/` 不作为执行依据。**


## 🧭 文档入口（先读这里，再决定读什么）

> 全部文档的单一入口 = **[`docs/INDEX.md`](docs/INDEX.md)**；本文件只留**硬约束**与**指针**，细则在 `docs/runbooks/agent-playbook.md`。

- **双实体（ADR-018 D3）**：活跃实体是 **D 卡**（`docs/tasks/v3/D-*.md`），T-ID 只是历史计划号索引；`T` 号不再新增为「活跃卡」。
- **生成物禁手改**：`docs/status.md`、`docs/backlog.md`、`docs/tasks/INDEX.md` 由 `npm run docs:gen` 生成；改完事实源跑 `npm run docs:lint`。
- **`docs/audit/` / `docs/archive/` 默认不加载**（ADR-018 D1；`opencode.jsonc` 已排除）。仅 5 类情形可读：① 修复历史 Bug（查成因 / 旧行为）；② 处理数据正确性问题（口径 / 复算 / 校验）；③ 检查 Gate / 验收证据；④ 调查架构历史决策；⑤ 任务明确引用了某份审计报告。
- **非 ADR 列举的其他情形**：用户显式点名、怀疑历史已裁决（需 D-ID 追认）、本层事实冲突取证、改硬约束出处、复核 Wave gate 或 benchmark —— 可按需查阅，**不计入上述 5 类**。
- **举证义务**：触发读取上述目录时，必须在任务卡或 commit message 写明触发原因，并在卡内 `audit_refs` 登记所引用的审计文件。
- **按需查阅**：起停服务/清端口 → playbook §1；本地绿 CI 红 → §2/§3；行情库相关测试 → §4；SQLite DDL → §8；文档分层细则 → §7；找权威文档 → §6。

---

## 📐 文档分层与层界规则（摘要；细则见 playbook §7）

> 核心规则：**每条事实只在它所属的那一层定义，其他层只能引用** —— 违反曾导致 B-14
> （`Requirements_simplified.md` §7.1 与 `SDD.md` §5.7 对 C3-C8 两套定义，潜伏 3 轮审计），案例见 playbook §7。

### 各层职责与冲突裁决（按域裁决，不用扁平优先级）

| 层 | 权威文档 | 只回答 |
|---|---|---|
| L1 业务 | `InvestAssistantV3_NewRequirements.md` / `Requirements_simplified.md` | 业务规则与不变量（成本算法、双口径、七类交易、C1-C12「要检什么」） |
| L2 体验 | `PRD_v3.md` / `PRD.md` | 用户可见的旅程与交互 |
| L3 契约 | `SDD_v3.md` / `SDD.md` | API / DDL / 插件接口 / C1-C12 的 SQL / 性能与安全门槛 |
| L3.5 行情 | `docs/tdx2db_schema.md` | DuckDB 表/视图真实结构（代码只读） |
| L4 计划 | `code_implementation_plan_v3.md` / `_v2.md` | 任务拆解、排期、Gate、偏差待办 |
| L5 运维 | `docs/deploy.md` | systemd / 环境变量 / 目录权限 |
| 决策 | `docs/adr/` | 为什么这么定 + 代价 + 备选否决理由 |
| 旁路 | `AGENTS.md` / `docs/coding-standards.md` | 硬约束摘要 + 指针 / 怎么写代码 |
| 证据 | `docs/audit/` `docs/archive/` | 审计与留档（**不得作为执行依据**） |

- **裁决**：业务口径归 L1、交互归 L2、技术契约归 L3、先后归 L4、理由归 ADR；冲突裁决记入 `docs/adr/`。
- **实现细节（表名/列名/API 路径）只进 L3**；L1/L2 只引用、不复述。

### 写入文档前的自检

1. 这条事实**属于哪一层**？→ 不属于本层就别写
2. 已有某一层定义了吗？→ **只引用，不复述**（复述即失真）
3. 改动会不会与另一层冲突？→ 冲突时按上表裁决，并把裁决记入 `docs/adr/`
4. 如果是**实现细节**（表名 / 列名 / API 路径）→ 一律不写进 L1/L2，只进 L3

> ⚠️ **表名/列名一律 `DESCRIBE` 实测**：SDD「放行可读某表」≠「已知字段名」（曾因照抄 `raw_symbol_class.is_st`、`raw_hfq_factor`、`/opt/invest/plugins/` 写错代码，见 plan §13.1 B-1 / T85）。
>
> 🔒 **改动既有代码前先证明「现状是错的」**：复现 → 找权威来源（真实响应 / DB 实测 / SDD 章节，**不是代码注释**）→ 注释与行为不一致时**先怀疑注释**。sub-agent 只许**报告**疑点，主 agent 复现后才可改（案例见 playbook §7）。

## 🔒 锁定技术栈，禁止擅自修改
1. Node版本 **≥22**（2026-10-20 实测 **v26.12.0**；⚠️ Node ≥22 自带**实验性内置 `localStorage`**，不带 `--localstorage-file` 时 `globalThis.localStorage` 是 `undefined` 且**遮蔽 jsdom 的实现** —— 前端测试必须自备内存版 Storage，见 `apps/frontend/tests/setup.ts`）；使用 systemd 管理普通 Node 进程；**禁止使用 Bun**。
2. 桌面SQLite：**推荐 better-sqlite3**（同步 API，成熟稳定，原生预编译二进制覆盖 linux-x64 / linux-arm64 / win32-x64）；
   - 有 `db.transaction(fn)` 事务闭包，也可手动 `BEGIN / COMMIT / ROLLBACK`；
   - 有 `db.backup(path)` 热备份 API，也可手动 `PRAGMA wal_checkpoint(TRUNCATE)` + `VACUUM INTO`；
   - `node:sqlite`（Node 25+ 内置）为备选方案，当 better-sqlite3 原生依赖在目标平台编译失败时使用；
3. 包管理：**npm workspaces**，不使用pnpm；monorepo 根 `package.json`：
   ```jsonc
   {
     "workspaces": ["packages/*", "apps/*"],
     // ⚠️ 实际脚本是分段带各自 config 的形式，不是裸 `vitest run`（改动时照抄实际，别照抄本注释）
     "scripts": {
       "test": "vitest run apps/backend --config apps/backend/vitest.config.ts --pool=forks --poolOptions.forks.singleFork=true && vitest run --config packages/core/vitest.config.ts && npm run test -w @invest/frontend",
       "test:coverage": "…同上，每段加 --coverage…",
       // T86 新增：lint / format / typecheck / build 四条基座脚本
       "lint": "eslint . && prettier --check .",
       "lint:fix": "eslint . --fix && prettier --write .",
       "format": "prettier --write .",
       "format:check": "prettier --check .",
       "typecheck": "npm run typecheck -w @invest/core && npm run build -w @invest/core && npm run typecheck -w @invest/backend && npm run typecheck -w @invest/frontend",
       "build": "npm run build -w @invest/core && npm run build -w @invest/backend && npm run build -w @invest/frontend"
     }
   }
   ```
   > ⚠️ `singleFork=true` 是**故意的**：Fastify 多实例并行 listen 会 `EADDRINUSE`。改动前先读 §「测试分层与端口依赖」。
   > 🔒 **`typecheck` 里 core 的 build 不能删** —— `apps/backend/tsconfig.json` **没有 `paths`**，
   > 后端 `tsc` 走 gitignored 的 `packages/core/dist`。不先构建 → core 的类型改动不传导到后端 →
   > **tsc 红而 CI 绿**（这正是 T86 修的那个盲区）。
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
7. 行情时间链（**MVP 阶段，systemd timer + Fastify 内部 cron 混合调度**）：`17:00 systemd timer 触发 tdx2db Go 二进制 → 17:01-17:03 Fastify @fastify/schedule 触发 C1-C12 校验 + 插件信号生成 → 17:05 Fastify cron 触发备份（SQLite 恒常 + DuckDB 受 `ENABLE_QUOTE_BACKUP` 控制，默认开启）`。**tdx2db 独立进程化**，不受 Node 进程生命周期影响；Fastify 内部 4 段任务共享同一数据库连接池和插件引擎实例。
8. 任务粒度控制1‑3人天；大任务不要继续膨胀，可拆分子任务。
9. 新增npm依赖必须说明理由，禁止随意引入第三方库。

## 🚫 Out‑Scope，绝对不要实现
1. 分钟K线、分钟周期策略、盘中实时信号；
2. 小程序端K线图表；
3. 微信云托管CloudBase‑Run常驻服务；
4. 实盘对接、交易下单；
5. 小程序消息订阅推送（MVP不做）；
6. **不做 `schema_migrations` 迁移表 / 迁移框架**，但**改已有表的约束必须用幂等表重建**，见下。

### DDL 变更判据（口诀：只加列 → ALTER；碰约束 → 表重建）

`CREATE TABLE IF NOT EXISTS` **无法改 CHECK / UNIQUE**。加列用 `ALTER TABLE ... ADD COLUMN`（先 `PRAGMA table_info` 判存在）；改 CHECK/UNIQUE/主键走**幂等表重建**（建新表 → `INSERT SELECT` → DROP → RENAME，包在 `db.transaction()`，**禁止直接 DROP 旧表**）。先例与合并规则见 playbook §8。

## 🔐 安全编码强制约束
1. Tushare token、device凭证、绑定token禁止打印明文日志；禁止前端渲染明文token。
2. 减仓、清仓必须做持仓充足校验，业务错误码固定 `HOLDING_INSUFFICIENT`（**HTTP 409**，非 400）。
3. **敏感配置的现状（2026-10-17 实测，勿按旧描述实施）**：
   - **全仓不存在 `config.json`**，ConfigStore 实际是 `configStore.ts:141` 的 `process.env.SQLITE_DB_PATH ?? path.resolve('data','business.db')`。
   - `TUSHARE_TOKEN` / `JWT_SECRET` **明文存于 `apps/backend/../.env.local`**（已被 `.gitignore` 忽略），由 `node --env-file` 加载。
   - ⚠️ **不要以为 token 已加密，也不要为此新建 config.json 层** —— 那会与现有 `--env-file` 机制双轨并存。加密存储属**未实现的待办**，落地前须先登记并经所有者确认。

## 🧩 编码输出约定
1. 实现任务前先阅读对应Txxx任务描述、开发要点、测试要点、卡点；
2. 生成代码同时思考单测要点；关键逻辑给出单测示例；
3. 修改数据库表必须同步更新DDL脚本；
4. 数据库全部使用预编译参数化语句，禁止字符串拼接SQL，防止注入；
5. 无云函数（MVP 不实现）；V2 引入微信云函数时再补充 core 包 CJS 产物 + esbuild 配置；
6. 黄金测试数据集：`tests/fixtures/golden/*.json`，移动加权成本、RSI、MACD、实现盈亏，双端算法必须复用同一套golden数据断言，保证双端计算误差=0。

## ⚠️ DuckDB 行情层硬约束（必须记住）
1. Fastify 进程对 DuckDB **只有 SELECT 权限**，禁止从 Node.js 代码里写入 DuckDB；写入权仅 **tdx2db Go 二进制** 持有（systemd timer 17:00 触发）；
2. 批量查询必须用 `IN (...)` 一次拿 100+ 标的日线（SDD §5.3 插件引擎流程图"1 次 IN 查询 → N 插件共享"），禁止逐标的循环查询；
3. DuckDB 按需打开关闭，**不常驻连接**（文件锁机制，多进程不能同时写）；
4. 禁止在 DuckDB 里写业务状态（全部业务数据写 SQLite）。

## ⚠️ 插件引擎硬约束（必须记住）
1. `execute()` 硬限制 **50ms**（Promise.race + reject），禁止死循环/阻塞操作；
2. 沙盒禁止清单：`global` / `process` / `require` 全部不可访问；禁止文件系统 / 网络操作；
3. `paramSchema` 声明的参数类型 + 范围，调用前必须先 validate（SDD §5.3 ParamField interface）；
4. 自定义插件只能放 `/opt/invol/IA_Prod/plugins/strategies/` 且仅限 `.js`；禁止动态 eval 用户上传的代码。
   > ⚠️ **2026-10-18 修订**：该目录路径支持 env 覆盖 —— `PLUGIN_ALLOWED_PATH`（默认 `/opt/invol/IA_Prod/plugins/strategies`）。改动的是**路径**，不是**约束**：仍只允许 `.js`、仍禁止 eval、仍做路径逃逸前缀校验。开发机无 `/opt/invol` 写权限时设 `PLUGIN_ALLOWED_PATH=<可写目录>` 即可，无需改代码。

## 📐 编码、命名、测试简要约束（完整详见 docs/coding‑standards.md）
1. 命名：TS/JS 遵循通用TS约定；数据库表、字段全部`snake_case`；接口RESTful；常量全大写SNAKE_CASE。
2. 类型：优先TypeScript严格模式；禁止`any`，尽量使用明确类型；禁止隐式`any`。
3. SQL：全部使用预编译prepared statement，禁止字符串拼接SQL。
4. 错误处理：业务异常使用结构化错误对象；原始异常必须捕获，不允许顶层裸throw泄露内部细节。
5. 测试：
   - 核心逻辑必须编写单元测试，使用 **Vitest（版本与仓库实际对齐，当前 `^2.1.0`）**，前后端统一框架，复用 Vite config；coverage via @vitest/coverage-v8。
     > ⚠️ **不要按旧文档升级到 Vitest 5.x** —— 实施计划 DEC-3 已裁决「暂不升级」，升版会导致 core/backend/frontend 三处配置分裂。
     > ✅ **T61 已落地**：前端测试基建在 `apps/frontend/vitest.config.ts`（jsdom 环境，`root` 显式指向 `apps/frontend`），三处现均为 **2.1.x**。前端测试入口 `npm run test -w @invest/frontend`；组件渲染用 `apps/frontend/tests/helpers.tsx` 的 `renderWithRouter`（自动包 MemoryRouter）。；
   - 核心算法必须跑 golden 黄金数据集；
   - 数据库相关测试优先使用 `:memory:`内存数据库；
6. 格式化：遵循项目 .eslintrc / .prettierrc，不要私自修改格式化规则。
7. 注释：复杂业务算法必须写注释说明业务口径；简单逻辑无需冗余注释。

> 完整编码风格、命名、测试细则：`docs/coding‑standards.md`


---

> 📌 **被搬走的细则**（逐字保留在 [`docs/runbooks/agent-playbook.md`](docs/runbooks/agent-playbook.md)）：
> §1 后台进程收尾四步 · §2 CI 三陷阱 · §3 测试执行节奏 · §4 行情库三档 · §5 better-sqlite3 · §6 参考文档路径（详细版）· §7 文档分层细则 · §8 DDL 变更判据（先例）。
