# ADR-004：数据校验完整性（C4/C5 实现 + 测试映射补齐）

| 项 | 值 |
|---|---|
| **状态** | ✅ 已接受（Accepted） |
| **日期** | 2026-10-17 |
| **裁决人** | 项目所有者 |
| **关联** | 实施计划 §13.1 **B-1**（C4/C5）、**B-2**（PE6 缺失）、**B-4**（测试映射）、§13.3 S-6 |
| **落地任务** | T85、T91 |
| **真相源依据** | SDD §5.7、§12.5；PRD D1、§6.2 |

---

## 背景

交叉审计 plan 与 PRD / SDD 时发现三类问题，**都会让 §12.6 全局验收必然判 FAIL**。

### 1. C4 / C5 两条校验从未实现（B-1）

代码 `services/validator.ts` 的注释原文写着「MVP 只实现 C3，**C4/C5 SDD 是"略"**」，
`checkC3toC5` 函数**一律返回 `checkId:'C3'`**，`detail` 写「C4/C5 MVP 暂缺」。

后果链：
- `runAllChecks()` 实际返回 **10 条**而非 12 条
- **PRD D1「12 项校验」不可达**
- **PRD §6.2「C1-C10 通过率 ≥99.9%」不可达**
- 且实施计划 §5 全部任务中**无一负责 C4/C5**

> ⚠️ 本条最初被误判为「PARTIAL，缺的是数据、卡片渲染逻辑存在」——
> 该结论**掩盖了代码本身就没实现**的事实，已在 §11.3b B8 更正为 FAIL。

### 2. 实施计划丢失了 SDD §12.5 的「对应测试 Case」映射（B-4）

SDD 每项验收都指定了测试文件与用例名
（`holding.test.ts → avg_cost_calc_5_scenarios`、`plugin.test.ts → state_machine_4_paths` …），
实施计划 §12.1 只有「项 / 通过标准」两列。

实测缺口：

| 缺口 | 实测情况 |
|---|---|
| `holding.test.ts` | **不存在**（现有 `positionCalculator.test.ts` 不覆盖 SDD 指定用例） |
| `scan.test.ts` | **不存在** |
| `frontend.test.tsx` | **不存在**（前端 0 测试） |
| `packages/core/tests/plugin.test.ts` | **只有 1 个用例**（插件可实例化），SDD 要求的状态机 4 路径 + `plugin_timeout_50ms` **均无** |
| F11 `backup_restore_duckdb` | **全仓无测试** —— `backup.test.ts` 只覆盖 `backupSQLite`（DuckDB 备份恢复零覆盖） |

后果：**F11 判「通过」是毫无证据的** —— 测试文件不存在却未被验收标准捕获。

### 3. 实施计划漏列 PE6（B-2）

§12.1 声称「SDD §12.5 共 24 项」，实际只列 23 项，**PE6（插件 50ms 超时不拖垮主流程）被漏**。
而 PE6 恰是当前最危险项（实测 `timeout:2/2`）。

## 决策

### 1. C4 / C5 **必须实现**（T85）

把 `checkC3toC5` 拆为三条独立校验，使 `runAllChecks()` 返回 **12 条**：

| 校验 | 内容 | 数据源 |
|---|---|---|
| C3 | 停牌日 | `v_stock_qfq`（volume=0 推断）|
| C4 | 退市标记 | `raw_symbol_name(symbol, name)` —— 已确认存在 |
| C5 | ST 状态一致性 | `raw_symbol_class.is_st` —— ⚠️ **代码中从未引用过，字段名未经验证** |

**每条校验返回 PASS / WARN / ERROR / SKIP 四态**；
**数据源缺失一律 SKIP，不得计为 PASS。**

### 2. 两条「禁止猜测 schema」的硬约束

实现 C4/C5 时**不得照抄文档写 SQL**：

- **C4**：判定式必须先 `SELECT` 实测取值分布再定，不得硬编码「名称含退」之类的假设
- **C5**：`raw_symbol_class` 在现有代码中从未被引用，字段名 `is_st` 仅来自 SDD 描述。
  **实现第一步必须 `DESCRIBE raw_symbol_class` 确认真实列名**；表不存在 → 返回 SKIP 并登记偏差

> 根因：SDD §3.3「放行某张表可读」≠「已知该表字段名」。
> T80 放行了 `raw_symbol_name` / `raw_symbol_class`，但**没有验证过 schema**。

### 3. 测试映射补齐 + 建缺失测试文件（T91）

- §12.1 补第三列「SDD 指定测试载体」，逐项标 `✅ 已有` / `❌ 待建`
- 新建 `tests/unit/{holding,scan}.test.ts`
- 扩展 `packages/core/tests/plugin.test.ts`（状态机 4 路径 + `plugin_timeout_50ms`）
- `backup.test.ts` 补 **DuckDB 备份恢复**用例（`COPY TO PARQUET GZIP` → 恢复 → `COUNT(*)` 相等，
  **不得只 mock**，必须用临时目录）
- PE6 已补回 §12.1（无需任务），其运行时问题归 ADR-005

## 后果

### 正面
- PRD D1 与 §6.2 变得可达
- 验收标准与实际测试之间建立可追溯映射，「无测试却判通过」不再可能

### 负面 / 代价
- T85 需先做 schema 探测，若 `raw_symbol_class` 不存在则 C5 只能返回 SKIP，
  **此时 PRD D1 的「12 项」在数据上仍不可达**，需再次裁决
- T91 工作量随 T60/T61 的测试存量浮动（若 T60 已建 `scan.test.ts` 则减 0.5d）

### 对真相源的影响
- ✅ **SDD §5.7 已回写**（C4/C5 占位「略」→ 完整 SQL + 四态 + 两条硬警告）
- ⏳ 待回写：`docs/coding-standards.md` 未提及 C1-C12 的四态要求
