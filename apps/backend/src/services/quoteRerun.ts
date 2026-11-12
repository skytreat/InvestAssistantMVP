import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeSystemLog } from './logger.js';
import { enterDuckDBWriteWindow, queryDuckDB } from '../db/duckdb.js';

/**
 * 行情更新补跑（G3a — SDD §5.1 Step 3；触发条件已按 ADR-018 收窄）
 *
 * ⚠️ **ADR-018：不要再用它实现「校验 WARN/ERROR → 自动补跑」。**
 * tdx2db `cron` 是增量语义（当日已入库即跳过），而 17:01 校验只在
 * `hasQuoteDataOn(date)=true` 时执行 ⇒ 此时补跑必然空跑。唯一有效的补跑是
 * `runScheduledDatacheck()` 中「tdx2db 报成功但当天无数据」那一支。
 *
 * 每次补跑（含管理员手动触发）会在前后各取一次当日行情指纹，
 * 用 `effective` 明确回答「这次补跑到底有没有改动数据」，避免日志撒谎。
 *
 * 实现方式对齐 SDD §5.1 Step 3：systemd-run --wait 同步等 exit_code（超时 5 分钟）。
 * 降级顺序：
 *   1. systemd-run --wait（服务器 systemd 环境，最准）
 *   2. systemctl start tdx2db.service（无 systemd-run 权限时，异步 + 轮询）
 *   3. 直接 exec tdx2db 二进制（本地开发 / 无 systemd 环境）
 * 三种都不可用（本地开发没装 tdx2db）→ 返回 SKIP，不抛错、不阻塞主流程
 *
 * ⚠️ 只调外部 Go 二进制，Node 侧仍对 DuckDB 只有 SELECT 权限（AGENTS.md 硬约束）
 */

const execFileAsync = promisify(execFile);

/** 单次补跑超时（SDD：5 分钟） */
const RERUN_TIMEOUT_MS = Number(process.env.TDX2DB_RERUN_TIMEOUT_MS ?? 300_000);

/** systemctl 补跑的轮询上限（对齐 tdx2db.service 的 TimeoutStartSec=3600） */
const RERUN_SYSTEMCTL_TIMEOUT_MS = Number(process.env.TDX2DB_RERUN_SYSTEMCTL_TIMEOUT_MS ?? 3_600_000);

/** 补跑后等待落库稳定的最长时间 */
const RETRY_SETTLE_MS = Number(process.env.TDX2DB_RERUN_SETTLE_MS ?? 3_000);

/** tdx2db 二进制路径（服务器 deploy.sh 装到 /usr/local/bin） */
const TDX2DB_BIN = process.env.TDX2DB_BIN ?? '/usr/local/bin/tdx2db';

/** 是否跳过 systemd-run（默认跳过；polkit 认证在此部署环境永远失败） */
function shouldSkipSystemdRun(): boolean {
  return (process.env.TDX2DB_SKIP_SYSTEMD_RUN ?? '1') === '1';
}

/** DuckDB URI（与 deploy/tdx2db.service 保持一致） */
const DUCKDB_URI = process.env.TDX2DB_DBURI ?? `duckdb:///${process.env.DUCKDB_PATH ?? 'data/quotes.duckdb'}`;

export interface RerunOptions {
  /** 补跑针对的交易日；提供时会在补跑前后各取一次当日行情指纹（ADR-018） */
  date?: string;
}

/** 当日行情指纹：三张带日期的原始表，用于判定补跑是否真的改了数据 */
export interface QuoteFingerprint {
  klineRows: number;
  klineHash: string | null;
  basicRows: number;
  basicHash: string | null;
  factorRows: number;
  factorHash: string | null;
}

export interface RerunResult {
  status: 'SUCCESS' | 'FAIL' | 'SKIP';
  method: 'systemd-run' | 'systemctl' | 'exec' | 'none';
  exitCode?: number;
  message: string;
  /** true=数据有变化；false=空跑/已是最新；null=未采集（未传 date 或查询失败） */
  effective?: boolean | null;
  before?: QuoteFingerprint | null;
  after?: QuoteFingerprint | null;
}

const FINGERPRINT_SQL = `SELECT
  (SELECT COUNT(*) FROM raw_kline_daily WHERE date = ?) AS kline_rows,
  (SELECT CAST(COALESCE(SUM(CAST(hash(symbol || '|' || CAST(close AS VARCHAR) || '|' || CAST(volume AS VARCHAR)) AS HUGEINT)), 0) AS VARCHAR)
     FROM raw_kline_daily WHERE date = ?) AS kline_hash,
  (SELECT COUNT(*) FROM raw_basic_daily WHERE date = ?) AS basic_rows,
  (SELECT CAST(COALESCE(SUM(CAST(hash(symbol || '|' || CAST(close AS VARCHAR) || '|' || CAST(totalmv AS VARCHAR)) AS HUGEINT)), 0) AS VARCHAR)
     FROM raw_basic_daily WHERE date = ?) AS basic_hash,
  (SELECT COUNT(*) FROM raw_adjust_factor WHERE date = ?) AS factor_rows,
  (SELECT CAST(COALESCE(SUM(CAST(hash(symbol || '|' || CAST(hfq_factor AS VARCHAR)) AS HUGEINT)), 0) AS VARCHAR)
     FROM raw_adjust_factor WHERE date = ?) AS factor_hash`;

/**
 * 读取某交易日的行情指纹（只读，失败不影响补跑主流程）。
 *
 * 需要三张表**同时**可用；任一缺失（如 CI 迷你库）则返回 null，
 * 上层记录 `effective=null`，不把「采集失败」误判为「空跑」。
 */
export async function readQuoteFingerprint(date: string): Promise<QuoteFingerprint | null> {
  try {
    const rows = await queryDuckDB<{
      kline_rows: number;
      kline_hash: string | null;
      basic_rows: number;
      basic_hash: string | null;
      factor_rows: number;
      factor_hash: string | null;
    }>(FINGERPRINT_SQL, [date, date, date, date, date, date]);
    const r = rows[0];
    if (!r) return null;
    return {
      klineRows: Number(r.kline_rows),
      klineHash: r.kline_hash ?? null,
      basicRows: Number(r.basic_rows),
      basicHash: r.basic_hash ?? null,
      factorRows: Number(r.factor_rows),
      factorHash: r.factor_hash ?? null,
    };
  } catch (err) {
    writeSystemLog({
      logType: 'tdx2db_update',
      level: 'INFO',
      message: `补跑指纹采集失败（不影响补跑）：${date}`,
      detail: String(err).slice(0, 300),
    });
    return null;
  }
}

function sameFingerprint(a: QuoteFingerprint, b: QuoteFingerprint): boolean {
  return (
    a.klineRows === b.klineRows &&
    a.klineHash === b.klineHash &&
    a.basicRows === b.basicRows &&
    a.basicHash === b.basicHash &&
    a.factorRows === b.factorRows &&
    a.factorHash === b.factorHash
  );
}

async function _trySystemdRun(): Promise<RerunResult | null> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'systemd-run',
      ['--wait', '--quiet', '--collect', 'tdx2db', 'cron', '--dburi', DUCKDB_URI],
      { timeout: RERUN_TIMEOUT_MS },
    );
    const text = `${stdout}${stderr}`.trim();
    writeSystemLog({
      logType: 'tdx2db_update',
      level: 'SUCCESS',
      message: 'tdx2db 补跑 exit_code=0（systemd-run）',
      detail: text.slice(0, 500) || undefined,
    });
    return { status: 'SUCCESS', method: 'systemd-run', exitCode: 0, message: text || 'systemd-run 补跑成功' };
  } catch (err: any) {
    // systemd-run 不存在 / 无权限 / tdx2db 失败 → 交给下一级
    writeSystemLog({
      logType: 'tdx2db_update',
      level: 'INFO',
      message: 'systemd-run 不可用，降级到 systemctl',
      detail: String(err?.stderr || err?.stdout || err).slice(0, 500),
    });
    return null;
  }
}

async function _trySystemctl(): Promise<RerunResult | null> {
  try {
    await execFileAsync('systemctl', ['start', 'tdx2db.service'], { timeout: 30_000 });
    // 异步启动，轮询等待 oneshot 结束
    const deadline = Date.now() + RERUN_SYSTEMCTL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3_000));
      const { stdout } = await execFileAsync(
        'systemctl',
        ['show', 'tdx2db.service', '-p', 'ActiveState', '-p', 'ExecMainStatus', '--value'],
        { timeout: 10_000 },
      ).catch(() => ({ stdout: '' }));
      const lines = String(stdout)
        .trim()
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      if (lines.includes('inactive') || lines.includes('failed')) {
        const statusLine = lines.find((l) => /^\d+$/.test(l)) ?? '0';
        const exitCode = Number(statusLine);
        const ok = exitCode === 0;
        writeSystemLog({
          logType: 'tdx2db_update',
          level: ok ? 'SUCCESS' : 'ERROR',
          message: `tdx2db 补跑（systemctl）${ok ? 'exit_code=0' : '失败'}`,
          detail: `exit_code=${exitCode}`,
        });
        return {
          status: ok ? 'SUCCESS' : 'FAIL',
          method: 'systemctl',
          exitCode,
          message: `exit_code=${exitCode}`,
        };
      }
    }
    writeSystemLog({
      logType: 'tdx2db_update',
      level: 'ERROR',
      message: 'systemctl 补跑超时（超过 5 分钟）',
    });
    return { status: 'FAIL', method: 'systemctl', message: 'timeout' };
  } catch (err: any) {
    writeSystemLog({
      logType: 'tdx2db_update',
      level: 'WARN',
      message: 'systemctl 补跑降级失败，尝试直接 exec',
      detail: String(err?.stderr || err?.stdout || err).slice(0, 500),
    });
    return null;
  }
}

async function _tryDirectExec(): Promise<RerunResult | null> {
  try {
    const { stdout, stderr } = await execFileAsync(TDX2DB_BIN, ['cron', '--dburi', DUCKDB_URI], {
      timeout: RERUN_TIMEOUT_MS,
    });
    const text = `${stdout}${stderr}`.trim();
    writeSystemLog({
      logType: 'tdx2db_update',
      level: 'SUCCESS',
      message: 'tdx2db 补跑 exit_code=0（直接 exec）',
      detail: text.slice(0, 500) || undefined,
    });
    return { status: 'SUCCESS', method: 'exec', exitCode: 0, message: text || 'exec 补跑成功' };
  } catch (err: any) {
    // 二进制不存在（ENOENT）是最常见的本地开发场景，不算错误
    const code = err?.code;
    const level = code === 'ENOENT' ? 'INFO' : 'WARN';
    writeSystemLog({
      logType: 'tdx2db_update',
      level,
      message:
        code === 'ENOENT'
          ? 'tdx2db 二进制不存在，跳过补跑（本地开发环境正常现象）'
          : 'tdx2db 直接 exec 补跑失败',
      detail: String(err?.stderr || err?.stdout || err).slice(0, 500),
    });
    return null;
  }
}

/**
 * 触发一次行情更新补跑（降级链 systemd-run → systemctl → exec → SKIP）
 *
 * 传入 `opts.date` 时，补跑前后各采集一次当日行情指纹，结果见 `effective`：
 *   - true  → 数据确有变化
 *   - false → 空跑（tdx2db 增量语义下当日已入库，ADR-018）
 *   - null  → 未采集（未传 date / 采集失败）
 *
 * 补跑成功后等 RETRY_SETTLE_MS 让 DuckDB 落盘稳定，再由调用方重新校验。
 */
export async function rerunQuoteUpdate(reason: string, opts: RerunOptions = {}): Promise<RerunResult> {
  const before = opts.date ? await readQuoteFingerprint(opts.date) : null;

  writeSystemLog({
    logType: 'tdx2db_update',
    level: 'WARN',
    message: `触发行情更新补跑（原因：${reason}）`,
    detail: `dburi=${DUCKDB_URI}${opts.date ? ` date=${opts.date}` : ''}`,
  });

  // 🔴 **方向 B**（ADR-012 §2.3）：Node 自己触发写 ⇒ 必须 Node 主动让锁。
  //   - 先置写窗口标志 + close instance，再 exec tdx2db，结束后清标志
  //   - ⚠️ **只 close 不够**：窗口内并发查询会重建 instance 抢回锁 ⇒ tdx2db 失败
  //   - 三级降级链（systemd-run / systemctl / exec）全部是独立进程 ⇒ 全都要写锁
  //     ⇒ 全部被挡（方向 B 是它们能成功的唯一前提）
  let releaseWriteWindow: (() => void) | null = null;
  try {
    releaseWriteWindow = await enterDuckDBWriteWindow();
  } catch (err) {
    writeSystemLog({
      logType: 'tdx2db_update',
      level: 'WARN',
      message: '进入 DuckDB 写窗口失败，保持现状继续主流程',
      detail: String(err).slice(0, 300),
    });
    return { status: 'FAIL', method: 'none', message: 'enter write window failed' };
  }

  const result =
    (shouldSkipSystemdRun() ? null : await _trySystemdRun()) ??
    (await _trySystemctl()) ??
    (await _tryDirectExec());

  if (releaseWriteWindow) releaseWriteWindow();

  if (result) {
    if (result.status === 'SUCCESS') {
      await new Promise((r) => setTimeout(r, RETRY_SETTLE_MS));
      const after = opts.date ? await readQuoteFingerprint(opts.date) : null;
      const effective = before && after ? !sameFingerprint(before, after) : null;
      writeSystemLog({
        logType: 'tdx2db_update',
        level: effective === false ? 'WARN' : 'INFO',
        message:
          effective === null
            ? '补跑结束：未采集数据指纹，无法判定是否空跑'
            : effective
              ? '补跑结束：当日行情数据有变化'
              : '补跑结束：当日行情数据无变化（空跑）',
        detail: JSON.stringify({ effective, before, after }),
      });
      return { ...result, effective, before, after };
    }
    return { ...result, effective: null, before };
  }

  writeSystemLog({
    logType: 'tdx2db_update',
    level: 'SKIP',
    message: '补跑不可用（无 systemd 且无 tdx2db 二进制），保持现状继续主流程',
  });
  return { status: 'SKIP', method: 'none', message: '补跑通道不可用', effective: null, before };
}
