# 迷你行情库夹具（mini market fixtures）

> 🔴 **为什么存在**：CI 环境**没有真实行情库** —— 仓库根的 `data/quotes.duckdb` 只是
> 12KB 的**空壳**（无 `v_stock_qfq` 等表），本机真库是 `/opt/invol/quotes.duckdb`（1.24GB，
> **不能进 git**）。于是「依赖真实行情数据」的用例在**本地全绿、CI 全红**
> （PR #15 后续 24 个 commit 从未过 CI 就是这个原因）。
>
> 本目录用 **Parquet**（不是二进制 `.duckdb`）承载一份**迷你行情库**，
> 测试前由 `scripts/make-mini-duckdb.mjs` 现生成 `.duckdb`。

## 规格（已定案）

| 项 | 值 | 实测 |
|---|---|---|
| 标的数 N | **250**（总量） | 250 |
| 必选标的 | 测试/源码里引用到的（真库中存在的 51 个） | 51 |
| 补足方式 | 按**真库真实 class 比例**（stock 49.5% / etf 22.8% / unknown 10.9% / block 9.1% / index 6.4% / bstock 1.3%）| 124/57/27/23/16/3 |
| 抽样确定性 | `hash(symbol)` 排序（**不是随机** ⇒ 可复现）| FNV-1a 32bit |
| 跨度 | **365 自然日** = **242 个交易日**（半年 119 根不够 golden 需要的 221 根）| 242 |
| 视图 | **6 张全部重建**，定义从真库 `duckdb_views()` **导出** | 6/6 DDL 逐字一致 |
| 体积 | 目标 ≤ 20MB | 迷你库 **3.5MB** / Parquet 合计 **1.5MB** |

## 三档切换（`MARKET_DATA_MODE`）

| 档 | 取值 | 行情库来源 |
|---|---|---|
| dev | `mini` | 磁盘上已有的 `data/quotes.mini.duckdb`（gitignored） |
| CI | `ci` | **现生成**（`$TMPDIR/invest-mini-market/quotes.mini.duckdb`） |
| full | `full` | **真库**（`DUCKDB_PATH`，**显式**指定） |
| 默认 | `auto` | `DUCKDB_PATH` 有值 → full；否则 → mini |

## 两层开关（能力分级）

| 能力 | 迷你库 | 真库 | 依据 |
|---|---|---|---|
| `numeric`（数值型） | ✅ | ✅ | 迷你库是真库的**逐位一致子集**（实测 10 表行数全等、6 视图 34839 行 0 数值差异、DDL 逐字一致） |
| `scale`（规模型） | ❌ | ✅ | 迷你库 stock 104 只 vs 真库 5561 只 |
| `performance`（性能型） | ❌ | ❌ | 迷你库测不出「5000 标的 ≤3s」 |

## 重新生成

```bash
# ① 从真库抽取（写 Parquet + manifest）—— 需要本机有真库
node scripts/make-mini-duckdb.mjs extract --source /opt/invol/quotes.duckdb

# ② 由 Parquet 构建迷你 .duckdb（**不需要真库** —— CI 走这条）
node scripts/make-mini-duckdb.mjs build --out data/quotes.mini.duckdb
```

## ⚠️ 注意事项

- ⚠️ `raw_holidays` **没有 `symbol` 列**（实测 schema 只有 `date`）⇒ **不能按 symbol 切片**，
  抽取时取**全表**（680 行）。
- ⚠️ 视图枚举必须用 `starts_with(view_name, 'v_')` ——
  DuckDB 的 `LIKE` **不把反斜杠当转义符**（实测 `LIKE 'v\_%'` 返回 **0 行**，
  `LIKE 'v_%'` 返回 7 行含系统视图，`starts_with` 返回 6 行）。
- ⚠️ `raw_tdx_blocks_info` / `raw_tdx_blocks_member` / `raw_kline_1min` 在真库中**均为 0 行**
  —— 仍建空表以保结构（视图/查询不会因缺表报错）。
- ⚠️ 本目录的 Parquet 是**真库内容的抽样**（非合成数据）⇒ 数值型断言可信；
  但**规模/性能型断言必须用真库**（见「两层开关」）。
