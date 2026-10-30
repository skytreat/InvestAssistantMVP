/**
 * K 线交易标记（T152 / SDD_v3 §9.9）
 *
 * 职责边界：
 * - **只读** `user_trade_record`，按该用户该标的的**全历史活记录**回放持仓；
 * - 4 类买卖标记（open/add/reduce/close）由「交易发生前持仓」推导，
 *   **不改写**原始 `trade_type`（手工录入的用户选择 / T129 导入推导都不是展示层的事）；
 * - 分红 / 送股 / 转增参与持仓回放，但不输出标记；transfer 不改变持仓；
 * - 全部买卖记录（含窗口外）都参与回放，避免「窗口首日买入」被误判为建仓。
 *
 * ⚠️ 本模块 **不碰 DuckDB**：复权因子由路由从 K 线查询结果传入。
 */
import { ConfigStore } from '../config/configStore.js';

export type FqMode = 'qfq' | 'bfq' | 'hfq' | 'raw';

export type KlineTradeMarkerType = 'open' | 'add' | 'reduce' | 'close';

/** 回放输入：SQLite 一行活交易记录（只取回放需要的列） */
export interface ReplayTradeRow {
  id: number;
  trade_type: string;
  trade_date: string;
  trade_time: string | null;
  quantity: number;
  price: number;
}

/** 返回给前端的标记 */
export interface KlineTradeMarker {
  id: number;
  trade_date: string;
  trade_time: string | null;
  /** 原始录入 / 导入类型，可能是 buy/add/reduce/clear */
  trade_type: string;
  /** 按发生前持仓推导出的展示类型 */
  marker_type: KlineTradeMarkerType;
  quantity: number;
  price: number;
  /** 当前 fq 口径的复权价；bfq/raw 等于 price */
  adj_price: number;
}

/** K 线窗口内的一个因子点；factor 允许 undefined（raw/bfq 或列缺失） */
export interface TradeFactorPoint {
  date: string;
  factor: number | null | undefined;
}

export interface AdjustedTradeMarkers {
  trades: KlineTradeMarker[];
  /** 无有效复权因子的交易日（去重、升序）；路由据此写 WARN */
  missingFactorDates: string[];
}

const EPSILON = 1e-9;

/**
 * 与 `@invest/core` 的 `calculateMovingWeightedCost` 同序：
 * bonus(0) < dividend(1) < 买卖(2)，同级按 trade_time / id 稳定排序。
 *
 * ⚠️ 不能用 `ORDER BY trade_time` 一把梭：送股/分红是 00:00:00 或 NULL，
 * 若排在买卖之后，会把「送股后卖出」误判为清仓（T152 测试覆盖）。
 */
function typePriority(tradeType: string): number {
  if (tradeType === 'bonus') return 0;
  if (tradeType === 'dividend') return 1;
  return 2;
}

function compareTradeRows(a: ReplayTradeRow, b: ReplayTradeRow): number {
  if (a.trade_date !== b.trade_date) return a.trade_date < b.trade_date ? -1 : 1;

  const pa = typePriority(a.trade_type);
  const pb = typePriority(b.trade_type);
  if (pa !== pb) return pa - pb;

  const ta = a.trade_time ?? '';
  const tb = b.trade_time ?? '';
  if (ta !== tb) return ta < tb ? -1 : 1;

  return a.id - b.id;
}

/**
 * 全历史回放 → 输出所有可展示的买卖标记（未筛窗口）。
 *
 * 回放口径与 `calcPosition` 一致：
 * - 买入类（buy/add）：持仓增加；
 * - 卖出类（reduce/clear）：按实际可卖数量扣减，超卖夹到 0（不产生负持仓）；
 * - bonus：送股增加数量；dividend：现金分红不改变数量；transfer：转托管不改变持仓。
 *
 * 空仓卖出的异常记录**不丢点**：reduce → reduce，clear → close。
 */
export function deriveTradeMarkers(rows: ReplayTradeRow[]): KlineTradeMarker[] {
  const sorted = [...rows].sort(compareTradeRows);

  let holding = 0;
  const markers: KlineTradeMarker[] = [];

  for (const row of sorted) {
    const quantity = Number(row.quantity);
    const price = Number(row.price);

    switch (row.trade_type) {
      case 'buy':
      case 'add': {
        const markerType: KlineTradeMarkerType = holding <= EPSILON ? 'open' : 'add';
        if (quantity > 0 && price > 0) {
          markers.push(toMarker(row, markerType));
        }
        holding += quantity;
        break;
      }
      case 'reduce':
      case 'clear': {
        let markerType: KlineTradeMarkerType;
        if (holding <= EPSILON) {
          // 脏数据兜底：不因空仓卖出丢掉标记；按原始类型给出最接近的展示类型
          markerType = row.trade_type === 'clear' ? 'close' : 'reduce';
        } else {
          const sold = Math.min(holding, quantity);
          holding -= sold;
          if (holding <= EPSILON) {
            holding = 0;
            markerType = 'close';
          } else {
            markerType = 'reduce';
          }
        }
        if (quantity > 0 && price > 0) {
          markers.push(toMarker(row, markerType));
        }
        break;
      }
      case 'bonus':
        holding += quantity;
        break;
      case 'dividend':
      case 'transfer':
      default:
        // dividend 不改变股数；transfer 不改变持仓；未知类型忽略（与 mapToCoreTrade 一致）
        break;
    }
  }

  return markers;
}

function toMarker(row: ReplayTradeRow, markerType: KlineTradeMarkerType): KlineTradeMarker {
  return {
    id: row.id,
    trade_date: row.trade_date,
    trade_time: row.trade_time,
    trade_type: row.trade_type,
    marker_type: markerType,
    quantity: Number(row.quantity),
    price: Number(row.price),
    adj_price: Number(row.price),
  };
}

/** 窗口筛选（含首尾），输入输出都保持升序 */
export function filterMarkersToWindow(
  markers: KlineTradeMarker[],
  startDate: string,
  endDate: string,
): KlineTradeMarker[] {
  return markers.filter((m) => m.trade_date >= startDate && m.trade_date <= endDate);
}

/**
 * 挂复权价。
 *
 * - qfq / hfq：`price × 交易日因子`；无当日行情时取**之前最近交易日**的因子；
 * - bfq / raw：不乘因子；
 * - 因子缺失 / 0 / NaN：回退 `price`，并返回缺失日期供路由写 WARN。
 */
export function attachAdjustedPrices(
  markers: KlineTradeMarker[],
  fq: FqMode,
  factors: TradeFactorPoint[],
): AdjustedTradeMarkers {
  if (fq === 'bfq' || fq === 'raw') {
    return {
      trades: markers.map((m) => ({ ...m, adj_price: m.price })),
      missingFactorDates: [],
    };
  }

  const sorted = [...factors].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const missing = new Set<string>();

  const trades = markers.map((m) => {
    const factor = findNearestPriorFactor(sorted, m.trade_date);
    if (factor === null || !Number.isFinite(factor) || factor <= 0) {
      missing.add(m.trade_date);
      return { ...m, adj_price: m.price };
    }
    // 保留 6 位小数，消除 10.5 × 1.1 = 11.550000000000001 这类浮点噪声
    return { ...m, adj_price: Number((m.price * factor).toFixed(6)) };
  });

  return { trades, missingFactorDates: [...missing].sort() };
}

function findNearestPriorFactor(sorted: TradeFactorPoint[], date: string): number | null {
  let lo = 0;
  let hi = sorted.length - 1;
  let found: TradeFactorPoint | null = null;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const point = sorted[mid] as TradeFactorPoint;
    if (point.date <= date) {
      found = point;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return found?.factor ?? null;
}

/**
 * 读取该用户该标的的**全部**活交易（含分红/送股），供全历史回放。
 *
 * ⚠️ 不按窗口过滤、不按 broker_code 分组 —— 持仓是该用户该标的的跨券商合并持仓，
 *    与 `calcPosition` 口径一致。`user_id` 必须由路由从 JWT 传入。
 */
export function loadKlineTradeMarkers(userId: number, assetCode: string): ReplayTradeRow[] {
  const db = ConfigStore.getInstance().db;
  return db
    .prepare(
      `SELECT id, trade_type, trade_date, trade_time, quantity, price
       FROM user_trade_record
       WHERE user_id = ? AND asset_code = ? AND is_deleted = 0
       ORDER BY trade_date ASC, trade_time ASC, id ASC`,
    )
    .all(userId, assetCode) as ReplayTradeRow[];
}
