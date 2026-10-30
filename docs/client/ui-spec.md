# UI 设计规格（L2.5 层）

> 本文档是从已归档的 `docs/archive/frontend_ux_v2_SUPERSEDED-2026-10-16.md` 与
> `frontend-gap-audit_SUPERSEDED-2026-10-16.md` 中**保全下来的、仍然有效的 UI 规格**。
> 原文档归档是因为其**任务拆解与结论已被超越**，但其中的具体数值与规格仍然有效，
> 因此在此独立成文。

**引用方**：实施计划 §12.3b（UX 验收 U1-U3）、任务 T62 / T63 / T65 / T67 / T68 / T76 / T79。

> ⚠️ **本文档只定义「长什么样」，不定义「什么时候做」** —— 排期与任务拆解见 `code_implementation_plan_v2.md`。
> `code_implementation_plan_v2.md`。

---

## UI 规格清单

> 归档 ≠ 丢弃。`frontend_ux_v2` / `frontend-gap-audit` 两份文档中，下列内容在 `559d671` 之后**依然成立**（结论未被推翻、也未被本 plan 的 §3 覆盖），但它们**只存在于 `docs/archive/`**。若将来有人清理 archive，这些依据会丢失。
> 因此在此**内联保全**，使本 plan 自包含 —— **执行 T61-T79 时不需要打开 archive**。

### 1. Design Token 具体数值（ux_v2 §2.4，建议直接落地）

ux_v2 已完成全站颜色统计并给出建议 token 值，这是**唯一一份具体数值来源**，本 plan 的 T62 只写了「按建议值落地」而未内联数值。保全如下：

> ⚠️ **本节是 token 数值的唯一权威**（`apps/frontend/src/theme/tokens.ts` 的文件头也这么写）。
> **改任何 token 数值前先改本节**，再改代码 —— 顺序反了就会「代码与 spec 脱节」，
> 届时「token 数值来自 spec」这条约定就只剩注释、没人核对了。
>
> 🔴 **Wave 7 卡 5（T76 ⑥）已改过一轮数值**（对比度收口）—— 本节已同步，
> **历史值（`textMuted #9ca3af` / `textFaint #888888` / `info #3b82f6` 当正文色 / `success #16a34a` 当正文色）作废**。

#### 1.1 「正文色档」与「徽章/图形档」的两档规则（Wave 7 卡 5 · 裁决 D-8）

**同一语义色（绿 / 蓝 / 琥珀）必须拆成两档**，各司其职：

| 档位 | 用途 | 取值 | 白底对比度 |
|---|---|---|---|
| **徽章/图形档**（饱和色） | **描边 / 色点 / 纯图形**；**深色画布**（K 线画布 `#1a1a2e`）上的标记 | `success #16a34a` / `info #3b82f6` / `warning #d97706` | 3.30 / 3.68 / 3.19 ❌ **不得承载白字** |
| **正文色档**（加深色） | **白底（`cardBg #ffffff`）/ 浅灰底（`pageBg #f8fafc`）上的文字** | `textSuccess #15803d` / `textInfo #1d4ed8` / `textWarning #92400e` | 5.02 / 6.70 / 7.09 ✅（页面灰底 4.79 / 6.41 / 6.78 ✅）|

🔴 **为什么必须分档**：

1. 饱和色档在白底上**达不到 WCAG 1.4.3 的 4.5:1** ⇒ 当正文色用就是真缺陷
   （Wave 7 前 `info` / `success` / `textMuted` / `textFaint` 四个 token 全部不合格，
   是 `docs/audit/a11y-baseline.md` §4.1 记录的 serious 级 color-contrast）；
2. 但 `success` 在**深色画布**（K 线图）上要的就是「亮绿」（5.18:1）⇒ **一刀切加深会把画布上的信号标记压到 3.40:1**。

⇒ **两档并存**：浅底上的文字走「正文色档」；徽章走「浅底 + 深字」（`bgPill*` + `textPill*`）
或「深底 + 白字」（底色取正文色档）；纯图形与深色画布走「饱和色档」。

⚠️ **色相家族不变**：绿仍是绿 —— `success` 仍是「盈利绿 / 系统导入绿」，
「红涨绿跌」由 `candleUp` / `candleDown` 单独承担，**不因对比度收口而改动**。

#### 1.2 数值表

```ts
// apps/frontend/src/theme/tokens.ts —— 数值来源：本节（ux_v2 §2.4 原始建议 + Wave 7 卡 5 对比度收口）
export const COLORS = {
  // Primary / Brand
  brand: '#2563eb', brandLink: '#1e40af', brandBg: '#eff6ff',
  // ── Semantic · 徽章/图形档（饱和色；不得承载白字）──
  success: '#16a34a',   // 盈利绿 / 系统导入绿（图形档；深色画布上的对比度 5.18:1）
  danger:  '#dc2626',   // 亏损红 / 删除 / ERROR（4.83:1，白底正文也合格）
  warning: '#d97706',   // WARN（图形档）
  info:    '#3b82f6',   // 系统信号蓝（图形档）
  neutral: '#6b7280',
  // ── Semantic · 正文色档（浅底上的文字；白底 + 页面灰底均 ≥ 4.5:1）──
  textSuccess: '#15803d',  // 白底 5.02:1 / 页面灰底 4.79:1
  textInfo:    '#1d4ed8',  // 白底 6.70:1 / 页面灰底 6.41:1
  textWarning: '#92400e',  // 白底 7.09:1 / 页面灰底 6.78:1
  // Text hierarchy
  textPrimary: '#1f2937', textSecondary: '#4b5563',
  textMuted: '#6b7280',    // 白底 4.83:1 / 页面灰底 4.62:1（原 #9ca3af 仅 2.54:1，作废）
  textFaint: '#737373',    // 白底 4.74:1 / 页面灰底 4.53:1（原 #888888 仅 3.54:1，作废）
  // Backgrounds
  pageBg: '#f8fafc', cardBg: '#ffffff', headerBg: '#f9fafb',
  // Borders
  borderLight: '#e5e7eb', borderMedium: '#d1d5db', borderFocus: '#2563eb',
  // ── 四色徽标色板（浅底 + 深字，保证 ≥ 4.5:1；Wave 4 T69 引入）──
  bgPillSuccess: '#dcfce7', textPillSuccess: '#166534', borderPillSuccess: '#86efac',
  bgPillWarning: '#ffedd5', textPillWarning: '#9a3412', borderPillWarning: '#fdba74',
  bgPillDanger:  '#fee2e2', textPillDanger:  '#991b1b', borderPillDanger:  '#fca5a5',
  bgPillNeutral: '#f3f4f6', textPillNeutral: '#4b5563', borderPillNeutral: '#d1d5db',
  // Chart palette（Kline.tsx 专用）
  chartBg: '#1a1a2e', chartGrid: '#2d2d44', chartText: '#888888',
  candleUp:   '#ef4444',   // A 股红涨
  candleDown: '#22c55e',   // A 股绿跌
  ma5: '#fbbf24', ma10: '#60a5fa', ma20: '#c084fc',
  macdBarPos: '#ef4444', macdBarNeg: '#22c55e',
  rsiLine: '#a78bfa', difLine: '#60a5fa', deaLine: '#f59e0b',
} as const;

export const SPACING = {
  pagePadding: '24px', cardPadding: '16px', cardMarginBottom: '24px',
  formRowGap: '12px', formRowMarginBottom: '12px', labelMinWidth: '80px',
  btnPadding: '6px 16px', inputPadding: '6px 10px', navPadding: '12px 16px',
  gapTight: '4px', gapBase: '8px', gapRelaxed: '16px', gapLoose: '24px',
} as const;

export const RADIUS = { sm: '4px', base: '6px', md: '8px' } as const;

export const TYPO = {
  fontFamily: '"Noto Sans SC", "PingFang SC", system-ui, -apple-system, sans-serif',
  monoFamily: '"JetBrains Mono", "SF Mono", Consolas, monospace',
  h1Size: '24px', h1Weight: '700',
  h2Size: '18px', h2Weight: '600',
  cardTitleSize: '16px', cardTitleWeight: '600',
  bodySize: '14px', smallSize: '13px', captionSize: '11px',
} as const;

export const MAX_WIDTH = 1200;
```

**⚠️ 一处需修正的数值**：ux_v2 建议 `TYPO.h1Size: '22px'`，但现网 `titleStyle` 是 `24px`（`_shared.tsx`）。落地时**沿用 24px**（避免全站标题视觉突变），其余按上表。

**⚠️ 本表是「建议落地值」，不是 `tokens.ts` 的逐行副本** —— `tokens.ts` 还有若干
「现网已在用、但 §1 建议表未覆盖」的补充键（`accentPurple` / `textTertiary` /
`borderSubtle` / `chartLabel` / `maskOverlay` / `shadowSoft` 等），
它们**以 `tokens.ts` 为准**，本节不逐条复述（AGENTS.md 分层自检第 2 条：只引用，不复述）。

**⚠️ 4 个键已从本表移除**（T66：`textOnDark` / `tableStripe` / `tableHover` / `RADIUS.lg`）
—— 它们在本表里只是「建议值」，**全仓 0 引用**，T66 已作为死导出删除。
⇒ 本表 = 「**在用的** token 数值」，不是历史建议值的全集。

### 2. 按钮变体（ux_v2 §2.3 问题 2-3/2-5）

```
dangerButtonStyle   = { background: '#dc2626', color: '#fff' }
ghostButtonStyle    = { background: 'transparent', color: '#2563eb', border: '1px solid #2563eb' }
secondaryButtonStyle= { background: '#e5e7eb', color: '#374151' }
buttonDisabledStyle = { background: '#9ca3af', color: '#fff', cursor: 'not-allowed' }
focusRingStyle      = { outline: '2px solid #2563eb', outlineOffset: '2px' }
```
T62 已列前四项；`focusRingStyle` 归 T63。

### 3. 全站内联颜色清单（ux_v2 §2.2，T62 的验收基准）

这 14 个颜色当前在各页重复内联，T62 要求收敛为 token：

| 颜色 | 出现次数 | 出现位置 | 映射到 |
|---|---|---|---|
| `#2563eb` | ~14 | `_shared:212`, Dashboard, Review, Kline, Settings | `COLORS.brand` |
| `#16a34a` | ~20 | 盈利绿 | `COLORS.success` |
| `#dc2626` | ~20 | 亏损红 | `COLORS.danger` |
| `#6b7280` | ~25 | 次级文字 | `COLORS.neutral` |
| `#e5e7eb` | 多处 | Card 边框 / 表格分隔线 | `COLORS.borderLight` |
| `#d1d5db` | 多处 | 输入框边框 | `COLORS.borderMedium` |
| `#f9fafb` | 表头 bg | — | `COLORS.headerBg` |
| `#374151` | 表头文字 | — | `COLORS.textSecondary` |
| `#1f2937` | cardTitle 文字 | — | `COLORS.textPrimary` |
| `#1e40af` | 链接蓝 | — | `COLORS.brandLink` |
| `#9ca3af` | 禁用灰 | Kline 加载按钮 | `COLORS.textMuted` |
| `#eff3f6f`→实际 `#eff6ff` | hover 蓝 | TradeInput autocomplete、Review 选中 | `COLORS.brandBg` |
| `#fee2e2` + `#fca5a5` | 选中红 | Review 止损三态选中 | 新增 `BG_SELECTED_DANGER` |
| `#dbeafe` + `#93c5fd` | 选中蓝 | Review 策略三态选中 | 新增 `BG_SELECTED_PRIMARY` |
| `#1a1a2e` | K线 canvas bg | — | `COLORS.chartBg` |
| `#ef4444` / `#22c55e` | K线阳线/阴线 | **A 股红涨绿跌**，勿改反 | `COLORS.candleUp/candleDown` |

> ⚠️ **`#fee2e2`/`#dbeafe` 两组在建议 token 表中原本缺失**，需 T62 补 `BG_SELECTED_DANGER` / `BG_SELECTED_PRIMARY`。

> ⚠️ **本表是「T62 收敛前」的基线快照**（历史事实，保留供追溯）。
> **当前生效的 token 数值一律看 §1** —— 其中 `#9ca3af` → `COLORS.textMuted` 一行已过时：
> Wave 7 卡 5 把 `textMuted` 改成 `#6b7280`（见 §1.1 / §1.2）。

### 4. 可访问性明细（ux_v2 §5，本 plan F-A11~F-A18 的原始依据）

| 方面 | 现状 | 修复建议 |
|---|---|---|
| Focus 样式 | 完全缺失 | 全局 `:focus-visible`（走 `global.css`，inline style 表达不了） |
| 表单 label | 无 `htmlFor` | 所有 input/select 加 `id` + `<label htmlFor>` |
| 表格 scope | `<th>` 无 scope | 加 `scope="col"` |
| 颜色对比度 | ~~`#16a34a` 白字 4.5:1 临界；`#6b7280` 白底 4.6:1 临界~~ | ✅ **Wave 7 卡 5 已落地**（数值见 §1.1「两档规则」/ §1.2）：正文色档 `textSuccess #15803d` / `textInfo #1d4ed8` / `textWarning #92400e` / `textMuted #6b7280` / `textFaint #737373` 对白底与页面灰底**均 ≥ 4.5:1**；饱和色档（`success` / `info` / `warning`）**只当徽章底 / 图形**用，不再承载白字 |
| 语义标签 | 仅 2 个 `<nav>` | 引入 `<header>/<main>/<nav>/<footer>` |
| aria-live | 缺失 | 动态内容区加 `aria-live="polite"` |
| 焦点锁定 | Review 弹窗无 | Modal 打开时锁定焦点 |

### 5. 架构决策（ux_v2 §8.3，仍然有效，勿推翻）

1. **inline style 方案保留**，但必须引入 Token 常量层；**不急于切 CSS Module / Tailwind**（MVP 阶段保持简单）
2. **允许引一个轻量 CSS 文件**（`global.css`）定义 `:focus-visible`、`body` 背景、`html/body` margin 重置 —— 这些 inline style 表达不了
3. ~~**不引图表库**：K 线继续手写 Canvas（ECharts/TradingView 在信号标记 overlay 上受限且增体积）；收益曲线用手写 SVG~~ —— **2026-10-17 DEC-11 已推翻**：K 线改用 `klinecharts@10.1.0`（只画不算，见 SDD §2.5）；收益曲线仍用手写 SVG。交易标记沿用 `klinecharts` 自定义 `draw` 叠加（§7）。
4. **TradeInput 实时预估算法在前端本地实现**（移动加权成本公式不复杂），无需打 API；与后端一致性由 golden 数据集在 CI 校验 —— ✅ **此条已由 DEC-1 落地**（前端直接用 `fast-technical-indicators`）
5. **Dark mode 推迟**（PRD §5.8 #8 自带「MVP 可选」）

### 6. frontend-gap-audit 中仍然有效的部分

| 内容 | 状态 |
|---|---|
| 「不变更的范围」表（移动端底部 Tab、桌面左侧导航、插件热重载、深色模式、收益曲线 SVG） | 移动端 Tab **已实现**；桌面左侧导航经 §10.3 裁决**按 PRD 执行**（T76）；其余归 V2 |
| 「实施顺序方案 B」7 波划分 | ✅ 已被本 plan 的 8 Wave 取代，但**排序逻辑一致**（先打通后端查询链路 → 再补前端） |
| 「工作量估算表」 | 8.5 人天 —— **严重低估**，本 plan §6 已给出修正对比 |
| 后端前置依赖清单（8 项） | ✅ 已并入 §3，动态审计实证 8 项全部成立 |
| Dashboard 建议 D「今日动态概览卡」 | ✅ 已补入 T67（**初稿遗漏的 P0**） |

---

### 7. K 线交易标记（2026-10-30）

> 交互口径见 PRD §5.2；本节只定义视觉。标记通过 `klinecharts` 自定义 `draw` 叠加（与 `APP_SIGNAL` 同机制），不新增第三方依赖。
>
> ⚠️ §5 第 3 条「不引图表库 / 手写 Canvas」已被 **DEC-11 / SDD §2.5** 推翻；K 线实际使用 `klinecharts@10.1.0`，本节以该实现为准。

| 项 | 规格 |
|---|---|
| 位置 | x = 交易所属日 K 的中心；y = 该笔交易在**当前复权口径**下的复权价（`qfq` / `hfq` / `bfq` / `raw` 随 K 线切换） |
| 形状 | 圆形（与策略信号的三角形区分）；半径 4px；**建仓/清仓为实心，加仓/减仓为空心**（描边 1.5px）—— 极端动作醒目、增量动作弱化 |
| 颜色 | 建仓/加仓 = `COLORS.candleUp`（A 股红）；减仓/清仓 = `COLORS.candleDown`（A 股绿）；外描边 1px `COLORS.cardBg` 保证深色画布可辨 |
| 同日多笔 | 聚合为 1 个 9px 空心圆环；同向时取该方向色，**含不同方向时用 `COLORS.info` 中性色**；悬停/点击列出全部交易（推导类型、原始类型、复权价、数量、成交时间）。**不得只显示一笔** |
| 周/月 K | 按交易日期归入所属周/月桶；同一桶多笔按同日规则聚合；明细不得因聚合丢失 |
| 图例与开关 | 图例 4 项：建仓（红实心圆）/ 加仓（红空心圆）/ 减仓（绿空心圆）/ 清仓（绿实心圆）；「交易点」开关默认开启；移动端图例换行，点击标记打开明细面板 |
| 层级 | 交易点画在蜡烛/MA 之上、十字光标/提示框之下；策略信号三角形后画（两者形状不同，可同日共存） |
| 明细面板 | 深色 `COLORS.chartBg` 底 + `COLORS.chartText` 文字；每笔一行，**全部列出**，面板最大高度 240px 可滚动；无成交时间（V3 导入）时省略时间，不伪造；推导类型与原始类型不一致时追加「录入为 X」 |
| 空态/降级 | 无交易记录时不画标记、不显示空图例；「交易点」开关仍可关闭；后端交易查询降级时按无标记处理，不阻塞 K 线渲染 |
| 可访问性 | Canvas 标记不可聚焦；明细面板支持 Esc 关闭，移动端点击遮罩关闭；颜色之外必须有形状/图例区分（不单靠红绿） |
