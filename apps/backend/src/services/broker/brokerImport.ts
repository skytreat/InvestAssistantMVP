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

export const PARSER_VERSION = 'v3.1.0';

export interface ImportResult {
  batchId: number;
  fileHash: string;
  rowTotal: number;
  rowInserted: number;
  rowDeduped: number;
  rowExcluded: number;
  duplicateFile: boolean; // 同 file_hash 已有批次（本批 0 新行）
}

/** 归一化后的行（映射模板缺省时用默认列映射；模板化属 T122② 的 mapping_json 载体） */
export function normalizeBrokerRow(
  parse: BrokerFileParseResult,
  row: { rowIndex: number; cells: string[] },
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
    asset_code: col('symbol') ?? null,
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
    fee_total: num(col('feeTotal')),
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

export async function importBrokerFile(
  db: Database.Database,
  userId: number,
  brokerCode: string,
  input: BrokerFileInput,
): Promise<ImportResult> {
  const fileHash = createHash('sha256').update(input.buffer).digest('hex');

  // 文件级幂等（INV-S2-9）：同 file_hash 已有未撤销批次 ⇒ 不重复落行
  const prev = db
    .prepare(
      `SELECT id, status FROM broker_import_batch WHERE user_id = ? AND file_hash = ? AND is_deleted = 0 ORDER BY id DESC LIMIT 1`,
    )
    .get(userId, fileHash) as { id: number; status: string } | undefined;
  if (prev && prev.status !== 'revoked') {
    return {
      batchId: prev.id,
      fileHash,
      rowTotal: 0,
      rowInserted: 0,
      rowDeduped: 0,
      rowExcluded: 0,
      duplicateFile: true,
    };
  }

  const parse = await parseBrokerFile(input);
  if (!parse.ok || parse.fileKind === 'unknown') {
    throw new Error(
      `BROKER_PARSE_FAILED: ${parse.errors.map((e) => e.message).join('; ') || '无法识别文件类型'}`,
    );
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
        parse.fileKind,
        parse.encoding,
        input.filename,
        fileHash,
        input.buffer.length,
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
  let rowDeduped = 0; // 仅统计文件级重复（本路径恒 0，重复文件走 duplicateFile 短路）
  let rowExcluded = 0;

  const runAll = db.transaction(() => {
    for (const row of parse.rows) {
      const normalized = normalizeBrokerRow(parse, row);
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
        input.filename,
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
    ).run(parse.rows.length, rowInserted, rowDeduped, rowExcluded, batchId, userId);
  });
  runAll();

  return {
    batchId,
    fileHash,
    rowTotal: parse.rows.length,
    rowInserted,
    rowDeduped,
    rowExcluded,
    duplicateFile: false,
  };
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
