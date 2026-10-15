/** 插件参数字段声明（SDD §5.3 ParamField） */
export interface ParamField {
  name: string;
  type: 'number' | 'string' | 'boolean' | 'integer';
  label: string;
  default?: number | string | boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  description?: string;
  required?: boolean;
}

/** 插件执行上下文 */
export interface PluginContext {
  /** 标的代码，如 sh600000 / sz000001 */
  symbol: string;
  /** 标的分类 */
  assetClass: 'stock' | 'etf' | 'index';
  /** 前复权 OHLCV 日线（日期从远到近） */
  klines: DailyKline[];
}

export interface DailyKline {
  date: string;       // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
}

/** 插件返回结果 */
export interface PluginSignal {
  direction: 'buy' | 'sell' | 'hold';
  label: string;
  strength?: number;  // 0-1
  metrics?: Record<string, number>;
}

/** 插件接口（沙盒中 execute 必须实现） */
export interface Plugin {
  readonly name: string;
  readonly pluginId: string;
  readonly category: 'monitor' | 'filter';
  readonly description?: string;
  readonly paramSchema: ParamField[];

  execute(ctx: PluginContext, params: Record<string, number | string | boolean>): PluginSignal | PluginSignal[] | Promise<PluginSignal | PluginSignal[]>;
}
