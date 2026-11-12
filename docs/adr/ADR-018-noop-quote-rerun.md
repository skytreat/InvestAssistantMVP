# ADR-018 —— 校验 WARN/ERROR 不再自动补跑（补跑改为「可测空跑」）

| 项 | 值 |
|---|---|
| **状态** | ✅ 已接受（2026-11-12，用户确认「tdx2db 会空跑」后落地） |
| **落地** | 本次修复（`scheduler.ts` / `quoteRerun.ts` / `routes/admin.ts`，无新 T 号） |
| **关联偏差** | §13.2 **I-37**（新增）；部分消解 **I-36 ④**（补跑抢锁） |
| **关联文档** | Requirements §7.1（校验处置列）、SDD §5.1 Step 3、PRD D3 |
| **取代** | 取代 G3a 的「WARN/ERROR → 自动补跑」实现口径（不取代 ADR-012 的写窗口协议） |

---

## 1. 背景（结构性证明，非估计）

### 1.1 校验只在「当日数据已存在」时才会执行

`runScheduledDatacheck()`（`apps/backend/src/services/scheduler.ts`）的三条入口：

```
hasData = await hasQuoteDataOn(date)          // SELECT COUNT(*) FROM v_stock_qfq WHERE date = ?
if (!hasData && update.state !== 'SUCCESS')   → UPDATE_FAILED，直接 return（不校验）
if (!hasData)                                 → 补跑一次；仍无数据 → NO_DATA_AFTER_RERUN（不校验）
                                              → 有数据才继续
runDatacheckWithRerun(date)                   ← 此时 hasData 必为 true
```

其中 `hasQuoteDataOn()` 的实现是 `validator.ts` 里对 `v_stock_qfq` 的当日行数查询。
⇒ **`runDatacheckWithRerun()` 的每一次调用，其前置条件都是「当天行情已经入库」。**

### 1.2 tdx2db `cron` 是按日期增量，不是强制重取

- 定时任务与补跑用的是**同一条命令**：`tdx2db cron --dburi duckdb:///…`
  （`deploy/tdx2db.service` 与 `quoteRerun.ts` 的 `DUCKDB_URI` 一致）；
- 该命令**没有** `--force` / `--date` / `--symbols` 之类的重取参数（仓库内无 tdx2db 源码，
  但部署命令与实测行为均如此）；
- 用户实测结论：**当日已入库时 tdx2db 空跑**（本次决策的直接依据）。

### 1.3 结论

「17:01 校验发现 WARN/ERROR → 再跑一次 tdx2db」在 1.1 + 1.2 下**必然空跑**。
这不是「有时无效」，而是**结构性无效**：

| 场景 | 是否会进校验 | 补跑是否有用 |
|---|---|---|
| 当天整日缺失 | ❌（先走无数据分支） | 有用（唯一有效路径，已保留） |
| 当天部分缺失（C1 数量不足） | ✅ | ❌（日期已存在 ⇒ 整日跳过） |
| 当天数据有但内容异常（C3/C5/C7/C8/C9/C10） | ✅ | ❌（同左） |

### 1.4 空跑不只是「没用」，还有害

1. `enterDuckDBWriteWindow()` 会关闭 Node 的 DuckDB 只读实例并创建写窗口哨兵；
   systemd oneshot 最长 30 分钟（实际 10+ 分钟）；
2. 17:01 是串行队列，17:02 信号 / 17:03 除权 / 17:04 纸面日更都要等写窗口结束
   ⇒ **一次无效补跑把整条盘后链路推迟十几分钟**；
3. `quoteRerun` 原先在 exit 0 时写 `level=SUCCESS「补算成功」`，
   而数据实际未变 ⇒ **日志与事实相反**，误导排障。

## 2. 决策

1. **删除「校验 WARN/ERROR → 自动补跑」**：
   `runDatacheckWithRerun()` 只跑一次校验并记录结果，不再调用 `rerunQuoteUpdate()`；
   返回值新增 `rerunSkippedReason: 'noop-by-design'` 作为显式证据。
2. **保留唯一有效的补跑**：`runScheduledDatacheck()` 中
   「tdx2db 报成功但当天仍无数据 → 补跑一次」的既有分支不变。
3. **补跑改为可测**：`rerunQuoteUpdate(reason, { date })` 在补跑前后各取一次当日指纹
   （`raw_kline_daily` / `raw_basic_daily` / `raw_adjust_factor` 的 `count(*)` + `sum(hash(...))`），
   返回 `effective`：
   - `true` = 数据确有变化；
   - `false` = 空跑（写 `WARN` 日志「当日行情数据无变化（空跑）」）；
   - `null` = 未采集（未传 date / 查询失败），**不把采集失败误判为空跑**。
   管理员手动补跑 `/api/admin/rerun-quotes` 同样透传 `effective`。
4. **日志不再撒谎**：补跑成功只写「tdx2db 补跑 exit_code=0（通道）」，是否生效看 `effective`。

## 3. 后果

**正面**

- 17:01 不再因无效补跑阻塞后续 cron 段与写窗口；
- 消除 `SUCCESS/补算成功` 的虚假信号，排障以 `effective` 为准；
- 与 Requirements §7.1 的「C5/C7/C8/C10 只记录 / 人工确认」口径一致（原先反而多补了）。

**负面 / 代价**

- Requirements §7.1 中 C1/C2/C3/C4/C6/C9(ERROR) 的「自动补算」在**当前 tdx2db 能力下不可实现**
  ⇒ 该业务承诺暂时降级为「记录 + 告警 + 人工处理」，已登记为 I-37；
- 若未来 tdx2db 支持 `--date/--symbols/--force`，需要按「定点修复」重新设计（见 §6）。

## 4. 备选方案与否决理由

| 方案 | 否决理由 |
|---|---|
| 维持现状（继续补跑） | 结构性空跑 + 阻塞链路 + 日志误导；且 I-36 ④ 的「补跑与 17:00 进程抢锁」问题被放大 |
| 给 tdx2db 加 `--force` 后补跑 | 第三方 Go 二进制，仓库无源码；MVP 内不改造上游；且全量重取代价远高于定点修复 |
| 补跑后仅 `sleep` 等待 | 不改变「不写库」的事实，只会更慢 |
| 对所有 WARN 一律跳过且不记录 | 丢失人工处理依据；本决策保留 WARN/ERROR 日志与告警 |

## 5. 验证

- 真实库指纹 SQL 实测（`data/quotes.duckdb`，1.24GB，2026-11-06）：
  `SELECT COUNT(*) ... SUM(hash(...))` 三表联查 **~2.3s**，`hash()` 与 `CAST(... AS VARCHAR)` 可用；
- 单测：`apps/backend/tests/unit/quoteRerun.test.ts`
  - 前后指纹一致 → `effective=false` + WARN 日志；
  - 指纹变化 → `effective=true`；
  - 指纹查询失败 → `effective=null` 且补跑仍 SUCCESS；
  - `runDatacheckWithRerun` 对 C1 WARN / C2 ERROR **均不再调用** `rerunQuoteUpdate`，
    且只跑一次校验；
- 调度单测：`schedulerGate.test.ts` 覆盖「校验 WARN → 不补跑」与
  「无数据补跑 → 透传 `rerunEffective`」；
- 集成测试：`cronSequence.test.ts` 断言 17:01 有 ERROR 时 `rerunQuoteUpdate` 调用数为 0。

## 6. 后续（不在本次范围）

「自动补算」若要恢复业务语义，必须改为**定点修复**而非整库重跑：

1. C9/C10（复权口径）→ 用 C11/C12 已接的上游源重取涉事标的；
2. C1/C6（缺标的/缺字段）→ 需要 tdx2db 提供按 `date + symbols` 的补齐能力；
3. C3/C4（因子/除权滞后）→ 需要上游强制刷新或等次日。

在这些能力落地前，17:01 的职责是**如实记录 + 告警**，不是「假装自愈」。
