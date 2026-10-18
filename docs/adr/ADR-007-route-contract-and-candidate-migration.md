# ADR-007：路由契约与候选池迁移语义

| 项 | 值 |
|---|---|
| **状态** | ✅ 已接受（Accepted） |
| **日期** | 2026-10-17 |
| **裁决人** | 项目所有者 |
| **关联** | 实施计划 §13.1 **B-7**（候选池迁移）、**B-12**（端点命名）、§13.2 **I-1**（15 处路由不一致）|
| **落地任务** | T92（与 T50 同批）、T90（与 T89a 同批） |
| **真相源依据** | SDD §4.4（22 条路由）、§12.3 B6；PRD S5 |

---

## 背景

两个独立问题，都属于「代码与真相源直接矛盾」。

### 1. 候选池迁移违反 PRD 明文（B-7）

PRD S5 整句强调：

> MVP 迁移操作**只在候选记录上打标记，不会自动创建自选关联**（用户需手动从候选池加入自选）

SDD §12.3 B6 同。

但 `routes/watch.ts:62-104` 的 promote 处理器在 `:85-88` **直接 INSERT 目标行**，
且 `tests/integration/watchPromote.test.ts:35` 断言「watch 出现」——
**测试把违规行为固化成了预期**。

### 2. 手动触发端点出现第四个名字（B-12）

同一能力在四处有四种命名：

| 来源 | 命名 |
|---|---|
| SDD §4.4:1274 | `/api/admin/datacheck/trigger` |
| SDD §5.1.1 | `/api/admin/datacheck`（简写）|
| 代码 `routes/admin.ts` | `/api/admin/run-datacheck` |
| 初版实施计划 T59 | `/api/admin/run-pipeline` |

### 3. 连带的 15 处路由不一致（I-1）

不止手动触发一处。SDD §4.4 的 22 条核心路由中，代码命名与之不符的有约 15 处：

| SDD §4.4 | 代码实际 |
|---|---|
| `/api/trade` | `/api/trades` |
| `/api/holding` | `/api/positions` |
| `/api/quote/:symbol/kline` | `/api/kline/:symbol` |
| `/api/strategy/plugins` | `/api/plugins` |
| `/api/strategy/plugins/:id/config`（PUT） | PATCH |
| `/api/signal` | `/api/signals` |
| `/api/review/yield` | `/api/review/stats` |
| `/api/candidate/:id/migrate` | `/api/candidate/:asset_code/promote` |
| `/api/admin/datacheck/result` | `/api/datacheck/latest` |
| `/api/admin/role/:userId` | `/api/admin/users/:id/role` |

初版实施计划只登记了其中 1 条（F-Q10），**且登记后未派任务**。

## 决策

### 1. 候选池迁移：**只打标记，不建关联**（T92）

- **删除** `watch.ts:85-88` 的 INSERT 分支
- 目标 `rel_type` 行不存在时**不再新建**，只把来源行打 `migrated_from_candidate=1`
  （配合 T50 的 `migrated_price_mode`）
- 已存在（含软删）时的「恢复 + 标记」分支保留
- 返回值语义改为 `{ marked: true, autoCreated: false }`，**响应文案明示「不会自动加入自选」**
- **改写 `watchPromote.test.ts:35` 的断言**（从「watch 出现」改为「watch 不出现」）

**待确认的边界**：`watch.ts:62` 的处理器由 `relType` 闭包复用，
**同一份逻辑也服务反向的 watch→candidate**。PRD S5 只约束 candidate→watch 单向。
T92 默认**两个方向都只打标记**（更保守），如需区分应另行裁决。

### 2. 路由：**以 SDD §4.4 为准，改代码**（T90）

- §4.4 的 22 条路由是唯一权威，**不改 SDD 的路由名**
- 仅统一 SDD §5.1.1 的简写与 §4.4 同名（属 SDD 内部矛盾修正）
- 旧名保留 1 个版本 `@deprecated` 别名 + `Deprecation: true` 响应头，下版本删除
- 契约测试遍历 §4.4 全 22 条逐条断言，**并反向断言旧名全部 404**
- 计划新增路由（`/api/candidates/batch`，T56）**补登记进 §4.4**

## 执行顺序约束

**T89a + T90 必须同批** —— 两者都改全部路由文件（共 63 处 `reply.code(...)` 与路径），
分批做会产生大量冲突。且**前端 `api/client.ts` 须一并适配**，
否则前端全量 404 / 白屏。这是 Wave 1 里**风险面最广**的一段。

## 后果

### 正面
- PRD S5 与 SDD §12.3 B6 落地
- SDD §4.4 恢复为路由唯一权威，新增契约测试防止再次漂移
- 手动触发端点从 4 个名字收敛为 1 个

### 负面 / 代价
- 破坏性变更：所有前端 API base path 需同步
- 候选池迁移行为**反转**（原来会自动加自选），需确认没有用户依赖该行为
- `watchPromote.test.ts` 的旧断言必须改写，否则测试会「通过」而行为是错的

### 对真相源的影响
- ✅ **SDD §5.1.1 端点命名已统一**为 `/api/admin/datacheck/trigger`
- ⏳ 待回写：`/api/candidates/batch`（T56）需补进 SDD §4.4
