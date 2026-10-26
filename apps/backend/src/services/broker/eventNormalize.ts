/**
 * T123（V3.1）事件归一化 —— SDD_v3 §4（13 种 + UNKNOWN；短词型 + 长描述四段）
 *
 * 硬约束：
 * - `raw_event_type` 必须保留（§4.2.3 / INV-S2-7）；未知组合 → UNKNOWN + 原文，**不得丢弃**
 * - 排除项（场外/占位/忽略）**仍进事实层**并标 `exclude_reason`（§4.3，对账归因用）
 * - 「融券 / 融券购回」确定映射 REPO（owner 确认全账户为普通账户；实测 360 行全指向
 *   逆回购品种 204001/131810；将来接信用账户须重新引入账户类型维度）
 * - 品种维度直接决定现金类：货币ETF → CASH_LIKE_ETF；跨境ETF/黄金ETF → 风险（跨境维度须标记）
 */

export type BrokerEventType =
  | 'TRADE_BUY'
  | 'TRADE_SELL'
  | 'FUND_SUBSCRIBE'
  | 'FUND_REDEEM'
  | 'DIVIDEND_CASH'
  | 'DIVIDEND_BONUS'
  | 'TRANSFER_IN'
  | 'MARGIN_SHORT'
  | 'MARGIN_REPAY'
  | 'REPO'
  | 'CASH_LIKE_ETF'
  | 'EXCLUDED_OFFEXCHANGE'
  | 'PLACEHOLDER'
  | 'IGNORE'
  | 'UNKNOWN';

export interface NormalizedEvent {
  event_type: BrokerEventType;
  raw_event_type: string; // 原文（去包裹后），未知时保留
  /** 排除项 / 忽略项的原因（§4.3；非排除项为 undefined） */
  exclude_reason?: string;
  /** 解析出的市场维度（沪/深），长描述型可得 */
  market?: 'SH' | 'SZ';
  /** 品种维度（长描述型） */
  product?: string;
  /** 跨境标记（策略适用品种维度用，SDD §10.3） */
  crossBorder?: boolean;
}

/** 短词型映射（券商甲系，SDD §4.2.1 实测 11 词 + 扩展） */
const SHORT_WORD_MAP: Record<string, { type: BrokerEventType; excludeReason?: string }> = {
  买入: { type: 'TRADE_BUY' },
  卖出: { type: 'TRADE_SELL' },
  盘后定价买入: { type: 'TRADE_BUY' },
  盘后定价卖出: { type: 'TRADE_SELL' },
  调帐转入: { type: 'TRANSFER_IN' },
  调账转入: { type: 'TRANSFER_IN' },
  红利: { type: 'DIVIDEND_CASH' },
  股息红利: { type: 'DIVIDEND_CASH' },
  送股: { type: 'DIVIDEND_BONUS' },
  分红: { type: 'DIVIDEND_CASH' },
  融券: { type: 'REPO', excludeReason: '普通账户实测：逆回购出资腿（非信用融券，见 ADR-013）' },
  融券购回: { type: 'REPO', excludeReason: '普通账户实测：逆回购收回腿' },
  基金申购: { type: 'EXCLUDED_OFFEXCHANGE', excludeReason: '场外 LOF 申购（净值与场内价格不同源，ADR-013）' },
  指定: { type: 'PLACEHOLDER', excludeReason: '指定登记占位（无交易语义）' },
  股息税: { type: 'IGNORE', excludeReason: '红利税扣缴（费用项，非独立事件）' },
  证券过户: { type: 'TRANSFER_IN' },
};

/** 长描述品种词（实测全量：A股普通股票/A股股份/A股红利/跨市场股票ETF/单市场股票ETF/跨境ETF/货币ETF/单市场债券ETF/黄金ETF/LOF基金/基金） */
const PRODUCTS = [
  'A股普通股票',
  'A股股份',
  'A股红利',
  '跨市场股票ETF',
  '单市场股票ETF',
  '跨境ETF',
  '货币ETF',
  '单市场债券ETF',
  '黄金ETF',
  'LOF基金',
  '基金',
] as const;

const MARKET_RE = /^(上海|深圳)/;

/** 去包裹残留（解析器已去一次，此处防御二次出现） */
function clean(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('="') && s.endsWith('"')) s = s.slice(2, -1);
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) s = s.slice(1, -1);
  return s.trim();
}

export function normalizeEvent(rawInput: string, _ctx?: { symbol?: string }): NormalizedEvent {
  const raw = clean(rawInput);
  const base = { raw_event_type: raw };

  // ① 短词型精确命中
  const short = SHORT_WORD_MAP[raw];
  if (short) {
    return { event_type: short.type, exclude_reason: short.excludeReason, ...base };
  }

  // ② 长描述型四段解析：市场 + 品种 + 方向（+ 方式）
  const mRaw = MARKET_RE.exec(raw);
  const market: 'SH' | 'SZ' | undefined = mRaw ? (mRaw[1] === '上海' ? 'SH' : 'SZ') : undefined;
  let rest = mRaw ? raw.slice(mRaw[0].length) : raw;
  for (const p of PRODUCTS) {
    if (rest.startsWith(p)) {
      const dir = rest.slice(p.length).trim();
      const product = p;
      rest = '';
      // 品种直接决定现金类（SDD §4.2.2）
      if (product === '货币ETF') {
        return {
          event_type: 'CASH_LIKE_ETF',
          market,
          product,
          crossBorder: false,
          ...base,
        };
      }
      const crossBorder = product === '跨境ETF';
      // 「A股红利」是事件词（红利入账的旧式表述），直接定案
      if (product === 'A股红利') {
        return { event_type: 'DIVIDEND_CASH', market, product, crossBorder, ...base };
      }
      // 方向词
      if (/^(竞价|盘后(定价)?)?(买入|买)$/.test(dir) || dir === '申购确认') {
        // 「申购确认」= 场内 LOF/ETF 申购（成交价即净值，数量×价格=成交金额恒等，owner 决策）→ 按买入
        return { event_type: 'TRADE_BUY', market, product, crossBorder, ...base };
      }
      if (dir === '卖出' || dir === '现金赎回' || /^竞价卖出$/.test(dir) || /^盘后卖出$/.test(dir)) {
        return { event_type: 'TRADE_SELL', market, product, crossBorder, ...base };
      }
      if (dir === '现金申购') {
        return { event_type: 'FUND_SUBSCRIBE', market, product, crossBorder, ...base };
      }
      if (dir === '现金分红' || dir === '红利入账') {
        return { event_type: 'DIVIDEND_CASH', market, product, crossBorder, ...base };
      }
      if (dir === '分拆折算份额计增') {
        return { event_type: 'DIVIDEND_BONUS', market, product, crossBorder, ...base };
      }
      if (dir === '特殊调账调入') {
        return { event_type: 'TRANSFER_IN', market, product, crossBorder, ...base };
      }
      // 货币 ETF 申赎结算子事件（现金替代退款 / 现金差额扣款）→ 仍属现金类
      if (dir === '现金替代退款' || dir === '现金差额扣款') {
        return { event_type: 'CASH_LIKE_ETF', market, product, crossBorder, ...base };
      }
      // 方向词未识别 ⇒ UNKNOWN（保留原文，INV-S2-7）
      return { event_type: 'UNKNOWN', market, product, crossBorder, ...base };
    }
  }
  void rest;

  // ③ 品种在 ctx 可推断（无长描述前缀）—— 不猜测，UNKNOWN
  return { event_type: 'UNKNOWN', market, ...base };
}

/** 该事件是否进系统记录（业务层）：排除项 = 场外/占位/忽略（仍进事实层，§4.3） */
export function isExcludedFromSystemRecord(e: NormalizedEvent): boolean {
  return (
    e.event_type === 'EXCLUDED_OFFEXCHANGE' || e.event_type === 'PLACEHOLDER' || e.event_type === 'IGNORE'
  );
}
