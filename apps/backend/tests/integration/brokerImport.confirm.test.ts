/**
 * 券商导入确认路由 —— 未知标的“整批拒绝”契约
 *
 * 旧行为是跳过未知行、其余照常写事实层；新契约：
 *   - 单文件：任一未知标的 → 422 UNKNOWN_ASSET_CODES，0 批次 / 0 事实行
 *   - 多文件：任一文件有未知标的 → 整批拒绝，所有文件都不写
 *   - 修正字典后重试 → 全部文件一次成功
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

describe('broker-import confirm · 未知标的整批拒绝', () => {
  it('单文件/多文件任一未知标的 → 422，且不留下任何批次或事实行', async () => {
    const [codesA, codesB] = await Promise.all([codesOf(FILE_A), codesOf(FILE_B)]);
    expect(codesA.length).toBeGreaterThan(0);
    expect(codesB.length).toBeGreaterThan(0);
    const unknown = codesB[codesB.length - 1];
    seedDict([...codesA, ...codesB.filter((c) => c !== unknown)]);

    // ① 单文件确认：含未知标的 → 整文件拒绝
    const single = await bundle.app.inject({
      method: 'POST',
      url: '/api/broker-import/confirm',
      headers: authHeaders(),
      payload: { brokerCode: '国泰', ...filePayload(FILE_B) },
    });
    expect(single.statusCode).toBe(422);
    const singleBody = JSON.parse(single.body);
    expect(singleBody.error).toBe('UNKNOWN_ASSET_CODES');
    expect(singleBody.message).toContain(unknown);

    // ② 多文件批量：第二个文件含未知标的 → 整批拒绝（第一个文件也不能写入）
    const batch = await bundle.app.inject({
      method: 'POST',
      url: '/api/broker-import/confirm-batch',
      headers: authHeaders(),
      payload: {
        brokerCode: '国泰',
        files: [filePayload(FILE_A), filePayload(FILE_B)],
      },
    });
    expect(batch.statusCode).toBe(422);
    expect(JSON.parse(batch.body).error).toBe('UNKNOWN_ASSET_CODES');

    const counts = bundle.db.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM broker_import_batch WHERE user_id = ?) AS batches,
           (SELECT COUNT(*) FROM broker_trade_record WHERE user_id = ? AND is_deleted = 0) AS facts`,
      )
      .get(bundle.userId, bundle.userId) as { batches: number; facts: number };
    expect(counts).toEqual({ batches: 0, facts: 0 });

    // ③ 修正字典后重试：两文件一次成功
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

    const after = bundle.db.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM broker_import_batch WHERE user_id = ?) AS batches,
           (SELECT COUNT(*) FROM broker_trade_record WHERE user_id = ? AND is_deleted = 0) AS facts`,
      )
      .get(bundle.userId, bundle.userId) as { batches: number; facts: number };
    expect(after.batches).toBe(2);
    expect(after.facts).toBeGreaterThan(0);
  });
});
