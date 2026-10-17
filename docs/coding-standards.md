# 编码风格 & 命名 & 测试规范
> 配套项目：摘要约束见根目录 AGENTS.md；机器校验：eslint.config.js（ESLint v9 flat config）+ .prettierrc

## 1 文件与目录命名
1. ts/js源码文件：`kebab‑case.ts`，例 `tushare‑client.ts`
2. 类型定义文件：`xxx.types.ts`
3. 单元测试：`xxx.test.ts`，和源码同目录
4. 数据库DDL脚本：`ddl‑vxx.sql`
5. 目录：kebab‑case，小写

## 2 标识符命名（TypeScript / JavaScript）
### 变量/函数
- 普通变量、函数：`camelCase`
- 类、Type/Interface：`PascalCase`
- 常量（运行期不变）：`UPPER_SNAKE_CASE`
```ts
const MAX_RETRY_COUNT = 2;
function calcHoldingQuantity() {}
interface TradeRecord {}
```
### 数据库（SQLite / 云开发集合）
表名、集合名、字段名：snake_case 小写下划线
主键统一：id / 复合主键 asset_code, trade_date
布尔字段：is_xxx，例 is_deleted
时间戳毫秒：updated_at
API 路由（Fastify）
REST 风格，全部小写，连字符分隔：/api/trade/add；
请求体字段 JS 层 camelCase，数据库存储 snake_case，接口层做转换。
错误码
业务错误码：UPPER_SNAKE_CASE，如 HOLDING_INSUFFICIENT
## 3 Import / 模块导入规范
内置 node 模块：优先 import xxx from 'node:xxx' 带 node: 协议；
第三方 npm 包 → 内部 @invest/core → 相对路径业务模块；分组空一行隔开；
*禁止 src/ 下导入 node: 内置模块 **（AGENTS 约束，eslint 做防火门）；
尽量使用命名导入；默认导入谨慎使用。
## 4 类型与 ts 编码风格
开启 strict: true，禁止 any；尽量用具体 type/interface；
禁止 // @ts‑ignore，除非注释写明理由；
函数入参、返回值显式标注类型；纯工具小函数可省略；
better-sqlite3 查询返回一次断言：`as Trade[]`；
业务实体优先用 interface；简单复合类型用 type。
## 5 SQL 编码规范（better-sqlite3）
全部使用 prepare 预编译语句，禁止字符串拼接 SQL；杜绝 SQL 注入
开启：WAL mode、busy_timeout=5000、foreign_keys=ON
事务优先用 `db.transaction(fn)` 闭包（自动 BEGIN/COMMIT/ROLLBACK）；或手动 `BEGIN IMMEDIATE` + `try-finally` 封装，禁止裸写事务忘记回滚；
DDL 统一 CREATE TABLE IF NOT EXISTS；MVP 无迁移表；
索引随建表一起定义；联合索引字段顺序按业务查询优先级。
备份优先用 `db.backup(path)` 一键热备份；或手动 `PRAGMA wal_checkpoint(TRUNCATE)` 之后执行 `VACUUM INTO`；
## 6 错误处理
顶层禁止裸 throw 直接向外抛出原始异常；捕获后包装结构化业务错误；
区分：业务逻辑错误（业务 code） vs 系统异常（日志记录，对外屏蔽内部细节）；
外部依赖（Tushare http）必须 try‑catch；记录错误日志，不把原始堆栈返回前端；
Promise 全部必须 await，禁止 floating promise（eslint 检测）。
## 7 注释规范
业务算法、口径、计算公式必须写注释，说明业务含义；参考 golden 数据集来源
复杂状态机、特殊业务边界写注释；
简单逻辑不要写冗余注释；
公共导出函数写 JSDoc；内部私有函数视复杂度。
## 8 测试编码注意事项
测试框架：**Vitest 5.x**（前后端统一框架，复用 Vite config，BDD 风格断言 + 内置 Mock + @vitest/coverage-v8 V8 覆盖率）。
核心层 @invest/core 算法必须单元测试；必须跑 tests/fixtures/golden 黄金数据集，保证双端结果一致；
SQLite 单元测试优先使用内存数据库 `new Database(':memory:')`，不污染真实文件；
外部 http 依赖（Tushare、东财）全部用 `vi.mock()` mock，不请求真实接口跑单元测试；
tdx2db 子进程调用用 `vi.mock("node:child_process")` mock，exit_code 成功/失败两条路径都要覆盖；
测试 case 覆盖：正常流程、边界值、异常失败场景；
数据库集成测试：每个测试用例前后重置内存数据库；
测试文件和源码放在同一目录，文件名 xxx.test.ts。
## 9 Fastify 后端编码约定
统一返回格式 `{code, data, timestamp}`（**与 client/SDD.md §4.2 对齐**）；
- code 为语义化 UPPER_SNAKE_CASE 业务错误码（如 HOLDING_INSUFFICIENT / TRADE_REASON_REQUIRED），系统成功时 code=0；
- 禁止额外 msg 字段——语义化错误码命名即文档，前端按 code 做分支处理；
- 错误码完整列表见 `packages/core/src/error-codes.ts`（与 SDD §4.3 对齐）；
db 实例通过 fastify.decorate 挂载，路由内部访问；
所有入参做校验（Fastify schema 配置）；
服务只监听 127.0.0.1，禁止 0.0.0.0。

## 9.1 DuckDB 行情层编码约定（**与 client/SDD.md §2.1 + AGENTS.md DuckDB 硬约束对齐**）
- Fastify 进程对 DuckDB **只有 SELECT 权限**，禁止从 Node.js 代码里写入 DuckDB；写入权仅 Go 二进制 tdx2db 持有；
- 批量查询必须用 `IN (...)` 一次拿 100+ 标的日线，禁止逐标的循环查询（SDD §5.3 插件引擎"1 次 IN 查询 → N 插件共享"）；
- DuckDB 按需打开关闭，**不常驻连接**（文件锁机制）；查询完毕立即 close；
- 禁止在 DuckDB 里写业务状态（全部业务数据写 SQLite）；
- 禁止在 DuckDB 里建业务索引（DuckDB 的列式压缩 + ZONE MAP 自动优化，手动建索引通常反而拖慢）。

## 9.2 tdx2db / rclone 规范

### tdx2db（**独立 Go 二进制，非 Node.js 代码**）
- tdx2db 由 systemd timer 触发（17:00），**独立进程**，不受 Fastify / Node 进程生命周期影响；
- DuckDB 行情层写入权仅 tdx2db 持有；**Fastify API handler 禁止写入 DuckDB**，只读 SELECT；
- tdx2db 是外部工具，不在 npm workspace 内；构建脚本独立维护。

### Fastify 内部 cron（@fastify/schedule）
- 行情更新后的 C1-C12 校验（17:01）+ 插件信号生成（17:02）+ 除权导入（17:03）+ 双库备份（17:05），全部在 Fastify 进程内按序执行（AGENTS §7 行情时间链）。

### rclone 备份上传（**系统包，非项目代码**）
- rclone 路径固定 `/usr/bin/rclone`；
- systemd service 用 `/bin/bash -c` 包装 shell 展开（AGENTS.md 系统知识，systemd 不做 shell 展开）。

## 9.3 策略插件编写规范（**与 client/SDD.md §5.3 插件接口契约对齐**）
- 插件必须实现 SDD §5.3 定义的 `StrategyPlugin` interface：`id` / `name` / `version` / `execute()` 等；
- `execute()` 硬限制 **50ms**（Promise.race + reject），禁止死循环/阻塞操作；
- 沙盒禁止清单：`global` / `process` / `require` 全部不可访问；禁止文件系统 / 网络操作；
- `paramSchema` 声明的参数类型 + 范围，调用前必须先 validate（SDD §5.3 ParamField interface）；
- 自定义插件只能放 `/opt/invol/plugins/strategies/` 且仅限 `.js`；禁止动态 eval 用户上传的代码；
- 插件必须返回 `StrategySignal | null`（null 表示"无信号"，不写入数据库）。

## 11 前端 React SPA 编码约定（apps/desktop‑web）
组件文件名 PascalCase；组件文件 .tsx；hooks useXxx.ts camelCase；
业务状态优先后端驱动；前端只做 UI 状态；
接口请求错误统一捕获展示 toast；不要把后端原始错误堆栈展示给用户。

### 11.1 Zustand Store 命名规范（**与 client/SDD.md §2.12.3 对齐**）
- Store 文件统一命名 `xxx-store.ts`（kebab-case），放在 `apps/frontend/src/stores/` 目录；
- Store hook 统一命名 `useXxxStore`（use + PascalCase 业务名 + Store），例 `useAuthStore` / `useHoldingStore` / `usePluginStore`；
- Store 结构三层：状态（state）+ 同步方法（actions）+ 异步方法（async actions）；
- **禁止**在 Store 里直接写 fetch/axios 调用——所有 API 请求必须通过 `@/api/client` 层；
- **禁止** Zustand 跨 Store 相互调用（会引入循环依赖）——跨 Store 逻辑用 React Query 串联或在组件层组合。

### 11.2 API Client 层规范（**与 client/SDD.md §2.12.4 对齐**）
- API client 文件统一命名 `xxx.ts`（kebab-case），放在 `apps/frontend/src/api/` 目录；
- 拦截器集中在 `api/client.ts`：请求拦截注入 Authorization、响应拦截统一处理 401/Token 续期；
- **禁止**在组件里直接写 `axios.get()` / `fetch()`——所有请求必须通过 `@/api/client` 层；
- 每个 API 模块导出函数式调用：`auth.login(username, password)` / `trade.create(payload)`；

### 11.3 klinecharts 集成规范
- 自定义 ChartOverlay 配置对象从**后端 StrategyPlugin 返回的 chartOverlay 元数据**直接消费（SDD §5.3 ChartOverlayConfig interface）；
- 禁止在前端硬编码 MACD/RSI 的线条颜色、阈值线位置——全部由后端插件返回的 chartOverlay 决定；
- klinecharts 只负责绘制渲染，**指标计算必须与后端完全一致**（核心算法在 packages/core，前后端共享 golden 数据集断言）。
## 12 禁止清单（重复重点）
❌ 不要引入 Bun
❌ 不要物理删除业务记录，全部软删除 is_deleted
❌ token 明文打印日志、前端明文展示 token
❌ 拼接 SQL 字符串

## 三、机器强制执行：配置文件
1. `eslint.config.js`（ESLint v9 flat config，ESM 格式）：根目录统一校验，`packages/core/src/**/*.ts` 禁止导入 `node:*` 内置模块（双端可复用防火门），禁止 any；
2. `.prettierrc`：格式化；
3. 在`package.json`增加脚本：
```json
"scripts": {
  "lint": "eslint .",
  "format": "prettier --write .",
  "test": "vitest run",
  "test:watch": "vitest",
  "test:coverage": "vitest run --coverage"
}
```
机器配置提交 git，CI / 本地都可以跑；AI / 人都必须服从 lint 报错。
Vitest 配置文件：根目录 `vitest.config.ts`（workspace 模式，各 workspace 独立 scope）；
覆盖率配置：`coverage.provider: "v8"`（@vitest/coverage-v8），输出 lcov + HTML；
CI 覆盖率 Gate：packages/core 和 apps/backend 核心模块**行覆盖率 ≥ 90% 且分支覆盖率 ≥ 85%**（与 client/SDD.md §12.2 对齐）。

## 四、项目目录结构（**AGENTS.md 第 3 条锁死，本条仅摘要**）
> ⚠️ **目录结构的权威定义在 AGENTS.md 第 3 条**（含 npm workspaces 配置、跨 workspace 依赖规则 Mermaid 图），**完整 src/ 子模块展开见 SDD §1.5.4**。如需修改目录结构，**必须先改 AGENTS.md**。

```
根目录
├─ AGENTS.md                             # ⭐ 权威规则：技术栈、架构硬约束、目录结构锁死、禁止 Out-Scope
├─ eslint.config.js                      # ESLint v9 flat config（ESM 格式，根目录统一校验）
├─ .prettierrc
├─ .gitignore
├─ package.json                          # npm workspaces 根配置
├─ docs/
│   ├─ Requirements_original.md          # 原始需求文档（历史参考）
│   ├─ coding-standards.md               # 编码风格、命名、测试规范（本文档）
│   ├─ client/                           # ⭐ 权威文档目录（web/ 已弃用）
│   │   ├─ Requirements_simplified.md    # 业务规则唯一真相源（WHAT，非 HOW）
│   │   ├─ PRD.md                        # 用户视角产品需求
│   │   ├─ SDD.md                        # 工程落地设计（已补全：技术选型、DDL、测试策略、CI/CD）
│   │   └─ code_implementation_plan_v2.md # ⭐ 开发任务拆解（T49-T94，48 个任务，Wave 1-8；含 §12 Wave 出口门槛）
│   ├─ archive/                           # 已归档的过期文档（禁止作为执行依据）
│   ├─ web/                              # ❌ 已弃用，不要参考
│   └─ adr/                              # 架构决策记录（当前为空，后续补）
├─ .trae/
│   └─ subagents/                        # AI agent 运行时角色配置（architect/coder/devops/tester/orchestrator）
├─ packages/
│   └─ core/                             # 核心复用层（ESM + CJS 双格式 + d.ts）
│       └─ tests/fixtures/golden/        # ⭐ 黄金测试数据集（移动加权成本、RSI、MACD 算法一致性断言）
└─ apps/
    ├─ backend/                          # Fastify 后端（Node 22+ 普通进程，systemd 管理，依赖 core）
    └─ frontend/                         # Vite + React + TS SPA 前端（只发静态资源，零 Node 运行时）
```