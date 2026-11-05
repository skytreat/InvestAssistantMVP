/**
 * T122（V3.1）事实层三表 + 导入批次 —— SDD_v3 §11.1.1~1.3 / §9.1
 *
 * 语义边界（ADR-013）：确认导入**只写事实层**（broker_trade_record），
 * **不写 `user_trade_record`** —— 业务记录由 T129 补录（`/api/broker-reconcile/confirm`）显式产生。
 *
 * 幂等（INV-S2-9 / INV-S2-39）：
 * - 文件级：`file_hash`（原始字节 SHA-256）重复上传 ⇒ 命中批次，0 新行
 * - 行级：`row_hash`（归一化内容 SHA-256）+ `content_seq`（同哈希在批次内出现序号）⇒
 *   同内容多笔全留、同文件重复上传零重复
 * 撤销（T122 验收③）：批次撤销只软删事实层（is_deleted=1），**原始证据（raw_row_json）保留**，
 * 绝不物理删除（AGENTS 铁律：业务记录全软删）。
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { parseBrokerFile } from './brokerParser.js';
import { normalizeEvent, isExcludedFromSystemRecord } from './eventNormalize.js';
import type { BrokerFileInput, BrokerFileParseResult } from './types.js';
import { buildCode6Dict, normalizeAssetCode } from '../assetCode.js';
import { queryDuckDB } from '../../db/duckdb.js';

export { buildCode6Dict, normalizeAssetCode } from '../assetCode.js';

export const PARSER_VERSION = 'v3.1.1';

export interface ImportResult {
  batchId: number;
  fileHash: string;
  rowTotal: number;
  rowInserted: number;
  rowDeduped: number;
  rowExcluded: number;
  duplicateFile: boolean; // 同 file_hash 已有批次（本批 0 新行）
}

/** 预检后的文件：此时尚未写任何 DB 行，供整批“先检后写”使用 */
export interface PreparedBrokerFile {
  filename: string;
  fileHash: string;
  fileSize: number;
  duplicateFile: boolean;
  existingBatchId: number | null;
  fileKind: BrokerFileParseResult['fileKind'] | null;
  encoding: BrokerFileParseResult['encoding'] | null;
  rows: Array<{ normalized: Record<string, unknown>; rowIndex: number; cells: string[] }>;
  rowTotal: number;
  rowExcluded: number;
  unknownAssets: string[];
  unknownAssetNames: (string | null)[];
}

export interface UnknownAssetDetail {
  filename: string;
  assetCodes: string[];
  /** 与 assetCodes 对应的原始名称（可能为 null/空字符串） */
  assetNames?: (string | null)[];
}

/** 任一未知标的 → 整个文件/整批拒绝（不创建批次、不写事实层） */
export class UnknownAssetCodesError extends Error {
  constructor(public readonly details: UnknownAssetDetail[]) {
    super(
      `标的不在系统字典中：${details
        .map((d) => {
          const parts = d.assetCodes.map((code, i) => {
            const name = d.assetNames?.[i];
            return name ? `${code}（${name}）` : code;
          });
          return `${d.filename}: ${parts.join('、')}`;
        })
        .join('；')}`,
    );
    this.name = 'UnknownAssetCodesError';
  }
}

/**
 * 费用明细分项列（与 brokerParser 的 FEE_HEADERS 对齐，但**排除**「成交费」）。
 *
 * `费用合计` 列缺失时按这些分项求和；华宝成交单只有 佣金/印花税/过户费 三列有值。
 */
const FEE_DETAIL_HEADERS = new Set([
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
]);

/**
 * 「成交费」= 可能是分项别名或冗余列（实测华宝 671 行全为 0）。
 * 为避免与 佣金/印花税/过户费 重复累加，**仅当其它分项全为 0 时**才作为兜底采用。
 */
const FEE_FALLBACK_HEADER = '成交费';

/**
 * 费用合计兜底：按表头名把费用分项列求和（分项列当前不在 mappingSuggestion.byField 里）。
 *
 * @returns 无任何费用列 → null（保持「未提供费用」语义）；有费用列但全空/全 0 → 0
 */
function sumFeeDetails(parse: BrokerFileParseResult, cells: string[]): number | null {
  let hasFeeColumn = false;
  let detail = 0;
  let fallback = 0;
  for (const c of parse.columns) {
    if (c.dropped) continue;
    const header = c.header.trim();
    const isFallback = header === FEE_FALLBACK_HEADER;
    if (!isFallback && !FEE_DETAIL_HEADERS.has(header)) continue;
    hasFeeColumn = true;
    const raw = cells[c.index];
    const n = raw === undefined || raw === '' ? null : Number(raw);
    if (n === null || !Number.isFinite(n)) continue;
    if (isFallback) fallback += n;
    else detail += n;
  }
  if (!hasFeeColumn) return null;
  // PR#80 review：detail 与 fallback 同时非 0 时**以 detail 为准**（不累加）——
  // 「成交费」按华宝成交单口径是「佣金/印花税/过户费」的汇总别名，累加会重复计入。
  // 实测本单 671 行「成交费」全为 0，故本单两种取法结果相同；仅在其它券商模板
  // 若把「成交费」作为独立收费项时才需调整（届时改这一行即可）。
  const total = detail !== 0 ? detail : fallback;
  // 金额按分单位四舍五入，避免浮点累加尾差进入行哈希
  return Math.round(total * 100) / 100;
}

/** 归一化后的行（映射模板缺省时用默认列映射；模板化属 T122② 的 mapping_json 载体） */
export function normalizeBrokerRow(
  parse: BrokerFileParseResult,
  row: { rowIndex: number; cells: string[] },
  code6Dict?: Map<string, string | null>,
): Record<string, unknown> {
  const m = parse.mappingSuggestion.byField;
  const col = (f: keyof typeof m): string | undefined => (m[f] ? row.cells[m[f]!.column] : undefined);
  const num = (v: string | undefined): number | null => {
    if (v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const rawEvent = col('direction') ?? '';
  const norm = normalizeEvent(rawEvent);
  const excluded = isExcludedFromSystemRecord(norm);
  return {
    event_type: norm.event_type,
    raw_event_type: norm.raw_event_type,
    asset_code: normalizeAssetCode(col('symbol') ?? null, code6Dict),
    raw_symbol: col('symbol') ?? null,
    raw_name: col('name') ?? null,
    market: norm.market ?? null,
    trade_date: col('tradeDate') ?? col('settleDate') ?? null,
    trade_time: col('tradeTime') ?? null,
    price: num(col('price')),
    quantity: num(col('quantity')),
    amount: num(col('amount')),
    cash_flow: num(col('cashFlow')),
    cash_balance_after: num(col('cashBalance')),
    balance_after: num(col('balance')),
    fee_total: num(col('feeTotal')) ?? sumFeeDetails(parse, row.cells),
    source_row_no: row.rowIndex,
    exclude_reason: excluded ? norm.exclude_reason : null,
    match_status: excluded ? 'EXCLUDED' : 'MISSING', // 匹配回填属 T124
  };
}

/** 行哈希：归一化内容（不含敏感/展示字段）的 SHA-256 */
export function rowHashOf(normalized: Record<string, unknown>): string {
  const stable = JSON.stringify([
    normalized.event_type,
    normalized.asset_code,
    normalized.trade_date,
    normalized.trade_time,
    normalized.price,
    normalized.quantity,
    normalized.amount,
    normalized.cash_flow,
    normalized.fee_total,
  ]);
  return createHash('sha256').update(stable).digest('hex');
}

/**
 * 预检：解析 + 归一化 + 标的存在性检查，**不写任何 DB 行**。
 *
 * 路由先对所有文件预检，任一文件存在未知标的则整批 422，避免“部分导入 + 撤销重来”。
 */
export async function preflightBrokerFile(
  db: Database.Database,
  userId: number,
  brokerCode: string,
  input: BrokerFileInput,
): Promise<PreparedBrokerFile> {
  void brokerCode;
  const fileHash = createHash('sha256').update(input.buffer).digest('hex');

  // 文件级幂等（INV-S2-9）：同 file_hash 已有未撤销批次 ⇒ 不重复落行
  const prev = db
    .prepare(
      `SELECT id, status FROM broker_import_batch WHERE user_id = ? AND file_hash = ? AND is_deleted = 0 ORDER BY id DESC LIMIT 1`,
    )
    .get(userId, fileHash) as { id: number; status: string } | undefined;
  if (prev && prev.status !== 'revoked') {
    return {
      filename: input.filename,
      fileHash,
      fileSize: input.buffer.length,
      duplicateFile: true,
      existingBatchId: prev.id,
      fileKind: null,
      encoding: null,
      rows: [],
      rowTotal: 0,
      rowExcluded: 0,
      unknownAssets: [],
      unknownAssetNames: [],
    };
  }

  const parse = await parseBrokerFile(input);
  if (!parse.ok || parse.fileKind === 'unknown') {
    throw new Error(
      `BROKER_PARSE_FAILED: ${parse.errors.map((e) => e.message).join('; ') || '无法识别文件类型'}`,
    );
  }

  // 存在性判定源：DuckDB raw_symbol_class（覆盖 raw_kline_daily 全部标的，含 unknown 类）；
  // symbol_dict 只做名称补全（code6 歧义消解 + 显示名称），**不做存在性判定**。
  // 行情库不可读/无数据时**降级跳过校验**（与既有「字典未同步则放行」语义一致），不误拒。
  let symbolSet: Set<string> | null = null;
  try {
    symbolSet = new Set(
      (
        await queryDuckDB<{ symbol: string }>(`SELECT symbol FROM raw_symbol_class WHERE class <> 'block'`)
      ).map((r) => r.symbol),
    );
  } catch {
    symbolSet = null;
  }
  const code6Dict = buildCode6Dict(db);
  const rows = parse.rows.map((row) => ({
    normalized: normalizeBrokerRow(parse, row, code6Dict),
    rowIndex: row.rowIndex,
    cells: row.cells,
  }));
  const unknownMap = new Map<string, string | null>();
  for (const r of rows) {
    const code = r.normalized.asset_code;
    // 排除行（场外申赎 / 占位 / 忽略）不进入系统记录，其伪代码（如 799999 指定登记）
    // 不需要存在于行情库 —— 否则每份含「指定登记」的成交单都会被未知标的弹窗拦截。
    if (r.normalized.match_status === 'EXCLUDED') continue;
    if (symbolSet !== null && symbolSet.size > 0 && typeof code === 'string' && !symbolSet.has(code)) {
      const existing = unknownMap.get(code);
      const name = (r.normalized.raw_name as string | null | undefined) ?? null;
      if (existing === undefined || (existing === null && name !== null && name !== '')) {
        unknownMap.set(code, name);
      }
    }
  }
  // 歧义消解：6 位裸码 + 名称 → symbol_dict 精确匹配 code6 + name（仅名称补全，不做存在性判定）
  const resolveStmt = db.prepare(`SELECT symbol FROM symbol_dict WHERE code6 = ? AND name = ?`);
  const resolveMap = new Map<string, string>(); // bare code → full symbol
  for (const [code, name] of unknownMap) {
    if (!/^\d{6}$/.test(code) || !name) continue;
    const hit = resolveStmt.get(code, name) as { symbol: string } | undefined;
    if (hit && symbolSet?.has(hit.symbol)) {
      // 解析成功 ⇒ 该代码**不再是未知标的**：只记映射，必须从 unknownMap 移除。
      // （旧实现又 set(hit.symbol) 回来 ⇒ 合法歧义码仍被计入 unknownAssets ⇒ 整文件误拒。）
      resolveMap.set(code, hit.symbol);
      unknownMap.delete(code);
    }
  }
  for (const r of rows) {
    const code = r.normalized.asset_code;
    if (typeof code === 'string' && resolveMap.has(code)) {
      r.normalized.asset_code = resolveMap.get(code);
    }
  }
  const unknownAssetEntries = [...unknownMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const unknownAssets = unknownAssetEntries.map((e) => e[0]);
  const unknownAssetNames = unknownAssetEntries.map((e) => e[1]);

  return {
    filename: input.filename,
    fileHash,
    fileSize: input.buffer.length,
    duplicateFile: false,
    existingBatchId: null,
    fileKind: parse.fileKind,
    encoding: parse.encoding,
    rows,
    rowTotal: parse.rows.length,
    rowExcluded: rows.filter((r) => r.normalized.match_status === 'EXCLUDED').length,
    unknownAssets,
    unknownAssetNames,
  };
}

/** 落盘预检结果：创建批次 + 写事实层（调用方必须先完成未知标的检查）
 *
 * @param skipUnknownAssetCodes 用户选择跳过的标的代码集合；
 *   提供时按代码过滤行与 unknownAssets，不再因这些代码抛错。
 */
export function persistPreparedBrokerFile(
  db: Database.Database,
  userId: number,
  brokerCode: string,
  prepared: PreparedBrokerFile,
  skipUnknownAssetCodes: string[] = [],
): ImportResult {
  if (skipUnknownAssetCodes.length > 0) {
    const skipSet = new Set(skipUnknownAssetCodes);
    const filteredRows = prepared.rows.filter((r) => !skipSet.has(r.normalized.asset_code as string));
    const keptCodes: string[] = [];
    const keptNames: (string | null)[] = [];
    for (let i = 0; i < prepared.unknownAssets.length; i++) {
      if (!skipSet.has(prepared.unknownAssets[i])) {
        keptCodes.push(prepared.unknownAssets[i]);
        keptNames.push(prepared.unknownAssetNames[i] ?? null);
      }
    }
    prepared = {
      ...prepared,
      rows: filteredRows,
      unknownAssets: keptCodes,
      unknownAssetNames: keptNames,
      rowTotal: filteredRows.length,
    };
  }

  if (prepared.unknownAssets.length > 0) {
    throw new UnknownAssetCodesError([
      {
        filename: prepared.filename,
        assetCodes: prepared.unknownAssets,
        assetNames: prepared.unknownAssetNames,
      },
    ]);
  }

  // 预检后、落盘前可能已有同文件批次（批量预检的场景）→ 再查一次
  const prev = db
    .prepare(
      `SELECT id, status FROM broker_import_batch WHERE user_id = ? AND file_hash = ? AND is_deleted = 0 ORDER BY id DESC LIMIT 1`,
    )
    .get(userId, prepared.fileHash) as { id: number; status: string } | undefined;
  if (prev && prev.status !== 'revoked') {
    return {
      batchId: prev.id,
      fileHash: prepared.fileHash,
      rowTotal: 0,
      rowInserted: 0,
      rowDeduped: 0,
      rowExcluded: 0,
      duplicateFile: true,
    };
  }

  const batchId = Number(
    db
      .prepare(
        `INSERT INTO broker_import_batch
         (user_id, broker_code, file_kind, encoding, file_name, file_hash, file_size, parser_version, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'parsed')`,
      )
      .run(
        userId,
        brokerCode,
        prepared.fileKind,
        prepared.encoding,
        prepared.filename,
        prepared.fileHash,
        prepared.fileSize,
        PARSER_VERSION,
      ).lastInsertRowid,
  );

  const insert = db.prepare(
    `INSERT INTO broker_trade_record
     (user_id, import_batch_id, broker_code, source_kind, event_type, asset_code, trade_date, trade_time,
      price, quantity, amount, cash_flow, fee_total, balance_after, cash_balance_after, market,
      raw_symbol, raw_name, raw_event_type, raw_row_json, source_file, source_row_no,
      match_status, exclude_reason, row_hash, content_seq)
     VALUES (?, ?, ?, 'broker', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // 行级幂等（SDD §11.1.1）：**批次内**同哈希多笔是真实分笔（如同日 5 笔卖出同价），
  // content_seq = 同哈希在批次内的出现序号 → 全留，不误判重复。
  // 跨文件的「冗余导出」去重归 T124（对账层）；同文件重复上传由上方 file_hash 拦截。
  const seqByHashInBatch = new Map<string, number>();
  let rowInserted = 0;
  let rowExcluded = 0;
  const runAll = db.transaction(() => {
    for (const row of prepared.rows) {
      const normalized = row.normalized;
      const hash = rowHashOf(normalized);
      const seq = seqByHashInBatch.get(hash) ?? 0;
      seqByHashInBatch.set(hash, seq + 1);
      const excluded = normalized.match_status === 'EXCLUDED';
      insert.run(
        userId,
        batchId,
        brokerCode,
        normalized.event_type,
        normalized.asset_code,
        normalized.trade_date,
        normalized.trade_time,
        normalized.price,
        normalized.quantity,
        normalized.amount,
        normalized.cash_flow,
        normalized.fee_total,
        normalized.balance_after,
        normalized.cash_balance_after,
        normalized.market,
        normalized.raw_symbol,
        normalized.raw_name,
        normalized.raw_event_type,
        // raw_row_json：去包裹后的原始单元格（敏感列已置空）+ 行号，可重放
        JSON.stringify({ rowIndex: row.rowIndex, cells: row.cells }),
        prepared.filename,
        normalized.source_row_no,
        normalized.match_status,
        normalized.exclude_reason,
        hash,
        seq,
      );
      rowInserted++;
      if (excluded) rowExcluded++;
    }
    db.prepare(
      `UPDATE broker_import_batch SET status = 'imported', row_total = ?, row_inserted = ?, row_deduped = ?, row_excluded = ? WHERE id = ? AND user_id = ?`,
    ).run(prepared.rowTotal, rowInserted, 0, rowExcluded, batchId, userId);
  });
  runAll();

  return {
    batchId,
    fileHash: prepared.fileHash,
    rowTotal: prepared.rowTotal,
    rowInserted,
    rowDeduped: 0,
    rowExcluded,
    duplicateFile: false,
  };
}

/** 单文件导入：先整文件预检，任一未知标的即拒绝（不写事实层） */
export async function importBrokerFile(
  db: Database.Database,
  userId: number,
  brokerCode: string,
  input: BrokerFileInput,
): Promise<ImportResult> {
  const prepared = await preflightBrokerFile(db, userId, brokerCode, input);
  return persistPreparedBrokerFile(db, userId, brokerCode, prepared);
}

/** 撤销批次：只软删事实层，raw_row_json 证据保留（验收③） */
export function revokeBatch(db: Database.Database, userId: number, batchId: number): number {
  const affected = Number(
    db
      .prepare(
        `UPDATE broker_trade_record SET is_deleted = 1 WHERE user_id = ? AND import_batch_id = ? AND is_deleted = 0`,
      )
      .run(userId, batchId).changes,
  );
  db.prepare(`UPDATE broker_import_batch SET status = 'revoked' WHERE id = ? AND user_id = ?`).run(
    batchId,
    userId,
  );
  return affected;
}

export function listBatches(db: Database.Database, userId: number): Array<Record<string, unknown>> {
  return db
    .prepare(`SELECT * FROM broker_import_batch WHERE user_id = ? AND is_deleted = 0 ORDER BY id DESC`)
    .all(userId) as Array<Record<string, unknown>>;
}

/** 列映射模板（UNIQUE(user_id, broker_code, file_kind) 幂等 upsert） */
export function saveTemplate(
  db: Database.Database,
  userId: number,
  brokerCode: string,
  fileKind: 'settlement' | 'trade',
  mappingJson: string,
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO broker_import_template (user_id, broker_code, file_kind, mapping_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, broker_code, file_kind) DO UPDATE SET mapping_json = excluded.mapping_json`,
      )
      .run(userId, brokerCode, fileKind, mappingJson).lastInsertRowid,
  );
}

export function getTemplate(
  db: Database.Database,
  userId: number,
  brokerCode: string,
  fileKind: 'settlement' | 'trade',
): { mappingJson: string } | null {
  const r = db
    .prepare(
      `SELECT mapping_json FROM broker_import_template WHERE user_id = ? AND broker_code = ? AND file_kind = ? AND is_deleted = 0`,
    )
    .get(userId, brokerCode, fileKind) as { mapping_json: string } | undefined;
  return r ? { mappingJson: r.mapping_json } : null;
}
