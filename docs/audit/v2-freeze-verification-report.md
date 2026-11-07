---
report_id: R-V2FREEZE-1
version: v2
title: V2 冻结前状态核验记录（Tier C 全量）
status: partial
verified_commit: b07eca1
verified_date: 2026-11-04
audit_refs:
  - docs/audit/wave-1-audit.md
  - docs/audit/wave-2-audit.md
  - docs/audit/wave-3-audit.md
  - docs/audit/wave-4-audit.md
  - docs/audit/wave-5-audit.md
  - docs/audit/wave-6-audit.md
  - docs/audit/wave-7-audit.md
  - docs/audit/wave-8-audit.md
  - docs/audit/wave-9-audit.md
  - docs/audit/wave-10-audit.md
  - docs/audit/wave-11-audit.md
seed: none（Tier C 全量，未抽样）
---

# V2 冻结前状态核验记录（R-V2FREEZE-1）

> **性质**：核验记录（`docs/audit/` 证据层）。判据与流程见 [`d2-v2-freeze-verification-plan.md`](./d2-v2-freeze-verification-plan.md)（下称「方案」）。
> **本轮范围**：**仅 Tier C 全量**（方案 §2.2 ⑦：已 `✅ 完成` 且所属 Wave 有 `wave-N-audit.md` 判定 PASS 的历史任务）。**Tier A / Tier B 未开跑**。
> **`status: partial` 的含义**：本记录只覆盖 67 个唯一任务标签中的 58 个（Tier C 对象池），不等于 V2 冻结核验完成。
> **红线遵守**：未改 `plan_v2` 任何内容（未打 `frozen` 头、未改 §13、未建 `docs/tasks/v2/`）、未改业务代码与测试、未跑任何测试、未提交、未推送。

---

## 0. 结论先行

1. **Tier C 对象池 = 58 个唯一任务标签**（= 全部 `✅ 完成` 的任务；68 个表行去掉 9 个未关闭 + T110 的重复行口径见 §1）。
2. **判定分布（本轮累计）：PASS 58（Tier C 57 + Tier B 1）/ FAIL 0 / NOT VERIFIABLE 0**；另有 9 条（T67–T74、T111）属 Tier A/B 未实测。
3. **T110 已在 Tier B 补核，判 PASS（产物存在性）**：Wave 12 **无** `wave-12-audit.md`（`Test-Path` = False）⇒ 按方案 C-1「T 号不在覆盖范围 → 降级 Tier B」；本轮按产物核：提交 **`19fa6f9`** 是 `main` 祖先、`AdminLogPanel.tsx` 实现与计划描述逐字对应、单测文件存在 ⇒ **PASS（仅产物存在性；验收「46 文件全绿」未复跑）**。**未新建 `wave-12-audit.md`**。
4. **T67–T74 已分案（§8）：A 6 / C 2 / B 0 / D 0**。判 A 的 6 条均为「实现已合并且 Wave 审计 PASS」，判 C 的 2 条为「审计 PASS 但带已登记的能力缺口 / 验收缺口」。分案**不是实测**，这 8 条仍属 Tier A 未完成。
5. **57 条 Tier C PASS 的效力是「文档确认 PASS（冻结时未复跑）」**，最高证据等级 = **审计记录**，未升级为「代码产物 / 可执行证据」。**不得把本表读成「已验证」**（方案 §2.1 R2）。
6. **本轮发现的主要漂移**（详见 §6）：`plan_v2` §5 状态列把 T67–T74 仍标 `⬜`，而 §6 与 wave-3/4/5/6 审计均判 PASS；T77 / T89b / T60b / T60c 的 Wave 归属在 §5 与 §6+审计之间冲突；`plan_v2` 的任务总数 65 / 63 / 68 三处不一致。
7. **G1 六条 🔒 已核验完毕（§10）**：按 7 个可核单元执行，**全部 PUBLISH（7/7，FAIL 0 / NV 0）**。2026-11-04 按 owner 决定把 G1.3a 判据从 `success === total` 修订为四态口径（`success + skip === total` / `timeout = 0` / `error = 0` / `inserted > 0`），并新增断言用例锁定；G1.6 的脚本假阳性同步修复。**V2 具备冻结条件，只差 D7 的 `frozen` 头未打。**

---

## 1. 对象池与统计口径

### 1.1 从 67 个唯一标签切出 Tier C

| 步骤 | 数量 | 依据 |
|---|---|---|
| `plan_v2` §5 任务表行（L225–L427） | **68 行** | 方案 §3.2 的 `^\|` + `$c.Count -ge 4` 计数命令（实测 `rows=68`） |
| 去重后唯一任务标签 | **67** | `T80` 在 L251 / L263 各一行（`unique=67`，重复组 `T80x2`）；`T60c` 是独立变体号（不折入 T60） |
| 非 `✅` 状态（不进 Tier C） | **9** | T67 L311、T68 L319、T69 L320、T70 L328、T71 L329、T72 L330、T73 L338、T74 L339（`⬜`）；T111 L423（`🟡`）→ 属 Tier A/B |
| `✅ 完成` | **58** | 67 − 9 |
| 其中所属 Wave **有审计且 PASS** | **57** | Wave 1/2/5/7/8/9/10/11 |
| 其中所属 Wave **无审计**（T110，Wave 12） | **1** | `docs/audit/wave-12-audit.md` 不存在 → 降级 Tier B；本轮已按**产物存在性**判 PASS（§3.8） |

> **与方案 §3.1 的对齐**：§3.1 登记「68 个唯一任务号」为 D1 权威口径，但严格按表行解析实测是 **68 行 / 67 标签**（差异原因 = T80 一号两行 + 旧计数脚本误把 L272 注记行算作任务行）。本记录以 **67** 为分母、**68** 为行数，两者都在 §5 统计中显式列出，**不掩盖 D1 的表述偏差**（另见 §6 第 6 条）。

### 1.2 复现命令（只读，实际执行）

```powershell
# R1 任务行/唯一标签计数（实测 rows=68, unique=67）
$f='docs\client\code_implementation_plan_v2.md'
$labels=@(); $i=0
Get-Content $f | ForEach-Object {
  $i++
  if($i -ge 225 -and $i -le 427 -and $_ -match '^\|'){
    $c=$_ -split '\|'
    if($c.Count -ge 4 -and $c[1] -match 'T\d+[ab]?c?'){ $labels += (($c[1] -replace '[^\w]','')) }
  }
}
"rows=$($labels.Count)"; "unique=$(($labels | Sort-Object -Unique).Count)"
($labels | Group-Object | Where-Object Count -gt 1 | ForEach-Object { "$($_.Name)x$($_.Count)" }) -join ','

# R2 某 Wave 审计的 T 提及（逐条核对的替代实现，本记录用等价的只读脚本扫描）
Select-String -Path docs\audit\wave-7-audit.md -Pattern 'T\d+' -AllMatches

# R3 某 Wave 审计的判定行
Select-String -Path docs\audit\wave-9-audit.md -Pattern 'G9\s*=|PASS'

# R4 Wave 12 审计是否存在
Test-Path docs\audit\wave-12-audit.md   # 实测 False
```

> 本记录的实际执行方式：Node 只读脚本（`fs.readFileSync` + 正则）扫描 `plan_v2` 与 `wave-1..11`，再用上列 PowerShell 复核关键数字；**未运行任何测试、未打开 SQLite、未写 DuckDB**。

---

## 2. Wave 级判定依据

| Wave | 审计文件 | 范围声明（行号） | 判定（行号） | 本波覆盖的 Tier C 条目数 |
|---|---|---|---|---|
| 1 | `wave-1-audit.md` | L3「Wave 1（数据与规则纠偏）」（**未逐条列 T 号**） | **L15：✅ PASS（9/9 条全过，0 COND，0 豁免）** | 29 |
| 2 | `wave-2-audit.md` | L5「T61-T66 + T86 + T95 + T98」 | **L18–L23：G2.1–G2.6 全 PASS（6/6）** | 9 |
| 3 | `wave-3-audit.md` | L5「T67」 | L17–L21 各门槛 PASS（G3 5/6，G3.5b 前移 G7） | 0（T67 仍 `⬜`） |
| 4 | `wave-4-audit.md` | L5「T68 + T69 + T87b」 | L17–L21 各门槛 PASS（G4 6/6） | 0（T68/T69 仍 `⬜`） |
| 5 | `wave-5-audit.md` | L5–L6「T70 + T71 + T72 + **T60b** + **T60c**」 | L17–L21 各门槛 PASS（G5 6/6） | 2（T60b、T60c） |
| 6 | `wave-6-audit.md` | L5「T73 + T74 + PE2 + CI」 | L16–L21 各门槛 PASS（G6 6/6） | 0（T73/T74 仍 `⬜`） |
| 7 | `wave-7-audit.md` | L5「T75 + T76」 | **L16–L22：G7.1–G7.7 全 PASS（7/7）** | 2 |
| 8 | `wave-8-audit.md` | L5「**T89b** + **T86b** + **T77** + **T78**」 | **L21–L23：G8.1–G8.3 全 PASS**；但 §12.6 全局判定 ⚠️ COND（L11） | 4 |
| 9 | `wave-9-audit.md` | L5「T99 + T100 + T102」 | **L17–L24 八条 PASS；L29 明写「G9 = PASS…0 COND」** | 3 |
| 10 | `wave-10-audit.md` | L5「T103 + **T79 ②~⑥**」 | **L17–L21：G10.1–G10.5 全 PASS（5/5）** | 2 |
| 11 | `wave-11-audit.md` | L5「T104 + T105 + T106 + T107 + T108 + T109」 | **L17–L23：G11.1–G11.7 全 PASS（7/7）** | 6 |
| 12 | **不存在**（`Test-Path` = False） | — | — | 0（T110 已按 Tier B 产物核验判 PASS，见 §3.8） |
| **合计** | | | | **57** |

> **Wave 1 的特别说明**：该审计**没有逐条点名 T 号**，只给「Wave 1」整体判定（L15）。因此 Wave 1 条目只能到「Wave 级 PASS + `plan_v2` L434 的任务清单」这一级证据，**不能再往上**（方案 §2.1 的「最低证据 = 审计记录」）。

---

## 3. 逐条记录（58 条）

> 判定列统一为 `PASS（文档确认，冻结时未复跑）`；`commit` 列对 Tier C 一律 `—`（Tier C 不要求提交级证据）。
> 「点名」= 该审计文件正文是否出现该 T 号；`未点名` 者仅有 Wave 级判定 + 计划清单支撑（属正常，但证据强度更低）。

### 3.1 Wave 1（31 条：29 条由 `wave-1-audit.md` 覆盖 + 2 条由 `wave-5-audit.md` 覆盖）

| 对象 | §5 行 | 判定 | 最高证据 | 证据位置 | 点名 | 备注 |
|---|---|---|---|---|---|---|
| T49 | L250 | PASS（文档确认，未复跑） | 审计记录 | `wave-1-audit.md L15`；点名 L27 | 是 | — |
| T80 | L251（另 L263） | PASS（文档确认，未复跑） | 审计记录 | `wave-1-audit.md L15`；`plan_v2 L434` | 否 | **一号两行**（L251 / L263 不同交付物），本表按标签合并 |
| T81 | L252 | PASS（文档确认，未复跑） | 审计记录 | `wave-1-audit.md L15`；点名 L74 | 是 | — |
| T50 | L253 | PASS（文档确认，未复跑） | 审计记录 | `wave-1-audit.md L15`；点名 L76 | 是 | — |
| T51 | L254 | PASS（文档确认，未复跑） | 审计记录 | `wave-1-audit.md L15`；点名 L36 | 是 | — |
| T52 | L255 | PASS（文档确认，未复跑） | 审计记录 | `wave-1-audit.md L15`；点名 L36 | 是 | — |
| T53 | L256 | PASS（文档确认，未复跑） | 审计记录 | `wave-1-audit.md L15`；点名 L72 | 是 | — |
| T54 | L257 | PASS（文档确认，未复跑） | 审计记录 | `wave-1-audit.md L15`；`plan_v2 L434` | 否 | 审计未点名 |
| T55 | L258 | PASS（文档确认，未复跑） | 审计记录 | `wave-1-audit.md L15`；点名 L72 | 是 | — |
| T56 | L259 | PASS（文档确认，未复跑） | 审计记录 | `wave-1-audit.md L15`；点名 L76 | 是 | — |
| T57 | L260 | PASS（文档确认，未复跑） | 审计记录 | `wave-1-audit.md L15`；点名 L72 | 是 | — |
| T58 | L261 | PASS（文档确认，未复跑） | 审计记录 | `wave-1-audit.md L15`；`plan_v2 L434` | 否 | 审计未点名 |
| T59 | L262 | PASS（文档确认，未复跑） | 审计记录 | `wave-1-audit.md L15`；`plan_v2 L434` | 否 | 审计未点名 |
| T82 | L264 | PASS（文档确认，未复跑） | 审计记录 | `wave-1-audit.md L15`；`plan_v2 L434` | 否 | 审计未点名 |
| T83 | L265 | PASS（文档确认，未复跑） | 审计记录 | `wave-1-audit.md L15`；`plan_v2 L434` | 否 | 审计未点名 |
| T84 | L266 | PASS（文档确认，未复跑） | 审计记录 | `wave-1-audit.md L15`；点名 L27 | 是 | — |
| T60 | L267 | PASS（文档确认，未复跑） | 审计记录 | `wave-1-audit.md L15`；点名 L164 | 是 | ③ 由 t53/t55/t52 等覆盖，属间接验收 |
| T85 | L273 | PASS（文档确认，未复跑） | 审计记录 | `wave-1-audit.md L15`；点名 L28 | 是 | — |
| T85b | L274 | PASS（文档确认，未复跑） | 审计记录 | `wave-1-audit.md L15`；点名 L29 | 是 | — |
| T97 | L275 | PASS（文档确认，未复跑） | 审计记录 | `wave-1-audit.md L15`；`plan_v2 L434` | 否 | 审计未点名 |
| T87 | L276 | PASS（文档确认，未复跑） | 审计记录 | `wave-1-audit.md L15`；点名 L27 | 是 | — |
| T88 | L277 | PASS（文档确认，未复跑） | 审计记录 | `wave-1-audit.md L15`；`plan_v2 L434` | 否 | 审计未点名 |
| T89a | L278 | PASS（文档确认，未复跑） | 审计记录 | `wave-1-audit.md L15`；`plan_v2 L434` | 否 | 审计未点名 |
| T90 | L280 | PASS（文档确认，未复跑） | 审计记录 | `wave-1-audit.md L15`；`plan_v2 L434` | 否 | 审计未点名 |
| T91 | L281 | PASS（文档确认，未复跑） | 审计记录 | `wave-1-audit.md L15`；点名 L37 | 是 | — |
| T92 | L282 | PASS（文档确认，未复跑） | 审计记录 | `wave-1-audit.md L15`；点名 L76 | 是 | — |
| T93 | L283 | PASS（文档确认，未复跑） | 审计记录 | `wave-1-audit.md L15`；`plan_v2 L434` | 否 | 审计未点名 |
| T96 | L284 | PASS（文档确认，未复跑） | 审计记录 | `wave-1-audit.md L15`；`plan_v2 L434` | 否 | 审计未点名 |
| T94 | L285 | PASS（文档确认，未复跑） | 审计记录 | `wave-1-audit.md L15`；点名 L72 | 是 | — |
| T60b | L269 | PASS（文档确认，未复跑） | 审计记录 | `wave-5-audit.md L6`（范围）；`L17–L21`（G5 PASS） | 是 | **§5 归 Wave 1，审计在 Wave 5 声明** |
| T60c | L270 | PASS（文档确认，未复跑） | 审计记录 | `wave-5-audit.md L6`（范围）；`L17–L21`（G5 PASS） | 是 | 同上；且本行不含尾管道，旧计数易漏 |

### 3.2 Wave 2（9 条，覆盖审计 = `wave-2-audit.md`）

| 对象 | §5 行 | 判定 | 最高证据 | 证据位置 | 点名 | 备注 |
|---|---|---|---|---|---|---|
| T61 | L295 | PASS（文档确认，未复跑） | 审计记录 | `wave-2-audit.md L5`；判定 L18–L23 | 是 | — |
| T62 | L296 | PASS（文档确认，未复跑） | 审计记录 | `wave-2-audit.md L5`；判定 L18–L23 | 是 | — |
| T63 | L297 | PASS（文档确认，未复跑） | 审计记录 | `wave-2-audit.md L5`；判定 L18–L23 | 是 | — |
| T95 | L298 | PASS（文档确认，未复跑） | 审计记录 | `wave-2-audit.md L5`；判定 L18–L23 | 是 | — |
| T98 | L299 | PASS（文档确认，未复跑） | 审计记录 | `wave-2-audit.md L5`；判定 L18–L23 | 是 | — |
| T64 | L300 | PASS（文档确认，未复跑） | 审计记录 | `wave-2-audit.md L5`；判定 L18–L23 | 是 | — |
| T65 | L301 | PASS（文档确认，未复跑） | 审计记录 | `wave-2-audit.md L5`；判定 L18–L23 | 是 | 亦被 `wave-5-audit.md` 引用 |
| T66 | L302 | PASS（文档确认，未复跑） | 审计记录 | `wave-2-audit.md L5`；判定 L18–L23 | 是 | — |
| T86 | L303 | PASS（文档确认，未复跑） | 审计记录 | `wave-2-audit.md L5`；判定 L18–L23 | 是 | — |

### 3.3 Wave 7（2 条，覆盖审计 = `wave-7-audit.md`）

| 对象 | §5 行 | 判定 | 最高证据 | 证据位置 | 点名 | 备注 |
|---|---|---|---|---|---|---|
| T75 | L347 | PASS（文档确认，未复跑） | 审计记录 | `wave-7-audit.md L5`；判定 L16–L22（G7 7/7） | 是 | — |
| T76 | L348 | PASS（文档确认，未复跑） | 审计记录 | `wave-7-audit.md L5`；判定 L16–L22 | 是 | — |

### 3.4 Wave 8（4 条，覆盖审计 = `wave-8-audit.md`）

| 对象 | §5 行 | 判定 | 最高证据 | 证据位置 | 点名 | 备注 |
|---|---|---|---|---|---|---|
| T77 | L349（§5 在 Wave 7 节） | PASS（文档确认，未复跑） | 审计记录 | `wave-8-audit.md L5`（范围）；判定 L21–L23 | 是 | **§5 归 W7、§6 L441 与审计归 W8**；`wave-7-audit.md L5` 不含 T77 |
| T89b | L279（§5 在 Wave 1 节） | PASS（文档确认，未复跑） | 审计记录 | `wave-8-audit.md L5`（范围）；判定 L21–L23 | 是 | **§5 归 W1、§6 L441 与审计归 W8** |
| T86b | L357 | PASS（文档确认，未复跑） | 审计记录 | `wave-8-audit.md L5`；判定 L21–L23 | 是 | G8 PASS，但 §12.6 全局 ⚠️ COND（`wave-8-audit.md L11`） |
| T78 | L358 | PASS（文档确认，未复跑） | 审计记录 | `wave-8-audit.md L5`；判定 L21–L23 | 是 | G8.3 附 1 项残留（PE4 并发档 = `D-4`/`I-28`） |

### 3.5 Wave 9（3 条，覆盖审计 = `wave-9-audit.md`）

| 对象 | §5 行 | 判定 | 最高证据 | 证据位置 | 点名 | 备注 |
|---|---|---|---|---|---|---|
| T99 | L371 | PASS（文档确认，未复跑） | 审计记录 | `wave-9-audit.md L5`；判定 L17–L24、L29 | 是 | Wave 9 遗留「备份覆盖面未补」见 `plan_v2 L452` |
| T100 | L372 | PASS（文档确认，未复跑） | 审计记录 | `wave-9-audit.md L5`；判定 L17–L24、L29 | 是 | 同上 |
| T102 | L373 | PASS（文档确认，未复跑） | 审计记录 | `wave-9-audit.md L5`；判定 L17–L24、L29 | 是 | 遗留「反向验证为手工 gate」，`plan_v2 L452` 明示**不得视为已关闭** |

### 3.6 Wave 10（2 条，覆盖审计 = `wave-10-audit.md`）

| 对象 | §5 行 | 判定 | 最高证据 | 证据位置 | 点名 | 备注 |
|---|---|---|---|---|---|---|
| T103 | L393 | PASS（文档确认，未复跑） | 审计记录 | `wave-10-audit.md L5`；判定 L17–L21（G10 5/5） | 是 | — |
| T79 | L394 | PASS（文档确认，未复跑） | 审计记录 | `wave-10-audit.md L5`（**仅 ②~⑥**）；判定 L17–L21 | 是 | ① 已随 T69/T73/T75 交付，**不在本轮审计范围** |

### 3.7 Wave 11（6 条，覆盖审计 = `wave-11-audit.md`）

| 对象 | §5 行 | 判定 | 最高证据 | 证据位置 | 点名 | 备注 |
|---|---|---|---|---|---|---|
| T104 | L407 | PASS（文档确认，未复跑） | 审计记录 | `wave-11-audit.md L5`；判定 L17–L23（G11 7/7） | 是 | — |
| T105 | L408 | PASS（文档确认，未复跑） | 审计记录 | `wave-11-audit.md L5`；判定 L17–L23 | 是 | — |
| T106 | L409 | PASS（文档确认，未复跑） | 审计记录 | `wave-11-audit.md L5`；判定 L17–L23 | 是 | — |
| T107 | L410 | PASS（文档确认，未复跑） | 审计记录 | `wave-11-audit.md L5`；判定 L17–L23 | 是 | — |
| T108 | L411 | PASS（文档确认，未复跑） | 审计记录 | `wave-11-audit.md L5`；判定 L17–L23 | 是 | — |
| T109 | L412 | PASS（文档确认，未复跑） | 审计记录 | `wave-11-audit.md L5`；判定 L17–L23 | 是 | — |

### 3.8 Wave 12（1 条，无审计 → Tier B 产物核验）

| 对象 | §5 行 | 判定 | 最高证据 | 证据位置 | 点名 | 备注 |
|---|---|---|---|---|---|---|
| T110 | L422 | **PASS（Tier B·产物存在性）** | 代码产物 + 版本锚（提交） | 提交 `19fa6f9`（`main` 祖先 = True，2026-10-24，PR #38，仅改 `AdminLogPanel.tsx` +8/−3）；`AdminLogPanel.tsx L102`（`{ key:'created_at', label:'时间' }`）、`L113–L115`（`log_date?` / `created_at?` 类型）、`L154–L156`（`created_at` 缺失回退 `log_date`）、`L405`（渲染 `textOf(row,'created_at')`）；单测 `apps/frontend/tests/unit/admin-log-panel.test.tsx` 存在（313 行 / 10 个 `it|test`） | 无 | **审计文件缺失**：本判定**不依赖也不会伪造** `wave-12-audit.md`；验收条「admin-log-panel 46 文件全绿」**未复跑**，故本判定只到「产物存在且与计划描述一致」 |

> **T110 证据链的两个纠正**：
> 1. **T110 的提交不是 `c1724ee`** —— `c1724ee` 是 **T111**（「前端显示数据库中最新行情日期」，改 `dataCheck.ts` / `routes/index.ts` / `Admin.tsx` / `Dashboard.tsx`）。T110 的真实提交是 **`19fa6f9`**（`feat(admin): 系统日志显示日期+时间（created_at） (#38)`），与 `plan_v2 L422` 的「✅ 完成（PR #38）」一致。
> 2. `plan_v2 L445` 仍把 Wave 12 标为「🟡 本 PR」，但 T110 已合入 `main`（`19fa6f9`），该行状态过期。
>
> **待办建议（交 owner）**：Wave 12 缺验收落档（无 `wave-12-audit.md`）。补审计 / 改为「Tier B 产物核验 + 明确豁免审计」二选一，**不在本轮自行补齐**。

---

## 4. 统计与对齐

| 项 | 数量 | 说明 |
|---|---|---|
| Tier C 对象（唯一标签） | **58** | 见 §1.1 |
| **PASS（Tier C·文档确认，冻结时未复跑）** | **57** | 最高证据 = 审计记录 |
| **PASS（Tier B·产物存在性）** | **1** | T110（§3.8） |
| **FAIL** | **0** | 本轮未发现「审计缺失 / 判定非 PASS / T 号越界 / 产物缺失」 |
| **NOT VERIFIABLE** | **0** | T110 已由 Tier B 补核；无遗留 NV |
| 本轮未覆盖（Tier A 未实测） | **9** | T67–T74（8 个 `⬜`，已分案见 §8）+ T111（`🟡`） |
| **合计** | **67** | 57 + 1 + 0 + 0 + 9 = 67 ✔（与 §1.1 的唯一标签数一致） |

**与方案 §3.1 的对齐**：

- §3.1 的「68」= **表行数**；本记录用 **67** 作唯一标签分母，**68 行**在 §1.1 显式保留，不存在「用 68 当分母导致覆盖率虚高」的问题。
- §3.1 的「未关闭 9 条」与「§13 开放偏差 17 条」「数据正确性项 6 条」「V3 显式依赖 2 个」**均不在 Tier C 范围**（方案 §2.2 互斥规则：满足 Tier A 条件者一律进 A），故本记录**不以这 28 项作 PASS 分母**，也不声称它们已核。
- 因此 **Tier C 本身不能**回答「V2 能否冻结」——它只覆盖 57/67 个任务标签的文档确认（Tier A/B 未跑）；冻结所需的 G1 六条 🔒 已在 §10 单独实测，结论见 §10.5。

---

## 5. 本轮明确没做的事（边界）

1. **未跑任何测试**（无 `vitest`、无 `npm test`），因此**没有任何一条结论达到「可执行证据」等级**。
2. **提交级证据的边界**：本轮只对 **T110 与 T67–T74**（共 9 条）执行了 `git merge-base --is-ancestor <commit> main` 与 `git show --stat`；**其余 53 条 Tier C 未做提交祖先判定**，§3 的 `commit` 列仍一律 `—`（Tier C 不要求提交级证据）。
3. **未改** `plan_v2` / 业务代码 / 测试 / 生成物；**未建** `docs/tasks/v2/`；**未提交 / 未推送**。
4. **未打开 SQLite**；DuckDB 仅做 1 次 `READ_ONLY` 探针（`SELECT version()` + `information_schema` 计数），立即 `closeSync()`，无写、无长持锁。

---

## 6. 实质发现（按严重度）

| # | 严重度 | 发现 | 证据 | 影响 |
|---|---|---|---|---|
| 1 | **高** | `plan_v2` §5 把 T67–T74 标 `⬜ 待启动`，但同文档 §6 判 Wave 3–6 完成、`wave-3/4/5/6-audit.md` 均 PASS，`main` 上也有实现提交 | `plan_v2 L311/L319/L320/L328–L330/L338/L339` vs `L436–L439`；§8 分案表 | 冻结时**不能把 §5 状态列当证据**。**本轮已分案**（§8）：A 6 / C 2 / B 0 / D 0 —— 6 条属「实现已合并且审计 PASS、仅 §5 漏回填」，2 条属「有产物但带已登记缺口」 |
| 2 | 中 | **Wave 归属三处冲突**：T77（§5 W7 / §6+审计 W8）、T89b（§5 W1 / §6+审计 W8）、T60b/T60c（§5 W1 / 审计 W5） | §3.1 的「点名」列与 §3.4 备注 | 不影响本轮判定（相关 Wave 均 PASS），但会让「按 Wave 统计覆盖率」口径漂移 |
| 3 | 中 | **Wave 12 无审计文件** | `Test-Path` = False；`docs/audit/` 只有 `wave-1..11` | T110 已降级 **Tier B 产物核验并判 PASS**（§3.8），**未伪造审计**；Wave 12 整体仍无验收落档，是否补审计**由 owner 决定** |
| 4 | 中 | Wave 8 的 G8 虽 PASS，但 §12.6 **全局判定 ⚠️ COND**，且 G8.3 附 1 项残留（PE4 并发档 → `D-4` / `I-28`） | `wave-8-audit.md L11`、L23 | T77/T78/T86b 的 PASS 仅到「G8 门槛」，不等于全局无偏差 |
| 5 | 中 | Wave 9 两项遗留**未关闭**（备份覆盖面未补 / T102 反向验证为手工 gate） | `plan_v2 L452`；§6 L442 | T99/T100/T102 的 PASS 需附此保留 |
| 6 | 低 | 任务总数 **65 / 63 / 68** 三处不一致；且「68 唯一」实为 **68 行 / 67 标签** | `plan_v2 L225`（65）、`L446`（63）；方案 §3.2 | D1 表述需修正为「68 行（67 唯一标签）」，否则覆盖率分母用错 |
| 7 | 低 | **13 个 T 未被任何 Wave 审计点名**（W1 为主：T54/T58/T59/T80/T82/T83/T97/T88/T89a/T90/T93/T96 + T60 的间接覆盖） | §3.1 点名列 | 这些条目只有 Wave 级判定，证据强度最低，冻结后若需追溯须回 Tier A/B |
| 8 | 低 | `wave-4-audit.md L5` 范围含 **T87b**，但 `plan_v2` §5 **无 T87b 行** | `wave-4-audit.md L5`；§5 无对应行 | 存在「计划外增补任务」未登记，任务表非全集 |
| 9 | 低 | T79 的审计只覆盖 ②~⑥，① 随其他波交付 | `wave-10-audit.md L5`；`plan_v2 L443` | 单号跨波交付，按单号统计会重复计数 |

---

## 7. 下一步建议（Tier B / Tier A 是否可开跑）

### Tier B —— 本轮已结（1/1）

- **T110 已按产物存在性判 PASS**（§3.8），Tier B 本轮**无剩余对象**。
- 遗留决策（交 owner）：Wave 12 是否补 `docs/audit/wave-12-audit.md`。**本轮不补、不伪造**。
- Tier B 其余候选（Wave 9–12 新增、被 V3 消费的契约）本轮**未枚举**，开跑前需先冻结名单（方案 §4.3）。

### Tier A —— 仍不具备开跑条件，但范围已收敛

1. **判据已落地**：`plan_v2 L243` 的「6 条 🔒」已逐条点名，见 §9（4 个 🔒 门槛 → 6 个核验单元）。
2. **测试执行许可仍缺**：§9 的 6 条里 **3 条需跑测试 / 读 SQLite**（G1.1-a、G1.3、G1.6），本轮**未执行任何一条**。Tier A 需要定向 `npx vitest run <file>`、信号流水线实跑、以及 SQLite 只读查询的授权。
3. **T67–T74 分案已完成**（§8）：A 6 / C 2 / B 0 / D 0。分案只回答「属于哪一类」，**不等于实测**；若要升级为「可执行证据」，A 的 6 条仍需跑对应前端测试文件。

> **建议顺序**：先做 §9 的 **3 条静态可核**（零风险、纯读代码）→ 再申请授权跑 **3 条需实测项**（G1.3 涉及 DuckDB + 插件引擎，建议单独隔离跑，避免污染全量套件）→ 最后决定 T67–T74 的 6 条 A 是否补跑测试。

---

## 8. T67–T74 分案（8 条逐条）

> **判 A 的三件套**：① 实现提交在 `main`（`git merge-base --is-ancestor`）；② 代码与测试载体存在；③ 对应 Wave 审计判 PASS **且无针对该任务验收项的未关闭缺口**。
> **缺任一 → C**；无产物 → B；§5 与 §6/审计挂在不同 Wave → D。
> ⚠️ 本表**不是实测**，只做归类；同一份证据不能同时证明「交付完成」与「验收达标」。

| T 号 | §5 行号与状态 | §6 判定 | 代码与测试证据 | 审计证据 | 归类 | 一句话理由 |
|---|---|---|---|---|---|---|
| **T67** | L311 `⬜ 待启动` | L436 `✅ 完成（G3 PASS）` | 提交 `d0b86d0`（main 祖先 = True）；`Dashboard.tsx`（1026 行改动）、`PositionCard.tsx`(278)、`WeightBar.tsx`(96)、`PositionToolbar.tsx`(164)、`TodayActivityCard.tsx`(890)、`TradeFormModal.tsx`(564)、`KlineMiniChart.tsx`(247)、`SignalMiniMenu.tsx`(488)；测试 `dashboard-cards.test.tsx`(784)、`dashboard-fd1-fd6.test.tsx`(469)、`dashboard-wiring.test.tsx`(672)、`todayActivityCard.test.tsx`(933)、`signalMiniMenu.test.tsx`(449)、`trade-form-modal.test.tsx`(390) | `wave-3-audit.md` §0：G3 = **5 PASS + 1 前移**；§2 PRD §5.3 逐行 5/5；§4 TodayActivityCard **43 用例** | **A** | 实现 + 用例 + 审计 PASS 三件齐；行业过滤按 `D-4`「显式降级」判 PASS（若 owner 不接受降级，须改判 C） |
| **T68** | L319 `⬜ 待启动` | L437 `✅ 完成（G4 6/6 PASS）` | 提交 `4ea2272`（祖先 = True）；`TradeInput.tsx`（651 行改动）、`TradeTypeTabs.tsx`(159)、`TradeEstimatePanel.tsx`(177)、`TradeReasonTags.tsx`(76)、`SymbolAutocomplete.tsx`(162)、`indicators/movingWeightedCost.ts`(279)；测试 `trade-input.test.tsx`(800) | `wave-4-audit.md` §0：G4 **6/6 PASS**；§2 PRD §5.4 逐行全 ✅；§3 F-T1~F-T6 6/6 | **A** | 6 项 gap + 8 项验收均有实现与用例；端点名出入（`/api/holding/:asset_code` vs 计划卡 `/api/positions/...`）已由审计 §8.4 裁决 |
| **T69** | L320 `⬜ 待启动` | L437 `✅ 完成（G4 6/6 PASS）` | 提交 `4ea2272`；`Review.tsx`（511 行改动）、`ReviewTag.tsx`(213)、`TriStateGroup.tsx`(101)、`components/tradeTypes.ts`(64)；测试 `review-page.test.tsx`(629)、`review.test.tsx`(32) | `wave-4-audit.md` §0：G4.3 / G4.4 PASS；§4 三态按「未标记 / 是 / 否」；§5 debounce 300ms 实测（连改 2 个下拉只发 1 次） | **A** | `setPage`、4 色 pill、300ms debounce 均被审计实测复核；G4.3 的 `PASS/WARN/ERROR` 被裁定为 plan 笔误，不影响交付 |
| **T70** | L328 `⬜ 待启动`（标 🔴） | L438 `✅ 完成（G5 6/6 PASS）` | 提交 `266e1a2`；`apps/frontend/package.json` 含 `klinecharts: 10.1.0`；`Kline.tsx`(834)、`KlineChart.tsx`(543)、`chartIndicators.ts`(771)、`chartBars.ts`(278)、`KlineHoverPanel.tsx`(132)；测试 `kline-page.test.tsx`(784)、`kline-metrics.test.tsx`(402)、`frontend.test.tsx` | `wave-5-audit.md` L18：**G5.2 PASS（附 1 项能力缺口）**；L72：`sh000001`（index）→ **0 行**；§4.2 L219 裁决「本波不修，记为能力缺口」 | **C** | F-K1~F-K8 **8/8** 有实现 + 测试，但 index 类 K 线为空，T70 验收②「ETF / 指数走 `v_etf_*`」对指数不成立 ⇒ **有产物但验收未达** |
| **T71** | L329 `⬜ 待启动`（标 🔓） | L438 `✅ 完成（G5 6/6 PASS）` | 提交 `266e1a2`；`KlineParamPanel.tsx`(222)、`chartParams.ts`(474)、`chartIndicators.ts`(771)；测试 `kline-params.test.tsx`(721)，其中 L433–L452 用 `performance.now()` 断言 **< 300ms** | `wave-5-audit.md` L19 / L20：**G5.3 / G5.4 零容差 PASS**（双端误差 = 0）；L128 交付描述「改值即时重绘、零网络请求」 | **A** | 三项验收各有可执行载体（耗时断言 / golden 逐位 / 柱值 ×2），且审计判 PASS |
| **T72** | L330 `⬜ 待启动` | L438 `✅ 完成（G5 6/6 PASS）` | 提交 `266e1a2`；`Signals.tsx`(410)、`SignalPills.tsx`(117)、`SignalStrength.tsx`(103)；测试 `signals-page.test.tsx`(335，含「T72 ① 进页自动加载」L107 与「T72 ③ 分页」L241)、`signals.test.tsx`(178) | `wave-5-audit.md` L21：**G5.5 PASS**（升序 + 三筛选参数）；L129 交付清单（自动加载 / pill / 分页 / debounce） | **A** | ①自动加载 / ②方向 pill / ③分页 / ④debounce / ⑤`asset_code` 均有实现与用例，后端筛选由 G5.5 实测 |
| **T73** | L338 `⬜ 待启动` | L439 `✅ 完成（G6 6/6 PASS）` | 提交 `038411b`；`StockScan.tsx`(1014)、`PluginParamForm.tsx`(257)、`CandidateTable.tsx`(310)；后端 `routes/stockscan.ts`(+91)、`services/marketData.ts`(+18)；测试 `stockscan-page.test.tsx`(506)、`tests/unit/scan.test.ts` | `wave-6-audit.md` §0 L16–L21：**G6.2** F-S1~F-S5 **5/5**（21 个页面用例）；**G6.4** PE2 2741ms；**G6.6** 375px 溢出 +100 → **0** | **A** | 六项 gap + 四项验收均有实现和实测（含 375px 真浏览器探针与性能门槛） |
| **T74** | L339 `⬜ 待启动` | L439 `✅ 完成（G6 6/6 PASS）` | 提交 `038411b`；`App.tsx L220` `<Route path="/candidates">`、`_shared.tsx L69 / L93`（桌面导航与移动 Tab）、`Candidates.tsx`(399)、`WatchListPanel.tsx`(113)、`CandidateTable.tsx`(310)；测试 `candidates-page.test.tsx`(373) | `wave-6-audit.md` §0：**G6.1 / G6.5 PASS**；但 §5.5 **L177**：`POST /api/candidates/batch` 不固化基准价 ⇒ `candidate_base_price=NULL`、显示 `--`（Req §5.7 #3 缺口，T56 已登记） | **C** | 页面 / 路由 / 导航 / 迁移 / 软删均有产物与用例，但验收①「基准价与加入日收盘价一致」对「选股页批量入池 → 候选池」链路不成立，属**已登记缺口** |

### 8.1 分案统计

| 归类 | 数量 | 任务 |
|---|---|---|
| **A 已完成但 §5 漏回填** | **6** | T67 / T68 / T69 / T71 / T72 / T73 |
| **B 真未交付** | **0** | — |
| **C 部分交付 / 有条件完成** | **2** | T70（index 类 K 线为空）、T74（批量入池基准价 `--`） |
| **D 与 Wave 审计归属冲突** | **0** | — |

> **D = 0 的说明**：8 条的 §5 归属（Wave 3 / 4 / 5 / 5 / 5 / 5 / 6 / 6）与 §6 L436–L439 及各自审计的范围声明**一致**。Wave 归属冲突只出现在 Tier C 的 T77 / T89b / T60b / T60c（见 §3.1、§3.4），不在本组。

### 8.2 对「V2 能否冻结」的直接回答

- **A 的 6 条**：交付不是问题，问题是 **`plan_v2` §5 状态列没回填**。冻结前需要 owner 决定「是否把 §5 改 ✅」（本轮**不改** `plan_v2`）。它们**不阻断冻结**。
- **C 的 2 条**：两个缺口都已在审计里登记并裁决过（T70 归「owner 裁决建 index 视图」；T74 归 T56）。它们**不阻断冻结**，但必须作为**已知限制**写进冻结说明，否则会被误读成「已完全达标」。
- **G1 六条 🔒 已全部 PUBLISH**（§10）：7 个可核单元全绿 —— G1.3a 按 **2026-11-04 修订的四态口径**通过（定向测试 8 passed），G1.6 的脚本假阳性已修（只读复跑 exit 0）。⇒ **V2 具备冻结条件**；尚未生效的唯一原因是 `plan_v2` 的 `frozen` 头属 **D7 独立 commit，本轮未打**。

---

## 9. 附录：G1 六条 🔒 清单

### 9.1 口径差异（先说明，避免伪造）

- `plan_v2 L243` 原文：「**6 条 🔒 数据正确性项不可豁免**」。
- 但 §12.7 的 G1 表（L836–L849）实际只有 **4 行**带 🔒 标记：G1.1（L840）、G1.2（L841）、G1.3（L842，且其内嵌 **G1.3b 另有一个 🔒**）、G1.6（L846）。
- **「4 行 → 6 条」的换算**：把 G1.1 的 3 条子断言拆开 —— **G1.1-a + G1.1-b + G1.1-c + G1.2 + G1.3（含 a/b）+ G1.6 = 6**。
- **另一种读法**（G1.3a 与 G1.3b 各自独立）为 **7 条**。本记录采用 6 条口径，并同时保留 7 条的可能性，**不擅自改写 `plan_v2`**。

### 9.2 逐条清单

| # | 编号 | 行号 | 原文摘要 | 验收判据 | 核验方式 | 本轮可静态核 |
|---|---|---|---|---|---|---|
| 1 | **G1.1-a** | L840 | T84 **时点超卖拒绝** | `tests/unit/positionCalculator.test.ts` + `tests/integration/trade.test.ts` 绿 | **跑测试** | 否 |
| 2 | **G1.1-b** | L840 | T87 **同日 + 同标的 + 同类型 + 不同时间可并存** | 唯一键含 `trade_time`，两笔不同时刻可同时落库 | **静态可核**（`configStore.ts L88` 去重索引 `ON user_trade_record(user_id, asset_code, trade_type, trade_date, trade_time)`）；行为仍需跑测试 | 是（结构） |
| 3 | **G1.1-c** | L840 | T49 **7 种类型 + 四处 `TRADE_TYPES` 清单一致** | 四处清单与 DDL CHECK 白名单一致 | **静态可核**：`routes/trade.ts L41`、`components/tradeTypes.ts L23` 两份清单内容相同（`buy / add / reduce / clear / dividend / bonus / transfer`）+ `configStore.ts` DDL CHECK | 是 |
| 4 | **G1.2** | L841 | `runAllChecks()` 返回**长度 = 12**，`checkId` **覆盖 C1-C12 无重复无占位** | `toHaveLength(12)` + 12 个互异 `checkId` | **静态可核（存在性）**：`services/validator.ts L1204` 有 `runAllChecks`；`tests/smoke-m2.test.ts L83–L86` 已有 `toHaveLength(12)`；判定需跑测试 | 是 |
| 5 | **G1.3（a+b）** | L842 | 信号段 `success === total`、`timeout === 0`、`error === 0`，且 `user_strategy_signal` 新增 > 0；**G1.3b** 标的域 = 自选 ∪ 持仓、无集合外标的、无硬编码 `sh600000`、全程只发 **1 次** DuckDB 日线查询 | 跑信号流水线后断言上述全部 | **必须跑测试**（依赖 DuckDB 行情 + 插件引擎，且会触发真实查询） | 否 |
| 6 | **G1.6** | L846 | **全库数据体检**：无负持仓 / 无负成本 / 无「同日 + 同标的 + 同类型 + 同时刻」重复 | 只读脚本断言三类结果均为空 | **读 SQLite**（只读查询，非测试；需 owner 授权开库） | 否 |

### 9.3 两类清单与数量

| 类别 | 数量 | 条目 |
|---|---|---|
| **本轮可静态核**（纯读代码 / 文档） | **3** | G1.1-b（索引结构）、G1.1-c（清单一致性）、G1.2（用例与函数存在性） |
| **需授权后跑测试 / 读数据库** | **3** | G1.1-a（跑 2 个测试文件）、G1.3（信号流水线实跑，涉及 DuckDB）、G1.6（SQLite 只读体检） |

> ⚠️ 本节只做**点名与方式分类**；实际执行记录见 §10（2026-11-04，owner 已授权定向测试 + 只读开库）。

---

## 10. G1 六条 🔒 核验执行记录（2026-11-04）

> 授权范围：定向 `vitest run`（只指定相关文件）+ 只读开库（SQLite / DuckDB 一律 `READ_ONLY`）。**未启动后端、未跑全量、未改任何代码或测试**。

### 10.1 口径结论：6 条还是 7 条

| 计数方式 | 结果 |
|---|---|
| ① 按 🔒 标记**逐行** | **4 行**：G1.1（L840）、G1.2（L841）、G1.3（L842）、G1.6（L846）；若按**标记处数**则为 **5 处**（G1.3 内嵌 G1.3b 另有一处 🔒） |
| ② 按**子断言**拆分 | **7 条**：G1.1-a / G1.1-b / G1.1-c / G1.2 / G1.3a / G1.3b / G1.6 |
| ③ `plan_v2` 是否明确 6 条的组成 | **没有**。L243 只写「6 条 🔒 数据正确性项不可豁免」，全文无拆分清单 |

**结论：原文未定义拆分规则，6 与 7 均属解释。**

- 能算出 6 的唯一解释：G1.1 的 3 条 + G1.2 + G1.3（a+b 合并）+ G1.6。
- 按 `plan_v2` 自己写的「G1.3a / G1.3b」命名，独立可核单元是 7。
- **本轮按 7 个单元执行（覆盖两种口径）**，统计同时给出 6 条口径的折算（§10.4）。

### 10.2 逐条执行

| 编号 | 判定 | 证据（命令 / 文件行号） | 关键输出 |
|---|---|---|---|
| **G1.1-a** 时点超卖拒绝 | **PUBLISH** | `npx vitest run --config apps/backend/vitest.config.ts --pool=forks --poolOptions.forks.singleFork=true tests/unit/t84-holding-sufficient.test.ts tests/unit/tradeTypeContract.test.ts`；`... tests/integration/trade.test.ts` | 第 1 次 **21 passed（2 文件）**；第 2 次 **22 passed（1 文件）**。关键用例 `t84-holding-sufficient.test.ts L71`「T84 时点回放：日期交错不能绕过校验」→ L72「08-01 买 100、10-16 买 100，08-06 想卖 105 → 必须拒绝」 |
| **G1.1-b** 同日同标的同类型不同时间可并存 | **PUBLISH** | `t87-trade-time.test.ts L165`「同日同标的同类型、不同成交时间 → 均插入成功」、L171「相同成交时间 → UNIQUE 冲突」；只读 `PRAGMA index_list('user_trade_record')` | 3 文件（t87-trade-time / t87b-partial-unique-index / t85b-signal-scope）**28 passed**。运行时索引实测：`idx_user_trade_record_unique_live ON (user_id, asset_code, trade_type, trade_date, trade_time) WHERE is_deleted = 0 AND broker_code IS NULL` → 结构足以支撑「不同时间可并存」 |
| **G1.1-c** 7 种类型四处一致 | **PUBLISH** | `routes/trade.ts TRADE_TYPES`、`frontend/src/components/tradeTypes.ts L23`、`configStore.ts L29` DDL CHECK；`tradeTypeContract.test.ts` 三断言（运行时 `sqlite_master` ≡ 路由白名单 ≡ Requirements 7 种 + configStore 内所有 `trade_type IN(...)` 一致） | 契约测试全绿（含在 21 passed 内）。三处均为 `buy / add / reduce / clear / dividend / bonus / transfer`，**无不一致**。口径说明：同名常量实测只有 **2 处**（后端 + 前端）+ DDL 1 处；另有 4 处**业务子集**（`positionCalculator.ts L231`、`brokerReconcile.ts L273`、`brokerReconcileReport.ts L76`、`assetStat.ts L28`）故意不含全部 7 种，属查询过滤而非白名单 |
| **G1.2** runAllChecks 12 项且覆盖 C1–C12 | **PUBLISH** | `validator.ts` 的 12 个 `checkId` 字面量（C1–C12）；`smoke-m2.test.ts L83` 用例（`-t "12 项 CheckSummary"`） | **1 passed / 10 skipped**。用例断言：长度 = 12、`checkId` ∈ C1–C12、无重复 |
| **G1.3a** 信号段无失败执行 + 新增 > 0 | **PUBLISH（2026-11-04 判据修订后）** | `npx vitest run apps/backend/tests/unit/t85b-signal-scope.test.ts --config apps/backend/vitest.config.ts --pool=forks --poolOptions.forks.singleFork=true`；新增用例：`t85b-signal-scope.test.ts` > `G1.3a — 信号段四态口径（2026-11-04 修订后）` > 「success + skip === total、timeout = 0、error = 0，且新增信号行 > 0」 | **8 passed（1 文件）**。用例 mock 返回 120 根单调下跌日线 → `rsi_oversold` 产信号（SUCCESS）、`macd_cross` 无信号（SKIP）；断言 `success + skip === total`、`timeout === 0`、`error === 0`，再用 `persistBatchSignals` 落库后断言 `inserted > 0`。原判据 `success === total` 与实现四态口径冲突，已按 owner 决定修订（记录见 §10.6） |
| **G1.3b** 标的域与单次查询 | **PUBLISH** | `t85b-signal-scope.test.ts`（域 = watch ∪ hold、候选池不计入、软删不计入、集合外不产生信号、无 `sh600000`、空域 total=0）；`pluginEngine.ts L1330` 一次 `batchGetDailyRange` 预取 + L1028 读缓存；`t88-plugin-timing.test.ts L283–L308` 断言 `onBatchCall` 1 次 | t85b 含在 **28 passed** 内；t88 定向跑 **1 passed / 29 skipped**（`onBatchCall` 调用 1 次、入参 `['good','bad','good2']`）。限制：t85b 把 DuckDB mock 成 `[]`（沿 CI 教训），故「标的域」是 mock 下证据 |
| **G1.6** 全库数据体检 | **PUBLISH** | `$env:SQLITE_DB_PATH='...\data\business.db'; node scripts/data-health-check.mjs`（脚本 `L31` `readonly: true`）；**2026-11-04 已修脚本口径**：重复检测加 `AND broker_code IS NULL`（与部分唯一索引同口径，见 `scripts/data-health-check.mjs` L103–L109） | 改前：规模 `user=36 / trade=385（未删 385）/ signal=5 / rel=4`，0 负持仓、0 负成本，但报 4 处「重复交易」、exit 1（4 处全为券商多笔成交：`broker_code` = 国泰 / 华宝，`source_broker_record_id` 239/240、760/761、686/687、931–935 互异）。改后复跑：**exit 0，全部通过，4 处假阳性消失，规模与负持仓 / 负成本结果不变** |

**G1.6 的「成本」口径选择**：按 `user_trade_record` 全表逐笔回放（`ORDER BY trade_date, id`），`buy/add` 累加 `quantity*price+fee`，`reduce/clear` 按当时移动加权均价结转；`dividend/bonus/transfer` 不计入数量与成本（与 `mapToCoreTrade` 的口径一致，见 `wave-4-audit.md` §8.7）。

### 10.3 阻断项（单列，不计入 PASS 统计）

**本轮无阻断项。**

- 原阻断项 **G1.3a** 已解除：按 owner 决定把判据修订为四态口径并补断言用例（详见 §10.6），定向测试 **8 passed**。
- **G1.6** 的 4 处假阳性已解除：`scripts/data-health-check.mjs` 重复检测加 `AND broker_code IS NULL`，只读复跑 **exit 0**。
- 遗留文档问题（**不阻断**）：`plan_v2` 的「6 条」口径仍未定义（4 行 / 5 处标记 / 7 个子断言三种数法并存），是否补清单由 owner 后续决定。

### 10.4 统计

| 判定 | 7 单元口径 | 折算 6 条口径（G1.3a+b 合并） |
|---|---|---|
| **PUBLISH** | **7**（G1.1-a、G1.1-b、G1.1-c、G1.2、G1.3a、G1.3b、G1.6） | **6** |
| **FAIL** | **0** | **0** |
| **NOT VERIFIABLE** | **0** | **0** |

本轮执行规模：定向测试共 **6 次运行、81 passed（0 failed）**（前 5 次 73 passed + G1.3a 新用例 8 passed）；只读库操作 3 次（体检脚本改前 1 次 + 改后 1 次 + 索引 / 明细复核 1 次）。未启动后端、未跑全量。

### 10.5 冻结结论

**G1 七单元全部 PUBLISH，V2 具备冻结条件。** 但 `plan_v2` 的 `frozen` 头属于 **D7 的独立 commit**，**本轮未打** —— 严格说「已冻结」尚未生效，只差 D7 把那行版本头打上。

### 10.6 2026-11-04 判据修订记录（改的是文档判据，不是实现）

| 项 | 内容 |
|---|---|
| 改动对象 | `plan_v2` §12.7 G1.3 行的**验收判据**（不是代码） |
| 改前 | `success === total` |
| 改后 | `success + skip === total`，且 `timeout === 0`、`error === 0`、`inserted > 0` |
| 理由 | 插件引擎是**四态**（SUCCESS / SKIP / TIMEOUT / ERROR）：`SKIP` = 插件正常执行但目标无信号（无数据 / 未触发条件），**不是失败**。原判据要求每个「插件 × 标的」都产信号，永不成立（历史 `{total:10, success:2, skip:8}` 即证） |
| 未改什么 | **未改任何实现代码**，`pluginEngine.ts` 的四态统计逻辑保持原样；只在 `t85b-signal-scope.test.ts` 加 1 条锁定新口径的用例 |
| 谁批准 | owner（2026-11-04） |
