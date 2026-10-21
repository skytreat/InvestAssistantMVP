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
 * 4. **T66 删除了 4 个 0 引用的键**（`textOnDark` / `tableStripe` / `tableHover` / `RADIUS.lg`）——
 *    它们虽在 ui-spec §1 的建议表里，但**全仓无任何引用**，属于死导出。
 *    ⚠️ `pageBg` / `borderFocus` **保留** —— `src/styles/global.css` 里的
 *    `body` 背景与 `:focus-visible` 焦点环是**硬编码字面量**，其注释指向这两个 token。
 * 5. **Wave 7 卡 5（T76 ⑥）把语义色拆成「正文色档 / 徽章图形色档」两档**，
 *    并把 5 个正文 token 的对比度拉到 **≥ 4.5:1**（白底 + 页面灰底双底达标）。
 *    ⚠️ **待办**：`docs/client/ui-spec.md` §1 的色板表**尚未同步本轮新值**
 *    （本卡被限定不得改 `docs/`）—— 落值需由文档 owner 补登记，否则
 *    「token 数值唯一来源在 ui-spec §1」这条约定会与本文件脱节。
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

  // ── Semantic · 徽章/图形色档（Wave 7 卡 5 · 裁决 D-8） ──────────────
  //
  // ⚠️ **这三个是「饱和色档」**：只用于**描边 / 色点 / 纯图形**与
  //    **深色画布**（K 线图画布 `#1a1a2e`），**不得承载白字**
  //    （白字在饱和色上只有 3.30 / 3.68 / 3.19，**达不到 WCAG 1.4.3 的 4.5:1**）。
  //
  // 🔴 **浅底上的文字一律走下面的「正文色档」**（`textSuccess` / `textInfo` / `textWarning`）：
  //    - 徽章要带文字 → 走「浅底 + 深字」（`bgPill*` + `textPill*`）或
  //      「深底 + 白字」（底色取正文色档，白字 ≥ 4.5:1）；
  //    - 纯文字 → 直接用正文色档。
  //
  // ⚠️ **色相家族不变**（绿仍是绿）—— `success` 仍是「盈利绿 / 系统导入绿」，
  //    「红涨绿跌」由 `candleUp` / `candleDown` 单独承担，未被本轮改动触及。
  success: '#16a34a', // 盈利绿 / 系统导入绿（图形档；深色画布上的对比度 5.18:1）
  danger: '#dc2626', // 亏损红 / 删除 / ERROR（4.83:1，白底正文也合格）
  warning: '#d97706', // WARN（图形档）
  info: '#3b82f6', // 系统信号蓝（图形档）
  neutral: '#6b7280', // 次级文字

  // ── 正文色档（Wave 7 卡 5 · T76 ⑥ · 裁决 D-9） ────────────────────────
  //
  // 「语义色的**正文档**」：用在**白底（cardBg）/ 浅灰底（pageBg）上的文字**，
  // 全部满足 WCAG 1.4.3 的 **≥ 4.5:1**（白底与页面灰底**两种底色都达标**）。
  //
  // ⚠️ 为什么与上面的 `success` / `info` / `warning` 分成两档（D-9）：
  //    饱和色档在白底上只有 3.30 / 3.68 / 3.19 —— 当**正文**用不合格；
  //    但 `success` 在**深色画布**（K 线图）上要的就是「亮绿」（5.18:1），
  //    一刀切加深会把画布上的信号标记压到 3.40:1。
  //    ⇒ 两档并存，各司其职。
  /** 正文绿（盈利 / 系统导入的**文字**）：白底 5.02:1 / 页面灰底 4.79:1 */
  textSuccess: '#15803d',
  /** 正文蓝（系统信号的**文字**）：白底 6.70:1 / 页面灰底 6.41:1 */
  textInfo: '#1d4ed8',
  /** 正文琥珀（WARN 的**文字**）：白底 7.09:1 / 页面灰底 6.78:1 */
  textWarning: '#92400e',

  // Text hierarchy
  textPrimary: '#1f2937', // 主标题 / cardTitle 文字
  textSecondary: '#4b5563', // 正文次级文字（表头文字、label）
  /** 弱化文字（未标记、占位文案）：白底 4.83:1 / 页面灰底 4.62:1 */
  textMuted: '#6b7280',

  // Backgrounds
  pageBg: '#f8fafc', // 页面底色（`global.css` 的 `body` 背景硬编码同值，注释指向本 token）
  cardBg: '#ffffff', // 卡片 / 面板底色（白）
  headerBg: '#f9fafb', // 表头底色

  // Borders
  borderLight: '#e5e7eb', // 卡片边框 / 表格分隔线
  borderMedium: '#d1d5db', // 输入框边框
  borderFocus: '#2563eb', // 焦点环（`global.css` 的 `:focus-visible` 硬编码同值，见该文件注释）

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
  /** 选中蓝：Dashboard / Settings / PositionToolbar 的激活态背景（§3 的 BG_SELECTED_PRIMARY） */
  bgSelectedPrimary: '#dbeafe',
  /** 选中蓝边框（§3 的 BG_SELECTED_PRIMARY 边框色） */
  borderSelectedPrimary: '#93c5fd',
  /**
   * 选中红（§3 的 BG_SELECTED_DANGER）
   *
   * ⚠️ **T69 起 Review 的三态按钮不再用它** —— PRD §5.5 规定三态是
   *    「未标记（灰）/ 是（绿）/ 否（红）」，且**是/否必须区分**，
   *    而本 token 的语义是「这一组的选中态」（旧实现里「是」和「否」共用同一底色，
   *    只靠文字区分）→ 已迁到下面的 `bgPillDanger` / `bgPillSuccess` / `bgPillNeutral` 色板。
   *    本 token **保留**：ui-spec §3 的 token 清单里有它，且数值与 `bgPillDanger` 同值（#fee2e2）。
   */
  bgSelectedDanger: '#fee2e2',
  /** 选中红边框（§3 的 BG_SELECTED_DANGER 边框色，数值同 `borderPillDanger`） */
  borderSelectedDanger: '#fca5a5',

  // ── T69 补充：4 色标签（pill）+ 三态按钮的语义色板 ─────────────────
  // 依据：PRD §5.5「列表标签颜色：未复盘（灰）/ 系统信号触发（绿）/ 主观决策（橙）/ 止损（红）」
  //      + PRD §5.5「复盘编辑弹窗：三态默认未标记（灰），是（绿）/ 否（红）」
  // ⚠️ ui-spec §1 未规定这组色值（PRD 只给了颜色语义），故在此登记为**新增 token**，
  //    组件里**不得再写裸 hex**。
  /** 绿 pill 底色：系统信号（系统导入）/ 三态「是」 */
  bgPillSuccess: '#dcfce7',
  /** 绿 pill 文字（深绿，保证在浅绿底上的对比度 ≥ 4.5:1） */
  textPillSuccess: '#166534',
  /** 绿 pill 边框 */
  borderPillSuccess: '#86efac',
  /** 红 pill 底色：止损 / 三态「否」（与 `bgSelectedDanger` 同值） */
  bgPillDanger: '#fee2e2',
  /** 红 pill 文字（深红，保证在浅红底上的对比度 ≥ 4.5:1） */
  textPillDanger: '#991b1b',
  /** 红 pill 边框（与 `borderSelectedDanger` 同值） */
  borderPillDanger: '#fca5a5',
  /** 橙 pill 底色：主观决策 */
  bgPillWarning: '#ffedd5',
  /** 橙 pill 文字（深橙，保证在浅橙底上的对比度 ≥ 4.5:1） */
  textPillWarning: '#9a3412',
  /** 橙 pill 边框 */
  borderPillWarning: '#fdba74',
  /** 灰 pill 底色：未复盘 / 三态「未标记」 */
  bgPillNeutral: '#f3f4f6',
  /** 灰 pill 文字 */
  textPillNeutral: '#4b5563',
  /** 灰 pill 边框 */
  borderPillNeutral: '#d1d5db',

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
  /** 更弱的说明文字：K 线空态提示、404 说明（与 chartText 同值但语义不同）：白底 4.74:1 / 页面灰底 4.53:1 */
  textFaint: '#737373',
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
export const RADIUS = { sm: '4px', base: '6px', md: '8px' } as const;

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
