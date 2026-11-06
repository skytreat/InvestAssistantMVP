import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { isOkEnvelope } from '../api/envelope';
import { extractErrorMessage } from '../api/errors';
import { COLORS, SPACING, TYPO } from '../theme/tokens';
import { buttonStyle, cardStyle, errorStyle, pageContainerStyle, successStyle, titleStyle } from './_shared';

/**
 * BrokerReconcile.tsx —— 券商对账报告 `/broker/reconcile`（V3.8 T144/T145 · PRD_v3 §3.2/§3.3）
 *
 * 单页结构（PRD U6）：摘要（四宫格）+ 差额归因（残差置顶）+ 资金校验 + 回填统计 + 三口径 + 差异明细。
 * 补录（§3.3）：缺失/疑似行勾选 → trade_type 可改 → 整体事务确认 → 结果「成功 N / 失败 M」。
 * 权限：仅 admin（路由挂 AdminGuard，SDD_v3 §10.3）。
 */

interface Report {
  brokerCode: string;
  coveredRange: { from: string; to: string };
  coverageNote?: string;
  matchSummary: { factRows: number; matched: number; fuzzy: number; missing: number; extra: number };
  attribution: {
    repo: number;
    cashLikeEtf: number;
    dividend: number;
    offExchange: number;
    uncoveredPeriod: number;
    caliberDiff: number;
    residual: number;
    order: string[];
  };
  /** 与后端 FundCheckResult 同形（brokerFundCheck.ts），字段名不得再自造（UX-05） */
  fundCheck: {
    checked: number;
    hit: number;
    notApplicable: number;
    skippedEvents: number;
    mismatch: Array<{ id: number; category: string }>;
    scopeNote: string;
  };
  /** 待补录的非成交族事件数（转入 / 送股 / 现金分红）；后端 buildReconcileReport 提供 */
  pendingNonTrade?: number;
  timeBackfill: { matched: number; lowConfidence: number; unmatched: number };
  repoModel: {
    pairs: unknown[];
    unpairedOpens: number;
    unpairedCloses: number;
    totalInterest: number;
    impliedAnnualRate: number;
  };
  returnSummary: { risk: number; cash: number; total: number; note: string };
  generatedAt: string;
}

interface DiffRow {
  id: number;
  event_type: string;
  raw_event_type?: string;
  asset_code: string | null;
  trade_date?: string;
  trade_time?: string | null;
  price?: number | null;
  quantity?: number | null;
  amount?: number | null;
  cash_flow?: number | null;
  match_status: string;
  exclude_reason?: string | null;
  source_file?: string | null;
}

const ATTR_LABELS: Record<string, string> = {
  residual: '残差（无法解释）',
  repo: '逆回购',
  cashLikeEtf: '货币 ETF',
  dividend: '分红送股',
  offExchange: '场外/占位',
  uncoveredPeriod: '未覆盖区间',
  caliberDiff: '口径差异',
  unmatched: '缺失未匹配（成交族）',
  unknown: '未能识别',
  nonTrade: '缺失未匹配（非成交族）',
};
/** 归因数值的单位：金额类按元，caliberDiff 是失配「条数」（UX-11） */
const ATTR_UNITS: Record<string, string> = { caliberDiff: '条' };
const CATEGORIES = [
  'unmatched',
  'nonTrade',
  'repo',
  'cashLikeEtf',
  'dividend',
  'offExchange',
  'unknown',
] as const;
const CONFIRM_TYPES = ['buy', 'add', 'reduce', 'clear'] as const;
const CONFIRM_LABELS: Record<string, string> = { buy: '买入', add: '加仓', reduce: '减仓', clear: '清仓' };
/**
 * 非成交族事件 → 业务类型（与后端 brokerConfirm.FIXED_EVENT_TRADE_TYPE 对齐）。
 * 这类行的类型由系统固定推导，用户不可修正（后端只接受成交族 4 种修正值）。
 */
const NON_TRADE_TYPE_LABELS: Record<string, string> = {
  TRANSFER_IN: '转入/转增（transfer）',
  DIVIDEND_BONUS: '送股（bonus）',
  DIVIDEND_CASH: '现金分红（dividend）',
};
const MISMATCH_LABELS: Record<string, string> = {
  fee_conflict: '费用口径不符',
  dividend: '分红',
  unknown: '口径未知',
};

/** 补录候选行（从差异明细勾选） */
interface ConfirmItem {
  sourceId: number;
  tradeType?: string;
  /** 事实事件类型：非成交族按系统固定类型补录，不提供「可修正」下拉 */
  event_type: string;
  asset_code: string | null;
  trade_date?: string;
  trade_time?: string | null;
}

/** POST /broker-reconcile/confirm 的返回体（单次批量，整体事务） */
interface ConfirmBatchResult {
  brokerCode: string;
  imported: number;
  already: number;
  invalid: number;
  rows: Array<{ sourceId: number; status: string; tradeType: string | null; reason?: string }>;
}

/** 一键补录（多批次）聚合结果：单个请求仍是整体事务，跨批可能部分成功 */
interface OneClickResult {
  imported: number;
  already: number;
  invalid: number;
  failedBatches: number;
  errors: string[];
  rows: ConfirmBatchResult['rows'];
}

/** 单次 confirm 请求的条数上限（与后端一致，超过必须分批） */
const CONFIRM_BATCH_LIMIT = 500;
/** 拉取待补录清单时每页条数（与 /diff 的 pageSize 上限一致） */
const PENDING_PAGE_SIZE = 200;

export default function BrokerReconcile() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const brokerCode = params.get('brokerCode') ?? '';
  const [brokerOptions, setBrokerOptions] = useState<Array<{ code: string; label: string }>>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // ── 差异明细 ──
  const [category, setCategory] = useState<string>('unmatched');
  const [diffRows, setDiffRows] = useState<DiffRow[]>([]);
  const [diffTotal, setDiffTotal] = useState(0);
  /** 差异查询失败必须显式上报，不能静默显示成「无」（UX-01 同类信任缺陷） */
  const [diffError, setDiffError] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  // ── 补录对话框（T145）──
  const [selected, setSelected] = useState<Map<number, ConfirmItem>>(new Map());
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmResult, setConfirmResult] = useState<ConfirmBatchResult | null>(null);

  // ── 一键全部补录（非成交族，仍为显式人工确认）──
  const [oneClickPlan, setOneClickPlan] = useState<{ items: ConfirmItem[]; fuzzyCount: number } | null>(null);
  const [oneClickBusy, setOneClickBusy] = useState(false);
  const [oneClickResult, setOneClickResult] = useState<OneClickResult | null>(null);

  /** 券商下拉 = 「已导入过流水的券商」，排除已撤销批次与未识别编码，标签带批次文件名（Q8） */
  useEffect(() => {
    api
      .get('/broker-import/batches')
      .then((res) => {
        if (isOkEnvelope(res.data)) {
          type BatchLite = {
            broker_code?: string | null;
            file_name?: string | null;
            status?: string | null;
            created_at?: string | null;
          };
          const batches = (res.data.data as { batches?: BatchLite[] }).batches ?? [];
          const latestByCode = new Map<string, { label: string; createdAt: string }>();
          for (const b of batches) {
            const code = (b.broker_code ?? '').trim();
            if (!code || code === '未识别' || b.status === 'revoked') continue;
            const createdAt = b.created_at ?? '';
            const prev = latestByCode.get(code);
            const label = b.file_name ? `${code}（${b.file_name}）` : code;
            if (!prev || createdAt > prev.createdAt) latestByCode.set(code, { label, createdAt });
          }
          setBrokerOptions(
            [...latestByCode.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([code, v]) => ({ code, label: v.label })),
          );
        }
      })
      .catch(() => undefined);
  }, []);

  const loadReport = useCallback(async (bc: string): Promise<boolean> => {
    if (!bc) return false;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/broker-reconcile/latest', { params: { brokerCode: bc } });
      if (isOkEnvelope(res.data)) {
        setReport(res.data.data as Report);
        return true;
      }
      // 切换券商 / 无数据时**必须清空旧报告**，否则会残留上一个券商的数字（UX-01）
      setReport(null);
      setError(String(res.data?.message ?? '无对账报告'));
      return false;
    } catch (e) {
      setReport(null);
      setError(extractErrorMessage(e, '加载对账报告失败'));
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDiff = useCallback(async (bc: string, cat: string, p: number) => {
    if (!bc) return;
    setDiffError(null);
    try {
      const res = await api.get('/broker-reconcile/diff', {
        params: { brokerCode: bc, category: cat, page: p, pageSize: 50 },
      });
      if (isOkEnvelope(res.data)) {
        setDiffRows((res.data.data as { rows: DiffRow[] }).rows);
        setDiffTotal((res.data as { data: unknown; pagination?: { total?: number } }).pagination?.total ?? 0);
      } else {
        setDiffRows([]);
        setDiffTotal(0);
        setDiffError(String(res.data?.message ?? '后端返回失败'));
      }
    } catch (e) {
      setDiffRows([]);
      setDiffTotal(0);
      setDiffError(extractErrorMessage(e, '差异明细加载失败'));
    }
  }, []);

  // 切换券商：清空上一个券商的状态（报告 / 差异 / 勾选 / 提示），避免旧数据残留
  useEffect(() => {
    setReport(null);
    setError(null);
    setNotice(null);
    setDiffRows([]);
    setDiffTotal(0);
    setDiffError(null);
    setSelected(new Map());
    setOneClickPlan(null);
    setOneClickResult(null);
  }, [brokerCode]);

  useEffect(() => {
    void loadReport(brokerCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brokerCode]);

  useEffect(() => {
    if (brokerCode) void loadDiff(brokerCode, category, page);
  }, [brokerCode, category, page, loadDiff]);

  /** 触发一次对账（重算去重/回填/归因，幂等） */
  const runReconcile = async () => {
    if (!brokerCode) {
      setError('请先选择券商');
      return;
    }
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.post('/broker-reconcile/run', { brokerCode });
      if (!isOkEnvelope(res.data)) {
        setError(String(res.data?.message ?? '重新对账失败'));
        return;
      }
      const ok = await loadReport(brokerCode);
      if (ok) setNotice('对账已刷新');
    } catch (e) {
      setError(extractErrorMessage(e, '重新对账失败'));
    } finally {
      setLoading(false);
    }
  };

  /** 勾选/取消补录候选（成交族与「未补录的非成交族」均可补录） */
  const toggleSelect = (row: DiffRow, checked: boolean) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (checked)
        next.set(row.id, {
          sourceId: row.id,
          event_type: row.event_type,
          asset_code: row.asset_code,
          trade_date: row.trade_date,
          trade_time: row.trade_time,
        });
      else next.delete(row.id);
      return next;
    });
  };

  /** 当前分类是否允许勾选补录（成交族缺失 + 非成交族缺失） */
  const confirmable = category === 'unmatched' || category === 'nonTrade';

  /**
   * 行是否可勾选：
   * - 成交族：必须有股数与标的；
   * - 非成交族：**有股数或有现金流**即可 —— 现金分红常无股数（quantity=0），只给发生金额。
   */
  const isSelectable = useCallback(
    (r: DiffRow): boolean => {
      if (r.match_status !== 'MISSING' || !r.asset_code) return false;
      if (category === 'nonTrade') {
        return (r.quantity ?? 0) > 0 || (r.cash_flow ?? 0) > 0 || (r.amount ?? 0) > 0;
      }
      return Boolean(r.quantity);
    },
    [category],
  );

  /** T151③：当前页可补录行 */
  const selectableRows = useMemo(() => diffRows.filter(isSelectable), [diffRows, isSelectable]);
  const allSelected = selectableRows.length > 0 && selectableRows.every((r) => selected.has(r.id));
  const someSelected = !allSelected && selectableRows.some((r) => selected.has(r.id));

  /** T151③：全选 / 取消全选（当前页） */
  const toggleSelectAll = (checked: boolean) => {
    setSelected((prev) => {
      const next = new Map(prev);
      for (const r of selectableRows) {
        if (checked)
          next.set(r.id, {
            sourceId: r.id,
            event_type: r.event_type,
            asset_code: r.asset_code,
            trade_date: r.trade_date,
            trade_time: r.trade_time,
          });
        else next.delete(r.id);
      }
      return next;
    });
  };

  /** 确认补录（整体事务；失败全回滚，PRD §3.3.1） */
  const confirmSupplement = async () => {
    setConfirmBusy(true);
    setConfirmResult(null);
    try {
      const items = [...selected.values()].map((x) =>
        x.tradeType ? { sourceId: x.sourceId, tradeType: x.tradeType } : { sourceId: x.sourceId },
      );
      const res = await api.post('/broker-reconcile/confirm', { brokerCode, items });
      if (isOkEnvelope(res.data)) {
        const r = res.data.data as typeof confirmResult;
        setConfirmResult(r);
        setSelected(new Map());
        // U12：补录后自动重跑对账并提示
        await loadReport(brokerCode);
        void loadDiff(brokerCode, category, page);
      } else {
        setConfirmResult(null);
        setError(String(res.data?.message ?? '补录失败'));
      }
    } catch (e) {
      setError(extractErrorMessage(e, '补录失败'));
    } finally {
      setConfirmBusy(false);
    }
  };

  /**
   * 非成交族可补录判据（与行级 checkbox 的 nonTrade 分支一致，但不依赖当前分类）：
   * 状态 MISSING 且「有股数或有现金流/金额」——现金分红常无股数。
   * 缺标的（asset_code=null）的行也纳入，交由后端逐条返回不可补原因。
   */
  const isNonTradeCandidate = (r: DiffRow): boolean =>
    r.match_status === 'MISSING' && ((r.quantity ?? 0) > 0 || (r.cash_flow ?? 0) > 0 || (r.amount ?? 0) > 0);

  /** 翻页拉全「待补录的非成交族」清单（不受当前分页/分类影响） */
  const fetchPendingNonTrade = async (bc: string): Promise<{ items: ConfirmItem[]; fuzzyCount: number }> => {
    const items: ConfirmItem[] = [];
    let fuzzyCount = 0;
    let pageNo = 1;
    let total = Number.POSITIVE_INFINITY;
    // 上限兜底，避免后端 total 异常导致死循环
    while (pageNo <= 100 && (pageNo - 1) * PENDING_PAGE_SIZE < total) {
      const res = await api.get('/broker-reconcile/diff', {
        params: { brokerCode: bc, category: 'nonTrade', page: pageNo, pageSize: PENDING_PAGE_SIZE },
      });
      if (!isOkEnvelope(res.data)) {
        throw new Error(String(res.data?.message ?? '待补录清单加载失败'));
      }
      const rows = (res.data.data as { rows?: DiffRow[] }).rows ?? [];
      total = (res.data as { pagination?: { total?: number } }).pagination?.total ?? rows.length;
      for (const r of rows) {
        if (r.match_status === 'FUZZY') {
          fuzzyCount += 1;
          continue; // 疑似匹配需逐条人工确认，不进一键队列
        }
        if (isNonTradeCandidate(r)) {
          items.push({
            sourceId: r.id,
            event_type: r.event_type,
            asset_code: r.asset_code,
            trade_date: r.trade_date,
            trade_time: r.trade_time,
          });
        }
      }
      if (rows.length === 0) break;
      pageNo += 1;
    }
    return { items, fuzzyCount };
  };

  /** 点「一键全部补录」→ 先拉全清单，弹显式确认框（不直接写库） */
  const openOneClick = async () => {
    if (!brokerCode || oneClickBusy) return;
    setOneClickBusy(true);
    setOneClickResult(null);
    setError(null);
    try {
      const plan = await fetchPendingNonTrade(brokerCode);
      if (plan.items.length === 0) {
        setOneClickPlan(null);
        setNotice(
          plan.fuzzyCount > 0
            ? `没有可直接补录的非成交事件；${plan.fuzzyCount} 笔疑似匹配需逐条人工确认`
            : '没有可直接补录的非成交事件',
        );
        return;
      }
      setOneClickPlan(plan);
    } catch (e) {
      setError(extractErrorMessage(e, '待补录清单加载失败'));
    } finally {
      setOneClickBusy(false);
    }
  };

  /**
   * 确认后按 CONFIRM_BATCH_LIMIT 分批提交（复用 /broker-reconcile/confirm）：
   * - 每批一个整体事务（后端保证），跨批可能部分成功
   * - 某批失败不回滚其他批，逐批记录原因并继续，最终汇总「成功 / 已存在 / 不可补 / 失败批次」
   */
  const runOneClick = async () => {
    if (!oneClickPlan || oneClickBusy) return;
    const items = oneClickPlan.items;
    setOneClickBusy(true);
    const agg: OneClickResult = {
      imported: 0,
      already: 0,
      invalid: 0,
      failedBatches: 0,
      errors: [],
      rows: [],
    };
    try {
      for (let i = 0; i < items.length; i += CONFIRM_BATCH_LIMIT) {
        const batch = items.slice(i, i + CONFIRM_BATCH_LIMIT);
        const batchNo = Math.floor(i / CONFIRM_BATCH_LIMIT) + 1;
        try {
          const res = await api.post('/broker-reconcile/confirm', {
            brokerCode,
            items: batch.map((x) =>
              x.tradeType ? { sourceId: x.sourceId, tradeType: x.tradeType } : { sourceId: x.sourceId },
            ),
          });
          if (!isOkEnvelope(res.data)) {
            agg.failedBatches += 1;
            agg.errors.push(`第 ${batchNo} 批：${String(res.data?.message ?? '后端返回失败')}`);
            continue;
          }
          const r = res.data.data as ConfirmBatchResult;
          agg.imported += r.imported;
          agg.already += r.already;
          agg.invalid += r.invalid;
          agg.rows.push(...r.rows);
        } catch (e) {
          agg.failedBatches += 1;
          agg.errors.push(`第 ${batchNo} 批：${extractErrorMessage(e, '请求失败')}`);
        }
      }
      setOneClickResult(agg);
      setOneClickPlan(null);
      setSelected(new Map());
      setNotice(
        agg.failedBatches > 0
          ? `一键补录完成：成功 ${agg.imported} 条，${agg.failedBatches} 批失败（可重试，不会重复写入）`
          : `一键补录完成：成功 ${agg.imported} 条`,
      );
      // 刷新报告与分类计数：待补录归零后按钮自然消失，避免重复点击
      await loadReport(brokerCode);
      void loadDiff(brokerCode, category, page);
    } finally {
      setOneClickBusy(false);
    }
  };

  /** 标记「已手工记录」（不写业务层，仅事实层 match_status=MATCHED） */
  const markManuallyRecorded = async (factId: number) => {
    try {
      const res = await api.post(`/broker-reconcile/diff/${factId}/match`, {});
      if (isOkEnvelope(res.data)) {
        void loadReport(brokerCode);
        void loadDiff(brokerCode, category, page);
      } else {
        setError(String(res.data?.message ?? '标记失败'));
      }
    } catch (e) {
      setError(extractErrorMessage(e, '标记失败'));
    }
  };

  /** 一键补录确认框的构成统计（按事件类型） */
  const oneClickComposition = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of oneClickPlan?.items ?? []) {
      counts.set(it.event_type, (counts.get(it.event_type) ?? 0) + 1);
    }
    return [...counts.entries()];
  }, [oneClickPlan]);

  const attrRows = useMemo(() => {
    if (!report) return [] as Array<{ key: string; label: string; value: number; highlight: boolean }>;
    return report.attribution.order.map((k) => ({
      key: k,
      label: ATTR_LABELS[k] ?? k,
      value: report.attribution[k as keyof Report['attribution']] as number,
      // 残差非 0 → 醒目置顶（order[0] 已置顶；红字强化）
      highlight: k === 'residual' && report.attribution.residual !== 0,
    }));
  }, [report]);

  return (
    <div style={pageContainerStyle}>
      <h1 style={titleStyle}>券商对账</h1>

      <div style={{ ...cardStyle, marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: SPACING.gapRelaxed, alignItems: 'center', flexWrap: 'wrap' }}>
          <label>
            <span style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary }}>券商：</span>
            <select
              style={{ marginLeft: 8 }}
              value={brokerCode}
              onChange={(e) => setParams({ brokerCode: e.target.value })}
            >
              <option value="">（选择）</option>
              {/* 当前编码不在选项里（如 URL 里带了刚撤销的批次）时仍保留可见，避免选择框空白 */}
              {brokerCode !== '' && !brokerOptions.some((o) => o.code === brokerCode) && (
                <option value={brokerCode}>{brokerCode}（当前）</option>
              )}
              {brokerOptions.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <button style={buttonStyle} onClick={() => void runReconcile()} disabled={loading}>
            重新对账
          </button>
          <button
            style={{ ...buttonStyle, background: COLORS.brand, color: '#fff', border: 'none' }}
            onClick={() => navigate(`/broker/import?brokerCode=${encodeURIComponent(brokerCode)}`)}
          >
            导入文件
          </button>
          {loading && <span style={{ fontSize: TYPO.smallSize, color: COLORS.textMuted }}>处理中…</span>}
        </div>
        {report && (
          <div style={{ marginTop: 8, fontSize: TYPO.smallSize, color: COLORS.textMuted }}>
            覆盖区间 {report.coveredRange.from} ~ {report.coveredRange.to}
            {report.coverageNote ? `（${report.coverageNote}）` : ''} · 生成于{' '}
            {new Date(report.generatedAt).toLocaleString()}
          </div>
        )}
        {notice && (
          <p style={successStyle} role="status">
            {notice}
          </p>
        )}
        {error && (
          <p style={errorStyle} role="alert">
            {error}
          </p>
        )}
      </div>

      {report && (
        <>
          {/* 防复发提示：非成交事件（转入/送股/分红）永远依赖人工补录，必须给出可见入口 */}
          {(report.pendingNonTrade ?? 0) > 0 && (
            <div
              data-testid="non-trade-pending"
              role="status"
              style={{
                ...warningBar,
                marginBottom: 16,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <span>
                有 {report.pendingNonTrade} 笔非成交事件（转入 / 送股 / 现金分红）尚未补录到交易记录
              </span>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button
                  data-testid="one-click-backfill"
                  style={{ ...buttonStyle, padding: '2px 8px', fontSize: TYPO.captionSize }}
                  onClick={() => void openOneClick()}
                  disabled={oneClickBusy}
                >
                  {oneClickBusy ? '统计中…' : `一键全部补录（${report.pendingNonTrade} 笔）`}
                </button>
                <button
                  style={{ ...buttonStyle, padding: '2px 8px', fontSize: TYPO.captionSize }}
                  onClick={() => {
                    setCategory('nonTrade');
                    setPage(1);
                  }}
                >
                  去补录（{report.pendingNonTrade} 笔）
                </button>
              </div>
            </div>
          )}

          {/* 一键补录：显式确认框（列出条数与构成，确认后才发请求） */}
          {oneClickPlan && (
            <div
              data-testid="one-click-dialog"
              role="dialog"
              aria-label="一键补录确认"
              style={{ ...cardStyle, marginBottom: 16, border: `1px solid ${COLORS.brand}` }}
            >
              <h3 style={subtitleStyle}>一键补录：{oneClickPlan.items.length} 笔</h3>
              <div style={{ fontSize: TYPO.smallSize }}>
                构成：
                {oneClickComposition
                  .map(([type, n]) => `${NON_TRADE_TYPE_LABELS[type] ?? type} ${n} 笔`)
                  .join(' · ')}
              </div>
              {oneClickPlan.fuzzyCount > 0 && (
                <div style={{ fontSize: TYPO.captionSize, color: COLORS.textSecondary, marginTop: 4 }}>
                  另有 {oneClickPlan.fuzzyCount} 笔疑似匹配（FUZZY）未纳入一键补录，请逐条人工确认
                </div>
              )}
              <p style={{ ...warningBar, margin: '8px 0' }}>
                将写入你的交易记录（可撤销：业务层软删、事实层保留）。仍需你点「确认补录」才会发请求，不会静默写库。
              </p>
              <div style={{ display: 'flex', gap: 12 }}>
                <button
                  style={{ ...buttonStyle, background: COLORS.brand, color: '#fff', border: 'none' }}
                  onClick={() => void runOneClick()}
                  disabled={oneClickBusy}
                >
                  确认补录（{oneClickPlan.items.length} 笔）
                </button>
                <button style={buttonStyle} onClick={() => setOneClickPlan(null)} disabled={oneClickBusy}>
                  取消
                </button>
              </div>
            </div>
          )}

          {/* 一键补录结果：部分失败必须逐条可见，不能只报「成功 N」 */}
          {oneClickResult && (
            <div data-testid="one-click-result" style={{ ...cardStyle, marginBottom: 16 }}>
              <h3 style={subtitleStyle}>一键补录结果</h3>
              <div style={{ fontSize: TYPO.smallSize }}>
                成功 {oneClickResult.imported} · 已存在 {oneClickResult.already} · 不可补{' '}
                {oneClickResult.invalid} · 失败批次 {oneClickResult.failedBatches}
              </div>
              {oneClickResult.errors.map((msg) => (
                <div key={msg} style={{ color: COLORS.danger, fontSize: TYPO.captionSize }}>
                  {msg}
                </div>
              ))}
              {oneClickResult.rows
                .filter((r) => r.status === 'invalid' || r.status === 'manual_sheet')
                .slice(0, 10)
                .map((r) => (
                  <div key={r.sourceId} style={{ color: COLORS.danger, fontSize: TYPO.captionSize }}>
                    #{r.sourceId}：{r.reason ?? r.status}
                  </div>
                ))}
            </div>
          )}

          {/* 摘要四宫格 */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
              gap: 12,
              marginBottom: 16,
            }}
          >
            <SummaryCard label="事实行" value={report.matchSummary.factRows} />
            <SummaryCard
              label="已匹配"
              value={report.matchSummary.matched}
              tone="success"
              hint={`含疑似 ${report.matchSummary.fuzzy}`}
            />
            <SummaryCard label="缺失（可补录）" value={report.matchSummary.missing} tone="warning" />
            <SummaryCard label="多余" value={report.matchSummary.extra} />
          </div>

          {/* 差额归因（残差置顶） */}
          <div style={{ ...cardStyle, marginBottom: 16 }}>
            <h2 style={subtitleStyle}>差额归因</h2>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>归因项</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>数值</th>
                  <th style={thStyle}>单位</th>
                </tr>
              </thead>
              <tbody>
                {attrRows.map((r) => (
                  <tr key={r.key} style={r.highlight ? { color: COLORS.danger, fontWeight: 600 } : undefined}>
                    <td style={tdStyle}>
                      {r.label}
                      {r.highlight ? ' ⚠' : ''}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>{r.value}</td>
                    <td style={{ ...tdStyle, color: COLORS.textMuted }}>{ATTR_UNITS[r.key] ?? '元'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 资金校验 + 回填 + 逆回购 + 三口径 */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 12,
              marginBottom: 16,
            }}
          >
            <div style={cardStyle}>
              <h3 style={subtitleStyle}>资金校验（行内自洽）</h3>
              <div style={{ fontSize: TYPO.smallSize }}>
                校验范围 {report.fundCheck.checked} 行 · 公式命中 {report.fundCheck.hit} · 不适用{' '}
                {report.fundCheck.notApplicable} · 范围外 {report.fundCheck.skippedEvents} · 失配{' '}
                {report.fundCheck.mismatch.length}
              </div>
              {report.fundCheck.mismatch.length > 0 && (
                <div style={{ fontSize: TYPO.captionSize, color: COLORS.textSecondary, marginTop: 4 }}>
                  失配分类：
                  {(['fee_conflict', 'dividend', 'unknown'] as const)
                    .map(
                      (c) =>
                        `${MISMATCH_LABELS[c]} ${report.fundCheck.mismatch.filter((m) => m.category === c).length}`,
                    )
                    .join(' · ')}
                </div>
              )}
              <div style={{ fontSize: TYPO.captionSize, color: COLORS.textMuted, marginTop: 4 }}>
                {report.fundCheck.scopeNote}
              </div>
            </div>
            <div style={cardStyle}>
              <h3 style={subtitleStyle}>成交时间回填</h3>
              <div style={{ fontSize: TYPO.smallSize }}>
                命中 {report.timeBackfill.matched} · 低置信 {report.timeBackfill.lowConfidence} · 未匹配{' '}
                {report.timeBackfill.unmatched}
              </div>
            </div>
            <div style={cardStyle}>
              <h3 style={subtitleStyle}>逆回购（§7.1）</h3>
              <div style={{ fontSize: TYPO.smallSize }}>
                配对 {report.repoModel.pairs.length} 对
                <br />
                利息合计 {report.repoModel.totalInterest.toFixed(2)} 元
                <br />
                隐含年化 {report.repoModel.impliedAnnualRate}%
                <br />
                在途未平仓 {report.repoModel.unpairedOpens} 笔
                <br />
                数据不全 {report.repoModel.unpairedCloses} 笔
              </div>
            </div>
            <div style={cardStyle}>
              <h3 style={subtitleStyle}>收益（占位口径，完整见「收益」页）</h3>
              <div style={{ fontSize: TYPO.smallSize }}>
                风险类 {report.returnSummary.risk} 元 · 现金类 {report.returnSummary.cash} 元 · 合计{' '}
                {report.returnSummary.total} 元
                <div style={{ color: COLORS.textMuted, marginTop: 4 }}>{report.returnSummary.note}</div>
              </div>
            </div>
          </div>

          {/* 差异明细 + 补录 */}
          <div style={{ ...cardStyle, marginBottom: 16 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 8,
              }}
            >
              <h2 style={subtitleStyle}>差异明细（{diffTotal}）</h2>
              <select
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value);
                  setPage(1);
                }}
                style={{ fontSize: TYPO.smallSize }}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {ATTR_LABELS[c] ?? c}
                  </option>
                ))}
              </select>
            </div>
            {category === 'nonTrade' && (
              <p
                data-testid="non-trade-note"
                style={{ fontSize: TYPO.captionSize, color: COLORS.textSecondary, margin: '6px 0 8px' }}
              >
                <strong>转入（转增）/ 送股 / 现金分红</strong>
                ，不是未知成交：勾选后按 transfer / bonus / dividend
                补录；现金分红可能没有股数，按分红金额补录。
              </p>
            )}
            {diffError !== null && (
              <p style={{ ...errorStyle, display: 'flex', alignItems: 'center', gap: 8 }} role="alert">
                差异明细加载失败：{diffError}
                <button
                  style={{ ...buttonStyle, padding: '2px 8px', fontSize: TYPO.captionSize }}
                  onClick={() => void loadDiff(brokerCode, category, page)}
                >
                  重试
                </button>
              </p>
            )}
            <table style={tableStyle}>
              <thead>
                <tr>
                  {confirmable && (
                    <th style={thStyle}>
                      补录
                      {/* T151③：全选当前页可补录行（全选/部分 → indeterminate） */}
                      <input
                        type="checkbox"
                        aria-label="全选本页可补录"
                        checked={allSelected}
                        ref={(el) => {
                          if (el) el.indeterminate = someSelected;
                        }}
                        onChange={(e) => toggleSelectAll(e.target.checked)}
                        style={{ marginLeft: 6 }}
                      />
                    </th>
                  )}
                  <th style={thStyle}>id</th>
                  <th style={thStyle}>事件</th>
                  <th style={thStyle}>标的</th>
                  <th style={thStyle}>日期</th>
                  <th style={thStyle}>数量</th>
                  <th style={thStyle}>金额</th>
                  <th style={thStyle}>状态</th>
                  <th style={thStyle}>排除原因</th>
                  <th style={thStyle}>操作</th>
                </tr>
              </thead>
              <tbody>
                {diffRows.map((r) => (
                  <tr key={r.id}>
                    {confirmable && r.match_status === 'MISSING' ? (
                      <td style={tdStyle}>
                        <input
                          type="checkbox"
                          checked={selected.has(r.id)}
                          onChange={(e) => toggleSelect(r, e.target.checked)}
                          disabled={!isSelectable(r)}
                        />
                      </td>
                    ) : confirmable ? (
                      <td style={tdStyle} />
                    ) : null}
                    <td style={tdStyle}>{r.id}</td>
                    <td style={tdStyle}>{r.raw_event_type ?? r.event_type}</td>
                    <td style={tdStyle}>{r.asset_code ?? '—'}</td>
                    <td style={tdStyle}>
                      {r.trade_date ?? '—'}
                      {r.trade_time ? ` ${r.trade_time}` : ''}
                      {r.trade_date && !r.trade_time && (
                        <span
                          title="无成交时间（留空不填假时间，INV-S2-36）"
                          style={{ color: COLORS.textMuted }}
                        >
                          {' '}
                          ⏱
                        </span>
                      )}
                    </td>
                    <td style={tdStyle}>{r.quantity ?? '—'}</td>
                    <td style={tdStyle}>{r.amount ?? r.cash_flow ?? '—'}</td>
                    <td style={tdStyle}>{r.match_status}</td>
                    <td style={tdStyle}>{r.exclude_reason ?? ''}</td>
                    <td style={tdStyle}>
                      {r.match_status === 'MISSING' && (
                        <button
                          style={{ ...buttonStyle, padding: '2px 8px', fontSize: TYPO.captionSize }}
                          onClick={() => void markManuallyRecorded(r.id)}
                        >
                          已手工记录
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {diffRows.length === 0 && (
                  <tr>
                    <td colSpan={10} style={{ ...tdStyle, color: COLORS.textMuted }}>
                      {diffError !== null ? '加载失败（可点上方重试）' : '无'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            {diffTotal > 50 && (
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  marginTop: 8,
                  alignItems: 'center',
                  fontSize: TYPO.smallSize,
                }}
              >
                <button style={buttonStyle} disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  上一页
                </button>
                {page}/{Math.ceil(diffTotal / 50)}
                <button
                  style={buttonStyle}
                  disabled={page * 50 >= diffTotal}
                  onClick={() => setPage((p) => p + 1)}
                >
                  下一页
                </button>
              </div>
            )}

            {/* 补录对话框（PRD §3.3：勾选 + trade_type 可改 + 提示 + 批量结果） */}
            {selected.size > 0 && (
              <div style={{ ...cardStyle, marginTop: 12, border: `1px solid ${COLORS.brand}` }}>
                <h3 style={subtitleStyle}>补录：{selected.size} 笔</h3>
                <p style={{ ...warningBar, margin: '4px 0 8px' }}>
                  这将写入你的交易记录，可撤销（业务层软删，事实层保留）
                </p>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={thStyle}>事实行</th>
                      <th style={thStyle}>标的</th>
                      <th style={thStyle}>日期</th>
                      <th style={thStyle}>推导类型</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...selected.values()].map((x) => (
                      <tr key={x.sourceId}>
                        <td style={tdStyle}>#{x.sourceId}</td>
                        <td style={tdStyle}>{x.asset_code ?? '—'}</td>
                        <td style={tdStyle}>{x.trade_date ?? '—'}</td>
                        <td style={tdStyle}>
                          {NON_TRADE_TYPE_LABELS[x.event_type] ? (
                            // 非成交族类型由系统固定推导（后端不接受成交族 4 种以外的修正值）
                            <span data-testid={`fixed-type-${x.sourceId}`}>
                              {NON_TRADE_TYPE_LABELS[x.event_type]}
                            </span>
                          ) : (
                            <select
                              value={x.tradeType ?? ''}
                              onChange={(e) => {
                                const next = new Map(selected);
                                next.set(x.sourceId, { ...x, tradeType: e.target.value || undefined });
                                setSelected(next);
                              }}
                              style={{ fontSize: TYPO.smallSize }}
                            >
                              <option value="">自动推导</option>
                              {CONFIRM_TYPES.map((t) => (
                                <option key={t} value={t}>
                                  {CONFIRM_LABELS[t] ?? t}
                                </option>
                              ))}
                            </select>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ marginTop: 10, display: 'flex', gap: 12 }}>
                  <button
                    style={{ ...buttonStyle, background: COLORS.brand, color: '#fff', border: 'none' }}
                    onClick={() => void confirmSupplement()}
                    disabled={confirmBusy}
                  >
                    全部补录（{selected.size} 笔）
                  </button>
                  <button style={buttonStyle} onClick={() => setSelected(new Map())} disabled={confirmBusy}>
                    取消
                  </button>
                </div>
              </div>
            )}

            {confirmResult && (
              <div style={{ ...cardStyle, marginTop: 12 }}>
                <h3 style={subtitleStyle}>补录结果</h3>
                <div style={{ fontSize: TYPO.smallSize }}>
                  成功 {confirmResult.imported} · 已存在 {confirmResult.already} · 不可补{' '}
                  {confirmResult.invalid}（整体事务，失败全回滚）
                </div>
                {confirmResult.rows
                  .filter((r) => r.status === 'invalid' || r.status === 'manual_sheet')
                  .slice(0, 5)
                  .map((r) => (
                    <div key={r.sourceId} style={{ color: COLORS.danger, fontSize: TYPO.captionSize }}>
                      #{r.sourceId}：{r.reason ?? r.status}
                    </div>
                  ))}
              </div>
            )}
          </div>
        </>
      )}

      {!report && !loading && brokerCode && (
        <div style={cardStyle}>
          <p style={{ color: COLORS.textMuted }}>
            该券商暂无对账数据。请先在「券商文件导入」完成导入并确认落库（撤销的批次不计入）；导入成功后再点「重新对账」。
          </p>
          <button
            style={{ ...buttonStyle, background: COLORS.brand, color: '#fff', border: 'none' }}
            onClick={() => navigate(`/broker/import?brokerCode=${encodeURIComponent(brokerCode)}`)}
          >
            去导入文件
          </button>
        </div>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: number;
  tone?: 'success' | 'warning';
  hint?: string;
}) {
  const color =
    tone === 'success' ? COLORS.success : tone === 'warning' ? COLORS.warning : COLORS.textPrimary;
  return (
    <div style={{ ...cardStyle, textAlign: 'center' }}>
      <div style={{ fontSize: TYPO.h1Size, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: TYPO.captionSize, color: COLORS.textMuted }}>{label}</div>
      {hint && <div style={{ fontSize: TYPO.captionSize, color: COLORS.textMuted }}>{hint}</div>}
    </div>
  );
}

const subtitleStyle: React.CSSProperties = {
  fontSize: TYPO.cardTitleSize,
  fontWeight: 600,
  margin: '0 0 8px',
};
const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: TYPO.smallSize,
};
const thStyle: React.CSSProperties = {
  textAlign: 'left',
  borderBottom: `1px solid ${COLORS.borderLight}`,
  padding: '4px 8px',
  color: COLORS.textSecondary,
};
const tdStyle: React.CSSProperties = {
  borderBottom: `1px solid ${COLORS.borderLight}`,
  padding: '4px 8px',
  verticalAlign: 'top',
};
const warningBar: React.CSSProperties = {
  background: COLORS.bgPillWarning,
  color: COLORS.textWarning,
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: TYPO.captionSize,
};
