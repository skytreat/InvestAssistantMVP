# 导出 ETF 坏名（含 U+FFFD 替换符）到覆盖表

```powershell
# 前置：DuckDB 行情库已加载（/opt/invol/quotes.duckdb 或本地 data/quotes.duckdb）
# 用法：在本仓库根目录下执行

npx tsx scripts/export-etf-bad-names.ts
```

## 输出

生成 `apps/backend/src/data/etf-name-overrides.json`，键为**原始坏名**（含 `\uFFFD`），值为**人工补全后的正确名**。

## 流程

1. 从 `raw_symbol_name` 查出 `class='etf'` 且 `name LIKE '%<U+FFFD>%'` 的全部行；
2. 对每行输出 `symbol / raw_name`，供人工或脚本补全正确名；
3. 汇总为 JSON 对象写回 `etf-name-overrides.json`。

## 示例

```json
{
  "中韩半导体ETF华\uFFFD": "中韩半导体ETF",
  "科创半导体ETF华\uFFFD": "科创半导体ETF"
}
```
