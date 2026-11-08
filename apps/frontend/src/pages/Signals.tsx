import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { isOkEnvelope } from '../api/envelope';
import { extractErrorMessage } from '../api/errors';
import { COLORS, SPACING, TYPO } from '../theme/tokens';
import Spinner from '../components/Spinner';
import ScrollableTable from '../components/ScrollableTable';
import {
  SignalDirectionPill,
  SignalGradeTag,
  SignalLabelTag,
  SignalTradeStatusTag,
} from '../components/SignalPills';
import { SignalStrength } from '../components/SignalStrength';
import { useUserStore } from '../store/user';
import {
  pageContainerStyle,
  cardStyle,
  titleStyle,
  cardTitleStyle,
  inputStyle,
  buttonStyle,
  tableStyle,
  thStyle,
  thTdStyle,
  errorStyle,
} from './_shared';

/**
 * 策略信号页（T72 · Signals 页增强）
 *
 * ## T72 的三件交付
 *
 * ① **进页自动加载**（今日 + 全部策略 + 全部方向）——
 *    挂载即发一次 `GET /api/signal`，**删掉「请点击查询按钮加载数据」空态**
 *    （旧实现把「还没查」当成一种状态，PRD §5.2 的用户旅程是
 *    「收盘后系统自动跑一遍 → 第二天打开就能看到」，进页就该有数据）。
 *
 * ② **方向彩色 pill + 强度进度条/星 + 标签 tag** ——
 *    见 `components/SignalPills.tsx`（方向配色口径）与
 *    `components/SignalStrength.tsx`（强度字段口径）。
 *
 * ③ **分页** —— 后端 `GET /api/signal` 返回 `pagination.totalPages / total`
 *    并接受 `page`（`apps/backend/src/routes/signal.ts:32/78`），
 *    旧实现把 `pagination` **整个丢掉**（只取 `res.data.data`）→ 永远只有第 1 页。
 *
 * ## 排序口径（**升序 = 交易日升序**，不是方向升序）
 *
 * 后端固定 `ORDER BY trade_date ASC, created_at ASC, id ASC`
 * （`apps/backend/src/routes/signal.ts:73`，T53/T54 要求升序，
 * 后端用例 `apps/backend/tests/unit/t54-signal-filter.test.ts:217` 逐条锁定）。
 *
 * ⇒ **前端不做任何重排**：直接按接口返回顺序渲染。
 *    分页下前端排序会**错乱**（每页各自排 → 全局顺序不成立），
 *    且会与后端的 `LIMIT/OFFSET` 语义打架。
 *
 * ## 筛选参数（全部走后端已登记的参数，SDD §4.4）
 *
 * | 前端控件 | 接口参数 | 后端支持 |
 * |---|---|---|
 * | 交易日期 | `trade_date` | ✅ 单日过滤 |
 * | 起始日期 | `start_date` | ✅ 闭区间下界（含）|
 * | 结束日期 | `end_date` | ✅ 闭区间上界（含）|
 * | 标的代码 | `asset_code` | ✅ 单标的过滤 |
 * | 策略名称 | `plugin_id` | ✅ |
 * | 方向 | `direction` | ✅ buy/sell/hold |
 * | 分页 | `page` / `page_size` | ✅（`page_size` 上限 200）|
 *
 * ⚠️ 多个条件之间是 **AND** 关系（后端 `WHERE` 逐条 append），
 *    例如「交易日期 = 今日」+「区间 = 上月」只会命中**同时**满足的信号。
 */

/** 每页条数（后端 `page_size` 上限 200）*/
const PAGE_SIZE = 50;

/**
 * 筛选防抖时长（毫秒）
 *
 * 与 `pages/Review.tsx` 的 `FILTER_DEBOUNCE_MS` 同款口径（T69 ⑥）：
 * 300ms 足以合并「连续改多个控件」的请求风暴，又短到用户感觉不到延迟。
 */
const FILTER_DEBOUNCE_MS = 300;

/** 一行信号（后端 `SELECT *`，列由后端给出，故用索引签名 + 已知字段可选化）*/
interface SignalRow {
  id?: number;
  /** 后端字段名是 `asset_code`；`symbol` 是旧前端用例用的别名，一并兼容 */
  asset_code?: string;
  symbol?: string;
  plugin_id?: string;
  plugin_category?: string;
  direction?: string;
  label?: string;
  /** 信号强度（**0~1 的小数**，可空 —— 见 `components/SignalStrength.tsx`）*/
  strength?: number | null;
  /** F1：分级（strong / medium / weak；历史行/无强度行为 null）*/
  grade?: string | null;
  /** F1：有效期（YYYY-MM-DD；过期信号置灰不删）*/
  expires_at?: string | null;
  /**
   * F6：同一策略+标的+方向在冷却窗口内被合并的「连续第 N 日选中」计数
   *
   * 仅 `dedupe=1` 时由后端下发；1 = 未被合并。
   */
  consecutive_days?: number;
  /** F2：关联成交 id（信号表字段，指向 `user_trade_record.id`）*/
  linked_trade_id?: number | null;
  /** F2：处理状态（后端派生：traded / ignored / adopted / pending）*/
  trade_status?: string;
  /** F2：关联的成交已被软删（不要显示「查看成交」）*/
  link_broken?: boolean;
  adopted?: number | null;
  ignored?: number | null;
  trade_date?: string;
  [key: string]: unknown;
}

/** F2：关联成交详情（`GET /api/signal/:id/linked-trade`）*/
interface LinkedTradeDetail {
  signal_id: number;
  trade_status: string;
  link_broken: boolean;
  trade: {
    id: number;
    asset_code: string;
    trade_type: string;
    direction: 'buy' | 'sell' | 'other';
    trade_date: string;
    trade_time: string | null;
    quantity: number;
    price: number;
    fee: number;
    amount: number;
    realized_pnl: number | null;
  } | null;
}

const TRADE_DIRECTION_LABEL: Record<string, string> = {
  buy: '买入',
  sell: '卖出',
  other: '其它',
};

/** F1：分级 tab（PRD_v3 §4.2「全部 / 强 / 中 / 弱 / 已过期」）*/
type GradeTab = 'all' | 'strong' | 'medium' | 'weak' | 'expired';

/** tab 文案（顺序即渲染顺序）*/
const GRADE_TABS: Array<{ key: GradeTab; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'strong', label: '强' },
  { key: 'medium', label: '中' },
  { key: 'weak', label: '弱' },
  { key: 'expired', label: '已过期' },
];

/** 东八区今天（YYYY-MM-DD）—— 与后端 `getTradeDate()` 同口径，用于过期判断 */
function todayInShanghai(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

/** `date` 距今天的天数（仅用于「生成于 X 天前」文案，非法日期返回 null）*/
function daysSince(date: string, today: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const diff = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(diff) ? Math.floor(diff / 86_400_000) : null;
}

/** 插件类别 → 中文（`monitor` = 监控类 / `filter` = 筛选类，Requirements §5.5）*/
const PLUGIN_CATEGORY_LABEL: Record<string, string> = {
  monitor: '监控',
  filter: '选股',
};

/** 取一行的标的代码（`asset_code` 优先，兼容旧别名 `symbol`）*/
function assetCodeOf(row: SignalRow): string {
  const code = row.asset_code ?? row.symbol;
  return typeof code === 'string' && code !== '' ? code : '--';
}

/** 后端下发的默认日期口径来源（F 域 P0-1）*/
type DateSource = 'explicit' | 'signal' | 'quote' | 'today';

export default function Signals() {
  const navigate = useNavigate();
  /** T79 ③：管理员在空态可直达 Admin 手动触发信号生成 */
  const role = useUserStore((s) => s.role);

  // ── 筛选条件 ───────────────────────────────────────────────────
  /**
   * 交易日期（单日精确匹配）
   *
   * 🔴 F 域 P0-1：**初始为空 = 跟随后端默认口径**（最近有信号日 → 最近行情日 → 今天），
   *    修复前硬编码 `todayStr()` ⇒ 周末/节假日/行情未跑的日子进页就是空页面，
   *    用户误以为「没有信号」。
   */
  const [tradeDate, setTradeDate] = useState<string>('');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [assetCode, setAssetCode] = useState<string>('');
  const [pluginId, setPluginId] = useState<string>('');
  const [direction, setDirection] = useState<string>('');
  /**
   * F1：分级 tab，**默认只看强**（用户口径：默认只显强；全部/中/弱/已过期按需切换）
   */
  const [gradeTab, setGradeTab] = useState<GradeTab>('strong');

  // ── 数据与分页 ──────────────────────────────────────────────
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<SignalRow[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  // ── 后端默认日期口径（F 域 P0-1）────────────────────────────
  /** 实际生效的交易日（用户没选日期时由后端解析，前端只展示，不自己猜今天）*/
  const [resolvedDate, setResolvedDate] = useState<string | null>(null);
  /** 默认日期来源：signal=最近有信号日 / quote=最近行情日 / today=兜底 */
  const [resolvedSource, setResolvedSource] = useState<DateSource | null>(null);
  /** 行情最新日（仅在后端走「最近行情日」兜底时下发，用于空态文案）*/
  const [latestQuoteDate, setLatestQuoteDate] = useState<string | null>(null);
  /** F6：冷却展示合并窗口（后端下发；仅用于旁注文案）*/
  const [cooldownBars, setCooldownBars] = useState<number>(3);

  /**
   * 行情最新日（独立取一次，仅用于「当前展示日 vs 行情最新日」旁注）
   *
   * ⚠️ `resolveDefaultSignalTradeDate()` 在「最近有信号日」口径下把
   *    `latest_quote_date` 置 null（见 `signalService.ts`），故 `/api/signal`
   *    响应里拿不到行情最新日。这里复用只读接口 `/api/market/latest-date`
   *    （与 Dashboard / Admin 同款），只做展示，不参与任何筛选或默认日期解析。
   */
  const [marketQuoteDate, setMarketQuoteDate] = useState<string | null>(null);

  // ── F3：今日 Top 5 摘要区 ────────────────────────────────────────
  /** 摘要区数据（后端强制单日 + 按 强>中>弱>未分级 + 强度降序 的前 5 条）*/
  const [top5Rows, setTop5Rows] = useState<SignalRow[]>([]);
  const [top5Loading, setTop5Loading] = useState(false);
  /** 摘要区实际交易日与来源（后端解析；摘要失败时静默降级，不影响主列表）*/
  const [top5TradeDate, setTop5TradeDate] = useState<string | null>(null);
  const [top5Source, setTop5Source] = useState<DateSource>('explicit');

  // ── V3.8 T149：信号生命周期操作（采纳/忽略/关联交易）────────────────
  const [actMsg, setActMsg] = useState<string | null>(null);

  /** F2：当前展开的关联成交详情（null = 未展开）*/
  const [tradeDetail, setTradeDetail] = useState<LinkedTradeDetail | null>(null);
  const [tradeDetailLoading, setTradeDetailLoading] = useState(false);

  /**
   * F2：按信号查关联成交（读取侧）
   *
   * 只读接口；断链（成交已软删）时后端返回 `link_broken: true` + `trade: null`。
   */
  const openTradeDetail = async (id: number) => {
    setTradeDetailLoading(true);
    try {
      const res = await api.get(`/signal/${id}/linked-trade`);
      if (isOkEnvelope(res.data)) {
        setTradeDetail((res.data.data ?? null) as LinkedTradeDetail | null);
      } else {
        setActMsg(String(res.data?.message ?? '查询关联成交失败'));
      }
    } catch (e) {
      setActMsg(extractErrorMessage(e, '查询关联成交失败'));
    } finally {
      setTradeDetailLoading(false);
    }
  };

  const signalAction = async (id: number, kind: 'adopt' | 'ignore') => {
    setActMsg(null);
    try {
      const res = await api.patch(`/signal/${id}/${kind}`);
      if (isOkEnvelope(res.data)) {
        // F2：状态同步 —— 已成交不会被「采纳 / 忽略」覆盖（优先级固定为 已成交 > ...）
        setRows((rs) =>
          rs.map((r) =>
            r.id === id
              ? {
                  ...r,
                  [`${kind}ed`]: 1,
                  trade_status:
                    r.trade_status === 'traded' ? 'traded' : kind === 'adopt' ? 'adopted' : 'ignored',
                }
              : r,
          ),
        );
        setActMsg(kind === 'adopt' ? '已采纳' : '已忽略');
      } else {
        setActMsg(String(res.data?.message ?? '操作失败'));
      }
    } catch (e) {
      setActMsg(extractErrorMessage(e, '操作失败'));
    }
  };

  /** 关联既有交易记录（INV-S3-15/16、INV-S6-4）：输入 tradeRecordId → 后端校验归属+标的 */
  const linkTrade = async (id: number) => {
    setActMsg(null);
    const raw = window.prompt('输入要关联的交易记录 id（user_trade_record.id）：');
    if (raw == null) return; // 用户取消
    const tradeRecordId = Number(raw.trim());
    if (!Number.isFinite(tradeRecordId) || tradeRecordId <= 0) {
      setActMsg('交易记录 id 非法');
      return;
    }
    try {
      const res = await api.patch(`/signal/${id}/link-trade`, { tradeRecordId });
      if (isOkEnvelope(res.data)) {
        const data = res.data.data as
          { linked_trade_id?: number | null; unchanged?: boolean; shared_signals?: number } | undefined;
        // F2：本地同步状态（后端已做校验；此处只更新展示，失败不掩盖成功结果）
        setRows((rs) =>
          rs.map((r) =>
            r.id === id
              ? { ...r, linked_trade_id: data?.linked_trade_id ?? tradeRecordId, trade_status: 'traded' }
              : r,
          ),
        );
        const shared = typeof data?.shared_signals === 'number' ? data.shared_signals : 0;
        setActMsg(shared > 0 ? `已关联交易（该成交同时被另外 ${shared} 条信号关联）` : '已关联交易');
      } else {
        setActMsg(String(res.data?.message ?? '关联失败'));
      }
    } catch (e) {
      setActMsg(extractErrorMessage(e, '关联失败'));
    }
  };

  /**
   * 拉取「今日 Top 5」摘要（F3）
   *
   * `date` 为 null 时由后端解析默认日（最近有信号日 → 最近行情日 → 今天）。
   * ⚠️ 摘要区失败只做**静默降级**（清空摘要），不覆盖主列表的错误态。
   */
  const fetchTop5 = async (date: string | null) => {
    setTop5Loading(true);
    try {
      const res = date
        ? await api.get('/signal/top5', { params: { trade_date: date } })
        : await api.get('/signal/top5');
      if (isOkEnvelope(res.data)) {
        setTop5Rows((res.data.data ?? []) as SignalRow[]);
        const meta = res.data as unknown as {
          trade_date?: string | null;
          trade_date_source?: DateSource;
        };
        setTop5TradeDate(typeof meta.trade_date === 'string' ? meta.trade_date : date);
        setTop5Source(meta.trade_date_source ?? 'explicit');
      } else {
        setTop5Rows([]);
      }
    } catch {
      setTop5Rows([]);
    } finally {
      setTop5Loading(false);
    }
  };

  /**
   * 拉取信号
   *
   * @param targetPage 目标页码（1 起）
   */
  const fetchSignals = async (targetPage: number) => {
    // 页码与请求同步更新（乐观分页）：翻页后「第 X / Y 页」立即反映目标页
    setPage(targetPage);
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, unknown> = { page: targetPage, page_size: PAGE_SIZE };
      if (tradeDate) params.trade_date = tradeDate;
      if (startDate) params.start_date = startDate;
      if (endDate) params.end_date = endDate;
      const code = assetCode.trim();
      if (code) params.asset_code = code;
      const plugin = pluginId.trim();
      if (plugin) params.plugin_id = plugin;
      if (direction) params.direction = direction;
      // F1：分级 tab 直接下推后端（避免前端只过滤当前页导致分页错乱）
      if (gradeTab !== 'all') params.grade = gradeTab;
      // F6：展示层冷却合并去重（同策略+标的+方向窗口内合并，只影响展示，不影响生成）
      params.dedupe = 1;

      const res = await api.get('/signal', { params });
      if (isOkEnvelope(res.data)) {
        setRows((res.data.data ?? []) as SignalRow[]);
        // T72 ③：后端已经返回分页元信息（旧实现把它整个丢了）
        setTotalPages(res.data.pagination?.totalPages ?? 1);
        setTotal(res.data.pagination?.total ?? 0);
        // F 域 P0-1：日期口径与行情最新日都取后端值（显式筛选时不覆盖用户的输入）
        const meta = res.data as unknown as {
          trade_date?: string | null;
          trade_date_source?: DateSource;
          latest_quote_date?: string | null;
          cooldown_bars?: number;
        };
        const source = meta.trade_date_source ?? 'explicit';
        setResolvedSource(source);
        setResolvedDate(source === 'explicit' ? null : (meta.trade_date ?? null));
        setLatestQuoteDate(typeof meta.latest_quote_date === 'string' ? meta.latest_quote_date : null);
        if (typeof meta.cooldown_bars === 'number' && meta.cooldown_bars >= 1) {
          setCooldownBars(meta.cooldown_bars);
        }
        /*
         * F3：摘要区跟随主列表的展示日 ——
         * 用户显式选了单日 → 用该日；只选区间/默认视角 → 用后端解析出的交易日；
         * 区间模式（source=explicit 且无单日）→ 传 null，由后端按默认口径解析。
         */
        void fetchTop5(tradeDate || (meta.trade_date ?? null));
      } else {
        setError(res.data.message ?? '请求失败');
      }
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  // ① 进页自动加载：挂载即查一次（今日 + 全部策略 + 全部方向）
  useEffect(() => {
    void fetchSignals(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 行情最新日只取一次（只用于旁注；失败就降级为不显示该段）*/
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get('/market/latest-date');
        if (cancelled || !isOkEnvelope(res.data)) return;
        const raw = (res.data.data as { date?: string | null } | null)?.date ?? null;
        setMarketQuoteDate(typeof raw === 'string' ? raw : null);
      } catch {
        // 旁注是辅助信息，取不到就不显示，不影响主流程
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 筛选即时生效（T72 ④）：改完筛选条件 300ms 后自动重查，**回到第 1 页**
   *
   * ⚠️ `lastQueriedFilterKey` 初始化为**挂载时的筛选指纹**，
   *    故挂载那一次不会重复触发（挂载 effect 已经查过第 1 页）。
   * ⚠️ 指纹比对放在 **timer 回调内** —— 这样「点【查询】按钮」先把指纹写进去，
   *    300ms 后到期的防抖就会自己跳过，**不会重复发两次请求**。
   */
  const filterKey = JSON.stringify([tradeDate, startDate, endDate, assetCode, pluginId, direction, gradeTab]);
  const lastQueriedFilterKey = useRef<string>(filterKey);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (lastQueriedFilterKey.current === filterKey) return;
      lastQueriedFilterKey.current = filterKey;
      void fetchSignals(1);
    }, FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  /**
   * 【查询】按钮：立刻按当前条件重查（不等防抖）
   *
   * - 筛选条件**变了** → 回到第 1 页（否则可能在空页上）；
   * - 条件没变 → 刷新当前页（手动刷新语义）。
   */
  const handleQuery = () => {
    const filterChanged = lastQueriedFilterKey.current !== filterKey;
    lastQueriedFilterKey.current = filterKey;
    void fetchSignals(filterChanged ? 1 : page);
  };

  /**
   * 是否处于「默认视角」（**所有筛选条件都没填**）—— 决定空态文案
   *
   * 🔴 F 域 P0-1：不再用「日期 == 今天」判断。默认视角 = 完全没筛选，
   *   此时后端按「最近有信号日 → 最近行情日 → 今天」解析，空态必须写明
   *   **行情最新日期**，否则用户会以为是「今天没信号」而不是「行情还没更新」。
   */
  const isDefaultView =
    !tradeDate && !startDate && !endDate && !assetCode.trim() && !pluginId.trim() && !direction;

  /** 空态主文案（F 域 P0-1：默认视角必须带上「行情最新 YYYY-MM-DD」） */
  const emptyText = isDefaultView
    ? resolvedSource === 'today'
      ? '尚未生成任何策略信号（行情库暂不可用）'
      : resolvedSource === 'quote'
        ? `行情最新 ${latestQuoteDate ?? resolvedDate ?? '--'}，暂无策略信号`
        : `最近有信号日 ${resolvedDate ?? '--'} 暂无符合条件的策略信号`
    : resolvedDate
      ? `交易日 ${resolvedDate} 暂无符合条件的策略信号`
      : '暂无符合条件的策略信号';

  /** 默认日期来源的中文标签（与筛选栏旁注、列表态旁注共用同一口径）*/
  const dateSourceLabel =
    resolvedSource === 'signal' ? '最近有信号日' : resolvedSource === 'quote' ? '行情最新日' : '兜底交易日';

  /** 摘要区的日期来源标签（显式筛选时是「指定日期」，故比主列表多一档）*/
  const top5SourceLabel =
    top5Source === 'signal'
      ? '最近有信号日'
      : top5Source === 'quote'
        ? '行情最新日'
        : top5Source === 'today'
          ? '兜底交易日'
          : '指定日期';

  /** 列表里是否有「非当前展示日」的行（决定是否显示灰显说明）*/
  const hasOtherDayRows =
    resolvedDate !== null &&
    rows.some((r) => typeof r.trade_date === 'string' && r.trade_date !== resolvedDate);

  /** F1：东八区今天，用于判断 `expires_at` 是否已过期（过期置灰不删）*/
  const today = todayInShanghai();

  const filterLabelStyle: React.CSSProperties = {
    fontSize: TYPO.bodySize,
    color: COLORS.textSecondary,
  };

  return (
    <div style={pageContainerStyle}>
      <h1 style={titleStyle}>策略信号</h1>

      {/*
        筛选栏（T72 ④⑤）
        ⚠️ **条件之间是 AND 关系**（后端 WHERE 逐条 append）——
           「交易日期」与「起始/结束日期」同时给会取交集。
      */}
      <div
        style={{
          ...cardStyle,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <label htmlFor="signals-trade-date" style={filterLabelStyle}>
          交易日期
        </label>
        <input
          id="signals-trade-date"
          style={inputStyle}
          type="date"
          value={tradeDate}
          onChange={(e) => setTradeDate(e.target.value)}
        />
        {!tradeDate && resolvedDate ? (
          <span
            data-testid="signals-default-date-hint"
            style={{ color: COLORS.textMuted, fontSize: TYPO.smallSize }}
          >
            未选日期时展示最近信号（
            {resolvedSource === 'signal'
              ? '最近有信号日'
              : resolvedSource === 'quote'
                ? '行情最新'
                : '兜底交易日'}
            {` ${latestQuoteDate ?? resolvedDate}`}）
          </span>
        ) : null}

        <label htmlFor="signals-start-date" style={filterLabelStyle}>
          起始日期
        </label>
        <input
          id="signals-start-date"
          style={inputStyle}
          type="date"
          value={startDate}
          max={endDate || undefined}
          onChange={(e) => setStartDate(e.target.value)}
        />

        <label htmlFor="signals-end-date" style={filterLabelStyle}>
          结束日期
        </label>
        <input
          id="signals-end-date"
          style={inputStyle}
          type="date"
          value={endDate}
          min={startDate || undefined}
          onChange={(e) => setEndDate(e.target.value)}
        />

        <label htmlFor="signals-asset-code" style={filterLabelStyle}>
          标的代码
        </label>
        <input
          id="signals-asset-code"
          style={inputStyle}
          type="text"
          placeholder="代码精确匹配"
          value={assetCode}
          onChange={(e) => setAssetCode(e.target.value)}
        />

        <label htmlFor="signals-plugin-id" style={filterLabelStyle}>
          策略名称
        </label>
        <input
          id="signals-plugin-id"
          style={inputStyle}
          type="text"
          placeholder="可选"
          value={pluginId}
          onChange={(e) => setPluginId(e.target.value)}
        />

        <label htmlFor="signals-direction" style={filterLabelStyle}>
          方向
        </label>
        <select
          id="signals-direction"
          style={inputStyle}
          value={direction}
          onChange={(e) => setDirection(e.target.value)}
        >
          <option value="">全部</option>
          <option value="buy">买入</option>
          <option value="sell">卖出</option>
          <option value="hold">持仓</option>
        </select>

        {/*
          ⚠️ **按钮文案恒为「查询」** —— 加载中不改成「查询中...」：
          可访问名（accessible name）**不应随状态变化**，否则读屏用户与
          `getByRole('button', {name:'查询'})` 都会在加载瞬间失去目标。
          加载态用 `aria-busy` + `disabled` + 结果区 Spinner 表达。
        */}
        <button style={buttonStyle} onClick={handleQuery} disabled={loading} aria-busy={loading}>
          查询
        </button>
      </div>

      {/*
        F1：分级 tab（PRD_v3 §4.2）
        ⚠️ **默认只看强**（用户口径）；切 tab 走防抖即时重查，并回到第 1 页。
      */}
      <div
        role="group"
        aria-label="信号分级筛选"
        data-testid="signals-grade-tabs"
        style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
      >
        <span style={filterLabelStyle}>分级</span>
        {GRADE_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            aria-pressed={gradeTab === tab.key}
            data-testid={`signals-grade-tab-${tab.key}`}
            onClick={() => setGradeTab(tab.key)}
            style={{
              ...buttonStyle,
              background: gradeTab === tab.key ? COLORS.brand : COLORS.bgPillNeutral,
              color: gradeTab === tab.key ? COLORS.cardBg : COLORS.textPillNeutral,
            }}
          >
            {tab.label}
          </button>
        ))}
        <span style={{ fontSize: TYPO.smallSize, color: COLORS.textMuted }}>
          默认只看强信号；过期信号置灰不删
        </span>
      </div>

      {error && <div style={errorStyle}>{error}</div>}

      {/* F3：今日 Top 5 摘要区（与主列表同屏，先回答「哪几条最值得看」） */}
      <div style={cardStyle} aria-busy={top5Loading} data-testid="signals-top5-summary">
        <div style={{ ...cardTitleStyle, border: 'none', margin: 0, padding: 0 }}>今日 Top 5 摘要</div>
        {top5TradeDate ? (
          <div
            data-testid="signals-top5-date-note"
            style={{
              fontSize: TYPO.smallSize,
              color: COLORS.neutral,
              marginTop: SPACING.gapTight,
              marginBottom: SPACING.gapBase,
            }}
          >
            {`摘要交易日 ${top5TradeDate}（${top5SourceLabel}）`}
          </div>
        ) : null}
        {top5Loading ? (
          <Spinner />
        ) : top5Rows.length === 0 ? (
          <div data-testid="signals-top5-empty" style={{ color: COLORS.textMuted, fontSize: TYPO.bodySize }}>
            该交易日暂无信号
          </div>
        ) : (
          <ScrollableTable label="今日 Top 5 摘要表">
            <table style={tableStyle} aria-label="今日 Top 5 摘要">
              <thead>
                <tr>
                  <th scope="col" style={thStyle}>
                    排名
                  </th>
                  <th scope="col" style={thStyle}>
                    标的代码
                  </th>
                  <th scope="col" style={thStyle}>
                    策略
                  </th>
                  <th scope="col" style={thStyle}>
                    方向
                  </th>
                  <th scope="col" style={thStyle}>
                    分级
                  </th>
                  <th scope="col" style={thStyle}>
                    强度
                  </th>
                  <th scope="col" style={thStyle}>
                    标签
                  </th>
                </tr>
              </thead>
              <tbody>
                {top5Rows.map((row, i) => {
                  const code = assetCodeOf(row);
                  return (
                    <tr key={typeof row.id === 'number' ? `top5-${row.id}` : `top5-${i}`}>
                      <td style={thTdStyle}>{i + 1}</td>
                      <td style={thTdStyle}>
                        <code>{code}</code>
                      </td>
                      <td style={thTdStyle}>
                        <code>{typeof row.plugin_id === 'string' ? row.plugin_id : '--'}</code>
                      </td>
                      <td style={thTdStyle}>
                        <SignalDirectionPill
                          direction={typeof row.direction === 'string' ? row.direction : 'hold'}
                        />
                      </td>
                      <td style={thTdStyle}>
                        {/* F1：Top 5 可含中/弱，用分级 tag 保证「一眼看出不是强档」 */}
                        <SignalGradeTag grade={typeof row.grade === 'string' ? row.grade : null} />
                      </td>
                      <td style={thTdStyle}>
                        <SignalStrength
                          value={typeof row.strength === 'number' ? row.strength : null}
                          label={`${code} 信号强度`}
                        />
                      </td>
                      <td style={thTdStyle}>
                        <SignalLabelTag label={typeof row.label === 'string' ? row.label : null} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollableTable>
        )}
      </div>

      {/* V3.8 T149：操作反馈（采纳/忽略/关联） */}
      {actMsg && (
        <div
          style={{
            fontSize: TYPO.smallSize,
            color: actMsg.includes('失败') || actMsg.includes('非法') ? COLORS.danger : COLORS.success,
          }}
        >
          {actMsg}
        </div>
      )}

      {/* F2：关联成交详情（读取侧）—— 点「查看成交」后展开，不跳页 */}
      {tradeDetail ? (
        <div
          data-testid="signal-trade-detail"
          style={{
            ...cardStyle,
            marginBottom: SPACING.gapTight,
            fontSize: TYPO.smallSize,
            lineHeight: 1.8,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>信号 #{tradeDetail.signal_id} 的关联成交</strong>
            <button
              style={{ ...buttonStyle, padding: '2px 8px', fontSize: TYPO.captionSize }}
              onClick={() => setTradeDetail(null)}
            >
              关闭
            </button>
          </div>
          {tradeDetailLoading ? (
            <div style={{ color: COLORS.textMuted }}>加载中…</div>
          ) : tradeDetail.trade ? (
            <div>
              <div>
                {`成交 #${tradeDetail.trade.id} · ${tradeDetail.trade.asset_code} · ${TRADE_DIRECTION_LABEL[tradeDetail.trade.direction] ?? tradeDetail.trade.direction}（${tradeDetail.trade.trade_type}）`}
              </div>
              <div>
                {`成交日 ${tradeDetail.trade.trade_date}${tradeDetail.trade.trade_time ? ' ' + tradeDetail.trade.trade_time : ''}；数量 ${tradeDetail.trade.quantity}；价格 ${tradeDetail.trade.price}`}
              </div>
              <div>
                {`成交金额 ¥${tradeDetail.trade.amount.toFixed(2)}；费用 ¥${tradeDetail.trade.fee.toFixed(2)}`}
              </div>
              <div data-testid="signal-trade-pnl">
                {tradeDetail.trade.realized_pnl != null
                  ? `已实现盈亏 ¥${tradeDetail.trade.realized_pnl.toFixed(2)}`
                  : '已实现盈亏：不可得（买入未平仓或权益类交易）'}
              </div>
            </div>
          ) : tradeDetail.link_broken ? (
            <div style={{ color: COLORS.danger }}>关联的成交已被删除（关联断链），请重新关联</div>
          ) : (
            <div style={{ color: COLORS.textMuted }}>该信号尚未关联成交</div>
          )}
        </div>
      ) : null}

      <div style={cardStyle} aria-busy={loading}>
        {loading && rows.length === 0 ? (
          <Spinner />
        ) : rows.length === 0 ? (
          /*
            空态（T72 ①：删掉「请点击查询按钮加载数据」）
            ⚠️ **17:02 是信号生成的时刻**（SDD §5.1 / `scheduler.ts:126` 的 `'2 17 * * 1-5'`），
               17:03 是除权导入 —— 写成 17:03 是**面向用户的错误文案**。
          */
          <div data-testid="signals-empty" style={{ padding: 20, textAlign: 'center' }}>
            <div style={{ color: COLORS.neutral, fontSize: TYPO.bodySize }}>{emptyText}</div>
            <div style={{ color: COLORS.textMuted, fontSize: TYPO.smallSize, marginTop: 4 }}>
              收盘后 17:02 自动运行信号生成
            </div>
            {/*
              T79 ③：管理员额外入口 —— 空态时可直接去 Admin 手动触发，
              普通用户看不到运维按钮。
            */}
            {role === 'admin' && (
              <button
                type="button"
                data-testid="signals-run-now"
                onClick={() => navigate('/admin')}
                style={{ ...buttonStyle, marginTop: SPACING.gapBase }}
              >
                立即运行信号
              </button>
            )}
          </div>
        ) : (
          <>
            {/*
              当前展示日旁注（F 域 P0-1 的可见性补齐）
              ⚠️ 只做展示：`resolvedDate` 由后端解析，前端不参与默认日期口径；
                 行情最新日走只读 `/api/market/latest-date`，取不到时该段自动省略。
            */}
            {resolvedDate ? (
              <div
                data-testid="signals-display-date-note"
                style={{
                  fontSize: TYPO.smallSize,
                  color: COLORS.neutral,
                  marginBottom: SPACING.gapTight,
                }}
              >
                当前展示日 <b>{resolvedDate}</b>（{dateSourceLabel}）
                {marketQuoteDate && marketQuoteDate !== resolvedDate
                  ? ` · 行情最新 ${marketQuoteDate}（默认优先取「最近有信号日」，可能早于行情最新日）`
                  : resolvedSource === 'quote'
                    ? ' · 尚无策略信号，取行情最新日'
                    : resolvedSource === 'today'
                      ? ' · 行情库暂不可用'
                      : ''}
              </div>
            ) : (
              <div
                style={{
                  fontSize: TYPO.smallSize,
                  color: COLORS.neutral,
                  marginBottom: SPACING.gapTight,
                }}
              >
                按交易日升序排列
              </div>
            )}
            {hasOtherDayRows ? (
              <div
                data-testid="signals-gray-legend"
                style={{
                  fontSize: TYPO.smallSize,
                  color: COLORS.textMuted,
                  marginBottom: SPACING.gapBase,
                }}
              >
                {`灰显行 = 其它交易日的信号（非当前展示日 ${resolvedDate ?? '--'}）；按「交易日期」筛选可只看单日`}
              </div>
            ) : null}
            {/*
              F6：冷却旁注 —— 明示「合并只是展示层」，信号生成/交易链路一条不少
            */}
            <div
              data-testid="signals-cooldown-note"
              style={{
                fontSize: TYPO.smallSize,
                color: COLORS.textMuted,
                marginBottom: SPACING.gapTight,
              }}
            >
              {`冷却 ${cooldownBars} 根 K 线内，同策略 + 同标的 + 同方向的重复信号已合并为一条（仅展示层去重，不影响信号生成与交易链路）`}
            </div>
            {/*
              表格用 `ScrollableTable` 包一层 —— 表格在**自己内部**横向滚动，
              不会把文档撑宽（G3.5 / G4.6 的 375px 无横向溢出判据）。
            */}
            <ScrollableTable label="策略信号列表表">
              <table style={tableStyle} aria-label="策略信号列表">
                <thead>
                  <tr>
                    <th scope="col" style={thStyle}>
                      标的代码
                    </th>
                    <th scope="col" style={thStyle}>
                      策略
                    </th>
                    <th scope="col" style={thStyle}>
                      方向
                    </th>
                    <th scope="col" style={thStyle}>
                      分级
                    </th>
                    <th scope="col" style={thStyle}>
                      强度
                    </th>
                    <th scope="col" style={thStyle}>
                      标签
                    </th>
                    <th scope="col" style={thStyle}>
                      交易日期
                    </th>
                    {/* F2：处理状态（已成交 / 已忽略 / 已采纳 / 未处理） */}
                    <th scope="col" style={thStyle}>
                      状态
                    </th>
                    {/* V3.8 T149：信号生命周期操作（采纳/忽略/关联交易，PRD_v3 §4.2） */}
                    <th scope="col" style={thStyle}>
                      操作
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => {
                    const code = assetCodeOf(row);
                    const category =
                      typeof row.plugin_category === 'string'
                        ? PLUGIN_CATEGORY_LABEL[row.plugin_category]
                        : undefined;
                    /**
                     * 非当前展示日 → 灰显（见列表上方 `signals-gray-legend`）
                     *
                     * ⚠️ 仅在后端已解析出展示日（默认视角）时生效；显式筛选下
                     *    `resolvedDate` 为 null，不做任何灰显。
                     */
                    const isOtherDay =
                      resolvedDate !== null &&
                      typeof row.trade_date === 'string' &&
                      row.trade_date !== resolvedDate;
                    /**
                     * F1：过期判断 —— `expires_at < 今天` 即过期。
                     * **置灰不删**：行照常渲染，标注「生成于 X 天前」，让用户知道它失效了。
                     */
                    const expiresAt = typeof row.expires_at === 'string' ? row.expires_at : null;
                    const isExpired = expiresAt !== null && expiresAt < today;
                    const generatedDaysAgo =
                      isExpired && typeof row.trade_date === 'string'
                        ? daysSince(row.trade_date, today)
                        : null;
                    const muted = isOtherDay || isExpired;
                    return (
                      <tr
                        key={typeof row.id === 'number' ? row.id : i}
                        data-testid={isExpired ? 'signals-row-expired' : undefined}
                        style={muted ? { color: COLORS.textMuted, opacity: isExpired ? 0.6 : 1 } : undefined}
                        title={
                          isExpired
                            ? `已过期（有效期至 ${expiresAt}）`
                            : isOtherDay
                              ? `历史信号（${row.trade_date}），非当前展示日 ${resolvedDate}`
                              : undefined
                        }
                      >
                        <td style={thTdStyle}>
                          <code>{code}</code>
                        </td>
                        <td style={thTdStyle}>
                          <code>{typeof row.plugin_id === 'string' ? row.plugin_id : '--'}</code>
                          {category ? (
                            <span style={{ color: COLORS.textMuted, fontSize: TYPO.captionSize }}>
                              {' '}
                              {category}
                            </span>
                          ) : null}
                        </td>
                        <td style={thTdStyle}>
                          <SignalDirectionPill
                            direction={typeof row.direction === 'string' ? row.direction : 'hold'}
                          />
                        </td>
                        <td style={thTdStyle}>
                          <SignalGradeTag grade={typeof row.grade === 'string' ? row.grade : null} />
                        </td>
                        <td style={thTdStyle}>
                          <SignalStrength
                            value={typeof row.strength === 'number' ? row.strength : null}
                            label={`${code} 信号强度`}
                          />
                        </td>
                        <td style={thTdStyle}>
                          <SignalLabelTag label={typeof row.label === 'string' ? row.label : null} />
                          {/* F6：冷却窗口内被合并 → 标注「连续第 N 日选中」 */}
                          {typeof row.consecutive_days === 'number' && row.consecutive_days >= 2 ? (
                            <span
                              data-testid="signals-consecutive-count"
                              style={{
                                display: 'block',
                                fontSize: TYPO.captionSize,
                                color: COLORS.textMuted,
                              }}
                            >
                              {`连续第 ${row.consecutive_days} 日选中`}
                            </span>
                          ) : null}
                        </td>
                        <td style={thTdStyle}>
                          {typeof row.trade_date === 'string' ? row.trade_date : '--'}
                          {/* F1：过期行标注「生成于 X 天前」（置灰不删，信息不丢） */}
                          {generatedDaysAgo !== null ? (
                            <span
                              data-testid="signals-expired-age"
                              style={{
                                display: 'block',
                                fontSize: TYPO.captionSize,
                                color: COLORS.textMuted,
                              }}
                            >
                              生成于 {generatedDaysAgo} 天前
                            </span>
                          ) : null}
                        </td>
                        {/* F2：状态 tag（后端派生；断链不显示「查看成交」） */}
                        <td style={thTdStyle}>
                          <SignalTradeStatusTag status={row.trade_status} />
                          {row.trade_status === 'traded' && row.link_broken !== true ? (
                            <button
                              data-testid="signal-trade-view"
                              style={{
                                ...buttonStyle,
                                marginTop: 4,
                                padding: '2px 8px',
                                fontSize: TYPO.captionSize,
                              }}
                              onClick={() => {
                                if (typeof row.id === 'number') void openTradeDetail(row.id);
                              }}
                            >
                              查看成交
                            </button>
                          ) : null}
                        </td>
                        {/* V3.8 T149：采纳/忽略/关联交易（过期信号仍可标注，标灰由后端 T134 的 expires_at 承担） */}
                        <td style={thTdStyle}>
                          {typeof row.id === 'number' ? (
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button
                                style={{ ...buttonStyle, padding: '2px 8px', fontSize: TYPO.captionSize }}
                                disabled={Boolean(row.adopted)}
                                onClick={() => void signalAction(row.id!, 'adopt')}
                              >
                                {row.adopted ? '已采纳' : '采纳'}
                              </button>
                              <button
                                style={{ ...buttonStyle, padding: '2px 8px', fontSize: TYPO.captionSize }}
                                disabled={Boolean(row.ignored)}
                                onClick={() => void signalAction(row.id!, 'ignore')}
                              >
                                {row.ignored ? '已忽略' : '忽略'}
                              </button>
                              <button
                                style={{ ...buttonStyle, padding: '2px 8px', fontSize: TYPO.captionSize }}
                                onClick={() => void linkTrade(row.id!)}
                              >
                                关联交易
                              </button>
                              {/* F2：未成交 → 跳转交易录入并预填 signal_id（录入时自动回填关联） */}
                              {row.trade_status !== 'traded' || row.link_broken === true ? (
                                <button
                                  data-testid="signal-trade-entry"
                                  style={{ ...buttonStyle, padding: '2px 8px', fontSize: TYPO.captionSize }}
                                  onClick={() => navigate(`/trade?signal_id=${row.id}`)}
                                >
                                  录入交易
                                </button>
                              ) : null}
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </ScrollableTable>

            {/* 分页（T72 ③）*/}
            {total > 0 && (
              <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
                <button style={buttonStyle} disabled={page <= 1} onClick={() => void fetchSignals(page - 1)}>
                  上一页
                </button>
                <span style={{ fontSize: TYPO.bodySize }}>
                  第 {page} / {totalPages} 页，共 {total} 条
                </span>
                <button
                  style={buttonStyle}
                  disabled={page >= totalPages}
                  onClick={() => void fetchSignals(page + 1)}
                >
                  下一页
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
