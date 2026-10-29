/**
 * 券商导入确认路由 —— 未知标的"弹窗选择跳过"契约
 *
 * confirm / confirm-batch：检测到未知标的时返回 200 + pending_unknown_assets，
 *   不再整批拒绝；前端据此弹窗让用户选择跳过哪些代码。
 * confirm-final：携带 skipUnknownAssetCodes 完成落盘，跳过代码对应行被过滤。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTestApp, cleanupIntegrationTest } from './_helpers.js';
import type { TestAppBundle } from './_helpers.js';
import { parseBrokerFile } from '../../src/services/broker/brokerParser.js';
import { normalizeBrokerRow } from '../../src/services/broker/brokerImport.js';

let bundle: TestAppBundle;
const FIX = path.resolve(__dirname, '../../../../tests/fixtures/broker-samples');
const FILE_A = '2026-10-20-国泰股票成交.xlsx';
const FILE_B = '20261020_华宝交割单.xls';

function filePayload(name: string) {
  const buffer = fs.readFileSync(path.join(FIX, name));
  return { filename: name, fileBase64: buffer.toString('base64') };
}

async function codesOf(name: string): Promise<string[]> {
  const buffer = fs.readFileSync(path.join(FIX, name));
  const parse = await parseBrokerFile({ buffer, filename: name });
  expect(parse.ok).toBe(true);
  return [
    ...new Set(
      parse.rows
        .map((row) => normalizeBrokerRow(parse, row).asset_code)
        .filter((c): c is string => typeof c === 'string' && c.length > 0),
    ),
  ];
}

function seedDict(codes: string[]): void {
  const ins = bundle.db.db.prepare(
    `INSERT OR REPLACE INTO symbol_dict (symbol, code6, name, pinyin, market, class, asset_class)
     VALUES (?, ?, '', '', ?, 'unknown', 'risk')`,
  );
  for (const code of codes) ins.run(code, code.replace(/^[a-z]+/i, ''), code.slice(0, 2));
}

function clearAll(): void {
  bundle.db.db.prepare('DELETE FROM broker_trade_record').run();
  bundle.db.db.prepare('DELETE FROM broker_import_batch').run();
  bundle.db.db.prepare('DELETE FROM symbol_dict').run();
}

beforeAll(async () => {
  bundle = await createTestApp();
});

afterAll(async () => {
  await bundle.app.close().catch(() => {});
  cleanupIntegrationTest();
});

function authHeaders() {
  return { authorization: `Bearer ${bundle.adminToken}` };
}

describe('broker-import confirm · 未知标的弹窗选择跳过', () => {
  it('单文件 confirm 含未知标的 → 200 + pending_unknown_assets，不落盘', async () => {
    const codesB = await codesOf(FILE_B);
    expect(codesB.length).toBeGreaterThan(0);
    const unknown = codesB[codesB.length - 1];
    // 只 seed 除 unknown 外的所有 code
    clearAll();
    seedDict(codesB.filter((c) => c !== unknown));

    const single = await bundle.app.inject({
      method: 'POST',
      url: '/api/broker-import/confirm',
      headers: authHeaders(),
      payload: { brokerCode: '国泰', ...filePayload(FILE_B) },
    });
    expect(single.statusCode).toBe(200);
    const body = JSON.parse(single.body);
    expect(body.data.pending_unknown_assets).toBeDefined();
    expect(body.data.pending_unknown_assets.length).toBeGreaterThan(0);
    expect(body.data.pending_unknown_assets[0].assetCodes).toContain(unknown);

    // 未落盘
    const counts = bundle.db.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM broker_import_batch WHERE user_id = ?) AS batches,
           (SELECT COUNT(*) FROM broker_trade_record WHERE user_id = ? AND is_deleted = 0) AS facts`,
      )
      .get(bundle.userId, bundle.userId) as { batches: number; facts: number };
    expect(counts).toEqual({ batches: 0, facts: 0 });
  });

  it('confirm-batch 含未知标的 → 200 + pending_unknown_assets，不落盘', async () => {
    const [codesA, codesB] = await Promise.all([codesOf(FILE_A), codesOf(FILE_B)]);
    expect(codesA.length).toBeGreaterThan(0);
    expect(codesB.length).toBeGreaterThan(0);
    const unknown = codesB[codesB.length - 1];
    clearAll();
    seedDict([...codesA, ...codesB.filter((c) => c !== unknown)]);

    const batch = await bundle.app.inject({
      method: 'POST',
      url: '/api/broker-import/confirm-batch',
      headers: authHeaders(),
      payload: {
        brokerCode: '国泰',
        files: [filePayload(FILE_A), filePayload(FILE_B)],
      },
    });
    expect(batch.statusCode).toBe(200);
    const body = JSON.parse(batch.body);
    expect(body.data.pending_unknown_assets).toBeDefined();
    expect(body.data.pending_unknown_assets.length).toBeGreaterThan(0);

    // 未落盘
    const counts = bundle.db.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM broker_import_batch WHERE user_id = ?) AS batches,
           (SELECT COUNT(*) FROM broker_trade_record WHERE user_id = ? AND is_deleted = 0) AS facts`,
      )
      .get(bundle.userId, bundle.userId) as { batches: number; facts: number };
    expect(counts).toEqual({ batches: 0, facts: 0 });
  });

  it('confirm-final 携带 skipCodes 跳过未知标的后正常落盘', async () => {
    const codesA = await codesOf(FILE_A);
    expect(codesA.length).toBeGreaterThan(0);
    const unknownA = codesA[codesA.length - 1];
    clearAll();
    seedDict(codesA.filter((c) => c !== unknownA));

    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/broker-import/confirm-final',
      headers: authHeaders(),
      payload: {
        brokerCode: '国泰',
        files: [filePayload(FILE_A)],
        skipUnknownAssetCodes: [unknownA],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.files).toHaveLength(1);
    expect(body.data.skippedCodes).toContain(unknownA);

    // 确认事实层有写入
    const facts = bundle.db.db
      .prepare('SELECT COUNT(*) c FROM broker_trade_record WHERE user_id = ? AND is_deleted = 0')
      .get(bundle.userId) as { c: number };
    expect(facts.c).toBeGreaterThan(0);
  });

  it('confirm-final 未完全跳过未知标的 → 仍返回 422', async () => {
    const codesB = await codesOf(FILE_B);
    expect(codesB.length).toBeGreaterThan(0);
    const unknown = codesB[codesB.length - 1];
    clearAll();
    seedDict(codesB.filter((c) => c !== unknown));

    // 传一个与 unknown 无关的 skipCode → unknown 仍在 → 422
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/broker-import/confirm-final',
      headers: authHeaders(),
      payload: {
        brokerCode: '国泰',
        files: [filePayload(FILE_B)],
        skipUnknownAssetCodes: ['sh999999'],
      },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('UNKNOWN_ASSET_CODES');
    expect(body.message).toContain(unknown);
  });

  it('修正字典后直接 confirm-batch 无需 skip 即可成功', async () => {
    const [codesA, codesB] = await Promise.all([codesOf(FILE_A), codesOf(FILE_B)]);
    clearAll();
    seedDict([...codesA, ...codesB]);
    const retry = await bundle.app.inject({
      method: 'POST',
      url: '/api/broker-import/confirm-batch',
      headers: authHeaders(),
      payload: {
        brokerCode: '国泰',
        files: [filePayload(FILE_A), filePayload(FILE_B)],
      },
    });
    expect(retry.statusCode).toBe(200);
    const retryBody = JSON.parse(retry.body);
    expect(retryBody.data.files).toHaveLength(2);
  });
});
