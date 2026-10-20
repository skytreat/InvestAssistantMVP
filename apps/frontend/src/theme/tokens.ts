/**
 * Design Token 常量层（T62）
 *
 * ⚠️ **数值唯一来源：`docs/client/ui-spec.md` §1「Design Token 具体数值」**
 *    —— **改值前先看该文件**，不要在本文件里凭感觉调色/调间距。
 *    验收基准见同文件 §3「全站内联颜色清单」。
 *
 * 落地约定（均来自 ui-spec 的显式说明，不是本文件的自由发挥）：
 *
 * 1. §1 建议 `TYPO.h1Size: '22px'`，但现网 `titleStyle`（`_shared.tsx`）是 `24px`
 *    → **落地沿用 24px**，避免全站标题视觉突变（ui-spec §1 修正说明）。
 * 2. §3 末尾提示：`#fee2e2` / `#dbeafe` 两组在建议 token 表中**原本缺失**
 *    → 本文件补 `bgSelectedDanger` / `bgSelectedPrimary`（含各自边框色）。
 * 3. 标注「T62 补充」的 token 是**现网已在用、但 §1 建议表未覆盖**的颜色：
 *    数值与现网**完全一致**（不改变任何视觉），只做命名收敛，避免在页面里继续写裸 hex。
 *
 * 用法约定：
 * - 样式对象里**直接引用常量**，不要引入 CSS 变量 `var(--x)`
 *   （字符串模板里拼 `conic-gradient` 等场景，直接用常量更稳）。
 * - 本文件是纯常量，**不含任何逻辑**，可被任意页面 / 组件直接 import。
 */

/** 颜色 token */
export const COLORS = {
  // Primary / Brand
  brand: '#2563eb', // 主色：主按钮、激活态、焦点环
  brandLink: '#1e40af', // 链接蓝（深一档）
  brandBg: '#eff6ff', // 品牌浅底：hover 蓝 / 自动补全高亮

  // Semantic
  success: '#16a34a', // 盈利绿 / 系统导入绿
  danger: '#dc2626', // 亏损红 / 删除 / ERROR
  warning: '#d97706', // WARN
  info: '#3b82f6', // 系统信号蓝
  neutral: '#6b7280', // 次级文字

  // Text hierarchy
  textPrimary: '#1f2937', // 主标题 / cardTitle 文字
  textSecondary: '#4b5563', // 正文次级文字（表头文字、label）
  textMuted: '#9ca3af', // 弱化文字（未标记、占位文案）
  textOnDark: '#e5e7eb', // 深色背景上的文字

  // Backgrounds
  pageBg: '#f8fafc', // 页面底色
  cardBg: '#ffffff', // 卡片 / 面板底色（白）
  headerBg: '#f9fafb', // 表头底色
  tableStripe: '#fafbfc', // 表格斑马纹
  tableHover: '#f1f5f9', // 表格 hover 底色

  // Borders
  borderLight: '#e5e7eb', // 卡片边框 / 表格分隔线
  borderMedium: '#d1d5db', // 输入框边框
  borderFocus: '#2563eb', // 焦点环

  // Chart palette（Kline.tsx 专用）
  chartBg: '#1a1a2e', // 画布底色
  chartGrid: '#2d2d44', // 网格线
  chartText: '#888888', // 图表内文字（坐标刻度 / 图例）
  candleUp: '#ef4444', // A 股红涨
  candleDown: '#22c55e', // A 股绿跌
  ma5: '#fbbf24',
  ma10: '#60a5fa',
  ma20: '#c084fc',
  macdBarPos: '#ef4444', // MACD 正柱（红）
  macdBarNeg: '#22c55e', // MACD 负柱（绿）
  rsiLine: '#a78bfa',
  difLine: '#60a5fa',
  deaLine: '#f59e0b',

  // ── T62 补充：§3 明确要求新增的两组「三态选中」配色 ──────────────
  /** 选中蓝：Review「是否符合策略」选中态背景（§3 的 BG_SELECTED_PRIMARY） */
  bgSelectedPrimary: '#dbeafe',
  /** 选中蓝边框（§3 的 BG_SELECTED_PRIMARY 边框色） */
  borderSelectedPrimary: '#93c5fd',
  /** 选中红：Review「是否止损」选中态背景（§3 的 BG_SELECTED_DANGER） */
  bgSelectedDanger: '#fee2e2',
  /** 选中红边框（§3 的 BG_SELECTED_DANGER 边框色） */
  borderSelectedDanger: '#fca5a5',

  // ── T62 补充：现网已在用、但 §1 建议表未覆盖的颜色（数值与现网一致） ──
  /** 紫色强调：已实现盈亏 / 胜率等特殊指标数字 */
  accentPurple: '#7c3aed',
  /** 紫色浅底：插件分类标签底色（条件选股类） */
  bgSelectedPurple: '#ede9fe',
  /** 紫色标签文字（条件选股类） */
  textSelectedPurple: '#5b21b6',
  /** 合规声明条底色（浅黄） */
  bgDisclaimer: '#fef3c7',
  /** 合规声明条文字（深黄） */
  textDisclaimer: '#92400e',
  /** 中性弱化文字：导航栏用户名、K 线计数、图表刻度数字 */
  textTertiary: '#666666',
  /** 更弱的说明文字：K 线空态提示、404 说明（与 chartText 同值但语义不同） */
  textFaint: '#888888',
  /** 极浅分隔线 / 底色：卡片标题下边框、code 标签底色 */
  borderSubtle: '#f3f4f6',
  /** 图表内指标名等次要文字（MACD(12,26,9) / RSI(14) / 插件 id） */
  chartLabel: '#aaaaaa',
  /** 图表参考线（MACD 零轴） */
  chartAxis: '#444444',
  /** 图表强调参考线（RSI 50 线） */
  chartAxisStrong: '#555555',
  /** 图表画布边框 */
  chartBorder: '#333333',
  /** 弹窗遮罩 */
  maskOverlay: 'rgba(0, 0, 0, 0.5)',
  /** 柔和阴影（下拉浮层） */
  shadowSoft: 'rgba(0, 0, 0, 0.1)',
} as const;

/** 间距 token（px） */
export const SPACING = {
  pagePadding: '24px', // 页面容器内边距
  cardPadding: '16px', // 卡片内边距
  cardMarginBottom: '24px', // 卡片下外边距
  formRowGap: '12px', // 表单行元素间距
  formRowMarginBottom: '12px', // 表单行下外边距
  labelMinWidth: '80px', // label 最小宽度
  btnPadding: '6px 16px', // 按钮内边距
  inputPadding: '6px 10px', // 输入框内边距
  navPadding: '12px 16px', // 导航条内边距
  gapTight: '4px',
  gapBase: '8px',
  gapRelaxed: '16px',
  gapLoose: '24px',
} as const;

/** 圆角 token（px） */
export const RADIUS = { sm: '4px', base: '6px', md: '8px', lg: '12px' } as const;

/** 字体 token */
export const TYPO = {
  fontFamily: '"Noto Sans SC", "PingFang SC", system-ui, -apple-system, sans-serif',
  monoFamily: '"JetBrains Mono", "SF Mono", Consolas, monospace',
  /** ⚠️ §1 建议 22px，现网 `titleStyle` 是 24px → 沿用 24px（避免标题视觉突变） */
  h1Size: '24px',
  h1Weight: '700',
  h2Size: '18px',
  h2Weight: '600',
  cardTitleSize: '16px',
  cardTitleWeight: '600',
  bodySize: '14px',
  smallSize: '13px',
  captionSize: '11px',
} as const;

/** 内容最大宽度（px） */
export const MAX_WIDTH = 1200 as const;
