# ADR-018 —— 文档组织与 coding agent 工作流（D/T 双实体 + 生成物 + docs-lint）

> **状态**：已接受（2026-11-02，owner 逐项确认）
> **决策者**：owner + agent 协作裁决
> **关联**：`AGENTS.md`（文档分层规则）/ `docs/adr/README.md`（ADR 分层）/ 本文 §7 落地任务
> **范围**：本 ADR 记录「coding agent 在本仓如何高效消费文档」的**决策 + 代价 + 被否决备选**；
> 具体落地规格（front-matter schema / lint 检查项 / 目录终态 / 执行顺序）作为**附录**，
> 实现时以附录为模板，不改变 ADR 正文的决策。

---

## 1. 背景（问题）

文档按 V1 / V2 / V3 组织（每版含 Requirements / PRD / SDD / plan 四类），但 agent 实际消费时踩到四个结构性瓶颈：

| 瓶颈 | 实测证据 | 代价 |
|---|---|---|
| **版本错位** | V1 三件套无版本后缀，其计划却叫 `plan_v2`；**不存在 V2 的需求/PRD/SDD**，「v2」只是计划 | 文件名无法回答「现在该看哪套」 |
| **文档自漂移** | `AGENTS.md` 写「Wave 1-8 / T49-T94 / G1-G8」；`plan_v2` 实际 **T49-T111 / Wave 1-12 / gate 到 G12** | 两个「权威」互相矛盾，agent 必须交叉读 |
| **单文档超上下文** | `plan_v2` 247KB≈11.5 万 token、`SDD` 192KB≈8.9 万、`AGENTS` 37KB≈1.7 万（每会话自动注入） | 权威文档全套 ≈20 万 token，通读必溢出 |
| **检索单位不是任务** | `plan_v2` §5 的 65 任务全是巨型表格行（最长单行 4089 字符） | 读一个任务要读整段 Wave |
| **证据层污染** | `docs/audit/` ~40 文件（`fullstack-audit-v2` 单文件 110KB），无索引 | 搜 `G1`/`T67` 命中审计快照，被当现行结论 |

**根因**：文档是「给人读的规范」，不是「给 agent 检索的任务形状」；且事实多处复述、无单一事实源。

## 2. 决策

### D1 · 证据层默认不加载，5 触发条件才检索
`docs/archive/**` 与 `docs/audit/**` 默认**不进 agent 检索**（`opencode.jsonc` `agent.context.exclude` + `AGENTS.md` 规则）。
仅以下 5 类情形允许主动检索，且**任务卡/commit 必须写明触发原因 + 精确引用**（`audit_refs` 字段举证）：
① 修复历史 Bug；② 处理数据正确性问题；③ 检查 Gate / 验收证据；④ 调查架构历史决策；⑤ 当前任务明确引用某份审计报告。

**关键澄清（视角分离）**：「默认不加载」约束的是 **agent 检索行为**（人/agent 视角），**不是构建脚本**（机器视角）。
生成器 / `docs-lint` 可以读 `audit/`、`archive/`；agent 平时不读。二者不冲突。

### D2 · V2 冻结前先做状态核验（分层，非全量重跑）
`plan_v2`（MVP 计划）冻结前，须先核验任务真实状态。**证据分级**：代码产物 > 可执行证据（相关测试现通过）> 审计记录 > 计划勾选（勾选只能当线索，不能当结论）。
**分层**：
- **Tier A 必须实测**：未关闭任务、§13 偏差、数据正确性/安全项、V3 显式依赖的 V2 任务。
- **Tier B 只查产物存在性**：最近完成、契约被 V3 消费的任务。
- **Tier C 仅文档确认**：已有 wave audit PASS 的历史关闭任务，标「冻结时未复跑」，不阻塞。

**冻结硬前置**：`plan_v2 §13` 与 `v3-pending` 的所有**开放项**必须全部**上浮**到 backlog（机器可查 D-ID）——这是 `docs-lint`「开放决策未上浮」ERROR 归零的同一不变量。
冻结时 `plan_v2` 只加头部 `status: frozen` + `verified_at` + 指向生成物，**不改写 247KB 正文**。

### D3 · D/T 双实体，不预先给所有 T 建卡
明确区分两种实体：
- **D-ID（D-xx）**：活跃任务卡主键，代表一个**待解决的偏差 / 缺陷 / 未完成事项**。
- **T-ID（Txx）**：历史计划任务号，只做**完成状态索引、审计追溯、来源关联**。

因为 V3 的 T119~T152 基本已实施合入（见 §6 关联证据），**真正活跃的是未关闭 D 偏差**（如 D-35 P0、D-49、D-37、D-38、D-32）。
若按 T 号拆 33 张卡 = 回到过度拆分。**活跃卡集合 = 未关闭 D 偏差 + 尚未实施的 T**；其余 T 只在生成物 `INDEX` 留一行索引。

**两个例外**：
1. 一个 T 有多个独立偏差 → 拆成多个 D 卡（如 T135 → D-12、D-13）。
2. 一个 D 涉及多个 T → D 卡保留单一主键，用 `related_tasks` 关联多个 T-ID。

**D-ID 永不复用**；关闭后保留原卡与历史（`status: closed`），不回收入编号空间。

**命名空间防撞车**：`plan_v2 §9.3` 的 `D-9` 与 `v3-pending` 的 `D-9` 语义不同。用**目录命名空间**解决（`docs/tasks/v3/D-35.md`、`docs/tasks/v2/D-9.md`），lint 的「D-ID 唯一」只在**同一版本目录内**判重，不靠改号（改号会打断 audit 里几十处 D 引用）。

### D4 · 单一事实源 + 生成物，避免 status/backlog/task 三处重复
**只有两处手维护，其余全生成并 commit 进仓库**（agent 直接读，不用跑脚本）：

| 文件 | 性质 | 谁写 |
|---|---|---|
| `docs/tasks/**.md` front-matter | **手维护 · 事实源①** | 人 |
| `plan_v2 §13` + `v3-pending` D 项 | **手维护 · 事实源②** | 人 |
| `docs/status.md`（当前阶段 / 活跃卡 / 核验锚） | **生成物** | 脚本 |
| `docs/backlog.md`（开放卡 + 开放偏差，只链接不复述） | **生成物** | 脚本 |
| `docs/tasks/INDEX.md`（T 状态索引） | **生成物** | 脚本 |

backlog 每条**只链接**到 D 卡或 §13 章节，**零复述**。`docs-lint` 加「生成物与源不同步」ERROR，逼着每次改卡/改偏差后跑一次生成。

### D5 · front-matter schema（唯一事实源，字段分工锁死）
```yaml
---
id: D-35
version: v3
title: T122 写路径缺 admin 门禁
status: open            # open|in_progress|blocked|closed|superseded|wont_fix
priority: P0
owner: <人/agent>
sources: [docs/client/SDD_v3.md#§9.3]                    # 任务从哪里来（L1/L3 规格章节）
source_decision: docs/audit/v3-pending-decisions.md#D-35  # 为什么这么定（决策记录/ADR）
audit_refs: []                                              # 执行时要看哪些审计证据（证据层，默认不读）
depends_on: [docs/tasks/v3/D-29.md]                        # 硬依赖（卡路径 或 T-ID，可混）
related_tasks: [T122, T129]                                 # 软关联的 T 计划任务
last_reviewed_commit: <sha>                                  # 「来源章节变更」WARNING 的版本锚
verified_commit: <sha>                                       # 关闭/核验的版本锚
verified_date: 2026-11-02                                    # 可选，人读日历日期
gate: G4
---
```
- **三字段分工（禁止混成一个引用字段）**：`sources`=任务来源；`source_decision`=决策依据；`audit_refs`=执行时要看的审计证据。
- **一个字段不同时承担时间与版本锚点**：`verified_at` → `verified_commit`（版本锚）+ 可选 `verified_date`（日历）；`last_reviewed` 同理改名 `last_reviewed_commit`。规则统一：`*_commit` 是版本锚，`*_date` 是日历，绝不混用。
- 卡是**执行视图**，L1/L3 规格仍是权威；卡与规格冲突时以规格为准，卡里记偏差。

### D6 · docs-lint 的 warning / error 分级（不要所有文档问题都阻断 CI）
| 检查项 | 级别 |
|---|---|
| 活跃卡缺必填 front-matter（id/status/related_tasks/sources） | ERROR |
| 同目录 D-ID 重复 | ERROR |
| depends_on / related_tasks 指向不存在任务 | ERROR |
| 权威文档链接/锚点不存在 | ERROR |
| 任务卡引用已废弃规格（命中 `docs/archive`） | ERROR |
| 开放决策未上浮到 backlog（= V2 冻结硬前置） | ERROR |
| 生成物与源不同步（`--gen` 后 diff 非空） | ERROR |
| 任务卡正文 > 4KB（软上限，超则警告） | WARNING |
| 已完成任务存在历史引用 | WARNING |
| 历史文档存在失效链接 | WARNING |
| 任务卡来源章节晚于 `last_reviewed_commit` 变更 | WARNING |

**CI 策略**：`docs-lint` 作**独立 job，先「报不阻断」（报告 + WARNING/ERROR 全量展示），跑稳 1-2 周再翻成阻断**——避免文档门禁误伤代码 PR。
**触发方式**：`npm run docs:gen` 手动跑 + 提交前跑一次（与「提交前跑全量测试」同节奏），CI `--check` 兜底；**不装 pre-commit / husky**。

### D7 · AGENTS.md 37KB → ~10KB，细节迁出
保留「违反即出事」的硬约束摘要 + 指针；分层规则细节、CI 三陷阱、测试分层表、Wave 验收说明、DDL 判据细节、行情库三档等迁到 `docs/runbooks/agent-playbook.md`。
新增到 AGENTS 顶部的「入口」：文档路由 + audit 5 触发规则 + D/T 双实体说明（指向本 ADR）。

### D8 · 版本命名暂不重命名，靠 INDEX 路由
`docs/INDEX.md` 明确「V1 规格 + plan_v2 = MVP 阶段；V3 = 当前增量」。重命名单独做，避免大面积断链。

## 3. 后果 / 代价

### 正面
- **设计目标（未实测）**：单任务上下文从 ~10 万 token 降到 1-3 千 token（读卡而非读整份 plan）；
  AGENTS 每会话固定成本按体积比例从 ≈1.7 万 token 降到 ≈0.7 万 token。
  ⚠️ 这两条是**预期收益，不是测量结论**：M2（读取文件数）/ M3（输入 token）在 Trae 侧本地不可采，
  已实测的只有 M1（AGENTS 体积 37,858B → 16,545B，−56.3%）与 M4（耗时，未证实下降）。
  实测口径与局限见 `docs/audit/doc-optimization-report-2026-11-04.md` §3/§6。
- 「该看哪个版本 / 哪节」由 `INDEX` + 卡 front-matter 一次查清；证据层与事实源分离，假结论风险下降。
- D-ID 不复用 + 目录命名空间 → 审计可追溯、无撞号。

### 负面 / 代价
- 引入一套**生成物 + 生成器 + lint** 的维护成本（`scripts/docs-lint.mjs`，零依赖）。
- 「开放决策未上浮」把 V2 冻结强耦合到 backlog 生成，冻结流程变重。
- 生成物 commit 进仓库，需 discipline 每次改卡后跑 `docs:gen`，否则「不同步」ERROR。

## 4. 被否决的备选方案

| 备选 | 否决理由 |
|---|---|
| **按 T 号给 V3 全部 33 任务建卡** | 过度拆分；V3 T 任务基本已 done，真正活跃的是 D 偏差；建 33 张卡会把「已完成」也复制一遍 |
| **status / backlog / task 三处各自手维护** | 同一事实三处 → 漂移；改生成物后三处更易不一致。改「两事实源 + 生成物」 |
| **改 D-ID / 重命名 V1/V2/V3 文件名** | 打断 audit 里几十处引用；代价 > 收益。改用目录命名空间 + INDEX 路由 |
| **docs-lint 一上线就阻断 CI** | 文档门禁误伤代码 PR 的风险高；先报不阻断，跑稳再翻 |
| **装 pre-commit / husky 强制 docs:gen** | 仓库无此基建；手动 + CI `--check` 兜足，降低工具链复杂度 |
| **保留 audit/archive 可自由检索** | 5 触发规则失效；证据层污染假结论。默认排除 + 例外条款 |
| **`verified_at` 一个字段同时当时间+版本锚** | 语义含糊，lint 无法机读。拆 `verified_commit` + 可选 `verified_date` |
| **sources / source_decision / audit_refs 混成一个引用字段** | 三者用途不同（来源/依据/证据）；混字段后无法分别校验与 5 触发举证 |

## 5. 目录终态

```
docs/
  INDEX.md            # 入口：版本清单 + 任务类型阅读路径 + audit 5 触发 + D/T 说明
  status.md           # 生成物
  backlog.md          # 生成物
  tasks/
    v3/  D-35.md ...  INDEX.md(生成)
    v2/  D-9.md ...   INDEX.md(生成)
  runbooks/agent-playbook.md   # AGENTS 迁出的细节
  audit/README.md     # 证据索引，默认不读
  archive/README.md   # 历史索引，默认不读
scripts/docs-lint.mjs             # --gen / --check
```

## 6. 落地任务（执行顺序，本文附录为模板）

1. **V3 活跃 D 卡**（D-35/D-49/D-37/D-38/D-32 等未关闭项，含 `depends_on`/`related_tasks` 交叉）
2. **`scripts/docs-lint.mjs`**（`--gen` 生成 status/backlog/INDEX，`--check` 校验）+ `npm run docs:gen`
3. **`docs/INDEX.md`** + **`docs/runbooks/agent-playbook.md`**（AGENTS 迁出项）
4. **AGENTS.md 37KB→~10KB** 瘦身 + 写进文档路由 / 5 触发 / D-T 双实体
5. **`opencode.jsonc`** 排除 `docs/audit/**`、`docs/archive/**`；`docs-lint` 独立 CI job（先报不阻断）
6. **V2 `plan_v2 §13` 开放项上浮 + D-ID 目录化（v2/）+ `plan_v2` 打 `frozen` 头**（冻结硬前置 = 「未上浮」项归零）

> 每个 D 卡 / 每步各一条 commit，沿用「一个 D 一条 commit」铁律。

## 7. 关联证据

- 各文档体积与 token 粗估：`plan_v2` 247KB、`SDD` 192KB、`AGENTS.md` 37KB、`v3-pending` 21.8KB（2026-11-02 实测）
- V3 T 任务已实施：`docs/audit/v3-1..v3-8-audit.md`、git log `#47`（T138/T140/T141）、`#52/#53`（T142-T150）、`#55`（T151）、`#69`（T152）
- 开放 D 偏差来源：`docs/audit/v3-pending-decisions.md`（D-35 P0、D-49、D-37、D-38、D-32 等）
- 现有任务卡雏形（本方案推广的形态）：`docs/audit/wave-3-task-cards.md`、`wave-7-task-cards.md`、`plan_v3 §3`
- 撞号先例（目录命名空间的动因）：`ADR-017`（v2/v3 T 号撞号 → 顺延 T119~）
