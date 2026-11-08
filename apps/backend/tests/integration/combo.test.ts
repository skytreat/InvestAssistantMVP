/**
 * T133 / PA-07 —— 组合策略配置 API 集成测试（`app.inject()`，不占端口）
 *
 * ⚠️ 后端 vitest 配置开了 `sequence.shuffle`（T81 顺序敏感守卫）⇒ **用例不得依赖顺序**，
 *    每个用例自己建自己的组合（不共享 `comboId`）。
 *
 * 覆盖：CRUD 正链路 / 软删 / 启停 / `config_version` 判据递增 / 参数与白名单 400 / 404 / 鉴权。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, cleanupIntegrationTest, type TestAppBundle } from './_helpers.js';

let bundle: TestAppBundle;

beforeAll(async () => {
  bundle = await createTestApp();
});

afterAll(async () => {
  await bundle.app.close();
  cleanupIntegrationTest();
});

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

const validConditions = [
  { pluginId: 'rsi_oversold', params: { period: 14, oversold: 25, overbought: 70 } },
  { pluginId: 'macd_cross', params: { fast: 12, slow: 26, signal: 9 } },
];

async function createCombo(payload: Record<string, unknown> = {}): Promise<{
  id: string;
  raw: Record<string, unknown>;
}> {
  const res = await bundle.app.inject({
    method: 'POST',
    url: '/api/strategy/combos',
    headers: auth(bundle.adminToken),
    payload: { name: 'RSI+MACD', assetScope: 'exclude_cash', conditions: validConditions, ...payload },
  });
  const body = JSON.parse(res.body);
  return { id: body.data.id as string, raw: body.data as Record<string, unknown> };
}

describe('PA-07 组合策略 CRUD', () => {
  it('POST 新建组合（条件参数补默认值；AND / daily / 冷却 3）', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/strategy/combos',
      headers: auth(bundle.adminToken),
      payload: { name: 'RSI+MACD', assetScope: 'exclude_cash', conditions: validConditions },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.code).toBe(0);
    expect(body.data.name).toBe('RSI+MACD');
    expect(body.data.combineOp).toBe('AND');
    expect(body.data.period).toBe('daily');
    expect(body.data.cooldownBars).toBe(3);
    expect(body.data.configVersion).toBe(1);
    expect(body.data.conditions).toHaveLength(2);
    // 落库参数是「校验后的完整参数」（含默认值），保证回放可复现
    expect(body.data.conditions[0].params).toMatchObject({ period: 14, oversold: 25, overbought: 70, days: 120 });
  });

  it('GET 列表 / 详情', async () => {
    const created = await createCombo();

    const list = await bundle.app.inject({
      method: 'GET',
      url: '/api/strategy/combos',
      headers: auth(bundle.adminToken),
    });
    expect(list.statusCode).toBe(200);
    const listBody = JSON.parse(list.body);
    expect(listBody.data.some((item: { id: string }) => item.id === created.id)).toBe(true);

    const detail = await bundle.app.inject({
      method: 'GET',
      url: `/api/strategy/combos/${created.id}`,
      headers: auth(bundle.adminToken),
    });
    expect(detail.statusCode).toBe(200);
    expect(JSON.parse(detail.body).data.id).toBe(created.id);
  });

  it('PUT 更新判据 → config_version +1；仅改名 → 不递增', async () => {
    const created = await createCombo();

    const changed = await bundle.app.inject({
      method: 'PUT',
      url: `/api/strategy/combos/${created.id}`,
      headers: auth(bundle.adminToken),
      payload: {
        conditions: [
          { ...validConditions[0], params: { period: 14, oversold: 20, overbought: 75 } },
          validConditions[1],
        ],
      },
    });
    expect(changed.statusCode).toBe(200);
    expect(JSON.parse(changed.body).data.configVersion).toBe(2);

    const renamed = await bundle.app.inject({
      method: 'PUT',
      url: `/api/strategy/combos/${created.id}`,
      headers: auth(bundle.adminToken),
      payload: { name: 'RSI+MACD v2' },
    });
    expect(renamed.statusCode).toBe(200);
    const renamedBody = JSON.parse(renamed.body);
    expect(renamedBody.data.name).toBe('RSI+MACD v2');
    expect(renamedBody.data.configVersion).toBe(2);
  });

  it('PUT toggle 停用 → 默认列表不含、include_disabled 含；再启用恢复', async () => {
    const created = await createCombo();

    const off = await bundle.app.inject({
      method: 'PUT',
      url: `/api/strategy/combos/${created.id}/toggle`,
      headers: auth(bundle.adminToken),
      payload: { enabled: '0' },
    });
    expect(off.statusCode).toBe(200);
    expect(JSON.parse(off.body).data.enabled).toBe(false);

    const defaultList = JSON.parse(
      (await bundle.app.inject({
        method: 'GET',
        url: '/api/strategy/combos',
        headers: auth(bundle.adminToken),
      })).body,
    );
    expect(defaultList.data.some((item: { id: string }) => item.id === created.id)).toBe(false);

    const allList = JSON.parse(
      (await bundle.app.inject({
        method: 'GET',
        url: '/api/strategy/combos?include_disabled=1',
        headers: auth(bundle.adminToken),
      })).body,
    );
    expect(allList.data.some((item: { id: string }) => item.id === created.id)).toBe(true);

    const on = await bundle.app.inject({
      method: 'PUT',
      url: `/api/strategy/combos/${created.id}/toggle`,
      headers: auth(bundle.adminToken),
      payload: { enabled: 1 },
    });
    expect(JSON.parse(on.body).data.enabled).toBe(true);
  });

  it('DELETE 软删 → 详情 404、再次删除 404', async () => {
    const created = await createCombo();

    const del = await bundle.app.inject({
      method: 'DELETE',
      url: `/api/strategy/combos/${created.id}`,
      headers: auth(bundle.adminToken),
    });
    expect(del.statusCode).toBe(200);

    const detail = await bundle.app.inject({
      method: 'GET',
      url: `/api/strategy/combos/${created.id}`,
      headers: auth(bundle.adminToken),
    });
    expect(detail.statusCode).toBe(404);

    const again = await bundle.app.inject({
      method: 'DELETE',
      url: `/api/strategy/combos/${created.id}`,
      headers: auth(bundle.adminToken),
    });
    expect(again.statusCode).toBe(404);
  });
});

describe('PA-07 校验与鉴权', () => {
  it('条件不足 2 个 → 400 PARAM_INVALID', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/strategy/combos',
      headers: auth(bundle.adminToken),
      payload: { name: '单条件', conditions: [{ pluginId: 'rsi_oversold' }] },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('PARAM_INVALID');
  });

  it('风险类插件（position_risk_alert）不能当条件 → 400', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/strategy/combos',
      headers: auth(bundle.adminToken),
      payload: {
        name: '含风险',
        conditions: [{ pluginId: 'rsi_oversold' }, { pluginId: 'position_risk_alert' }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('PARAM_INVALID');
  });

  it('未知插件 → 400', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/strategy/combos',
      headers: auth(bundle.adminToken),
      payload: { name: '未知', conditions: [{ pluginId: 'rsi_oversold' }, { pluginId: 'nope_plugin' }] },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('PARAM_INVALID');
  });

  it('跨字段违规参数（oversold >= overbought）→ 400', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/strategy/combos',
      headers: auth(bundle.adminToken),
      payload: {
        name: '坏参数',
        conditions: [
          { pluginId: 'rsi_oversold', params: { period: 14, oversold: 40, overbought: 35 } },
          { pluginId: 'macd_cross' },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('PARAM_INVALID');
  });

  it('condition pluginId 重复 → 400', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/strategy/combos',
      headers: auth(bundle.adminToken),
      payload: {
        name: '重复条件',
        conditions: [{ pluginId: 'rsi_oversold' }, { pluginId: 'rsi_oversold' }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('PARAM_INVALID');
  });

  it('toggle 的 enabled 非布尔 → 400', async () => {
    const created = await createCombo();
    const res = await bundle.app.inject({
      method: 'PUT',
      url: `/api/strategy/combos/${created.id}/toggle`,
      headers: auth(bundle.adminToken),
      payload: { enabled: 'yes' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('PARAM_INVALID');
  });

  it('未登录 → 401', async () => {
    const res = await bundle.app.inject({ method: 'GET', url: '/api/strategy/combos' });
    expect(res.statusCode).toBe(401);
  });
});
