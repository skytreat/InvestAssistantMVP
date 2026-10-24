# Wave 11 验收 —— 行情更新链路 P0 修复（T104-T109 / DEC-14）

> **判定人**：Wave 11 实施 agent
> **日期**：2026-10-24
> **波次范围**：**T104** 哨兵让锁 + **T105** 更新结果归集 + **T106** 校验闸门/补跑 + **T107** C8 + **T108** 时区 + **T109** Caddy 脚本
> **上游**：[`code_implementation_plan_v2.md`](../client/code_implementation_plan_v2.md) Wave 11 / §9.1 DEC-14 / §12.7 G11
> **判定规则**：G11（7 条）；**只有 PASS / FAIL，无 COND**
> **Base**：`fix/production-deploy`（PR #36）HEAD `0aca454`
> **本波 commit**：`8072b67` T104 / `29ecad5` T105 / `646344d` T106 / `0343ae0` T107 / `ce540ba` T108 / `7f273b6` T109 / `232a91b` style

---

## 0. 判定结论

| 门槛 | 判定 | 实测依据（原始数据见 §1~§4） |
|---|---|---|
| 🔒 **G11.1** | 方向 A 让锁生效：哨兵出现 → Node 释放 instance，外部进程可写；无哨兵时仍复现锁冲突 | ✅ **PASS** —— 跨进程实验：无哨兵 → 外部 `DuckDBInstance.create` 报 `Conflicting lock is held in /usr/bin/node`（与生产原文一致）；写哨兵 + `sync` 后 → `RELEASED true`，外部进程打开并 `SELECT COUNT(*)=1` |
| 🔒 **G11.2** | 更新失败可见：失败/未触发必有 `tdx2db_update/ERROR`，汇总不得 `ERROR=0 WARN=0` | ✅ **PASS** —— `quoteUpdateStatus.test.ts` 9/9；失败分支写 `result=ERROR` + `exit_code`；`schedulerGate` 断言失败+无数据写 `datacheck/ERROR` |
| 🔒 **G11.3** | 无数据不假绿：失败+无数据 → ERROR 跳过；成功+无数据 → 补跑一次，仍无数据 → ERROR | ✅ **PASS** —— `schedulerGate.test.ts` 9/9（矩阵含补跑成功/补跑失败/运行中/等待超时） |
| **G11.4** | C8 生产可用：不再让 `system_log` 走 DuckDB；按 `duration_s` 判 120s | ✅ **PASS** —— validator 三文件 27/27；`C8_SQL` / `?::date` / `parseLocalTs` 已删除；缺日志 SKIP、40s PASS、300s WARN |
| **G11.5** | 时区对齐：timer 含 `Asia/Shanghai`；4 个 CronJob 均带 timezone；09:01 UTC 触发 | ✅ **PASS** —— `systemd-analyze calendar` Next elapse `Mon 2026-10-26 09:00:00 UTC`；`cronSequence` 8 passed / 1 真机探针失败（见 §3.2，属部署前历史失败记录，非代码回归） |
| **G11.6** | 登录经 Caddy 可达：`/api/health` 返回 JSON 而非 index.html | ✅ **PASS** —— `caddyIpScript.test.ts` 2/2；生成的 Caddyfile `caddy validate` = `Valid configuration`；结构为 `handle /api/*` → `reverse_proxy 127.0.0.1:8080`，`try_files` 仅在兜底 `handle` 内 |
| **G11.7** | 文档同步：计划 Wave 11 + DEC-14 + deploy.md 时区/日志 | ✅ **PASS** —— 见本 PR 文档 commit |

### 0.1 G11 判定

```
✅ G11 = PASS（G11.1~G11.7 七条全过，0 COND）
```

> 🔒 **G11.1/G11.2/G11.3 为数据正确性类门槛，零豁免。**
> ⚠️ **部署后复核项（不改变本 PR 判定）**：下一个交易日 17:00 真机 `journalctl -u tdx2db`
> 应无 `Conflicting lock`；`system_log` 应有 `tdx2db_update/SUCCESS`；经 Caddy 的
> `curl http://127.0.0.1/api/health` 应返回 JSON。

---

## 1. G11.1 —— 方向 A 让锁（跨进程实测）

### 1.1 负向对照：无哨兵时复现生产错误

```console
$ DUCKDB_PATH=/tmp/opencode/wave11.duckdb npx tsx holder-hold.mts &
HOLDING
$ DUCKDB_PATH=/tmp/opencode/wave11.duckdb node ... DuckDBInstance.create(...)
EXPECTED_LOCK_FAIL: IO Error: Could not set lock on file "/tmp/opencode/wave11.duckdb":
Conflicting lock is held in /usr/bin/node (PID 912964) by user ubuntu.
However, you would be able to open this database in read-only mode...
```

与 2026-10-23 生产原文（`/opt/invol/IA_Prod/quotes.duckdb`，PID 891852）**同型同文**。

### 1.2 正向：哨兵 + `syncDuckDBWriteSentinel()` 后外部可写

```console
$ DUCKDB_PATH=/tmp/opencode/wave11.duckdb TDX2DB_WRITE_SENTINEL=/tmp/opencode/wave11.sentinel npx tsx holder.mts &
RELEASED true
$ DUCKDB_PATH=/tmp/opencode/wave11.duckdb node ... DuckDBInstance.create(...)
EXTERNAL_OK 1n
```

**结论**：Node 持有 instance 时外部写必失败；哨兵出现后 Node 主动释放，外部进程可正常打开。
`duckdbSentinel.test.ts` 另覆盖 watcher 自动检测、恢复查询、幂等停止（3/3）。

---

## 2. G11.2 + G11.3 —— 结果归集与校验闸门

```console
$ npx vitest run apps/backend/tests/unit/quoteUpdateStatus.test.ts \
    apps/backend/tests/unit/schedulerGate.test.ts \
    --config apps/backend/vitest.config.ts --pool=forks --poolOptions.forks.singleFork=true

 ✓ tests/unit/quoteUpdateStatus.test.ts (9 tests)
 ✓ tests/unit/schedulerGate.test.ts (9 tests)
 Test Files  2 passed (2)
      Tests  18 passed (18)
```

关键断言：

- `SUCCESS` → `result=SUCCESS`，`duration_s` 来自 `ExecMainStart/ExitTimestamp`；
- `failed` / `exit_code!=0` → `ERROR`，detail 含 `state/result/exit_code`；
- 最近运行超过 30 分钟 → `NOT_RUN`（不把昨天的成功当今天）；
- 更新失败 + 当日无数据 → `datacheck/ERROR`，跳过校验；
- 更新成功 + 当日无数据 → 补跑 1 次；补跑后仍无数据 → `ERROR`；
- 更新仍在运行 → `WARN` 跳过（等待超时同样 WARN）。

---

## 3. G11.4 + G11.5 —— C8 与时间链

### 3.1 C8

```console
$ npx vitest run apps/backend/tests/unit/validator_deep.test.ts \
    apps/backend/tests/unit/validatorCoverage.test.ts \
    apps/backend/tests/unit/validator.test.ts \
    --config apps/backend/vitest.config.ts --pool=forks --poolOptions.forks.singleFork=true

 Test Files  3 passed (3)
      Tests  27 passed (27)
```

C8 现在只查 SQLite `system_log`：无日志 → SKIP；`duration_s=40` → PASS；`300` → WARN；
detail 缺失/非法 JSON/非法 duration → WARN。`queryDuckDB` 不再参与 C8。

### 3.2 时区

```console
$ systemd-analyze calendar 'Mon..Fri *-*-* 17:00:00 Asia/Shanghai'
  Original form: Mon..Fri *-*-* 17:00:00 Asia/Shanghai
Next elapse: Mon 2026-10-26 09:00:00 UTC
       (in UTC) / Mon 2026-10-26 17:00:00 CST
```

`cronSequence.test.ts`：**8 passed / 1 failed**。失败项为真机 `journalctl` 探针
（期望 `Finished tdx2db.service`，实际只有 2026-10-23 锁冲突失败记录）；
CI 通过 `CI` 环境变量跳过该探针。**这是部署前预期红，不是代码回归**。

---

## 4. G11.6 + G11.7 —— Caddy 与文档

### 4.1 Caddy 脚本

```console
$ npx vitest run apps/backend/tests/unit/caddyIpScript.test.ts ...
 ✓ tests/unit/caddyIpScript.test.ts (2 tests)
 Test Files  1 passed (1)
      Tests  2 passed (2)

$ caddy validate --config /tmp/opencode/Caddyfile.wave11
Valid configuration
```

生成配置的核心结构：

```caddyfile
http://127.0.0.1 {
    handle /api/* {
        reverse_proxy 127.0.0.1:8080
    }
    handle {
        root * /opt/invol/IA_Prod/frontend/dist
        try_files {path} /index.html
        file_server
    }
}
```

**根因对照**：修复前 `try_files` 在站点顶层，`/api/health` 被改写成 `index.html`
（经 Caddy 返回 `text/html`，直连 8080 返回 JSON）；修复后 `/api/*` 先匹配独立 `handle`。

### 4.2 文档

- `docs/client/code_implementation_plan_v2.md`：新增 Wave 11 任务表、DEC-14、G11、汇总表；
- `docs/client/SDD.md`：timer 片段改为 `17:00:00 Asia/Shanghai`；
- `docs/deploy.md`：Cron 链路标注北京时间，新增 T105/T106 可见性说明。

---

## 5. 全量回归

```console
$ CI=1 npx vitest run apps/backend --config apps/backend/vitest.config.ts \
    --pool=forks --poolOptions.forks.singleFork=true
 Test Files  1 failed | 66 passed (67)
      Tests  933 passed | 17 skipped (950)
   Duration  335.26s
```

唯一失败：`tests/unit/t55-stockscan-filter.test.ts` 的**数据前提探针** ——
生产行情库 `raw_tdx_blocks_member` 现有 **89928 行**，而该用例前提是「板块表为空」。
在迷你库上同一文件 **25 passed / 3 skipped**，故为**生产数据状态导致的本地全量红**，
与 T104-T109 无关。CI 使用迷你库，不受影响。

**其他门禁**：

- `npm run typecheck` ✅ 全仓通过；
- `npx prettier --check apps/backend/src apps/backend/tests/unit apps/backend/tests/integration/cronSequence.test.ts` ✅；
- `npx eslint apps/backend/src apps/backend/tests/unit/caddyIpScript.test.ts` ✅ 无输出。

---

## 6. 部署后复核清单（不改变 G11 判定）

1. `sudo cp deploy/tdx2db-update.timer /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl restart tdx2db-update.timer`；
2. `systemctl list-timers tdx2db-update.timer` 确认下次触发为北京时间 17:00；
3. 部署后端后 `sudo bash deploy/install_caddy_ip.sh`（`CADDY_IP` 必填）并 `curl http://127.0.0.1/api/health`；
4. 下一交易日 17:00 后检查：
   - `journalctl -u tdx2db -n 50 --no-pager` 无 `Conflicting lock`；
   - `sqlite3 /opt/invol/IA_Prod/data/business.db "SELECT log_type,level,detail FROM system_log WHERE log_type IN ('tdx2db_update','datacheck') ORDER BY id DESC LIMIT 5"`；
   - `tdx2db_update` 为 SUCCESS，`datacheck` 非 ERROR。
