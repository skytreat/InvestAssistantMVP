// src/services/logger.ts
import { ConfigStore } from '../config/configStore.js';
import fs from 'node:fs';

const FALLBACK_FILE = '/var/log/invol/err.log';

export interface SystemLogEntry {
  logType: string; // datacheck / signal_generate / dividend_import / backup / trigger_manual / startup
  level: string; // INFO / WARN / ERROR / SKIP / SUCCESS
  message: string;
  detail?: string;
  checkItem?: string;
  logDate?: string; // YYYY-MM-DD，默认今天
}

// =====================================================================
// SDD §6 S6 日志脱敏 —— 在 writeSystemLog 内部统一做，三层降级自动脱敏
// =====================================================================

/** 金额脱敏：末 4 位换 ****，只处理整数部分 ≥ 4 位的金额 */
function maskAmount(text: string): string {
  return text.replace(/\b(\d{4,})(\.\d+)?\b/g, (_match, intPart: string, _decPart: string | undefined) => {
    const maskedInt = intPart.slice(0, -4) + '****';
    return maskedInt;
  });
}

/** 用户标识脱敏：username 保留前 2 位，后面 **** */
function maskUserId(text: string): string {
  return text.replace(/(username[:=]\s*)([a-zA-Z0-9_]{2,})/gi, (m, prefix, name: string) => {
    if (name.length <= 2) return m;
    return `${prefix}${name.slice(0, 2)}****`;
  });
}

/**
 * writeSystemLog 三层降级：
 * 1. 正常：写 SQLite system_log
 * 2. SQLite 不可用：降级 console.error → systemd journal 自动捕获
 * 3. 都不可用：降级写文件 /var/log/invol/err.log
 */
export function writeSystemLog(entry: SystemLogEntry): void {
  const { logType, level, message, detail, checkItem, logDate } = entry;
  const date = logDate ?? new Date().toISOString().slice(0, 10);

  // SDD §6 S6 脱敏 —— 三层降级统一使用 safeMessage/safeDetail
  const safeMessage = maskAmount(maskUserId(message ?? ''));
  const safeDetail = detail ? maskAmount(maskUserId(detail)) : undefined;

  // Level 校验
  const ALLOWED_LEVELS = ['INFO', 'WARN', 'ERROR', 'SKIP', 'SUCCESS'];
  if (!ALLOWED_LEVELS.includes(level)) {
    console.warn('[writeSystemLog] 非法 level:', level, '允许:', ALLOWED_LEVELS);
  }

  // 第 1 层：正常写 SQLite
  try {
    const config = ConfigStore.getInstance();
    config.writeLog(logType, level, safeMessage, safeDetail, checkItem, date);
    return; // 成功，直接返回
  } catch (sqliteErr) {
    console.error('[writeSystemLog] SQLite 不可用，降级到 console.error:', sqliteErr);
  }

  // 第 2 层：console.error（systemd journal 自动捕获）
  const journalMsg = JSON.stringify({
    source: 'invest-assistant',
    logType,
    level,
    checkItem,
    message: safeMessage,
    detail: safeDetail,
    date,
  });
  console.error(journalMsg);

  // 第 3 层：写文件（如果 journal 也没接住）
  try {
    fs.appendFileSync(FALLBACK_FILE, journalMsg + '\n', { mode: 0o644 });
  } catch {
    // 彻底放弃
  }
}
