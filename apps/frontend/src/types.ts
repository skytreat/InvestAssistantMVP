export interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface UserInfo {
  id: number;
  username: string;
  role: 'user' | 'admin';
}

export interface TradeRecord {
  id: number;
  asset_code: string;
  trade_type: string;
  trade_date: string;
  quantity: number;
  price: number;
  fee: number;
  remark: string | null;
}

export interface Position {
  asset_code: string;
  totalQuantity: number;
  avgCost: number;
  totalCostBasis: number;
  realizedPnL: number;
  totalFee: number;
}

export interface StrategySignal {
  id: number;
  symbol: string;
  plugin_id: string;
  plugin_category: string;
  direction: string;
  label: string;
  strength: number | null;
  trade_date: string;
  created_at: string;
}

export interface SystemLog {
  id: number;
  log_type: string;
  level: string;
  message: string;
  detail: string | null;
  log_date: string;
  created_at: string;
}

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface PositionResult {
  totalQuantity: number;
  avgCost: number;
  totalCostBasis: number;
  realizedPnL: number;
  totalFee: number;
}
