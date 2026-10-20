# Wave 4 验收 —— TradeInput + Review（G4）

> 判定人：主 agent（Wave 4 实施者）
> 日期：2026-10-20
> 波次范围：**T68（TradeInput 全量重写）+ T69（Review 补全与 bug 修复）** + **T87b（唯一键 P0 修复）**
> 上游：[`wave-3-audit.md`](./wave-3-audit.md)（G3 判定 PASS 5/6 + G3.5b 前移）
> 起始 commit：`d0b86d0`（Wave 3 收尾）
> 结束 commit：`55d4dc3`
> commit 区间：`d0b86d0..55d4dc3` —— **4 个 commit**

---

## 0. 判定结论

| 门槛 | 判定 | 实测依据 |
|---|---|---|
| **G4.1** PRD §5.4 + §5.5 对应行零 gap | ✅ **PASS** | §2 逐行勾对 |
| **G4.2** F-T1~F-T6 + F-R1/F-R2 + Review page bug 关闭 | ✅ **PASS** | §3 逐项核对（9/9）|
| **G4.3** 复盘三态弹窗正确分流 | ✅ **PASS** | §4：**「未标记 / 是 / 否」**（plan 原文的 PASS/WARN/ERROR 是笔误，见 §4）|
| **G4.4** 筛选 debounce 即时生效 | ✅ **PASS** | §5：**300ms debounce + 删除「筛选」按钮**，真浏览器复核请求合并 |
| **G4.5** `trade_time` 提交前预检生效 | ✅ **PASS** | §6：新端点 + 前端禁用提交 + 提示 |
| **G4.6** 375px review 页无横向溢出 | ✅ **PASS** | §7：**真浏览器实测 review@375 = 0px** |

**G4 = 6/6 PASS → Wave 4 可合入 `main`。**

---

## 1. 实测原始数据

### G4.6 —— 横向溢出探针（真浏览器 Chromium）

```bash
node scripts/probe-overflow.mjs --api-base-url http://127.0.0.1:8081 --username admin --password admin123
→ ✅ PASS G4.6（Wave 4）—— 375px review 无横向溢出
→ ❌ FAIL G6.6 / G7.7（分别属 Wave 6 / 7）
```

**全矩阵**（数据 = DuckDB + `business.db` 副本）：

| 页面 | 375 | 768 | 1440 | 归属 |
|---|---|---|---|---|
| login / dashboard / trade / signals / kline / **review** / settings / notfound | **0** | 0 | 0 | — |
| stockscan | +100 ❌ | 0 | 0 | G6.6（Wave 6）|
| admin | +435 ❌ | +42 ❌ | 0 | G7.7（Wave 7）|

**review 修复前后**：

| review | 修复前 | **修复后** |
|---|---|---|
| @375 | 616 / 375 → **+241 ❌** | **375 / 375 → 0 ✅** |
| @768 | 0 | 0 ✅ |
| @1440 | 0 | 0 ✅ |

内部机制：@375 时滚动容器 `clientWidth=253 / scrollWidth=620`，表格 620px →
**表格在自己内部横向滚动，文档不被撑宽**。

### G4.4 —— a11y 门禁（真浏览器）

```bash
node scripts/a11y-check.mjs --api-base-url http://127.0.0.1:8081 --username admin --password admin123
→ ✅ 全部 10 个页面 0 条 critical 违规
→ exit 0
```

非 critical：`color-contrast`（serious，已登记 T76）+ `page-has-heading-one`（moderate，kline/stockscan，已登记 T76 ⑦）。

### 全量测试

| 范围 | 结果 |
|---|---|
| **前端** | **431 passed + 1 todo**（23 文件；Wave 3 基线 361 → +70）|
| 前端覆盖率 | **86.24% stmt / 82.75% branch**（Wave 3 基线 82.62% → +3.6pp）|
| **后端** | **655 passed**（50 文件；Wave 3 基线 624 → +31）|
| `npm run lint` / `npm run typecheck` | exit 0 |

---

## 2. G4.1 —— PRD §5.4 + §5.5 逐行勾对

### PRD §5.4「交易录入弹窗」

| 要求 | 实现 | 状态 |
|---|---|---|
| 交易类型选择：顶部 Tab 切换 买入/加仓/减仓/清仓/除权补充 | `TradeTypeTabs.tsx`（5 主 Tab + 3 除权子类型）| ✅ |
| 操作理由 必填（UI 不允许空值）；除权补充时系统固化置灰 | 空值 → 按钮 disabled + 提交二次拦截 + **字段级红框 + 提示紧贴字段下方**；除权 → 自动填 + `readOnly` + 置灰 | ✅ |
| 实时预估：输入数量+价格+手续费 → 实时显示预估新均价；减仓超持仓 → 红色禁用提交 | `TradeEstimatePanel.tsx`（`useMemo` 监听 qty/price/fee）；超持仓 → 红字 + 禁用 | ✅ |
| 标签快捷填充：预设标签按钮（策略触发/止损/抄底）一键填入理由 | `TradeReasonTags.tsx`，**按交易类型出现/消失** | ✅ |
| 除权补充表单：除权日、分红金额/送转比例等数值字段可编辑；操作理由自动固化 | 数值字段可编辑；理由自动固化 | ✅ |
| 系统 vs 人工标签：自动导入的交易以**绿色「系统导入」**标签展示；手动补充以**灰色「人工补充」**展示 | T69 的 4 色 pill 覆盖（系统导入绿 / 主观决策橙 / 未复盘灰）| ✅ |

### PRD §5.5「复盘页交互」

| 要求 | 实现 | 状态 |
|---|---|---|
| 日期范围筛选 | `input[type=date]` × 2 → `start_date`/`end_date`（后端本就支持）| ✅ |
| 三态字段默认**未标记（null）**，显示灰色「未标记」；点击切换「是」（**绿色**）/「否」（**红色**）| `TriStateGroup.tsx` —— **是=绿 / 否=红 / 未标记=灰** | ✅ |
| 标签用 pill/badge（非彩色文字）| `ReviewTag.tsx` 4 色 pill + 图例 | ✅ |
| 复盘统计（胜率/盈亏比等）| 已有 | ✅ |
| 收益曲线 | `YieldCurve` + **悬浮 tooltip** | ✅ |

---

## 3. G4.2 —— F-T1~F-T6 + F-R1/F-R2 + Review bug 逐项核对

| Gap | 现状 | 关闭方式 |
|---|---|---|
| **F-T1** | 交易类型是 `<select>` 下拉 | ✅ `TradeTypeTabs.tsx`（`<select>` 已删除）|
| **F-T2** | `trade_reason` 无 `required`、无前端阻止 | ✅ 空值阻止提交 + 字段级红框 + 提示紧贴字段下方 |
| **F-T3** | 无实时预估新均价 | ✅ `TradeEstimatePanel` + **适配层 + golden 逐位相等** |
| **F-T4** | 减仓超持仓无红色禁用 | ✅ `GET /api/holding/:asset_code` → 红字 + 禁用 |
| **F-T5** | 无「除权补充」独立入口，理由未固化 | ✅ 次级入口 + 自动填 + `readOnly` |
| **F-T6** | 无预设标签按钮 | ✅ `TradeReasonTags.tsx` |
| **F-R1** | 无日期范围筛选 | ✅ 两个 date input |
| **F-R2** | 标签是彩色文字非 pill | ✅ 4 色 pill + 图例 |
| **Review page bug** | **`setPage` 缺失** → 页码永远第 1 页 | ✅ `useState(1)` 解构 setter + `fetchTrades(p)` 发起时同步 `setPage(p)` |

---

## 4. G4.3 —— 「PASS/WARN/ERROR」是 plan 的**笔误**

G4.3 原文写「复盘**三态弹窗**（PASS/WARN/ERROR）正确分流」。
⚠️ **实测**：ux_v2 §3.3-4 与 PRD §5.5 定义的复盘三态字段是
**未标记（null）/ 是 / 否**（`strategy_match` 与 `is_stop_loss`），**不是** PASS/WARN/ERROR。
⇒ 按域裁决（交互/界面行为归 PRD）**按 PRD §5.5 实现**：

| 态 | 底色 | 文字 | 边框 |
|---|---|---|---|
| 是 (`1`) | `bgPillSuccess` `#dcfce7` | `textPillSuccess` `#166534` | `borderPillSuccess` `#86efac` |
| 否 (`0`) | `bgPillDanger` `#fee2e2` | `textPillDanger` `#991b1b` | `borderPillDanger` `#fca5a5` |
| 未标记 | `bgPillNeutral` `#f3f4f6` | `textPillNeutral` `#4b5563` | `borderPillNeutral` `#d1d5db` |

⚠️ **现状原本不符合 PRD**：策略三态选中底色是**浅蓝 `#dbeafe`**、止损三态是**浅红 `#fee2e2`**，
且**没有区分「是/否」**（两者同底色，只靠标签区分）⇒ 本次按 PRD 改为 **是=绿 / 否=红 / 未标记=灰**。

**4 色 pill 映射**（优先级高→低，每行 1 个 pill）：
`is_stop_loss===1` → **止损红** › `system_followed===1` → **系统信号绿** ›
`is_auto_import===1` → **系统导入绿** › 已复盘 → **主观决策橙** › 其余 → **未复盘灰**。

**图例**：`role="group"` + `aria-label="标签颜色图例"`
（⚠️ **必须带 role** —— 裸 div 的 implicit role 是 generic，`aria-label` 在其上被 axe 判违规）。

---

## 5. G4.4 —— 筛选 debounce 即时生效

`filterKey = JSON.stringify([6 个筛选值])` 作依赖；`lastQueriedFilterKey = useRef(filterKey)` 初始化为
**挂载时的空筛选** ⇒ 挂载不重复触发；变化时 `setTimeout(300ms)` → `fetchTrades(1)`；
effect cleanup `clearTimeout` ⇒ 连续改多个控件**只发一次**。

**「筛选」按钮已删除**（原本 `Review.tsx:356` 是手动触发）。

**实测**（真浏览器 + 后端日志）：
- 改 1 个下拉 → **1 次**请求
- 50ms 内再改 2 个 → **合并成 1 次**（`?page=1&limit=20&trade_type=buy&system_followed=1&is_stop_loss=1`）

**用例**：断言「筛选」按钮**不存在**；改下拉后 `waitFor` 等**新出现的**请求并断言 `params.trade_type==='buy'`
（**没有点任何按钮**）；连改 2 个下拉 → 等 600ms 断言请求数只 +1。

---

## 6. G4.5 —— `trade_time` 提交前预检

**新端点** `GET /api/trade/check-duplicate?asset_code=&trade_type=&trade_date=&trade_time=`
→ `{ taken:false }` / `{ taken:true, taken_at }`；参数非法一律 **400 PARAM_INVALID**（**绝不**返回 `taken:false`）。

**前端**：300ms debounce → 命中则**成交时间红框 + 「该成交时刻已被占用（同日同标的同类型），请修改成交时间」+ 提交按钮 disabled**。
⚠️ **4xx/5xx 一律「无法确定」→ 不阻断提交**（乐观 UI，最终以 `POST` 结果为准）。

**性能断言**：`EXPLAIN QUERY PLAN` 含 `USING INDEX` + **不含 `SCAN`**
（实测 `SEARCH user_trade_record USING INDEX sqlite_autoindex_user_trade_record_1 (…)`）。

---

## 7. 本波挖出并修复的真实缺陷（**3 个 P0**）

### 7.1 🔴 P0：软删除记录**永久占用**交易唯一键 → 用户可见的幽灵占用
表级 `UNIQUE(...)` **不含 `is_deleted`** ⇒ 软删后同键再也录不进去（409），
而 `GET /api/trade` **过滤了 `is_deleted=0`** ⇒ **用户看不到那条记录，却提交失败**。

**修法**：表级 UNIQUE（**无法部分化**）→ **部分唯一索引** `WHERE is_deleted = 0`。
⇒ 「软删不再占用」与「未软删仍唯一」**同时成立**（实测双向验证）。

### 7.2 🔴 P0：旧幂等重建的「已是最终 schema」判定**恒为假** ⇒ **每次启动都重建表**
表级 UNIQUE 生成 `sqlite_autoindex_*`，其 `sqlite_master.sql` 为 **NULL**
⇒ 旧查询 `sql LIKE '%UNIQUE%'` **永不命中**。
**修法**：判定改用「表定义文本 + `PRAGMA index_list` 结构复核」，三态
`ready`（零动作）/ `missing-index`（只补索引）/ `legacy`（重建）。
实测：连续两次启动 → 第一次重建 1 次、第二次 **0 次**。

### 7.3 🔴 P0：重建用 `INSERT OR IGNORE` + `trade_time` 回填偏移算错 ⇒ 静默丢行 + **成交时刻被清空**
`substr(created_at, 14, 2)` 取到 `':4'` ⇒ 恒回退 `'00:00:00'`
⇒ **每次重启把所有 `trade_time` 清成 `00:00:00`**；`OR IGNORE` ⇒ 撞键行**静默丢弃** = 数据丢失。

**修法**：普通 INSERT + **显式列映射**（不用 `SELECT *` —— 列序随 `ALTER ADD COLUMN` 漂移）；
`trade_time` **有则原样保留**；冲突在事务内立刻炸 → **整体 ROLLBACK，旧表原样保留**。
⇒ 宁可**整笔迁移失败并回滚**，也**不静默丢行**。

### 7.4 🔴 交易类型白名单与 DDL CHECK 不一致（Wave 3 已修，此处登记）
见 `wave-3-audit.md` §7.1。

### 7.5 ⚠️ `Review.tsx` 分页页码不推进（**Wave 1 登记、Wave 4 才修**）
`setPage` 从未被调用 ⇒ 页码永远第 1 页、保存后回查第 1 页。

### 7.6 ⚠️ 交易类型中文名**散落 4 处且互相矛盾**（本波修）
转托管 / 转增 / 转增 / 转股 ⇒ 同一笔交易在不同页面显示成三种名字。
**修法**：新建 `src/components/tradeTypes.ts` 作**单一真相源**（依据 Requirements §5.1 的 7 种类型）。

### 7.7 🟠 `POST /api/trade` 不校验 `trade_date` 格式（DDL 无 CHECK）
`2026-13-45` 能落库；预检严、POST 松 ⇒ 口径差。**未改**（会变更既有接口契约）。

---

## 8. 实施口径裁决（owner 需过目）

> 本波 **15 条**裁决。以下为需过目的部分。

| # | 事项 | 裁决 | 依据 |
|---|---|---|---|
| 8.1 | **G4.3 的「PASS/WARN/ERROR」** | 按 PRD §5.5 的「未标记/是/否」实现 | 交互/界面行为归 PRD（AGENTS.md 域裁决表）|
| 8.2 | **「是/否」必须用不同颜色** | 是=绿 / 否=红 / 未标记=灰 | PRD §5.5 逐字；**改了既有 `review.test.tsx` 的 4 个颜色字面量**（用例数 17、结构、断言强度**一律不动**）—— 旧断言与 PRD 直接矛盾，不可能同时成立 |
| 8.3 | **`transfer` 的中文名** | **转增** | Requirements §5.1 的 7 种类型（买入/加仓/减仓/清仓/分红/送股/**转增**）；§5.1 **没有「卖出」** |
| 8.4 | **T68 的持仓校验端点** | `GET /api/holding/:asset_code`（**不是**计划卡写的 `/api/positions/:asset_code`）| 实测后端只注册了 `/api/holding` 与 `/api/holding/:asset_code`；SDD §4.4 也是前者。**计划卡待更正** |
| 8.5 | **「5+2 Tab」实为 5+3** | 5 主 Tab + 3 除权子类型 | 按字面「5+2」只给 2 个子类型会**丢掉一种除权类型、违反 §5.1** |
| 8.6 | **预估新均价不另写公式** | 「当前持仓」合成一笔前序买入，交给**同一个** `calculateMovingWeightedCost` | 公式只有一份 ⇒ 无口径漂移 |
| 8.7 | **送转/分红不参与移动加权** | 预估面板**不显示**新均价/新数量 | 跟随后端口径（`mapToCoreTrade` 不把 bonus/transfer 计入数量）—— 宁可少显示，也不显示与成交后持仓对不上的数字 |
| 8.8 | **理由固化格式** | 「人工补充 - {除权日} {类型}」 | Requirements §5.2 逐字 |
| 8.9 | **清仓自动填数量** | 切到清仓且用户未手改数量时填入当前持仓 | ux_v2 建议（非 PRD 硬要求），手改后不再覆盖 |
| 8.10 | **预检失败不阻断提交** | 4xx/5xx → 仍可提交 | 乐观 UI，最终以 `POST` 结果为准 |
| 8.11 | **预检参数非法 ≠ 未占用** | 一律 400 | 否则前端会把「查失败」误当「没占用」而放行 |
| 8.12 | **软删是否占用唯一键** | 依 **DDL 实测**（不占用）→ 预检加回 `is_deleted = 0` | 修 DDL 后必须同步预检，否则「预检说占用、提交却成功」 |
| 8.13 | **迁移宁可失败也不丢行** | 普通 INSERT + 显式列映射 | 旧 `OR IGNORE` 的静默丢行不可接受 |
| 8.14 | **部分唯一索引不放进 `DDL_SQL`** | 由幂等步骤统一负责 | 实测放进 `DDL_SQL` 会让「存量库缺 `trade_time`」报 `no such column` **卡死启动** |
| 8.15 | **除权补充的「三态」** | 用共享 `tradeTypes.ts` | 与 Review/TodayActivity/PositionDetail 同源 |

---

## 9. 本波未解决 / 移交后续 Wave

| # | 问题 | 归属 |
|---|---|---|
| 9.1 | **stockscan@375 溢出 +100px**（`formRowStyle` 无 `flexWrap`）| **G6.6（Wave 6 / T73）** |
| 9.2 | **admin@375 +435px / @768 +42px** | **G7.7（Wave 7 / T75）** |
| 9.3 | `color-contrast` serious · `page-has-heading-one` moderate（kline/stockscan）| **T76（Wave 7）** |
| 9.4 | 🟠 **业务口径待裁决**：部分索引下**软删的分红/送股记录会被次日 cron 重新导入**（`exDividendSync` 靠 `INSERT OR IGNORE` + `trade_time='00:00:00'` 防重，软删记录不再挡重复）| **需所有者裁决** |
| 9.5 | 🟠 **「止损」列语义色冲突**：PRD 统一「是=绿」，但止损业务上偏负面，而 4 色 pill 里止损是红 ⇒ 同一行同时出现「绿=是」与「红=止损」| **需 owner 裁决** |
| 9.6 | 🟠 `docs/audit/overflow-probe.md` §7-1 说「卡片化是唯一修复手段」与本波做法（`ScrollableTable`）冲突 → 该结论需订正 | **需 owner 裁决** |
| 9.7 | `POST /api/trade` 不校验 `trade_date` 格式（预检严、POST 松）| 独立任务 |
| 9.8 | `GET /api/trade` 的分页参数名与 SDD §4.4 不符（实现 `page`/`limit`，SDD `page_size`）| 既有契约漂移 |
| 9.9 | `created_at` 无时区信息（`datetime('now','localtime')`），全仓同问题 | 长期 |
| 9.10 | `TradeInput.tsx` 与 `TradeFormModal.tsx` 是**两套表单**，口径重复；PRD §5.4 标题是「弹窗」但页面仍是整页 | ux_v2 建议 B 的 Modal 化未做 |
| 9.11 | 后端 `mapToCoreTrade` 不把 `bonus/transfer` 计入持仓数量，与 Requirements §5.3 冲突 | **需业务裁决（L1）** |
| 9.12 | `watchPromote.test.ts` 偶发 15s 超时 · `smoke-m3` 偶发 120s 超时 | 既有 flaky |

---

## 10. CI 实跑记录

**PR**：#22 `feat(Wave 4): TradeInput + Review 重写 —— T68/T69 + 3 个 P0 修复（G4 6/6 PASS）`

| Run | run id | Stage 2 | build-and-test | 结论 |
|---|---|---|---|---|
| #1 | `39458672254` | pass | pass | ✅ success |
| #2 | 见 commit | | | |

---

## 11. 验证汇总

| 检查 | 结果 |
|---|---|
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |
| **前端全量** | **431 passed + 1 todo**（23 文件）|
| **前端覆盖率** | **86.24% stmt / 82.75% branch** |
| **后端全量** | **655 passed**（50 文件）|
| **G4.4 axe（真浏览器）** | **10 页 0 critical，exit 0** |
| **G4.6 溢出（真浏览器）** | **review@375 = 0px，PASS** |
| CI 模拟（无行情库）| unit 502 passed / 26 skipped |
| CI shuffle guard（seed 1/2）| 两次结果完全一致 |
| 收尾 | 端口 8081/5173/51230/51231 全无 LISTEN；无残留 node 进程；playwright `(no browsers)`；DuckDB/SQLite 副本已删 |
