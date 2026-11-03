# 文档优化 · 前后对照基准（doc-optimization baseline）

> **性质**：证据 / 实验协议（`docs/audit/`），**默认不加载**，仅在「检查优化效果 / gate 证据」时检索。
> **状态**：🟡 **DRAFT —— before 已采 b1（主样本 = Trae 实跑，§7.2，单样本）；opencode 口径 b1 降为附注（§7）；opencode b2 跳过（§7.1）；Trae 侧 2 次无效样本归档（§7.3）；after（a1/a2）待 ADR-018 §6 落地后采集**
> **关联**：`docs/adr/ADR-018`（本实验要验证的对象）、`opencode.db`（数据采集源）
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
| C5 | envelope | 成功体 `code=0 + data + timestamp + success=true`；错误走统一 `fail`，**不裸抛 500** |
| C6 | 角色 | 用户级端点：普通登录用户可访问（**不 403 admin-only**）；未登录 401 |
| C7 | 可加性 | 每组 `total.pnl ≈ risk.pnl + cash.pnl − fees`（复用现有 golden 断言方式） |
| C8 | 测试 | 契约测试（走路由 + envelope）+ 单测（≥1 条多券商 + 1 条手工归组 golden：`001` group cost=1005 / `002`=2010 / 手工=5003）；相关子集全绿 |

**grader 脚本（run 时写）**：`scripts/bench-probe.mjs` —— seed 上述 fixture，调 `computePortfolioReturn`（含 breakdown）与路由注入，逐条断言 C1–C7，输出 `C1..C7: PASS/FAIL` + C8 的 `npx vitest run` 结果。M5 据此计分。

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

| run | 条件 | M1(AGENTS) | M2(读文件) | M3(输入token) | M4 | M5(命中/8) | 备注 |
|---|---|---|---|---|---|---|---|
| **b1（主样本·Trae）** | before | 37KB≈17k | **NOT COLLECTED** | **NOT COLLECTED** | **≈16min**（2026-11-04 00:07→00:23） | **NOT COLLECTED** | 起始提交 `ef4f9d9`（`git status` 为空）；`DeepSeek-V4.1-Flash`；5 文件（4 改 + 1 新增）`314+/41-` 加新文件 153 行；明细见 §7.2 |
| b1-opencode（附注） | before | 37KB≈17k | 48（read38+grep9+glob1） | 458,148（另 cache_read 6,582,272 / output 28,501） | ≈8,781s（146min） | ~7/8（transcript 判，C8 未跑 bench-probe） | ⚠️ **不同工具口径（`opencode run` + agnes-3.0-flash），不参与主对比**；session `ses_e5fad31a4ffezIpNxPolKNcN1M` |
| b2 | before | 37KB≈17k | ⚠️17 / ⚠️27（两次尝试，**均无效**） | ⚠️76,594 / ⚠️168,328 | ⚠️≈34.6min / ≈55.5min | — | ⏭️ **owner 决定跳过**（首轮 b2 在脏树上起跑已污染；重跑前被中止）；实测值归档见 §7.1，**不计入对照** |
| a1 | after | ~10KB≈5k | | | | | 待 §6 实施后采（须同工具同模型：Trae + `DeepSeek-V4.1-Flash`） |
| a2 | after | ~10KB≈5k | | | | | 待 §6 实施后采（同上） |

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
| M5 遗漏规格 | **NOT COLLECTED** —— **测试结果未采集**，本次只登记交付物，不推测 C1–C8 命中数 |
| 改动归档 | `git stash: bench-b1-2026-11-04`；补丁副本 `%TEMP%\bench-b1.diff`。**未并入仓库**，符合 §5「代码改动不并入」 |

> ⚠️ **口径差异显式标注**：主样本用 Trae + `DeepSeek-V4.1-Flash`，M2/M3 均不可采；opencode 口径 b1（M2=48 / M3≈458k / M4≈146min）是**另一套工具与模型**的结果，**只能作附注，不参与主对比**。主对比只在同一工具口径内成立：**before = Trae b1 ↔ after = Trae a1/a2**。

### 7.3 Trae 侧无效样本（**归档，不计入对照**）

| 样本 | 时间 | 观测 | 无效原因 |
|---|---|---|---|
| 无效样本 1 | 2026-11-03 23:49–23:51 | 流中断，**零改动** | 未产出任何交付物，不满足 §5 停止判据 |
| 无效样本 2 | 2026-11-04（≈14min） | 5 文件（4 改 + 1 新）、`+272/−30` | **并发污染**：两个 agent 并行跑同一任务，工作区互扰（§8「污染」风险的实测证据）；已归档 `git stash: bench-invalid-concurrent-2026-11-04`，判定无效 |

**判定（Trae 口径）**：before 主样本只有 b1 一条，且 M2/M3/M5 缺采 ⇒ **H1 仍不可判定**；a1/a2 必须在**同工具同模型**下采，并补 `bench-probe`/测试采集以填 M5，否则前后不可比。

## 8. 公平性 / 已知风险

- **随机性**：agent 每 run 非确定；**b2 已跳过 → before 仅 1 样本**，均值/区间不可得，M4 时间噪声最大，只作参考。
- **b1 采样污染已排除**：b1 在干净 portfolio 基线上起跑；其后 2 次 b2 尝试（首轮在脏树、重跑前被中止）均未并入，已 `git checkout` 复位 portfolio 文件。
- **Token 口径**：`tokens_input` 为 provider 上报累计值；`tokens_cache_read` 单列，避免缓存稀释误判。
- **污染**：被测 run 用全新会话；grader（人/我）持有 checklist，被测 agent 不持有。
- **M2/M3 缺采（Trae 口径）**：主样本 b1 的读取文件数、token 用量、测试结果均 **NOT COLLECTED** ⇒ H1 的「M2/M3 显著下降」子命题在当前工具下**暂不可证**；可用信号只有 M4（≈16min）与交付物规模（5 文件 / +314−41 + 新文件 153 行）。
- **工具口径不可混用**：Trae（`DeepSeek-V4.1-Flash`）与 opencode（agnes-3.0-flash）的 M2/M3 采集机制不同，跨工具比较无效；a1/a2 必须与 b1 **同工具同模型**。
- **任务漂移**：task brief / fixture / checklist 全部冻结在本文件，前后不得改。
- **代码改动不并入**：基准只测「agent 消费文档完成该任务」，产出的 breakdown 代码是副作用，不 merge。

## 9. 下一步

1. ✅ **b1 已采（主样本 = Trae 实跑，2026-11-04，见 §7.2）**：起始提交 `ef4f9d9`，≈16min，5 文件；M2/M3/M5 = NOT COLLECTED；改动归档 `git stash: bench-b1-2026-11-04`。
2. ✅ **Trae 侧 2 次无效样本已归档（§7.3）**：流中断（零改动）/ 并发污染（`bench-invalid-concurrent-2026-11-04`）。
3. ⏭️ **opencode b2 跳过**（owner 决定）；两次尝试的实测值已归档于 §7.1 并标注无效（脏树 / 未完成）；opencode b1 降为附注，**不参与主对比**。
4. 实施 ADR-018 §6（INDEX/卡/生成物/AGENTS 瘦身/audit 排除）。
5. 在 after 文档下采 a1/a2（**同工具同模型：IDE 内 Trae + `DeepSeek-V4.1-Flash`**），跑 `bench-probe` 补 M5，填 §7 出 H1 判定。

> 主口径复现：IDE 内 Trae，模型 `DeepSeek-V4.1-Flash`，起始提交 `ef4f9d9`（干净树），prompt 逐字取 §3；
> M4 取会话起止时间；M2/M3 需 IDE 侧工具调用 / token 能力，当前为 **NOT COLLECTED**。
> 附注口径复现：`opencode run --title <bench-x> -m agnes/agnes-3.0-flash --dir <repo> "<§3 task brief>"`；
> 指标取自 `~/.local/share/opencode/opencode.db`（`session` 取 M3/M4，`part` 取 M2）。
