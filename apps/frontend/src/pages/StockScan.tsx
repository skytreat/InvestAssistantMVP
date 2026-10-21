import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { isOkEnvelope } from '../api/envelope';
import { extractErrorMessageOrString } from '../api/errors';
import { COLORS, SPACING, TYPO } from '../theme/tokens';
import PluginParamForm, {
  defaultParamsFromSchema,
  validateParamValues,
  type ParamField,
} from '../components/PluginParamForm';
import ScrollableTable from '../components/ScrollableTable';
import {
  cardStyle,
  cardTitleStyle,
  formRowStyle,
  labelStyle,
  inputStyle,
  buttonStyle,
  tableStyle,
  thStyle,
  thTdStyle,
  titleStyle,
  pageContainerStyle,
  errorStyle,
  successStyle,
} from './_shared';

/**
 * 条件选股页（T73 · StockScan 全量重写）
 *
 * ## 本页对应的缺口（`docs/audit/gap-list-2026-10-17.md` §5.6）
 *
 * | 缺口 | 内容 | 本页落点 |
 * |---|---|---|
 * | F-S1 | 公共过滤缺 标的类型 / 排除 ST / 行业 | 「公共过滤」卡片（见下方「F-S1」）|
 * | F-S2 | 参数输入是裸 JSON textarea | `components/PluginParamForm.tsx`（schema 驱动，与设置页共用）|
 * | F-S3 | 「结果 ≤100」未强制，UI 允许到 500 | `MAX_RESULTS = 100`（常量，不可调）|
 * | F-S4 | 无批量加入候选池 | 勾选 + 全选 + 批量按钮 → `POST /api/candidates/batch`（T56 已有接口）|
 * | F-S5 | 结果表缺 名称/现价/涨跌幅/成交额 + 无分页 | 结果表列 + 前端分页 |
 * | 附带缺陷 | 409 判断在成功分支（axios 对 409 走 reject）| `addCandidate` 的 catch 分支里判 409 |
 *
 * ## F-S1 · 公共过滤（口径与后端 `routes/stockscan.ts` 的 `parseScanFilters` 一一对应）
 *
 * | 前端控件 | 接口参数 | 单位 / 取值 |
 * |---|---|---|
 * | 标的类型 | `asset_type` | `stock` / `etf` / `all`（后端白名单 `ASSET_TYPES`）|
 * | 排除 ST | `exclude_st` | boolean |
 * | 最低成交额 | `min_amount` | **后端口径是「元」**（`raw_kline_daily.amount` 单位为元）|
 * | 总市值上限 | `market_cap_max` | 亿元（后端 `market_cap_max * 1e8` 与 `totalmv` 比较）|
 * | 行业 | `industry_code` | 🔴 **不可用**（见下）|
 *
 * ⚠️ **成交额单位换算**：界面用「万元」（用户友好），后端 `min_amount` 比的是**元**
 *    （`buildPoolQuery` 里 `k.amount >= ?`，`amount` 存元）。
 *    ⇒ 前端提交前 **× 10000**。改动前界面写「万元」而后端按「元」比，
 *    实际放行了 1 万倍的成交额 —— 本页已修正这个口径错位。
 *
 * 🔴 **行业过滤为什么 disabled**（T85b ④ / I-22 实测）：
 *    `raw_tdx_blocks_info` 与 `raw_tdx_blocks_member` **均为 0 行**（未采集板块数据），
 *    后端 `buildPoolQuery` 的 `EXISTS (SELECT 1 FROM raw_tdx_blocks_member ...)`
 *    必然 0 行 ⇒ 任何 `industry_code` 都会让**全部标的消失**（静默丢标的）。
 *    ⇒ 本页把行业控件**禁用**并显式写明「行业数据源暂不可用」，
 *      **不发送** `industry_code`（宁可不过滤，也不静默清空结果）。
 *
 * ## F-S2 · 参数表单
 *
 * 参数控件由后端 `paramSchema` 驱动，渲染器是 `components/PluginParamForm.tsx`
 * —— 与 `pages/Settings.tsx`（插件参数保存）**共用同一个组件**，避免两份实现漂移。
 *
 * ⚠️ **`symbol` / `symbols` 两个字段不渲染也不提交**：
 *    filter 类插件的标的是由选股路由**逐标的注入**的（`routes/stockscan.ts`
 *    里 `{...userParams, symbol: stock.symbol}`），
 *    用户若在表单里填 `symbols`，插件会只筛那几个标的 ⇒ 结果与候选池无关。
 *
 * ## F-S4 · 批量加入候选池
 *
 * 复用 **T56 已实现的批量接口**（不新造）：
 * `POST /api/candidates/batch`，body `{ asset_codes: string[], candidate_reason?: string }`，
 * 单次上限 **100**（`MAX_BATCH_CANDIDATES`），返回 `{ added, skipped, duplicates[] }`，
 * 重复项**幂等跳过**（不报错）。本页的结果上限正好是 100 ⇒「全部加入」一次即可。
 */

/** 后端插件信息（`GET /api/stockscan/plugins`） */
interface PluginInfo {
  id: string;
  name: string;
  description?: string;
  category: 'monitor' | 'filter';
  paramSchema?: ParamField[];
}

/** 一条选股结果（后端 `StockScanResult`） */
interface ScanResult {
  symbol: string;
  /** 证券名称（后端 `raw_symbol_name.name`，查不到时为 null） */
  name?: string | null;
  /** 现价（前复权收盘价，与候选池页 / K 线页同口径） */
  close?: number | null;
  /** 当日涨跌幅（%） */
  changePct?: number | null;
  /** 当日成交额（元） */
  amount?: number | null;
  score: number;
  signalType: 'BUY' | 'SELL' | 'HOLD' | 'ALERT';
  details?: string;
  pluginId: string;
}

/** 后端返回的「生效过滤条件」（`AppliedScanFilters`），用于回显实际口径 */
interface AppliedFilters {
  assetType?: 'stock' | 'etf' | 'all';
  excludeSt?: boolean;
  industryCode?: string | null;
  marketCapMaxYi?: number | null;
  minAmount?: number;
}

/** 标的类型（后端白名单 `ASSET_TYPES`） */
type ScanAssetType = 'stock' | 'etf' | 'all';

/** PRD §5.6「结果 ≤ 100 条」—— **强制上限，界面不可调**（F-S3） */
const MAX_RESULTS = 100;

/** 前端分页每页条数（F-S5；结果总数 ≤100，故最多 5 页） */
const PAGE_SIZE = 20;

/** 后端批量入池单次上限（T56 `MAX_BATCH_CANDIDATES`） */
const BATCH_LIMIT = 100;

/** 万元 → 元（后端 `min_amount` 的口径是「元」，见文件头说明） */
const WAN = 10_000;

const ASSET_TYPE_OPTIONS: ReadonlyArray<{ value: ScanAssetType; label: string }> = [
  { value: 'stock', label: '股票' },
  { value: 'etf', label: 'ETF' },
  { value: 'all', label: '全部' },
];

const SIGNAL_LABEL: Record<string, string> = {
  BUY: '买入',
  SELL: '卖出',
  HOLD: '持仓',
  ALERT: '预警',
};

/** 由标的代码派生「加入候选池」按钮的无障碍名（读屏可区分多行同名按钮） */
function rowLabel(symbol: string): string {
  return `选择 ${symbol}`;
}

/** 判断 axios 错误是否为 409（重复加入） */
function isConflict(err: unknown): boolean {
  const status = (err as { response?: { status?: number } } | null)?.response?.status;
  return status === 409;
}

/** 成交额（元）→ 万元字符串 */
function formatAmount(amount: number | null | undefined): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '--';
  return (amount / WAN).toFixed(2);
}

/** 现价格式化（保留 2 位小数） */
function formatClose(close: number | null | undefined): string {
  if (typeof close !== 'number' || !Number.isFinite(close)) return '--';
  return close.toFixed(2);
}

/** 涨跌幅格式化（带正负号） */
function formatChangePct(pct: number | null | undefined): string {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return '--';
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

export default function StockScan() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [selectedPluginId, setSelectedPluginId] = useState<string>('');
  /** schema 驱动表单的值（F-S2） */
  const [params, setParams] = useState<Record<string, unknown>>({});
  /** JSON 模式（T73 卡片要求保留的「高级入口」）：关 = 表单，开 = 裸 JSON */
  const [jsonMode, setJsonMode] = useState<boolean>(false);
  const [paramsJson, setParamsJson] = useState<string>('{}');

  // ---- F-S1 · 公共过滤 ----
  const [assetType, setAssetType] = useState<ScanAssetType>('stock');
  const [excludeSt, setExcludeSt] = useState<boolean>(false);
  /** 最低成交额（万元，界面口径） */
  const [minAmountWan, setMinAmountWan] = useState<number>(0);
  /** 总市值上限（亿元，空 = 不过滤） */
  const [marketCapMaxYi, setMarketCapMaxYi] = useState<string>('');

  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<ScanResult[]>([]);
  const [totalCandidates, setTotalCandidates] = useState<number>(0);
  const [totalPass, setTotalPass] = useState<number>(0);
  const [tradeDate, setTradeDate] = useState<string>('');
  const [appliedFilters, setAppliedFilters] = useState<AppliedFilters | null>(null);
  const [timeMs, setTimeMs] = useState<number>(0);
  const [errorMsg, setErrorMsg] = useState<string>('');
  /** 选股 / 参数相关的错误（显示在「选股配置」卡片里） */
  /** 加入候选池 / 自选的操作结果（显示在「选股结果」卡片里，靠近操作按钮）*/
  const [actionMsg, setActionMsg] = useState<string>('');
  const [actionError, setActionError] = useState<string>('');
  /** 每行的加入状态：symbol → 'candidate' | 'watch' | 'loading' | 'error' */
  const [rowAction, setRowAction] = useState<Record<string, string>>({});
  /** F-S4 · 勾选的标的 */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set<string>());
  /** F-S5 · 当前页 */
  const [page, setPage] = useState(1);
  const [batchLoading, setBatchLoading] = useState(false);

  const markRow = (symbol: string, state: string) => setRowAction((prev) => ({ ...prev, [symbol]: state }));

  /** 只有 filter 类插件能用于选股（PRD §5.6「筛选插件下拉」） */
  const filterPlugins = useMemo(() => plugins.filter((p) => p.category === 'filter'), [plugins]);

  const currentPlugin = useMemo(
    () => filterPlugins.find((p) => p.id === selectedPluginId) ?? null,
    [filterPlugins, selectedPluginId],
  );

  /** 当前插件的可见参数 schema（剔除运行时注入的 symbol / symbols） */
  const paramSchema = useMemo(
    () => (currentPlugin?.paramSchema ?? []).filter((f) => f.key !== 'symbol' && f.key !== 'symbols'),
    [currentPlugin],
  );

  /** F-S5 · 分页 */
  const totalPages = Math.max(1, Math.ceil(results.length / PAGE_SIZE));
  const pageRows = useMemo(() => results.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [results, page]);
  const allPageSelected = pageRows.length > 0 && pageRows.every((r) => selected.has(r.symbol));

  useEffect(() => {
    api
      .get('/stockscan/plugins')
      .then((res) => {
        const list = (res.data?.data ?? []) as PluginInfo[];
        setPlugins(list);
        const firstFilter = list.find((p) => p.category === 'filter');
        if (firstFilter) {
          setSelectedPluginId(firstFilter.id);
          setParams(defaultParamsFromSchema(firstFilter.paramSchema ?? []));
        }
      })
      .catch(() => setErrorMsg('加载插件列表失败'));
  }, []);

  /** 切换插件：重置参数为新插件的默认值 */
  const handlePluginChange = (pluginId: string) => {
    setSelectedPluginId(pluginId);
    const p = filterPlugins.find((x) => x.id === pluginId);
    const next = defaultParamsFromSchema(p?.paramSchema ?? []);
    setParams(next);
    setParamsJson(JSON.stringify(next, null, 2));
    setErrorMsg('');
  };

  /** 表单值变更（F-S2） */
  const handleParamChange = (key: string, value: unknown) => {
    setParams((prev) => ({ ...prev, [key]: value }));
  };

  /**
   * 切到 JSON 模式：把当前表单值序列化进去
   * 切回表单模式：把 JSON 解析回对象（解析失败则留在 JSON 模式并报错）
   */
  const toggleJsonMode = () => {
    if (!jsonMode) {
      setParamsJson(JSON.stringify(params, null, 2));
      setJsonMode(true);
      return;
    }
    try {
      const parsed = JSON.parse(paramsJson.trim() || '{}');
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setErrorMsg('参数必须是 JSON 对象');
        return;
      }
      setParams(parsed as Record<string, unknown>);
      setJsonMode(false);
    } catch {
      setErrorMsg('参数 JSON 解析失败');
    }
  };

  /**
   * 组装请求参数（**剔除运行时注入的 symbol / symbols**）
   *
   * ⚠️ 两种模式都剔除：`symbol` / `symbols` 由选股路由逐标的注入，
   *    用户填的 `symbols` 会让插件只筛那几个标的 ⇒ 结果与候选池无关。
   */
  const buildParams = (): Record<string, unknown> | null => {
    const stripRuntimeFields = (raw: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (k === 'symbol' || k === 'symbols') continue;
        out[k] = v;
      }
      return out;
    };

    if (jsonMode) {
      try {
        const parsed = JSON.parse(paramsJson.trim() || '{}');
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          setErrorMsg('参数必须是 JSON 对象');
          return null;
        }
        return stripRuntimeFields(parsed as Record<string, unknown>);
      } catch {
        setErrorMsg('参数 JSON 解析失败');
        return null;
      }
    }

    const issue = validateParamValues(paramSchema, params);
    if (issue) {
      setErrorMsg(`参数「${issue.label}」${issue.message}`);
      return null;
    }
    const out: Record<string, unknown> = {};
    for (const f of paramSchema) {
      if (f.key === 'symbol' || f.key === 'symbols') continue;
      out[f.key] = params[f.key];
    }
    return out;
  };

  const runScan = async () => {
    setErrorMsg('');
    setActionMsg('');
    setActionError('');
    setResults([]);
    setTotalCandidates(0);
    setTotalPass(0);
    setTradeDate('');
    setAppliedFilters(null);
    setTimeMs(0);
    setSelected(new Set<string>());
    setPage(1);

    if (!selectedPluginId) {
      setErrorMsg('请先选择插件');
      return;
    }

    const payloadParams = buildParams();
    if (payloadParams === null) return;

    setLoading(true);
    try {
      const res = await api.post('/stockscan', {
        plugin_id: selectedPluginId,
        params: payloadParams,
        // ⚠️ 万元 → 元（后端 min_amount 的口径是「元」）
        min_amount: Math.floor(Math.max(0, minAmountWan) * WAN),
        // F-S3：强制 ≤100，界面不可调
        max_results: MAX_RESULTS,
        // F-S1 · 公共过滤
        asset_type: assetType,
        exclude_st: excludeSt,
        ...(marketCapMaxYi.trim() !== '' ? { market_cap_max: Number(marketCapMaxYi) } : {}),
        // ⚠️ 不传 industry_code：板块表 0 行 → 传了会把结果清空（见文件头说明）
      });
      if (isOkEnvelope(res.data) && res.data?.data) {
        setResults((res.data.data.results ?? []) as ScanResult[]);
        setTotalCandidates(res.data.data.totalCandidates ?? 0);
        setTotalPass(res.data.data.total ?? 0);
        setTradeDate(res.data.data.tradeDate ?? '');
        setAppliedFilters((res.data.data.filters ?? null) as AppliedFilters | null);
        setTimeMs(res.data.timeMs ?? 0);
      } else {
        setErrorMsg(res.data?.message ?? '选股失败');
      }
    } catch (err) {
      setErrorMsg('选股请求失败：' + extractErrorMessageOrString(err));
    } finally {
      setLoading(false);
    }
  };

  /** 单只加入候选池（附带缺陷修复：409 判断移到 catch 分支） */
  const addCandidate = async (symbol: string) => {
    markRow(symbol, 'loading');
    setActionError('');
    try {
      const res = await api.post('/candidate', { asset_code: symbol });
      if (isOkEnvelope(res.data)) {
        markRow(symbol, 'candidate');
        setActionMsg(`${symbol} 已加入候选池`);
      } else {
        markRow(symbol, 'error');
        setActionError(res.data?.message ?? '加入候选失败');
      }
    } catch (err) {
      // 🔴 附带缺陷修复：axios 对 4xx 走 **reject**，409 永远到不了上面的成功分支
      //   → 「已在候选池」必须在这里判，否则用户看到的是「加入候选失败」。
      if (isConflict(err)) {
        markRow(symbol, 'candidate');
        setActionMsg(`${symbol} 已在候选池`);
        return;
      }
      markRow(symbol, 'error');
      setActionError('加入候选失败：' + extractErrorMessageOrString(err));
    }
  };

  /** 加入自选（`POST /api/watch` —— 原实现打的 `/candidate/:symbol/promote` 是死路由，实测 404） */
  const promoteToWatch = async (symbol: string) => {
    markRow(symbol, 'loading');
    try {
      const res = await api.post('/watch', { asset_code: symbol });
      if (isOkEnvelope(res.data)) {
        markRow(symbol, 'watch');
        setActionMsg(`${symbol} 已加入自选`);
      } else {
        markRow(symbol, 'error');
        setActionError(res.data?.message ?? '加入自选失败');
      }
    } catch (err) {
      if (isConflict(err)) {
        markRow(symbol, 'watch');
        setActionMsg(`${symbol} 已在自选`);
        return;
      }
      markRow(symbol, 'error');
      setActionError('加入自选失败：' + extractErrorMessageOrString(err));
    }
  };

  /** F-S4 · 批量加入候选池（复用 T56 的 `POST /api/candidates/batch`） */
  const addBatchToCandidates = async (codes: string[]) => {
    setActionError('');
    setActionMsg('');
    if (codes.length === 0) {
      setActionError('请先勾选要加入候选池的标的');
      return;
    }
    if (codes.length > BATCH_LIMIT) {
      setActionError(`单次最多加入 ${BATCH_LIMIT} 只，当前 ${codes.length} 只`);
      return;
    }
    setBatchLoading(true);
    try {
      const res = await api.post('/candidates/batch', { asset_codes: codes });
      if (isOkEnvelope(res.data)) {
        const data = (res.data.data ?? {}) as {
          added?: number;
          skipped?: number;
          duplicates?: string[];
        };
        const added = data.added ?? 0;
        const skipped = data.skipped ?? 0;
        const duplicates = data.duplicates ?? [];
        setActionMsg(
          `已加入候选池 ${added} 只，跳过 ${skipped} 只` +
            (duplicates.length > 0 ? `（重复 ${duplicates.length} 只）` : ''),
        );
        for (const code of codes) markRow(code, 'candidate');
      } else {
        setActionError(res.data?.message ?? '批量加入候选池失败');
      }
    } catch (err) {
      setActionError('批量加入候选池失败：' + extractErrorMessageOrString(err));
    } finally {
      setBatchLoading(false);
    }
  };

  /** 勾选 / 取消勾选某一只 */
  const toggleRow = (symbol: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      return next;
    });
  };

  /** 全选 / 取消全选（当前页） */
  const toggleSelectAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allPageSelected) {
        for (const r of pageRows) next.delete(r.symbol);
      } else {
        for (const r of pageRows) next.add(r.symbol);
      }
      return next;
    });
  };

  // ── 样式（全部取自 theme token，不引入裸 hex）──

  /** 表单行：允许换行（G6.6 375px 无横向溢出的第一个根因）*/
  const rowStyle: React.CSSProperties = { ...formRowStyle, flexWrap: 'wrap' };
  /** 控件：可伸缩且不撑破父容器 */
  const controlStyle: React.CSSProperties = {
    ...inputStyle,
    flex: '1 1 140px',
    minWidth: 0,
    maxWidth: '100%',
  };
  /** 说明文字：独占一行（不与控件抢空间）*/
  const hintStyle: React.CSSProperties = {
    flexBasis: '100%',
    fontSize: TYPO.smallSize,
    color: COLORS.neutral,
  };
  /** 按钮行：允许换行 */
  const actionRowStyle: React.CSSProperties = {
    marginTop: SPACING.gapRelaxed,
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
  };
  const smallButtonStyle: React.CSSProperties = {
    ...buttonStyle,
    fontSize: 12,
    padding: '3px 10px',
    marginRight: 6,
  };

  return (
    <div style={pageContainerStyle}>
      {/* ⚠️ 用 `<h1>`（不是 h2）—— axe 的 page-has-heading-one 要求页面有 h1（其它页面一律 h1）*/}
      <h1 style={titleStyle}>条件选股</h1>

      {/* ── F-S1 · 公共过滤 + F-S2 · 插件参数 ── */}
      <div style={cardStyle}>
        <div style={cardTitleStyle}>选股配置</div>

        {/* 筛选插件下拉（PRD §5.6：只列 filter 类插件）*/}
        <div style={rowStyle}>
          <label htmlFor="stockscan-plugin" style={labelStyle}>
            筛选插件：
          </label>
          <select
            id="stockscan-plugin"
            style={controlStyle}
            value={selectedPluginId}
            onChange={(e) => handlePluginChange(e.target.value)}
          >
            {filterPlugins.length === 0 && <option value="">暂无可用筛选插件</option>}
            {filterPlugins.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {currentPlugin?.description ? (
            <span style={{ flexBasis: '100%', color: COLORS.neutral, fontSize: TYPO.smallSize }}>
              {currentPlugin.description}
            </span>
          ) : null}
        </div>

        {/* F-S1 · 标的类型 */}
        <div style={rowStyle}>
          <label htmlFor="stockscan-asset-type" style={labelStyle}>
            标的类型：
          </label>
          <select
            id="stockscan-asset-type"
            style={controlStyle}
            value={assetType}
            onChange={(e) => setAssetType(e.target.value as ScanAssetType)}
          >
            {ASSET_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span style={hintStyle}>股票 / ETF / 全部（默认股票）</span>
        </div>

        {/* F-S1 · 排除 ST */}
        <div style={rowStyle}>
          <label htmlFor="stockscan-exclude-st" style={labelStyle}>
            排除 ST：
          </label>
          <input
            id="stockscan-exclude-st"
            type="checkbox"
            checked={excludeSt}
            onChange={(e) => setExcludeSt(e.target.checked)}
          />
          <span style={hintStyle}>排除名称带 ST / *ST 的标的（按证券名称前缀判定）</span>
        </div>

        {/* F-S1 · 成交额下限 */}
        <div style={rowStyle}>
          <label htmlFor="stockscan-min-amount" style={labelStyle}>
            最低成交额（万）：
          </label>
          <input
            id="stockscan-min-amount"
            style={controlStyle}
            type="number"
            min={0}
            step={100}
            value={minAmountWan}
            onChange={(e) => setMinAmountWan(Math.max(0, Number(e.target.value) || 0))}
          />
          <span style={hintStyle}>过滤流动性过差的标的，单位：万元，默认 0 不过滤</span>
        </div>

        {/* F-S1 · 市值上限 */}
        <div style={rowStyle}>
          <label htmlFor="stockscan-market-cap" style={labelStyle}>
            总市值上限（亿）：
          </label>
          <input
            id="stockscan-market-cap"
            style={controlStyle}
            type="number"
            min={0}
            step={1}
            placeholder="留空不过滤"
            value={marketCapMaxYi}
            onChange={(e) => setMarketCapMaxYi(e.target.value)}
          />
          <span style={hintStyle}>按总市值过滤，单位：亿元，留空表示不过滤</span>
        </div>

        {/* F-S1 · 行业（🔴 数据源不可用 → 禁用 + 显式文案）*/}
        <div style={rowStyle}>
          <label htmlFor="stockscan-industry" style={labelStyle}>
            行业：
          </label>
          <select id="stockscan-industry" style={controlStyle} disabled value="">
            <option value="">全部</option>
          </select>
          {/*
            ⚠️ 颜色用 `COLORS.textWarning`（深琥珀 #92400e，白底对比度 7.09:1 ≥ 4.5:1）
               而不是 `COLORS.warning`（#d97706 是饱和图形档，对比度 3.19:1）——
               后者会被真浏览器 axe 判为 color-contrast 违规（serious）。
               （Wave 7 卡 5 新增了 `textWarning`；此处沿用同值的 `textDisclaimer` 亦可。）
          */}
          <span style={{ ...hintStyle, color: COLORS.textDisclaimer }}>行业数据源暂不可用</span>
        </div>

        {/* F-S2 · 参数表单（schema 驱动）*/}
        <div style={{ ...rowStyle, alignItems: 'flex-start' }}>
          {/*
            ⚠️ 这里用 `<span>` 而不是 `<label htmlFor>`：
            本行的**唯一**表单控件是「JSON 模式」开关（参数输入框由
            `PluginParamForm` 各自带 label）。若外层也用 label 且指向同一个 id，
            开关的可访问名会变成「参数： JSON 模式（高级）」这种拼接串。
          */}
          <span style={{ ...labelStyle, paddingTop: 6 }}>参数：</span>
          <div style={{ flex: '1 1 200px', minWidth: 0 }}>
            <label
              htmlFor="stockscan-json-mode"
              style={{ fontSize: TYPO.bodySize, display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <input id="stockscan-json-mode" type="checkbox" checked={jsonMode} onChange={toggleJsonMode} />
              JSON 模式（高级）
            </label>

            {jsonMode ? (
              <textarea
                id="stockscan-params-json"
                aria-label="参数 JSON"
                style={{ ...inputStyle, width: '100%', fontFamily: TYPO.monoFamily, marginTop: 8 }}
                rows={4}
                value={paramsJson}
                onChange={(e) => setParamsJson(e.target.value)}
                placeholder='{"periodShort": 5, "periodMid": 10, "periodLong": 20}'
              />
            ) : (
              <div style={{ marginTop: 8 }}>
                <PluginParamForm
                  pluginId={selectedPluginId}
                  schema={paramSchema}
                  values={params}
                  idPrefix="stockscan"
                  hiddenKeys={['symbol', 'symbols']}
                  onChange={handleParamChange}
                />
                {paramSchema.length === 0 && (
                  <div style={{ fontSize: TYPO.smallSize, color: COLORS.neutral }}>该插件无需额外参数</div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* F-S3 · 结果上限（不可调）*/}
        <div style={rowStyle}>
          <label htmlFor="stockscan-max-results" style={labelStyle}>
            结果上限：
          </label>
          <input
            id="stockscan-max-results"
            style={{ ...controlStyle, maxWidth: 120 }}
            type="number"
            min={1}
            max={MAX_RESULTS}
            value={MAX_RESULTS}
            readOnly
            aria-readonly="true"
          />
          <span style={hintStyle}>按 PRD §5.6 固定为 {MAX_RESULTS} 条，不可调整</span>
        </div>

        {errorMsg && <div style={errorStyle}>{errorMsg}</div>}

        <div style={actionRowStyle}>
          <button style={buttonStyle} onClick={runScan} disabled={loading || !selectedPluginId}>
            {loading ? '运行中...' : '开始选股'}
          </button>
          {timeMs > 0 && !loading && (
            <span style={{ color: COLORS.neutral, fontSize: TYPO.smallSize }}>耗时 {timeMs}ms</span>
          )}
        </div>
      </div>

      {/* ── F-S5 · 结果表（含分页）+ F-S4 · 批量加入候选池 ── */}
      <div style={cardStyle}>
        <div style={cardTitleStyle}>
          选股结果
          {totalCandidates > 0 && (
            <span style={{ color: COLORS.neutral, fontWeight: 400, marginLeft: 12 }}>
              交易日 {tradeDate} · 候选池 {totalCandidates} · 命中 {totalPass} · 返回 {results.length}
            </span>
          )}
        </div>

        {appliedFilters ? (
          <div
            style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary, marginBottom: SPACING.gapBase }}
          >
            生效过滤：
            {ASSET_TYPE_OPTIONS.find((o) => o.value === appliedFilters.assetType)?.label ?? '股票'}
            {appliedFilters.excludeSt ? ' · 排除 ST' : ''}
            {appliedFilters.minAmount ? ` · 成交额 ≥ ${appliedFilters.minAmount} 元` : ''}
            {appliedFilters.marketCapMaxYi ? ` · 总市值 ≤ ${appliedFilters.marketCapMaxYi} 亿` : ''}
            {' · 行业：未过滤（数据源不可用）'}
          </div>
        ) : null}

        {/*
          加入候选池 / 自选的操作反馈放在**结果卡片**里（紧挨操作按钮）——
          放在上方的「选股配置」卡片里会让用户在页面底部点了按钮却看不到回显。
        */}
        {actionError && <div style={errorStyle}>{actionError}</div>}
        {actionMsg && <div style={{ ...successStyle, color: COLORS.textSuccess }}>{actionMsg}</div>}

        {loading ? (
          <div style={{ color: COLORS.neutral, padding: 20, textAlign: 'center' }}>选股进行中...</div>
        ) : results.length === 0 ? (
          <div style={{ color: COLORS.neutral, padding: 20, textAlign: 'center' }}>暂无结果</div>
        ) : (
          <>
            {/* F-S4 · 批量操作条 */}
            <div style={{ ...actionRowStyle, marginTop: 0, marginBottom: SPACING.gapBase }}>
              <button
                style={buttonStyle}
                disabled={batchLoading || selected.size === 0}
                onClick={() => void addBatchToCandidates(Array.from(selected))}
              >
                加入选中（{selected.size}）
              </button>
              <button
                style={buttonStyle}
                disabled={batchLoading || results.length === 0}
                onClick={() => void addBatchToCandidates(results.map((r) => r.symbol))}
              >
                全部加入候选池（{results.length}）
              </button>
              {selected.size > 0 && (
                <button
                  style={{ ...buttonStyle, background: COLORS.neutral }}
                  onClick={() => setSelected(new Set<string>())}
                >
                  清空勾选
                </button>
              )}
              <span style={{ color: COLORS.neutral, fontSize: TYPO.smallSize }}>
                批量加入走 T56 的批量接口，单次上限 {BATCH_LIMIT} 只，重复项自动跳过
              </span>
            </div>

            {/*
              表格用 `ScrollableTable` 包一层 —— 表格在**自己内部**横向滚动，
              不会把文档撑宽（G6.6 的 375px 无横向溢出判据）。
            */}
            <ScrollableTable label="选股结果表">
              <table style={tableStyle} aria-label="选股结果">
                <thead>
                  <tr>
                    <th scope="col" style={thStyle}>
                      <input
                        type="checkbox"
                        aria-label="全选"
                        checked={allPageSelected}
                        onChange={toggleSelectAll}
                      />
                    </th>
                    <th scope="col" style={thStyle}>
                      序号
                    </th>
                    <th scope="col" style={thStyle}>
                      标的代码
                    </th>
                    <th scope="col" style={thStyle}>
                      名称
                    </th>
                    <th scope="col" style={thStyle}>
                      现价
                    </th>
                    <th scope="col" style={thStyle}>
                      涨跌幅
                    </th>
                    <th scope="col" style={thStyle}>
                      成交额（万）
                    </th>
                    <th scope="col" style={thStyle}>
                      方向
                    </th>
                    <th scope="col" style={thStyle}>
                      强度
                    </th>
                    <th scope="col" style={thStyle}>
                      筛选参数
                    </th>
                    <th scope="col" style={thStyle}>
                      操作
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((r, i) => {
                    const st = rowAction[r.symbol];
                    const pct = r.changePct;
                    return (
                      <tr key={r.symbol}>
                        <td style={thTdStyle}>
                          <input
                            type="checkbox"
                            aria-label={rowLabel(r.symbol)}
                            checked={selected.has(r.symbol)}
                            onChange={() => toggleRow(r.symbol)}
                          />
                        </td>
                        <td style={thTdStyle}>{(page - 1) * PAGE_SIZE + i + 1}</td>
                        <td style={thTdStyle}>
                          <code>{r.symbol}</code>
                        </td>
                        <td style={thTdStyle}>{r.name ?? '--'}</td>
                        <td style={thTdStyle}>{formatClose(r.close)}</td>
                        <td
                          style={{
                            ...thTdStyle,
                            color:
                              typeof pct === 'number'
                                ? pct >= 0
                                  ? COLORS.danger
                                  : COLORS.textSuccess
                                : COLORS.textSecondary,
                          }}
                        >
                          {formatChangePct(pct)}
                        </td>
                        <td style={thTdStyle}>{formatAmount(r.amount)}</td>
                        <td style={thTdStyle}>
                          <span
                            style={{
                              color:
                                r.signalType === 'BUY'
                                  ? COLORS.textSuccess
                                  : r.signalType === 'SELL'
                                    ? COLORS.danger
                                    : COLORS.textSecondary,
                              fontWeight: TYPO.cardTitleWeight,
                            }}
                          >
                            {SIGNAL_LABEL[r.signalType] ?? r.signalType}
                          </span>
                        </td>
                        <td style={thTdStyle}>{(r.score * 100).toFixed(1)}%</td>
                        <td style={{ ...thTdStyle, color: COLORS.neutral }}>{r.details ?? '-'}</td>
                        <td style={{ ...thTdStyle, whiteSpace: 'nowrap' }}>
                          <button
                            style={smallButtonStyle}
                            disabled={st === 'loading' || st === 'candidate'}
                            onClick={() => void addCandidate(r.symbol)}
                          >
                            {st === 'candidate' ? '已候选' : '加候选'}
                          </button>
                          <button
                            style={{
                              ...smallButtonStyle,
                              /*
                               * ⚠️ 底色用**正文色档**（Wave 7 卡 5 · 裁决 D-9）：
                               *   `COLORS.success`（饱和绿）承载白字只有 3.30:1 —— 达不到
                               *   WCAG 1.4.3 的 4.5:1，真浏览器 axe 会判 color-contrast（serious）。
                               *   `textSuccess`（#15803d）+ 白字 = 5.02:1 ✅
                               */
                              background: COLORS.textSuccess,
                            }}
                            disabled={st === 'loading' || st === 'watch'}
                            onClick={() => void promoteToWatch(r.symbol)}
                          >
                            {st === 'watch' ? '已自选' : '加自选'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </ScrollableTable>

            {/* F-S5 · 分页 */}
            <div
              style={{
                marginTop: SPACING.gapBase,
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <button style={buttonStyle} disabled={page <= 1} onClick={() => setPage(page - 1)}>
                上一页
              </button>
              <span style={{ fontSize: TYPO.bodySize }}>
                第 {page} / {totalPages} 页，共 {results.length} 条
              </span>
              <button style={buttonStyle} disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
                下一页
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
