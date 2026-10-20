# Wave 2 开工交接说明（→ 下一台机器 / 新 session）

> 生成时间：2026-10-20（Wave 1 合并后）
> 上游：`docs/audit/wave-1-audit.md`（G1 判定 PASS 9/9）· `docs/audit/t85b-implementation-notes.md`（4 个新缺口的取证）
> 目标读者：**接手 Wave 2 的 agent**（含上下文重置后的自己）

---

## 0. 当前状态（一句话）

Wave 1 已完整合入 `main`（`814a5a2`），G1 门槛 9/9 PASS。**Wave 2（前端基座）尚未开工**，本文件是唯一入口。

| 载体 | 状态 |
|---|---|
| `main` | `814a5a2`，与 `origin/main` 同步，工作区 clean |
| PR #17 | **MERGED**（Wave 1 验收，100 文件 +20933 -1450）|
| PR #18 | **MERGED**（AGENTS.md 补 CI 陷阱）|
| PR #15 | **OPEN 作记录** —— 内容已全部并入 main（83/83 文件核对无遗漏），已加「已被 #17 取代」评论 |
| PR #16 | **MERGED**（运行时可移植性 3 修 + T85b 任务卡）|
| 远端分支 `fix/t84-holding-sufficient` | 旧快照，无 main 缺失内容 → 可删 |
| 远端分支 `fix/p0-duckdb-leak-audit-plan` | 旧快照，无 main 缺失内容 → 可删 |
| 本地分支 | 仅 `main` + 4 个历史分支（`docs/m4-*`、`feat/*`、`test/unit-coverage`）|

**那个 agent 已停工 11 小时**，其工作 100% 已进 main，**无未推送内容**。

---

## 1. Wave 2 范围与门槛（G2）

**任务**：T61-T66 + T86 + T95 + T98（plan §5「Wave 2 — 前端基座」）

| 任务 | 内容 | 优先级 |
|---|---|---|
| **T61** | 前端测试基建：`vitest@2.x`（**与 core/backend 同版本**，DEC-3 不升级）+ `jsdom` + `@testing-library/react` + `@vitest/coverage-v8`；`vitest.config.ts`；`test` 脚本；根 `package.json` 串联；CI 加一步。首批用例：双口径 Tab 切换、收益曲线 bucket 分组、donut 角度计算、Review 3 态弹窗、信号键盘导航、**指标适配层对 golden 的断言**（SDD §12.5 F5 `kline_render` 入口）| 🔴 最高（后续所有前端改动都靠它兜底）|
| **T86** | ESLint + Prettier + 根 `lint`/`build` 脚本 + **CI Stage 2（Lint + TypeScript Check）**。⚠️ **顺带修 core dist 盲区**（见 §3）| 🔒 高 |
| **T62** | Design Token 层 `src/theme/tokens.ts` + `src/styles/global.css`；替换全部 raw hex | 高 |
| **T63** | 导航激活态（`<NavLink>` + `activeStyle`）+ 语义化（`header/main/footer`）+ a11y 基线（`label htmlFor` / `th scope` / `focus-visible` / `aria-current`）| 中 |
| **T95** | 全站合规声明常驻（`App.tsx` 布局 footer，**逐字**用 PRD §5.9 原文；删 `Settings.tsx:261` 重复）| 中 |
| **T98** | ① **AdminGuard**（I-12：`role !== 'admin'` → 重定向，**无 admin API 请求**）② SDD §2.12.3 标注「MVP 仅用 zustand + api/client，React Query 移出范围」| 中 |
| **T64** | `src/api/errorMessages.ts`（**已部分存在**，见 §2）+ 401 → 提示条 + `Navigate('/login',{state:{from}})` + 真实 `/login` 路由 | 中 |
| **T65** | `components/{Spinner,EmptyState,ConfirmDialog}.tsx`；12 处「加载中...」替换；Review 空值渲染 `--` | 中 |
| **T66** | `React.lazy` 拆 `Kline`/`Admin`；清 `any`（约 25 处）；删死导出 | 低 |

**G2 出口门槛**（plan §12.7）：
| # | 门槛 |
|---|---|
| G2.1 | `npm run lint` 退出码 **0** |
| 🔒 G2.2 | **反向验证**：故意写一个 `any` + 一处格式错误 → lint **必须非 0**（证明规则真生效）|
| G2.3 | `npm run build` 三段产物齐备 |
| G2.4 | 前端测试用例数 **> 0**，coverage **≥60%** |
| G2.5 | CI Stage 2 步骤存在**且失败会阻断**（用故意破坏验证）|
| G2.6 | CI 连续 **2 次**全绿（T81 未完成前可豁免，须登记）|

---

## 2. 已完成的前置（**别重做**）

| 已落地 | 位置 | 说明 |
|---|---|---|
| 前端错误码→文案表 | `apps/frontend/src/api/errorMessages.ts` | T64 的一半已做完（`resolveErrorMessage` / `resolveErrorHint`）。**只差**：把各页面的 `res.data.error` 改读 `res.data.message`（**G1.4b 要求 `grep -rn 'data\.error'` 归零 —— 现已归零**）与 401 会话过期处理 |
| 后端错误码→文案表 | `apps/backend/src/lib/errorMessages.ts` | 缺 message 时的兜底 |
| 统一 envelope | `apps/backend/src/lib/envelope.ts` | `ok(data, extra?)` / `fail(status, code, message)` |
| 响应契约 | 全站 16 个路由文件 | G1.4 已验 |
| 合规声明位置 | `apps/frontend/src/pages/_shared.tsx` 的 Navbar 下方 | **T95 仍需**：移进 `App.tsx` 布局 footer（`header/main/footer` 语义结构由 T63 建）并删 `Settings.tsx` 的重复 |

---

## 3. ⚠️ 三个必须先知道的坑（都在 AGENTS.md 里，但要再强调）

### ① CI 没有真实行情库 → 31 个用例在 CI 是「跳过」不是「跑」
仓库的 `data/quotes.duckdb` 是 **12KB 空壳**（无 `v_stock_qfq` 表），本地是 **1.24GB** 真库。
- 判定用 `apps/backend/tests/_marketData.ts` 的 `MARKET_DATA_AVAILABLE`（探测**表**是否存在，**不能**用 `fs.existsSync`）
- CI 实测：unit **418 passed + 24 skipped**、integration **52 passed + 7 skipped**
- **待办（T60 范围）**：给 CI 一个**最小行情桩库**（现场生成，含 `v_stock_qfq` / `raw_symbol_name` / `raw_symbol_class` / `raw_holidays` / `raw_basic_daily` + 几百行确定性数据），并把 `t50` / `t55` 里**硬编码的 5561 / 5363** 改成**相对断言**（如 `> 3000`、比例关系）→ 31 个跳过就能进 CI

### ② 改 `packages/core` 必须重建
`apps/backend/tsconfig.json` **没有 `paths`** → `tsc` 走 gitignored 的 `packages/core/dist`。
不重建则 **tsc 红而 CI 绿**（CI 无 typecheck 步骤）→ **T86 补 CI Stage 2 时一并修**（让 CI 先 `npm run build -w @invest/core`）。

### ③ `sequence.shuffle` 已开
T81 给 vitest 加了用例顺序随机化。**新增测试必须自给自足**（不依赖兄弟用例的副作用）。
- 修法：场景构造搬到 `beforeAll` + 快照断言；或用独立 userId / 独立标的
- ⚠️ `describe.sequential` **在 vitest 2.1.9 + 配置级 `sequence.shuffle: true` 下不生效**（实测）—— 别再试

---

## 4. 建议的开工顺序

```
1. T61 前端测试基建  →  先让 vitest 跑起来（0 用例也行），打通 CI 的一步
2. T86 lint/build + CI Stage 2  →  顺带修 core dist 盲区 + 跑通 G2.2 反向验证
3. T62 token + global.css  →  后续所有前端改动的地基
4. T63 语义化 + T95 合规声明  →  T95 依赖 T63 的 footer 结构
5. T98 AdminGuard  →  可插在 T63 之后
6. T64/T65/T66 收尾
7. 写 docs/audit/wave-2-audit.md（G2 逐条 + 实测数据）→ 开 PR → CI 过 → 自动 squash merge
```

**Wave 2 全部是前端**，不碰后端 → 与任何后端工作**零冲突**。

---

## 5. 本机环境注意

| 项 | 值 |
|---|---|
| DuckDB | `/opt/invol/quotes.duckdb`（1.24GB 真库，`.env.local` 里 `DUCKDB_PATH`）|
| **8080 端口** | 被宿主的 `llama-server`（PID 79190）占用 → 后端用 `PORT=8081`（`server.ts` 已支持 env 覆盖）|
| 前端 dev | `5173`（vite proxy 写死 `http://127.0.0.1:8080` → **8080 被占时前端代理会打错**，Wave 2 若要连后端需临时改 proxy 或改用 8080 之外的口子 |
| `.env.local` | 本地已改成仓库内可写路径（`SQLITE_DB_PATH=/opt/invol/InvestAssistantMVP/data/business.db`）；**gitignored，未入库** |
| 跑测试前 | **先停后端**（DuckDB 文件独占锁 → 12 个用例误报）|

---

## 6. 本轮我自己犯的错（别重蹈）

| 错 | 后果 | 正确做法 |
|---|---|---|
| **直接在 `main` 上 commit** | 违反「禁止直接推 main / 一个 Wave 一个 PR」 | 一律走分支 + PR + CI + 自动 merge（用 `git branch <name> <commit>` + `git reset --hard origin/main` 可补救）|
| **`grep -o "is_st"` 判定「引用了不存在的列」** | 误报 T55 有 bug（实际命中的是**注释**与 `exclude_st` **子串**）| grep 命中 ≠ 事实；**逐行读上下文** |
| **改写脚本吞掉 `send` 对象里的额外顶层字段** | 丢了 `summary`（前端在用）/ `pagination` | 机械改写后**必须逐文件 diff 校验字段完整性** |
| **假设 `process.env` 在测试文件间共享** | CI 4 个文件崩 | 兜底放**业务代码自己**身上，不依赖注入时序 |

---

## 7. 关键文档索引

| 用途 | 路径 |
|---|---|
| 业务规则唯一真相源 | `docs/client/Requirements_simplified.md` |
| 技术契约唯一权威 | `docs/client/SDD.md` |
| 任务拆解 + Wave gate + 偏差登记 | `docs/client/code_implementation_plan_v2.md` |
| **Wave 1 验收（G1 判定）** | `docs/audit/wave-1-audit.md` |
| **本轮 4 个新缺口的取证** | `docs/audit/t85b-implementation-notes.md` |
| 上一个 agent 的交接 | `docs/audit/handoff-wave1.md` |
| 六层追溯矩阵 | `docs/traceability.md` |
| 决策归档 | `docs/adr/` |
| 行情层真实 schema | `docs/tdx2db_schema.md`（**实现前必须 DESCRIBE 实测**）|
| 编码硬约束 | `AGENTS.md` |
| 部署运维 | `docs/deploy.md` |
