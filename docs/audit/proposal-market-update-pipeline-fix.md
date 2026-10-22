# 提案：行情更新链路修复（新增 T 任务 + §13 偏差登记）

> ✅ **裁决状态（2026-10-21）**：**所有者已裁决 D-1~D-5**，本提案已**落地**为
> **plan §5 Wave 9（T99 / T100 / T102）+ §12.7 G9 + §13.1 B-15 + §13.2 I-34/I-35/I-36 + [ADR-012](../adr/ADR-012-market-update-write-window.md)**。
> 本文档保留为**证据层**（原始实测输出与推理过程的可审计留档），**不再是待裁决草案**。
>
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
>
> 🔴 **基线说明（2026-10-21 修订）**：撰写本提案期间，**Wave 7 / Wave 8 已完成并合入 `main`**
> （`863e850` / `e6c00c0`，G7 7/7 PASS、G8 PASS，§12.6 全局判定 ⚠️ COND）。
> ⇒ 本提案的编号与「Wave 归属」已按 `main` 现状重新校准（见 §0 与 §5 D-1）。

---

## 0. 一句话总览

> **行情增量更新的「二进制机制」是好的（增量语义已实测证实），坏的是「Node 侧持锁」与「部署态」两处。**
>
> **三条新发现**：
> ① 🔴 **Fastify 常驻持锁 ⇒ 装好 timer 也必然失败**（plan 完全未覆盖；**修复方向已实测验证可行**）；
> ② 🟠 **F8 的验收载体是「读文件」⇒ G5.1 已判过假绿**；
> ③ 🟠 **4 段 cron 未设 `preventOverrun` + 真库单条校验 SQL 3.27s ⇒ 段间重叠**（与 ① 叠加会连锁自愈失败）。
>
> 另附 **1 条设计确认**（**不是缺陷**）：**mini 库不跑 tdx2db 是设计意图**，且缺 `_meta` 这条**护栏必须保留**（§2.2）。

**§13 拟登记 4 条**（编号已按 `main` 现状校准）：**B-15**（🔴 阻断，main 上 B-15 空缺）+ **I-34 / I-35 / I-36**（🟠 重要；main 已用到 I-33）。
**拟新增 3 个 T 任务**：T99（锁模型）/ T100（部署态，含 mini 库重抽）/ **T102**（F8 验收真触发 + cron 重叠）—— **归属 Wave 9**（main 上 Wave 9 = T79 的 P2 波；main 的 I-32 已定「Wave 9 或后续」为 follow-up 归属）。
（T101 保留为**已撤销占位**，见 §3 —— 记录「初稿曾误派 mini 库任务」，避免后人重复踩坑。）
**新 ADR 应为 ADR-012**（main 已到 ADR-011）。

✅ **已落地**：**[ADR-012](../adr/ADR-012-market-update-write-window.md)** + plan **§5 Wave 9**（T99/T100/T102）+ **§12.7 G9**（7 条）+ **§13.1 B-15** + **§13.2 I-34/I-35/I-36**。
📌 **T100 在 Ubuntu 下仍用独立运行账号 `invol`**（所有者裁决：不借用 `ubuntu`；最小权限）。

---

## 1. 背景：Wave 7 / Wave 8 都已完成，但都没覆盖

> 🔴 **Wave 7 / Wave 8 已于 2026-10-21 合入 `main`**（`863e850` / `e6c00c0`；G7 **7/7 PASS**、G8 **PASS**，§12.6 全局判定 ⚠️ **COND**）。
> ⇒ 本节不是「Wave 7/8 将来会做吗」，而是「**它们做完了，这些修复项仍然没人认领**」。

| 修复项 | Wave 7（✅ 已完成 G7 7/7） | Wave 8（✅ 已完成 G8 PASS） | 现状判定 |
|---|---|---|---|
| 装 systemd unit（`tdx2db-update.timer` 从未安装） | ❌ | ❌ | plan §1 行 34 自认「真机部署验证」**仍未覆盖** |
| `User=invol` 用户不存在 | ❌ | ❌ | `deploy/deploy.sh:16` 会 `useradd`，但脚本**从未在本机执行过** |
| `/opt/invol` 属主 `root:root`（DuckDB WAL 不可建） | ❌ | ❌ | `deploy.sh:63` 的 `chown` 未执行 |
| 数据落后 6 个交易日（停在 `2026-10-12`） | ❌ | ❌ | 无任何 T 负责「重跑一次把数据补齐」 |
| **Fastify 常驻持 DuckDB 锁** | ❌ | ❌ | **plan / §13 / ADR 全部无记载**（main 的 §13.2 I-26 是**同一段单例代码**的另一处缺陷 —— 路径绑定，非锁） |
| T75 ⑤ 手动触发行情更新按钮 | ✅ 已交付 | — | 但后端 `POST /api/admin/rerun-quotes`（`routes/admin.ts:209`）+ `services/quoteRerun.ts` 三级降级**早已存在**；Wave 7 只加了按钮 + 二次确认 |
| F8「5 段自动化触发」验收 | — | ⚠️ **假绿** | `tests/integration/cronSequence.test.ts:144,171` 只 `readFileSync` unit **文件内容** + 比对 cron 字符串，**不验证真实触发** |

> 🔴 **T75 ⑤ 交付的「立即补跑行情更新」按钮，在当前机器上点下去必然走完降级链后返回 SKIP**：
> `systemd-run`（实测 `Interactive authentication required`，需 root）→ `systemctl start`（unit 不存在）→
> 直接 exec（`/opt/invol` 不可写，实测 `touch .wal` → `Permission denied`）。

### 1.1 ⚠️ 更严重的是：**T78 最终审计也带着这个假绿通过了**

```console
# main:docs/audit/fullstack-audit-v2.md:202 —— Requirements §4.2 第 12 条「收盘后定时自动化」
| 12 | 收盘后定时自动化（行情更新 → 数据校验 → 信号生成 + 资产快照 → 除权自动导入 → 双库备份，按序执行）
    | services/scheduler.ts 4 段（17:01 校验 / 17:02 信号 / 17:03 除权 / 17:05 备份）
      + systemd timer 17:00 触发 tdx2db（Node 进程外）；F8 的 cron_sequence_trigger 5 个用例 | ✅ |
```

> 🔴 **判定依据全部是「代码」与「unit 文件内容」** —— 与 G5.1 判 F8 PASS 的依据**完全同源**。
> ⇒ **M4 验收带着「行情从未真正更新过（数据落后 6 个交易日、timer 从未安装）」这个假绿通过了 §12.6。**
> ⚠️ 这是 §12.7「静默污染」机制在**验收层**（而非实现层）的盲区 —— 本提案的 T102 就是补这一刀。

---

## 2. 三条新发现 + 一条设计确认（实测证据）

### 2.1 🔴 发现 ① —— Fastify 常驻持锁 ⇒ 装好 timer 也必然失败

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

#### 2.1.4b 🔴 手动触发路径同样中招（**方向 B**）

| 事实 | 实测 |
|---|---|
| `services/quoteRerun.ts` / `routes/admin.ts` 里 `closeDuckDBInstance` | **0 命中** |
| `server.ts:52` 的 `duckdbHealthCheck()` → `openConnection()` → `getInstance()` → `DuckDBInstance.create()` | ⇒ **Fastify 启动那一刻就持锁** ⇒ 17:00 的 tdx2db **100% 失败**（不是概率问题） |
| 三级降级链（`systemd-run` / `systemctl start` / `execFile`） | **全是独立进程** ⇒ 全都要写锁 ⇒ **全部被挡** |

⇒ **手动补跑（`POST /api/admin/rerun-quotes`）与自愈补跑（`scheduler.ts:48`）当前 100% 失败。**
⇒ **方向 A（外部写 → Node 让锁）不够** —— 手动触发是**反方向**（Node 叫 tdx2db 写），
必须由 **Node 主动 close**（**方向 B**）。详见 ADR-012 §2.3。

⚠️ **只 close 也不够** —— 实测竞态：close 后到 tdx2db 启动之间若有并发查询，
它会走 `getInstance()` **惰性重建 instance 把锁抢回** ⇒ tdx2db 又被挡。
⇒ 必须同时有**进程内写窗口标志**（`inProcessWriting`），标志为真时**禁止重建**。

```console
# 方向 B 实测：close → exec → 惰性重建
[1] instance 已持有（模拟 Fastify 现状）
    直接 exec tdx2db => 🛑 错误: failed to connect to database: IO Error: Could not set lock …
[2] 方向 B：close → exec → 惰性重建
    closeDuckDBInstance() 已执行
    exec tdx2db => 🟡 00010701 数据尚未发布      ← 已拿到锁并进入拉取流程
[3] 惰性重建后查询仍可用 => [42]

# 竞态实测
[A] close 之后、tdx2db 启动之前，有一个并发查询进来：
    并发查询已重建 instance（锁又被抢回）
    tdx2db => ❌ 失败: … Could not set lock …
```

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

### 2.2 ✅ 设计确认（**不是缺陷**）—— mini 库不跑 tdx2db 是设计意图，且被工具强制

> 🔴 **本节初稿误把「设计意图」当成「缺陷」，2026-10-21 修正。**
> mini 库是**只读快照**，**设计上就不由 tdx2db 更新**（ADR-008 §2.1 的规格是「10 张 raw_ 表 + 6 张视图」，
> **本就不含 `_meta`**）⇒ 「跑不了 tdx2db」是**正确行为**，不是问题。

#### 2.2.1 `_meta` 缺失 = tdx2db 主动拒绝写入（**护栏有效**）

```console
$ tdx2db cron --dburi 'duckdb:////tmp/opencode/minicron.duckdb'
🛑 错误:
数据库 schema 版本缺失 (需要: v6.x)
请阅读 https://github.com/jing2uo/tdx2db/releases 了解迁移方式
```

- mini 库的 10 张表由 `scripts/make-mini-duckdb.mjs:91-102` 的 `TABLES` 常量**刻意定义**（**不含 `_meta`**）；
- `manifest.json` 的 `tableDdl` 同样无 `_meta`；
- 真库 `_meta` 内容实测：`schema_version = 6.0`。

> ✅ **这条护栏必须保留**：`_meta` 缺失 ⇒ tdx2db **拒绝写入** ⇒ 「mini 库是只读快照」这一约束
> **由工具本身强制**，不依赖人的自觉。**任何时候都不应该给 mini 库补 `_meta`。**

#### 2.2.2 「若有人绕过护栏会怎样」（实测，作为护栏必要性的佐证）

```console
# 手工补 _meta.schema_version='6.0' 后跑 tdx2db cron（仅 /tmp 副本，未动真库/仓库库）
原始 mini :  202 标的 /  46,528 行 / max(date)=2026-10-12
补跑 5 分钟后: 11,863 标的 / 118,962 行 / max(date)=2026-10-21
```

- `raw_symbol_class` 从 **250 只**变成 **11,863 只**（全市场）；
- mini 库赖以成立的「真库**逐位一致子集**」前提（ADR-008 §2.3 两层开关的 `numeric` 层；原文见 `apps/backend/tests/_marketData.ts:33`）**当场作废**。

> ⇒ 这组数字**不是缺陷证据，而是护栏必要性的证据**：正因为绕过 `_meta` 会把 250 只抽样冲成全市场，
> **`_meta` 缺失这条设计不能动**。

#### 2.2.3 顺带证实了增量语义（正面结论，与 mini 无关）

| 项 | 实测 |
|---|---|
| 是否全量重拉重写 | **否** —— `min(date)` 保持 `2025-10-14` 不变，只**追加** `2026-10-13`~`2026-10-21` |
| 二进制符号表佐证 | `workflow.pullDateRange` → `database/duckdb.(*DuckDBDriver).GetLatestDate`（SQL `SELECT date FROM %s ORDER BY date`）→ `workflow.executeUpdateDaily` |
| 日志字符串 | `no new daily data` / `no new basic data` / `1min data imported` / `factors calculated` / `gbbq data imported` |
| 交易日语义 | `workflow.(*TradingCalendar).IsTradingDay` / `IsHoliday` / `IsWeekend` / `LastTradingDayOnOrBefore` |

#### 2.2.4 剩下的唯一开放项：**谁负责重抽**（流程问题，非缺陷）

- mini 库与真库**当前同步**（实测两者 `max(date)` 均为 `2026-10-12`，mini 202 标的 / 46,528 行）；
- ADR-008 §3 **已明确接受**「迷你库会过期」为代价，缓解手段 = 「固定快照 + 一键重生成脚本」——**脚本已存在**
  （`make-mini-duckdb.mjs extract` / `build`）；
- ⇒ **唯一开放项是「触发时机」**：T100 把真库回填到最新交易日后，mini 库需要重抽一次。
  **不单独派 T 任务**，并入 T100 ⑥（见 §3 T100 交付物）。

> ⚠️ **本节不产生 §13 偏差条目，也不需要独立 T 任务。**（初稿曾拟派 T101「mini 库策略修正」，已撤销 —— 见 §3 T101）

---

### 2.3 🟠 发现 ② —— F8 的验收载体是「读文件」，G5.1 与 T78 最终审计**都**判过假绿

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

#### 🔴 2.3.1 波及面比初稿判断的更大：**T78 最终审计也判了 PASS**

```console
# main:docs/audit/fullstack-audit-v2.md:202（Requirements §4.2 第 12 条「收盘后定时自动化」）
… + systemd timer 17:00 触发 tdx2db（Node 进程外）；F8 的 cron_sequence_trigger 5 个用例 | ✅
```

- **判定依据**同样是「代码 + unit 文件内容」⇒ 与 G5.1 **同源**；
- 已知实况（本次实测）：**timer 从未安装**、**数据落后 6 个交易日** ⇒ **功能不可用**；
- ⇒ **§12.6 全局判定（⚠️ COND）带着这一条通过了**。

> 🔴 **G5.1 判的是「载体存在」，不是「功能可用」** —— 这是 §12.7「静默污染」机制的一个实例：
> 载体在，功能不在，门禁仍绿。**且该假绿一路传到了最终审计。**

#### 2.3.2 与 main 已登记的 I-32 同族（但不同）

| | main 的 **I-32**（已登记 → §9.3 D-8，判「Wave 9 或后续」） | 本提案的 **I-35（拟）** |
|---|---|---|
| 假绿形态 | 行情用例被**静默 skip**，退出码仍 0 | **验收载体只验「unit 文件内容」**，不验证真实触发 |
| 盲区位置 | **测试守卫层**（`tests/_marketData.ts` 的可用性探测） | **验收用例层**（`cronSequence.test.ts` 的 F8） |
| 修法 | CI 把「行情用例被跳过」判红 | F8 拆「配置层 / 运行层」，运行层真机验 systemd |

> ⇒ 两者**互补**，应**同批**修（都在「门禁不能只信载体」这一条主线上），但**不是同一条**。

---

### 2.4 🟠 发现 ③ —— 4 段 cron 未设 `preventOverrun`，17:01 校验段在真库上单条 SQL 就要 3.27s

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
> ⇒ 三条问题（B-15 持锁 / I-34 部署态 / I-36 本条重叠）**必须一起修**，否则修了任一条仍会自愈失败。

---

## 3. 拟新增的 T 任务（**草案，待裁决**）

> ⚠️ 编号 **T99~T102** 是按现有最大编号 T98 顺延的**占位**；最终编号由所有者指定。
> ⚠️ 另注：仓库存在并行分支 **`docs/v3-spec`（PR #25，DRAFT）**，内含 `code_implementation_plan_v3.md` 与 **ADR-009~012** ⇒ 本提案的编号与决策点需与该分支**对齐后再定**（尤其 ADR 编号应为 **ADR-013**）。
> Wave 归属建议见每条的「建议归属」列。

### T99 —— 🔴 DuckDB 访问模型改造（只读 + 写窗口让锁）

| 项 | 内容 |
|---|---|
| **建议归属** | **Wave 9**（Wave 8 已完成 —— F8/PE1-PE5 都依赖它；main 的 I-32 已定「Wave 9 或后续」为 follow-up 归属） |
| **前置** | 无（可与 Wave 7 并行） |
| **交付物** | ① `db/duckdb.ts`：`DuckDBInstance.create(path, { access_mode: 'READ_ONLY' })` —— 落实 AGENTS.md:376<br>② 写窗口协调：新增「**行情更新进行中**」状态位 —— tdx2db 写入期间，Node 侧**主动 `closeDuckDBInstance()`** 并让 API 返回可重试错误（503 / `RETRY_AFTER`），写入结束后**惰性重开**<br>③ `server.ts` SIGTERM：补 `closeDuckDBInstance()` 后再退出<br>④ `services/backup.ts:94`：第二个 instance 同样改只读（当前它能开是因为同进程同锁域，但与 ① 冲突后需一并处理）<br>⑤ 写窗口的**触发方式**待裁决（三选一，见 §5 决策点 D-2） |
| **测试要点** | ① 单测：写窗口内 `queryDuckDB` 抛结构化「行情更新中」错误，窗口结束后恢复<br>② 集成：`closeDuckDBInstance()` 后另一进程能 RW 打开同一文件（用 `/tmp` 临时库，不碰真库）<br>③ 回归：现有全部行情用例仍绿（`apps/backend/tests/unit/duckdbLeak.test.ts` 等 12 个受影响的用例） |
| **卡点** | 🔴 写窗口的判定信号从哪来？tdx2db 是**外部进程**，Node 侧无从得知它何时开始/结束写 ⇒ 必须有一个跨进程信号源（见 §5 D-2） |

### T100 —— 🔴 部署态落地（unit + 用户 + 权限 + 数据回填）

| 项 | 内容 |
|---|---|
| **建议归属** | **Wave 9**（或独立「Wave 8.5 · 部署态」，见 §5 D-1） |
| **前置** | T99（否则装好了也跑不通） |
| **交付物** | ① 装 `deploy/tdx2db.service` + `deploy/tdx2db-update.timer` → `/etc/systemd/system/` + `daemon-reload` + `enable --now`<br>② 解决 `User=invol` 不存在（`useradd -r -s /bin/false invol` 或改 unit 为运行用户）<br>③ 解决 `/opt/invol` 不可写（DuckDB 需在同目录建 `.wal`）<br>④ 首次 `tdx2db cron` **留痕**（stdout/stderr 重定向到文件，禁止再出现「无日志可查」）<br>⑤ **数据回填**：把 `2026-10-13`~`2026-10-21` 补齐<br>⑥ 修 `docs/deploy.md`（当前描述的 17:00→17:05 链路与实况脱节）<br>⑦ **mini 库重抽**（并入此项，不另派任务 —— 见 §2.2.4）：真库回填后跑一次 `make-mini-duckdb.mjs extract` 重抽 Parquet 并提交；顺带在 `apps/backend/tests/fixtures/mini-market/README.md` 补一行**禁令**「⛔ 不要给 mini 库补 `_meta`、不要对它跑 tdx2db —— 会把 250 只抽样冲成全市场（实测 11,863 只）」 |
| **测试要点** | ① `systemctl is-enabled tdx2db-update.timer` == `enabled`<br>② `systemctl list-timers` 显示下次触发 = 明日 17:00<br>③ `journalctl -u tdx2db.service` 有成功记录且 `exit_code=0`<br>④ 真库 `max(raw_kline_daily.date)` == 最近交易日<br>⑤ `tdx2db` 端到端跑通后**真库无 `.wal` 残留**、文件大小/行数合理<br>⑥ mini 库重抽后：抽样标的数仍 == 250、class 比例仍符合 ADR-008 §2.1、**仍无 `_meta` 表** |
| **卡点** | 🔴 需 **root** 与**改动 `/opt/invol` 属主** ⇒ 属**生产环境变更**，须所有者授权；<br>⚠️ 与 AGENTS.md「跑测试前必须先停掉后端」冲突 —— 17:00 窗口内 Node 持锁会挡住 tdx2db（这正是 T99 要解决的）；<br>⚠️ ⑦ 会改动仓库内 12 个 Parquet 二进制文件 ⇒ 需先定「何时重抽」的策略（见 §5 D-3） |

### ~~T101~~ ❌ 已撤销（2026-10-21 修正）—— mini 库策略「修正」

> **撤销原因**：初稿把「mini 库跑不了 tdx2db」当成缺陷并派生本任务 —— **误判**。
> mini 库**设计上就是只读快照**（ADR-008 §2.1：10 张 raw_ 表 + 6 张视图，**本就不含 `_meta`**），
> 「跑不了 tdx2db」是**正确行为**，且 `_meta` 缺失这条**护栏必须保留**（绕过它会把 250 只抽样冲成 11,863 只 —— 实测）。
> ⇒ **不产生 §13 偏差条目、不派独立 T 任务**；唯一残留的「重抽触发时机」并入 **T100 ⑦**。
> 详见 §2.2。

### T102 —— 🟠 F8 验收升级（真触发替代「读文件」）+ cron 段重叠防护

| 项 | 内容 |
|---|---|
| **建议归属** | Wave 9 |
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

> ⚠️ **与 main 已登记的 §13.2 I-26 是「同一段单例代码」的两个不同缺陷** ——
> I-26 讲的是「单例**绑定到首次查询那一刻的路径**」（测试里被绑到空壳库）；
> 本条讲的是「单例**持有文件锁 + 默认可写模式**」（生产里挡住 tdx2db 写入）。
> ⇒ **同在 `db/duckdb.ts` 的 `getInstance()` 里，建议 T99 一并改**（改 `access_mode` + 加释放时机时，
> 顺手把「路径在创建时快照」也改成「每次连接时解析」，可同时关闭 I-26）。

### I-34（拟）—— 🟠 重要级：行情更新的部署态从未落地，数据落后 6 个交易日

| 现状（实测） | 真相源 | 建议 |
|---|---|---|
| ① `tdx2db-update.timer` / `tdx2db.service` **从未安装**（`systemctl cat` → `No files found`；`list-unit-files 'tdx*'` → 0）；`journalctl -u tdx2db.service` → `-- No entries --`；无 cron / at / user-timer 替代通道<br>② `User=invol` **不存在**（`id invol` → no such user）<br>③ `/opt/invol` 属主 `root:root` 755 → DuckDB 需在同目录建 `.wal` → 实测 `Permission denied`<br>④ `deploy/deploy.sh` **从未在本机执行过**（`/opt/invol/secrets`、`/opt/invol/plugins/strategies` 不存在）<br>⑤ 真库 `max(raw_kline_daily.date)` = **2026-10-12** ⇒ 落后 6 个完整交易日（10-13/14/15/16/19/20，**非周末/节假日误报**）<br>⑥ `docs/deploy.md` 描述的 17:00→17:05 链路与实况脱节 | **Requirements §4.2 #12**（收盘后定时自动化）+ **SDD §5.1 五段时序** | 🔴 **派任务 → T100**。<br>⚠️ plan §1 行 34 已自认「真机部署验证（systemd unit / Caddy HTTPS）」**仍未覆盖** ⇒ 本条是那条自认缺口的**具体化** |
| 证据 | 同上 §2.1 前置 / 运行时侧调查（`journalctl` / `systemctl` 原始输出） | 拟裁决：**需所有者授权**（涉及 root 与 `/opt/invol` 属主变更） |

### I-35（拟）—— 🟠 重要级：F8「5 段自动化触发」的验收载体只验「unit 文件内容」，G5.1 **与 T78 最终审计**都判过假绿

| 现状（实测） | 真相源 | 建议 |
|---|---|---|
| ① `tests/integration/cronSequence.test.ts:144,171` 只 `readFileSync('deploy/tdx2db-update.timer')` 后比对正则 —— 验证的是**仓库文件内容**，不是**本机 timer 是否装了/触发过**<br>② 全仓 `grep systemctl apps/backend/tests/` → **0 命中**（`quoteRerun.test.ts` 全 mock）<br>③ `docs/audit/wave-5-audit.md:17` 的 **G5.1（🔒 硬阻断）据此判 F8 PASS**<br>④ 🔴 **波及面比初稿判断的更大**：`main:docs/audit/fullstack-audit-v2.md:202` 对 **Requirements §4.2 #12「收盘后定时自动化」** 也判了 **✅ PASS**，依据同为「代码 + unit 文件内容」⇒ **§12.6 全局判定（⚠️ COND）带着这条假绿通过**<br>⑤ 已知实际状态：timer 未安装、数据落后 6 个交易日 ⇒ **功能不可用而门禁绿** | **SDD §12.5 F8**（「每日 5 段自动化正确触发」）+ **§12.7 硬阻断语义** | 🔴 **派任务 → T102**（运行层用例 + 分层登记）。<br>⚠️ 与 §12.7「静默污染优先」同型：**载体存在 ≠ 功能可用**。这是 gate 机制本身的一个盲区，登记后可考虑加一条通用规则 |
| 证据 | 同上 §2.3 | 拟裁决：**需所有者确认**（是否把「运行层」写进 SDD §12.5，还是仅在 §12.7 门禁层加） |

### I-36（拟）—— 🟠 重要级：4 段 cron 未设 `preventOverrun`，真库上单条校验 SQL 3.27s ⇒ 17:01/17:02 段重叠

| 现状（实测） | 真相源 | 建议 |
|---|---|---|
| ① `services/scheduler.ts:105,139,214,245` 四个 `AsyncTask` **全部未设 `preventOverrun`**（`grep -c` = 0）；`toad-scheduler` README:350 该选项**默认 false**<br>② 真库实测：`SELECT COUNT(DISTINCT symbol) FROM v_stock_qfq WHERE date='2026-10-12'`（= C1 的 SQL 形态）耗时 **3272ms** —— `validator.ts` 的 C1/C6 **仍走视图**（T60c 只改了 `marketData.ts` / `dataCheck.ts`）<br>③ 段间隔仅 **60 秒**（17:01 → 17:02）⇒ C1~C12 单轮在真库上分钟级 ⇒ **17:02 信号段极可能在 17:01 未结束时触发**<br>④ 连锁效应：若 17:00 的 tdx2db 正在写库（受 B-15 持锁影响），17:01 校验读不到新数据 ⇒ 判 ERROR/WARN ⇒ 触发 `scheduler.ts:48` 的 `runDatacheckWithRerun` **再跑一次 tdx2db** ⇒ 与 17:00 的进程抢锁 ⇒ **自愈必然失败** | **SDD §5.1 五段时序**（17:00 写 → 17:01 校验 → 17:02 信号，按序执行）+ **Requirements §7.1**（C1 失败级别 ERROR ⇒ 自动触发补跑） | 🔴 **派任务 → T102**（与 F8 验收升级同批）。<br>⚠️ 修 B-15 / I-34 而不修本条 ⇒ **自愈链路仍会失败**（三条必须一起修） |
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

# ✅ **全部已裁决（2026-10-21）** —— 裁决结果见下表「裁决」列；决策理由归档在 [ADR-012](../adr/ADR-012-market-update-write-window.md)

| # | 决策点 | 选项 | 建议 | **裁决** |
|---|---|---|---|---|
| **D-1** | T100（部署态）放哪个 Wave | ① 独立「Wave 8.5」② 并入 Wave 9 ③ 单独一个 PR 不占 Wave | ② **并入 Wave 9** —— Wave 8 已完成（§12.6 判 COND），Wave 9 是既定的 follow-up 波次（main 的 I-32/I-33 已归入）；<br>⚠️ 若不排进 Wave 9，则「行情从未更新」的状态会带着 M4 tag 长期存在 | **✅ ② 并入 Wave 9** |
| **D-2** | **T99 的写窗口信号源**（Node 侧怎么知道 tdx2db 正在写？） | ① **文件哨兵**：`tdx2db.service` 加 `ExecStartPre/Post` 写/删 `/opt/invol/.tdx2db-writing`，Node 侧检测该文件即让锁<br>② **Node 侧主动探测**：改只读后，Node 用「尝试 RW 打开探测」判断（不现实）<br>③ **改为 Node 侧不做长驻**：每次查询开关（实测 +46ms/次，与 PE4 冲突）<br>④ **改 SDD 场景 4 的时序**：让 tdx2db 写库时 Fastify **整体停机**（17:00 停 → 写完起），与 systemd `ExecStartPre/Post` 联动 | ① **文件哨兵** —— 改动最小、跨进程可靠、不引入额外依赖；<br>✅ **无论选哪个，机制本身已实测可行**：调用 `closeDuckDBInstance()` 后 tdx2db 立刻拿到锁（§2.1.5 实验 5）⇒ 剩下的只是「谁来决定何时 close」；<br>⚠️ **SDD §5.1 场景 4 的「MVCC 自动处理 reader/writer 共存」必须改**（实测证伪） | **✅ ① 文件哨兵**。<br>「谁决定何时 close」= **systemd 决定窗口起止**（`ExecStartPre/Post` 写/删哨兵），**Node 惰性执行 close**（下次查询前发现哨兵即让锁 + 返回可重试错误；17:01 段轮询等待窗口结束）。<br>⇒ Node **不需要**预判窗口、不需要与 tdx2db 通信 ⇒ `Persistent=true` 的补跑漂移也照样成立。<br>🔴 **补入方向 B**（所有者追问后发现）：**手动触发 / 自愈补跑是反方向 —— Node 叫 tdx2db 写 ⇒ 必须 Node 主动 close**；且只 close 不够，**并发查询会重建 instance 抢回锁**（实测）⇒ 必须加进程内写窗口标志禁止重建。<br>详见 ADR-012 §2.1（方向 A）/ §2.3（方向 B） |
| **D-3** | mini 库重抽 Parquet 的**触发时机**（**流程问题，非缺陷** —— ADR-008 §3 已接受「迷你库会过期」为代价） | ① 随 T100 手动做一次（简单，但会过期）② 定期自动重抽（每次产生 12 个二进制 diff）③ 只在 CI 跑 `extract`（需 CI 有真库 ⇒ 不可行） | ① **随 T100 ⑦ 做一次** + 写进 ADR-008 的「重生成触发」小节；<br>⚠️ 长期看 ② 更正确，但需先解决「二进制 diff 进 git」的流程问题 | **✅ 暂不重抽**（本波不做）。<br>⇒ mini 库与真库的窗口差异继续存在；`numeric` 层断言不受影响（mini 是真库的逐位一致子集） |
| **D-4** | **行情层文档（SDD L3 + `tdx2db_schema.md` L3.5）与实测有 4 处不一致** —— 详见 **§4.1** | 见 §4.1 | 🔴 **修文档**（L3/L3.5 权威层）。<br>⚠️ 这些**不是**代码缺陷（代码侧 `validator.ts` / `marketData.ts` 已按实测修正）⇒ **不占用 §13.2 编号**，建议随 T99/T102 文档同步修正时一并处理。<br>⚠️ 但 `raw_symbol_class` 的 `is_st`/`is_listing` 缺失**有功能后果**（C3 ST 状态校验无字段可用）⇒ 需确认 C3 的实际实现口径 | **✅ 修** —— 已并入 **G9.7** 门槛（四处不一致全修）。<br>⚠️ `is_st`/`is_listing` 的功能后果（C3 ST 校验口径）**仍待确认**，不阻塞 G9.7 |
| **D-5** | 本提案的落地方式 | ① 裁决后由主 agent 直接写进 plan §5/§12.7/§13.4（改 L4 计划文档）② 先落 `docs/adr/ADR-012`（决策归档）再改 plan ③ 只留本提案，等 Wave 8 开工时再定 | ① + ② —— D-2 涉及「Node 与外部写进程的协调协议」，属**架构决策**，按 AGENTS.md 应进 `docs/adr/`。<br>⚠️ **编号注意**：main 已到 **ADR-011** ⇒ 本提案对应的新 ADR 应为 **ADR-012**。落地前以 `docs/adr/README.md` 的实际最大编号 +1 为准 | **✅ ① + ②** —— 已落 **[ADR-012](../adr/ADR-012-market-update-write-window.md)**，并据此改了 plan §5 / §12.7 / §13.1 / §13.2 / §13.4 |

---

## 6. 与既有文档的关系（避免层界违规）

| 本提案涉及的事实 | 归属层 | 应写在哪 | 本提案的动作 |
|---|---|---|---|
| 「Node 只读 + 写窗口让锁」的技术契约 | **L3 SDD** | `docs/client/SDD.md` §2 架构图 / §5.1 场景 4 | **不写在本提案**；裁决后改 SDD |
| 「Fastify 常驻持锁」这一缺陷现状 | L4 plan §13.1 | `code_implementation_plan_v2.md` §13.1 | 提案给出**草案条目**（B-15，main 上该号空缺），裁决后进 plan |
| 「tdx2db.service 装哪、User 填谁」 | **L5 运维** | `docs/deploy.md` | **不写在本提案**；归 T100 交付物 |
| 「mini 库是只读快照、不可喂 tdx2db」 | **ADR-008**（已裁决，**不改策略**）+ 夹具 README | `docs/adr/ADR-008` + `apps/backend/tests/fixtures/mini-market/README.md` | 提案只给依据；**README 补一行禁令归 T100 ⑦**（§2.2） |
| 「F8 运行层验收」 | L3 SDD §12.5 + L4 plan §12.7 | 两处 | 提案给草案，裁决后同步 |
| 实测原始数据 | **证据层** | 本文件 | ✅ 已在此 |
| **本提案本身** | **证据层**（`docs/audit/`） | 本文件 | ⚠️ **不是执行依据**；T 任务与 §13 条目须裁决后才进 plan（§5 D-5） |

> ⚠️ **本提案刻意不复述 SDD 的技术契约内容**（表名列名、SQL、接口形状）——
> 那些只引用不重写（AGENTS.md「已有某一层定义了吗？→ 只引用，不复述」）。

---

## 7. 明确不在本提案范围内

| 项 | 归属 |
|---|---|
| mini 库作为测试夹具的**整体策略**（三档切换 / 两层开关 / **不由 tdx2db 更新**） | **ADR-008**（已裁决，**不动**）。⚠️ `make-mini-duckdb.mjs` 的 `TABLES` **刻意不含 `_meta`** ⇒ tdx2db 主动拒绝写入 —— **这条护栏必须保留，不要给 mini 库补 `_meta`**（§2.2） |
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
| 修改仓库文件 | **仅本文档**（`docs/audit/proposal-market-update-pipeline-fix.md`） | — |

> ⚠️ **一个需要如实记录的过程事实**：本提案文件在撰写期间**被并行的 Wave 7 会话一并提交进了 `main`**
> （commit `863e850`）—— 因为它当时就躺在**共享工作树**里，被对方的 `git add` 顺带带入。
> ⇒ 本 PR（#26）现在承担的是**「修正 + 编号校准」**的角色：
> **① mini 库降级**（§2.2 设计确认，撤销 T101）；
> **② 编号按 main 现状校准**（I-26/27/28 → **I-34/35/36**，ADR-013 → **ADR-012**，Wave 归属 → **Wave 9**）；
> **③ 补上 T78 最终审计同样判过假绿的证据**（§1.1 / §2.3.1）。
> ⚠️ 教训（值得进 AGENTS.md）：**多个 agent 会话共享同一工作树时，未跟踪文件会被别人的 `git add` 带走** ——
> 本次是**幸运**（带的是可接受的初稿），下次可能是**事故**（带的是半成品或不该带的东西）。

> ⚠️ **唯一被写入的 DuckDB 是 `/tmp/opencode/` 下的副本**；真库 `/opt/invol/quotes.duckdb` 全程只读。
> ⚠️ 真库的 `mtime` 保持 `2026-10-12 13:53:07`（与部署时一致）⇒ **本次调查未污染真库**。
