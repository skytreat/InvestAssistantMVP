# ETF 坏名覆盖表：诊断与重新生成

行情层 `raw_symbol_name` 中部分 ETF 名称末字节被 tdx2db 截断，DuckDB 解出 U+FFFD（替换符）。
覆盖表 `apps/backend/src/data/etf-name-overrides.json` 按**标的代码**（含市场前缀，如 `sh510900`）映射到**官方名称**（权威源：天天基金 fund.eastmoney.com 基金代码全量列表）。

> 为什么不用坏名作键：坏名本身是损坏数据（含 U+FFFD），且同一坏名可能对应多个标的代码
> （实测 395 个坏名标的中 23 个坏名各有 2+ 代码），按坏名键会丢失映射。

```powershell
# 前置：DuckDB 行情库已加载（本地 data/quotes.duckdb 或 /opt/invol/quotes.duckdb），且后端进程未占用
# 用法：在本仓库根目录下执行

# 1) 诊断：列出行情库坏名标的与覆盖表缺口（只读）
npx tsx scripts/export-etf-bad-names.ts

# 2) 重新生成覆盖表（需网络访问 fund.eastmoney.com）
npx tsx scripts/complete-etf-bad-names.ts
```

## 输出

`complete-etf-bad-names.ts` 重写 `apps/backend/src/data/etf-name-overrides.json`：

```json
{
  "sh510900": "恒生中国企业ETF易方达",
  "sh510130": "上证中盘ETF易方达"
}
```

键 = 标的代码（`raw_symbol_name.symbol` 格式，与业务层 asset_code 一致）；值 = 官方名称。
脚本会对每条做一致性校验（坏名清洗后 vs 官方名），并把「TDX 名已过时 / 权威源缺失」的条目
打印出来供人工确认——**值一律取官方名**，复核结果不影响写入。
