import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeSystemLog } from './logger.js';
import { enterDuckDBWriteWindow } from '../db/duckdb.js';

/**
 * 行情更新补跑（G3a — PRD D3「WARN 级别校验自动触发补跑」+ SDD §5.1 Step 3）
 *
 * 场景：17:00 systemd timer 跑完 tdx2db 后，17:01 C1-C12 校验发现 WARN/ERROR
 *      （典型：tdx2db exit_code=0 但当日数据没落库 / 落库不全）。
 * 自愈动作：再跑一次 tdx2db，然后重新校验。
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

/** 补跑后等待落库稳定的最长时间 */
const RETRY_SETTLE_MS = Number(process.env.TDX2DB_RERUN_SETTLE_MS ?? 3_000);

/** tdx2db 二进制路径（服务器 deploy.sh 装到 /usr/local/bin） */
const TDX2DB_BIN = process.env.TDX2DB_BIN ?? '/usr/local/bin/tdx2db';

/** DuckDB URI（与 deploy/tdx2db.service 保持一致） */
const DUCKDB_URI = process.env.TDX2DB_DBURI ?? `duckdb:///${process.env.DUCKDB_PATH ?? 'data/quotes.duckdb'}`;

export interface RerunResult {
  status: 'SUCCESS' | 'FAIL' | 'SKIP';
  method: 'systemd-run' | 'systemctl' | 'exec' | 'none';
  exitCode?: number;
  message: string;
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
      message: 'WARN/ERROR 触发 tdx2db 补跑（systemd-run）成功',
      detail: text.slice(0, 500) || undefined,
    });
    return { status: 'SUCCESS', method: 'systemd-run', exitCode: 0, message: text || 'systemd-run 补跑成功' };
  } catch (err: any) {
    // systemd-run 不存在 / 无权限 / tdx2db 失败 → 交给下一级
    writeSystemLog({
      logType: 'tdx2db_update',
      level: 'WARN',
      message: 'systemd-run 补跑未成功，尝试降级方式',
      detail: String(err).slice(0, 300),
    });
    return null;
  }
}

async function _trySystemctl(): Promise<RerunResult | null> {
  try {
    await execFileAsync('systemctl', ['start', 'tdx2db.service'], { timeout: 30_000 });
    // 异步启动，轮询等待 oneshot 结束
    const deadline = Date.now() + RERUN_TIMEOUT_MS;
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
          message: `WARN/ERROR 触发 tdx2db 补跑（systemctl）${ok ? '成功' : '失败'}`,
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
      message: 'WARN/ERROR 触发 tdx2db 补跑（直接 exec）成功',
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
      detail: String(err).slice(0, 300),
    });
    return null;
  }
}

/**
 * 触发一次行情更新补跑（降级链 systemd-run → systemctl → exec → SKIP）
 *
 * 补跑成功后等 RETRY_SETTLE_MS 让 DuckDB 落盘稳定，再由调用方重新校验。
 */
export async function rerunQuoteUpdate(reason: string): Promise<RerunResult> {
  writeSystemLog({
    logType: 'tdx2db_update',
    level: 'WARN',
    message: `触发行情更新补跑（原因：${reason}）`,
    detail: `dburi=${DUCKDB_URI}`,
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

  const result = (await _trySystemdRun()) ?? (await _trySystemctl()) ?? (await _tryDirectExec());

  if (releaseWriteWindow) releaseWriteWindow();

  if (result) {
    if (result.status === 'SUCCESS') {
      await new Promise((r) => setTimeout(r, RETRY_SETTLE_MS));
    }
    return result;
  }

  writeSystemLog({
    logType: 'tdx2db_update',
    level: 'SKIP',
    message: '补跑不可用（无 systemd 且无 tdx2db 二进制），保持现状继续主流程',
  });
  return { status: 'SKIP', method: 'none', message: '补跑通道不可用' };
}
