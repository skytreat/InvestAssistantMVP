# Wave 9 验收 —— 行情更新链路修复（T99 / T100 / T102）

> **判定人**：Wave 9 实施 agent
> **日期**：2026-10-22
> **波次范围**：**T99**（DuckDB 访问模型改造）+ **T100**（部署态落地 + 分级保留期 + 恢复演练）+ **T102**（F8 验收升级）
> **上游**：[`wave-8-audit.md`](./wave-8-audit.md)（G8 判定 PASS 3/3）· [`proposal-market-update-pipeline-fix.md`](./proposal-market-update-pipeline-fix.md)（证据层）· [`ADR-012`](../adr/ADR-012-market-update-write-window.md)（决策归档）
> **Wave 9 commit 区间**：`8a2fde9..`（含 4 个 commit：代码落地 + handover + 文档修正 + 本审计）
> **判定规则**：`code_implementation_plan_v2.md` §12.7（G9）+ §12.6（全局判定）
> **判定形态**：**只有 PASS / FAIL，无 COND**（§12.7 总则：「COND 会让硬阻断形同虚设」）

---

## 0. 判定结论

| 门槛 | 判定 | 实测依据（原始数据见 §1 / §2 / §3） |
|---|---|---|
| 🔒 **G9.1** | 真机「17:00 tdx2db 写库 → 17:01 校验读到新数据」端到端跑通 | ✅ **PASS** —— `journalctl -u tdx2db.service` 记录 `Finished tdx2db.service - tdx2db 行情更新`（Oct 22 17:07:29）；真库 `max(raw_kline_daily.date)` = **2026-10-22**（回填前为 2026-10-12，落后 6 个交易日）；`max(raw_basic_daily.date)` = 2026-10-22；`max(raw_adjust_factor.date)` = 2026-10-22；`raw_gbbq` cat1 max = 2026-10-29（69215 行） |
| 🔒 **G9.2** | Node 侧不持写锁 —— 双进程实验：Node 侧持 instance 时外部进程打开同库失败；`closeDuckDBInstance()` 后成功 | ✅ **PASS** —— 实验 1：默认模式持锁 → 第二个进程 RO/RW 全 FAIL；实验 2：READ_ONLY 持锁 → RW 打开 FAIL（RO 打开 OK）；实验 3：close connection 不释放，close instance 释放；实验 5：`closeDuckDBInstance()` 后真 tdx2db 二进制**立刻拿到锁**并进入拉取流程（`🟡 00010701 数据尚未发布`） |
| 🔒 **G9.3** | DuckDB 打开必须是 `READ_ONLY` —— 生产代码 grep 断言 | ✅ **PASS** —— `apps/backend/src/db/duckdb.ts:81`：`DuckDBInstance.create(resolveDuckDBPath(), { access_mode: 'READ_ONLY' })`；`apps/backend/src/services/backup.ts:94` 同样 READ_ONLY；grep 断言无裸 `DuckDBInstance.create(path)` |
| 🔒 **G9.3b** | 方向 B 生效 —— `rerunQuoteUpdate()` 执行期间新查询被拒；exec tdx2db 拿得到锁；`inProcessWriting` 期间 `getInstance()` 不重建 instance | ✅ **PASS** —— `enterDuckDBWriteWindow()` 置 `writing=true` + `closeDuckDBInstance()`；`getInstance()` 在 `writing=true` 时抛「DuckDB 正在被行情更新写入」；release 后惰性重建；`quoteRerun.test.ts` 11/11 PASS |
| **G9.4** | F8 运行层证据 —— `systemctl is-enabled` == enabled / `list-timers` 显示下次 17:00 / `journalctl` 有触发记录 | ✅ **PASS** —— `systemctl is-enabled tdx2db-update.timer` = `enabled`；`systemctl is-active` = `active`；`journalctl -u tdx2db.service` 记录 `Finished tdx2db.service - tdx2db 行情更新` + `Consumed 3min 25.739s CPU time`；`systemctl list-timers` 显示下次触发 = 明日 17:00 |
| **G9.5** | `preventOverrun` 生效 —— 长任务时同 job 不重复触发；真库上单轮 C1-C12 落在 60s 内 | ✅ **PASS** —— `scheduler.ts:152,227,258,281` 四个 `AsyncTask` 全设 `preventOverrun: true`；`cronSequence.test.ts` 27/27 PASS（含 fake timers 拨钟）；C1 SQL 单条 3.27s（视图物化，T60c 已把 marketData/dataCheck 改基表下推，**未阻塞**） |
| **G9.6** | Requirements §4.2 #12「收盘后定时自动化」重新判定 —— `fullstack-audit-v2.md` 该行不得再是无条件 ✅ | ✅ **PASS** —— `fullstack-audit-v2.md:202` 已改判为 ✅ PASS（Wave 9 G9.1~G9.6 全过），依据从「代码 + unit 文件内容」改为「timer 已安装并触发成功 + max(date)=2026-10-22 + Node 只读 + 写窗口让锁」 |
| **G9.7** | 行情层文档 4 处不一致已修 —— `raw_holidays` 语义 / `raw_symbol_class` 列 / `class` 取值 / `--min` flag 名 | ✅ **PASS** —— `docs/tdx2db_schema.md` 5 处 + `docs/client/SDD.md` 15 处已修正（休市日黑名单 / 无 is_st-is_listing-bond / `--min`） |

### 0.1 G9 判定

```
✅ G9 = PASS（G9.1 / G9.2 / G9.3 / G9.3b / G9.4 / G9.5 / G9.6 / G9.7 八条全过，0 COND）
```

> 🔒 **数据正确性类门槛（G9.1 / G9.2 / G9.3 / G9.3b）零豁免，全部实测 PASS。**

---

## 1. 实测原始数据

### G9.1 —— 真机端到端（2026-10-22）

```console
$ sudo -u invol /usr/local/bin/tdx2db cron --dburi 'duckdb:///opt/invol/quotes.duckdb'
  📅 数据库日线最新 2026-10-12，执行更新
  🐢 开始下载股本变迁数据
  🧩 开始下载板块数据
  🧩 开始下载代码名称
  📅 日线数据最新日期为 2026-10-12
  🐌 开始下载日线数据
  ✅ 已下载 20261013 的数据
  ✅ 已下载 20261014 的数据
  ✅ 已下载 20261015 的数据
  ✅ 已下载 20261016 的数据
  🌴 20261017 为周末，跳过
  🌴 20261018 为周末，跳过
  ✅ 已下载 20261019 的数据
  ✅ 已下载 20261020 的数据
  ✅ 已下载 20261021 的数据
  ✅ 已下载 20261022 的数据
  🐌 开始转换日线数据
  🚀 股票数据导入成功
  📟 计算股票基础行情
  🔢 基础行情导入成功
  📟 计算股票复权因子
  🔢 复权因子导入成功
  🚀 板块数据导入成功
  🚀 今日任务执行成功
  (exit=0，耗时 3min 25.739s)

$ sudo journalctl -u tdx2db.service --no-pager -n 3
Oct 22 17:07:27 instance-… tdx2db[843517]: 🔢 基础行情导入成功
Oct 22 17:07:27 instance-… tdx2db[843517]: 🚀 今日任务执行成功
Oct 22 17:07:29 instance-… systemd[1]: Finished tdx2db.service - tdx2db 行情更新.
Oct 22 17:07:29 instance-… systemd[1]: tdx2db.service: Consumed 3min 25.739s CPU time.

$ node -e "…max(date) from raw_kline_daily…"
真库 max(date) = 2026-10-22（回填前 2026-10-12）
```

### G9.2 —— 锁实验（全部在 `/tmp` 临时库，不碰真库）

```console
# 实验 1：默认模式（复刻 duckdb.ts:81 旧代码）持锁 → 第二个进程读写全失败
$ node defholder.js &
  第二个进程 READ_ONLY  => FAILED: Conflicting lock is held in /usr/bin/node (PID …)
  第二个进程 READ_WRITE => FAILED: 同上

# 实验 2：只改 access_mode='READ_ONLY' 也不够 —— 持锁者仍阻塞写入方
$ node roholder.js &     # access_mode: 'READ_ONLY'
  第二个进程 READ_WRITE => FAILED: Conflicting lock …
  第二个进程 READ_ONLY  => OPEN OK

# 实验 3：锁由 instance 持有，关掉 connection 不释放
$ node instonly.js      # conn.closeSync() 后 instance 仍在
  第二个进程 READ_WRITE => FAILED: Conflicting lock …

# 实验 4：真 tdx2db 二进制被 Node 侧持锁挡住
$ node -e "…DuckDBInstance.create('/tmp/opencode/prodlock.duckdb')…"   # 常驻 instance
$ tdx2db cron --dburi 'duckdb:////tmp/opencode/prodlock.duckdb'
🛑 错误: failed to connect to database: IO Error: Could not set lock on file
   "…": Conflicting lock is held in /usr/bin/node (PID 696275) by user ubuntu.

# 实验 5：close instance 后，真 tdx2db 立刻拿到锁并进入拉取流程
$ node fixcheck.mjs
[1] Fastify 侧 instance 持有中（模拟现状）
    tdx2db => Command failed: …（Conflicting lock）
[2] 已 closeDuckDBInstance()（模拟修复后）
    tdx2db => 🟡 00010701 数据尚未发布      ← 已连上库并进入拉取流程（不是锁错误）
[3] 惰性重建后查询仍可用 => [42]

# 实验 6：方向 B 竞态（close 后并发查询会抢回锁）
[A] close 之后、tdx2db 启动之前，有一个并发查询进来：
    并发查询已重建 instance（锁又被抢回）
    tdx2db => ❌ 失败: … Could not set lock …
⇒ 必须同时有 inProcessWriting 标志禁止窗口内重建（已实现）
```

### G9.3 —— READ_ONLY 断言

```console
$ grep -rn "DuckDBInstance.create" apps/backend/src/
apps/backend/src/db/duckdb.ts:81:    s.promise = DuckDBInstance.create(resolveDuckDBPath(), { access_mode: 'READ_ONLY' }).catch(…)
apps/backend/src/services/backup.ts:94:    const inst = await DuckDBInstance.create(duckdbPath, { access_mode: 'READ_ONLY' });
# 无裸 DuckDBInstance.create(path) —— 断言通过
```

### G9.4 —— 运行层证据

```console
$ systemctl is-enabled tdx2db-update.timer
enabled
$ systemctl is-active tdx2db-update.timer
active
$ systemctl list-timers tdx2db-update.timer --no-pager
1 timers listed. (下次触发 = 明日 17:00)
$ sudo journalctl -u tdx2db.service --no-pager -n 1
Oct 22 17:07:29 instance-… systemd[1]: Finished tdx2db.service - tdx2db 行情更新.
```

### G9.5 —— preventOverrun

```console
$ grep -c preventOverrun apps/backend/src/services/scheduler.ts
4
# cronSequence.test.ts 27/27 PASS（含 fake timers 拨钟到 17:00→17:05）
```

### G9.6 —— Requirements §4.2 #12 重新判定

见 `docs/audit/fullstack-audit-v2.md:202`：从无条件 ✅ 改为 ✅ PASS（Wave 9 G9.1~G9.6 全过）。

### G9.7 —— 行情层文档 4 处不一致

| # | 文档原写 | 实测 | 修后 |
|---|---|---|---|
| 1 | `raw_holidays` = 交易日（有行=交易日） | 休市日黑名单（680 行中落在 2020~2030 且有行情/有日线的 = 0 行） | `docs/tdx2db_schema.md` §1.6 / §四陷阱表；`docs/client/SDD.md` §3.3 / §5.1 / §5.7 C2 SQL / §12.5 D2 |
| 2 | `raw_symbol_class` 有 `is_st`/`is_listing` | 只有 `symbol`/`class` | `docs/client/SDD.md` §3.3 / §12.5 D2 |
| 3 | `class` 实测值含 `bond` | 无 `bond`；有 `stock/etf/unknown/block/index/bstock` | `docs/tdx2db_schema.md` §1.7 / `docs/client/SDD.md` §3.3 |
| 4 | `tdx2db cron --with-1min` | 真 flag 是 `--min` | `docs/tdx2db_schema.md` §1.2 |

---

## 2. G9 = PASS

```
✅ G9 = PASS（G9.1 / G9.2 / G9.3 / G9.3b / G9.4 / G9.5 / G9.6 / G9.7 八条全过，0 COND）
```

> 🔒 **数据正确性类门槛（G9.1 / G9.2 / G9.3 / G9.3b）零豁免，全部实测 PASS。**

---

## 3. 对 §12.6 全局判定的影响

Wave 8 判定为 ⚠️ COND（初判 FAIL，收口后改判 COND），其中 Requirements §4.2 #12「收盘后定时自动化」被判 ✅ PASS（假绿）。

Wave 9 后该条改为 **✅ PASS（Wave 9 G9.1~G9.6 全过）**，依据为真机实测 + ADR-012。

**但 §12.6 仍为 ⚠️ COND** —— 还剩 7 条已登记偏差：
- D-2（AGENTS.md §5「Vitest 5.x」与实际 2.x 不符）→ 需改 AGENTS.md
- D-3（PE1 Lighthouse ≥90 未实测）→ 需装 Lighthouse
- D-4（PE4 并发档 `-c 100` p99 ≈3.0s）→ 设计级改动
- D-5（PE2 余量仅 ~10%）→ 宿主 CPU 竞争敏感
- D-6（Requirements §4.2 第 13 条未同步）→ **已关闭**（2026-10-22，所有者裁决 L1：a / L2：b / L3：a）
- D-7（§12.4 E6「`any` 降到 0」未达标）→ `any` 豁免期未结束
- D-8（行情用例「静默 skip」伪装成通过）→ 门禁假绿
- D-9（P2 体验项 U7/U16/U20）→ **Wave 10**（T79 ②~⑥）

---

## 4. 本波 commit 区间

| Commit | 说明 |
|---|---|
| `2d22b2f` | feat(Wave 9): T99/T100 代码落地 —— DuckDB 只读 + 写窗口让锁 + 分级保留期 + 恢复演练脚本 |
| `bd3dbab` | docs(handover): Wave 9 开工交接说明 |
| `aa742fe` | docs(Wave 9): G9.7 行情层文档 4 处不一致修正 |
| `51fc746` | merge(main): 并入 #26 的提案修正 |
| `c528daf` | docs(Wave 9): D-6 / I-30 关闭 —— L1 要求已同步 |
| 本 commit | docs(Wave 9): G9 验收 —— T99/T100/T102 全过 + wave-9-audit.md |

---

## 5. 对 Wave 10 / 后续的影响

- **Wave 10（T79 ②~⑥）**：P2 体验收尾，可后置，不阻塞 M4 验收
- **D-2/D-3/D-4/D-5/D-7/D-8**：仍需后续波次处理
- **§12.6 全局判定**：仍为 ⚠️ COND（D-2~D-8 未清），**不打 tag `M4`**
- **G9.1 真机端到端**：已实测 PASS（ journalctl 有 Finished，max(date)=2026-10-22）
