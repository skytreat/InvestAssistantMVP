# 编码风格 & 命名 & 测试规范

> **本文档只管「怎么写代码」，不管「做什么」和「长什么样」。**
>
> | 问题 | 去哪查 |
> |---|---|
> | 做什么、排期、任务拆解 | [code_implementation_plan_v2.md](client/code_implementation_plan_v2.md) |
> | **技术契约**（API / DDL / 插件 / 验收标准 / 插件接口）| **[SDD.md](client/SDD.md)** ← 技术契约唯一权威 |
> | **为什么这么设计**（决策 + 代价 + 备选方案）| **[docs/adr/](adr/README.md)** |
> | 业务规则 / 交互需求 | `Requirements_simplified.md` / `PRD.md` |
> | UI 长什么样 | [ui-spec.md](client/ui-spec.md) |
> | agent 硬约束 | [AGENTS.md](../AGENTS.md) |

> ⚠️ **本文档不重复 SDD / ADR 的内容**，只给指针。历史教训：早前版本曾把
> 「DDL 用 `CREATE TABLE IF NOT EXISTS`」「API 路由连字符分隔」「禁止 `msg` 字段」
> 「Vitest 5.x」「`error-codes.ts` 是错误码表」写在这里，**其中 4 条与 SDD 直接矛盾或与代码不符**，
> 照做会写出违规代码。重复即失真。

---

## 1 文件与目录命名

1. ts/js 源码文件：`kebab-case.ts`，例 `tushare-client.ts`
2. 类型定义文件：`xxx.types.ts`
3. 单元测试：`xxx.test.ts`
   > ⚠️ **实际位置是集中式**，不是与源码同目录：后端 `tests/{unit,integration,http,smoke-m*}/`，
   > core `packages/core/tests/`。新增测试请放入对应目录。
4. 目录：kebab-case，小写
5. ❌ 业务 DDL **不写独立 `.sql` 文件** —— 内联在 `apps/backend/src/config/configStore.ts`
   （唯一的 `.sql` 是 `tdx2db_schema_dump.sql`，那是 DuckDB schema dump，非业务 DDL）

## 2 标识符命名（TypeScript / JavaScript）

### 变量 / 函数 / 类型
- 普通变量、函数：`camelCase`
- 类、Type / Interface：`PascalCase`
- 常量（运行期不变）：`UPPER_SNAKE_CASE`
- React 组件文件：`PascalCase.tsx`；hooks：`useXxx.ts`

```ts
const MAX_RETRY_COUNT = 2;
function calcHoldingQuantity() {}
interface TradeRecord {}
```

### 数据库（SQLite）
- 表名、字段名：`snake_case`
- 布尔字段：`is_xxx`，例 `is_deleted`
- 时间戳：`updated_at` / `created_at`
- 主键与唯一键：**各表不同，不套用通式** → 以
  [SDD §3.2 DDL]](client/SDD.md) 为准（例：`user_trade_record` 主键为 `id`，
  唯一键为 `(user_id, asset_code, trade_type, trade_date, trade_time)` —— 见 [ADR-003](adr/ADR-003-trade-dedup-semantics.md)）

### API 路由
- **以 [SDD §4.4 核心 API 路由清单]](client/SDD.md) 为唯一权威**（22 条）。
- 命名风格：**斜杠分段，无连字符**（例 `/api/quote/:symbol/kline`）。
  ❌ 不要自造 `/api/trade/add` 这类连字符路径。

### 错误码
- `UPPER_SNAKE_CASE`，例 `HOLDING_INSUFFICIENT`
- **完整列表见 [SDD §4.3]](client/SDD.md)**（唯一权威）。
  ❌ 早期版本称列表在 `packages/core/src/error-codes.ts` —— **该文件不存在**。

## 3 Import / 模块导入规范

1. Node 内置模块：优先 `import x from 'node:xxx'` 带 `node:` 前缀
2. 顺序：内置 `node:*` → 第三方 npm 包 → `@invest/core` → 相对路径；**分组间空一行**
3. 尽量使用命名导入；默认导入谨慎使用
4. ❌ **`packages/core/src/**/*.ts` 不得导入 `node:*`** —— core 要能被浏览器端复用，
   一旦引 Node 模块就废。这是「core 零 Node 依赖」的机械保障。

## 4 类型与 ts 编码风格

- 开启 `strict: true`；❌ 禁止 `any`；尽量用具体 `type` / `interface`
- ❌ 禁止 `// @ts-ignore`，除非注释写明理由
- 函数入参、返回值显式标注类型；纯工具小函数可省略
- better-sqlite3 查询返回**一次**类型断言：`as Trade[]`
- 业务实体优先 `interface`；简单复合类型用 `type`

## 5 SQL 编码规范（better-sqlite3）

- **全部使用 prepare 预编译语句**，❌ 禁止字符串拼接 SQL（防注入）
- 连接初始化后立即执行一次：`WAL mode` / `busy_timeout=5000` / `foreign_keys=ON`
- 事务优先用 `db.transaction(fn)` 闭包；需手动控制时用 `BEGIN IMMEDIATE` + `try-finally`
- 备份优先 `db.backup(path)`；或 `PRAGMA wal_checkpoint(TRUNCATE)` + `VACUUM INTO`
- 索引随建表定义；联合索引字段顺序按业务查询优先级

> ⚠️ **DDL 变更方式不要凭直觉**，判据见 **[AGENTS.md「DDL 变更判据」](../AGENTS.md)**：
> `CREATE TABLE IF NOT EXISTS` **只对「表不存在」生效**，无法改已存在表的 CHECK / UNIQUE。
> 改约束必须**幂等表重建**（先例 `configStore.ts:164` / `:167`）。
> 口诀：**只加列 → ALTER；碰约束 → 表重建。**
> ❌ 绝不可直接 `DROP` 旧表 —— 必须先 `INSERT INTO 新 SELECT * FROM 旧` 且包 `db.transaction()`。

## 6 错误处理

- ❌ 顶层禁止裸 `throw` 直接抛出原始异常；捕获后包装成结构化业务错误
- 区分：**业务逻辑错误**（业务 code，对外）vs **系统异常**（记录日志，对外屏蔽内部细节）
- 外部依赖（Tushare / 东财 http）必须 `try-catch`；不把原始堆栈返回前端
- Promise 全部必须 `await`，❌ 禁止 floating promise（eslint 检测）

## 7 注释规范

- **业务算法 / 口径 / 计算公式必须写注释说明业务含义**，引用 golden 数据集来源
- 复杂状态机、特殊业务边界写注释
- 简单逻辑不要写冗余注释
- 公共导出函数写 JSDoc；内部私有函数视复杂度而定

## 8 测试编码注意事项

- 框架：**Vitest，版本与仓库实际对齐（当前 `^2.1.0`）**。
  ❌ **不要升级到 5.x** —— 实施计划 DEC-3 已裁决暂不升级，升版会导致 core/backend/frontend 三处配置分裂。
  前端测试基建由 T61 建立，届时三处必须同版本。
- BDD 风格断言 + 内置 Mock + `@vitest/coverage-v8`
- 核心层 `@invest/core` 算法必须单元测试；必须跑 `tests/fixtures/golden` 黄金数据集，
  保证**双端结果一致**（误差 = 0）
- 外部 http 依赖（Tushare / 东财）全部 `vi.mock()`，❌ 不请求真实接口
- tdx2db 子进程调用用 `vi.mock("node:child_process")` mock，
  `exit_code` 成功 / 失败**两条路径都要覆盖**
- 测试 case 须覆盖：正常流程、边界值、异常失败场景

> ⚠️ **测试分层与端口**（详细表见 [AGENTS.md](../AGENTS.md)）：
> `tests/integration/` 用 `app.inject()`，**不占端口**，
> 因此**测不了 CORS / HTTPS / 性能**（`inject()` 绕过 HTTP 传输层）。
> 这三类必须放 `tests/http/` 并**真 listen** —— 放 integration 会得到**假绿**。

## 9 后端响应与错误码

- 统一 envelope：**以 [SDD §4.2]](client/SDD.md) 为唯一权威**；落地分两阶段，见 [ADR-002](adr/ADR-002-api-envelope-and-error-codes.md)
  （`T89a` Wave 1 加字段 / `T89b` Wave 8 删 `success`）—— **两阶段均已落地**
- 状态码以 [SDD §4.3]](client/SDD.md) 的 HTTP 列为准（例 `HOLDING_INSUFFICIENT` → **409**）
- ✅ **错误响应含 `message` 字段**（中文文案，供前端直接展示）
  > ❌ 早期版本写「禁止额外 msg 字段」—— **与 SDD §4.2 示例直接矛盾**，且会导致
  > 前端拿不到中文文案、只能显示裸错误码。
- ✅ **成功判定只看 `code === 0`**；响应体**没有 `success` 键**（T89b 已删，勿再加回来）。
  错误体额外带 `error` 字段（与 `code` 同值，供前端兜底），错误信息一律在 `message`。
- 其他：db 实例通过 `fastify.decorate` 挂载；所有入参做 Fastify schema 校验；
  服务只监听 `127.0.0.1`（❌ 禁止 `0.0.0.0`）

## 10 前端（`apps/frontend`）

> ❌ 早期版本写「apps/desktop-web」—— **该目录不存在**，实际是 `apps/frontend`。

### 10.1 Zustand Store

- Store 文件：`xxx-store.ts`（kebab-case），放 `apps/frontend/src/stores/`
- Store hook：`useXxxStore`（`use` + PascalCase 业务名 + `Store`），例 `useAuthStore`
- 三层结构：状态 + 同步 actions + 异步 actions
- ❌ **禁止**在 Store 里直接写 `fetch` / `axios` —— 一律经 `@/api/client` 层
- ❌ **禁止** Zustand 跨 Store 相互调用（循环依赖）—— 跨 Store 逻辑用 React Query 或组件层组合

### 10.2 API Client 层

- API 模块：`xxx.ts`（kebab-case），放 `apps/frontend/src/api/`
- 拦截器集中在 `api/client.ts`：请求注入 `Authorization`；响应统一处理 401 / token 续期
- ❌ **禁止**在组件里直接写 `axios.get()` / `fetch()`
- 每个 API 模块导出函数式调用：`auth.login(...)` / `trade.create(payload)`
- ❌ **禁止把后端原始错误 / 堆栈展示给用户**

## 11 禁止清单

❌ 不要引入 Bun
❌ 不要物理删除业务记录，全部软删除 `is_deleted = 1`
❌ token 明文打印日志、前端明文展示 token
❌ 拼接 SQL 字符串
❌ 引入第三方图表库（K 线图用自写 Canvas —— 见 [ADR-001](adr/ADR-001-frontend-backend-stack.md)）
❌ 升级 Vitest 到 5.x

## 12 机器强制执行（**当前尚未落地**）

| 工具 | 状态 | 落地任务 |
|---|---|---|
| `eslint.config.js` | ❌ **不存在** | T86 |
| `.prettierrc` | ❌ **不存在** | T86 |
| 根 `lint` / `format` 脚本 | ❌ 不存在 | T86 |
| CI Stage 2「Lint + TypeScript Check」 | ❌ 不存在 | T86 |
| CI 覆盖率 Gate（SDD §12.2）| ⏸️ **冻结** | T86b |

> ⚠️ **早期版本把上述全部写成「已存在」，实际一个都没有。** 在 T86 落地前，
> 「机器强制执行」只存在于本文档，**无任何自动化校验** —— 写代码时不要假设 lint 会拦住你。
> 覆盖率门槛冻结理由与恢复义务见 [ADR-006](adr/ADR-006-engineering-gates-and-wave-acceptance.md)。

## 13 项目目录结构

> **权威定义在 [AGENTS.md 第 3 条](../AGENTS.md)**（含 npm workspaces 配置、跨 workspace 依赖规则图），
> 完整 `src/` 子模块展开见 [SDD §1.5.4]](client/SDD.md)。
> **如需修改目录结构，必须先改 AGENTS.md。**

```
根目录
├─ AGENTS.md                    # ⭐ agent 硬约束 + 目录结构锁死 + Wave Gate
├─ package.json                 # npm workspaces 根
├─ docs/
│  ├─ client/                   # ⭐ 真相源目录
│  │  ├─ Requirements_simplified.md   # 业务规则（WHAT）
│  │  ├─ PRD.md                       # 用户视角需求
│  │  ├─ SDD.md                       # ⭐ 技术契约唯一权威
│  │  ├─ code_implementation_plan_v2.md  # ⭐ 任务拆解 + 排期 + Wave Gate
│  │  ├─ ui-spec.md                  # UI 设计规格
│  │  └─ archive/                    # 已归档过期文档（禁止作为执行依据）
│  ├─ adr/                       # 架构决策记录（8 份 ADR）
│  ├─ audit/                     # 审计报告与 Wave Gate 落档
│  └─ coding-standards.md        # 本文
├─ packages/core/               # 核心复用层（ESM+CJS+d.ts）
│  └─ tests/fixtures/golden/    # 黄金数据集 ⚠️ 当前为空，由 T51 填充
└─ apps/
   ├─ backend/                  # Fastify（依赖 core）
   └─ frontend/                 # Vite + React + TS SPA
```