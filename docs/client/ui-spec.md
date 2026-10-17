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

```ts
// apps/frontend/src/theme/tokens.ts —— T62 落地依据（数值来自 ux_v2 §2.4）
export const COLORS = {
  // Primary / Brand
  brand: '#2563eb', brandLink: '#1e40af', brandBg: '#eff6ff',
  // Semantic
  success: '#16a34a',   // 盈利绿 / 系统导入绿
  danger:  '#dc2626',   // 亏损红 / 删除 / ERROR
  warning: '#d97706',   // WARN
  info:    '#3b82f6',
  neutral: '#6b7280',
  // Text hierarchy
  textPrimary: '#1f2937', textSecondary: '#4b5563',
  textMuted: '#9ca3af',   textOnDark: '#e5e7eb',
  // Backgrounds
  pageBg: '#f8fafc', cardBg: '#ffffff', headerBg: '#f9fafb',
  tableStripe: '#fafbfc', tableHover: '#f1f5f9',
  // Borders
  borderLight: '#e5e7eb', borderMedium: '#d1d5db', borderFocus: '#2563eb',
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

export const RADIUS = { sm: '4px', base: '6px', md: '8px', lg: '12px' } as const;

export const TYPO = {
  fontFamily: '"Noto Sans SC", "PingFang SC", system-ui, -apple-system, sans-serif',
  monoFamily: '"JetBrains Mono", "SF Mono", Consolas, monospace',
  h1Size: '22px', h1Weight: '700',
  h2Size: '18px', h2Weight: '600',
  cardTitleSize: '16px', cardTitleWeight: '600',
  bodySize: '14px', smallSize: '13px', captionSize: '11px',
} as const;

export const MAX_WIDTH = 1200;
```

**⚠️ 一处需修正的数值**：ux_v2 建议 `TYPO.h1Size: '22px'`，但现网 `titleStyle` 是 `24px`（`_shared.tsx`）。落地时**沿用 24px**（避免全站标题视觉突变），其余按上表。

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

### 4. 可访问性明细（ux_v2 §5，本 plan F-A11~F-A18 的原始依据）

| 方面 | 现状 | 修复建议 |
|---|---|---|
| Focus 样式 | 完全缺失 | 全局 `:focus-visible`（走 `global.css`，inline style 表达不了） |
| 表单 label | 无 `htmlFor` | 所有 input/select 加 `id` + `<label htmlFor>` |
| 表格 scope | `<th>` 无 scope | 加 `scope="col"` |
| 颜色对比度 | `#16a34a` 白字 4.5:1 临界；`#6b7280` 白底 4.6:1 临界 | 升级为 `#15803d` / `#c81e1e` / `#4b5563`（P2，可选） |
| 语义标签 | 仅 2 个 `<nav>` | 引入 `<header>/<main>/<nav>/<footer>` |
| aria-live | 缺失 | 动态内容区加 `aria-live="polite"` |
| 焦点锁定 | Review 弹窗无 | Modal 打开时锁定焦点 |

### 5. 架构决策（ux_v2 §8.3，仍然有效，勿推翻）

1. **inline style 方案保留**，但必须引入 Token 常量层；**不急于切 CSS Module / Tailwind**（MVP 阶段保持简单）
2. **允许引一个轻量 CSS 文件**（`global.css`）定义 `:focus-visible`、`body` 背景、`html/body` margin 重置 —— 这些 inline style 表达不了
3. **不引图表库**：K 线继续手写 Canvas（ECharts/TradingView 在信号标记 overlay 上受限且增体积）；收益曲线用手写 SVG
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
