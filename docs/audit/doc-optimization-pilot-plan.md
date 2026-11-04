# 文档优化 · opencode 试点计划（doc-optimization pilot plan）

> **性质**：可行性试点（`docs/audit/` 证据层），与 `doc-optimization-baseline.md` 的 Trae 主样本**相互独立**。
> **状态**：DRAFT —— 待 owner 确认 §8 的 4 点后执行；**N=1、顺序固定，不得当作 H1 证据**。
> **关联**：`doc-optimization-baseline.md`（协议与历史数据）、`doc-optimization-report-2026-11-04.md`（分析）、`../adr/ADR-018-doc-agent-workflow.md`（被验证对象）。
> **模型**：`zen/deepseek-v4.1-flash-free`（preflight 已通过，见 §0）。

## 0. Preflight 结论（2026-11-04 实测）

| 项 | 结果 |
|---|---|
| 模型可用性 | 在**项目目录内** `opencode run -m zen/deepseek-v4.1-flash-free` 正常返回；试跑 `pong` 耗时 ≈15.2s |
| Token 上报 | 会话写入 `opencode.db`：`tokens_input=17015 / cache_read=1792 / output=4 / cost=0` ⇒ **M3 可采** |
| M2 / M4 | `part` 可读工具调用；`session.time_created/time_updated` 齐全 ⇒ **M2 / M4 可采** |
| 配置依赖 | 在**临时目录**跑同一模型报 `ProviderModelNotFoundError`：`zen` provider 只定义在项目里**未被 git 跟踪**的 `opencode.jsonc` ⇒ worktree 必须复制该配置 |
| 备选模型 | `opencode/pulse-alpha-free` 在模型列表中存在，但未完成验证，owner 决定**不采用** |

## 1. 变量控制

| 维度 | 设置 |
|---|---|
| 代码基 | b1 = `main`(2c99bda) worktree；a1 = HEAD(2ce1257) worktree。已实测 `git diff main..HEAD -- apps packages` 为空 |
| 唯一被测变量 | 文档结构：`AGENTS.md` + `docs/**`（INDEX / D 卡 / runbooks / 生成物） |
| 非被测差异 | HEAD 还改了 `scripts/`、`package.json`、`.github/`、`opencode.template.jsonc`；对 Task A 惰性，记录但不隔离 |
| 配置 | 两个 worktree **放同一份** `opencode.jsonc`（含 `docs/audit/**`、`docs/archive/**` 排除）⇒ ADR-018 D6 的排除**不作为被测变量**，两臂同享 |
| 模型 / 工具 | 相同：`zen/deepseek-v4.1-flash-free`，opencode 1.19.0 |
| 顺序 | 串行 **b1 → a1**（承认时间 / 缓存顺序混淆，N=1 不校正） |

## 2. worktree 搭建（Windows）

```powershell
$base = "D:\workspace\ia-bench"
New-Item -ItemType Directory -Force $base | Out-Null
git -C D:\workspace\InvestAssistantMVP worktree add "$base\b1" main
git -C D:\workspace\InvestAssistantMVP worktree add "$base\a1" 2ce1257

foreach ($w in @("$base\b1", "$base\a1")) {
  Copy-Item D:\workspace\InvestAssistantMVP\opencode.jsonc $w\
  Copy-Item D:\workspace\InvestAssistantMVP\.env.local $w\ -ErrorAction SilentlyContinue
  cmd /c mklink /J "$w\node_modules" "D:\workspace\InvestAssistantMVP\node_modules"
  New-Item -ItemType Directory -Force "$w\packages\core" | Out-Null
  robocopy D:\workspace\InvestAssistantMVP\packages\core\dist "$w\packages\core\dist" /E /NFL /NDL /NJH /NJS | Out-Null
}
```

- 起跑前对每个 worktree 断言工作区干净（未跟踪的 `opencode.jsonc` / `.env.local` / junction 需单独确认，出现非预期改动即判无效）。
- `node_modules` 用 junction；其中 workspace 链接 `@invest/core` 仍指向主仓 `packages/core`（代码相同，可接受）。vitest 的 alias 指向 worktree 自己的 `packages/core/src`。

## 3. 运行协议

```powershell
# 逐字 task brief（与 baseline §3 完全一致，不给 checklist / audit）
$brief = "给 GET /api/portfolio/return 增加一个可选 query 参数 breakdown=broker。指定时：按券商分组，返回该用户所有券商的三口径收益（每组含 手工/无券商 记录）；不指定时：现有行为完全不变。补齐测试。请遵循本仓既有的响应封装、错误码、角色守卫、命名与测试约定。"

opencode run -m zen/deepseek-v4.1-flash-free --dir "$base\b1" --title "bench-oc-b1" $brief
# b1 结束后：
opencode run -m zen/deepseek-v4.1-flash-free --dir "$base\a1" --title "bench-oc-a1" $brief
```

- 每个 run = 全新会话；**硬超时 90 min**，超时即 kill 并记为无效（不补跑，N=1 pilot）。
- 不给被测 agent 任何 checklist / grader；grader 在 run **结束后**才注入。
- 不主动跑全量后端测试；若 agent 自行跑全量并卡住，由 90 min 硬超时兜底。

## 4. 指标

| 指标 | 采集 |
|---|---|
| M2 读文件数 | `part` 中 `type=tool` 且 `tool in (read,grep,glob)` 的次数；另记 bash / edit |
| M3 输入 token | `session.tokens_input` + `tokens_cache_read` + `tokens_output` |
| M4 耗时 | `session.time_updated - time_created` |
| 步数 | tool 调用总次数（+ assistant 消息数） |
| 每步上下文 | `tokens_input / 步数`（近似） |
| 交付规模 | run 后 worktree `git diff --stat` + 未跟踪新增文件行数 |
| M5 命中 | grader C1–C8，命中数 / 8，遗漏 = 8 − 命中 |

采集脚本：`C:\Users\tuanyuan\AppData\Local\Temp\opencode\bench\db.cjs`（M2/M3/M4）、`analyze.cjs`（耗时拆解）。

## 5. grader（实现无关，run 后注入）

位置：worktree 内 `apps/backend/tests/unit/bench-probe.test.ts`（用 vitest 跑 TS，避免 mjs 加载 TS 的麻烦）。

- 造数：临时 `SQLITE_DB_PATH`（`ConfigStore.resetInstance()` 模式，参照现有 `portfolioReturn.test.ts`），`user_account(id=1, role=user)`；3 条 `user_trade_record`：
  - `001`：buy sh600000 ×100 @10 fee5（2026-09-01）
  - `002`：buy sz000001 ×100 @20 fee10（2026-09-02）
  - 手工（`broker_code IS NULL`）：buy sh600519 ×50 @100 fee3（2026-09-03）
- 启动：复用 `tests/integration/_helpers.ts` 的 app 构造方式（`registerRoutes` + `app.inject`），带 `Authorization: Bearer <signToken(user)>`。
- 判据：
  - C1 不传参数 → `data` 为**对象**（非数组），字段 `risk/cash/total/caliberNote` 不变；现有 `portfolioReturn.test.ts` 全绿。
  - C2 `?breakdown=broker` 且 ≥2 券商 → `data` 为数组，每元素含 `brokerCode` + `risk/cash/total`。
  - C3 手工组存在（`brokerCode` 为 `null` / `'manual'` / 明确等价标记），cost=5003，不被并入 001/002。
  - C4 仅 1 个券商（过滤或独立 fixture）→ 数组长度 = 1。
  - C5 成功体：`code===0`、`data` 存在、`timestamp` 为字符串、HTTP 200；错误为统一 `fail` envelope（不裸抛未捕获异常）。
    - **注意**：现仓 `ok()` **没有 `success` 字段**（T89b 已删）。原 checklist C5 写 `success=true` 与现状冲突，grader **不校验 success**。
  - C6 普通 user → 200（非 403 admin-only）；无 token → 401。
  - C7 每组 `total.pnl ≈ risk.pnl + cash.pnl − total.fees`（2 位小数）。
  - C8 相关子集（**只跑子集**）：`tests/unit/portfolioReturn.test.ts` + agent 新增的 breakdown 测试。命令示例：
    `npx vitest run --config apps/backend/vitest.config.ts <相关文件>`，硬超时 5 min。

## 6. 有效 / 中止判据

- 起跑 worktree 不干净 → 无效。
- 超过 90 min 未返回 → 无效。
- run 结束零代码改动 → 无效。
- agent 明确读取 worktree 之外的仓库 / 文档 → 标记污染（外部目录权限当前对 `$HOME` 放行）。

## 7. 交付位置

- 结果追加为 `doc-optimization-baseline.md` 新小节（建议 §7.6「opencode pilot」），并在标题 / 表头显式标注：
  `N=1 pilot / 非证据 / 顺序混淆 / 配置恒定（D6 排除未隔离）`。
- 不并入 agent 产出的 breakdown 代码；worktree 保留或 `git worktree remove`。

## 8. 待 owner 确认的 4 点

1. **C5**：按现状去掉 `success=true` 断言（建议）；还是要求被测实现额外加 `success`（不建议，会与仓库契约冲突）。
2. **配置**：两臂使用同一份 `opencode.jsonc`（建议，隔离出纯文档变量）；还是只给 a1 加 `docs/audit` 排除（把 D6 也计入变量）。
3. **超时**：90 min 是否可接受（b1-opencode 历史为 146 min，但那是 agnes；zen 未知）。
4. **样本**：接受 N=1 与固定顺序 b1→a1；还是再加一组反向顺序（N=2，成本翻倍）来抵消顺序混淆。
