import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { isOkEnvelope } from '../api/envelope';
import { extractErrorMessage } from '../api/errors';
import { COLORS, SPACING, TYPO } from '../theme/tokens';
import Spinner from '../components/Spinner';
import ScrollableTable from '../components/ScrollableTable';
import { SignalDirectionPill, SignalLabelTag } from '../components/SignalPills';
import { SignalStrength } from '../components/SignalStrength';
import {
  pageContainerStyle,
  cardStyle,
  titleStyle,
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
  trade_date?: string;
  [key: string]: unknown;
}

/** 插件类别 → 中文（`monitor` = 监控类 / `filter` = 筛选类，Requirements §5.5）*/
const PLUGIN_CATEGORY_LABEL: Record<string, string> = {
  monitor: '监控',
  filter: '选股',
};

function todayStr(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** 取一行的标的代码（`asset_code` 优先，兼容旧别名 `symbol`）*/
function assetCodeOf(row: SignalRow): string {
  const code = row.asset_code ?? row.symbol;
  return typeof code === 'string' && code !== '' ? code : '--';
}

export default function Signals() {
  // ── 筛选条件 ────────────────────────────────────────────────
  /** 交易日期（单日精确匹配）；默认今天 —— 与「进页自动加载（今日）」一致 */
  const [tradeDate, setTradeDate] = useState<string>(todayStr());
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [assetCode, setAssetCode] = useState<string>('');
  const [pluginId, setPluginId] = useState<string>('');
  const [direction, setDirection] = useState<string>('');

  // ── 数据与分页 ──────────────────────────────────────────────
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<SignalRow[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

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

      const res = await api.get('/signal', { params });
      if (isOkEnvelope(res.data)) {
        setRows((res.data.data ?? []) as SignalRow[]);
        // T72 ③：后端已经返回分页元信息（旧实现把它整个丢了）
        setTotalPages(res.data.pagination?.totalPages ?? 1);
        setTotal(res.data.pagination?.total ?? 0);
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

  /**
   * 筛选即时生效（T72 ④）：改完筛选条件 300ms 后自动重查，**回到第 1 页**
   *
   * ⚠️ `lastQueriedFilterKey` 初始化为**挂载时的筛选指纹**，
   *    故挂载那一次不会重复触发（挂载 effect 已经查过第 1 页）。
   * ⚠️ 指纹比对放在 **timer 回调内** —— 这样「点【查询】按钮」先把指纹写进去，
   *    300ms 后到期的防抖就会自己跳过，**不会重复发两次请求**。
   */
  const filterKey = JSON.stringify([tradeDate, startDate, endDate, assetCode, pluginId, direction]);
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

  /** 是否处于「默认视角」（今日 + 无区间）—— 决定空态文案 */
  const isTodayView = tradeDate === todayStr() && !startDate && !endDate;

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

      {error && <div style={errorStyle}>{error}</div>}

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
            <div style={{ color: COLORS.neutral, fontSize: TYPO.bodySize }}>
              {isTodayView ? '今日暂无策略信号' : '暂无策略信号'}
            </div>
            <div style={{ color: COLORS.textMuted, fontSize: TYPO.smallSize, marginTop: 4 }}>
              收盘后 17:02 自动运行信号生成
            </div>
          </div>
        ) : (
          <>
            <div
              style={{
                fontSize: TYPO.smallSize,
                color: COLORS.neutral,
                marginBottom: SPACING.gapBase,
              }}
            >
              按交易日升序排列
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
                      强度
                    </th>
                    <th scope="col" style={thStyle}>
                      标签
                    </th>
                    <th scope="col" style={thStyle}>
                      交易日期
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
                    return (
                      <tr key={typeof row.id === 'number' ? row.id : i}>
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
                          <SignalStrength
                            value={typeof row.strength === 'number' ? row.strength : null}
                            label={`${code} 信号强度`}
                          />
                        </td>
                        <td style={thTdStyle}>
                          <SignalLabelTag label={typeof row.label === 'string' ? row.label : null} />
                        </td>
                        <td style={thTdStyle}>
                          {typeof row.trade_date === 'string' ? row.trade_date : '--'}
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
