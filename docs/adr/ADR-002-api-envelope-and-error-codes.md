# ADR-002：统一响应封装与错误码契约

| 项 | 值 |
|---|---|
| **状态** | ✅ 已接受（Accepted） |
| **日期** | 2026-10-17 |
| **裁决人** | 项目所有者 |
| **关联** | 实施计划 §13.1 **B-9**（envelope）、**B-10**（状态码）、§13.2 I-2（错误码集合）、**I-15**（`error` 字段语义不一致） |
| **落地任务** | T84、T89a（Wave 1）、T89b（Wave 8）、T90 |

---

## 背景

SDD §4.2 规定所有 API 返回统一 envelope `{code, data, timestamp}`，§4.3 定义 10 个错误码。
实测代码与 SDD 有三重偏差：

| 维度 | SDD 要求 | 代码实际（实测） |
|---|---|---|
| envelope | `{code, data, timestamp}` | `{success, data/error, message}`，全站 **63 处** `reply.code(...)` |
| 错误码数量 | 10 个 | **17 个** |
| `HOLDING_INSUFFICIENT` | §4.3 表 409 + §5.1 时序图 409 | `trade.ts:58` 实测 `reply.code(400)` |

另有两处连带问题：

- **SDD 自身矛盾**：§12.3 B1 写 400，与 §4.3 / §5.1 的 409 冲突
- **`error` 字段语义不一致**（本次新发现，I-15）：
  `auth.ts:28` 放中文「用户名或密码错误」，`trade.ts:60` 放 `HOLDING_INSUFFICIENT`；
  而前端 `Login.tsx:43` 等 **36 处**直接把该字段 `setError` 上屏，
  `.message` 字段**仅 2 处**被读 → **用户实际看到的是裸错误码**（实测 401 返回 `{"error":"NO_TOKEN"}`）

这直接导致 T64 的 `errorMessages.ts` 无法按「码」建表 —— 字段里装的东西根本不是码。

## 决策

### 1. 采纳 SDD 的 envelope —— **改代码，不改 SDD**

分**两阶段**落地，理由见「为何拆两阶段」：

| 阶段 | 时机 | 内容 | 破坏性 |
|---|---|---|---|
| **T89a** | Wave 1 | 新增 `lib/envelope.ts`；全部 63 处经此出口；**加 `code` / `timestamp`，保留 `success`**；`error` 统一为错误码、中文移入 `message`；错误码归一 17→10；状态码按 §4.3 校正；**前端 36 处改读 `message`** | 无 |
| **T89b** | Wave 8 | 删 `success` 字段；前端 20 处 `if (res.data.success)` → `if (res.data.code === 0)` | **有** |

### 2. 错误码归一（17 → 11）

- **改名**：`INVALID_TOKEN` + `NO_TOKEN` → `UNAUTHORIZED`；
  `INVALID_SYMBOL` → `SYMBOL_NOT_FOUND`
- **新增**：`PARAM_INVALID`（**代码中根本不存在，却是 SDD §4.3 首个码**）、`DB_UNAVAILABLE`、
  `EXTERNAL_SOURCE_UNAVAILABLE`、`TRADE_DUPLICATE`
- **保留 409 的两处**：`auth.ts:81`（用户名已存在）、`watch.ts:41`（重复关注）——
  属语义冲突而非参数错误

### 3. `HOLDING_INSUFFICIENT` 统一为 **409**

采纳 §4.3 与 §5.1 时序图；**修掉 §12.3 B1 的 400 笔误**。

## 为何拆两阶段

前端对旧字段的依赖面**远超预期**（实测）：

| 字段 | 被依赖处数 |
|---|---|
| `.success` | **20 处**（跨 9 个 page 文件） |
| `.error` | **36 处**（且被直接上屏） |
| `.message` | 仅 2 处 |

而**前端测试基座 T61 在 Wave 2**。若在 Wave 1 做「删 `success`」这类破坏性变更，
等于**零回归保护**下改动全站唯一的 API 契约。

分两阶段后：T89a 是**增量**（加字段，前端只改「读哪个字段」而非「读什么字段」），
中间 6 个 Wave 任何状态都能正常跑；T89b 是唯一的破坏性变更，届时 T61 已就位。

### 附带收益

T89a 的前端 36 处改读 `message`，**立刻修掉一个线上 UX bug**：
登录失败会重新显示「用户名或密码错误」，而不是 `INVALID_CREDENTIALS`。
已加 **G1.4b** 作为回归锚点。

## 后果

### 正面
- SDD §4.2 / §4.3 恢复权威，SDD 内部 400/409 矛盾消除
- 前端不再显示裸错误码
- 错误码集合从 17 收敛到与 SDD 一致

### 负面 / 代价
- T89a + T90 改全部 63 处 `reply.code(...)` 与路由路径，**是 Wave 1 风险面最广的一段**；
  前端不同步会全量 404 / 白屏
- **禁止正则批量替换** —— 各路由 `data` 取值形态不同（有对象、有数组、有 `null`）
- T89b 的前置条件是 T61 已落地，**否则不得开工**

### 对真相源的影响
- ✅ **SDD §4.3 / §12.3 B1 已回写**（本次 SDD PR）
- ✅ **SDD §4.2 已补注**（T89b · 2026-10-21）：§4.2 的 envelope 示例**本就**不含 `success`
  （本 ADR 的决策是「改代码向 SDD 靠拢」），T89b 落地后补上「成功判定唯一口径 = `code === 0`」
  「响应体无 `success` 键」「错误体额外带同值 `error`」「`/api/health` 不走 envelope」四条约束，
  并修正 §4.4 两处响应体描述（`system-log` / `admin/backup`）。
- ✅ **`docs/coding-standards.md` §9 已回写**（T89b · 2026-10-21）：删掉「代码尚未对齐」的过期表述，
  改为「成功判定只看 `code === 0`；响应体没有 `success` 键」。
- ⏳ 待回写：`docs/coding-standards.md:169` 引用的 `packages/core/src/error-codes.ts` **不存在**
