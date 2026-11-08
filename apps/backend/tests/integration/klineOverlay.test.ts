/**
 * klineOverlay.test.ts — K 线手工画线持久化（独立 PR）
 *
 * 覆盖：
 *   - 5 个工具的白名单 + 点数校验
 *   - 创建 / 列表 / 软删除
 *   - 斐波那契（两点）落库与重放的数据形状
 *   - 用户隔离（不能删别人的标注）
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupIntegrationTest, createTestApp, makeUserToken, type TestAppBundle } from './_helpers';

let bundle: TestAppBundle;

const SYMBOL = 'sh600000';
const TS1 = Date.UTC(2026, 9, 12);
const TS2 = Date.UTC(2026, 9, 13);

function authHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function createOverlay(payload: Record<string, unknown>, token = bundle.adminToken) {
  return bundle.app.inject({
    method: 'POST',
    url: '/api/kline-overlays',
    headers: authHeaders(token),
    payload,
  });
}

beforeAll(async () => {
  bundle = await createTestApp();
});

afterAll(async () => {
  await bundle.app.close();
  cleanupIntegrationTest();
});

describe('POST /api/kline-overlays', () => {
  it('水平线（1 点）创建成功并返回记录', async () => {
    const res = await createOverlay({
      symbol: SYMBOL,
      period: 'day',
      name: 'horizontalStraightLine',
      points: [{ timestamp: TS1, value: 10.5 }],
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.code).toBe(0);
    expect(body.data.symbol).toBe(SYMBOL);
    expect(body.data.points).toEqual([{ timestamp: TS1, value: 10.5 }]);
    expect(typeof body.data.id).toBe('number');
  });

  it('斐波那契（2 点）按 timestamp + value 原样落库', async () => {
    const points = [
      { timestamp: TS1, value: 10 },
      { timestamp: TS2, value: 12 },
    ];
    const res = await createOverlay({
      symbol: SYMBOL,
      period: 'week',
      name: 'fibonacciLine',
      points,
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.name).toBe('fibonacciLine');
    expect(body.data.points).toEqual(points);
  });

  it('文字标注必须带文字', async () => {
    const res = await createOverlay({
      symbol: SYMBOL,
      period: 'day',
      name: 'simpleAnnotation',
      points: [{ timestamp: TS1, value: 10 }],
      text: '   ',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('OVERLAY_INVALID');
  });

  it('点数不足被拒绝', async () => {
    const res = await createOverlay({
      symbol: SYMBOL,
      period: 'day',
      name: 'priceChannelLine',
      points: [{ timestamp: TS1, value: 10 }],
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain('需要 3 个落点');
  });

  it('不支持的画线工具被拒绝', async () => {
    const res = await createOverlay({
      symbol: SYMBOL,
      period: 'day',
      name: 'segment',
      points: [{ timestamp: TS1, value: 10 }],
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain('不支持的画线工具');
  });

  it('非法 symbol 被拒绝', async () => {
    const res = await createOverlay({
      symbol: '600000',
      period: 'day',
      name: 'horizontalStraightLine',
      points: [{ timestamp: TS1, value: 10 }],
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/kline-overlays', () => {
  it('按标的 + 周期返回，且不影响其他周期', async () => {
    // ⚠️ 本文件用例顺序会被 `sequence.shuffle` 打乱 ⇒ 不能依赖前面 POST 用例留下的数据，
    //    必须在本用例内自建（否则全量跑随机失败、单跑侥幸通过）
    const createdDay = await createOverlay({
      symbol: SYMBOL,
      period: 'day',
      name: 'horizontalStraightLine',
      points: [{ timestamp: TS1, value: 10 }],
    });
    expect(createdDay.statusCode).toBe(201);
    const createdWeek = await createOverlay({
      symbol: SYMBOL,
      period: 'week',
      name: 'fibonacciLine',
      points: [
        { timestamp: TS1, value: 10 },
        { timestamp: TS2, value: 12 },
      ],
    });
    expect(createdWeek.statusCode).toBe(201);

    const dayRes = await bundle.app.inject({
      method: 'GET',
      url: `/api/kline-overlays?symbol=${SYMBOL}&period=day`,
      headers: authHeaders(bundle.adminToken),
    });
    expect(dayRes.statusCode).toBe(200);
    const dayBody = JSON.parse(dayRes.body);
    expect(dayBody.code).toBe(0);
    expect(dayBody.data.length).toBeGreaterThanOrEqual(1);
    expect(dayBody.data.every((row: { period: string }) => row.period === 'day')).toBe(true);

    const monthRes = await bundle.app.inject({
      method: 'GET',
      url: `/api/kline-overlays?symbol=${SYMBOL}&period=month`,
      headers: authHeaders(bundle.adminToken),
    });
    expect(JSON.parse(monthRes.body).data).toEqual([]);
  });
});

describe('DELETE /api/kline-overlays/:id', () => {
  it('软删除后列表不再返回，重复删除 404', async () => {
    const createRes = await createOverlay({
      symbol: SYMBOL,
      period: 'day',
      name: 'rayLine',
      points: [
        { timestamp: TS1, value: 10 },
        { timestamp: TS2, value: 11 },
      ],
    });
    const id = JSON.parse(createRes.body).data.id as number;

    const delRes = await bundle.app.inject({
      method: 'DELETE',
      url: `/api/kline-overlays/${id}`,
      headers: authHeaders(bundle.adminToken),
    });
    expect(delRes.statusCode).toBe(200);

    const listRes = await bundle.app.inject({
      method: 'GET',
      url: `/api/kline-overlays?symbol=${SYMBOL}&period=day`,
      headers: authHeaders(bundle.adminToken),
    });
    const rows = JSON.parse(listRes.body).data as Array<{ id: number }>;
    expect(rows.some((row) => row.id === id)).toBe(false);

    const again = await bundle.app.inject({
      method: 'DELETE',
      url: `/api/kline-overlays/${id}`,
      headers: authHeaders(bundle.adminToken),
    });
    expect(again.statusCode).toBe(404);
  });

  it('不能删除其他用户的标注', async () => {
    const createRes = await createOverlay({
      symbol: SYMBOL,
      period: 'day',
      name: 'horizontalStraightLine',
      points: [{ timestamp: TS1, value: 10 }],
    });
    const id = JSON.parse(createRes.body).data.id as number;

    const otherToken = makeUserToken(9999, 'other_user');
    const res = await bundle.app.inject({
      method: 'DELETE',
      url: `/api/kline-overlays/${id}`,
      headers: authHeaders(otherToken),
    });
    expect(res.statusCode).toBe(404);
  });
});
