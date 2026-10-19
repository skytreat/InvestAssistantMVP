# T85b 实施记录 — 动态审计取证与裁决

> 关联：PR #16（`4e8f38f`）新增任务 T85b + I-19~I-23；本文件是实施过程的**实测证据**，结论进 `wave-1-audit.md`。
> 日期：2026-10-19。环境：后端 127.0.0.1:8081、行情库 `/opt/invol/quotes.duckdb`（1.24GB）。

---

## 1. B 取证 —— 6 个「未经独立审查」任务的补审结论

来源：PR #15 交接文档 §4.1（主 agent 自承 sub-agent 被取消后由其接手，6 个任务只有一双眼睛看过）。

### 1.1 T51 adapters.ts —— ✅ 只做两件事，未夹带第三件

通读 `packages/core/src/indicators/adapters.ts`（132 行）确认：

| 声明 | 实测 | 结论 |
|---|---|---|
| 数组补齐 | `padFront(length, values, fill)` —— 头部填 fill，长度守恒 | ✅ 仅形状变换 |
| 柱值 ×2 | `orNaN(r.histogram) * A_SHARE_HISTOGRAM_SCALE`（=2）| ✅ 仅约定变换 |
| **无第三件事** | 全文件无 EMA/DIF/DEA/Wilder 实现；算法全部委托 `fast-technical-indicators@1.1.6` | ✅ **通过** |

额外确认：`orNaN()` 把库的可选字段统一转 `NaN`（绝不产出 `undefined`）—— 属形状契约的一部分，不算第三件事。

### 1.2 T53 表名 —— ✅ 全部真实存在

交接文档担心「6 个表/视图名未经 DESCRIBE 实测」。实测 `DESCRIBE` 全部通过：

| 代码引用 | 实测列 | 判定 |
|---|---|---|
| `v_stock_qfq` | symbol,date,open,high,low,close,preclose,volume,amount,turnover,floatmv,totalmv,change_pct,amplitude,qfq_factor | ✅ |
| `v_stock_bfq` | 同上 + hfq_factor,qfq_factor | ✅ |
| `v_stock_hfq` | 同上 + hfq_factor | ✅ |
| `v_etf_qfq/bfq/hfq` | 与 stock 同构 | ✅ |
| `raw_kline_daily` | symbol,open,high,low,close,amount,volume,up_count,down_count,date | ✅ |
| `raw_symbol_class` | **symbol, class** | ✅（见 1.4） |

### 1.3 T55 表名 —— 🔴 1 处不存在的列 + 1 处空表

| 代码引用 | 实测 | 判定 |
|---|---|---|
| `raw_basic_daily.totalmv` / `.floatmv` | date,symbol,close,preclose,change_pct,amplitude,turnover,**floatmv,totalmv** | ✅ |
| `raw_tdx_blocks_member` | stock_symbol, block_code | ✅ 列名对，**但 0 行** |
| `raw_symbol_class.is_st` | **实测只有 `symbol` + `class` 两列，没有 `is_st`** | 🔴 **不存在** |

→ T55 的「排除 ST」功能当前**必然失效**（详见 §1.4 的修复方案）。

### 1.4 T55 `is_st` 的正确替代方案（已实测）

`raw_symbol_class` 无 ST 标记，但 `raw_symbol_name` 有 `name`：

```
raw_symbol_name 中 name LIKE '%ST%' → 205 条
raw_symbol_name 中 name LIKE '%退%' → 1 条
```

→ **排除 ST 应改为 `JOIN raw_symbol_name` + `name NOT LIKE '%ST%'`**（ST 前缀的 A 股名称即 ST 股）。
注意 `raw_symbol_name` 只有 **8726** 行，而 `raw_symbol_class` 有 **12449** 行 → 3723 个标的无名称，
`JOIN` 会丢掉它们 → 需用 **LEFT JOIN**（名称缺失时**不排除**，避免静默丢标的）。

### 1.5 行情数据源缺失（→ T85b ④）

```
raw_tdx_blocks_info      0 行      ← 板块/行业元数据全空
raw_tdx_blocks_member    0 行      ← 板块成分全空
raw_symbol_class      12449 行    （stock 6158 / etf 2839 / unknown 1357 / block 1128 / index 801 / bstock 166）
raw_symbol_name        8726 行    ← 缺 3723 条（名称缺失）
```

**影响**：
- T85④C5「板块完整性」→ 数据源为空，**必须判 SKIP**（数据源缺失 ≠ 校验通过）
- T55/T73「行业过滤」→ **必须降级为不按行业过滤**并在响应中标注（不得静默丢标的）
- `class='unknown'` 有 1357 条 → 标的类型过滤同样要降级

### 1.6 T52 两份 KDJ —— 留待 §1.7 的非 golden 交叉验证（本轮 T85b 完成后做）

### 1.7 T57 / T94 —— 留待 T89a/T90 批次一并处理

---

## 2. T85b 四项缺口的现状实测

### ① 信号生成不按用户自选/持仓跑（I-19，最严重）

实测 `apps/backend/src/services/pluginEngine.ts` 的 `executeAllPlugins()`：

```ts
const res = await executePlugin(plugin, {}, ctx);   // ← 传空参
```

→ 插件落到 `paramSchema` 的硬编码默认 `symbol:'sh600000'`；
`scheduler.ts` 从不查 `user_asset_rel`；`PluginContext.batchGetDailyKlines` 无任何调用方。

**T88 只修了计时边界（IO 不计入 50ms），标的域完全没动。**

### ② `getLatestTradingDay()` 返回「最近的节假日」（I-20）

实测 `apps/backend/src/services/marketData.ts`：

```sql
SELECT date FROM raw_holidays WHERE date <= ? ORDER BY date DESC LIMIT 1
```

`raw_holidays` 存的是**休市日** → 返回最近一个**休市日**。
实测 `raw_holidays` 内容：`2026-09-25, 10-01, 10-02, 10-05, 10-06, 10-07`（国庆 + 中秋）。

→ `getLatestTradingDay('2026-10-18')` 返回 **2026-10-07**（休市日），
而 DuckDB 最新有数据的交易日是 **2026-10-12**。
→ `routes/stockscan.ts` 用它查 `v_stock_qfq` → **0 行** → `totalCandidates: 0`（G6.3 第二根因）。

**三处「最新交易日」口径实测互不相同**：

| 来源 | 值 | 问题 |
|---|---|---|
| `new Date().toISOString()` | 2026-10-18 | 周日，非交易日 |
| `MAX(date) FROM v_stock_qfq` | 2026-10-12 | ✅ 正确 |
| `getLatestTradingDay()` | 2026-10-07 | ❌ 休市日 |

### ③ C6 / C9 的 SQL 语法错误（I-21）

`ARRAY_AGG(symbol ORDER BY random() LIMIT 50)` —— DuckDB **不支持在 `ARRAY_AGG` 的 ORDER BY 内写 LIMIT**。

实测：`C6 ERROR: Parser Error: syntax error at or near "LIMIT"`、`C9 ERROR`（同）。

> T85（PR #15 的 `044c978`）已重写 C6 → 顺带修掉。**C9 仍需显式修**（T97 只覆盖 C9 的抽样参数，不含这条语法错）。

### ④ 板块表为空（I-22）

见 §1.5。

---

## 3. 自行裁决记录

| # | 裁决点 | 决定 | 依据 |
|---|---|---|---|
| 1 | G1.5「旧名全部 404」 vs T90③「保留 @deprecated 别名」| **旧名 404** | G1.5 是硬 gate，任务卡建议让位 |
| 2 | T85b ① 后 `stats.total` 语义 | 保持 = 插件数，新增 `symbolCount` | 不改写既有 G1.3a 断言 |
| 3 | 14 项待裁决 | 明确 bug 直接修；业务口径（K/J/M）登记不拍板 | AGENTS.md §9.3 |
| 4 | 6 个未审查任务 | 本文件 §1 补审 | PR#15 §4.1 点名要求 |
| 5 | `data/business.db` 污染 | 先备份再清 seed/int | PR#15 交接文档 §7 |
