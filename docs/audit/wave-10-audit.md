# Wave 10 验收 —— 行情库备份开关（T103 / DEC-13）+ P2 体验收尾（T79 ②~⑥）

> **判定人**：Wave 10 实施 agent
> **日期**：2026-10-23
> **波次范围**：**T103**（`ENABLE_QUOTE_BACKUP` 行情库备份开关）+ **T79 ②~⑥**（touch / 信号空态 / 面包屑 / Dashboard 概览 / 候选池面板）
> **上游**：[`code_implementation_plan_v2.md`](../client/code_implementation_plan_v2.md) §5 Wave 10 / §9.1 DEC-13 / §12.7 G10
> **判定规则**：G10（5 条）+ §12.6 全局判定；**只有 PASS / FAIL，无 COND**
> **Base commit**：`5a90e8a`（Wave 9 文档收尾）
> **本波 commit**：`feat(Wave 10): T103 ...`（单任务 commit）+ 随 PR 的 lint 修复 commit（见 §4.1）

---

## 0. 判定结论

| 门槛 | 判定 | 实测依据（原始数据见 §1~§3） |
|---|---|---|
| 🔒 **G10.1** | 默认行为回归 —— 未设置 / `true` 时 SQLite + DuckDB 双库照常 | ✅ **PASS** —— 未设置时 `backup.test.ts` 的 F11 真跑 `COPY v_stock_qfq TO parquet`（15/15 PASS）；`schedulerBackup.test.ts`「未跳过且成功 → duckdb=OK + SUCCESS」PASS |
| 🔒 **G10.2** | 开关真实生效 —— `false` 时 DuckDB 不打开、不产 parquet；SQLite 仍备份；定时/手动一致 | ✅ **PASS** —— `backupDuckDB()` 返回 `{success:true, skipped:true}`；哨兵 DuckDB 路径未被创建；parquet 集合零新增；`runFullBackup()` 生成 `business.db.YYYY-MM-DD` 且 `duckdb.skipped=true` |
| **G10.3** | 日志与前端语义正确 —— `duckdb=SKIP` 且 `level != ERROR`；前端显示「已跳过」 | ✅ **PASS** —— 调度日志 `duckdb=SKIP` + `level=SUCCESS`；前端 9/9 PASS，含「DuckDB：已跳过（配置关闭）」且不出现「成功/失败」 |
| **G10.4** | 恢复演练不误报 —— 无 parquet 时 WARN 跳过行情段、SQLite 仍校验并 EXIT=0；缺 SQLite FAIL | ✅ **PASS** —— 手动脚本 EXIT=0，stdout 有 WARN + `SKIP（无 parquet 备份）`；`restoreDrill.test.ts` 3/3 PASS（含缺 SQLite / SQLite 损坏两条反向用例） |
| **G10.5** | 文档同步无残留 —— L1 §4.2 #12/#13、L3 §6.5 + §4.4、L5 env 表 + `.env.template` | ✅ **PASS** —— 4 层均已写入 `ENABLE_QUOTE_BACKUP` 语义；`grep "双库备份"` 在目标层零命中 |

### 0.1 G10 判定

```
✅ G10 = PASS（G10.1 / G10.2 / G10.3 / G10.4 / G10.5 五条全过，0 COND）
```

> 🔒 **G10.1 / G10.2 为数据正确性类门槛，零豁免。**

---

## 1. G10.1 + G10.2 —— 开关行为（原始输出）

### 1.1 后端定向用例

```console
$ npx vitest run apps/backend/tests/unit/backup.test.ts \
    apps/backend/tests/unit/schedulerBackup.test.ts \
    apps/backend/tests/unit/restoreDrill.test.ts \
    --config apps/backend/vitest.config.ts --pool=forks --poolOptions.forks.singleFork=true

 ✓ tests/unit/restoreDrill.test.ts (3 tests)
 ✓ tests/unit/backup.test.ts (15 tests)
 ✓ tests/unit/schedulerBackup.test.ts (3 tests)
 Test Files  3 passed (3)
      Tests  21 passed (21)
```

其中新增的开关用例（`--reporter=verbose`）：

```console
 ✓ backup > ENABLE_QUOTE_BACKUP > 默认开启：未设置 / true → true；仅 false → false
 ✓ backup > ENABLE_QUOTE_BACKUP > false：backupDuckDB 返回 skipped，且不打开 DuckDB / 不产 parquet
 ✓ backup > ENABLE_QUOTE_BACKUP > false：runFullBackup 仍备份 SQLite，DuckDB 标记 skipped
 ✓ backup_restore_duckdb > COPY TO parquet → COPY FROM 恢复 → COUNT(*) 与源库一致
 ✓ backup_restore_duckdb > COPY TO PARQUET GZIP → 恢复 → COUNT(*) 一致
```

**反向验证成立**：`false` 用例把 `DUCKDB_PATH` 指向不存在的哨兵路径，并断言该路径未被创建、
备份目录 parquet 集合零新增。若实现忽略开关（打开 DuckDB / 写 parquet），断言必然 FAIL。

### 1.2 CI 条件（空行情库 + `--coverage`）

```console
$ DUCKDB_PATH=/tmp/nonexistent.duckdb BACKUP_DIR=<tmp>/backup \
    SQLITE_DB_PATH=<tmp>/business.db \
    npx vitest run <上述 3 个文件> --coverage \
    --config apps/backend/vitest.config.ts --pool=forks --poolOptions.forks.singleFork=true

 ✓ tests/unit/schedulerBackup.test.ts (3 tests)
 ✓ tests/unit/restoreDrill.test.ts (3 tests)
 ✓ tests/unit/backup.test.ts (15 tests)
 Test Files  3 passed (3)
      Tests  21 passed (21)
```

> 证明惰性读取有效：`--coverage` 提前加载模块时，开关/路径仍按用例内 env 生效。

---

## 2. G10.3 —— 日志与前端（原始输出）

```console
$ npx vitest run apps/backend/tests/unit/schedulerBackup.test.ts ...
 ✓ duckdb.skipped=true → duckdb=SKIP 且 level=SUCCESS（不得误报 ERROR）
 ✓ 未跳过且成功 → duckdb=OK + SUCCESS（默认行为回归）
 ✓ DuckDB 真实失败（未 skipped）→ duckdb=FAIL + ERROR

$ npx vitest run apps/frontend/tests/unit/admin-backup-panel.test.tsx --config apps/frontend/vitest.config.ts
 ✓ tests/unit/admin-backup-panel.test.tsx (9 tests)
 Test Files  1 passed (1)
      Tests  9 passed (9)
```

前端新增断言：

```ts
expect(notice).toHaveTextContent('SQLite：成功');
expect(notice).toHaveTextContent('DuckDB：已跳过（配置关闭）');
expect(notice).not.toHaveTextContent('DuckDB：成功');
expect(notice).not.toHaveTextContent('DuckDB：失败');
```

`services/backup.ts` 关闭分支另写一条 `level='SKIP'` 日志；调度汇总日志为
`备份完成: sqlite=OK duckdb=SKIP cleaned=N` + `level=SUCCESS`。

---

## 3. G10.4 —— 恢复演练（手动原始输出）

```console
$ PATH=<tmp-bin-with-sqlite3-stub>:$PATH \
    BACKUP_DIR=<tmp>/backup TMPDIR=<tmp>/work bash scripts/restore-drill.sh

=== 1. 定位最新备份 ===
⚠️ 找不到 DuckDB 行情 parquet 备份（ENABLE_QUOTE_BACKUP=false 时属正常）
   → 跳过行情段，SQLite 段仍完整校验
  SQLite: /tmp/g10-drill-hMlO6r/backup/business.db.2026-10-23
=== 2. SQLite 恢复演练 ===
✅ SQLite integrity_check = ok
=== 3. DuckDB 行情恢复演练 === SKIP（无 parquet 备份）
=== 4. 清理 ===
✅ 恢复演练完成（SQLite 段通过）
EXIT=0
```

`restoreDrill.test.ts` 额外覆盖两条反向路径：

```console
 ✓ 缺 SQLite 备份 → EXIT≠0（即使也没有 parquet）
 ✓ 无 parquet 时 SQLite 校验失败仍必须 EXIT≠0（跳过行情段不得放过业务库）
```

---

## 4. G10.5 —— 文档同步与全量门禁

### 4.1 文档命中（原始 grep）

```console
$ grep -n "ENABLE_QUOTE_BACKUP" docs/client/Requirements_simplified.md docs/client/SDD.md \
    docs/deploy.md .env.template AGENTS.md

docs/client/SDD.md:1458  /api/admin/backup 响应含 duckdb.skipped?
docs/client/SDD.md:2441  行情库备份开关（DEC-13）
docs/deploy.md:122       # ENABLE_QUOTE_BACKUP=false
docs/deploy.md:139       17:05 cron 描述
.env.template:17         # ENABLE_QUOTE_BACKUP=false
AGENTS.md:138            17:05 cron 描述
```

L1 `Requirements_simplified.md` §4.2 #12/#13、Step 5、Phase 4 交付物均已改为
「SQLite 恒常 + 行情库默认、可配置关闭」，且目标层 `grep "双库备份"` 零命中。

### 4.2 质量门禁

```console
$ npm run typecheck
> @invest/core typecheck / build / @invest/backend typecheck / @invest/frontend typecheck
（全部 exit 0）

$ npm run lint
eslint . && prettier --check .
All matched files use Prettier code style!   # exit 0

$ npx vitest run --config packages/core/vitest.config.ts
 Test Files  11 passed (11)
      Tests  92 passed (92)

$ npm run test -w @invest/frontend
 Test Files  43 passed (43)
      Tests  633 passed | 1 todo (634)
```

### 4.3 全量后端测试的已知非阻塞项

```console
$ npm test   # backend
 Test Files  1 failed | 62 passed (63)
      Tests  912 passed | 13 skipped (925)

FAIL tests/unit/t55-stockscan-filter.test.ts > T55 — 真实 DuckDB 数据上的过滤行为
AssertionError: expected 89928 to be +0
 ❯ tests/unit/t55-stockscan-filter.test.ts:250
```

**判定：与 T103 无关，不阻断 G10。** 该断言是 Wave 6 留下的「数据前提探针」：
当时真库 `raw_tdx_blocks_member` 为空；Wave 9 的 tdx2db 回填后真库有 **89928** 行，
前提已改变。T103 未触碰股票扫描 / DuckDB 查询代码；CI 使用空壳/迷你库，该探针走 skip 分支。
建议另立测试维护任务，勿混入本任务。

### 4.4 随 PR 的 lint 修复

`apps/backend/tests/integration/cronSequence.test.ts` 在 `5a90e8a` 已有 4 处
`@typescript-eslint/no-require-imports`（`npx eslint .` 失败，非本任务引入）。
为让 PR 的 `lint-and-typecheck` job 可绿，本 PR 附一条独立 commit 改为静态 import
（`execFileSync` / `fs`）。

**同文件 CI 守卫修复**：首次 PR CI 暴露 GitHub Actions 上 `/run/systemd/system` **存在**
但 timer 未安装，旧守卫 `!fs.existsSync('/run/systemd/system')` 误判为真机 ⇒ 3 条 T102
真机探针 FAIL，连带 `build-and-test` 与 `Coverage Gate` 两个 job 红。改为
`Boolean(process.env.CI) || (...)` 优先认 CI；本地真机（无 `CI`）仍照常跑探针。

---

## 5. 未关闭 / 移交项（不得冒充已关闭）

| # | 项 | 状态 |
|---|---|---|
| 1 | **T79 ②~⑥** P2 体验收尾 | ✅ **已完成**（2026-10-23）；**不计入 G10**，证据见 §7 |
| 2 | Wave 9 遗留：备份覆盖面未补（`raw_gbbq` / `raw_holidays` / `raw_symbol_class` / `v_etf_*`） | ⬜ 未关闭；T103 明确不负责 |
| 3 | Wave 9 遗留：T102 运行层反向验证为手工 gate（单测占位 `expect(true)`） | ⬜ 未关闭 |
| 4 | 本地全量 `t55` 数据前提漂移 | ⬜ 另立测试维护任务（见 §4.3） |

---

## 6. 最终判定

```
✅ Wave 10 · T103 = PASS（G10 5/5，0 COND）
✅ 开关语义：默认开启；仅 ENABLE_QUOTE_BACKUP=false 关闭；SQLite 恒常备份
✅ 文档：L1 / L3 / L5 / AGENTS.md 同口径
✅ T79 ②~⑥ = 完成（P2 体验收尾；无 G10 门槛，证据见 §7）
```

---

## 7. T79 ②~⑥ —— P2 体验收尾（补充验收）

> T79 不含 G10 门槛；本节记录交付证据，避免「无落档 = 未执行」。

| 项 | 交付 | 证据 |
|---|---|---|
| ② touch ≥44×44 | `global.css` 的 `@media (pointer: coarse)`：button / role=button / a / input（不含 checkbox/radio）/ select / textarea / summary / label 高度下限 44px；按钮类宽度下限 44px；`touch-action: manipulation` | `touch-targets.test.ts` **4/4 PASS** |
| ③ 信号空态引导 | `Signals.tsx` 空态保留「今日暂无策略信号」+「收盘后 **17:02** 自动运行信号生成」；管理员额外显示【立即运行信号】→ `/admin` | `signals-page.test.tsx` **17/17 PASS**（含 17:03 负断言、admin / 普通用户两态） |
| ④ 面包屑 | 新增 `Breadcrumbs.tsx`；Kline（仪表盘 / K线图 / 标的）与 `PositionDetailModal`（仪表盘 / 标的详情 / 代码）接入；当前页 `aria-current="page"` | `breadcrumbs.test.tsx` **2/2** + `kline-page.test.tsx` / `symbol-detail-modal.test.tsx` 全绿 |
| ⑤ Dashboard 概览 | 四块：资产汇总 / 今日快捷操作（买入、卖出、全部交易、admin 入口 + TodayActivityCard）/ 持仓 Top3（市值降序，>3 可展开）/ 最新信号 Top5（查看全部 → `/signals`）；admin 日志收进底部折叠 `<details>` | `dashboard.test.tsx` **17/17 PASS**（含 T79 3 条）；全量前端 **46 文件 / 655 PASS + 1 todo** |
| ⑥ 候选池联动 | 新增 `CandidatePoolPanel.tsx`：默认折叠「候选池 N 只 · M 只有信号」，展开 Top5「有信号优先 → 跟踪天数长优先」，每行现价/信号/跟踪天数/【买入】；买入预填 `TradeFormModal` 现价 + D-11 理由，数量留空 | `candidate-pool-panel.test.tsx` **5/5**；Dashboard 集成用例验证弹窗预填；`trade-input.test.tsx` **45/45**（含 `?type=buy|sell` 落点，`sell` 映射业务口径「减仓」） |

质量门禁：`npm run typecheck -w @invest/frontend` exit 0；`eslint apps/frontend/src apps/frontend/tests` exit 0；`npm run test -w @invest/frontend` **46 files / 655 passed / 1 todo**。

> ⚠️ `?type=sell` 是 Dashboard 快捷入口的通用叫法；Requirements §5.1 无 `sell`，前端将其归一化为 `reduce`（减仓），避免落到非法交易类型。
