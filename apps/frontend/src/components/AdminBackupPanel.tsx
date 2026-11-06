import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { isOkEnvelope } from '../api/envelope';
import { extractErrorMessage } from '../api/errors';
import { COLORS, RADIUS, SPACING, TYPO } from '../theme/tokens';
import {
  buttonDisabledStyle,
  buttonStyle,
  dangerButtonStyle,
  errorStyle,
  inputStyle,
  successStyle,
  tableStyle,
  thStyle,
  thTdStyle,
  truncatedTextStyle,
} from '../theme/styles';
import ConfirmDialog from './ConfirmDialog';
import ScrollableTable from './ScrollableTable';

/**
 * 管理员「备份与恢复」面板（Wave 7 · T75 ② · 关闭 F-A2）
 *
 * ## 交付了什么（对应 PRD §5.7 行 271「备份恢复」）
 *
 * | PRD 要求 | 本组件的落点 |
 * |---|---|
 * | 手动备份按钮 | 「立即备份」→ `POST /api/admin/backup` |
 * | 备份列表（日期 + 体积）| `GET /api/admin/backups` → 文件名 / 修改时间 / 可读体积 |
 * | 恢复按钮 | UX-10：日常列表不再内联「恢复」；统一走下方「危险恢复区」→ `POST /api/admin/backup/:file/restore` |
 * | 恢复前二次确认 | 危险区内**手输文件名**方可点击恢复，再复用 `ConfirmDialog` 二次确认（**不自造裸遮罩**）|
 *
 * ## 三条硬约束
 *
 * 1. **禁止原生 `alert` 弹窗** —— 全部反馈走页面内 `aria-live="polite"` 状态区。
 *    阻塞式弹窗会打断读屏用户，且承载不了「失败后重试」这个动作。
 * 2. **恢复必须显式带 `confirm: true`** —— 后端 `routes/admin.ts` 收不到该字段
 *    直接 400 `CONFIRM_REQUIRED`（破坏性操作的显式确认闸门）。
 * 3. **只有 SQLite 备份可恢复** —— 后端 `services/backup.ts` 的文件名白名单只接受
 *    `business.db.YYYY-MM-DD`；parquet 备份与 `.pre-restore-*` 安全备份**必然失败**，
 *    所以前端**不渲染**它们的恢复按钮（点了也是白点）。
 *
 * ## 分层约定
 *
 * - **不 import `pages/Admin.tsx`** —— 接线归 Wave 7 的接线卡，本组件只认 props。
 * - **不 import `pages/_shared.tsx`** —— 组件层不得反向依赖页面层（T66 分层收口），
 *   共享样式一律从 `theme/styles` 取。
 * - 本组件**不自带卡片外框与卡片标题** —— 外框由页面（接线卡）提供，
 *   保持「页面管布局、组件管内容」的分工。
 */

/** 备份文件一行（`GET /api/admin/backups` 的返回项，字段名与后端一致） */
export interface BackupEntry {
  /** 文件名（如 `business.db.2026-10-20` / `v_stock_qfq.2026-10-20.parquet`）*/
  readonly name: string;
  /** **字节数**（后端 `stat.size`）—— 前端只做展示换算，不改单位口径 */
  readonly size: number;
  /** 修改时间（ISO 8601 字符串，后端 `stat.mtime.toISOString()`）*/
  readonly modified: string;
}

/** `POST /api/admin/backup` 的返回体里本组件用得到的部分 */
interface BackupRunResult {
  // ⚠️ 这里的 `success` 是**备份服务自己的结果字段**（`services/backup.ts`），
  //    **不是** envelope 的 `success`（T89b 已删）—— 语义不同，刻意保留。
  readonly sqlite?: { readonly success?: boolean; readonly size?: number };
  readonly duckdb?: {
    readonly success?: boolean;
    readonly size?: number;
    /** `ENABLE_QUOTE_BACKUP=false` 时后端返回 true —— 配置跳过，不是失败 */
    readonly skipped?: boolean;
  };
}

/** 后端统一 envelope 的最小形状（只取本组件读得到的字段） */
interface ApiEnvelope<T> {
  /** 🔴 T89b：成功判定唯一口径 `code === 0`（后端已删 `success` 字段） */
  readonly code?: number | string;
  readonly message?: string;
  readonly data?: T;
}

/**
 * 可恢复的 SQLite 备份文件名白名单
 *
 * ⚠️ 必须与后端 `apps/backend/src/services/backup.ts` 的 `RESTORE_FILE_RE` **逐字一致** ——
 *    后端只接受 `business.db.YYYY-MM-DD`；`v_stock_qfq.*.parquet`（行情层备份）
 *    与 `business.db.*.pre-restore-*`（恢复前的安全备份）都**不可恢复**。
 *    前端用同一套正则决定「要不要渲染恢复按钮」，避免制造必然失败的入口。
 */
const RESTORE_FILE_RE = /^business\.db\.\d{4}-\d{2}-\d{2}$/;

/**
 * 字节数 → 可读体积
 *
 * ⚠️ **只做展示换算，不改单位口径** —— 后端 `size` 恒为字节数（SDD §4.4）。
 */
export function formatBackupSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** ISO 时间 → 本地 `YYYY-MM-DD HH:mm:ss`（解析失败时原样返回） */
function formatBackupTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** 面板内部的次级标题（与页面卡片标题区分开） */
const subTitleStyle = {
  fontSize: TYPO.bodySize,
  fontWeight: TYPO.cardTitleWeight,
  color: COLORS.textPrimary,
  marginBottom: SPACING.gapBase,
};

/**
 * 禁用态按钮样式
 *
 * ⚠️ **必须与可用态区分开** —— 禁用按钮若沿用主色底，用户会以为「能点但没反应」。
 */
const disabledButtonStyle = { ...buttonStyle, ...buttonDisabledStyle };

/** 危险恢复区外框（UX-10）—— 虚线红框，与日常备份区视觉分离 */
const dangerZoneStyle = {
  marginTop: SPACING.gapRelaxed,
  padding: SPACING.gapBase,
  border: `1px dashed ${COLORS.danger}`,
  borderRadius: RADIUS.md,
  background: '#fef2f2',
};

/** 状态条底色 —— 浅底 + 边框，避免「彩色底 + 白字」的对比度不足 */
const statusBarStyle = {
  marginTop: SPACING.gapBase,
  padding: SPACING.gapBase,
  borderRadius: RADIUS.sm,
  border: `1px solid ${COLORS.borderLight}`,
  background: COLORS.headerBg,
  fontSize: TYPO.bodySize,
};

export default function AdminBackupPanel() {
  // ── 备份列表 ──
  const [entries, setEntries] = useState<BackupEntry[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  // ── 手动备份 ──
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupNotice, setBackupNotice] = useState<string | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);

  // ── 恢复 ──
  const [restoreTarget, setRestoreTarget] = useState<BackupEntry | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  /** 恢复失败时记住「是哪个文件失败的」—— 重试按钮要拿它重新发起恢复 */
  const [restoreFailedEntry, setRestoreFailedEntry] = useState<BackupEntry | null>(null);

  // ── 危险恢复区（UX-10：恢复入口从日常备份表中拆出）──
  /** 选中的待恢复文件名（空串 = 未选） */
  const [restorePick, setRestorePick] = useState('');
  /** 用户手输的文件名 —— 必须与选中文件名逐字一致才允许恢复 */
  const [restoreConfirmText, setRestoreConfirmText] = useState('');

  /** 只有 SQLite 备份可恢复（与后端白名单一致） */
  const restorableEntries = entries.filter((e) => RESTORE_FILE_RE.test(e.name));
  const pickedEntry = restorableEntries.find((e) => e.name === restorePick) ?? null;
  /** <1MB 的备份多半是早期/测试库，恢复会丢大量数据 —— 需额外警示 */
  const pickedIsSuspiciouslySmall = pickedEntry !== null && pickedEntry.size < 1024 * 1024;
  const confirmNameMatches = pickedEntry !== null && restoreConfirmText.trim() === pickedEntry.name;

  const loadBackups = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      const res = await api.get('/admin/backups');
      const body = res.data as ApiEnvelope<BackupEntry[]>;
      if (isOkEnvelope(body)) {
        setEntries(Array.isArray(body.data) ? body.data : []);
      } else {
        setListError(body?.message ?? '读取备份列表失败');
      }
    } catch (err) {
      setListError(extractErrorMessage(err, '读取备份列表失败'));
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBackups();
  }, [loadBackups]);

  /** 手动备份 —— 期间禁用按钮，避免重复触发（后端会真的跑一次双库备份） */
  const runBackup = async () => {
    if (backupBusy) return;
    setBackupBusy(true);
    setBackupError(null);
    setBackupNotice(null);
    try {
      const res = await api.post('/admin/backup');
      const body = res.data as ApiEnvelope<BackupRunResult>;
      if (isOkEnvelope(body)) {
        const result = body.data ?? {};
        const sqliteOk = result.sqlite?.success === true;
        const duckdbOk = result.duckdb?.success === true;
        const duckdbLabel =
          result.duckdb?.skipped === true ? '已跳过（配置关闭）' : duckdbOk ? '成功' : '失败';
        // UX-13：用户语言（业务库 / 行情库），不再直呼表名
        setBackupNotice(`备份完成：业务库 ${sqliteOk ? '成功' : '失败'} · 行情库 ${duckdbLabel}`);
        await loadBackups();
      } else {
        setBackupError(body?.message ?? '备份失败');
      }
    } catch (err) {
      setBackupError(extractErrorMessage(err, '备份失败'));
    } finally {
      setBackupBusy(false);
    }
  };

  /** 执行恢复 —— 调用方必须已经拿到过用户的显式确认 */
  const doRestore = async (entry: BackupEntry) => {
    if (restoreBusy) return;
    setRestoreBusy(true);
    setRestoreError(null);
    setRestoreNotice(null);
    setRestoreFailedEntry(null);
    try {
      // ⚠️ 文件名必须 URL 编码 —— 后端走 `decodeURIComponent(file)`
      const res = await api.post(`/admin/backup/${encodeURIComponent(entry.name)}/restore`, {
        confirm: true,
      });
      const body = res.data as ApiEnvelope<{ file?: string; safetyBackup?: string }>;
      if (isOkEnvelope(body)) {
        setRestoreNotice(`已从备份恢复：${entry.name}`);
        setRestorePick('');
        setRestoreConfirmText('');
        await loadBackups();
      } else {
        setRestoreError(body?.message ?? '恢复失败');
        setRestoreFailedEntry(entry);
      }
    } catch (err) {
      setRestoreError(extractErrorMessage(err, '恢复失败'));
      setRestoreFailedEntry(entry);
    } finally {
      setRestoreBusy(false);
    }
  };

  /** 确认恢复 —— 二次确认通过后才真正发请求 */
  const confirmRestore = () => {
    const target = restoreTarget;
    setRestoreTarget(null);
    if (target) void doRestore(target);
  };

  return (
    <div>
      {/* 手动备份 */}
      <div style={subTitleStyle}>手动备份</div>
      <button
        type="button"
        style={backupBusy ? disabledButtonStyle : buttonStyle}
        onClick={() => void runBackup()}
        disabled={backupBusy}
      >
        {backupBusy ? '备份中…' : '立即备份'}
      </button>

      {/* 内联反馈区 —— `aria-live` 让读屏也能听到结果；失败给「重试」 */}
      <div aria-live="polite" aria-busy={backupBusy} data-testid="backup-status">
        {backupNotice !== null && (
          <div
            style={{ ...statusBarStyle, ...successStyle, color: COLORS.textSuccess }}
            data-testid="backup-notice"
          >
            {backupNotice}
          </div>
        )}
        {backupError !== null && (
          <div style={{ ...statusBarStyle, ...errorStyle }} data-testid="backup-error">
            {backupError}
            <button
              type="button"
              style={{ ...buttonStyle, marginLeft: SPACING.gapBase }}
              onClick={() => void runBackup()}
              disabled={backupBusy}
            >
              重试
            </button>
          </div>
        )}
      </div>

      {/* 备份列表 —— UX-10：日常列表不再内联「恢复」按钮，恢复到下方独立危险区操作 */}
      <div style={{ ...subTitleStyle, marginTop: SPACING.gapRelaxed }}>备份列表</div>
      {listLoading && <div style={{ color: COLORS.neutral }}>读取备份列表中…</div>}
      {listError !== null && (
        <div style={errorStyle} data-testid="backup-list-error">
          {listError}
          <button
            type="button"
            style={{ ...buttonStyle, marginLeft: SPACING.gapBase }}
            onClick={() => void loadBackups()}
          >
            重试
          </button>
        </div>
      )}
      {!listLoading && listError === null && (
        <ScrollableTable label="备份列表表">
          <table style={tableStyle} aria-label="备份列表">
            <thead>
              <tr>
                <th scope="col" style={thStyle}>
                  文件名
                </th>
                <th scope="col" style={thStyle}>
                  修改时间
                </th>
                <th scope="col" style={thStyle}>
                  体积
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 ? (
                <tr>
                  <td style={thTdStyle} colSpan={3}>
                    暂无备份文件
                  </td>
                </tr>
              ) : (
                entries.map((entry) => (
                  <tr key={entry.name} data-testid="backup-row">
                    <td style={thTdStyle}>
                      <span style={truncatedTextStyle} title={entry.name}>
                        {entry.name}
                      </span>
                    </td>
                    <td style={thTdStyle}>{formatBackupTime(entry.modified)}</td>
                    <td style={thTdStyle}>{formatBackupSize(entry.size)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </ScrollableTable>
      )}

      {/* 危险恢复区（UX-10）—— 与日常备份视觉/结构分离，恢复需手输文件名确认 */}
      <div style={dangerZoneStyle} data-testid="admin-restore-zone">
        <div style={{ ...subTitleStyle, color: COLORS.danger, marginBottom: SPACING.gapTight }}>
          危险恢复区
        </div>
        <div style={{ fontSize: TYPO.captionSize, color: COLORS.textSecondary }}>
          恢复会用备份文件覆盖当前业务库，<strong>操作不可撤销</strong>。备份之后产生的交易与配置变更将丢失。
          恢复前建议先点上方「立即备份」留一份当前数据。
        </div>

        <div style={{ marginTop: SPACING.gapBase, display: 'flex', flexWrap: 'wrap', gap: SPACING.gapBase }}>
          <label htmlFor="restore-pick" style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary }}>
            选择备份
          </label>
          <select
            id="restore-pick"
            value={restorePick}
            onChange={(e) => {
              setRestorePick(e.target.value);
              setRestoreConfirmText('');
            }}
            disabled={restoreBusy}
            style={{ ...inputStyle, minWidth: 240 }}
          >
            <option value="">（选择要恢复的 SQLite 备份）</option>
            {restorableEntries.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name} · {formatBackupSize(entry.size)}
              </option>
            ))}
          </select>
        </div>

        {pickedEntry !== null && (
          <div
            style={{ marginTop: SPACING.gapBase, fontSize: TYPO.captionSize }}
            data-testid="restore-pick-info"
          >
            <div>
              备份日期：{formatBackupTime(pickedEntry.modified)} · 体积：{formatBackupSize(pickedEntry.size)}
            </div>
            {pickedIsSuspiciouslySmall && (
              <div
                style={{ color: COLORS.danger, marginTop: SPACING.gapTight }}
                data-testid="restore-small-warning"
              >
                体积不足 1MB，可能是早期或测试备份，恢复会丢失大量数据，请务必确认后再操作。
              </div>
            )}
          </div>
        )}

        {pickedEntry !== null && (
          <div style={{ marginTop: SPACING.gapBase }}>
            <label
              htmlFor="restore-confirm-name"
              style={{ display: 'block', fontSize: TYPO.smallSize, color: COLORS.textSecondary }}
            >
              请输入上方文件名以确认恢复
            </label>
            <input
              id="restore-confirm-name"
              type="text"
              value={restoreConfirmText}
              onChange={(e) => setRestoreConfirmText(e.target.value)}
              placeholder={pickedEntry.name}
              disabled={restoreBusy}
              style={{ ...inputStyle, minWidth: 240 }}
            />
            <button
              type="button"
              style={
                !confirmNameMatches || restoreBusy
                  ? disabledButtonStyle
                  : { ...buttonStyle, ...dangerButtonStyle, marginLeft: SPACING.gapBase }
              }
              disabled={!confirmNameMatches || restoreBusy}
              onClick={() => {
                if (pickedEntry) setRestoreTarget(pickedEntry);
              }}
            >
              恢复此备份
            </button>
          </div>
        )}
        {restorableEntries.length === 0 && !listLoading && listError === null && (
          <div style={{ marginTop: SPACING.gapBase, color: COLORS.neutral }} data-testid="restore-empty">
            暂无可恢复的 SQLite 备份（行情库 parquet 备份不可恢复）。
          </div>
        )}
      </div>

      {/* 恢复的内联反馈区 */}
      <div aria-live="polite" aria-busy={restoreBusy} data-testid="restore-status">
        {restoreNotice !== null && (
          <div
            style={{ ...statusBarStyle, ...successStyle, color: COLORS.textSuccess }}
            data-testid="restore-notice"
          >
            {restoreNotice}
          </div>
        )}
        {restoreError !== null && (
          <div style={{ ...statusBarStyle, ...errorStyle }} data-testid="restore-error">
            {restoreError}
            <button
              type="button"
              style={{ ...buttonStyle, marginLeft: SPACING.gapBase }}
              onClick={() => {
                if (restoreFailedEntry) setRestoreTarget(restoreFailedEntry);
              }}
              disabled={restoreBusy}
            >
              重试
            </button>
          </div>
        )}
      </div>

      {/* 恢复二次确认 —— 复用既有 ConfirmDialog（自带 role=dialog + ESC 关闭） */}
      <ConfirmDialog
        open={restoreTarget !== null}
        title="确认恢复备份"
        message={
          restoreTarget
            ? [
                `恢复「${restoreTarget.name}」会覆盖当前业务库，操作不可撤销。`,
                `备份时间：${formatBackupTime(restoreTarget.modified)} · 体积：${formatBackupSize(restoreTarget.size)}`,
                restoreTarget.size < 1024 * 1024
                  ? '注意：该备份不足 1MB，可能是早期或测试备份，恢复会丢失大量数据。'
                  : '',
                '备份之后产生的交易与配置变更将丢失。确认继续？',
              ]
                .filter(Boolean)
                .join('\n')
            : ''
        }
        confirmText="确认恢复"
        cancelText="取消"
        danger
        onConfirm={confirmRestore}
        onCancel={() => setRestoreTarget(null)}
      />
    </div>
  );
}
