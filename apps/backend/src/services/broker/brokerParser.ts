/**
 * T121（V3.1）券商文件解析器 —— SDD_v3 §3（探测 / 编码 / 包裹 / 映射建议 / 敏感丢弃）
 *
 * 硬约束（AGENTS 铁律 + SDD）：
 * - 文件类型**按表头列名组合判定**，不认文件名 / 用户声明（§3.2）
 * - 表头**向下扫描定位**（实测国泰前 4 行为元数据，表头在第 5/6 行）（§3.7）
 * - 编码嗅探 BOM → 严格 UTF-8 → GB18030（§3.3）；GB18030 用**宽容**解码
 *   （实测伪 .xls 含 0x80 裸字节，strict 解码会炸）
 * - 三种单元格包裹风格幂等去包裹（§3.4）
 * - 敏感列（资金账号/股东代码/营业部名称/用户名/结算汇率）**解析期丢弃**：
 *   不落库、不入日志、不回显；报错只报行号与列名（§3.6）
 * - 语义列名**不得硬编码精确值**：同义 / 错字容忍（实测「资金发生数」vs「资金余额」用字不一致）（§3.5）
 */
import type {
  BrokerFileInput,
  BrokerFileParseResult,
  DetectedColumn,
  ParsedRow,
  ParseWarning,
  ParseError,
  ColumnMappingSuggestion,
  SemanticField,
} from './types.js';
import { isZipBuffer, readXlsxSheet } from './xlsxReader.js';

/** 敏感列名（出现即整列丢弃，只记列号） */
const SENSITIVE_HEADERS: readonly string[] = [
  '资金账号',
  '股东代码',
  '营业部名称',
  '用户名',
  '结算汇率',
  '资金帐号',
  '股东帐号',
];

/** 表头特征关键字（出现任一即视为「可能是表头行」的候选锚点，§3.7 向下扫描） */
const HEADER_ANCHORS: readonly string[] = [
  '成交日期',
  '成交时间',
  '交易类别',
  '委托类别',
  '证券代码',
  '交收日期',
  '日期',
];

/** fileKind 打分特征（§3.2 + 实测扩展，见 D-16） */
const SETTLE_FEATURES: Array<{ name: string; weight: number }> = [
  { name: '资金余额', weight: 2 },
  { name: '费用合计', weight: 2 },
  { name: '发生金额', weight: 1 },
  { name: '资金发生数', weight: 1 },
];
const TRADE_FEATURES: Array<{ name: string; weight: number }> = [
  { name: '成交时间', weight: 1 },
  { name: '委托编号', weight: 2 },
  { name: '剩余金额', weight: 1 },
];

/** 语义字段同义词表（§3.5：容忍错字/同义；完全相等=high，包含/编辑距离≤1=low） */
const SEMANTIC_ALIASES: Partial<Record<SemanticField, readonly string[]>> = {
  tradeDate: ['成交日期', '交易日期'],
  settleDate: ['交收日期'],
  tradeTime: ['成交时间'],
  symbol: ['证券代码', '代码'],
  name: ['证券名称', '名称'],
  direction: ['交易类别', '委托类别'],
  price: ['成交价格', '价格'],
  quantity: ['成交数量', '数量'],
  amount: ['成交金额', '成交金额(元)'],
  cashFlow: ['发生金额', '资金发生数', '资金发生额', '资金发生'],
  cashBalance: ['剩余金额', '资金余额', '余额'],
  balance: ['证券余额'],
  feeTotal: ['费用合计'],
  tradeId: ['成交编号'],
  contractNo: ['合同序号', '委托编号'],
} as Partial<Record<SemanticField, readonly string[]>>;

const FEE_HEADERS = [
  '佣金',
  '规费',
  '印花税',
  '过户费',
  '经手费',
  '清算费',
  '前台费用',
  '交易规费',
  '证管费',
  '其他费用',
  '其他费',
  '成交费',
];

/** 幂等去包裹（§3.4 三风格：`="v"` / `"v"` / 原生） */
export function stripCellWrap(raw: string): string {
  const s = raw.trim();
  if (s.startsWith('="') && s.endsWith('"') && s.length >= 3) return s.slice(2, -1).trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) return s.slice(1, -1).trim();
  return s;
}

function decodeText(buffer: Buffer): {
  text: string;
  encoding: 'utf-8' | 'utf-8-bom' | 'gb18030';
  replacements: number;
} {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    return {
      text: new TextDecoder('utf-8').decode(buffer.subarray(3)),
      encoding: 'utf-8-bom',
      replacements: 0,
    };
  }
  try {
    const t = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return { text: t, encoding: 'utf-8', replacements: 0 };
  } catch {
    // 非严格 UTF-8 ⇒ GB18030 宽容解码（裸 0x80 等历史字节 → 替换字符 + 告警）
    const t = new TextDecoder('gb18030').decode(buffer);
    let replacements = 0;
    for (const ch of t) if (ch === '\uFFFD') replacements++;
    return { text: t, encoding: 'gb18030', replacements };
  }
}

function splitLines(text: string): string[] {
  return text.split(/\r\n|\n/).filter((l) => l.length > 0 || (text.endsWith('\n') && l === ''));
}

/** 编辑距离 ≤ 1（同义/错字容忍的最小实现：长度差 0/1 且逐位匹配 ≥ 90%） */
function nearMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let diff = 0;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) diff++;
  return diff <= 1;
}

function scoreFeatures(headers: string[], feats: Array<{ name: string; weight: number }>): number {
  let s = 0;
  for (const f of feats) if (headers.some((h) => h === f.name || h.includes(f.name))) s += f.weight;
  if (feats === SETTLE_FEATURES && headers.filter((h) => FEE_HEADERS.some((f) => h === f)).length >= 2)
    s += 1;
  return s;
}

/** 主入口（SDD_v3 §3.1 契约） */
export async function parseBrokerFile(input: BrokerFileInput): Promise<BrokerFileParseResult> {
  const { buffer, filename } = input;
  const warnings: ParseWarning[] = [];
  const errors: ParseError[] = [];

  let grid: string[][]; // 二维字符串（未去包裹的原始单元格）
  let encoding: 'utf-8' | 'utf-8-bom' | 'gb18030' | 'unknown';

  if (isZipBuffer(buffer)) {
    try {
      grid = readXlsxSheet(buffer);
      encoding = 'utf-8'; // xlsx 内部 XML 恒 UTF-8
    } catch (e) {
      errors.push({
        code: 'XLSX_PARSE',
        message: `xlsx 解析失败（${e instanceof Error ? e.message : String(e)}）；文件名仅供参考：${filename}`,
      });
      return {
        ok: false,
        fileKind: 'unknown',
        encoding: 'unknown',
        headerRowIndex: -1,
        columns: [],
        rows: [],
        mappingSuggestion: emptySuggestion(),
        warnings,
        errors,
      };
    }
  } else {
    const dec = decodeText(buffer);
    encoding = dec.encoding;
    if (dec.replacements > 0) {
      warnings.push({
        code: 'ENCODING_LOSSY',
        message: `GB18030 宽容解码产生 ${dec.replacements} 个替换字符（历史裸字节），疑似列数据可能失真`,
        scope: 'file',
      });
    }
    grid = splitLines(dec.text).map((l) => l.split('\t'));
  }

  // ── 表头定位（§3.7：向下扫描，不假设首行）──
  let headerRowIndex = -1;
  for (let i = 0; i < Math.min(grid.length, 50); i++) {
    const cells = (grid[i] ?? []).map((c) => stripCellWrap(c));
    const anchorHits = cells.filter((c) => HEADER_ANCHORS.some((a) => nearMatch(c, a))).length;
    if (anchorHits >= 2) {
      headerRowIndex = i;
      break;
    }
  }
  if (headerRowIndex < 0) {
    errors.push({
      code: 'HEADER_NOT_FOUND',
      message:
        '50 行内未找到表头特征（成交日期/成交时间/交易类别/委托类别/证券代码/交收日期/日期 至少 2 个命中）',
    });
    return {
      ok: false,
      fileKind: 'unknown',
      encoding,
      headerRowIndex: -1,
      columns: [],
      rows: [],
      mappingSuggestion: emptySuggestion(),
      warnings,
      errors,
    };
  }

  const rawHeader = (grid[headerRowIndex] ?? []).map((c) => stripCellWrap(c));
  const header = rawHeader.map((c) => c.replace(/\s+$/g, ''));

  // ── 敏感列识别（§3.6：整列丢弃，只记列号，不回显值）──
  const sensitiveIdx = new Set<number>();
  header.forEach((h, i) => {
    if (SENSITIVE_HEADERS.some((s) => nearMatch(h, s))) sensitiveIdx.add(i);
  });

  // ── fileKind 打分（§3.2 + D-16 实测扩展）──
  const visibleHeader = header.filter((_, i) => !sensitiveIdx.has(i));
  const settleScore = scoreFeatures(visibleHeader, SETTLE_FEATURES);
  const tradeScore = scoreFeatures(visibleHeader, TRADE_FEATURES);
  let fileKind: 'settlement' | 'trade' | 'unknown' = 'unknown';
  if (settleScore > tradeScore && settleScore >= 2) fileKind = 'settlement';
  else if (tradeScore >= 1 && tradeScore >= settleScore) fileKind = 'trade';
  else if (
    visibleHeader.some((h) => nearMatch(h, '成交时间')) ||
    visibleHeader.some((h) => nearMatch(h, '发生金额'))
  )
    fileKind = 'trade';
  if (settleScore === tradeScore && (settleScore > 0 || tradeScore > 0)) {
    warnings.push({
      code: 'FILE_KIND_AMBIGUOUS',
      message: `交割/成交特征打平（settle=${settleScore}, trade=${tradeScore}），按 trade 兜底，请人工复核`,
      scope: 'file',
    });
  }

  // ── 数据行（表头之后；去包裹后的原始字符串）──
  const rows: ParsedRow[] = [];
  for (let i = headerRowIndex + 1; i < grid.length; i++) {
    const cells = (grid[i] ?? []).map((c) => stripCellWrap(c));
    if (cells.every((c) => c === '')) continue; // 空行
    const safe: string[] = [];
    for (let j = 0; j < cells.length; j++) safe[j] = sensitiveIdx.has(j) ? '' : cells[j];
    rows.push({ rowIndex: i, cells: safe });
  }

  // ── 列检测 + 映射建议（§3.5：同义/错字容忍 + 候选）──
  const columns: DetectedColumn[] = header.map((h, i) => ({
    index: i,
    header: h,
    dropped: sensitiveIdx.has(i),
    semantic: suggestSemantic(h),
  }));

  const mappingSuggestion = buildSuggestion(columns);

  // T151①：券商名推断（仅元数据行；推断不出为 undefined）
  const brokerNameHint = detectBrokerName(grid, headerRowIndex);

  if (sensitiveIdx.size > 0) {
    warnings.push({
      code: 'SENSITIVE_DROPPED',
      message: `已丢弃敏感列 ${sensitiveIdx.size} 个（资金账号/股东代码/营业部名称/用户名/结算汇率），不落库不入日志`,
      scope: 'file',
    });
  }

  return {
    ok: true,
    fileKind,
    encoding,
    headerRowIndex,
    columns,
    rows,
    mappingSuggestion,
    warnings,
    errors,
    ...(brokerNameHint !== undefined ? { brokerNameHint } : {}),
  };
}

function suggestSemantic(headerName: string): { field: SemanticField; confidence: 'high' | 'low' } | null {
  for (const [field, aliases] of Object.entries(SEMANTIC_ALIASES)) {
    for (const a of (aliases ?? []) as string[]) {
      if (headerName === a) return { field: field as SemanticField, confidence: 'high' };
    }
    for (const a of (aliases ?? []) as string[]) {
      if (nearMatch(headerName, a)) return { field: field as SemanticField, confidence: 'low' };
    }
  }
  return null;
}

function buildSuggestion(columns: DetectedColumn[]): ColumnMappingSuggestion {
  const byField: ColumnMappingSuggestion['byField'] = {};
  const used = new Set<number>();
  // 高置信优先占用列，低置信随后（避免一列抢两个字段）
  const ordered = [...columns]
    .filter((c) => c.semantic && !c.dropped)
    .sort(
      (a, b) => (a.semantic!.confidence === 'high' ? -1 : 1) - (b.semantic!.confidence === 'high' ? -1 : 1),
    );
  for (const c of ordered) {
    if (used.has(c.index)) continue;
    used.add(c.index);
    byField[c.semantic!.field] = { column: c.index, header: c.header, confidence: c.semantic!.confidence };
  }
  const unmapped = columns
    .filter((c) => !c.dropped && !used.has(c.index) && c.header !== '')
    .map((c) => c.index);
  const sensitiveDropped = columns.filter((c) => c.dropped).map((c) => c.index);
  return { byField, unmapped, sensitiveDropped };
}

function emptySuggestion(): ColumnMappingSuggestion {
  return { byField: {}, unmapped: [], sensitiveDropped: [] };
}

/**
 * T151①（V3.8a）：常见券商名清单（元数据行推断用，最长匹配优先）。
 * 只识别**公司名**（如「国泰君安证券」）——敏感信息边界（§3.6 / INV-S-*）：
 * 不回账号 / 用户名 / 营业部代码，故匹配范围仅限公司名关键词。
 */
const KNOWN_BROKER_NAMES: readonly string[] = [
  '国泰君安证券',
  '中信证券',
  '华泰证券',
  '申万宏源证券',
  '招商证券',
  '国信证券',
  '广发证券',
  '银河证券',
  '海通证券',
  '东方证券',
  '安信证券',
  '浙商证券',
  '兴业证券',
  '中金公司',
  '东方财富证券',
  '民生证券',
  '光大证券',
  '平安证券',
  '方正证券',
  '东北证券',
  '财通证券',
  '华西证券',
];

/**
 * 从**表头之前的元数据行**推断券商名（T151①）。
 *
 * 规则（确定性、可测试）：
 * 1. 拼元数据行（0..headerRowIndex-1，去包裹）全文；
 * 2. 先按 KNOWN_BROKER_NAMES 命中（**最长优先**，避免「中信」误配「中信证券」的短名）；
 * 3. 兜底：`/([\u4e00-\u9fa5]{2,10}证券)/` 提取「中文名 + 证券」形态（取首个，且不含敏感词）；
 * 4. 推断不出 → undefined。
 *
 * ⚠️ 元数据行常含敏感值（资金账号/用户名/营业部）——本函数只输出公司名形态的匹配，
 *    不输出整行内容，敏感值不会经由该字段回显。
 */
export function detectBrokerName(grid: string[][], headerRowIndex: number): string | undefined {
  if (headerRowIndex <= 0) return undefined;
  const metaText = grid
    .slice(0, headerRowIndex)
    .map((row) => (row ?? []).map((c) => stripCellWrap(c).trim()).join(' '))
    .join('\n');
  if (!metaText) return undefined;

  let best: string | undefined;
  for (const name of KNOWN_BROKER_NAMES) {
    if (metaText.includes(name) && (!best || name.length > best.length)) best = name;
  }
  if (best) return best;

  const m = metaText.match(/([\u4e00-\u9fa5]{2,10}证券)/);
  if (m) {
    const cand = m[1];
    // 排除疑似敏感/表头词（含账号/用户名/营业部的不采纳）
    if (!/账号|帐号|用户|营业部|名称$/.test(cand)) return cand;
  }
  return undefined;
}

export type {
  BrokerFileInput,
  BrokerFileParseResult,
  DetectedColumn,
  ParsedRow,
  ParseWarning,
  ParseError,
  ColumnMappingSuggestion,
  SemanticField,
} from './types.js';
