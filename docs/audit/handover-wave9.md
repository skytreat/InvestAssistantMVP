# Wave 9 开工交接说明（→ 新 session / 下一台机器）

> 生成时间：2026-10-22（Wave 8 合并后，PR #26 / #30 已合入 main）
> 上游：`docs/audit/proposal-market-update-pipeline-fix.md`（证据层）· `docs/adr/ADR-012-market-update-write-window.md`（决策归档）· `docs/audit/wave-8-audit.md`（G8 PASS，§12.6 判 COND）
> 目标读者：**接手 Wave 9 的 agent**（含上下文重置后的自己）

---

## 0. 当前状态（一句话）

`main` = `47cd280`，与 `origin/main` 同步，工作区 clean。Wave 9 **尚未开工**。Wave 7 / Wave 8 已全部合入（G7 7/7 PASS、G8 PASS，§12.6 判 ⚠️ COND）。Wave 9 是**行情更新链路修复**（部署态 + 跨进程写窗口），所有者已裁决 D-1~D-5，落地为 ADR-012 + plan §5 Wave 9 + §12.7 G9 + §13.1 B-15 + §13.2 I-34/I-35/I-36。

| 载体 | 状态 |
|---|---|
| `main` | `47cd280`，与 `origin/main` 同步，工作区 clean |
| PR #26 | **MERGED**（提案文档修正，证据层）|
| PR #30 | **MERGED**（ADR-012 + plan §5 Wave 9 + §12.7 G9 + §13.1 B-15 + §13.2 I-34/I-35/I-36）|
| PR #25 (`docs/v3-spec`) | OPEN · DRAFT（V3 规格，ADR-009~012 已重编号为 ADR-013~016）|
| PR #29 | CLOSED（内容被 #30 取代）|
| 本地分支 | `main` + `feature/wave9-market-update`（已无未推送内容）|

**所有者最新裁决（2026-10-22）**：`L1：a. L2：b. L3：a. 都并入wave9` —— 即：
- **L1** = Requirements §4.2 #13 改写（远程 90 天 → 仅本地），按 I-11 裁决对齐
- **L2** = 保留期分级（行情 7 天 / 业务 30 天，按备份类型分开判定）
- **L3** = 补恢复验证脚本 + 补备份覆盖面（DuckDB 的 `raw_gbbq` / `raw_holidays` / `raw_symbol_class` / `v_etf_*` 也导出）
- 全部并入 Wave 9

---

## 1. Wave 9 范围（G9）

**任务**：T99 / T100 / T102（plan §5「Wave 9 — 行情更新链路修复」）

| 任务 | 内容 | 优先级 |
|---|---|---|
| 🔒 **T99** | **DuckDB 访问模型改造（只读 + 写窗口让锁）**（§13.1 **B-15**）：① `access_mode: 'READ_ONLY'` ② 进程内写窗口标志 `inProcessWriting`（为真时 `getInstance()` 不得重建 —— 防止并发查询抢回锁）③ 方向 A（外部写 → Node 被动让锁，哨兵）④ 方向 B（Node 自己触发写 → 主动让锁）⑤ 17:01 段窗口内轮询等待 ⑥ 四个 `AsyncTask` 加 `preventOverrun: true` ⑦ SIGTERM 关 instance ⑧ 顺带关闭 main §13.2 I-26（单例路径绑定）⑨ 修 SDD §5.1 场景 4（MVCC 表述被实测证伪） | 🔴 最高（功能正确性） |
| 🔒 **T100** | **部署态落地（unit + 运行用户 + 目录权限 + 数据回填）**（§13.2 **I-34**）：① 装 `deploy/tdx2db.service` + `deploy/tdx2db-update.timer` ② **创建独立运行账号 `invol`**（不借用 `ubuntu`）③ 精确 chown（顶层 + quotes.duckdb，**不用 `chown -R`**）④ `tdx2db.service` 加 `ExecStartPre/Post` 哨兵 ⑤ 首次 `tdx2db cron` 留痕 ⑥ 数据回填（`2026-10-13`~`2026-10-21`）⑦ 修 `docs/deploy.md` ⑧ 修 `deploy/deploy.sh` 三缺陷（caddy 中止 / build 顺序 / chown 过宽）⑨ **mini 库重抽**（并入此项） | 🔴 最高（生产环境变更，需 root） |
| 🔒 **T102** | **F8 验收升级（真触发替代「读文件」）**（§13.2 **I-35**）：F8 用例分配置层/运行层；运行层真机验 systemd；门禁 G9 增列「F8 运行层证据」；重新判定 `fullstack-audit-v2.md` 的 Requirements §4.2 #12 | 🔴 高（验收 correctness） |
| **T79** | **不在 Wave 9** —— 独立为 **Wave 10**（P2 体验收尾，可后置，不阻塞 M4）。T79 ① 已随 T69/T73/T75 交付（G4.6/G6.6/G7.7 已 PASS），Wave 10 只剩 ②~⑥ | ⬜ 待启动（可后置） |

**门槛 G9**（§12.7）：

| 门槛 | 验证方式 |
|---|---|
| 🔒 **G9.1** | **真机「17:00 tdx2db 写库 → 17:01 校验读到新数据」端到端跑通** —— 真库 `max(raw_kline_daily.date)` == 最近交易日，且 `journalctl -u tdx2db.service` 有成功记录（**不得 mock**） |
| 🔒 **G9.2** | **Node 侧不持写锁** —— 双进程实验：Node 侧持 instance 时外部进程打开同库失败；`closeDuckDBInstance()` 后成功（`/tmp` 临时库，**不碰真库**） |
| 🔒 **G9.3** | **DuckDB 打开必须是 `READ_ONLY`** —— 生产代码 grep 断言 |
| 🔒 **G9.3b** | **方向 B 生效** —— `rerunQuoteUpdate()` 执行期间新查询被拒；exec tdx2db **拿得到锁**；`inProcessWriting` 期间 `getInstance()` **不重建** instance |
| **G9.4** | **F8 运行层证据** —— `systemctl is-enabled` == enabled / `list-timers` 显示下次 17:00 / `journalctl` 有触发记录 |
| **G9.5** | **`preventOverrun` 生效** —— 长任务时同 job 不重复触发；真库上单轮 C1-C12 落在 60s 内 |
| **G9.6** | **Requirements §4.2 #12「收盘后定时自动化」重新判定** —— `fullstack-audit-v2.md` 该行不得再是无条件 ✅ |
| **G9.7** | **行情层文档 4 处不一致已修** —— `raw_holidays` 语义 / `raw_symbol_class` 列 / `class` 取值 / `--min` flag 名（§4.1 表） |

---

## 2. 所有者已裁决的决策

| 决策 | 裁决 |
|---|---|
| **D-1** 修哪个 Wave | **并入 Wave 9** |
| **D-2** 写窗口信号源 | **systemd 哨兵文件**；「谁决定何时 close」= **systemd 决定窗口起止，Node 惰性执行 close** |
| **D-3** mini 库重抽 | **暂不重抽** |
| **D-4** 行情层文档不一致 | **修**（列为 G9.7） |
| **D-5** 落地路径 | **① 直接改 plan + ② 先落 ADR** |
| T100 运行用户 | **Ubuntu 下仍用独立账号 `invol`**（不借用 `ubuntu`） |
| T100 生产变更 | 需**所有者授权**（建 `invol` + 精确 chown `/opt/invol` + 装 systemd unit + 真实回填） |
| **D-6**（L1 业务文档改动） | **a**（改 Requirements §4.2 #13 对齐 I-11 裁决） |
| **保留期分级** | **b**（改代码对齐 SDD：行情 7 天 / 业务 30 天，按备份类型分开判定） |
| **恢复验证脚本** | **a**（补 `scripts/restore-drill.sh`，同时补备份覆盖面：`raw_gbbq` / `raw_holidays` / `raw_symbol_class` / `v_etf_*`） |
| **备份覆盖面** | 与恢复验证脚本**同批**（DuckDB 备份产物当前只含 `v_stock_qfq` 一个视图） |

### D-6 的具体改法（已裁决，待执行）

- **L1**：`Requirements_simplified.md:75` 第 13 条改为「**仅本地**双库备份（行情保留 7 天 / 业务保留 30 天）+ 恢复验证」—— 一句话，L1 业务文档改动需所有者点头（已点头）
- **L2**：`backup.ts` 的 `RETENTION_DAYS = 3`（统一 3 天）→ 改为按文件名区分 `v_stock_qfq.*.parquet`（7 天）与 `business.db.*`（30 天）
- **L3**：补 `scripts/restore-drill.sh`（双库完整恢复演练到临时目录 + `integrity_check` + `COUNT(*)` 比对）+ 补备份覆盖面（导出 `raw_gbbq` / `raw_holidays` / `raw_symbol_class` / `v_etf_*`）

---

## 3. 关键实测数据（Wave 9 实施时直接用）

| 项 | 实测值 |
|---|---|
| 真库 `max(raw_kline_daily.date)` | **2026-10-12**（落后 6 个交易日：10-13/14/15/16/19/20） |
| `raw_holidays` 680 行中落在 2020~2030 区间且有行情/有日线的 | **0 行** ⇒ 确为**休市日**黑名单 |
| `raw_symbol_class` 实测列 | 只有 `symbol` / `class`（**无 `is_st` / `is_listing`**） |
| `class` 实测分布 | stock 6158 / etf 2839 / unknown 1357 / block 1128 / index 801 / bstock 166（**无 `bond`**） |
| tdx2db `cron` 真 flag | `--min`（不是 `--with-1min`） |
| DuckDB 单写者文件锁 | Node 持 READ_ONLY instance ⇒ tdx2db RW 打开 **FAIL**（实验 2） |
| close instance 后 | 真 tdx2db **立刻拿到锁**并进入拉取流程（实验 5） |
| 单进程第二个 instance | **不冲突**（DuckDB 允许同进程多 instance 共享同一文件） |
| 锁由谁持有 | **instance**，不是 connection（关 conn 不释放） |
| open instance 耗时 | **29ms** |
| open+query+close 均摊 | **46.2ms/次** |
| PE4 单请求 p99 | **96.7ms / 99.1ms**（真库，30 只持仓，门槛 200ms） |
| PE4 并发档 `-c 100` | **≈3.0s**（未达标，已登记 D-4 / I-28） |
| `C1_SQL` 真库耗时 | **3272ms**（视图物化） |
| Node RSS：跑一次视图聚合 | 325.7 MB；close instance 后 → **98.0 MB**（释放 ~222 MB） |
| C1~C12 单轮在真库上的耗时 | 分钟级（多条 SQL 打视图） |
| `preventOverrun` 现状 | **0 命中**（4 个 `AsyncTask` 全未设） |
| tdx2db `sync` 子命令 | **不存在**（`cron` 是唯一增量入口） |
| `--dry-run` | **不存在** |
| `systemd-run` 权限 | `Interactive authentication required`（需 root） |
| `/opt/invol` 属主 | `root:root` 755（ubuntu 不可写） |
| `User=invol` | **不存在**（`id invol` 失败） |
| `deploy/deploy.sh` | **从未在本机执行过**（`/opt/invol/secrets`、`plugins/strategies` 不存在） |
| `deploy/deploy.sh` 缺陷 | Step 8 caddy 中止 / Step 5 build 顺序 / Step 7 chown 过宽（3 个） |
| `caddy` | **未安装**，`/etc/caddy` 不存在 |
| CI 真库 | 无（12KB 空壳，31 个行情用例长期 skip） |
| `systemd-run` | `/usr/bin/systemd-run` 存在 |
| tdx2db 发布平台 | `Linux_arm64` / `Linux_x86_64` / `Windows_x86_64` / `Darwin_arm64`（v2026.8.12） |
| 并行会话 | `de4ccff7` 已完成 Wave 7/8；**已停滞**（无 tdx2db 进程，无后端进程，真库 mtime 未变） |

---

## 4. 关键文件与行号

| 文件 | 关键位置 | 说明 |
|---|---|---|
| `apps/backend/src/db/duckdb.ts:81` | `DuckDBInstance.create(resolveDuckDBPath())` | 未传 `access_mode` ⇒ 默认读写 |
| `apps/backend/src/db/duckdb.ts:57-76` | `globalThis.__investDuckDBSingleton__` | 进程级单例 |
| `apps/backend/src/db/duckdb.ts:90-102` | `closeDuckDBInstance()` | 存在，**生产零调用** |
| `apps/backend/src/server.ts:52` | `duckdbHealthCheck()` | 启动时创建 instance ⇒ **启动即持锁** |
| `apps/backend/src/server.ts:68-71` | SIGTERM 只 `process.exit(0)` | 不关 DuckDB |
| `apps/backend/src/services/quoteRerun.ts` | 三级降级链 | **零 close**（方向 B 待修） |
| `apps/backend/src/services/scheduler.ts:48` | `runDatacheckWithRerun` | 自愈补跑入口 |
| `apps/backend/src/services/scheduler.ts:104-245` | 4 个 `AsyncTask` | **全未设 `preventOverrun`** |
| `apps/backend/src/services/scheduler.ts:126` | `'2 17 * * 1-5'` | 信号生成 17:02 |
| `apps/backend/src/services/backup.ts:94` | `DuckDBInstance.create(duckdbPath)` | 同进程第二个 instance（不冲突） |
| `apps/backend/src/services/backup.ts:22` | `RETENTION_DAYS = 3` | ⚠️ 分级备份被抹平 |
| `apps/backend/src/services/validator.ts:193-266` | C1/C2 SQL + `CHECK_NAMES` | 已按实测修正（休市日黑名单） |
| `apps/backend/src/services/marketData.ts:503-583` | `resolveTargetTradeDate` / `raw_holidays` 语义 | 已按实测修正 |
| `apps/backend/src/routes/admin.ts:209` | `POST /api/admin/rerun-quotes` | 手动触发入口 |
| `deploy/tdx2db.service:10` | `tdx2db cron --dburi 'duckdb:///opt/invol/quotes.duckdb'` | 从未安装 |
| `deploy/tdx2db-update.timer:5-8` | `OnCalendar=*-*-* 17:00:00` | 从未安装 |
| `deploy/deploy.sh:16` | `useradd -r -s /bin/false invol` | 从未执行 |
| `deploy/deploy.sh:63` | `chown -R "$USERNAME:$USERNAME" "$DEPLOY_DIR"` | 从未执行 |
| `deploy/deploy.sh:57-59` | `cp Caddyfile /etc/caddy/` | caddy 未安装 ⇒ 脚本在此中止 |
| `docs/tdx2db_schema.md:29` | `--with-1min` | 真 flag 是 `--min` |
| `docs/tdx2db_schema.md:125-131` | `raw_holidays` = 交易日 | **实测 = 休市日** |
| `docs/tdx2db_schema.md:138` | `class` 实测值含 `bond` | 实测无 `bond` |
| `docs/client/SDD.md:1276` | `raw_holidays` = 交易日 | 同上 |
| `docs/client/SDD.md:1309` | `raw_symbol_class` 有 `is_st`/`is_listing` | 实测只有 `symbol`/`class` |
| `docs/client/SDD.md:1563` | MVCC 自动处理 reader/writer 共存 | **实测证伪** |
| `docs/client/SDD.md:2010-2021` | C2 SQL（有行=交易日） | **方向写反** |
| `docs/client/SDD.md:2752` | D2 实测 dump（`raw_holidays` 有=交易日） | **方向写反** |
| `docs/audit/proposal-market-update-pipeline-fix.md` | 证据层提案（已合入 main） | — |
| `docs/adr/ADR-012-market-update-write-window.md` | 决策归档（已合入 main） | — |
| `docs/audit/wave-8-audit.md:202` | #12 收盘后定时自动化 = ✅ PASS | **假绿**（载体在，功能不在） |
| `docs/audit/fullstack-audit-v2.md:202` | 同上 | 同上 |

---

## 5. 已知陷阱（Wave 9 实施时别重踩）

1. **多 agent 共享工作树**：未跟踪文件会被别人的 `git add` 带走（本次提案文件被 Wave 7 会话顺带提交到 main）⇒ Wave 9 期间只留一个会话
2. **DuckDB 单写者文件锁**：`READ_ONLY` 实例仍阻塞外部写者 ⇒ Node 侧必须 `closeDuckDBInstance()` 才能放锁（**关 connection 不释放**）
3. **空闲即关不是锁方案**：它只降概率；真正保证靠方向 A（哨兵）+ 方向 B（主动 close）
4. **只 close 不够**：必须同时有 `inProcessWriting` 标志禁止窗口内重建 instance（实测竞态）
5. **mini 库不可喂 tdx2db**：缺 `_meta` ⇒ tdx2db 拒绝写入；强行补 `_meta` 会把 250 只抽样冲成全市场；**护栏必须保留**
6. **`deploy.sh` 三缺陷**：Step 8 caddy 中止 / Step 5 build 顺序 / Step 7 chown 过宽 —— 修完再跑
7. **CI 无真实行情库**：31 个行情用例长期 skip，门禁半盲
8. **F8 验收载体只验「unit 文件内容」**：`cronSequence.test.ts:144,171` 只 `readFileSync` 后比对正则
9. **`raw_holidays` 语义**：代码已按实测修正（休市日黑名单），SDD/`tdx2db_schema.md` 仍写反 —— 修文档时按 §4.1 表
10. **`is_st`/`is_listing` 不存在**：`raw_symbol_class` 只有 `symbol`/`class` —— C3 ST 校验口径需确认
11. **`--with-1min` flag 名错**：真 flag 是 `--min`

---

## 6. 不在本提案 / 本波范围

| 项 | 归属 |
|---|---|
| mini 库作为测试夹具的整体策略（三档切换 / 两层开关 / 不由 tdx2db 更新） | **ADR-008**（已裁决，不动） |
| `tdx2db` 二进制自身的实现（Go 仓库） | **不在本仓库** |
| `ENABLE_OCI_BACKUP` 远程备份 | **I-11 已裁决**「MVP 不交付远程备份」 |
| 深色模式 / CSS Module / 图表库 | V2 / 禁止（plan U21） |
| 板块表 0 行、名称覆盖 70% | **I-22 已登记**（随 T85b ④） |
| `raw_holidays` 语义等 4 处文档不一致 | **G9.7**（本波修） |
| T79 ②~⑥ 五个 P2 体验项 | **Wave 10**（可后置） |
| PR #25（V3 规格，ADR-009~016） | 不动（V3 是下一版本，与 MVP 并行） |

---

## 7. 参考文档

| 文档 | 作用 |
|---|---|
| `docs/audit/proposal-market-update-pipeline-fix.md` | 证据层（原始实测输出） |
| `docs/adr/ADR-012-market-update-write-window.md` | 决策归档 |
| `docs/client/code_implementation_plan_v2.md` §5 Wave 9 / §12.7 G9 / §13.1 B-15 / §13.2 I-34~I-36 / §13.4 | 派工与验收 |
| `docs/audit/wave-8-audit.md` | G8 PASS，§12.6 判 COND |
| `docs/audit/fullstack-audit-v2.md` | T78 全栈审计（#12 假绿） |
| `docs/deploy.md` | L5 运维（待 T100 修） |
| `docs/tdx2db_schema.md` | L3.5 行情层 schema（含 4 处不一致） |
| `docs/adr/ADR-008-test-market-data-strategy.md` | 迷你库策略（不动） |
