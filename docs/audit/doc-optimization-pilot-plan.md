# 文档优化 · opencode 试点计划（doc-optimization pilot plan）

> **性质**：可行性试点（`docs/audit/` 证据层），与 `doc-optimization-baseline.md` 的 Trae 主样本**相互独立**。
> **状态**：DRAFT（2026-11-04 按评审修订）—— 待 owner 确认 §8 后执行；**N=1、顺序固定，不得当作 H1 证据**。
> **关联**：`doc-optimization-baseline.md`（协议与历史数据）、`doc-optimization-report-2026-11-04.md`（分析）、`../adr/ADR-018-doc-agent-workflow.md`（被验证对象）。
> **模型**：`zen/deepseek-v4.1-flash-free`（preflight 已通过，见 §0）。

## 0. Preflight 结论（2026-11-04 实测）

| 项 | 结果 |
|---|---|
| 模型可用性 | 在**项目目录内** `opencode run -m zen/deepseek-v4.1-flash-free` 正常返回；试跑 `pong` 耗时 ≈15.2s |
| Token 上报 | 会话写入 `opencode.db`：`tokens_input=17015 / cache_read=1792 / output=4 / cost=0` ⇒ **M3 可采** |
| M2 / M4 | `part` 可读工具调用；`session.time_created/time_updated` 齐全 ⇒ **M2 / M4 可采** |
| 配置依赖 | 在**临时目录**跑同一模型报 `ProviderModelNotFoundError`：`zen` provider 未定义 ⇒ worktree 必须显式加载 bench 配置 |
| 备选模型 | `opencode/pulse-alpha-free` 在列表中存在，但未完成验证，owner 决定**不采用** |

## 1. 变量控制

| 维度 | 设置 |
|---|---|
| 代码基 | b1 = `main`(2c99bda) worktree；a1 = HEAD(2ce1257) worktree。已实测 `git diff main..HEAD -- apps packages` 为空 |
| 唯一被测变量 | 文档结构：`AGENTS.md` + `docs/**`（INDEX / D 卡 / runbooks / 生成物） |
| 非被测差异 | HEAD 还改了 `scripts/`、`package.json`、`.github/`、`opencode.template.jsonc`；对 Task A 惰性，记录但不隔离 |
| 配置 | 两臂通过 `OPENCODE_CONFIG` 加载**同一份去密钥 bench 配置**（§2.1）；`external_directory` 默认拒绝，仅放行主仓 `node_modules` 与 `packages/core`；`read/glob` 对 `docs/audit/**`、`docs/archive/**` 拒绝 ⇒ D6 排除在两臂**同等生效**，不作为被测变量 |
| 模型 / 工具 | 相同：`zen/deepseek-v4.1-flash-free`，opencode 1.19.0 |
| 顺序 | 串行 **b1 → a1**（承认时间 / 缓存顺序混淆，N=1 不校正） |

## 2. worktree 搭建（Windows）

```powershell
$base = "D:\workspace\ia-bench"
New-Item -ItemType Directory -Force $base | Out-Null
git -C D:\workspace\InvestAssistantMVP worktree add "$base\b1" main
git -C D:\workspace\InvestAssistantMVP worktree add "$base\a1" 2ce1257

foreach ($w in @("$base\b1", "$base\a1")) {
  cmd /c mklink /J "$w\node_modules" "D:\workspace\InvestAssistantMVP\node_modules"
  New-Item -ItemType Directory -Force "$w\packages\core" | Out-Null
  robocopy D:\workspace\InvestAssistantMVP\packages\core\dist "$w\packages\core\dist" /E /NFL /NDL /NJH /NJS | Out-Null
}
```

- **不复制** `.env.local`、`opencode.jsonc`（原配置含明文 `apiKey`）。worktree 起跑前 `git status --porcelain` 必须为空（junction 与 `dist` 均被 gitignore）。
- `node_modules` 用 junction；其中 workspace 链接 `@invest/core` 仍指向主仓 `packages/core`（代码相同）。vitest 的 alias 指向 worktree 自己的 `packages/core/src`。

## 2.1 bench 配置（去密钥 + 收紧越界）

密钥放在 worktree 外，通过 `{file:...}` 注入；配置由 `OPENCODE_CONFIG` 指向，**不落进 worktree**：

```powershell
# 1) 密钥文件（示例路径；值取现有 zen apiKey，勿提交、勿写入仓库）
New-Item -ItemType Directory -Force "$HOME\.config\ia-bench" | Out-Null
Set-Content "$HOME\.config\ia-bench\zen.key" "<ZEN_API_KEY>"

# 2) 配置放在 worktree 外
New-Item -ItemType Directory -Force "$base\_cfg" | Out-Null
@'
{
  "$schema": "https://opencode.ai/config.json",
  "model": "zen/deepseek-v4.1-flash-free",
  "provider": {
    "zen": {
      "name": "Zen",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://opencode.ai/zen/v1",
        "apiKey": "{file:~/.config/ia-bench/zen.key}"
      },
      "models": { "deepseek-v4.1-flash-free": {} }
    }
  },
  "permission": {
    "bash": {
      "*": "allow",
      "npm test*": "deny",
      "npm run test*": "deny",
      "npx vitest run*": "deny",
      "npx vitest run *tests/*.test.ts*": "allow",
      "vitest run*": "deny",
      "vitest run *tests/*.test.ts*": "allow"
    },
    "read": { "*": "allow", "docs/audit/**": "deny", "docs/archive/**": "deny" },
    "glob": { "*": "allow", "docs/audit/**": "deny", "docs/archive/**": "deny" },
    "grep": "allow",
    "edit": "allow",
    "external_directory": {
      "*": "deny",
      "D:\\workspace\\InvestAssistantMVP\\node_modules\\**": "allow",
      "D:\\workspace\\InvestAssistantMVP\\packages\\core\\**": "allow"
    }
  },
  "ui": { "showSkillLoadInfo": false }
}
'@ | Set-Content "$base\_cfg\opencode.bench.jsonc" -Encoding utf8

$env:OPENCODE_CONFIG = "$base\_cfg\opencode.bench.jsonc"
```

- 配置有意**不加载** `subagent-orchestration.md`（自定义配置在 worktree 外，相对路径会歧义）；两臂一致，已在 §5 标注为偏离。
- `bash` 显式拒绝全量入口（`npm test*` / `npm run test*` / `npx vitest run*` / `vitest run*`），仅放行含 `tests/*.test.ts` 的定向命令；两臂一致。
- 起跑前对每个 worktree 做一次 `pong` 冒烟，确认 `OPENCODE_CONFIG` 生效且 `zen` 可解析。

### 越界检测（不只看「标记污染」）

run 后执行只读检查（建议落为 `bench/check-contamination.cjs`）：从 `part` 取 `read.state.input.filePath`、`glob/grep.state.input.path`、`bash.state.input.command` 及 `state.output`，凡出现**主仓路径**（`D:\workspace\InvestAssistantMVP\...`，放行 `node_modules` / `packages\core`）或**不在本 worktree 前缀内**的路径，即判 `CONTAMINATION=FAIL`。命中 `AGENTS.md` / `docs/**` 的主仓路径时**直接作废该样本**。

## 3. 运行协议

```powershell
# 逐字 task brief（PowerShell 单引号 here-string 原样保留反引号与 ** 标记）
$brief = @'
给 `GET /api/portfolio/return` 增加一个可选 query 参数 `breakdown=broker`。
指定时：按券商分组，返回该用户**所有**券商的三口径收益（每组含 手工/无券商 记录）；
不指定时：现有行为完全不变。补齐测试。请遵循本仓既有的响应封装、错误码、角色守卫、命名与测试约定。
'@

opencode run -m zen/deepseek-v4.1-flash-free --dir "$base\b1" --title "bench-oc-b1" $brief
# b1 结束后：
opencode run -m zen/deepseek-v4.1-flash-free --dir "$base\a1" --title "bench-oc-a1" $brief
```

- 每个 run = 全新会话；**硬超时 60 min**，超时即 kill 并记为无效。
- 不给被测 agent 任何 checklist / grader；grader 在 run **结束后**才注入。
- **harness 与 grader 均不运行全量后端测试**（C8 只跑相关子集）；`npm test*` / `npm run test*` / `npx vitest run*` / `vitest run*` 已在配置层拒绝，若仍有残留进程由 60 min 硬超时兜底。

## 4. 指标

| 指标 | 含义 | 采集 |
|---|---|---|
| M1 | `AGENTS.md` 字节数 | 实测：main **37,430B** → HEAD **16,368B（−56.3%）**；另记 `docs/**` 总量 |
| M2 | 读取文件数 | `part` 中 `type=tool` 且 `tool in (read,grep,glob)` 的次数；另记 bash / edit |
| M3 | 输入 token | `session.tokens_input` + `tokens_cache_read` + `tokens_output` |
| M4 | 完成时间 | `session.time_updated - time_created` |
| M5 | 遗漏规格数 | `8 − 命中`（grader C1–C8；与 baseline §4 定义一致） |
| 辅助 | 步数 / 每步上下文 / 交付规模 | tool 调用总次数；`tokens_input / 步数`；run 后 `git diff --stat` + 未跟踪新增行数 |

采集脚本：`C:\Users\tuanyuan\AppData\Local\Temp\opencode\bench\db.cjs`（M2/M3/M4）、`analyze.cjs`（耗时拆解）。

## 5. grader（实现无关，run 后注入）

> **偏离冻结协议（显式记录）**：baseline §4 写 `scripts/bench-probe.mjs`；本试点改为
> `apps/backend/tests/unit/bench-probe.test.ts`（需 vitest/TS 加载；`.mjs` 需额外 tsx loader）。
> 判据与 fixture 不变。

位置：worktree 内 `apps/backend/tests/unit/bench-probe.test.ts`。

**确定性 fixture**（`user_account(id=1, role=user)`；3 条 `user_trade_record`，`broker_code` 列显式给出）：

| 行 | broker_code | asset_code | trade_type | date | time | quantity | price | fee |
|---|---|---|---|---|---|---|---|---|
| 1 | `'001'` | `sh600000` | buy | 2026-09-01 | 09:30:00 | 100 | 10 | 5 |
| 2 | `'002'` | `sz000001` | buy | 2026-09-02 | 09:30:00 | 100 | 20 | 10 |
| 3 | **NULL**（手工） | `sh600519` | buy | 2026-09-03 | 09:30:00 | 50 | 100 | 3 |

- 无行情（unit 档）→ 各未平仓 MV=0、realized=0。
- 构造：临时 `SQLITE_DB_PATH`（`ConfigStore.resetInstance()` 模式，参照 `portfolioReturn.test.ts`）；app 用 `registerRoutes` + `app.inject`；登录态用 `_helpers.ts` 的 `makeUserToken(userId, username)`（**不是** `signToken(user)`）。
- 判据：
  - C1 不传参数 → `data` 为**对象**（非数组），字段 `risk/cash/total/caliberNote` 不变；现有 `portfolioReturn.test.ts` 全绿。
  - C2 `?breakdown=broker` 且 ≥2 券商 → `data` 为数组，每元素含 `brokerCode` + `risk/cash/total`；`001` 组 cost=**1005**、`002` 组 cost=**2010**。
  - C3 手工组存在（`brokerCode` 为 `null` / `'manual'` / 明确等价标记），cost=**5003**，不被并入 `001`/`002`。
  - C4 单券商：**独立 fixture** 只 seed 第 1 行（`001`）→ 数组长度 = 1（与 C2 的 3 行 fixture 分离，避免歧义）。
  - C5 成功体：`code===0`、`data` 存在、`timestamp` 为字符串、HTTP 200；错误为统一 `fail` envelope（不裸抛未捕获异常）。
    - **不校验 `success`**：现仓 `ok()` 无该字段（T89b 已删除）；baseline §4 C5 已同步修正。
  - C6 普通 user → 200（非 403 admin-only）；无 token → 401。
  - C7 每组 `total.pnl ≈ risk.pnl + cash.pnl − total.fees`（2 位小数）。
  - C8 相关子集（**只跑子集**）：`tests/unit/portfolioReturn.test.ts` + agent 新增的 breakdown 测试；agent 测试须含 ≥1 条多券商 golden 与 1 条手工归组 golden（三组 cost = 1005 / 2010 / 5003）。命令示例：
    `npx vitest run --config apps/backend/vitest.config.ts <相关文件>`，硬超时 5 min。

## 6. 有效 / 中止判据

- 起跑 worktree 不干净（`git status --porcelain` 非空）→ 无效。
- 超过 60 min 未返回 → 无效。
- run 结束零代码改动 → 无效。
- 越界检测（§2.1）出现主仓 `AGENTS.md` / `docs/**` 路径 → 样本作废。

## 7. 交付位置

- 结果追加为 `doc-optimization-baseline.md` 新小节（建议 §7.6「opencode pilot」），并在标题 / 表头显式标注：
  `N=1 pilot / 非证据 / 顺序混淆 / 配置恒定（D6 排除未隔离）/ 去密钥配置偏离`。
- 不并入 agent 产出的 breakdown 代码；worktree 保留或 `git worktree remove`。

## 8. 待 owner 确认

1. **样本**：接受 N=1 与固定顺序 b1→a1；还是再加一组反向顺序（N=2，成本翻倍）来抵消顺序混淆。
2. **配置收紧**：接受「去密钥 `{file:}` + `external_directory` 拒绝 + `OPENCODE_CONFIG` 指向 worktree 外」作为偏离（两臂一致）。

> 超时已固定为 **60 min 硬超时（不放宽）**，见 §3 / §6。
