# tdx2db DuckDB Schema 完整字段说明

> **数据源**：`jing2uo/tdx2db` v2026.8.12 预编译二进制实测 DuckDB schema dump
> **生成日期**：2026-10-15
> **写入权限**：仅 tdx2db Go 二进制；Fastify 进程只读 SELECT
> **列名约定**：所有表的日期列一律叫 `date`（不是 `trade_date`），无例外

---

## 一、原始表（raw_ 前缀）

### 1.1 `raw_kline_daily` —— 不复权日线行情（MVP 核心表）

| 字段 | 类型 | 说明 | 备注 |
|---|---|---|---|
| symbol | VARCHAR | 标的代码 | 格式 `sh600000` / `sz000001` / `sh688xxx` / `sz300xxx` |
| open | DOUBLE | 当日开盘价 | 不复权 |
| high | DOUBLE | 当日最高价 | 不复权 |
| low | DOUBLE | 当日最低价 | 不复权 |
| close | DOUBLE | 当日收盘价 | 不复权 |
| amount | DOUBLE | 当日成交额 | 单位：元 |
| volume | BIGINT | 当日成交量 | 单位：股 |
| up_count | BIGINT | 通达信内部字段（上涨笔数） | MVP 不使用 |
| down_count | BIGINT | 通达信内部字段（下跌笔数） | MVP 不使用 |
| **date** | **DATE** | **交易日期** | **列名就是 `date`，不是 `trade_date`** |

### 1.2 `raw_kline_1min` —— 不复权 1 分钟 K 线（MVP 不使用）

> 注意：AGENTS.md 明确禁止分钟级策略和盘中实时信号，这张表只在 `tdx2db cron --min` 时生成（Linux arm64 会跳过），Fastify 不读。

| 字段 | 类型 | 说明 |
|---|---|---|
| symbol | VARCHAR | 标的代码 |
| open/high/low/close | DOUBLE | 1 分钟 OHLC（不复权） |
| amount | DOUBLE | 成交额（元） |
| volume | BIGINT | 成交量（股） |
| datetime | TIMESTAMP WITH TIME ZONE | 分钟级时间戳 |

### 1.3 `raw_basic_daily` —— 每日基础指标（**含 preclose**）

| 字段 | 类型 | 说明 | 备注 |
|---|---|---|---|
| **date** | **DATE** | **交易日期** | JOIN 主键之一 |
| **symbol** | **VARCHAR** | **标的代码** | JOIN 主键之一 |
| close | DOUBLE | 不复权收盘价 | 与 raw_kline_daily.close 应一致 |
| **preclose** | **DOUBLE** | **前收盘价**（含除权修正） | C11 跨源校验必须 JOIN 这张表取 |
| change_pct | DOUBLE | 涨跌幅（%） | `(close - preclose) / preclose * 100` |
| amplitude | DOUBLE | 振幅（%） | `(high - low) / preclose * 100` |
| turnover | DOUBLE | 换手率（%） | 流通股本口径 |
| floatmv | DOUBLE | 流通市值（元） | |
| totalmv | DOUBLE | 总市值（元） | |

### 1.4 `raw_adjust_factor` —— 后复权因子（逐标的逐日稀疏存储）

| 字段 | 类型 | 说明 | 备注 |
|---|---|---|---|
| symbol | VARCHAR | 标的代码 | |
| **date** | **DATE** | **因子生效日期** | 除权除息日当天会有新因子；非除权日该 symbol 无行 |
| **hfq_factor** | **DOUBLE** | **后复权因子** | 字段名是 `hfq_factor`，不是 `factor` |

**重要**：这张表是**稀疏存储**——不是每个交易日都有行，只在除权除息日追加新因子。`v_stock_qfq` 视图用 `COALESCE(f.hfq_factor, 1)` 做左连接，意思是"没行就当因子=1"。

### 1.5 `raw_gbbq` —— 股本变迁 / 权息事件表（MVP 只取 category=1）

| 字段 | 类型 | 说明 | 备注 |
|---|---|---|---|
| **category** | **BIGINT** | **事件类型** | 1=除权除息（MVP唯一使用）；2=通达信内部复权因子链快照；5=股本/市值快照 |
| symbol | VARCHAR | 标的代码 | |
| **date** | **DATE** | **事件日期** | **category=1 时是除权除息日（ex_date）** |
| c1 | DOUBLE | c1 | **category=1 → 每10股派现金额**（元/10股，÷10=每股分红）；其他 category 为通达信内部大数值 |
| c2 | DOUBLE | c2 | **category=1 → 固定为 0**；其他 category 为通达信内部大数值 |
| c3 | DOUBLE | c3 | **category=1 → 每10股送转股数**（股/10股，÷10=每股送转比例）；其他 category 为通达信内部大数值 |
| c4 | DOUBLE | c4 | **category=1 → 固定为 0**；其他 category 为通达信内部大数值 |

**MVP 读取方式（唯一正确口径）**：
```sql
SELECT symbol, date AS ex_date, c1/10.0 AS cash_per_share, c3/10.0 AS transfer_ratio
FROM raw_gbbq WHERE category = 1;
```

---

#### 🔬 实测数据实例（2026-10-15 DuckDB 实查）

**数据源**：`SELECT * FROM raw_gbbq LIMIT 10;`（标的 sz000001，混合 category）

| category | symbol | date | c1 | c2 | c3 | c4 | 解读 |
|---|---|---|---|---|---|---|---|
| **1** | sz000001 | 1990-03-01 | 0.0 | 3.56 | 0.0 | 1.0 | 老历史数据（c2/c4 非零，MVP 不关心） |
| **5** | sz000001 | 1991-04-03 | 0.0 | 0.0 | 2650.0 | 4850.0 | category=5 股本快照，MVP 忽略 |
| **1** | sz000001 | 1991-05-02 | 3.0 | 0.0 | 4.0 | 0.0 | ✅ **10派3元送4股** |
| **2** | sz000001 | 1991-05-02 | 2650.0 | 4850.0 | 3949.07 | 8975.16 | category=2 复权因子链，c1/c2=上一条 category=2 的 c3/c4 |
| **1** | sz000001 | 1991-08-17 | 0.0 | 0.0 | 10.0 | 0.0 | ✅ **10转10股** |
| **1** | sz000001 | 1992-03-23 | 2.0 | 0.0 | 5.0 | 0.0 | ✅ **10派2元送5股** |
| **1** | sz000001 | 1993-05-24 | 3.0 | 16.0 | 8.5 | 1.0 | 老历史数据（c2/c4 非零） |
| **2** | sz000001 | 1993-05-24 | 3949.07 | 8975.16 | 18812.98 | 26941.79 | category=2 链式传递 |
| **2** | sz000001 | 1993-06-30 | 18812.98 | 26941.79 | 18004.33 | 26125.37 | c1/c2 继续=上一条 c3/c4 |
| **2** | sz000001 | 1994-07-09 | 18004.33 | 26125.37 | 19804.77 | 28737.91 | 链式传递终止于最新因子 |

**数据源**：`SELECT DISTINCT category, c1, c2, c3, c4 FROM raw_gbbq WHERE date >= '2020-01-01';`（全市场，2020年以来）

**category=1（除权除息）—— MVP 唯一读取，c2/c4 永远=0，零例外**：

| c1 | c2 | c3 | c4 | 解读 |
|---|---|---|---|---|
| **3.0** | **0** | **0** | **0** | ✅ 10派3元 |
| **1.3** | **0** | **0** | **0** | ✅ 10派1.3元 |
| **0** | **0** | **4.0** | **0** | ✅ 10转4股 |
| **2.3** | **0** | **0** | **0** | ✅ 10派2.3元 |
| **4.0** | **0** | **0** | **0** | ✅ 10派4元 |
| **2.0** | **0** | **5.0** | **0** | ✅ 10派2元送5股 |

**category=5（股本/市值快照）—— MVP 完全忽略**：c2 和 c4 经常相等（6800 / 10560 / 14961 / 40000），c1/c3 为递增大数值（1e3–1e4 量级），与除权除息无关。

**category=2（通达信内部复权因子链快照）—— MVP 完全忽略**：每次 category=1 触发后自动追加一条，`c1=上一条.c3, c2=上一条.c4, c3/c4=新累计因子`，数值在 1e4–1e5 量级。`v_stock_qfq` 视图已内嵌计算，MVP 不需要直接读。

---

#### 📌 关键验证点

- **近 6 年（2020–2026）category=1 的 c2 和 c4 全部精确=0**，没有任何例外——开发时 `WHERE category = 1 AND c2 = 0 AND c4 = 0` 做防御性过滤是安全的
- 1990s 初老数据有 c2/c4 非零（如 1990-03-01 c2=3.56, c4=1.0），属于通达信早期 gbbq 文件旧字段定义，MVP 只关心近 1–2 年行情校验，完全不影响
- **category=2 与 category=1 经常在同一日期成对出现**（如 1991-05-02、1993-05-24）—— 通达信内部设计：先写除权事件（category=1），再追加复权因子链节点（category=2）

### 1.6 `raw_holidays` —— 休市日黑名单（**只有休市日**）

| 字段 | 类型 | 说明 |
|---|---|---|
| **date** | **DATE** | **休市日日期** |

**关键**：这张表**只有一个 `date` 列**，没有 `is_trading_day` 列。有行 = 休市日，没行 = 交易日（或周末）。
⚠️ **2026-10-19 实测（I-20）**：真库 680 行中，落在 2020~2030 区间且有行情/有日线的 = **0 行** ⇒ 确为休市日黑名单。

### 1.7 `raw_symbol_class` —— 标的分类（**视图依赖的路由表**）

| 字段 | 类型 | 说明 | 备注 |
|---|---|---|---|
| symbol | VARCHAR | 标的代码 | |
| **class** | **VARCHAR** | **品种分类** | 实测值：`stock`（股票 6158）、`etf`（2839）、`unknown`（1357）、`block`（1128）、`index`（801）、`bstock`（166）。**无 `bond`** |

`v_stock_*` 视图通过 `INNER JOIN raw_symbol_class ON sc.class = 'stock'` 过滤股票；`v_etf_*` 同理过滤 ETF。

### 1.8 `raw_symbol_name` —— 标的名称 + 分类

| 字段 | 类型 | 说明 |
|---|---|---|
| symbol | VARCHAR | 标的代码 |
| name | VARCHAR | 证券名称（如 "平安银行"） |
| class | VARCHAR | 品种分类（同 raw_symbol_class） |

### 1.9 `raw_tdx_blocks_info` —— 板块信息（MVP 不使用）

| 字段 | 类型 | 说明 |
|---|---|---|
| block_type | VARCHAR | 板块类型（行业/概念/地区） |
| block_name | VARCHAR | 板块名称 |
| block_symbol | VARCHAR | 板块代码 |
| block_code | VARCHAR | 板块编码 |
| parent_code | VARCHAR | 父板块编码 |
| block_level | BIGINT | 板块层级 |

### 1.10 `raw_tdx_blocks_member` —— 板块成分股（MVP 不使用）

| 字段 | 类型 | 说明 |
|---|---|---|
| stock_symbol | VARCHAR | 成分股代码 |
| block_code | VARCHAR | 所属板块编码 |

### 1.11 `_meta` —— 元数据表（MVP 不使用）

| 字段 | 类型 | 说明 |
|---|---|---|
| key | VARCHAR | 元数据键（如 `version`、`last_update`） |
| value | VARCHAR | 元数据值 |

---

## 二、视图（v_ 前缀，共 6 张）

所有视图由 `tdx2db init` 自动创建，底层 JOIN 了 `raw_kline_daily` + `raw_symbol_class` + `raw_adjust_factor` + `raw_basic_daily`。

### 2.1 视图字段统一说明

6 张视图的列**完全相同**，只是复权口径和标的分类不同。

| 视图名 | 标的分类 | 复权口径 | close 精度 | qfq_factor 列 |
|---|---|---|---|---|
| `v_stock_qfq` | stock | 前复权 | ROUND(2) | ✅ |
| `v_stock_hfq` | stock | 后复权 | ROUND(2) | ❌ |
| `v_stock_bfq` | stock | 不复权（原始） | 原值 | ✅ |
| `v_etf_qfq` | etf | 前复权 | ROUND(3) | ✅ |
| `v_etf_hfq` | etf | 后复权 | ROUND(3) | ❌ |
| `v_etf_bfq` | etf | 不复权（原始） | 原值 | ✅ |

> 股票价格默认保留 2 位小数，ETF 保留 3 位——这是 tdx2db 内置的 `ROUND` 精度。

### 2.2 通用字段定义（6 张视图共享）

| 字段 | 类型 | 说明 | 计算逻辑 |
|---|---|---|---|
| symbol | VARCHAR | 标的代码 | 直接来自 raw_kline_daily.symbol |
| **date** | **DATE** | **交易日期** | **列名就是 `date`** |
| open | DOUBLE | 开盘价（按口径复权） | `v_stock_qfq`: `ROUND(raw.open × hfq_factor / latest_hfq, 2)`；`v_stock_hfq`: `ROUND(raw.open × hfq_factor, 2)`；`v_stock_bfq`: `raw.open` |
| high | DOUBLE | 最高价（按口径复权） | 同上 |
| low | DOUBLE | 最低价（按口径复权） | 同上 |
| close | DOUBLE | 收盘价（按口径复权） | 同上 |
| preclose | DOUBLE | 前收盘价（按口径复权） | 来自 `raw_basic_daily.preclose` 乘/不乘复权因子 |
| volume | BIGINT | 成交量（不复权，量不变） | 直接来自 raw_kline_daily |
| amount | DOUBLE | 成交额（不复权） | 直接来自 raw_kline_daily |
| turnover | DOUBLE | 换手率（%） | 来自 raw_basic_daily |
| floatmv | DOUBLE | 流通市值 | 来自 raw_basic_daily |
| totalmv | DOUBLE | 总市值 | 来自 raw_basic_daily |
| change_pct | DOUBLE | 涨跌幅（%） | 来自 raw_basic_daily |
| amplitude | DOUBLE | 振幅（%） | 来自 raw_basic_daily |
| hfq_factor | DOUBLE | 后复权因子（当日有效） | `COALESCE(raw_adjust_factor.hfq_factor, 1)` |
| **qfq_factor** | **DOUBLE** | **前复权因子**（仅 _qfq / _bfq 视图有） | **`COALESCE(hfq_factor, 1) / latest_hfq`**，其中 `latest_hfq = argmax(hfq_factor, date)` |

### 2.3 复权公式速查

```
后复权价 (hfq) = raw_price × hfq_factor
前复权价 (qfq) = raw_price × hfq_factor / latest_hfq
不复权价 (bfq) = raw_price                       // hfq_factor 和 qfq_factor 仍附带
```

`latest_hfq` 是该标的截至**全历史**最新的 `hfq_factor` 值，用 `argmax(hfq_factor, date)` 取到。

---

## 三、MVP 使用矩阵（哪些表/视图读、哪些完全不碰）

| 表/视图 | MVP 是否读 | 用途 |
|---|---|---|
| `v_stock_qfq` | ✅ 高频读 | 插件引擎行情查询、C1/C2/C6/C7/C9 校验 |
| `v_stock_hfq` | ⚠️ 低频 | 可能用于展示后复权价（当前 MVP 暂不展示 K 线图） |
| `v_stock_bfq` | ❌ | 不复权原始数据，跟 raw_kline_daily 等价 |
| `v_etf_qfq` | ⚠️ 可能 | 如果用户自选含 ETF |
| `v_etf_hfq` | ❌ | |
| `v_etf_bfq` | ❌ | |
| `raw_kline_daily` | ✅ 读 | C11 跨源校验取不复权原始 OHLC |
| `raw_basic_daily` | ✅ 读 | C11 JOIN 取 preclose |
| `raw_adjust_factor` | ✅ 读 | C9 校验 hfq_factor vs 视图 qfq_factor 计算 |
| `raw_gbbq` | ✅ 读 | C8/C10 除权校验，**只取 category=1** |
| `raw_holidays` | ✅ 读 | C1/C2 交易日判断 |
| `raw_symbol_class` | ✅ 可能 | 路由过滤 |
| `raw_symbol_name` | ✅ 可能 | 展示用 |
| `raw_kline_1min` | ❌ | MVP 禁止分钟级策略 |
| `raw_tdx_blocks_info` | ❌ | MVP 不做板块功能 |
| `raw_tdx_blocks_member` | ❌ | MVP 不做板块功能 |
| `_meta` | ❌ | tdx2db 内部版本信息 |

---

## 四、已知列名陷阱（开发时必须避免）

| ❌ 错误写法 | ✅ 正确写法 | 影响 |
|---|---|---|
| `WHERE trade_date = ?` | `WHERE date = ?` | C1-C12 全部校验 SQL 全挂 |
| `WHERE is_trading_day = 1` | `WHERE date NOT IN (SELECT date FROM raw_holidays) AND EXTRACT(ISODOW FROM date) BETWEEN 1 AND 5` | C2 交易日判断写反（raw_holidays = 休市日黑名单） |
| `JOIN raw_kline_daily ON ex_date` | `JOIN raw_kline_daily ON date` | C8/C10 JOIN 失败 |
| `SELECT pre_close FROM raw_kline_daily` | `JOIN raw_basic_daily ... SELECT preclose` | C11 preclose 为空 |
| `raw_adjust_factor.factor` | `raw_adjust_factor.hfq_factor` | C9 字段不存在 |
| `raw_gbbq.cash_dividend` | `raw_gbbq.c1 / 10.0` | C8 字段不存在 |
| `raw_gbbq.stock_transfer` | `raw_gbbq.c3 / 10.0` | C8 字段不存在 |
