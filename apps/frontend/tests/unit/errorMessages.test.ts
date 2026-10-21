import { describe, it, expect } from 'vitest';
import { ERROR_MESSAGES, resolveErrorMessage, resolveErrorHint } from '../../src/api/errorMessages';
import {
  extractErrorMessage,
  extractErrorMessageOrString,
  extractErrorMessageOrErrorMessage,
} from '../../src/api/errors';

/**
 * T64 · 错误码表一致性用例
 *
 * 🎯 **验收点 ①：每个错误码都有中文文案**
 *
 * ⚠️ **后端表不能被前端 import**（`apps/frontend` 不依赖 `apps/backend`，
 *    那是 monorepo 的结构约束）。故这里把后端表
 *    （`apps/backend/src/lib/errorMessages.ts`）**抄成常量快照**，
 *    断言前端表**逐码覆盖**它。
 *
 * 🔒 **后端表变更时必须同步本快照**（否则本用例会红）——
 *   这正是「两表不一致」要被抓到的机制：宁可测试红，也不许用户看到裸错误码。
 */
const BACKEND_ERROR_MESSAGES: Record<string, string> = {
  // ── SDD §4.3 主表 ──
  PARAM_INVALID: '请求参数不合法',
  TRADE_REASON_REQUIRED: '请填写本次操作理由',
  HOLDING_INSUFFICIENT: '持仓不足，无法减仓或清仓',
  TRADE_DUPLICATE: '该标的在该时刻已有同类型交易',
  DUPLICATE_IMPORT: '除权数据已导入，已跳过',
  SYMBOL_NOT_FOUND: '标的不存在',
  USER_EXISTS: '用户名已存在',
  UNAUTHORIZED: '登录已失效，请重新登录',
  FORBIDDEN: '无权限执行该操作',
  INTERNAL_ERROR: '服务内部错误',
  DB_UNAVAILABLE: '数据库不可用',
  EXTERNAL_SOURCE_UNAVAILABLE: '外部行情源暂不可用',

  // ── 扩展码 ──
  PLUGIN_NOT_FOUND: '插件不存在',
  SEARCH_FAILED: '搜索失败',
  KLINE_QUERY_FAILED: 'K 线数据查询失败',
  RESTORE_FAILED: '备份恢复失败',
  CONFIRM_REQUIRED: '该操作需要显式确认',
  ADMIN_ALREADY_EXISTS: '系统已存在管理员账号',
  SEED_PASSWORD_REQUIRED: '请提供初始密码',
  REGISTRATION_CLOSED: '注册已关闭',
  DUPLICATE: '该标的已存在于该列表',
  NOT_FOUND: '资源不存在',

  // ── 后端保留的旧别名（T64 补齐到前端的 3 个）──
  INVALID_TOKEN: '登录已失效，请重新登录',
  NO_TOKEN: '缺少 Authorization: Bearer <jwt>',
  INVALID_SYMBOL: '标的不存在',
};

describe('T64 · 错误码表与后端一致', () => {
  it('前端码表覆盖后端全部 25 个码（key 集合 ⊇ 后端）', () => {
    const frontendKeys = Object.keys(ERROR_MESSAGES);
    for (const code of Object.keys(BACKEND_ERROR_MESSAGES)) {
      expect(frontendKeys, `前端码表缺少后端的 ${code}`).toContain(code);
    }
    expect(Object.keys(BACKEND_ERROR_MESSAGES).length).toBe(25);
  });

  it('前端码表恰好 25 个码（与后端表**完全一致**，不多不少）', () => {
    expect(Object.keys(ERROR_MESSAGES).length).toBe(25);
    expect(Object.keys(ERROR_MESSAGES).sort()).toEqual(Object.keys(BACKEND_ERROR_MESSAGES).sort());
  });

  it('同一错误码在前后端两表里的中文文案逐字相同', () => {
    for (const [code, message] of Object.entries(BACKEND_ERROR_MESSAGES)) {
      expect(ERROR_MESSAGES[code]?.message, `${code} 的文案与后端不一致`).toBe(message);
    }
  });

  it('每个码都有非空中文文案（不允许空串 / 纯英文 / 裸码）', () => {
    for (const [code, entry] of Object.entries(ERROR_MESSAGES)) {
      expect(entry.message, `${code} 缺 message`).toBeTruthy();
      expect(entry.message.trim(), `${code} 的 message 是空串`).not.toBe('');
      // 裸码上屏是最严重的 UX 事故（G1.4b）——文案不能就是错误码本身
      expect(entry.message.trim(), `${code} 的 message 就是裸错误码`).not.toBe(code);
      // 必须含中文
      expect(/[一-龥]/.test(entry.message), `${code} 的 message 没有中文`).toBe(true);
    }
  });

  it('UNAUTHORIZED 的 hint 体现 PRD §5.9 语义（跳登录 + 保留原路径）', () => {
    const hint = ERROR_MESSAGES.UNAUTHORIZED.hint ?? '';
    expect(hint).toContain('登录');
    expect(hint).toContain('返回');
  });

  it('USER_EXISTS：建号重名是业务冲突，不是「服务内部错误」', () => {
    expect(ERROR_MESSAGES.USER_EXISTS.message).toBe('用户名已存在');
    expect(ERROR_MESSAGES.USER_EXISTS.message).not.toContain('内部错误');
    // 回落链可用：只给 code 也能翻出中文
    expect(resolveErrorMessage({ code: 'USER_EXISTS' })).toBe('用户名已存在');
  });
});

describe('T64 · 错误码回落（message 缺失 → 查表 → 兜底）', () => {
  it('resolveErrorMessage：message 存在时优先用 message', () => {
    expect(resolveErrorMessage({ message: '后端给的中文', code: 'HOLDING_INSUFFICIENT' })).toBe(
      '后端给的中文',
    );
  });

  it('resolveErrorMessage：message 缺失时按 code 查表', () => {
    expect(resolveErrorMessage({ code: 'HOLDING_INSUFFICIENT' })).toBe('持仓不足，无法减仓或清仓');
  });

  it('resolveErrorMessage：code 也查不到时用兜底文案', () => {
    expect(resolveErrorMessage({ code: 'NOT_A_KNOWN_CODE' }, '兜底')).toBe('兜底');
    expect(resolveErrorMessage(null, '兜底')).toBe('兜底');
  });

  it('resolveErrorMessage：error 字段与 code 同值时也能查到（后端 envelope 双写）', () => {
    expect(resolveErrorMessage({ error: 'PARAM_INVALID' })).toBe('请求参数不合法');
  });

  it('resolveErrorHint：按 code 取操作建议', () => {
    expect(resolveErrorHint({ code: 'HOLDING_INSUFFICIENT' })).toContain('持仓');
    expect(resolveErrorHint({ code: 'NOT_A_KNOWN_CODE' })).toBeUndefined();
  });

  it('extractErrorMessage：无 message 有 code → 返回码表中文文案（不是裸码）', () => {
    const err = {
      response: { status: 409, data: { code: 'HOLDING_INSUFFICIENT', error: 'HOLDING_INSUFFICIENT' } },
    };
    const text = extractErrorMessage(err);
    expect(text).toBe('持仓不足，无法减仓或清仓');
    expect(text).not.toBe('HOLDING_INSUFFICIENT');
  });

  it('extractErrorMessage：message 存在时仍优先用 message（既有行为不变）', () => {
    const err = {
      response: { status: 409, data: { code: 'HOLDING_INSUFFICIENT', message: '后端自定义文案' } },
    };
    expect(extractErrorMessage(err)).toBe('后端自定义文案');
  });

  it('extractErrorMessage：message 为空串时原样返回（`??` 语义，不退回码表）', () => {
    const err = { response: { status: 400, data: { code: 'PARAM_INVALID', message: '' } } };
    expect(extractErrorMessage(err)).toBe('');
  });

  it('extractErrorMessage：既无 message 也无已知 code → 用调用方兜底文案', () => {
    const err = { response: { status: 500, data: { code: 'WHATEVER' } } };
    expect(extractErrorMessage(err, '加载失败')).toBe('加载失败');
  });

  it('extractErrorMessageOrString：无 message 有 code → 查表（不是裸码，也不是 String(err)）', () => {
    const err = { response: { status: 409, data: { code: 'HOLDING_INSUFFICIENT' } } };
    expect(extractErrorMessageOrString(err)).toBe('持仓不足，无法减仓或清仓');
  });

  it('extractErrorMessageOrErrorMessage：无 message 有 code → 查表', () => {
    const err = { response: { status: 409, data: { code: 'HOLDING_INSUFFICIENT' } } };
    expect(extractErrorMessageOrErrorMessage(err)).toBe('持仓不足，无法减仓或清仓');
  });

  it('extractErrorMessageOrString / OrErrorMessage：message 存在时仍优先用 message', () => {
    const err = { response: { status: 409, data: { code: 'HOLDING_INSUFFICIENT', message: '后端自定义' } } };
    expect(extractErrorMessageOrString(err)).toBe('后端自定义');
    expect(extractErrorMessageOrErrorMessage(err)).toBe('后端自定义');
  });
});
