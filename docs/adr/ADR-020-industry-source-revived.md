# ADR-020 —— 重新启用行业数据源（tdx_research L1 口径）

| 项 | 值 |
|---|---|
| **状态** | ✅ 已接受（2026-11-12，所有者裁决） |
| **落地** | PR「行业数据源启用 + 两页合并」 |
| **关联** | plan_v2 §13.2 **I-22**（「板块表 0 行」结论，2026-10-18 实测）、裁决 D-4、T85b④ |
| **取代** | I-22 时代的前端「行业控件写死禁用」与后端 `industry` 恒 `null` 的契约 |

---

## 1. 背景（实测数据）

I-22（2026-10-18）结论是 `raw_tdx_blocks_info` / `raw_tdx_blocks_member` **均为 0 行**，
据此前端把行业控件写死禁用、`GET /api/holding` 的 `industry` 字段写死 `null`（裁决 D-4）。

**2026-11-06 板块表回填后，该前提已失效**（`data/quotes.duckdb` 实测）：

| 表 | 行数 | 说明 |
|---|---|---|
| `raw_tdx_blocks_info` | 926 | `block_type` 取值 `tdx_research`(467) / `concept`(269) / `style`(158) / `region`(32) —— **没有字面 `industry`** |
| `raw_tdx_blocks_member` | 90,988 | `stock_symbol` + `block_code` |

口径沿用 `services/portfolioRisk.ts` 既有结论（2026-11-06 实测）：
行业 = **`block_type='tdx_research'` + `block_level=1`**（L1 覆盖 5,581/5,581；
不过滤层级因一/二/三级重复挂靠会放大 2.85 倍）。

## 2. 决策

1. **选股页**（`routes/stockscan.ts` + `StockScan.tsx`）：
   - 新增 `GET /api/stockscan/industries`：返回 L1 行业 `{code, name}` 列表（`loadIndustryOptions()`）；
   - `POST /api/stockscan` 的 `industry_code` 校验：必须是 L1 列表内的 `block_code`，否则 400
     `PARAM_INVALID`（概念/风格/地区板块码也被拦下，避免「看似成功但口径错误」）；
   - 前端动态加载选项、启用下拉并提交 `industry_code`；**列表为空时仍禁用 + 显式文案**
     （数据缺失降级不变，只是不再写死）。
2. **持仓/仪表盘**（`routes/trade.ts` + `Dashboard.tsx` + `PositionToolbar.tsx`）：
   - `GET /api/holding` 用 `loadIndustryNames()`（**1 次 IN 查询**，不查 DISTINCT block_type）
     填充 `industry`（L1 板块名；ETF/未收录 → null）；
   - 仪表盘行业下拉接线：选项由持仓 `industry` 去重得到，选中按 `position.industry` 过滤；
     全部为 null 时仍禁用 + 文案（不静默失效）。
3. 口径参数保持可用环境变量覆盖：`INDUSTRY_BLOCK_TYPES` / `INDUSTRY_BLOCK_LEVEL`
   （与 `portfolioRisk` 一致）。

## 3. 代价

- `/api/holding` 的 DuckDB 常量查询 3 → 4 次（`holding-nplus1.test.ts` 上限同步 +1，
  查询仍是 O(1) 常数，与持仓数无关）；
- 选股传 `industry_code` 时多 1 次选项查询（仅过滤时发生，926 行小表）。

## 4. 验证

- 真实库：`sh600519` 挂 L1「食品饮料」/L2「酿酒」/L3「白酒」⇒ `/api/holding` 返回「食品饮料」
  （`watchPromote.test.ts` 钉住，层级过滤错误会被该断言抓住）；
- `loadIndustryOptions` / `loadIndustryNames` 单测（`portfolioRiskIndustry.test.ts`，mock 查询）；
- `GET /api/stockscan/industries` + 非法 `industry_code` 400（`t55-stockscan-filter.test.ts`，数值库守卫）;
- 前端 `stockscan-page.test.tsx`（选项可用/不可用两态）与 `dashboard-cards.test.tsx`
  （行业过滤选项 + 过滤生效 + 排序无关断言）。

## 5. 残余

- I-22 的「标的名称仅覆盖 70% / `raw_symbol_class` 缺 3723 条」部分**未处理**（与本 ADR 无关）；
- C5「板块表为空 → SKIP」的判定保持不变（按当前数据自适应，空库时仍 SKIP）。
