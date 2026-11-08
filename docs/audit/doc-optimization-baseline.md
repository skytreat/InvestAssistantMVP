# 文档优化 · 前后对照基准（doc-optimization baseline）

> **性质**：证据 / 实验协议（`docs/audit/`），**默认不加载**，仅在「检查优化效果 / gate 证据」时检索。
> **状态**：🟢 **COMPLETE（Trae 口径 N=2×2）—— before b1 §7.2 / b2 §7.4；after a1/a2 §7.5；4 次无效样本 §7.3；opencode 口径仅附注（§7/§7.1）。M2/M3/M5 全组 NOT COLLECTED（§8）**；另：**opencode pilot（§7.6）已采（b1/a1/b1r/b1s/a1r），M2/M3/M5 可采但非主对比**
> **关联**：`docs/adr/ADR-018`（本实验要验证的对象）；**主口径采集源 = IDE 内 Trae 会话**（不读 `opencode.db`，§6 的 SQL 仅适用于附注口径）
> **目的**：用**同一个真实开发任务**，量化「文档结构优化（ADR-018 §6）」前后 coding agent 的
> 读取文件数、输入 Token、完成时间、遗漏规格数，把「优化有效」从判断变成可复现实验。

---

## 1. 假设

H1：落地 ADR-018 §6（INDEX + 任务卡 + 生成物 + AGENTS 瘦身 + audit 默认排除）后，
agent 完成**同一任务**所需的**读取文件数（M2）与输入 Token（M3）显著下降**，
同时**遗漏规格数（M5）不上升**（质量不降）。

## 2. 指标与数据来源

| 指标 | 含义 | 数据来源 | 备注 |
|---|---|---|---|
| M1 | AGENTS.md Token | 静态字节计数（估算 ~2.2 字符/token） | before≈37KB / after≈10KB，确定性 |
| M2 | 读取文件数 | `opencode.db` → `part` 中 `type=tool` 且 `tool∈{read,grep,glob}` 的调用次数 | 另记 `bash` 次数作旁证 |
| M3 | 输入 Token | `opencode.db` → `session.tokens_input`（+`tokens_cache_read`） | 单一会话累计值 |
| M4 | 完成时间 | `session.time_updated − time_created`（到停止判据达成） | 含模型/工具，同模型可比 |
| M5 | 遗漏规格数 | 冻结 checklist（§4）8 条，跑 `bench-probe` + 相关子集测试打分 | 0=全命中 |

**采集**：每次 run 后，用 `session.id`（`opencode run` 新建会话）查 `opencode.db`。

> ⚠️ **主口径已切换为 IDE 内 Trae**（§7.2）：Trae 侧无同构工具调用记录、不暴露 token ⇒ **M2/M3/M5 一律记 `NOT COLLECTED`**；上表来源说明仅适用于 **opencode 附注口径**。

## 3. 基准任务（冻结，Task A —— 保证 open 的多券商收益分维度）

**为什么选它**：多券商三口径单券商筛选（`?brokerCode=`）**已实现**（T132：
`routes/portfolio.ts` 读 `q.brokerCode`、`services/portfolioReturn.ts` 做 `brokerFilter`、
单测 `tests/unit/portfolioReturn.test.ts`）；但**按券商分组的 breakdown 数组**
（`?breakdown=broker` 返回 `[ {brokerCode, risk, cash, total} ]`）经 `grep` 确认**全仓缺席**
（唯一命中是无关的 `configStore.ts:293 fee_breakdown_json`）⇒ 任务保证 open。
它跨 **L1 业务口径（三口径，SDD_v3 §7.3/§9.5）+ L3 契约（envelope/错误码/角色）+ 测试约定**，
能把「文档结构」差异放大。

**给被测 agent 的 task brief（冻结，前后完全一致；不给 checklist）**：
> 给 `GET /api/portfolio/return` 增加一个可选 query 参数 `breakdown=broker`。
> 指定时：按券商分组，返回该用户**所有**券商的三口径收益（每组含 手工/无券商 记录）；
> 不指定时：现有行为完全不变。补齐测试。请遵循本仓既有的响应封装、错误码、角色守卫、命名与测试约定。

## 4. 冻结 checklist（M5 = 8 − 命中数；由 `bench-probe` + 相关子集测试客观判定）

**确定性 fixture（grader 造数，非 agent 造）**：user 1（role=user），券商 `001`/`002`，1 条手工记录：
- `001`：buy sh600000 ×100 @10 fee5（2026-09-01）
- `002`：buy sz000001 ×100 @20 fee10（2026-09-02）
- 手工（broker_code IS NULL）：buy sh600519 ×50 @100 fee3（2026-09-03）
- 无行情（unit 档）→ 各未平仓 MV=0、realized=0。

| # | 判据 | 通过条件 |
|---|---|---|
| C1 | 回归 | 现有 `portfolioReturn.test.ts` **全绿**；不传 breakdown 时返回**单对象**（非数组），字段不变 |
| C2 | 多券商数组 | `?breakdown=broker` 且 ≥2 券商 → `data` 为**数组**，每元素含 `brokerCode` + `risk/cash/total` |
| C3 | 手工归组 | `broker_code IS NULL` 记录归入一个明确组（如 `brokerCode:null`/`'manual'`），**不丢失、不误并入**某券商 |
| C4 | 单券商 | 仅 1 个券商时数组长度 = 1 |
| C5 | envelope | 成功体 `code=0 + data + timestamp`（**无 `success`**，T89b 已删除）；错误走统一 `fail`，**不裸抛 500** |
| C6 | 角色 | 用户级端点：普通登录用户可访问（**不 403 admin-only**）；未登录 401 |
| C7 | 可加性 | 每组 `total.pnl ≈ risk.pnl + cash.pnl − fees`（复用现有 golden 断言方式） |
| C8 | 测试 | 契约测试（走路由 + envelope）+ 单测（≥1 条多券商 + 1 条手工归组 golden：`001` group cost=1005 / `002`=2010 / 手工=5003）；相关子集全绿 |

**grader 脚本（run 时写）**：`scripts/bench-probe.mjs` —— seed 上述 fixture，调 `computePortfolioReturn`（含 breakdown）与路由注入，逐条断言 C1–C7，输出 `C1..C7: PASS/FAIL` + C8 的 `npx vitest run` 结果。M5 据此计分。

> **opencode pilot 偏离**：`doc-optimization-pilot-plan.md` 改用 `apps/backend/tests/unit/bench-probe.test.ts`（需 vitest/TS 加载），判据与 fixture 不变；该偏离已在 pilot 计划 §5 显式记录。

## 5. 运行协议（N=2 / 条件）

| 维度 | 设置 |
|---|---|
| 变量 | **唯一变量 = 文档结构**（before=现状 / after=ADR-018 §6 落地后） |
| 代码基 | 两条件**同一 base commit**（`main`，未含 §6 代码）；agent 产出的代码改动作为交付物评估，不并入 |
| 会话 | 每次 `opencode run "<task brief>"` 开**全新会话**（无前序上下文污染） |
| 模型/工具 | 相同（**主口径 = IDE 内 Trae + `DeepSeek-V4.1-Flash`**，见 §7.2；历史 opencode + agnes-3.0-flash 仅作附注，不参与主对比）；两条件各 **2 次**（b1/b2、a1/a2） |
| 被测输入 | 只给 §3 task brief；**不给 checklist、不给 audit**（触发规则：任务未显式引用 audit） |
| 停止判据 | agent 自述完成 **且** `bench-probe` 的 C8 相关子集全绿；记录此时 `time_updated` |
| 顺序 | **先采 before（当前文档）→ 实施 §6 → 采 after → 填 §6 对照表** |

## 6. 数据采集（示例 SQL）

```sql
-- M3/M4（按 opencode run 新建的 session id）
-- time_created / time_updated 为 13 位毫秒时间戳（2026-11-04 抽样实测），差值单位 = ms
SELECT id, tokens_input, tokens_cache_read, tokens_output, cost,
       time_created, time_updated,
       (time_updated - time_created) AS dur_ms
FROM session WHERE id = '<ses_xxx>';

-- M2（读文件数 = read/grep/glob 工具调用）
SELECT json_extract(data,'$.tool') AS tool, COUNT(*) AS n
FROM part WHERE session_id='<ses_xxx>' AND json_extract(data,'$.type')='tool'
  AND json_extract(data,'$.tool') IN ('read','grep','glob')
GROUP BY 1;
```

## 7. 结果对照表（主样本 = Trae 实跑 b1；opencode 口径降为附注）

| run | 条件 | M1(AGENTS) | M2(读文件) | M3(输入token) | M4 | M5(命中/8；遗漏=8−命中) | 备注 |
|---|---|---|---|---|---|---|---|
| **b1（主样本·Trae）** | before | 37KB≈17k | **NOT COLLECTED** | **NOT COLLECTED** | **≈16min**（2026-11-04 00:07→00:23） | **NOT COLLECTED** | 起始提交 `ef4f9d9`（`git status` 为空）；`DeepSeek-V4.1-Flash`；5 文件（4 改 + 1 新增）`314+/41-` 加新文件 153 行；明细见 §7.2 |
| b1-opencode（附注） | before | 37KB≈17k | 48（read38+grep9+glob1） | 458,148（另 cache_read 6,582,272 / output 28,501） | ≈8,781s（146min） | ~7/8（transcript 判，C8 未跑 bench-probe） | ⚠️ **不同工具口径（`opencode run` + agnes-3.0-flash），不参与主对比**；session `ses_e5fad31a4ffezIpNxPolKNcN1M` |
| **b2（主样本·Trae）** | before | 37KB≈17k | **NOT COLLECTED** | **NOT COLLECTED** | **≈9.5min**（2026-11-04 08:59→09:08） | **NOT COLLECTED** | 起始提交 `11d038a`（起跑前 `git status` 为空）；5 文件（4 改 + 1 新增）`258+/39-` 加新文件 114 行；明细见 §7.4 |
| b2-opencode（附注） | before | 37KB≈17k | ⚠️17 / ⚠️27（两次尝试，**均无效**） | ⚠️76,594 / ⚠️168,328 | ⚠️≈34.6min / ≈55.5min | — | ⏭️ **owner 决定跳过**（首轮在脏树起跑、重跑前被中止）；实测值归档见 §7.1，**不计入对照** |
| **a1（Trae）** | after | **20.5KB≈9.3k**（−46%） | **NOT COLLECTED** | **NOT COLLECTED** | **≈8.9min**（09:18→09:27） | **NOT COLLECTED** | 起始 `617ba1f`；5 文件（4 改+1 新 151 行）`235+/36-`；明细 §7.5 |
| **a2（Trae）** | after | 同上 | **NOT COLLECTED** | **NOT COLLECTED** | **≈46.9min**（09:27→10:14；⚠️含全量后端测试卡死 35min） | **NOT COLLECTED** | 起始 `617ba1f`；5 文件（4 改+1 新 107 行）`260+/34-`；明细 §7.5 |

**b1-opencode 明细（`opencode.db` → `part`/`session`，附注口径）**：
- 工具调用：`read=38, grep=9, glob=1`（读文件 48）+ `edit=19, write=2, bash=12, todowrite=4`
- M3 为 provider 上报累计值；`cache_read` 高达 6.58M（agnes-3.0-flash 命中缓存）
- M5（transcript 判定，未跑 `bench-probe` 全量）：C1 回归 / C2 多券商数组 / C3 手工归组 / C4 单券商 / C6 角色 200-401 / C7 可加性 均命中；C8 相关子集「91 tests pass」，但独立 bench-probe golden 断言未跑 → 保守记 ~7/8
- b1 产出 6 文件（`portfolio.ts` / `portfolioReturn.ts` / `positionCalculator.ts` / 单测 / `envelopeContract.test.ts` / 新增 breakdown 集成测试），已快照于临时区，未并入仓库

### 7.1 b2 采集取证（**无效样本归档，不计入对照**）

两次 before 采样均不满足 §5 协议，故 b2 判定为 **无效并跳过重跑**（owner 决定）。原始数值仍归档以便复现/审计：

| 尝试 | session | M2（read/grep/glob） | M3（tokens_input） | cache_read / output | M4（time_updated − time_created） | 无效原因 |
|---|---|---|---|---|---|---|
| 首轮 | `ses_e5f253d06ffewe8VcDCetZp6LR`（`bench-b2`） | 17（13/3/1） | 76,594 | 2,522,624 / 10,100 | 2,075,312ms ≈ **34.6min** | **脏树起跑**：工作区已有 b1 残留改动 ⇒ 违反 §5「同一 base commit、代码基干净」 |
| 重跑 | `ses_e5f02bc67ffebtSnoreiqfOUyT`（`bench-b2b`） | 27（17/8/2） | 168,328 | 1,529,088 / 5,976 | 3,332,200ms ≈ **55.5min** | **未达停止判据即被中止**：`tokens_output` 5,976 远低于 b1 的 28,501，会话无终态交付 |

> ⚠️ 两样本的 M3/M4 均**不可用作 before 的第二样本**：一个受脏树影响（读取了本不属于基线的文件），另一个未完成（时间与 token 都被截断）。这正是 §8「随机性/污染」风险的实测证据，也是 b2 只能跳过、before 仅剩 1 样本的原因。

**判定（opencode 口径，当前）**：仅有 before 单样本（b1-opencode），**H1 尚不可判定** —— 需 §6 实施后采 a1/a2 才能对照 M2/M3/M5。b2 跳过使 before 只剩 1 样本，M2/M3/M4 的离散度无法估计（噪声风险，尤其 M4=146min 偏长）。

### 7.2 b1 主样本明细（**Trae 实跑**，2026-11-04）

| 项 | 值 |
|---|---|
| 工具 / 模型 | IDE 内 Trae，模型为当时 IDE 配置的 `DeepSeek-V4.1-Flash` |
| 起始提交 | `ef4f9d9`（起跑前 `git status` 为空，**干净工作区**） |
| 被测输入 | 与 §3 冻结 brief **逐字一致**（未给 checklist、未给 audit） |
| 起止 / 耗时 | 2026-11-04 00:07 → 00:23，**≈16 min**（串行，无并发） |
| 交付物 | 5 文件 = 4 修改（`apps/backend/src/routes/portfolio.ts`、`apps/backend/src/services/portfolioReturn.ts`、`apps/backend/src/services/positionCalculator.ts`、`apps/backend/tests/unit/portfolioReturn.test.ts`）+ 1 新增 `apps/backend/tests/integration/portfolioReturn.breakdown.test.ts`（**153 行**） |
| 改动量 | `4 files changed, 314 insertions(+), 41 deletions(-)`，**另加** 1 个未跟踪新文件 153 行（故实际新增 ≈467 行） |
| M2 读取文件数 | **NOT COLLECTED** —— Trae 侧无 `opencode.db` 同构的工具调用记录，采不到 |
| M3 输入 token | **NOT COLLECTED** —— Trae 侧不暴露 token 用量 |
| M5 遗漏规格 | **NOT COLLECTED**（checklist 未由 grader 独立判读）；agent **自报**：`typecheck` / ESLint / Prettier 通过，新增相关子集 `12/12`、`envelopeContract` 75 通过、后端全量 `1150 passed / 8 skipped`（**未经 grader 复核**） |
| 改动归档 | `git stash: bench-b1-2026-11-04`；补丁副本 `%TEMP%\bench-b1.diff`。**未并入仓库**，符合 §5「代码改动不并入」 |

> ⚠️ **口径差异显式标注**：主样本用 Trae + `DeepSeek-V4.1-Flash`，M2/M3 均不可采；opencode 口径 b1（M2=48 / M3≈458k / M4≈146min）是**另一套工具与模型**的结果，**只能作附注，不参与主对比**。主对比只在同一工具口径内成立：**before = Trae b1 ↔ after = Trae a1/a2**。

### 7.3 Trae 侧无效样本（**归档，不计入对照**）

| 样本 | 时间 | 观测 | 无效原因 |
|---|---|---|---|
| 无效样本 1 | 2026-11-03 23:49–23:51 | 流中断，**零改动** | 未产出任何交付物，不满足 §5 停止判据 |
| 无效样本 2 | 2026-11-04（≈14min） | 5 文件（4 改 + 1 新）、`+272/−30` | **并发污染**：两个 agent 并行跑同一任务，工作区互扰（§8「污染」风险的实测证据）；已归档 `git stash: bench-invalid-concurrent-2026-11-04`，判定无效 |
| 无效样本 3 | 2026-11-04 00:23→00:35（≈12min） | 4 文件、`+200/−28` + 新文件 130 行 | **关机中断**：b2 首跑在最后一个文件 mtime `00:35:44` 后随机器关机中止，未达 §5 停止判据；已归档 `git stash: bench-b2-interrupted-2026-11-04`、补丁 `%TEMP%\bench-b2-interrupted.diff` |

**判定（Trae 口径）**
- **M1（已可判定）**：`AGENTS.md` 37,858B → **20,548B（−45.7%）**；新增单入口 `docs/INDEX.md` + 5 张 D 卡（均 < 4KB 软上限）+ 生成物。
- **M4（噪声大，只作区间）**：before ≈16min / ≈9.5min；after a1 ≈8.9min、a2 ≈46.9min（其中 ≈35min 是全量测试卡死）。**有效对比只能取 a1 vs b2（≈8.9 vs ≈9.5，−6%）**；a2 归入已知局限，不作证据。
- **交付物规模（近似持平）**：before `314+/41-`+153 行、`258+/39-`+114 行；after `235+/36-`+151 行、`260+/34-`+107 行 ⇒ 文档瘦身**未降低交付质量量级**，也未提升。
- **M2/M3/M5**：Trae 侧**全部 NOT COLLECTED** ⇒ **H1 的「读取文件数与 token 显著下降」不可证**，只能证「M1 达成、M4 未见恶化」。**结论按此边界表述，不外推。**

**H1 结论（受限）**：**部分成立** —— 结构优化（单入口 + 卡 + 生成物 + 审查排除）**已落地且指标可机器校验**（`docs-lint`：0 ERROR / 0 WARNING），但「读得更少、token 更省」**未获测量支撑**（工具侧取不到 M2/M3）。要闭环 H1，需在能导出 token/工具计数的 harness（`bench-probe`）就绪后重跑。

### 7.4 b2 主样本明细（**Trae 实跑**，2026-11-04）

| 项 | 值 |
|---|---|
| 工具 / 模型 | IDE 内 Trae，模型为 IDE 配置的 `DeepSeek-V4.1-Flash`（与 b1 同配置，四组不得变更） |
| 起始提交 | `11d038a`（起跑前 `git status --porcelain` 为空，**干净工作区**；该提交只改 `docs/audit/`，**文档结构仍未优化**） |
| 被测输入 | 与 §3 冻结 brief **逐字一致**（未给 checklist、未给 audit） |
| 起止 / 耗时 | 2026-11-04 08:59 → 09:08，**≈9.5 min**（串行，单 agent，无并发） |
| 交付物 | 5 文件 = 4 修改（`apps/backend/src/routes/portfolio.ts`、`apps/backend/src/services/portfolioReturn.ts`、`apps/backend/src/services/positionCalculator.ts`、`apps/backend/tests/unit/portfolioReturn.test.ts`）+ 1 新增 `apps/backend/tests/integration/portfolioReturn.breakdown.test.ts`（**114 行**） |
| 改动量 | `4 files changed, 258 insertions(+), 39 deletions(-)`，**另加** 1 个未跟踪新文件 114 行（故实际新增 ≈372 行） |
| M2 / M3 | **NOT COLLECTED**（同 §7.2 的 Trae 侧限制） |
| M5 | **NOT COLLECTED**（checklist 未由 grader 独立判读）；agent **自报**：`12/12` 新测通过、`envelopeContract` 74 通过 / 1 skip、持仓回归 `68/68`、`typecheck` + ESLint + Prettier 通过（**未经 grader 复核**） |
| 改动归档 | `git stash: bench-b2-2026-11-04`；补丁 `%TEMP%\bench-b2.diff`；未并入仓库 |

> ⚠️ **b1 与 b2 的分母一致但绝对值分化（≈16min vs ≈9.5min，−41%）**：同一冻结 brief、同一模型、同一代码提交族，说明**单样本 M4 噪声极大** ⇒ after 侧必须按 N=2 取区间，不能用单次耗时下结论。

### 7.5 a1 / a2 主样本明细（**Trae 实跑**，2026-11-04，after）

| 项 | a1 | a2 |
|---|---|---|
| 工具 / 模型 | IDE 内 Trae + `DeepSeek-V4.1-Flash`（与 b1/b2 同配置） | 同左 |
| 起始提交 | `617ba1f`（ADR-018 §6 落地后：`AGENTS.md` 20,548B、`docs/INDEX.md`、5 张 D 卡、`docs-lint`） | 同左 |
| 被测输入 | 与 §3 冻结 brief **逐字一致**（未给 checklist / audit） | 同左 |
| 起止 / 耗时 | 09:18 → 09:27，**≈8.9 min** | 09:27 → 10:14，**≈46.9 min** |
| 交付物 | 5 文件 = 4 改 + 1 新（`portfolioReturn.breakdown.test.ts` **151 行**） | 5 文件 = 4 改 + 1 新（**107 行**） |
| 改动量 | `4 files changed, 235 insertions(+), 36 deletions(-)` + 新文件 151 行 ≈ **386 行** | `4 files changed, 260 insertions(+), 34 deletions(-)` + 新文件 107 行 ≈ **367 行** |
| M2 / M3 / M5 | NOT COLLECTED | NOT COLLECTED |
| 测试自报（未复核） | 新增 12/12、相关子集 153 通过 / 1 skip、`tsc` + ESLint + Prettier 通过 | 新增 12/12、`83 passed / 1 skipped`、持仓回归 67 通过、`tsc` + ESLint + Prettier 通过；**全量后端跑满 10min 工具上限卡死**（agent 自述：真行情库用例长时间等待，非本次改动） |
| 归档 | `git stash: bench-a1-2026-11-04` / `%TEMP%\bench-a1.diff` | `git stash: bench-a2-2026-11-04` / `%TEMP%\bench-a2.diff` |

> ⚠️ **a2 的 M4（≈46.9min）严重失真**：其中 **≈35min 是全量后端 vitest 卡死**（主进程 CPU 仅 7.6s，agent 自述卡在真行情库/网络类用例）。**主对比须用 a1（≈8.9min），a2 仅作上界参考**，并在 §8 记为已知局限。

### 7.6 opencode pilot（非证据；2026-11-05）

> ⚠️ **性质**：可行性试点，**非证据**；与 §7.2/§7.4/§7.5 的 Trae 主样本**不同工具、不同模型**，不可混用。
> 协议与执行细节见 `doc-optimization-pilot-plan.md`。
> **运行顺序**：b1（旧配置，放行全量测试）→ a1 → b1r → b1s → a1r（后四者同收紧配置）。**公平对照 = b1r/b1s vs a1/a1r**；b1 仅作「旧配置」参考。
> **样本量**：before 3（同配置 2：b1r/b1s），after 2（a1/a1r）。

| run | 条件 / 配置 | M1(AGENTS) | M2(读文件) | M3(输入token；cache/out) | M4 | 步数 | 交付规模 | M5(命中/8) |
|---|---|---|---|---|---|---|---|---|
| b1-oc | before / 旧（放行全量 vitest） | 37,430B | 9（read6+grep3+glob0） | 191,594（cache 6,703,744 / out 12,389） | 550,535ms ≈**9m11s** | 76 tool calls / 266 parts | 4 改 +151/−12；新测试 109 行 | **3/8**（C1/C5/C6） |
| a1-oc | after / 收紧 | 16,368B | 8（read7+grep1+glob0） | 122,782（cache 2,797,568 / out 10,477） | 279,982ms ≈**4m40s** | 46 tool calls / 158 parts | 4 改 +249/−27；新测试 145 行（含路由契约） | **8/8** |
| b1r-oc | before / 收紧 | 37,430B | 19（read11+grep8+glob0） | 111,156（cache 2,390,656 / out 4,653） | 296,460ms ≈**4m56s** | 60 tool calls / 168 parts | 4 改 +260/−34；无新增文件（仅改单测） | **7/8**（缺路由契约测试） |
| b1s-oc | before / 收紧 | 37,430B | 18（read9+grep8+glob1） | 106,207（cache 2,333,312 / out 11,912） | 388,140ms ≈**6m28s** | 63 tool calls / 172 parts | 4 改 +260/−34；新测试 138 行（含路由契约） | **8/8** |
| a1r-oc | after / 收紧 | 16,368B | 27（read19+grep8+glob0） | 163,077（cache 4,106,880 / out 12,742） | 720,880ms ≈**12m01s** | 62 tool calls / 187 parts | 4 改 +268/−29；新测试 177 行（含路由契约） | **8/8** |

**公平对照（同配置，N_before=2 / N_after=2）**：

| 指标 | before（b1r, b1s） | after（a1, a1r） | 观察 |
|---|---|---|---|
| M2 读文件 | 19, 18（均值 18.5） | 8, 27（均值 17.5） | 区间重叠，无稳定差异 |
| tool calls | 60, 63（61.5） | 46, 62（54.0） | 均值略低，但 a1r 落在 before 区间内 |
| parts | 168, 172（170） | 158, 187（172.5） | 基本持平 |
| M4 | 4m56s, 6m28s（均值 5m42s） | 4m40s, 12m01s（均值 8m20s） | 区间重叠；after 均值更高，a1r 为长尾 |
| M3 input | 111,156, 106,207（108.7k） | 122,782, 163,077（142.9k） | **两个 after 都高于两个 before（均值 +31.5%）** |
| cache | 2.39M, 2.33M（2.36M） | 2.80M, 4.11M（3.45M） | after 更高 |
| output | 4,653, 11,912（8.3k） | 10,477, 12,742（11.6k） | after 更高 |
| M5 | 7, 8 | 8, 8 | after 两次均 8/8 |

**判读**：
- **没有任何指标稳定下降**：M2 / tool calls / parts / M4 的两组区间均重叠；after 的 M4 均值反而更高（a1r 12m01s 长尾）。
- **token 方向相反且一致**：两个 after 的 input / cache / output 都高于两个 before（input 均值 +31.5%）⇒ 本试点**不支持**「文档优化降低 token」。
- **质量未下降**：after 两次均 8/8；before 一次 7/8（b1r 缺路由契约测试）。
- 原 b1 vs a1 的「大幅下降」（M4 −49%、input −36%）主要是 b1 跑全量测试（63.6s / 44k 字符，之后 9 步 input 27k / cache 1.55M）+ 额外探索，叠加单样本噪声；加入 b1r/b1s/a1r 后不再成立。
- 越界检测：五样本 `badCount=0`；均未超时、有交付。

**局限**：
- 每臂 N=2 仍小，且离散极大（M4 before 4m56–6m28、after 4m40–12m01；M2 before 18–19、after 8–27）。
- 顺序为 b1→a1→b1r→b1s→a1r；after 位于第 2/5 个，before 位于第 3/4 个，存在时间 / 缓存混淆。
- b1 旧配置放行全量测试，导致其 M3/M4 偏高；仅作参考。
- C2 的「`data` 为数组」未在 brief/文档中显式钉死；b1 选了 `data.breakdown`，其余命中。
- **结论**：本试点只支持「after 质量至少不下降（8/8×2）」，**不支持**「读取 / token / 时间显著下降」。

## 8. 公平性 / 已知风险

- **随机性**：agent 每 run 非确定；before 两样本 M4 已出现 **≈16min vs ≈9.5min（−41%）** 的离散 ⇒ 结论按区间表述，不用单次耗时下定论。
- **污染已排除的 3 条**：流中断（零改动）、并发双 agent（`bench-invalid-concurrent-2026-11-04`）、关机中断（`bench-b2-interrupted-2026-11-04`）均**未并入**对照。
- **Token 口径**：`tokens_input` 为 provider 上报累计值；`tokens_cache_read` 单列，避免缓存稀释误判。
- **污染**：被测 run 用全新会话；grader（人/我）持有 checklist，被测 agent 不持有。
- **M2/M3 缺采（Trae 口径）**：主样本 b1/b2/a1/a2 的读取文件数、token 用量均 **NOT COLLECTED** ⇒ H1 的「M2/M3 显著下降」子命题在当前工具下**暂不可证**；可用信号只有 M1（AGENTS 旧 37,858B → 新 20,548B，−45.7%）、M4（见 §7）与交付物规模（四组均 5 文件，≈367–386 行）。
- **a2 的 M4 失真**：单次跑出 ≈46.9min，其中 ≈35min 卡在全量后端测试（非任务本身）⇒ 不计入主对比，只作上界。
- **after 侧存在提示效应**：a1/a2 的 agent 与 b 组同模型，但仓库里多了 `docs/INDEX.md` 与 D 卡，可能改变其检索路径；这正是 H1 要测的变量，但也意味着**不能把 M4 差异全归因于 AGENTS 瘦身**。
- **工具口径不可混用**：Trae（`DeepSeek-V4.1-Flash`）与 opencode（agnes-3.0-flash）的 M2/M3 采集机制不同，跨工具比较无效；a1/a2 必须与 b1 **同工具同模型**。
- **任务漂移**：task brief / fixture / checklist 全部冻结在本文件，前后不得改。
- **代码改动不并入**：基准只测「agent 消费文档完成该任务」，产出的 breakdown 代码是副作用，不 merge。

## 9. 下一步

1. ✅ **b1 已采（主样本 = Trae 实跑，2026-11-04，见 §7.2）**：起始提交 `ef4f9d9`，≈16min，5 文件；M2/M3/M5 = NOT COLLECTED；改动归档 `git stash: bench-b1-2026-11-04`。
2. ✅ **b2 已采（主样本 = Trae 实跑，2026-11-04，见 §7.4）**：起始提交 `11d038a`，≈9.5min，5 文件；M2/M3/M5 = NOT COLLECTED；归档 `git stash: bench-b2-2026-11-04`。**before 已满 N=2**。
3. ✅ **Trae 侧 3 次无效样本已归档（§7.3）**：流中断（零改动）/ 并发污染 / 关机中断。
4. ⏭️ **opencode 口径全部降为附注**（§7/§7.1），**不参与主对比**。
5. ✅ **ADR-018 §6 已落地**（提交 `617ba1f`）：`docs/INDEX.md` 单入口 + 5 张 D 卡 + `docs/status.md`/`backlog.md`/`tasks/INDEX.md` 生成物 + `scripts/docs-lint.mjs`（`--gen`/`--check`，0 ERROR/0 WARNING）+ `docs/runbooks/agent-playbook.md` + `AGENTS.md` 37858→20548B + `opencode.jsonc` 排除 `docs/audit/**`、`docs/archive/**` + `docs-lint` CI（report-only）。
6. ✅ **a1/a2 已采**（同工具同模型、串行单跑、起始 `617ba1f`）：a1 ≈8.9min / a2 ≈46.9min（含 35min 测试卡死）；M2/M3/M5 = NOT COLLECTED；归档 `stash: bench-a1/a2-2026-11-04`。
7. ⏭️ **剩余（需 harness）**：`scripts/bench-probe.mjs` 就绪后补 M5 判读；IDE 侧若能导出工具调用 / token 计数，再补 M2/M3 并重跑 a1/a2。
8. ⏭️ **ADR-018 §6 第 6 项（V2 计划冻结）未执行**：需先按 D2 做 Tier A/B/C 校验（判分点反向投影、失效链接、重复事实抽取、卡 existence 校验）并为 42 张卡登记核验锚；本次只落地 1–5 项。
9. ⚠️ **opencode pilot 已采（§7.6）**：b1 3/8（旧配置，仅参考）、a1 8/8、b1r 7/8、b1s 8/8、a1r 8/8。同配置 N_before=2 / N_after=2：M2 18–19 vs 8–27、input 106–111k vs 123–163k（after 更高）、M4 4m56–6m28 vs 4m40–12m01 ⇒ **无稳定下降**，仅质量 8/8×2。**非证据**：N 小、离散大、顺序混淆。

> 主口径复现：IDE 内 Trae，模型 `DeepSeek-V4.1-Flash`，起始提交 `ef4f9d9`（干净树），prompt 逐字取 §3；
> M4 取会话起止时间；M2/M3 需 IDE 侧工具调用 / token 能力，当前为 **NOT COLLECTED**。
> 附注口径复现：`opencode run --title <bench-x> -m agnes/agnes-3.0-flash --dir <repo> "<§3 task brief>"`；
> 指标取自 `~/.local/share/opencode/opencode.db`（`session` 取 M3/M4，`part` 取 M2）。
