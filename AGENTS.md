# AGENTS.md — 项目全局编码规则
> 本项目严格依据 **`docs/client/code_implementation_plan_v2.md`** 执行，所有开发任务以该文档为唯一真相源。
> **该文档含 §12.7「Wave 出口门槛（硬阻断）」—— 未过 gate 的 Wave，其 commit 一律不得合入 `main`（见本文「里程碑边界与 Wave Gate」）。**
> SDD基线文档：`docs/client/SDD.md`；产品需求：`docs/client/PRD.md`；业务规则最高优先级：`docs/client/Requirements_simplified.md`
> **`docs/client/MVP_code_implementation_plan.md` 已被 `code_implementation_plan_v2.md` 超越（Phase1-4 旧任务体系，T49-T94 已完全重写），禁止再作为执行依据。**
> 不要参考 `docs/web/` 目录下的任何文档；`docs/archive/` 下均为已归档的过期文档。

## 📐 文档分层与层界规则（2026-10-17 确立，违反即视为缺陷）

### 核心规则：每条事实只在它所属的那一层定义，其他层只能引用

> 违反此规则已造成实际损失：**B-14（C1-C12 编号定义）** —— `Requirements_simplified.md` §7.1
> 与 `SDD.md` §5.7 对 C3-C8 的定义**完全不同**（一为「数据新鲜度」，一为「数据内容」），
> 而 `PRD.md` §6.4 站在 Requirements 一边。**三层文档、两套定义，潜伏 3 轮审计未被发现。**

### 各层职责边界

| 层 | 文档 | **只回答** | **明确不写** |
|---|---|---|---|
| L1 业务 | `Requirements_simplified.md` | **业务规则与不变量**（成本算法、双口径、七类交易、**C1-C12「要检什么」**）| 任何技术实现、SQL、界面细节 |
| L2 体验 | `PRD.md` | **用户可见的旅程与交互** | 业务规则、技术契约 |
| L2.5 规格 | `ui-spec.md` | **UI 长什么样**（Token / 组件规格 / 断点）| 什么时候做、排期 |
| L3 契约 | `SDD.md` | **技术契约唯一权威**：API / DDL / 插件接口 / **C1-C12「怎么检」的 SQL** / 性能与安全门槛 | 用户故事、排期 |
| **L3.5 行情** | `docs/tdx2db_schema.md`<br>`docs/tdx2db_schema_dump.sql` | **DuckDB 行情层的真实表/视图结构**（由 `tdx2db` Go 二进制写入，**代码只读**）| 业务规则、后端 API |
| L4 计划 | `code_implementation_plan_v2.md` | **任务拆解 + 排期 + 依赖 + 验收 Gate + 偏差待办** | **不复述技术契约** |
| **L5 运维** | `docs/deploy.md` | **怎么部署与运维**（systemd unit / 环境变量 / 目录权限）| 业务规则、任务排期 |
| 决策 | `docs/adr/` | **为什么这么定** + 代价 + 备选方案否决理由 | 具体怎么做 |
| 旁路 | `AGENTS.md`（本文）| agent 硬约束**摘要 + 指针** | 不复述细节 |
| 旁路 | `docs/coding-standards.md` | **怎么写代码**（命名 / 风格 / 测试写法）| 不复述架构与验收 |
| 证据 | `docs/audit/` `docs/archive/` | 审计发现与历史留档 | **不得作为执行依据** |

### 冲突裁决：按域，不按扁平优先级

> ⚠️ **不要用「`Requirements > PRD > SDD > plan」的扁平优先级** —— 会计规则不该压过 UX 决策，
> 技术契约也不该压过业务要求。**按冲突的类型裁决**：

| 冲突类型 | 谁赢 |
|---|---|
| 业务规则 / 计算口径 / 校验项定义 | **`Requirements_simplified.md`** |
| 交互 / 界面行为 / 用户旅程 | **`PRD.md`** |
| 技术契约（API / DDL / SQL 实现 / 性能与安全门槛）| **`SDD.md`** |
| 「什么时候做 / 谁做 / 什么顺序」| **实施计划** |
| 「为什么这么设计」| **`docs/adr/`（已接受 ADR 优先于 SDD 的旧表述）** |

### 写入文档前的自检

1. 这条事实**属于哪一层**？→ 不属于本层就别写
2. 已有某一层定义了吗？→ **只引用，不复述**（复述即失真）
3. 改动会不会与另一层冲突？→ 冲突时按上表裁决，并把裁决记入 `docs/adr/`
4. 如果是**实现细节**（表名 / 列名 / API 路径）→ 一律不写进 L1/L2，只进 L3

> ⚠️ **SDD §3.3「放行某张表可读」≠「已知该表字段名」。**
> 本项目已多次因照抄未验证的表名假设（`raw_symbol_class.is_st`、`raw_hfq_factor`、
> `/opt/invest/plugins/`）而写错代码 —— **实现前必须 `DESCRIBE` 实测**。
> 详见实施计划 §13.1 B-1 与 T85 卡点。

> 🔒 **注释不是规格。改动既有代码前，先证明「现状是错的」（2026-10-17 确立）**
>
> 上条只覆盖 DuckDB 表/列名。**同类错误在外部 API 与代码注释上同样发生过**，故扩展为通用动作门禁：
>
> 1. **复现** —— 写一个会失败的测试，或跑一条命令让错误现象可见；
> 2. **定位** —— 找**权威来源**（真实 API 响应 / DB 实测 / SDD 章节），**不是代码注释**；
> 3. **注释与行为不一致时，先怀疑注释** —— 注释可能过期、可能一直是错的。
>
> **实测案例（当天 4 次，第 4 次由 agent 犯）**：
> `validator.ts` 用东方财富 `fields2=f51..f61` 取前复权收盘价。代码注释写着
> `"2024-01-02,10.50,10.60,10.40,10.55"`，据此读是 `日期,开盘,高,低,收` → 收盘应在 `parts[4]`，
> sub-agent 据此报告「`parts[2]` 是 bug」。**2026-10-17 真实响应实测**：
> `2026-10-12,1262.95,1288.00,1288.00,1261.00` → `f53=收盘` 即 `parts[2]`，与本地 `close=1288` 吻合
> —— **代码正确，注释错误**。主 agent 采信该报告去改注释，**误删 `const parts = ...` 代码行，
> 引入真实缺陷并被 typecheck + 9 个测试抓到**。
>
> **推论**：
> - 权威来源只有**实测**。第三方 API 的字段序**一律以真实响应为准**，不以注释或记忆为准。
> - 「报告疑似缺陷」与「动手修改」之间**必须插入取证步骤**。sub-agent 只被允许**报告**疑似问题，
>   不允许顺手改；主 agent 采信前必须自己复现。
> - 同一天内前三次同类错误：C4/C5 字段名假设、资产快照表结构假设、C11/C12 阈值照抄 plan 而非 Requirements。

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
7. 行情时间链（**MVP 阶段，systemd timer + Fastify 内部 cron 混合调度**）：`17:00 systemd timer 触发 tdx2db Go 二进制 → 17:01-17:03 Fastify @fastify/schedule 触发 C1-C12 校验 + 插件信号生成 → 17:05 Fastify cron 触发双库备份`。**tdx2db 独立进程化**，不受 Node 进程生命周期影响；Fastify 内部 4 段任务共享同一数据库连接池和插件引擎实例。
8. 任务粒度控制1‑3人天；大任务不要继续膨胀，可拆分子任务。
9. 新增npm依赖必须说明理由，禁止随意引入第三方库。

#### 🤖 Agent 开发流程硬约束（本项目专用，违反直接卡死）

> 本项目 Session 里实炸过的坑，写进规则保证任何后续接手者（人或 Agent）都知道。

**后台进程收尾流程**：任何时候起的后台服务（后端 `npm run dev` / vite dev server / smoke-m1、m3 / 未来的 `tests/http/`），**收尾必须完整走完**。

> **2026-10-17 实测修订**：原三步的 Step 1 已被证伪。实测启动 `npm run dev` 得到 npm PID `2632`/`14940`，但实际监听 8080/5173 的是 PID `10184`/`788`（中间隔 `cmd.exe` → `tsx` → `node` 三层）。**把两个 npm PID 都 `Stop-Process -Force` 之后，8080 和 5173 依然 LISTEN** —— 只杀包装层完全无效。
> 另外，按端口杀完后仍残留 1 个 **`tsx watch` 看门狗**（不占端口，端口检查会误判「已清干净」，但文件一变动就自动重启后端）。

**四步（顺序不可跳过）**：

```powershell
# Step 1 —— 杀整棵进程树：从监听 PID 向上遍历 ppid 逐层杀（含 cmd.exe / tsx watch）
#          用法：$rootPid 传入后依次向上取 ParentProcessId
Get-CimInstance Win32_Process -Filter "ProcessId=$pid" |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue; $_.ParentProcessId }
#   ↑ 循环直到 ParentProcessId 为 0；别只杀最底层，tsx watch 是父节点，杀晚了会复活

# Step 2 —— 按端口段强杀（见下方端口分配表），兜底
@(8080,5173) + (51100..51999) | ForEach-Object {
  Get-NetTCPConnection -State Listen -LocalPort $_ -EA SilentlyContinue
} | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -EA SilentlyContinue }

# Step 3 —— 查不占端口的残留（tsx watch / vite）★ 这一步最容易漏 ★
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'InvestAssistantMVP|tsx watch|vite' } |
  ForEach-Object { "残留 pid=$($_.ProcessId) $($_.CommandLine)"; Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }

# Step 4 —— 端口段 LISTEN 归零 + Step 3 查询无输出 = 真干净
@(8080,5173) + (51100..51999) | ForEach-Object {
  $c = @(Get-NetTCPConnection -State Listen -LocalPort $_ -EA SilentlyContinue)
  if ($c.Count) { "❌ $_ 仍 pid=$($c[0].OwningProcess)" }
}
```

**验收标准**：`LISTEN = 0` **且** Step 3 无输出。**只满足前者不算收尾完成** —— `tsx watch` 不占端口但会在下次文件变动时复活后端。

**起服务时的纪律**：
- **必须用隔离库**。`.env.local` **已有** `SQLITE_DB_PATH`，且指向仓库内 `data/business.db`；`node --env-file` 不覆盖已存在的环境变量，故**在命令行显式前置 `SQLITE_DB_PATH=<临时路径>` 即可覆盖**（范式见 `apps/backend/tests/integration/_helpers.ts:17-21`：`mkdtempSync` + 覆盖 `SQLITE_DB_PATH` + `(ConfigStore as any)._instance = null`）。
  - ⚠️ **2026-10-18 修订**：本条原文写「`.env.local` 无 `SQLITE_DB_PATH`，可直接覆盖」—— 该前提已失效。若 `.env.local` 里的值指向**当前用户不可写**的目录（如 `/opt/invol/...`，该目录 root 拥有且 `deploy.md` §2 的 chown 尚未执行），启动会以 `SQLITE_CANTOPEN` 崩溃。
  - ✅ `configStore.ts` 启动时 `fs.mkdirSync(dir, {recursive:true})` 会自动建父目录，故**只要父路径可写即可**，无需手工建目录。
- **端口可覆盖**：`server.ts` 读 `PORT`（默认 8080）。宿主 8080 被别的服务（如 llama-server）占用时，`PORT=8081 npm run dev`。`.env.local` 里有注释掉的 `PORT=8080` 可按需启用。
- ⚠️ **跑测试前必须先停掉后端**（2026-10-18 实测）：后端进程持有 `DUCKDB_PATH` 指向的 DuckDB 文件**独占锁**，此时跑 `npm test` 会让 `tests/unit/duckdbLeak.test.ts` 等 **12 个用例**报 `IO Error: Could not set lock on file ... Conflicting lock is held in /usr/bin/node (PID …)`。**这是环境冲突，不是代码回归** —— 先 `kill` 后端再跑测试即可全绿（实测 257/257 PASS）。
- **日志重定向到文件**（`-RedirectStandardOutput`），便于起不来时定位。
- **记 PID 只能记 `Start-Process -PassThru` 的返回值，不能当清理依据** —— 见上，包装层 PID 与监听 PID 无关。

每次漏做这步 → 下次 `npm run dev` 端口冲突 → ConfigStore 持久化漂移 → 排查 30 分钟以上。

### 🔴 CI 与本地不一致的三个陷阱（2026-10-19 实测，PR #17 修复）

**本地全绿 ≠ CI 全绿**。下列三点会让「本地过、CI 红」，写测试/改配置前必读：

1. **CI 没有真实行情库** —— 仓库里的 `data/quotes.duckdb` 只是 **12KB 空壳**（无 `v_stock_qfq` 等表），
   本地指向 `/opt/invol/quotes.duckdb`（**1.24GB** 真数据）。
   → **依赖真实行情的测试在 CI 必红**。判定「行情库可用」**不能用 `fs.existsSync`**（空壳文件是存在的），
   必须探测**表是否存在**（见 `apps/backend/tests/_marketData.ts`）。
   → 无库时**跳过**（`it.skipIf`），与 `smoke-m1` 的既有做法一致。

2. **`--coverage` 会提前加载源文件** —— v8 provider 为收集未覆盖文件的覆盖率，
   会在 `setupFiles` **之前**求值 `src/` 下的模块。
   → **不要在模块顶层读 `process.env`**（`auth.ts` 已改为惰性读取）。
   → 也意味着 `process.env` 在测试文件之间**不保证共享**，`setup.ts` 里的
   `globalThis` 守卫会让「只跑一次」的兜底在后续文件失效 → **兜底必须每文件执行**。

3. **`vitest.config.ts` 的 `test.env` 不可靠** —— 它作用于 vitest 的模块上下文代理，
   业务模块读**裸** `process.env` 时可能拿不到（实测：探针测试里有值，
   另一个测试文件的上下文里没有）。
   → **兜底必须放在业务代码自己身上**，不要依赖任何注入时序。

> 📌 **改完测试必须在 CI 条件下自验**，两种环境各跑一遍：
> ```bash
> # CI 模拟（空行情库 + 无 .env.local + 无 JWT_SECRET + --coverage）
> mv .env.local .env.local.hidden && unset JWT_SECRET \
>   DUCKDB_PATH=/tmp/nonexistent.duckdb \
>   npx vitest run apps/backend/tests/unit --coverage --pool=forks --poolOptions.forks.singleFork=true
> mv .env.local.hidden .env.local
> ```
> ⚠️ **改 `packages/core` 后必须 `npm run build -w @invest/core`** —— `apps/backend/tsconfig.json`
> **没有 `paths`**，故 `tsc` 走 gitignored 的 `packages/core/dist`；不重建则 `tsc` 红而 CI 绿
> （CI 无 typecheck 步骤 → 契约漂移抓不到）。**这是 T86 要修的盲区。**

**端口分配固定段**（避免与用户其他项目冲突，也避免我们自己测试冲突）：

| 用途 | 端口 | 说明 |
|------|------|------|
| Fastify 后端默认 | 8080 | ConfigStore 持久化；vite.config.ts proxy target 写死这个 |
| Vite 前端 dev server | 5173 | vite.config.ts 固定 |
| smoke-m1（自动化联调） | 51100 | startServer({ startPort: 51100 }) |
| smoke-m2 | 51101 | ⚠️ **实测为死常量**（`TEST_PORT` 定义后从未使用），T60 清理 |
| smoke-m3 | 51102 | 自动化联调 |
| `tests/http/`（CORS / HTTPS / 性能，**必须真 listen**） | 51200‑51999 | 与下条同段，起服务前先查占用 |
| 其他测试 / 临时联调 | 51200‑51999 | 预留段，每次临时起新服务在这个范围内 |

清残留端口段的固定 PowerShell（一行）：
```powershell
@(8080,5173) + (51100..51999) | ForEach-Object { Get-NetTCPConnection -State Listen -LocalPort $_ -EA SilentlyContinue } | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -EA SilentlyContinue }
```

**测试分层与端口依赖**（`app.inject()` 绕过网络层，勿误放）：

| 目录 | 调用方式 | 占端口 | 能测什么 | 不能测什么 |
|---|---|---|---|---|
| `tests/unit/` | 直接调函数 | ❌ | 纯算法 / 单服务 | 路由、鉴权 |
| `tests/integration/` | **`app.inject()`**（`_helpers.ts:50` 只 `registerRoutes` 不 `listen`） | ❌ | 进程内**完整路由 + 鉴权 + DB** 链路 | **CORS / HTTPS / 性能**（`inject()` 走内存，不经 HTTP 传输层） |
| `tests/http/` | **必须 `app.listen()`** | ✅ 51200‑51999 | CORS 只允许 127.0.0.1、SE1 HTTPS 301、PE1‑PE5 性能 | — |
| `smoke-m1`/`m3` | `app.listen()` | ✅ 51100/51102 | 端到端联调 | — |

> ⚠️ **把 CORS/HTTPS/性能测试写进 `integration/` 会得到假绿** —— `inject()` 完全绕过 `@fastify/cors` 的 Origin 处理与 socket 层，测了等于没测。这是 T60 补齐项。

### 🔴 测试行情库的三档与三层能力（2026-10-20 实测，ADR-008）

**跑测试前先确认 `MARKET_DATA_MODE`** —— 选错档位会得到**假绿**（断言静默跳过）或**假红**（真库上的规模/性能断言在迷你库上必然失败）。

| 档 | `MARKET_DATA_MODE` | 行情库 | 何时用 |
|---|---|---|---|
| `auto`（默认）| `DUCKDB_PATH` 有值 → `full`；否则 → `mini` | — | 日常 |
| `mini` | 迷你库（真库的**逐位一致子集**）| `data/quotes.mini.duckdb` | 日常开发 |
| `ci` | 现生成迷你库 | `$TMPDIR/invest-mini-market/` | CI |
| `full` | **真库** 1.24GB | `/opt/invol/quotes.duckdb` | 门禁前 / 性能基准 / 发布前 |

**三层能力**（一个开关混用会让规模断言**假装通过**）：

| 能力 | 迷你库 | 真库 | 典型用例 |
|---|---|---|---|
| `numeric` 数值型 | ✅ 可跑 | ✅ | 基准价 == 最新前复权收盘价；指标与 golden 逐位相等 |
| `scale` 规模型 | ❌ **必须真库** | ✅ | 候选池数量断言 |
| `performance` 性能型 | ❌ **必须真库** | ✅ | `scan_5000_target` ≤ 3s；PE1‑PE6 |

⚠️ **迷你库数值可信、规模不可信**（迷你库 stock 104 只 vs 真库 5561 只）⇒ **规模/性能类断言绝不能用迷你库的结果冒充**。
⚠️ **真库档的查询会物化 2800 万行**（视图是实时计算的）⇒ `/api/market/latest` 曾达 12.18s、批量取价 3.38s
⇒ **跑测试前先停掉占用 DuckDB 的后端进程**（文件锁会让 12+ 用例误报 `Could not set lock on file`）。
⚠️ 生成器与规格见 `docs/client/SDD.md` §12.1.1；决策与代价见 `docs/adr/ADR-008-test-market-data-strategy.md`。

**交付单元：一个 Wave = 一个 PR（2026-10-17 用户决策，替代「里程碑每阶段一 PR」）**

Wave 1-8 合计 52 个任务 / ~64 人天，**人工逐任务 review 不现实**，故改为按 Wave 交付：

| 环节 | 规则 |
|---|---|
| **commit 粒度** | **仍是「一个 T 任务一条 commit」不变** —— PR 只是容器，原子仍是 commit |
| **PR 粒度** | **一个 Wave 一个 PR**（Wave 1 = T49-T60 + T80-T98，约 30 条 commit 打进一个 PR） |
| **验收时机** | 跑 G1~G8 门槛 → 写 `docs/audit/wave-N-audit.md` → **与本波 commit 同 PR** |
| **合并条件** | `CI build-and-test 通过` **且** `wave-N-audit.md 判定 PASS` —— 二者缺一不可 |
| **合并方式** | squash merge，**满足上述两条件后自动执行**，不需人工点确认 |
| **下一 Wave** | 合并成功后**立即开始下一个 Wave**，不等待人工指令 |

> ⚠️ **为什么 gate 必须在 PR 内而不是 merge 之后**：
> 若「CI 过了就 merge、验收在 merge 后做」，则 gate FAIL 时代码**已经在 main 上**，
> 「硬阻断」名存实亡。故本流程把 gate 排在 merge **之前**：
> **CI 是必要条件，gate 是充分条件，两者都过才 merge。**
> 标 🔒 的数据正确性门槛（G1/G2 等）FAIL 时 → **不许 merge**，就地修复后重跑。

**Wave 验收文档（`docs/audit/wave-N-audit.md`）**：
- 每个 Wave 收尾必写，**无落档文件 = 未执行 = FAIL**
- 内容：G1~G8 逐条 **PASS / FAIL（无 COND）** + 豁免理由 + **实测原始数据** + 本波 commit 区间
- 豁免：标 🔒 的**数据正确性类门槛永久不可豁免**；其余须写明理由 + 指向 §9.3/§13 条目，**同一门槛最多豁免 1 个 Wave**

**回滚可行性依赖 commit 粒度**：因规定「每个 T 任务一条 commit」，一波内 commit 区间可整体 `git revert` 而不留半拉子改动 —— **这是 Gate 流程成立的前提，不可把多个 T 任务合并成一条 commit**（**PR 合并不违反此条：PR 内仍是原子 commit**）

**T78 不是首次验收，是最终验收**。§12.6 的全局 PASS 前提是 G1-G8 全 PASS

## 🚫 Out‑Scope，绝对不要实现
1. 分钟K线、分钟周期策略、盘中实时信号；
2. 小程序端K线图表；
3. 微信云托管CloudBase‑Run常驻服务；
4. 实盘对接、交易下单；
5. 小程序消息订阅推送（MVP不做）；
6. **不做 `schema_migrations` 迁移表 / 迁移框架**，但**改已有表的约束必须用幂等表重建**，见下。

### DDL 变更判据（2026-10-17 实测澄清，违反会导致 T49/T87 无法实现）

`CREATE TABLE IF NOT EXISTS` **只对「表不存在」生效**；表已存在时它什么都不做，**无法改 CHECK / UNIQUE**。

| 变更类型 | 可行手段 | 先例 |
|---|---|---|
| **加列** | `ALTER TABLE ... ADD COLUMN`（幂等：先 `PRAGMA table_info` 判存在） | `configStore.ts:180` `_ensureTradeRecordReviewColumns()` |
| **改 CHECK / UNIQUE / 主键** | **幂等表重建**：`建新表 → INSERT SELECT → DROP 旧表 → ALTER RENAME` | `configStore.ts:164` `_ensureTradeRecordUniqueConstraint()`、`configStore.ts:167` `_ensureSystemLogCheckConstraint()` |

> 根因（`configStore.ts:177` 注释原文）：**SQLite `ALTER TABLE ADD COLUMN` 不支持带 CHECK 之类的复杂约束，也不支持改 CHECK 值。**
>
> ⚠️ **绝对禁止「直接 DROP 旧表」** —— 必须先 `INSERT INTO 新 SELECT * FROM 旧` 再 DROP，且必须包在 `db.transaction()` 里。T49 / T87 都要改 `user_trade_record` 的 CHECK 与 UNIQUE，走的就是这条路径。
>
> ⚠️ 多个幂等重建若落在同一张表上（如 T49 改 CHECK + T87 改 UNIQUE），**合并为一次重建**，不要叠加多次 DROP/RENAME。
>
> 判别口诀：**只加列 → ALTER；碰约束 → 表重建。**

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
   > ⚠️ **2026-10-18 修订**：该目录路径支持 env 覆盖 —— `PLUGIN_ALLOWED_PATH`（默认 `/opt/invol/plugins/strategies`）。改动的是**路径**，不是**约束**：仍只允许 `.js`、仍禁止 eval、仍做路径逃逸前缀校验。开发机无 `/opt/invol` 写权限时设 `PLUGIN_ALLOWED_PATH=<可写目录>` 即可，无需改代码。

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

## 📎 参考文档路径（**权威源，以此为准**）
> 所有开发、评审、验收均以 `docs/client/` 目录下的文档为基准，`docs/web/` 目录已弃用。
> SDD 已完成补全（含 P0 参数修正、插件接口契约、C1-C12 SQL、writeSystemLog 设计、前端架构、测试策略、CI/CD），详见 `docs/client/SDD.md`。

| 文档 | 路径 | 定位 |
|------|------|------|
| 需求权威源 | `docs/client/Requirements_simplified.md` | 业务规则唯一真相源（WHAT，非 HOW）|
| PRD | `docs/client/PRD.md` | 用户视角产品需求（用户故事、交互体验、成功指标）|
| SDD 设计文档 | `docs/client/SDD.md` | 工程落地设计（技术选型 Trade-off、DDL、时序图、测试策略、运维）|
| MVP 实施计划 | **`docs/client/code_implementation_plan_v2.md`** | **开发任务拆解（T49-T98，53 个任务，Wave 1-8）；§12 Wave 出口门槛；§13 PRD/SDD 偏差待办清单** |
| **决策归档** | `docs/adr/` | **已接受 ADR 8 份** —— 决策结论 + 理由 + 代价 + 备选方案否决理由；索引见 `docs/adr/README.md`。**本文档与实施计划只引用决策，不重复决策理由** |
| ~~旧实施计划~~ | `docs/archive/MVP_code_implementation_plan_SUPERSEDED-2026-10-17.md` | ❌ **已被 v2 超越，禁止作为执行依据**（Phase1-4 旧体系），已归档 |
| ~~旧需求原件~~ | `docs/archive/Requirements_original_SUPERSEDED-2026-10-13.md` | ❌ **需求 V1.1（OCI 架构）**，已被 `Requirements_simplified.md` 取代，已归档 |
| **行情层 Schema** | `docs/tdx2db_schema.md`<br>`docs/tdx2db_schema_dump.sql` | **DuckDB 真实表/视图结构**（tdx2db Go 二进制写入，Node 代码**只读**）。⚠️ **实现前必须实测 `DESCRIBE`** —— SDD §3.3「放行某张表可读」≠ 已知字段名 |
| **部署运维** | `docs/deploy.md` | systemd unit / 环境变量 / 目录权限 / 日志位置 |
| UI 规格 | `docs/client/ui-spec.md` | UI Token / 组件规格 / 断点 |
| 编码规范 | `docs/coding-standards.md` | 命名、类型、SQL、错误处理、测试规范 |
| 编码规则摘要 | `AGENTS.md`（本文） | AI agent 行为规则 + 架构硬约束 + 禁止 Out-Scope |
| 黄金测试数据集 | `packages/core/tests/fixtures/golden/` | ⚠️ **目录存在但当前为空** —— 由 **T51** 填充（移动加权成本 5 场景 / RSI / MACD）。填之前「双端一致性断言」无载体可依 |
| Wave 验收落档 | `docs/audit/wave-N-audit.md` | 每波收尾必写；**无文件 = 未执行 = FAIL**；与本波 commit 同 PR |
| **Wave 验收** | `docs/audit/wave-N-audit.md` | **交付单元 = 一个 Wave 一个 PR**；G1~G8 逐条 PASS/FAIL + 实测原始数据；CI 与 gate 双通过才 squash merge |
| **审计记录** | `docs/audit/*.md` | 静态审计 Gap 清单、UX 交叉核对、动态探针记录（**属证据，非计划内容**）；实施计划 §3/§10/§11 已迁出至此，plan 内只留紧凑索引 |