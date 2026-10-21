import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { api } from '../api/client';
import { extractErrorMessage } from '../api/errors';
import { COLORS, RADIUS, SPACING, TYPO } from '../theme/tokens';
import { cardStyle, cardTitleStyle } from '../theme/styles';

/**
 * DatacheckCards —— C1-C12 校验仪表盘（Wave 7 · 卡 3）
 *
 * ## 交付的是 G7.6 的三件事
 *
 * | G7.6 子句 | 本组件的落点 |
 * |---|---|
 * | 「12 项校验卡片**真实渲染 12 条**」 | `EXPECTED_CHECK_IDS` 铺满 12 张，缺项也**占位**（SKIP + 「未运行」）|
 * | 「卡片显示的**校验名称**与 SDD §5.7 主表一致」 | 名称**由后端下发**（`name` 字段），前端**不硬编码**（裁决 D-4）|
 * | 「停牌/退市/ST 等扩展校验**不得占用 C 编号**」 | 前端只认 `{C1..C12}`，其余编号一律不渲染 |
 *
 * ## 为什么名称不能在前端写死
 *
 * 名称的**唯一权威是 SDD §5.7 主表的小节标题**，后端 `services/validator.ts` 的
 * `CHECK_NAMES` 是全仓唯一引用它的地方。若前端再抄一份，就变成「前端自说自话 vs
 * 前端自说自话」—— 名称与 SDD 漂移时**没有任何一处会报错**（自证），G7.6 形同虚设。
 *
 * ⚠️ 本组件**只硬编码了编号**（`EXPECTED_CHECK_IDS`），那是「12 项」的**结构基准**
 *   （裁决 D-1），**不含任何名称**。
 */

/** 后端 `GET /admin/datacheck/result` 的单条元素 */
export interface DatacheckItem {
  checkId: string;
  /** 校验名称（后端下发；缺省时前端显示占位文案） */
  name?: string | null;
  /** 四态结果：PASS / WARN / ERROR / SKIP（后端旧版本可能给 SUCCESS，前端等价当 PASS） */
  result: string;
  message?: string | null;
  detail?: string | null;
}

export interface DatacheckCardsProps {
  /** 注入校验结果（不传则组件自行请求 `/admin/datacheck/result`） */
  items?: DatacheckItem[];
  /** 变化时重新拉取（接线后「手动触发校验」可用它刷新卡片） */
  refreshKey?: number | string;
}

/** 校验结果的四种状态 */
type ResultState = 'PASS' | 'WARN' | 'ERROR' | 'SKIP';

/**
 * C1~C12 的**编号**全集（仅结构，不含名称）
 *
 * ⚠️ 这里硬编码的是**编号**（裁决 D-1 的判定基准「{C1..C12} 全集」），
 *   **不是名称** —— 名称一律由后端下发（裁决 D-4）。
 *   作用：后端少返回时也要**占位渲染**（卡 3 交付 2「不得少渲染」），
 *   这正是 G7.6「不再是空态 / checkId 只有 2 个」要防的回归。
 */
const EXPECTED_CHECK_IDS: readonly string[] = [
  'C1',
  'C2',
  'C3',
  'C4',
  'C5',
  'C6',
  'C7',
  'C8',
  'C9',
  'C10',
  'C11',
  'C12',
];

/** 四色（PRD §5.7：PASS=绿 / WARN=黄 / ERROR=红 / SKIP=灰） */
interface ResultPalette {
  /** 浅色底 */
  bg: string;
  /** 深色文字（保证在浅底上对比度 ≥ 4.5:1） */
  text: string;
  /** 描边 */
  border: string;
  /** 徽标文案 */
  label: string;
}

/**
 * 四色配色（**浅色底 + 深色字**）
 *
 * 🔴 **为什么不是「彩色底 + 白字」**：那是 `pages/Admin.tsx` 旧实现的做法，
 *   也正是 `info #3b82f6`（3.68:1）/ `success #16a34a`（3.30:1）对比度不足的**来源**。
 *   现改为「浅色底 + 深色字」—— 文字对比度由 token 的深色档保证（实测均 ≥ 4.5:1）。
 *
 * ⚠️ 全部取自 `theme/tokens.ts` 的既有 pill 色板（**未新增任何裸 hex**），
 *   且**不改动** `COLORS.success` / `COLORS.info` 本身（那是 卡 5 的 token 收口范围）。
 */
const RESULT_PALETTE: Record<ResultState, ResultPalette> = {
  PASS: {
    bg: COLORS.bgPillSuccess,
    text: COLORS.textPillSuccess,
    border: COLORS.borderPillSuccess,
    label: 'PASS',
  },
  WARN: {
    bg: COLORS.bgPillWarning,
    text: COLORS.textPillWarning,
    border: COLORS.borderPillWarning,
    label: 'WARN',
  },
  ERROR: {
    bg: COLORS.bgPillDanger,
    text: COLORS.textPillDanger,
    border: COLORS.borderPillDanger,
    label: 'ERROR',
  },
  SKIP: {
    bg: COLORS.bgPillNeutral,
    text: COLORS.textPillNeutral,
    border: COLORS.borderPillNeutral,
    label: 'SKIP',
  },
};

/** 把后端返回的 result 归一到四态（`SUCCESS` = 旧后端对 PASS 的落库写法） */
function normalizeResult(raw: string | null | undefined): ResultState {
  const value = (raw ?? '').trim().toUpperCase();
  if (value === 'SUCCESS' || value === 'PASS') return 'PASS';
  if (value === 'WARN') return 'WARN';
  if (value === 'ERROR') return 'ERROR';
  return 'SKIP';
}

/* ------------------------------------------------------------------ *
 * 样式
 * ------------------------------------------------------------------ */

/** 卡片网格：flex + wrap（不用 grid，避免窄视口下 minmax 撑破文档） */
const gridStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: SPACING.gapBase,
};

/** 单张卡的容器：`minWidth:0` 防止长名称把 flex 行撑宽（G7.7 的老坑） */
const cardWrapperStyle: CSSProperties = {
  flex: '1 1 200px',
  minWidth: 0,
  maxWidth: '100%',
};

const cardButtonStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: SPACING.gapTight,
  width: '100%',
  padding: '8px 10px',
  border: `1px solid ${COLORS.borderLight}`,
  borderRadius: RADIUS.base,
  background: COLORS.cardBg,
  cursor: 'pointer',
  textAlign: 'left',
  fontSize: TYPO.smallSize,
  color: COLORS.textPrimary,
};

const checkIdStyle: CSSProperties = {
  fontWeight: TYPO.cardTitleWeight,
  fontSize: TYPO.bodySize,
  color: COLORS.textPrimary,
};

const nameStyle: CSSProperties = {
  fontSize: TYPO.captionSize,
  lineHeight: 1.5,
  color: COLORS.textSecondary,
  // 长名称（C11/C12）不得撑破卡片
  overflowWrap: 'anywhere',
  wordBreak: 'break-word',
};

const badgeStyle: CSSProperties = {
  display: 'inline-block',
  padding: '1px 8px',
  borderRadius: RADIUS.sm,
  fontSize: TYPO.captionSize,
  fontWeight: TYPO.cardTitleWeight,
};

const detailStyle: CSSProperties = {
  marginTop: SPACING.gapTight,
  padding: SPACING.gapBase,
  border: `1px solid ${COLORS.borderLight}`,
  borderRadius: RADIUS.sm,
  background: COLORS.headerBg,
  fontSize: TYPO.captionSize,
  lineHeight: 1.6,
  color: COLORS.textSecondary,
  overflowWrap: 'anywhere',
};

const preStyle: CSSProperties = {
  margin: 0,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  fontSize: TYPO.captionSize,
  color: COLORS.textSecondary,
  maxHeight: 180,
  overflow: 'auto',
};

/* ------------------------------------------------------------------ *
 * 组件
 * ------------------------------------------------------------------ */

export default function DatacheckCards({ items, refreshKey }: DatacheckCardsProps) {
  const [remote, setRemote] = useState<DatacheckItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 已展开详情的 checkId 集合（多张可同时展开） */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/admin/datacheck/result');
      if (res.data?.success) {
        setRemote(Array.isArray(res.data.data) ? (res.data.data as DatacheckItem[]) : []);
      } else {
        setError(res.data?.message ?? '请求失败');
      }
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  /** 注入模式（传了 `items`）不自己请求 */
  const injected = items !== undefined;
  useEffect(() => {
    if (injected) return;
    void load();
  }, [injected, load, refreshKey]);

  const toggle = useCallback((checkId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(checkId)) next.delete(checkId);
      else next.add(checkId);
      return next;
    });
  }, []);

  /**
   * 卡片集合：**恒为 12 张**
   *
   * ⚠️ 后端少返回时用占位项补齐（SKIP + 「未运行」+ 无 detail）——
   *   「12 条」的基准是 `{C1..C12}` 全集（裁决 D-1），**不允许少渲染**。
   */
  const cards = useMemo<DatacheckItem[]>(() => {
    const source = items ?? remote ?? [];
    const byId = new Map<string, DatacheckItem>();
    for (const item of source) {
      if (!EXPECTED_CHECK_IDS.includes(item.checkId)) continue;
      byId.set(item.checkId, item);
    }
    return EXPECTED_CHECK_IDS.map(
      (checkId) =>
        byId.get(checkId) ?? {
          checkId,
          name: null,
          result: 'SKIP',
          message: '未运行',
          detail: null,
        },
    );
  }, [items, remote]);

  return (
    <div style={cardStyle}>
      <div style={cardTitleStyle}>数据校验结果（C1-C12）— 点击卡片查看详情</div>
      <div aria-busy={loading} aria-live="polite">
        {error && <div style={{ color: COLORS.danger, marginBottom: SPACING.gapBase }}>{error}</div>}
        <div style={gridStyle}>
          {cards.map((item) => {
            const state = normalizeResult(item.result);
            const palette = RESULT_PALETTE[state];
            const isExpanded = expanded.has(item.checkId);
            const detailId = `datacheck-detail-${item.checkId}`;
            return (
              <div key={item.checkId} style={cardWrapperStyle}>
                <button
                  type="button"
                  aria-expanded={isExpanded}
                  aria-controls={detailId}
                  data-testid="datacheck-card"
                  data-check-id={item.checkId}
                  data-result={state}
                  onClick={() => toggle(item.checkId)}
                  style={cardButtonStyle}
                >
                  <span style={checkIdStyle}>{item.checkId}</span>
                  {/* 副标题 = 校验名称；名称缺失（占位项）时退回 message（如「未运行」） */}
                  <span style={nameStyle}>{item.name?.trim() || item.message?.trim() || '（无名称）'}</span>
                  <span
                    data-testid={`datacheck-badge-${item.checkId}`}
                    style={{
                      ...badgeStyle,
                      background: palette.bg,
                      color: palette.text,
                      border: `1px solid ${palette.border}`,
                    }}
                  >
                    {palette.label}
                  </span>
                </button>
                {/* 详情区始终渲染（保证 `aria-controls` 指向的元素存在），
                    折叠时用 `hidden` 移出无障碍树 */}
                <div
                  id={detailId}
                  data-testid={`datacheck-detail-${item.checkId}`}
                  hidden={!isExpanded}
                  style={detailStyle}
                >
                  <div style={{ marginBottom: SPACING.gapTight }}>{item.message || '（无说明）'}</div>
                  {item.detail ? <pre style={preStyle}>{item.detail}</pre> : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
