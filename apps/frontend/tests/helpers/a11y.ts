/**
 * axe-core 断言助手（Wave 3 · G3.4「a11y：axe 核心规则 0 critical」的测试基建）
 *
 * ## 为什么需要它
 *
 * G3.4 是 Wave 3 的**出口门槛**，要求「axe 核心规则 0 critical」。
 * 在本文件落地之前，仓库里**没有任何 a11y 自动化** —— 只能靠人眼看，
 * 门槛既不可执行、也不可复现、CI 更跑不了。
 *
 * 本文件把 axe 接进 vitest（jsdom）基建，提供两个可复用的断言：
 * - {@link getA11yViolations} —— 跑 axe 并按 impact 过滤违规；
 * - {@link expectNoCriticalA11yViolations} —— 断言「没有 critical 级违规」。
 *
 * ## ⚠️ jsdom 的已知限制（实测结论，勿凭记忆改）
 *
 * jsdom **没有 layout engine**（不排版、不做盒模型计算），
 * 因此一部分 axe 规则在 jsdom 下**要么无法评估、要么恒判通过（静默漏检）**。
 * 这些规则必须**显式关掉** —— 否则：
 * - 要么拿到一堆**误报**（噪声，掩盖真实问题）；
 * - 要么拿到一堆**假阴性**（更危险：门禁显示「通过」，实际没检）。
 *
 * 实测方式：逐条规则单独跑 `axe.run(body, { runOnly: { type: 'rule', values: [id] } })`，
 * 看返回的是 violation / incomplete / pass / inapplicable。
 *
 * ### 关掉的规则清单（每条都写明原因）
 *
 * | 规则 | jsdom 下的实测现象 | 为什么不可评估 |
 * |---|---|---|
 * | `color-contrast` | **incomplete**（需人工复核） | axe 判断「图标连字」要调 `canvas.getContext('2d')` 量文本宽度（axe.js `_isIconLigature`）。jsdom 未实现 canvas → 返回 `null` → axe 抛错降级为 incomplete。**顺带**会往 stderr 打 `Not implemented: HTMLCanvasElement.prototype.getContext` 噪声。 |
 * | `link-in-text-block` | 实测恒 **inapplicable** | 与 `color-contrast` **共用同一条 canvas 颜色检测路径**。一旦页面出现「文本块内的异色链接」，jsdom 下会退化成 incomplete（静默漏检）而非给出结论。 |
 * | `target-size` | 实测恒 **pass** | WCAG 2.2「目标尺寸」要读 `getBoundingClientRect()` 的真实几何尺寸；jsdom 的矩形**恒为 0×0** → 恒判通过 = 假阴性。 |
 * | `avoid-inline-spacing` | 实测恒 **pass** | 要读行内元素的 `getClientRects()` 包围盒间距；jsdom **恒返回空数组** → 恒判通过 = 假阴性。 |
 * | `scrollable-region-focusable` | 实测恒 **inapplicable** | 要比较 `scrollWidth/scrollHeight` 与 `clientWidth/clientHeight`；jsdom 这些值**恒为 0** → 永远判定「没有可滚动区域」。 |
 *
 * ### 这 5 条谁来兜底
 *
 * 真浏览器脚本 **`scripts/a11y-check.mjs`** —— 它在 **Chromium 真渲染**下跑 axe，
 * **不关任何规则**，所以上表 5 条（含 `color-contrast`）在那条路径上是**真检**。
 * 详见 `docs/audit/a11y-baseline.md`。
 *
 * ⚠️ **不要为了「让测试变绿」而扩大这份清单** ——
 * 每多关一条，G3.4 的检出能力就少一分。扩清单前必须先跑一遍
 * `node scripts/a11y-check.mjs`（真浏览器）确认该规则在真实渲染下确实可用。
 */

import axe, { type AxeResults, type ImpactValue } from 'axe-core';

/** axe 的 impact 分级（`critical` 是 G3.4 门禁唯一关心的等级） */
export type A11yImpact = NonNullable<ImpactValue>;

/**
 * jsdom 下**不可评估**的 axe 规则清单
 *
 * 逐条原因见文件头部的长表格；此处是「规则的唯一事实源」，
 * helper 内部据此构造 `axe.run` 的 `rules` 选项。
 */
export const AXE_RULES_UNSUPPORTED_IN_JSDOM: ReadonlyArray<{
  /** axe 规则 id */
  readonly id: string;
  /** 为什么在 jsdom 下不可评估 */
  readonly reason: string;
}> = [
  {
    id: 'color-contrast',
    reason:
      'axe 判断图标连字需调 canvas.getContext("2d") 量文本宽度；jsdom 无 canvas → 结果恒为 incomplete（需人工复核），并向 stderr 抛 Not implemented 噪声。',
  },
  {
    id: 'link-in-text-block',
    reason:
      '与 color-contrast 共用同一条 canvas 颜色检测路径；jsdom 下若命中「文本块内异色链接」会退化为 incomplete（静默漏检）。',
  },
  {
    id: 'target-size',
    reason:
      'WCAG 2.2 目标尺寸依赖 getBoundingClientRect() 的真实几何尺寸；jsdom 的矩形恒为 0×0 → 恒判通过（假阴性）。',
  },
  {
    id: 'avoid-inline-spacing',
    reason: '依赖行内元素的 getClientRects() 包围盒间距；jsdom 恒返回空数组 → 恒判通过（假阴性）。',
  },
  {
    id: 'scrollable-region-focusable',
    reason:
      '依赖 scrollWidth/scrollHeight 与 clientWidth/clientHeight 的真实布局尺寸；jsdom 恒为 0 → 永远判定「无可滚动区域」。',
  },
];

/** 由 {@link AXE_RULES_UNSUPPORTED_IN_JSDOM} 派生的 axe `rules` 选项（全部关掉） */
const DISABLED_RULES: axe.RuleObject = Object.fromEntries(
  AXE_RULES_UNSUPPORTED_IN_JSDOM.map((r) => [r.id, { enabled: false }]),
);

/** 影响级别过滤参数 */
export interface A11yFilterOptions {
  /**
   * 只保留该 impact 的违规
   *
   - `'critical'`（**默认**）—— G3.4 门禁关心的唯一等级；
   * `'all'` —— 不按 impact 过滤（用于「全量基线」，防任何等级的回归）。
   */
  readonly impact?: A11yImpact | 'all';
}

/**
 * 待检查的 DOM 范围
 *
 * - `Element` —— 通常传 `document.body`（逐页检查）
 * - `Document` —— 传 `document` 可额外评估 `html-has-lang` / `document-title`
 *   这类**文档级**规则（它们只在 context 含 `<html>` 时才会被评估）
 */
export type A11yContainer = Element | Document;

/**
 * 对给定容器跑一次 axe，返回**完整**结果
 *
 * ⚠️ 同一个页面请**只调一次**再自行过滤 —— axe 每次全量跑一遍所有规则，代价不小。
 */
export async function runA11y(container: A11yContainer): Promise<AxeResults> {
  return axe.run(container, { rules: DISABLED_RULES });
}

/**
 * 对给定 DOM 容器跑 axe，返回 violations
 *
 * 默认只返回 `impact === 'critical'` 的违规（G3.4 门禁口径）。
 * 传 `{ impact: 'all' }` 可拿到全部等级的违规（用于建立/校验全量基线）。
 */
export async function getA11yViolations(
  container: A11yContainer,
  options: A11yFilterOptions = {},
): Promise<AxeResults['violations']> {
  const result = await runA11y(container);
  return filterViolationsByImpact(result.violations, options.impact ?? 'critical');
}

/**
 * 按 impact 过滤违规（纯函数，便于对**已跑过**的 axe 结果复用）
 *
 * `impact === 'all'` 时返回全部。
 */
export function filterViolationsByImpact(
  violations: AxeResults['violations'],
  impact: A11yImpact | 'all',
): AxeResults['violations'] {
  if (impact === 'all') return violations;
  return violations.filter((v) => v.impact === impact);
}

/**
 * 断言容器内**没有 critical 级 a11y 违规**
 *
 * 失败时给出可读摘要：规则 id / impact / 影响节点的 html 片段 / axe 官方修复说明链接。
 *
 * @param target 可以传 DOM 容器（内部跑一次 axe），
 *               也可以传**已经跑过**的 axe 结果（避免重复跑 axe）。
 */
export async function expectNoCriticalA11yViolations(target: A11yContainer | AxeResults): Promise<void> {
  const result = 'violations' in target ? target : await runA11y(target);
  const critical = filterViolationsByImpact(result.violations, 'critical');

  if (critical.length === 0) return;

  const summary = critical
    .map((v) => {
      const nodes = v.nodes
        .slice(0, 5)
        .map((n) => `      - ${n.html}`)
        .join('\n');
      const more = v.nodes.length > 5 ? `\n      ...（另有 ${v.nodes.length - 5} 个节点）` : '';
      return [
        `  ✗ [${v.impact ?? 'unknown'}] ${v.id} —— ${v.help}`,
        `    说明：${v.description}`,
        `    节点：`,
        `${nodes}${more}`,
        `    修复参考：${v.helpUrl}`,
      ].join('\n');
    })
    .join('\n\n');

  throw new Error(
    `a11y 门禁失败：发现 ${critical.length} 条 critical 级违规\n\n${summary}\n\n` +
      `（若确认是 jsdom 环境本身造成的误报，请在 ` +
      `apps/frontend/tests/helpers/a11y.ts 的 AXE_RULES_UNSUPPORTED_IN_JSDOM 里登记原因；` +
      `若确属真实缺陷，请修 src/ 而不是放宽断言。）`,
  );
}

/**
 * 把违规列表格式化成可读文本（用于测试失败信息 / 基线快照）
 *
 * 每条一行：`id(impact) × N 节点 —— 首个节点的 html 片段`
 */
export function formatA11yViolations(violations: AxeResults['violations']): string {
  if (violations.length === 0) return '（无违规）';
  return violations
    .map((v) => {
      const first = v.nodes[0]?.html ?? '(无节点)';
      return `[${v.impact ?? 'unknown'}] ${v.id} × ${v.nodes.length} —— ${first}`;
    })
    .join('\n');
}
