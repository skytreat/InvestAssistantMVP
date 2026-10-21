# 提案：行情更新链路修复（新增 T 任务 + §13 偏差登记）

> 🔴 **本文档性质**：`docs/audit/` 是「证据层」。本文件**不新增任何事实定义、不复述技术契约**，
> 只做三件事：① 汇总 2026-10-21 实测到的**三条新发现**（附原始证据）；
> ② 给出**拟新增的 T 任务**（草案，待所有者裁决后才进 plan §5）；
> ③ 给出**拟登记的 §13 偏差条目**（草案）。
>
> ⚠️ **本文档不是执行依据**。落地前需：
> ① 所有者裁决 §13 新条目的编号与级别；
> ② 裁决后由主 agent 把 T 任务写进 `docs/client/code_implementation_plan_v2.md` §5 + §12.7 Gate + §13.4；
> ③ 需要改 SDD/ADR 的部分，走 `docs/adr/` 归档。
>
> **快照时间**：2026-10-21
> **实测主机**：`instance-20261006-1644`（OCI ARM，Linux aarch64）
> **真库**：`/opt/invol/quotes.duckdb`（1.24GB，1,244,147,712 B）

---

## 0. 一句话总览

> **行情增量更新的「二进制机制」是好的（增量语义已实测证实），坏的是「Node 侧持锁」与「部署态」两处。**
>
> **四条新发现**：
> ① 🔴 **Fastify 常驻持锁 ⇒ 装好 timer 也必然失败**（plan 完全未覆盖；**修复方向已实测验证可行**）；
> ② 🟠 **mini 库跑不了 tdx2db**（缺 `_meta` + 抽样语义会被冲垮）；
> ③ 🟠 **F8 的验收载体是「读文件」⇒ G5.1 已判过假绿**；
> ④ 🟠 **4 段 cron 未设 `preventOverrun` + 真库单条校验 SQL 3.27s ⇒ 段间重叠**（与 ① 叠加会连锁自愈失败）。

**§13 拟登记 4 条**：1 条阻断级（B-15）+ 3 条重要级（I-26 / I-27 / I-28）。
**拟新增 4 个 T 任务**：T99（锁模型）/ T100（部署态）/ T101（mini 库策略）/ T102（F8 验收真触发 + cron 重叠）。

---

## 1. 背景：Wave 7 / Wave 8 为什么不覆盖

| 修复项 | Wave 7（T75~T77/T79） | Wave 8（T77/T78/T86b/T89b） | 判定 |
|---|---|---|---|
| 装 systemd unit（`tdx2db-update.timer` 从未安装） | ❌ | ❌ | plan §1 行 34 自认「真机部署验证」**仍未覆盖** |
| `User=invol` 用户不存在 | ❌ | ❌ | `deploy/deploy.sh:16` 会 `useradd`，但脚本**从未在本机执行过** |
| `/opt/invol` 属主 `root:root`（DuckDB WAL 不可建） | ❌ | ❌ | `deploy.sh:63` 的 `chown` 未执行 |
| 数据落后 6 个交易日（停在 `2026-10-12`） | ❌ | ❌ | 无任何 T 负责「重跑一次把数据补齐」 |
| **Fastify 常驻持 DuckDB 锁** | ❌ | ❌ | **plan / §13 / ADR 全部无记载** |
| T75 ⑤ 手动触发行情更新按钮 | ✅ 沾边 | — | 但后端 `POST /api/admin/rerun-quotes`（`routes/admin.ts:209`）+ `services/quoteRerun.ts` 三级降级**早已存在**；Wave 7 只加按钮 + 二次确认 |
| F8「5 段自动化触发」验收 | — | ⚠️ **假绿** | `tests/integration/cronSequence.test.ts:144,171` 只 `readFileSync` unit **文件内容** + 比对 cron 字符串，**不验证真实触发** |

> 🔴 **T75 ⑤ 交付的「立即补跑行情更新」按钮，在当前机器上点下去必然走完降级链后返回 SKIP**：
> `systemd-run`（实测 `Interactive authentication required`，需 root）→ `systemctl start`（unit 不存在）→
> 直接 exec（`/opt/invol` 不可写，实测 `touch .wal` → `Permission denied`）。

---

## 2. 三条新发现（实测证据）

### 2.1 🔴 发现 1 —— Fastify 常驻持锁 ⇒ 装好 timer 也必然失败

#### 2.1.1 代码现状

| 位置 | 实测内容 |
|---|---|
| `apps/backend/src/db/duckdb.ts:81` | `DuckDBInstance.create(resolveDuckDBPath())` —— **未传 `access_mode`**，即默认读写模式 |
| `apps/backend/src/db/duckdb.ts:57-76` | instance 挂 `globalThis.__investDuckDBSingleton__`，**进程内单例** |
| `apps/backend/src/db/duckdb.ts:90-102` | `closeDuckDBInstance()` 存在，但**生产代码零调用点**（`grep apps/backend/src` 仅命中定义处 1 次） |
| `apps/backend/src/server.ts:68-71` | SIGTERM 只 `process.exit(0)`，**不关 DuckDB** |
| `apps/backend/src/services/backup.ts:94` | 另开一个 `DuckDBInstance.create(duckdbPath)` —— ⚠️ **实测：同进程第二个 instance 不冲突**（DuckDB 允许同进程多 instance 共享同一文件，见 §2.1.5 实验 4），故此项**不是**独立缺陷；改 ① 后需一并复核 |

> ⚠️ 注释与现实相反：`duckdb.ts:6` 写「**只有 SELECT 权限**（AGENTS.md 硬约束：Fastify 进程禁止写入 DuckDB）」，
> 但 `access_mode` 未指定 → DuckDB 按**可写**模式打开（实测会生成 `.wal`）。
> 这同时违反 **AGENTS.md:376**（只有 SELECT 权限）与 **AGENTS.md:378**（按需打开关闭，不常驻连接）。

#### 2.1.2 实测：锁由 instance 持有，跨进程必然冲突

```console
# 实验 1：默认模式（复刻 duckdb.ts:81）持锁 → 第二个进程读写全失败
$ node defholder.js &        # DuckDBInstance.create(path)  ← 无 access_mode
  第二个进程 READ_ONLY  => FAILED: IO Error: Could not set lock on file
                               "…/deftest.duckdb": Conflicting lock is held in
                               /usr/bin/node (PID 696275) by user ubuntu.
  第二个进程 READ_WRITE => FAILED: 同上

# 实验 2：只改 access_mode='READ_ONLY' 也不够 —— 持锁者仍阻塞写入方
$ node roholder.js &         # access_mode: 'READ_ONLY'
  第二个进程 READ_WRITE => FAILED: Conflicting lock …
  第二个进程 READ_ONLY  => OPEN OK

# 实验 3：锁由 instance 持有，关闭 connection 不释放
$ node instonly.js           # conn.closeSync() 后 instance 仍在
  第二个进程 READ_WRITE => FAILED: Conflicting lock …
```

#### 2.1.3 实测：真 tdx2db 二进制被 Node 侧持锁挡住

```console
$ node -e "…DuckDBInstance.create('/tmp/opencode/prodlock.duckdb')… # 常驻 instance"
$ tdx2db cron --dburi 'duckdb:////tmp/opencode/prodlock.duckdb'
🛑 错误: failed to connect to database: database/sql/driver: could not connect
   to database: IO Error: Could not set lock on file
   "/tmp/opencode/prodlock.duckdb": Conflicting lock is held in
   /usr/bin/node (PID 696275) by user ubuntu.
```

#### 2.1.4 性能代价实测（决定「按需开关」是否可行）

| 方案 | 实测 |
|---|---|
| 长驻单例 + 复用 connection（现状） | open **29ms**；5 次查询合计 **5ms** |
| 真·按需（每次 open instance + conn + close） | 5 次合计 **231ms**（均摊 **46.2ms/次**） |

> ⇒ 「每次查询都开关」会给每次 API 请求加 ~46ms，与 **PE4（p99 < 200ms）** 冲突。
> ⇒ 因此修复方向应是「**长驻但只读**」+「**写窗口前后显式释放/重开**」，而非无条件开关。

#### 2.1.5 ✅ 修复方向已被实测验证可行（**关键正面结论**）

```console
# 实验 4：同进程第二个 instance（复刻 backup.ts:94）—— 不冲突
$ node samproc.mjs
同进程第二 instance => OPEN OK, 读到行数 = 1

# 实验 5：释放 instance 后，真 tdx2db 二进制立刻拿到锁并开始干活
$ node fixcheck.mjs
[1] Fastify 侧 instance 持有中（模拟现状）
    tdx2db => Command failed: …（Conflicting lock）
[2] 已 closeDuckDBInstance()（模拟修复后）
    tdx2db => 🟡 00010103 数据尚未发布
              🟡 00010104 数据尚未发布 …
              ← 错误码 00010103 等是「该交易日数据尚未发布」，
                说明 tdx2db 已成功连上库并进入拉取流程（不再是锁错误）
```

> ✅ **结论：只要在 tdx2db 写入前调用 `closeDuckDBInstance()`，tdx2db 即可正常写库。**
> ⇒ T99 的技术可行性**已被实测证实**，不是纸面推演。
> ⚠️ 同时说明：`🟡 数据尚未发布` 是**非致命**提示（exit code 非 0 但流程继续），
> 说明 tdx2db 对「部分交易日无数据」是容错的 —— 这条对本项目的**「非交易日不出数据」**场景是利好。

---

### 2.2 🟠 发现 2 —— mini 库跑不了 tdx2db（且语义会被冲垮）

#### 2.2.1 mini 库缺 `_meta` ⇒ 直接被拒

```console
$ tdx2db cron --dburi 'duckdb:////tmp/opencode/minicron.duckdb'
🛑 错误:
数据库 schema 版本缺失 (需要: v6.x)
请阅读 https://github.com/jing2uo/tdx2db/releases 了解迁移方式
```

- mini 库的 10 张表由 `scripts/make-mini-duckdb.mjs:91-102` 的 `TABLES` 常量定义，**不含 `_meta`**；
- `manifest.json` 的 `tableDdl` 同样无 `_meta`；
- 真库 `_meta` 内容实测：`schema_version = 6.0`。

#### 2.2.2 强行补 `_meta` 后，抽样语义被冲垮

```console
# 手工补 _meta.schema_version='6.0' 后跑 tdx2db cron（仅 /tmp 副本，未动真库/仓库库）
原始 mini :  202 标的 /  46,528 行 / max(date)=2026-10-12
补跑 5 分钟后: 11,863 标的 / 118,962 行 / max(date)=2026-10-21
```

- `raw_symbol_class` 从 **250 只**变成 **11,863 只**（全市场）；
- mini 库赖以成立的「真库**逐位一致子集**」前提（ADR-008 §2.3 两层开关的 `numeric` 层；原文见 `apps/backend/tests/_marketData.ts:33`）**当场作废**。

#### 2.2.3 但增量语义被证实了（正面结论）

| 项 | 实测 |
|---|---|
| 是否全量重拉重写 | **否** —— `min(date)` 保持 `2025-10-14` 不变，只**追加** `2026-10-13`~`2026-10-21` |
| 二进制符号表佐证 | `workflow.pullDateRange` → `database/duckdb.(*DuckDBDriver).GetLatestDate`（SQL `SELECT date FROM %s ORDER BY date`）→ `workflow.executeUpdateDaily` |
| 日志字符串 | `no new daily data` / `no new basic data` / `1min data imported` / `factors calculated` / `gbbq data imported` |
| 交易日语义 | `workflow.(*TradingCalendar).IsTradingDay` / `IsHoliday` / `IsWeekend` / `LastTradingDayOnOrBefore` |

#### 2.2.4 结论

> **mini 库的正确姿势不是喂 tdx2db**，而是
> **真库更新 → `make-mini-duckdb.mjs extract` 重抽 Parquet → 提交 Parquet → CI 现 build**。
> 这正是 ADR-008 §3「迷你库会过期 → 固定快照 + 一键重生成脚本」的设计，
> 但**目前没有定时化 / 没人负责触发**。

---

### 2.3 🟠 发现 3 —— F8 的验收载体是「读文件」，G5.1 已判过假绿

```console
# apps/backend/tests/integration/cronSequence.test.ts
:144  const content = fs.readFileSync(timerPath, 'utf-8');   # 读 deploy/tdx2db-update.timer 文件
      expect(content).toMatch(/^OnCalendar=\*-\*-\* 17:00:00$/m);
      expect(content).toMatch(/^Unit=tdx2db\.service$/m);
:171  （同上，重复）
```

- 全仓 `grep systemctl apps/backend/tests/` → **0 命中**（`quoteRerun.test.ts` 的 `systemctl` 全是 **mock**）；
- 该用例验证的是「**仓库里的 unit 文件内容对不对**」，不是「**本机 timer 是否装了、是否触发过**」；
- 而 `docs/audit/wave-5-audit.md:17` 的 **G5.1（🔒 硬阻断）判 F8 PASS** —— 依据正是「10 个指定用例名全部是真实 `it()`」。

> 🔴 **G5.1 判的是「载体存在」，不是「功能可用」。** 这是 §12.7「静默污染」机制的一个实例：
> 载体在，功能不在，门禁仍绿。

---

### 2.4 🟠 发现 4 —— 4 段 cron 未设 `preventOverrun`，17:01 校验段在真库上单条 SQL 就要 3.27s

#### 2.4.1 现象

```console
# apps/backend/src/services/scheduler.ts —— 4 段 AsyncTask 全部未设 preventOverrun
:105  new AsyncTask('datacheck-c1-c12', async () => { …   # '1 17 * * 1-5'
:139  new AsyncTask('signal-generate',     async () => { …   # '2 17 * * 1-5'
:214  new AsyncTask('dividend-import',     async () => { …   # '3 17 * * 1-5'
:245  new AsyncTask('backup',              async () => { …   # '5 17 * * 1-5'
grep -c preventOverrun apps/backend/src/services/scheduler.ts   →  0
```

> `toad-scheduler` README:350 —— `preventOverrun?: boolean`：「if set to true, prevents a second instance of the task from being fired up while the first one is still executing」。**默认 false。**

#### 2.4.2 真库上单条校验 SQL 的实测耗时

```console
$ node -e "…DuckDBInstance.create('/opt/invol/quotes.duckdb', {access_mode:'READ_ONLY'})…
           SELECT COUNT(DISTINCT symbol) FROM v_stock_qfq WHERE date='2026-10-12'"
C1_SQL（真库, v_stock_qfq 物化）耗时 = 3272 ms
```

- C1 查 `v_stock_qfq`（视图）⇒ 真库 **3.27s**（T60c 已把 `marketData.ts` / `dataCheck.ts` 改成基表下推，但 **`validator.ts` 的 C1/C6 仍走视图**）；
- C1~C12 共 12 条，其中多条打视图 ⇒ **单轮校验在真库上必然是分钟级**；
- 段间隔仅 **60 秒**（17:01 → 17:02）⇒ **17:02 信号生成极可能在 17:01 校验未结束时触发**；
- 两个 job 同时打 DuckDB（同一 instance、同一只读连接池）⇒ 叠加 CPU 压力 + 互相拖慢。

#### 2.4.3 结论

> 🔴 **17:01 校验段与 17:02 信号段存在重叠风险**，且重叠会**同时拖慢两段**。
> ⚠️ 这条与「写窗口」问题**叠加**：若 T100 把 tdx2db 装好、17:00 真库开始写入，
> 而 17:01 的校验又因 §2.1 的持锁问题读不到新数据 ⇒ 校验必然判 ERROR/WARN ⇒
> 触发 `runDatacheckWithRerun`（`scheduler.ts:48`）⇒ **再跑一次 tdx2db** ⇒ 与 17:00 的 tdx2db 抢锁。
> ⇒ 三条问题（B-15 持锁 / I-26 部署态 / 本条重叠）**必须一起修**，否则修了任一条仍会自愈失败。

---

## 3. 拟新增的 T 任务（**草案，待裁决**）

> ⚠️ 编号 **T99~T102** 是按现有最大编号 T98 顺延的**占位**；最终编号由所有者指定。
> ⚠️ 另注：仓库存在并行分支 **`docs/v3-spec`（PR #25，DRAFT）**，内含 `code_implementation_plan_v3.md` 与 **ADR-009~012** ⇒ 本提案的编号与决策点需与该分支**对齐后再定**（尤其 ADR 编号应为 **ADR-013**）。
> Wave 归属建议见每条的「建议归属」列。

### T99 —— 🔴 DuckDB 访问模型改造（只读 + 写窗口让锁）

| 项 | 内容 |
|---|---|
| **建议归属** | **Wave 8**（必须在 T78 最终审计前落地 —— F8/PE1-PE5 都依赖它） |
| **前置** | 无（可与 Wave 7 并行） |
| **交付物** | ① `db/duckdb.ts`：`DuckDBInstance.create(path, { access_mode: 'READ_ONLY' })` —— 落实 AGENTS.md:376<br>② 写窗口协调：新增「**行情更新进行中**」状态位 —— tdx2db 写入期间，Node 侧**主动 `closeDuckDBInstance()`** 并让 API 返回可重试错误（503 / `RETRY_AFTER`），写入结束后**惰性重开**<br>③ `server.ts` SIGTERM：补 `closeDuckDBInstance()` 后再退出<br>④ `services/backup.ts:94`：第二个 instance 同样改只读（当前它能开是因为同进程同锁域，但与 ① 冲突后需一并处理）<br>⑤ 写窗口的**触发方式**待裁决（三选一，见 §5 决策点 D-2） |
| **测试要点** | ① 单测：写窗口内 `queryDuckDB` 抛结构化「行情更新中」错误，窗口结束后恢复<br>② 集成：`closeDuckDBInstance()` 后另一进程能 RW 打开同一文件（用 `/tmp` 临时库，不碰真库）<br>③ 回归：现有全部行情用例仍绿（`apps/backend/tests/unit/duckdbLeak.test.ts` 等 12 个受影响的用例） |
| **卡点** | 🔴 写窗口的判定信号从哪来？tdx2db 是**外部进程**，Node 侧无从得知它何时开始/结束写 ⇒ 必须有一个跨进程信号源（见 §5 D-2） |

### T100 —— 🔴 部署态落地（unit + 用户 + 权限 + 数据回填）

| 项 | 内容 |
|---|---|
| **建议归属** | **Wave 8**（或独立「Wave 7.5 · 部署态」，见 §5 D-1） |
| **前置** | T99（否则装好了也跑不通） |
| **交付物** | ① 装 `deploy/tdx2db.service` + `deploy/tdx2db-update.timer` → `/etc/systemd/system/` + `daemon-reload` + `enable --now`<br>② 解决 `User=invol` 不存在（`useradd -r -s /bin/false invol` 或改 unit 为运行用户）<br>③ 解决 `/opt/invol` 不可写（DuckDB 需在同目录建 `.wal`）<br>④ 首次 `tdx2db cron` **留痕**（stdout/stderr 重定向到文件，禁止再出现「无日志可查」）<br>⑤ **数据回填**：把 `2026-10-13`~`2026-10-21` 补齐<br>⑥ 修 `docs/deploy.md`（当前描述的 17:00→17:05 链路与实况脱节） |
| **测试要点** | ① `systemctl is-enabled tdx2db-update.timer` == `enabled`<br>② `systemctl list-timers` 显示下次触发 = 明日 17:00<br>③ `journalctl -u tdx2db.service` 有成功记录且 `exit_code=0`<br>④ 真库 `max(raw_kline_daily.date)` == 最近交易日<br>⑤ `tdx2db` 端到端跑通后**真库无 `.wal` 残留**、文件大小/行数合理 |
| **卡点** | 🔴 需 **root** 与**改动 `/opt/invol` 属主** ⇒ 属**生产环境变更**，须所有者授权；<br>⚠️ 与 AGENTS.md「跑测试前必须先停掉后端」冲突 —— 17:00 窗口内 Node 持锁会挡住 tdx2db（这正是 T99 要解决的） |

### T101 —— 🟠 mini 库策略修正（明确「不喂 tdx2db」+ 重生成触发）

| 项 | 内容 |
|---|---|
| **建议归属** | Wave 8（与 T100 同批，因为重抽依赖真库已更新） |
| **前置** | T100 ⑤（真库已回填到最新交易日） |
| **交付物** | ① **明确 mini 库不由 tdx2db 更新** —— 在 `scripts/make-mini-duckdb.mjs` / `apps/backend/tests/fixtures/mini-market/README.md` 写清「mini 库是**只读快照**，喂 tdx2db 会因缺 `_meta` 被拒、强行补 `_meta` 会把 250 只抽样冲成全市场」<br>② **重生成流程落地**：`真库更新 → extract 重抽 Parquet → 提交 Parquet → CI 现 build` 的**触发方式**（手动脚本 / 定期任务 / 随 T100 一起做）<br>③ CI 档（`MARKET_DATA_MODE=ci`）复用同一路径，不新增第二套 |
| **测试要点** | ① `build` 后 mini 库行数与 `manifest.json` 一致<br>② mini 库**仍无** `_meta` 表（防止有人补上后误跑 tdx2db）<br>③ 抽样标的数仍 == 250、class 比例仍符合 ADR-008 §2.1 规格 |
| **卡点** | ⚠️ 重抽 Parquet 会改动仓库内 12 个二进制文件 ⇒ 每次真库更新都会产生 diff，需要「何时重抽」的策略（见 §5 D-3） |

### T102 —— 🟠 F8 验收升级（真触发替代「读文件」）+ cron 段重叠防护

| 项 | 内容 |
|---|---|
| **建议归属** | Wave 8（T78 之前） |
| **前置** | T100（否则真机上没有可触发的 timer） |
| **交付物** | ① `cronSequence.test.ts` 的 F8 用例**分层**：<br>　　- **配置层**（现有，CI 可跑）：unit 文件内容 + cron 表达式 —— 保留<br>　　- **运行层**（新增，**仅本地/真机**，CI 跳过）：`systemctl is-enabled` / `is-active` / `list-timers` / `journalctl` 有触发记录<br>② 该分层必须在 **SDD §12.5 F8 行**同步登记（否则 SDD 与实际载体不符）<br>③ 门禁 `G8.3` 增列「F8 运行层证据」<br>④ **`services/scheduler.ts` 四个 `AsyncTask` 加 `preventOverrun: true`**（消除 17:01/17:02 段重叠）<br>⑤ 评估 `validator.ts` 的 C1/C6 是否从视图改基表下推（真库 3.27s ⇒ 缩短单轮校验）—— ⚠️ 属 T60c 遗留范围，**须所有者确认是否并入** |
| **测试要点** | ① 配置层用例仍全绿（CI）<br>② 运行层用例在真机 PASS、在 CI `skip` 且 skip 原因写明<br>③ **反向验证**：把 timer 停掉后运行层用例必须 FAIL（防止再造一个恒绿）<br>④ `preventOverrun` 生效性：模拟长任务时，同一 job 第二次触发被跳过<br>⑤ 真库上单轮 C1-C12 耗时落在 60s 内（否则段间仍会重叠） |
| **卡点** | ⚠️ 运行层用例**不能在 CI 跑**（CI 无 systemd）⇒ 需在 §12.7 豁免规则中登记「CI 环境无法验证运行层」，否则 G8.3 会因「无载体」判 FAIL；<br>⚠️ ⑤ 若要动 `validator.ts` 的 SQL，须复核 SDD §5.7 C1/C6 的 SQL 原文是否也要同步 |

---

## 4. 拟登记的 §13 偏差条目（**草案，待裁决编号与级别**）

> §13.1 阻断级现有 B-1~B-14（全部已裁决）；§13.2 重要级现有 I-1~I-25；§13.3 次要级现有 S-1~S-10。
> 下列 4 条为**新增**，编号待所有者指定。

### B-15（拟）—— 🔴 阻断级：Fastify 常驻持有 DuckDB 写锁，行情更新链路结构性不可用

| 现状（实测） | 真相源 | 建议 |
|---|---|---|
| ① `db/duckdb.ts:81` `DuckDBInstance.create(path)` **未传 `access_mode`** → 默认可写模式；instance 挂 `globalThis` 单例；`closeDuckDBInstance()` 生产零调用；`server.ts:68` SIGTERM 直接 `process.exit(0)`<br>② 实测：Node 侧持锁期间，**真 tdx2db 二进制**报 `failed to connect to database: IO Error: Could not set lock on file … Conflicting lock is held in /usr/bin/node (PID …)`<br>③ 实测：改 `access_mode:'READ_ONLY'` 仍阻塞第二个进程的 RW 打开<br>④ 违反 **AGENTS.md:376**（Node 只有 SELECT 权限）与 **AGENTS.md:378**（按需打开关闭，不常驻连接）——注释自称「只有 SELECT 权限」但代码是可写<br>⑤ 连带：`services/backup.ts:94` 在同进程另开第二个 instance —— ⚠️ **实测同进程不冲突**，故非独立缺陷 | **AGENTS.md:376/378** + **SDD §2 架构图（行情层只读）** + **SDD §5.1 时序图（17:00 写 → 17:01 读，必须能共存）** | 🔴 **派任务 → T99**。这是**先于部署态**的独立根因：不修它，装好 timer 也跑不通。<br>✅ **修复方向已实测验证可行**：调用 `closeDuckDBInstance()` 后，真 tdx2db 二进制立刻拿到锁并进入拉取流程（§2.1.5 实验 5）—— 不是纸面推演。<br>⚠️ SDD §5.1 场景 4（`SDD.md:1563`）写「DuckDB MVCC 自动处理 reader/writer 共存」—— **实测证伪**（DuckDB 是单写者文件锁，非 MVCC 共享），该行需一并修正 |
| 证据 | `docs/audit/proposal-market-update-pipeline-fix.md` §2.1 | 拟裁决：**需所有者确认**（改代码 vs 改 SDD 场景 4 的表述，两者都要） |

### I-26（拟）—— 🟠 重要级：行情更新的部署态从未落地，数据落后 6 个交易日

| 现状（实测） | 真相源 | 建议 |
|---|---|---|
| ① `tdx2db-update.timer` / `tdx2db.service` **从未安装**（`systemctl cat` → `No files found`；`list-unit-files 'tdx*'` → 0）；`journalctl -u tdx2db.service` → `-- No entries --`；无 cron / at / user-timer 替代通道<br>② `User=invol` **不存在**（`id invol` → no such user）<br>③ `/opt/invol` 属主 `root:root` 755 → DuckDB 需在同目录建 `.wal` → 实测 `Permission denied`<br>④ `deploy/deploy.sh` **从未在本机执行过**（`/opt/invol/secrets`、`/opt/invol/plugins/strategies` 不存在）<br>⑤ 真库 `max(raw_kline_daily.date)` = **2026-10-12** ⇒ 落后 6 个完整交易日（10-13/14/15/16/19/20，**非周末/节假日误报**）<br>⑥ `docs/deploy.md` 描述的 17:00→17:05 链路与实况脱节 | **Requirements §4.2 #12**（收盘后定时自动化）+ **SDD §5.1 五段时序** | 🔴 **派任务 → T100**。<br>⚠️ plan §1 行 34 已自认「真机部署验证（systemd unit / Caddy HTTPS）」**仍未覆盖** ⇒ 本条是那条自认缺口的**具体化** |
| 证据 | 同上 §2.1 前置 / 运行时侧调查（`journalctl` / `systemctl` 原始输出） | 拟裁决：**需所有者授权**（涉及 root 与 `/opt/invol` 属主变更） |

### I-27（拟）—— 🟠 重要级：F8「5 段自动化触发」的验收载体只验「unit 文件内容」，G5.1 已判过假绿

| 现状（实测） | 真相源 | 建议 |
|---|---|---|
| ① `tests/integration/cronSequence.test.ts:144,171` 只 `readFileSync('deploy/tdx2db-update.timer')` 后比对正则 —— 验证的是**仓库文件内容**，不是**本机 timer 是否装了/触发过**<br>② 全仓 `grep systemctl apps/backend/tests/` → **0 命中**（`quoteRerun.test.ts` 全 mock）<br>③ `docs/audit/wave-5-audit.md:17` 的 **G5.1（🔒 硬阻断）据此判 F8 PASS**<br>④ 已知实际状态：timer 未安装、数据落后 6 个交易日 ⇒ **功能不可用而门禁绿** | **SDD §12.5 F8**（「每日 5 段自动化正确触发」）+ **§12.7 硬阻断语义** | 🔴 **派任务 → T102**（运行层用例 + 分层登记）。<br>⚠️ 与 §12.7「静默污染优先」同型：**载体存在 ≠ 功能可用**。这是 gate 机制本身的一个盲区，登记后可考虑加一条通用规则 |
| 证据 | 同上 §2.3 | 拟裁决：**需所有者确认**（是否把「运行层」写进 SDD §12.5，还是仅在 §12.7 门禁层加） |

### I-28（拟）—— 🟠 重要级：4 段 cron 未设 `preventOverrun`，真库上单条校验 SQL 3.27s ⇒ 17:01/17:02 段重叠

| 现状（实测） | 真相源 | 建议 |
|---|---|---|
| ① `services/scheduler.ts:105,139,214,245` 四个 `AsyncTask` **全部未设 `preventOverrun`**（`grep -c` = 0）；`toad-scheduler` README:350 该选项**默认 false**<br>② 真库实测：`SELECT COUNT(DISTINCT symbol) FROM v_stock_qfq WHERE date='2026-10-12'`（= C1 的 SQL 形态）耗时 **3272ms** —— `validator.ts` 的 C1/C6 **仍走视图**（T60c 只改了 `marketData.ts` / `dataCheck.ts`）<br>③ 段间隔仅 **60 秒**（17:01 → 17:02）⇒ C1~C12 单轮在真库上分钟级 ⇒ **17:02 信号段极可能在 17:01 未结束时触发**<br>④ 连锁效应：若 17:00 的 tdx2db 正在写库（受 B-15 持锁影响），17:01 校验读不到新数据 ⇒ 判 ERROR/WARN ⇒ 触发 `scheduler.ts:48` 的 `runDatacheckWithRerun` **再跑一次 tdx2db** ⇒ 与 17:00 的进程抢锁 ⇒ **自愈必然失败** | **SDD §5.1 五段时序**（17:00 写 → 17:01 校验 → 17:02 信号，按序执行）+ **Requirements §7.1**（C1 失败级别 ERROR ⇒ 自动触发补跑） | 🔴 **派任务 → T102**（与 F8 验收升级同批）。<br>⚠️ 修 B-15 / I-26 而不修本条 ⇒ **自愈链路仍会失败**（三条必须一起修） |
| 证据 | 同上 §2.4 | 拟裁决：**需所有者确认**（是否同时把 `validator.ts` 的 C1/C6 从视图改基表下推 —— 那属 T60c 的遗留范围） |

### 4.1 附：行情层文档（SDD L3 / `tdx2db_schema.md` L3.5）与实测的 **4 处不一致**

> ⚠️ 这 4 处**不是代码缺陷** —— 代码侧（`validator.ts:236-245`、`marketData.ts:503-572`）**已按实测修正**。
> ⇒ **不占用 §13 编号**，建议随 T99 / T102 的文档同步动作一并修正。
> ⚠️ 但第 2、3 处**有功能后果**（C3 的 ST 状态校验无字段可用）⇒ 需确认 C3 的实际实现口径。

| # | 文档写的 | 实测 | 位置 |
|---|---|---|---|
| **1** | `raw_holidays` = **交易日历（有行 = 交易日）** | **休市日黑名单** —— 真库 680 行中，落在 2020~2030 区间且**有行情 / 有日线的 = 0 行** | `docs/client/SDD.md:1276` / `:1580` / `:2010-2021`（C2 SQL）/ `:2752`；`docs/tdx2db_schema.md:125-131` / `:257`（陷阱表把 `date IN (SELECT date FROM raw_holidays)` 列为「✅正确写法」—— **方向正好写反**） |
| **2** | `raw_symbol_class` 有 **`is_listing` / `is_st`** 两列 | **只有 `symbol` / `class` 两列**（`DESCRIBE` 实测） | `docs/client/SDD.md:1038-1039`（DDL）/ `:1309`（表说明）；⚠️ 后果：C3「ST 状态一致性」**无字段可用** |
| **3** | `class` 实测值含 **`bond`** | **无 `bond`**；实际有 `stock` 6158 / `etf` 2839 / **`unknown` 1357** / **`block` 1128** / `index` 801 / **`bstock` 166** | `docs/client/SDD.md:1277`；`docs/tdx2db_schema.md:138` |
| **4** | `tdx2db cron --with-1min` | 真实 flag 是 **`--min`** —— `--with-1min` 被拒并打印帮助 | `docs/tdx2db_schema.md:29`（文档命令**不可执行**） |

> ✅ **代码侧无需改**（`validator.ts` 的 C2_SQL 与 `marketData.ts` 的 `resolveTargetTradeDate` 都已用「工作日 AND NOT IN raw_holidays」的**正确口径**）。
> ⇒ 本项是**纯文档修正**，但因为 SDD 是 L3 权威层，**不修就会被下一个实现者照抄出错**（这正是 AGENTS.md 记载的 B-14 同型事故）。

---

## 5. 需要所有者裁决的决策点

| # | 决策点 | 选项 | 建议 |
|---|---|---|---|
| **D-1** | T100（部署态）放哪个 Wave | ① 独立「Wave 7.5」② 并入 Wave 8 ③ 单独一个 PR 不占 Wave | ② **并入 Wave 8** —— T78 最终审计必须包含它，否则 M4 tag 会在「行情从未更新」的状态下打出 |
| **D-2** | **T99 的写窗口信号源**（Node 侧怎么知道 tdx2db 正在写？） | ① **文件哨兵**：`tdx2db.service` 加 `ExecStartPre/Post` 写/删 `/opt/invol/.tdx2db-writing`，Node 侧检测该文件即让锁<br>② **Node 侧主动探测**：改只读后，Node 用「尝试 RW 打开探测」判断（不现实）<br>③ **改为 Node 侧不做长驻**：每次查询开关（实测 +46ms/次，与 PE4 冲突）<br>④ **改 SDD 场景 4 的时序**：让 tdx2db 写库时 Fastify **整体停机**（17:00 停 → 写完起），与 systemd `ExecStartPre/Post` 联动 | ① **文件哨兵** —— 改动最小、跨进程可靠、不引入额外依赖；<br>✅ **无论选哪个，机制本身已实测可行**：调用 `closeDuckDBInstance()` 后 tdx2db 立刻拿到锁（§2.1.5 实验 5）⇒ 剩下的只是「谁来决定何时 close」；<br>⚠️ **SDD §5.1 场景 4 的「MVCC 自动处理 reader/writer 共存」必须改**（实测证伪） |
| **D-3** | mini 库重抽 Parquet 的触发策略 | ① 随 T100 手动做一次（简单，但会过期）② 定期自动重抽（每次产生 12 个二进制 diff）③ 只在 CI 跑 `extract`（需 CI 有真库 ⇒ 不可行） | ① **随 T100 做一次 + 写进 ADR-008 的「重生成触发」小节**；<br>⚠️ 长期看 ② 更正确，但需先解决「二进制 diff 进 git」的流程问题 |
| **D-4** | **行情层文档（SDD L3 + `tdx2db_schema.md` L3.5）与实测有 4 处不一致** —— 详见 **§4.1** | 见 §4.1 | 🔴 **修文档**（L3/L3.5 权威层）。<br>⚠️ 这些**不是**代码缺陷（代码侧 `validator.ts` / `marketData.ts` 已按实测修正）⇒ **不占用 §13.2 编号**，建议随 T99/T102 文档同步修正时一并处理。<br>⚠️ 但 `raw_symbol_class` 的 `is_st`/`is_listing` 缺失**有功能后果**（C3 ST 状态校验无字段可用）⇒ 需确认 C3 的实际实现口径 |
| **D-5** | 本提案的落地方式 | ① 裁决后由主 agent 直接写进 plan §5/§12.7/§13.4（改 L4 计划文档）② 先落 `docs/adr/ADR-013`（决策归档）再改 plan ③ 只留本提案，等 Wave 8 开工时再定 | ① + ② —— D-2 涉及「Node 与外部写进程的协调协议」，属**架构决策**，按 AGENTS.md 应进 `docs/adr/`。<br>⚠️ **编号注意**：ADR-009~012 已被 **PR #25（`docs/v3-spec`，DRAFT）** 占用 ⇒ 本提案对应的新 ADR 应为 **ADR-013**。若 PR #25 先合入，则以 `docs/adr/README.md` 的实际最大编号 +1 为准 |

---

## 6. 与既有文档的关系（避免层界违规）

| 本提案涉及的事实 | 归属层 | 应写在哪 | 本提案的动作 |
|---|---|---|---|
| 「Node 只读 + 写窗口让锁」的技术契约 | **L3 SDD** | `docs/client/SDD.md` §2 架构图 / §5.1 场景 4 | **不写在本提案**；裁决后改 SDD |
| 「Fastify 常驻持锁」这一缺陷现状 | L4 plan §13 | `code_implementation_plan_v2.md` §13.2 | 提案给出**草案条目**（B-15），裁决后进 plan |
| 「tdx2db.service 装哪、User 填谁」 | **L5 运维** | `docs/deploy.md` | **不写在本提案**；归 T100 交付物 |
| 「mini 库是只读快照、不可喂 tdx2db」 | **ADR**（决策） | `docs/adr/ADR-008`（修订）+ 夹具 README | 提案只给依据，修订由 T101 落地 |
| 「F8 运行层验收」 | L3 SDD §12.5 + L4 plan §12.7 | 两处 | 提案给草案，裁决后同步 |
| 实测原始数据 | **证据层** | 本文件 | ✅ 已在此 |

> ⚠️ **本提案刻意不复述 SDD 的技术契约内容**（表名列名、SQL、接口形状）——
> 那些只引用不重写（AGENTS.md「已有某一层定义了吗？→ 只引用，不复述」）。

---

## 7. 明确不在本提案范围内

| 项 | 归属 |
|---|---|
| mini 库作为测试夹具的**整体策略**（三档切换 / 两层开关） | **ADR-008**（已裁决，不动） |
| `tdx2db` 二进制自身的实现（Go 仓库） | **不在本仓库** |
| 备份覆盖面补全（`raw_gbbq` / `raw_holidays` / `raw_symbol_class` / `v_etf_*` 未被 `backup.ts` 导出） | 另立（本提案未覆盖，建议并入 T100 或独立） |
| `ENABLE_OCI_BACKUP` 远程备份 | **I-11 已裁决**「MVP 不交付远程备份」 |
| 深色模式 / CSS Module / 图表库 | V2 / 禁止（plan U21） |
| 板块表 0 行、名称覆盖 70% | **I-22 已登记**（随 T85b ④） |

---

## 8. 附录：本文档的复现命令

```bash
# §2.1.2 锁实验
cd /tmp/opencode
node defholder.js &   # 默认 access_mode 持锁
node -e "DuckDBInstance.create(path,{access_mode:'READ_ONLY'})"   # → Conflicting lock
node -e "DuckDBInstance.create(path,{access_mode:'READ_WRITE'})"  # → Conflicting lock
node instonly.js     # conn 已关、instance 仍在 → 仍 Conflicting lock

# §2.1.3 真二进制被挡
node -e "…create('/tmp/opencode/prodlock.duckdb')… # 常驻"
/usr/local/bin/tdx2db cron --dburi 'duckdb:////tmp/opencode/prodlock.duckdb'
# → failed to connect to database: … Conflicting lock is held in /usr/bin/node (PID …)

# §2.1.4 开销对比
node /tmp/opencode/perf.mjs
# → 长驻单例: open=29ms, 5 次查询=5ms
# → 按需开关: 5 次 open+query+close=231ms (46.2ms/次)

# §2.1.5 修复可行性 + 同进程多 instance
node /tmp/opencode/samproc.mjs   # → 同进程第二 instance => OPEN OK
node /tmp/opencode/fixcheck.mjs   # → close 后 tdx2db 拿到锁（🟡 数据尚未发布 = 已进拉取流程）

# §2.2.1 mini 库缺 _meta
/usr/local/bin/tdx2db cron --dburi 'duckdb:////tmp/opencode/minicron.duckdb'
# → 数据库 schema 版本缺失 (需要: v6.x)

# §2.3 F8 只读文件
grep -n "readFileSync(timerPath" apps/backend/tests/integration/cronSequence.test.ts
grep -rn "systemctl" apps/backend/tests/ | grep -v mock      # → 0 命中

# §2.4 cron 重叠
grep -c preventOverrun apps/backend/src/services/scheduler.ts   # → 0
# 真库单条 C1 SQL 耗时
node -e "…DuckDBInstance.create('/opt/invol/quotes.duckdb',{access_mode:'READ_ONLY'})…
         SELECT COUNT(DISTINCT symbol) FROM v_stock_qfq WHERE date='2026-10-12'"
# → 3272 ms

# 运行时侧（只读）
systemctl cat tdx2db-update.timer tdx2db.service --no-pager     # → No files found
journalctl -u tdx2db.service --no-pager -n 200                 # → -- No entries --
id invol; stat -c '%A %U:%G %n' /opt/invol /opt/invol/quotes.duckdb
ls -l /proc/*/fd 2>/dev/null | grep quotes.duckdb
duckdb -readonly -box /opt/invol/quotes.duckdb \
  -c "SELECT max(date) FROM raw_kline_daily"
```

---

## 9. 本提案的实测足迹（可审计）

| 动作 | 目标 | 是否写生产数据 |
|---|---|---|
| 读 `/opt/invol/quotes.duckdb`（只读模式） | 数据新鲜度 / 表结构 / C1 耗时 | ❌ 否 |
| `tdx2db cron` 打 `/tmp/opencode/*.duckdb` **副本** | 增量语义 / 锁行为 / `_meta` 要求 | ❌ 否（仅 `/tmp` 副本） |
| `tdx2db cron` 打 `/opt/invol/quotes.duckdb` | **未执行** | — |
| `systemctl` / `journalctl` / `id` / `stat` | 部署态 | ❌ 只读 |
| 代码 / 文档阅读 | 全部结论的 `文件:行号` 锚点 | ❌ 只读 |
| 修改仓库文件 | **仅本文档**（`docs/audit/proposal-market-update-pipeline-fix.md`，未跟踪） | — |

> ⚠️ **唯一被写入的 DuckDB 是 `/tmp/opencode/` 下的副本**；真库 `/opt/invol/quotes.duckdb` 全程只读。
> ⚠️ 真库的 `mtime` 保持 `2026-10-12 13:53:07`（与部署时一致）⇒ **本次调查未污染真库**。
