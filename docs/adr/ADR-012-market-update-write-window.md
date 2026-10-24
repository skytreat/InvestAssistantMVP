# ADR-012 —— 行情更新链路的跨进程写窗口协调协议

| 项 | 值 |
|---|---|
| **状态** | ✅ 已接受（2026-10-21，所有者裁决 D-2） |
| **落地任务** | T99（访问模型）/ T100（部署态）/ T102（验收升级） |
| **关联偏差** | §13.1 **B-15**（阻断级）、§13.2 **I-34** / **I-35** / **I-36** |
| **关联提案** | [`docs/audit/proposal-market-update-pipeline-fix.md`](../audit/proposal-market-update-pipeline-fix.md)（证据层） |
| **取代** | 无（ADR-001~011 均不涉及 DuckDB 跨进程并发） |

---

## 1. 背景（实测数据，非估计）

### 1.1 DuckDB 是**单写者文件锁**，不是 MVCC 共享读

DuckDB 的文件锁是**进程间排他**的：一个进程以读写模式打开库文件后，**其他进程**（哪怕只读）一律被拒。

```console
# 实验 A：默认模式（读写）持锁 → 另一个进程读写全失败
$ node defholder.js &
  第二个进程 READ_ONLY  => FAILED: IO Error: Could not set lock on file
                               "…/deftest.duckdb": Conflicting lock is held in
                               /usr/bin/node (PID 696275) by user ubuntu.
  第二个进程 READ_WRITE => FAILED: 同上

# 实验 B：持锁者改只读，也仍然阻塞写入方
$ node roholder.js &     # access_mode: 'READ_ONLY'
  第二个进程 READ_WRITE => FAILED: Conflicting lock …
  第二个进程 READ_ONLY  => OPEN OK      ← 只读之间可共存

# 实验 C：锁由 instance 持有，关掉 connection 不释放
$ node instonly.js      # conn.closeSync() 后 instance 仍在
  第二个进程 READ_WRITE => FAILED: Conflicting lock …
```

### 1.2 Node 侧当前是「长驻 + 可写」

`apps/backend/src/db/duckdb.ts` 的 `getInstance()`：

- `DuckDBInstance.create(resolveDuckDBPath())` —— **未传 `access_mode`** ⇒ 默认读写模式（实测会生成 `.wal`）
- instance 挂在 `globalThis.__investDuckDBSingleton__` ⇒ **进程内单例**
- `closeDuckDBInstance()` **生产代码零调用点**；`server.ts` 的 SIGTERM 只 `process.exit(0)`

⇒ 与 **AGENTS.md:376**（Node 对 DuckDB 只有 SELECT 权限）、**AGENTS.md:378**（按需打开关闭，不常驻连接）
**直接冲突** —— 文件头注释自称「只有 SELECT 权限」，但代码是可写的。

### 1.3 后果：外部写进程被完全挡住

```console
$ node -e "…DuckDBInstance.create('/tmp/opencode/prodlock.duckdb')…"   # 常驻 instance
$ tdx2db cron --dburi 'duckdb:////tmp/opencode/prodlock.duckdb'
🛑 错误: failed to connect to database: database/sql/driver: could not connect
   to database: IO Error: Could not set lock on file
   "/tmp/opencode/prodlock.duckdb": Conflicting lock is held in
   /usr/bin/node (PID 696275) by user ubuntu.
```

⇒ **只要 Fastify 进程活着并已打开过行情库，17:00 的 tdx2db 就写不进去。**
⇒ 这与「systemd unit 没装」「用户不存在」「目录不可写」是**三个独立根因**，修任一个都不够。

### 1.4 修复方向已实测可行

```console
$ node fixcheck.mjs
[1] Fastify 侧 instance 持有中（模拟现状）
    tdx2db => Command failed: …（Conflicting lock）
[2] 已 closeDuckDBInstance()（模拟修复后）
    tdx2db => 🟡 00010103 数据尚未发布 …   ← 已连上库并进入拉取流程
```

⇒ **释放 instance 后 tdx2db 立即可写** —— 问题只剩「谁决定何时释放」。

### 1.5 附带发现：SDD 的现有表述被实测证伪

`docs/client/SDD.md:1563`（§5.1 协调机制场景 4）写：

> 「Fastify 只读连接 open 时 DuckDB MVCC 自动处理 reader/writer 共存」

⇒ **实测证伪**（DuckDB 是单写者文件锁，不是 MVCC 共享读）。本 ADR 取代该表述。

---

## 2. 决策

> **窗口的起止由外部写进程（systemd unit）决定；Node 侧只做「检测到就惰性让锁」的被动响应。**

### 2.1 机制：哨兵文件 + 惰性让锁

```
tdx2db.service (systemd)                      Node 侧 (Fastify)
─────────────────────────────────────         ────────────────────────────────────────
ExecStartPre  → 写 /opt/invol/.tdx2db-writing
  (tdx2db 独占写入 DuckDB)
ExecStartPost → 删 /opt/invol/.tdx2db-writing
                                              查询前检查哨兵：
                                                ├─ 存在 → closeDuckDBInstance()
                                                │          返回可重试错误（503 / Retry-After）
                                                └─ 不存在 → 正常查
                                              17:01 校验段：
                                                哨兵存在 → 轮询等待其消失（带超时）
                                                           → 再跑 C1-C12
```

> ⚠️ **方向 A 只解决「外部写」**。**Node 自己触发写**（手动补跑 / 自愈补跑）必须走**方向 B**（主动 close）—— 见 §2.3。

### 2.2 「谁决定何时 close」的明确回答

| 主体 | 决定什么 | 凭什么 |
|---|---|---|
| **systemd（`tdx2db.service`）** | **窗口的起止**（何时开始写、何时写完） | 它是唯一知道「我此刻在写库」的主体 |
| **Node（Fastify）** | **执行 close 的时刻**（惰性） | 下一次查询前发现哨兵 → 立即 close |

⇒ **Node 不需要知道 tdx2db 的内部状态、不需要预测窗口、不需要与它通信**。
⇒ `Persistent=true` 导致补跑窗口漂移到任意时刻（开机时刻）也**照样成立** —— 哨兵跟着 tdx2db 走。

### 2.3 🔴 方向 B：Node **自己**触发写入（手动补跑 / 自愈）—— 必须**主动**让锁

> 🔴 **初稿遗漏的场景**（2026-10-21 补入）：方向 A 解决的是「**外部写 → Node 让锁**」；
> 但**手动触发补跑**（`POST /api/admin/rerun-quotes`）与**自愈补跑**
> （`scheduler.ts:48` 的 `runDatacheckWithRerun`）是**反方向** ——
> **是 Node 去叫 tdx2db 写**，此时 Node 自己就是持锁方 ⇒ **必须由 Node 主动 close**。

#### 2.3.1 现状：手动触发路径**零 close** ⇒ 三级降级链全部失败

| 事实 | 实测 |
|---|---|
| `services/quoteRerun.ts` / `routes/admin.ts` 里 `closeDuckDBInstance` | **0 命中** |
| `server.ts:52` 的 `duckdbHealthCheck()` → `openConnection()` → `getInstance()` → `DuckDBInstance.create()` | ⇒ **Fastify 启动那一刻就创建 instance 并持锁** ⇒ 17:00 的 tdx2db **100% 失败**（不是概率问题） |
| 三级降级链（`systemd-run` / `systemctl start` / `execFile`） | **全部是独立进程** ⇒ 全部需要写锁 ⇒ **全部被挡** |

```console
# 实测：Node 持锁时，直接 exec 真 tdx2db 二进制
[1] instance 已持有（模拟 Fastify 现状）
    直接 exec tdx2db => 🛑 错误: failed to connect to database: IO Error:
                        Could not set lock on file …
```

#### 2.3.2 方向 B 的协议

```
rerunQuoteUpdate():                              ← 手动触发 / 自愈补跑的共同入口
  1. inProcessWriting = true        ← 进程内互斥标志：期间**拒绝新建 instance**
  2. await closeDuckDBInstance()    ← 释放文件锁
  3. await execFile(tdx2db cron)    ← 拿到锁、写入；execFile 本身同步等待，返回即写完
  4. inProcessWriting = false       ← 恢复
  5. 下次查询惰性重建 instance
```

✅ **实测可行**（复刻 `duckdb.ts` 的单例语义）：

```console
[1] instance 已持有（模拟 Fastify 现状）
    直接 exec tdx2db => 🛑 错误: failed to connect to database: IO Error: Could not set lock …
[2] 方向 B：close → exec → 惰性重建
    closeDuckDBInstance() 已执行
    exec tdx2db => 🟡 00010701 数据尚未发布      ← 已拿到锁并进入拉取流程
[3] 惰性重建后查询仍可用 => [42]
```

#### 2.3.3 ⚠️ 只 close **不够** —— 必须同时禁止窗口内重建 instance（实测竞态）

```console
[A] close 之后、tdx2db 启动之前，有一个并发查询进来：
    并发查询已重建 instance（锁又被抢回）
    tdx2db => ❌ 失败: 🛑 错误: failed to connect to database: IO Error: Could not set lock …
```

⇒ **close 与 exec 之间存在一个窗口**，任何并发查询都会走 `getInstance()` 惰性重建 instance ⇒ **把锁抢回来** ⇒ tdx2db 又被挡。
⇒ 故 `inProcessWriting` 标志**不是可选优化，而是方向 B 的必要组成部分**：
标志为真时，`getInstance()` **不得重建**，查询返回可重试错误。

#### 2.3.4 两个方向如何配合（闭环）

| 方向 | 触发者 | 谁让锁 | 何时让锁 |
|---|---|---|---|
| **A** 外部写 | systemd timer 17:00（tdx2db 自主启动） | **Node 被动** | 检测到哨兵 ⇒ 让锁 + 返回可重试 |
| **B** Node 触发写 | 管理员手动补跑 / 17:01 自愈补跑 | **Node 主动** | 调 `rerunQuoteUpdate()` ⇒ 先置标志 + close，再 exec |

**闭环**：
方向 A 存在**毫秒级残留竞态**（哨兵写入前一刻 Node 恰在查询 ⇒ tdx2db 首次抢锁失败）
→ systemd 记失败 → **17:01 校验发现数据未更新 ⇒ 判 WARN/ERROR**
→ 触发 `runDatacheckWithRerun` ⇒ 走**方向 B**（此时 Node 主动让锁，**必定成功**）
⇒ **两个方向缺一不可**：A 负责「常规路径」，B 负责「兜底自愈」。

### 2.4 配套改动（T99）

1. `db/duckdb.ts`：`DuckDBInstance.create(path, { access_mode: 'READ_ONLY' })` —— 落实 AGENTS.md:376
2. `db/duckdb.ts`：新增**进程内写窗口标志** `inProcessWriting` —— 为真时 `getInstance()` **不得重建**（否则并发查询会抢回锁，见 §2.3.3）
3. `db/duckdb.ts`：新增**哨兵检测** + 惰性 `closeDuckDBInstance()` + 重新获取（惰性重建）—— 方向 A
4. `services/quoteRerun.ts`：**方向 B** —— `rerunQuoteUpdate()` 先置 `inProcessWriting` + `closeDuckDBInstance()`，**再** exec tdx2db，结束后清标志（覆盖**手动补跑**与**自愈补跑**两条路径）
5. `server.ts`：SIGTERM 时 `closeDuckDBInstance()` 后再退出
6. `services/scheduler.ts`：17:01 校验段在窗口内**轮询等待**（带超时），避免读到半写状态
7. `services/scheduler.ts`：四个 `AsyncTask` 加 `preventOverrun: true`（消除 17:01/17:02 段重叠）
8. 🔴 **所有关闭路径必须共用同一个幂等入口** —— `closeDuckDBInstance()` 需保证：
   **重复调用安全**、**与在途查询串行化**、**关闭期间 `getInstance()` 不得重建**。
   方向 A（哨兵）、方向 B（主动让锁）、空闲即关（§2.5）三者作用于**同一个 instance 生命周期**，
   若各写各的关闭逻辑 ⇒ **双重关闭竞态**（方向 B 正在等 tdx2db，idle timer 同时判定该关 ⇒ 互踩）。
   ⇒ 三者**共用一个状态机**（`inProcessWriting` / `idleClosing` 标志 + 幂等 `close`）

### 2.5 空闲即关：**资源治理手段，不是锁竞争方案**（可选项）

> ⚠️ **定位澄清（2026-10-21 补充）**：本 ADR 初稿把「空闲即关」与方向 A/B 并列讨论，
> 容易被误读为「三选一的锁方案」。**它不是。**

#### 2.5.1 它解决什么、不解决什么

| | 作用 | 与锁竞争的关系 |
|---|---|---|
| ✅ **内存回收** | 实测 **325.7 MB → 98.0 MB**（释放 **~222 MB**）—— DuckDB 的 buffer pool | **无关** |
| ✅ **规则字面合规** | 落实 AGENTS.md:378「不常驻连接」 | 间接（不持锁就不会挡） |
| ⚠️ **降低撞锁概率** | 没人用的时候它自己就松手了 | **只是概率**，且见 §2.5.2 的反直觉点 |
| ❌ **不能替代方向 A/B** | — | **无确定性** |

#### 2.5.2 反直觉点：**它帮不上最需要它的那 17:00**

17:00 是收盘后 —— 用户可能刚看完盘就关掉（空闲）⇒ 此时它有用。
但用户**也常在收盘后习惯性刷新一下行情**（活跃）⇒ 此时它**完全无效**。

> ⇒ **「用户刚看完盘」恰是行情更新最需要成功的时刻，也是撞锁概率最高的时刻。**
> ⇒ 而空闲即关恰恰在这个时刻帮不上忙 ⇒ **它不能承担锁竞争的职责。**

#### 2.5.3 有了 A + B 之后，它的定位只剩「资源」

- **方向 A** 保证 17:00 那一刻**确定性**让锁（不管有没有人在用）
- **方向 B** 保证任何时候都能**主动**让锁（自愈兜底）

⇒ 二者落地后，空闲即关对「锁竞争」**不再必要**，只剩 §2.5.1 的内存与合规两项价值。

#### 2.5.4 但它让「细粒度按需开关」变得可负担（这是它真正的独特价值）

| 粒度 | 代价 | 命中场景 |
|---|---|---|
| **每次查询都开关** | **每次 +46.2ms**（实测 open+query+close 均摊） | 每个请求都付 |
| **空闲 N 秒才关** | **只有冷路径付 46.2ms** | 每 N 分钟的第一个查询 |

⇒ 空闲即关是把 AGENTS.md:378「按需打开关闭」这条规则**做成细粒度**的手段，
而不是「每次都开关」的替代品。

#### 2.5.5 实测依据（2026-10-21，Node 进程 RSS）

```
baseline RSS            69.5 MB
open instance 后         91.4 MB   ← instance 本身 ≈ 22 MB
跑一次视图聚合后        325.7 MB   ← buffer pool 吃掉 ~234 MB
close conn 后            320.3 MB   ← 🔴 关连接**不释放** buffer pool
close instance 后         98.0 MB   ← 释放了 ~222 MB
重开 instance 后         98.1 MB
```

> ⚠️ 「关 connection ≠ 不常驻」—— **只有关 instance 才释放 buffer pool**。
> 这也是 §2.4 第 8 条（幂等 close 入口）必须作用在 **instance** 层的原因。
>
> ⚠️ `close instance` 后 RSS 未回落到 69.5 MB（停在 98 MB）⇒ glibc arena 未归还 OS，
> 但 **DuckDB 侧分配已释放**（重开 instance 后 RSS 不再继续增长）。

#### 2.5.6 决策

| 项 | 结论 |
|---|---|
| 是否纳入 T99 | **可选项**，与 A/B 解耦；建议**独立开关**（env 覆盖），默认可开可关 |
| 优先级 | **低于 A/B**（A/B 是功能正确性，本项是资源优化） |
| 前提 | 必须复用 §2.4 第 8 条的**同一个幂等 close 入口**，否则会出双重关闭竞态 |

---

## 3. 代价（明确接受）

| 代价 | 说明 | 缓解 |
|---|---|---|
| **写窗口内行情 API 不可用** | 返回 503 + `Retry-After` | 桌面单机场景可接受；窗口通常 < 2 分钟 |
| **需要跨进程信号载体** | 哨兵文件（写/删） | 纯文件，无新依赖，无 IPC |
| **Fastify 侧需认识哨兵路径** | 新增一个可配置项 | 硬编码 `/opt/invol/.tdx2db-writing` + env 覆盖 |
| **DuckDB `.wal` 需在库文件同目录可写** | 部署态要求 | 精确 `chown`（目录 + 库文件），**不用 `chown -R`**（否则整个项目目录连同 `.git`/`node_modules` 归属改变） |
| **只读 + 惰性 close 的连接语义变化** | 连接可能在下一次查询时重建 | 惰性重建，首次查询多 ~29ms（实测） |
| **空闲期持锁** | 空闲即关**未启用**时，Node 仍常驻持锁 ⇒ tdx2db 在该时刻写不进 | 方向 A（哨兵）确定性让锁兜底；空闲即关（§2.5，可选）进一步降低概率 |
| **DuckDB buffer pool 内存常驻** | 实测跑一次视图聚合后 RSS **325.7 MB**，其中 buffer pool ~234 MB ⇒ **只关 connection 不释放**（320.3 MB），**只有关 instance 才释放**（98.0 MB） | 空闲即关（§2.5）回收 ~222 MB；或接受常驻开销 |
| **手动补跑期间行情 API 不可用** | 方向 B 的 `inProcessWriting` 期间拒绝新查询 | 桌面单机场景可接受；补跑通常 < 1 分钟 |
| **close 与 exec 之间有竞态窗口** | 并发查询可能重建 instance 抢回锁 | **必须**用 `inProcessWriting` 标志禁止窗口内重建（实测：不做则 tdx2db 必失败，§2.3.3） |

---

## 4. 备选方案与否决理由

| 方案 | 否决理由 |
|---|---|
| **每次查询都开关 instance** | ⚠️ **初稿的否决理由不准确，已更正**：原文写「+46.2ms/次 ⇒ 与 PE4（p99<200ms）冲突」—— **实测不冲突**：PE4 **单请求**口径实测 p99 = **96.7ms（轮1）/ 99.1ms（轮2）**（`fullstack-audit-v2.md` §9.5），加 46.2ms 后 ≈ **143ms**（1 query/请求）~ **189ms**（2 queries/请求）⇒ **仍 < 200ms**。<br>**真正的否决理由是**：① 并发档（`-c 100`）**本来就 3.0s 不达标**（已登记 §9.3 **D-4** / §13.2 **I-28**），每次开关会把这条偏差**推得更远**；② 「每次都付 46.2ms」却只换来**概率性**让锁（撞上就失败），而**方向 A 能给确定性** ⇒ 性价比不划算。<br>⇒ 改由 **§2.5 的「空闲即关」**承担细粒度按需开关（只有冷路径付这 46.2ms）。 |
| **Node 主动探测**（尝试 RW 打开判断） | 探测本身要开 RW ⇒ **失败即说明被占**，但这等于用「打开失败」当信号，语义脆弱且有竞态 |
| **Node 主动定时 close**（17:00 前 5 秒关、17:05 后重开） | 与 tdx2db 的实际运行时长耦合；`Persistent=true` 补跑会让窗口漂移到开机时刻 ⇒ **定时假设失效** |
| **写库期间 Fastify 整体停机** | 桌面应用不可接受；且与 SDD §5.1 时序图「17:00 写 → 17:01 读」的连续性要求冲突 |
| **改 tdx2db 支持多进程读写** | Go 二进制不在本仓库；DuckDB 本身不支持同文件多写者 |
| **把行情库拆成读写两份 + 原子替换** | tdx2db 的增量判定依赖旧库的 `max(date)` ⇒ 必须能读到旧库 ⇒ 与「写新文件」互斥；且 1.24GB/天拷贝，磁盘仅剩 6.2GB（87% 已用） |

---

## 5. 跨平台说明（**Windows 不在 MVP 交付范围，但本决策不堵死这条路**）

**范围事实**：`docs/deploy.md:3` 明确部署目标为「OCI 云数据库 ARM 2C12G **Ubuntu 24.04**」；
`AGENTS.md:80` 硬编码「使用 systemd 管理普通 Node 进程」；
**PRD / Requirements 中 Windows、macOS 各 0 处命中** ⇒ **MVP 不要求跨平台交付**。

**若将来需要 Windows 桌面部署**，机制映射如下（哨兵方案与平台无关）：

| Linux / systemd | Windows 等价物 | 备注 |
|---|---|---|
| `tdx2db-update.timer`（`OnCalendar=*-*-* 17:00:00`） | **Task Scheduler** 每日 17:00 任务 | `schtasks /create /sc daily /st 17:00` |
| `tdx2db.service`（`Type=oneshot`） | 同一 Task 的 action | — |
| `User=invol` | **当前登录用户** | 无需建用户 |
| `chown /opt/invol` | **NTFS 目录 ACL** | ⚠️ DuckDB 的 `.wal` 要在**同目录**可写 —— 这是 Windows 上唯一的坑 |
| `ExecStartPre/Post` 哨兵 | 同一 Task 的前置/后置 action | **纯文件，跨平台通用** |
| `journalctl` | 事件查看器 / Task 历史 | — |
| `Persistent=true` 补跑 | Task「错过任务后尽快运行」 | — |
| `WorkingDirectory=/opt/invol` | Task「起始于」 | — |
| `RandomizedDelaySec=30` | Task 的随机延迟选项 | — |

> ⚠️ **Windows 上 DuckDB 的文件锁更严**（`docs/audit/handoff-wave1.md:103` 记过「Windows 锁文件」现象）
> ⇒ **「写窗口让锁」是跨平台必需的机制，不是 Linux 专属补丁**。
> ⇒ 反过来说：若把「Node 常驻持锁」当作 Linux 特性绕过，**Windows 上会更早炸**。

**tdx2db 官方预编译包覆盖**：`Linux_arm64` / `Linux_x86_64` / `Windows_x86_64` / `Darwin_arm64`（v2026.8.12）⇒ 二进制本身不构成平台障碍。

---

## 6. 与既有决策的关系

| 关系 | 说明 |
|---|---|
| **不取代** ADR-001~011 | 均不涉及 DuckDB 跨进程并发 |
| **修正 SDD** | `SDD.md:1563`（§5.1 场景 4「MVCC 自动处理 reader/writer 共存」**被本 ADR §1.1 实测证伪**） |
| **落实 AGENTS.md:376/378** | 「只有 SELECT 权限」+「按需打开关闭，不常驻连接」—— 现状两者**都违反**（`duckdb.ts:81` 无 `access_mode` ⇒ 可写；instance 为进程级单例 ⇒ 常驻）。<br>⚠️ 值得注意：AGENTS.md:378 的括注「文件锁机制，多进程不能同时写」**就是这条规则本身的理由** ⇒ 恢复它与本 ADR 的目标**同向**，不是绕过 |
| **关联 main 的 §13.2 I-26** | 同一段单例代码的另一处缺陷（**路径绑定**：单例把首次查询那一刻的路径永久缓存）⇒ T99 建议一并改（改为「每次连接时解析路径」） |
| **关联 main 的 §13.2 I-32** | 行情用例**静默 skip** 假绿（→ §9.3 D-8）—— 与本 ADR 的 I-35 **互补不同源**，同批修 |
| **不改 mini 库策略** | mini 库**设计上不由 tdx2db 更新**（ADR-008 §2.1：10 张 raw_ 表，**不含 `_meta`**）⇒ `_meta` 缺失这条**护栏必须保留** |

---

## 7. 验收锚点（可自动验证）

1. 持锁实验：Node 侧持 instance 时，外部进程打开同库失败；`closeDuckDBInstance()` 后成功（§1.4）
2. `access_mode` 断言：生产代码中 DuckDB 打开**必须**是 `READ_ONLY`
3. 窗口行为：哨兵存在时行情 API 返回可重试错误；哨兵消失后自动恢复
4. **方向 B**：`rerunQuoteUpdate()` 执行期间（`inProcessWriting=true`）新查询被拒；exec tdx2db **拿得到锁**（实测不再报 `Conflicting lock`）
5. **竞态防护**：`inProcessWriting=true` 期间 `getInstance()` **不得重建** instance（否则并发查询会抢回锁 ⇒ tdx2db 失败，§2.3.3）
6. 17:01 段在窗口内会等待（不读到半写状态）
7. `preventOverrun` 生效：长任务未结束时同 job 不重复触发
8. 部署态：timer `enabled` + `journalctl` 有成功记录 + 真库 `max(date)` == 最近交易日（T100 交付物）
9. **幂等 close 入口**：重复调用 `closeDuckDBInstance()` 安全；关闭期间 `getInstance()` 不重建；方向 A / 方向 B / 空闲即关三者并发触发时不互踩（§2.4 第 8 条）
10. **（若启用空闲即关）内存回落**：跑一次视图聚合后 RSS 上升 → 触发空闲关闭后 **RSS 回落到 ~98 MB** 量级（实测基线，§2.5.5）
