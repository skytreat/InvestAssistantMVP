import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { extractErrorMessage } from '../api/errors';
import { COLORS, RADIUS, SPACING, TYPO } from '../theme/tokens';
import {
  buttonStyle,
  cardStyle,
  cardTitleStyle,
  inputStyle,
  tableStyle,
  thStyle,
  thTdStyle,
  truncatedTextStyle,
} from '../theme/styles';
import ScrollableTable from './ScrollableTable';
import Spinner from './Spinner';

/**
 * Admin 日志面板（Wave 7 · 卡 1 · T75「日志查看」）
 *
 * ## 它解决什么
 *
 * PRD §5.7「日志查看」要求：**分页 + 日期过滤 + 类型过滤**，
 * 并显示「系统日志降级记录」（正常日志库不可用时的兜底）。
 * 现状（`pages/Admin.tsx` 的内联块）只传 `page` / `page_size`，
 * 日期 / 类型 / level 三个过滤**从未传给后端**（gap F-A1），
 * 且日志表**没有滚动容器** → 375px / 768px 下**文档级横向溢出**（F-Q12 / G7.7）。
 *
 * 本组件交付三件事：
 *
 * 1. **三类筛选**：日期范围（起止两个 date）/ 类型下拉 / level 下拉，
 *    筛选变化 → `page` 重置为 1（裁决 D-3：后端已改成 `log_date BETWEEN ? AND ?`）。
 * 2. **长文本不撑破文档**：表格外套 `ScrollableTable`（`overflow-x:auto`），
 *    `message` / `detail` 单元格用 `truncatedTextStyle` 截断 + `title` 暴露全文。
 * 3. **`<768px` 改卡片列表**：不渲染 `<table>`（裁决 D-2）——
 *    滚动容器解决「文档级溢出」，卡片化解决「可读性」，两件都要做。
 *
 * ## 为什么是独立组件（而不是继续写在 Admin 页里）
 *
 * 卡 1 / 卡 2 / 卡 3 三个组件必须**互不 import**、文件零重叠，才能并行开发；
 * 接线（把本组件放进 Admin 页）统一由**卡 6** 串行完成。
 * ⇒ 本组件**不 import `pages/Admin.tsx`**，只依赖 `api/client` 与 `theme/`。
 *
 * ## 关于窄视口断点
 *
 * 断点判定用**渲染期 JS**（`window.innerWidth` + resize 监听），
 * **不用** CSS media query 做「显示/隐藏」——
 * 那会同时渲染两份 DOM，读屏用户会把表格和卡片各读一遍。
 *
 * ⚠️ 这里**没有** import `pages/_shared.tsx` 的 `useIsMobile`：① 组件层不反向依赖页面层
 *    （T66 确立的依赖方向）；② `pages/_shared.tsx` 是卡 4 的重写对象，
 *    import 会让本组件与并行改动产生隐性耦合。断点值与 `MOBILE_BREAKPOINT` 同为 768。
 */

/** 窄视口断点（px）—— 与 `pages/_shared.tsx` 的 `MOBILE_BREAKPOINT` 同值 */
const NARROW_VIEWPORT_MAX_WIDTH = 768;

/**
 * 日志类型 → 中文标签
 *
 * ⚠️ **取值必须与后端 `system_log` 的 CHECK 白名单一致**
 *    （`apps/backend/src/config/configStore.ts` 的建表 DDL）。
 *    2026-10-21 实测：后端白名单已含 `candidate_migrate`（Wave 6 T74 新增），
 *    而旧 Admin 页的映射表**漏了它** → 该类型在页面上显示成裸英文。
 *    本表是**完整**的 10 项，卡 6 接线时应改用本表（导出）并删掉 Admin 页里的旧副本。
 */
export const LOG_TYPE_LABEL: Record<string, string> = {
  tdx2db_update: '行情更新',
  datacheck: '数据校验',
  plugin_execute: '插件执行',
  signal_generate: '信号生成',
  dividend_import: '除权导入',
  backup: '备份',
  trigger_manual: '手动触发',
  startup: '启动',
  trade: '交易',
  candidate_migrate: '候选迁移',
};

/**
 * 日志级别 → 颜色（全部取 token；卡 5 调整 token 数值时自动跟随）
 *
 * ⚠️ **Wave 7 卡 5（裁决 D-9）**：级别是**文字**，故走**正文色档**
 *    （`textInfo` 6.70:1 / `textWarning` 7.09:1 / `textSuccess` 5.02:1）——
 *    饱和的 `COLORS.info` / `warning` / `success` 白底只有 3.68 / 3.19 / 3.30，
 *    会被真浏览器 axe 判 color-contrast（serious）。
 */
const LEVEL_COLOR: Record<string, string> = {
  INFO: COLORS.textInfo,
  WARN: COLORS.textWarning,
  ERROR: COLORS.danger,
  SKIP: COLORS.textMuted,
  SUCCESS: COLORS.textSuccess,
};

/** 可选日志级别 —— 与 `services/logger.ts` 的 `ALLOWED_LEVELS` 逐字一致 */
const LOG_LEVELS = ['INFO', 'WARN', 'ERROR', 'SKIP', 'SUCCESS'] as const;

/** 日志表列（`key` = 后端列名，`label` = 表头文案） */
const LOG_COLUMNS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'log_date', label: '日期' },
  { key: 'log_type', label: '类型' },
  { key: 'level', label: '级别' },
  { key: 'check_item', label: '校验项' },
  { key: 'message', label: '消息' },
  { key: 'detail', label: '详情' },
];

/** system_log 的一行（后端 `SELECT *` 返回，这里只声明会用到的字段） */
interface LogRow {
  id?: number;
  log_date?: string;
  log_type?: string;
  level?: string;
  check_item?: string | null;
  message?: string;
  detail?: string | null;
}

/** 三类筛选的当前取值（空串 = 不筛） */
interface LogFilters {
  /** 起始日期（含），`YYYY-MM-DD` */
  startDate: string;
  /** 结束日期（含），`YYYY-MM-DD` */
  endDate: string;
  /** 日志类型（后端 `log_type` 原值） */
  logType: string;
  /** 日志级别（`INFO` / `WARN` / `ERROR` / `SKIP` / `SUCCESS`） */
  level: string;
}

const EMPTY_FILTERS: LogFilters = { startDate: '', endDate: '', logType: '', level: '' };

export interface AdminLogPanelProps {
  /** 每页条数（默认 20，与旧 Admin 页一致） */
  pageSize?: number;
}

/** 拼请求参数：空筛选项**不出现**在 params 里（不是空串） */
function buildParams(filters: LogFilters, page: number, pageSize: number): Record<string, string | number> {
  const params: Record<string, string | number> = { page, page_size: pageSize };
  if (filters.logType) params.log_type = filters.logType;
  if (filters.level) params.level = filters.level;
  if (filters.startDate) params.start_date = filters.startDate;
  if (filters.endDate) params.end_date = filters.endDate;
  return params;
}

/** 取一行的文本（缺失时给空串，避免渲染出 `undefined`） */
function textOf(row: LogRow, key: string): string {
  const v = row[key as keyof LogRow];
  return v === null || v === undefined ? '' : String(v);
}

/** 视口是否窄（`<768px`）—— 渲染期 JS 判断，见文件头说明 */
function useIsNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState<boolean>(
    () => typeof window !== 'undefined' && window.innerWidth < NARROW_VIEWPORT_MAX_WIDTH,
  );

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < NARROW_VIEWPORT_MAX_WIDTH);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return narrow;
}

export default function AdminLogPanel({ pageSize = 20 }: AdminLogPanelProps) {
  const isNarrow = useIsNarrowViewport();

  const [filters, setFilters] = useState<LogFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 展开中的日志详情（`<768px` 卡片分支用；键 = 行 id 或下标） */
  const [expandedDetails, setExpandedDetails] = useState<Record<string, boolean>>({});

  /** 降级日志折叠区 */
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const [fallback, setFallback] = useState<{ exists: boolean; lines: string[] } | null>(null);
  const [fallbackLoading, setFallbackLoading] = useState(false);
  const [fallbackError, setFallbackError] = useState<string | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // 拉日志：筛选或页码变化即重查（`filters` 是对象，改任一筛选项都会换引用）
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.get('/admin/system-log', {
          params: buildParams(filters, page, pageSize),
        });
        if (cancelled) return;
        if (res.data.success) {
          setLogs(Array.isArray(res.data.data) ? (res.data.data as LogRow[]) : []);
          setTotal(res.data.pagination?.total ?? 0);
        } else {
          setError(res.data.message ?? '请求失败');
        }
      } catch (err) {
        if (!cancelled) setError(extractErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [filters, page, pageSize]);

  /** 改筛选条件 —— 同时把页码重置为第 1 页（PRD：筛选后从第一页看起） */
  const updateFilter = useCallback((patch: Partial<LogFilters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
    setPage(1);
  }, []);

  /** 展开 / 收起某条日志的详情（卡片分支） */
  const toggleDetail = useCallback((key: string) => {
    setExpandedDetails((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  /** 展开降级日志区（首次展开时才去拉取，避免每次进页面都多一个请求） */
  const toggleFallback = useCallback(async () => {
    const nextOpen = !fallbackOpen;
    setFallbackOpen(nextOpen);
    if (!nextOpen || fallback !== null) return;

    setFallbackLoading(true);
    setFallbackError(null);
    try {
      const res = await api.get('/admin/system-log/fallback');
      if (res.data.success) {
        const data = (res.data.data ?? {}) as { exists?: boolean; lines?: string[] };
        setFallback({ exists: data.exists === true, lines: data.lines ?? [] });
      } else {
        setFallbackError(res.data.message ?? '读取降级日志失败');
      }
    } catch (err) {
      setFallbackError(extractErrorMessage(err));
    } finally {
      setFallbackLoading(false);
    }
  }, [fallback, fallbackOpen]);

  const filterFieldStyle: React.CSSProperties = useMemo(
    () => ({
      display: 'flex',
      flexDirection: 'column',
      gap: SPACING.gapTight,
      minWidth: 0,
      flex: isNarrow ? '1 1 auto' : '0 0 auto',
    }),
    [isNarrow],
  );

  const filterControlStyle: React.CSSProperties = useMemo(
    () => ({ ...inputStyle, width: '100%', minWidth: 0 }),
    [],
  );

  return (
    <section aria-label="系统日志面板" style={cardStyle} data-testid="admin-log-panel">
      <h2 style={cardTitleStyle}>系统日志</h2>

      {/* 三类筛选：日期范围 / 类型 / level */}
      <div
        style={{
          display: 'flex',
          flexDirection: isNarrow ? 'column' : 'row',
          flexWrap: isNarrow ? 'nowrap' : 'wrap',
          alignItems: isNarrow ? 'stretch' : 'flex-end',
          gap: SPACING.gapBase,
          marginBottom: SPACING.gapBase,
        }}
      >
        <div style={filterFieldStyle}>
          <label
            htmlFor="admin-log-start-date"
            style={{ color: COLORS.textSecondary, fontSize: TYPO.smallSize }}
          >
            开始日期
          </label>
          <input
            id="admin-log-start-date"
            type="date"
            value={filters.startDate}
            onChange={(e) => updateFilter({ startDate: e.target.value })}
            style={filterControlStyle}
          />
        </div>

        <div style={filterFieldStyle}>
          <label
            htmlFor="admin-log-end-date"
            style={{ color: COLORS.textSecondary, fontSize: TYPO.smallSize }}
          >
            结束日期
          </label>
          <input
            id="admin-log-end-date"
            type="date"
            value={filters.endDate}
            onChange={(e) => updateFilter({ endDate: e.target.value })}
            style={filterControlStyle}
          />
        </div>

        <div style={filterFieldStyle}>
          <label htmlFor="admin-log-type" style={{ color: COLORS.textSecondary, fontSize: TYPO.smallSize }}>
            日志类型
          </label>
          <select
            id="admin-log-type"
            value={filters.logType}
            onChange={(e) => updateFilter({ logType: e.target.value })}
            style={filterControlStyle}
          >
            <option value="">全部</option>
            {Object.entries(LOG_TYPE_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <div style={filterFieldStyle}>
          <label htmlFor="admin-log-level" style={{ color: COLORS.textSecondary, fontSize: TYPO.smallSize }}>
            日志级别
          </label>
          <select
            id="admin-log-level"
            value={filters.level}
            onChange={(e) => updateFilter({ level: e.target.value })}
            style={filterControlStyle}
          >
            <option value="">全部</option>
            {LOG_LEVELS.map((lv) => (
              <option key={lv} value={lv}>
                {lv}
              </option>
            ))}
          </select>
        </div>
      </div>

      {loading && <Spinner />}

      {error && (
        <div role="alert" style={{ color: COLORS.danger, marginBottom: SPACING.gapBase }}>
          {error}
        </div>
      )}

      {!loading && !error && isNarrow && (
        /* 窄视口：卡片列表（不渲染 table —— 读屏不该把同一份内容读两遍） */
        <div data-testid="admin-log-cards">
          {logs.length === 0 ? (
            <div style={{ color: COLORS.textSecondary, padding: SPACING.gapBase }}>暂无日志</div>
          ) : (
            logs.map((row, i) => {
              const key = String(row.id ?? i);
              const expanded = expandedDetails[key] === true;
              const type = textOf(row, 'log_type');
              const level = textOf(row, 'level');
              const detail = textOf(row, 'detail');
              return (
                <div
                  key={key}
                  data-testid="admin-log-card"
                  style={{
                    border: `1px solid ${COLORS.borderLight}`,
                    borderRadius: RADIUS.md,
                    padding: SPACING.gapBase,
                    marginBottom: SPACING.gapBase,
                    minWidth: 0,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: SPACING.gapBase,
                      fontSize: TYPO.captionSize,
                      color: COLORS.textSecondary,
                    }}
                  >
                    <span>{textOf(row, 'log_date')}</span>
                    <span>{LOG_TYPE_LABEL[type] ?? type}</span>
                    <span style={{ color: LEVEL_COLOR[level] ?? COLORS.textSecondary, fontWeight: 600 }}>
                      {level}
                    </span>
                    {textOf(row, 'check_item') ? <span>{textOf(row, 'check_item')}</span> : null}
                  </div>
                  <div style={{ marginTop: SPACING.gapTight, wordBreak: 'break-all' }}>
                    {textOf(row, 'message')}
                  </div>
                  {detail ? (
                    <>
                      <button
                        type="button"
                        onClick={() => toggleDetail(key)}
                        aria-expanded={expanded}
                        aria-controls={`admin-log-detail-${key}`}
                        style={{
                          marginTop: SPACING.gapTight,
                          padding: '2px 8px',
                          fontSize: TYPO.captionSize,
                          background: 'transparent',
                          color: COLORS.brand,
                          border: `1px solid ${COLORS.brand}`,
                          borderRadius: RADIUS.sm,
                          cursor: 'pointer',
                        }}
                      >
                        {expanded ? '收起详情' : '展开详情'}
                      </button>
                      {expanded && (
                        <pre
                          id={`admin-log-detail-${key}`}
                          style={{
                            margin: `${SPACING.gapTight}px 0 0`,
                            padding: SPACING.gapBase,
                            background: COLORS.headerBg,
                            border: `1px solid ${COLORS.borderLight}`,
                            borderRadius: RADIUS.sm,
                            fontSize: TYPO.captionSize,
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-all',
                          }}
                        >
                          {detail}
                        </pre>
                      )}
                    </>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      )}

      {!loading && !error && !isNarrow && (
        /* 宽视口：表格 + 横向滚动容器（长路径不撑破文档） */
        <ScrollableTable label="系统日志表">
          <table style={tableStyle} aria-label="系统日志">
            <thead>
              <tr>
                {LOG_COLUMNS.map((col) => (
                  <th key={col.key} scope="col" style={thStyle}>
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 ? (
                <tr>
                  <td style={thTdStyle} colSpan={LOG_COLUMNS.length}>
                    暂无日志
                  </td>
                </tr>
              ) : (
                logs.map((row, i) => {
                  return (
                    <tr key={String(row.id ?? i)}>
                      {LOG_COLUMNS.map((col) => {
                        const raw = textOf(row, col.key);
                        if (col.key === 'log_type') {
                          return (
                            <td key={col.key} style={thTdStyle}>
                              {LOG_TYPE_LABEL[raw] ?? raw}
                            </td>
                          );
                        }
                        if (col.key === 'level') {
                          return (
                            <td
                              key={col.key}
                              style={{
                                ...thTdStyle,
                                color: LEVEL_COLOR[raw] ?? COLORS.textSecondary,
                                fontWeight: 600,
                              }}
                            >
                              {raw}
                            </td>
                          );
                        }
                        if (col.key === 'message' || col.key === 'detail') {
                          return (
                            <td key={col.key} style={thTdStyle}>
                              <span style={truncatedTextStyle} title={raw}>
                                {raw}
                              </span>
                            </td>
                          );
                        }
                        return (
                          <td key={col.key} style={thTdStyle}>
                            {raw}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </ScrollableTable>
      )}

      {/* 分页 */}
      <div
        style={{
          marginTop: SPACING.gapBase,
          display: 'flex',
          alignItems: 'center',
          gap: SPACING.gapBase,
          flexWrap: 'wrap',
        }}
      >
        <button
          type="button"
          style={buttonStyle}
          disabled={page <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
        >
          上一页
        </button>
        <span aria-live="polite" style={{ fontSize: TYPO.bodySize }}>
          第 {page} / {totalPages} 页，共 {total} 条
        </span>
        <button
          type="button"
          style={buttonStyle}
          disabled={page >= totalPages}
          onClick={() => setPage((p) => p + 1)}
        >
          下一页
        </button>
      </div>

      {/* 系统日志降级记录（SQLite 不可用时的兜底文件） */}
      <div style={{ marginTop: SPACING.gapRelaxed }}>
        <button
          type="button"
          onClick={() => {
            void toggleFallback();
          }}
          aria-expanded={fallbackOpen}
          aria-controls="admin-log-fallback-panel"
          style={{
            background: 'transparent',
            color: COLORS.brand,
            border: `1px solid ${COLORS.brand}`,
            borderRadius: RADIUS.sm,
            padding: '4px 10px',
            fontSize: TYPO.smallSize,
            cursor: 'pointer',
          }}
        >
          {fallbackOpen ? '收起降级日志' : '降级日志（SQLite 不可用时的兜底文件）'}
        </button>

        {fallbackOpen && (
          <div id="admin-log-fallback-panel" style={{ marginTop: SPACING.gapBase }}>
            {fallbackLoading && <Spinner />}
            {fallbackError && (
              <div role="alert" style={{ color: COLORS.danger }} data-testid="admin-log-fallback-error">
                {fallbackError}
              </div>
            )}
            {!fallbackLoading && !fallbackError && fallback && !fallback.exists && (
              <div style={{ color: COLORS.textSecondary }} data-testid="admin-log-fallback-empty">
                无降级记录
              </div>
            )}
            {!fallbackLoading &&
              !fallbackError &&
              fallback &&
              fallback.exists &&
              fallback.lines.length === 0 && (
                <div style={{ color: COLORS.textSecondary }} data-testid="admin-log-fallback-empty">
                  无降级记录
                </div>
              )}
            {!fallbackLoading &&
              !fallbackError &&
              fallback &&
              fallback.exists &&
              fallback.lines.length > 0 && (
                <pre
                  data-testid="admin-log-fallback-lines"
                  style={{
                    margin: 0,
                    padding: SPACING.gapBase,
                    maxHeight: 240,
                    overflow: 'auto',
                    background: COLORS.headerBg,
                    border: `1px solid ${COLORS.borderLight}`,
                    borderRadius: RADIUS.sm,
                    fontSize: TYPO.captionSize,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                  }}
                >
                  {fallback.lines.join('\n')}
                </pre>
              )}
          </div>
        )}
      </div>
    </section>
  );
}
