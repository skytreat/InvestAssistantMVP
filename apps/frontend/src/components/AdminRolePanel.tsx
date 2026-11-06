import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { isOkEnvelope } from '../api/envelope';
import { extractErrorMessage } from '../api/errors';
import { useUserStore } from '../store/user';
import { COLORS, RADIUS, SPACING, TYPO } from '../theme/tokens';
import {
  buttonDisabledStyle,
  buttonStyle,
  dangerButtonStyle,
  errorStyle,
  successStyle,
  tableStyle,
  thStyle,
  thTdStyle,
} from '../theme/styles';
import ConfirmDialog from './ConfirmDialog';
import ScrollableTable from './ScrollableTable';

/**
 * 管理员「角色管理」面板（Wave 7 · T75 ③ · 关闭 F-A3）
 *
 * ## 交付了什么（对应 PRD §5.7 行 272「角色管理」+ §5.9 行 302「管理员双重鉴权」）
 *
 * | PRD 要求 | 本组件的落点 |
 * |---|---|
 * | 用户列表 | `GET /api/admin/users` → 用户名 / 角色 / 创建时间 |
 * | 升级 / 降级按钮 | `PATCH /api/admin/role/:userId`，body `{ role: 'admin' \| 'user' }` |
 * | admin 仅 1 人，可转移（UX-08）| 「升 admin」= **转移管理员**：后端同一事务内「升目标 + 降自己」 |
 * | 管理员双重鉴权 | 升级 / 降级都要走 `ConfirmDialog` 二次确认后才发请求 |
 *
 * ## 前端禁用 vs 后端 400 —— 谁才是权威
 *
 * 前端的「禁用 + 提示文案」**只是 UX**，真正的约束在后端
 * （`routes/admin.ts`：禁止降级自己 / admin 只能有 1 人）。
 * ⇒ 后端真拒绝时（400 `PARAM_INVALID`）必须把后端文案显示成内联错误条，
 *    不能吞掉、也不能只弹一个没有信息量的提示。
 *
 * ## 「当前登录账号」怎么认
 *
 * 后端比的是**用户 id**（`targetId === operator.sub`），但前端会话里只有
 * `username`（`store/user.ts` 不保存 id）⇒ 前端按 **username** 匹配当前登录用户，
 * 用于禁用「降级自己」按钮。这只是 UX 层的提前拦截，**最终仍以后端为准**。
 */

/** 用户一行（`GET /api/admin/users` 的返回项，字段名与后端一致） */
export interface AdminUser {
  readonly id: number;
  readonly username: string;
  readonly role: string;
  readonly created_at?: string | null;
}

/** 后端统一 envelope 的最小形状（只取本组件读得到的字段） */
interface ApiEnvelope<T> {
  /** 🔴 T89b：成功判定唯一口径 `code === 0`（后端已删 `success` 字段） */
  readonly code?: number | string;
  readonly message?: string;
  readonly data?: T;
}

/** 角色中文名 */
const ROLE_LABEL: Record<string, string> = {
  admin: '管理员',
  user: '普通用户',
};

/**
 * 与后端 `routes/admin.ts` 口径一致的提示文案（UX-08）
 *
 * ⚠️ 旧的「已有管理员，请先降级现任管理员」与「不能降级当前登录账号」互相指向对方，
 *    形成没有出口的死锁 ⇒ 现在只保留「降自己」这一条，并把出口指向「转移管理员」。
 */
const HINT_CANNOT_DEMOTE_SELF = '不能直接降级自己；请用「转移管理员」把管理员交给其他用户';

/** 面板内部的次级标题 */
const subTitleStyle = {
  fontSize: TYPO.bodySize,
  fontWeight: TYPO.cardTitleWeight,
  color: COLORS.textPrimary,
  marginBottom: SPACING.gapBase,
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

/** 行内提示文案（禁用原因） */
const hintStyle = {
  color: COLORS.neutral,
  fontSize: TYPO.captionSize,
  marginTop: SPACING.gapTight,
};

/**
 * 禁用态按钮样式
 *
 * ⚠️ **必须与可用态区分开** —— 禁用按钮若沿用主色底，用户会以为「能点但没反应」。
 *    `theme/styles.ts` 的 `buttonDisabledStyle`（灰底 + `not-allowed` 光标）就是干这个的。
 */
const disabledButtonStyle = { ...buttonStyle, ...buttonDisabledStyle };

export interface AdminRolePanelProps {
  /**
   * 当前登录用户名（用于禁用「降级自己」按钮）
   *
   * 缺省时从用户 store 读（`store/user.ts` 的 `username`）。
   * 显式传入是为了让页面/测试能覆盖这个来源。
   */
  readonly currentUsername?: string | null;
}

/**
 * 待确认的角色变更
 *
 * - `transfer` —— 把管理员转移给目标（同一事务内「升目标 + 降自己」）
 * - `promote` —— 库里尚无管理员时的直接升级
 * - `demote` —— 降级另一个管理员
 */
interface PendingRoleChange {
  readonly user: AdminUser;
  readonly nextRole: 'admin' | 'user';
  readonly kind: 'transfer' | 'promote' | 'demote';
}

export default function AdminRolePanel({ currentUsername }: AdminRolePanelProps) {
  const storeUsername = useUserStore((s) => s.username);
  const self = currentUsername !== undefined ? currentUsername : storeUsername;

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [pending, setPending] = useState<PendingRoleChange | null>(null);
  /** 变更失败时记住「是哪一次变更失败的」—— 重试按钮要拿它重新发起 */
  const [failedChange, setFailedChange] = useState<PendingRoleChange | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const res = await api.get('/admin/users');
      const body = res.data as ApiEnvelope<AdminUser[]>;
      if (isOkEnvelope(body)) {
        setUsers(Array.isArray(body.data) ? body.data : []);
      } else {
        setListError(body?.message ?? '读取用户列表失败');
      }
    } catch (err) {
      setListError(extractErrorMessage(err, '读取用户列表失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  /**
   * 库里是否已经有管理员
   *
   * - 有 → 对非 admin 行的「升 admin」是**转移**（自己会失去管理员权限）
   * - 无 → 是普通**升级**（只在库中没有任何 admin 的异常/初始状态下可达）
   */
  const hasAdmin = users.some((u) => u.role === 'admin');

  /** 执行角色变更 —— 调用方必须已经拿到过用户的显式确认 */
  const applyRoleChange = async (change: PendingRoleChange) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setFailedChange(null);
    try {
      const res = await api.patch(`/admin/role/${change.user.id}`, { role: change.nextRole });
      const body = res.data as ApiEnvelope<null>;
      if (isOkEnvelope(body)) {
        if (change.kind === 'transfer') {
          setNotice(`已将管理员转移给「${change.user.username}」，你已变为普通用户`);
          // 转移成功 = 当前账号已失去管理员权限 ⇒ 同步会话角色，让 AdminGuard 立即生效
          useUserStore.setState({ role: 'user' });
        } else {
          const label = change.nextRole === 'admin' ? '管理员' : '普通用户';
          setNotice(`已将「${change.user.username}」的角色改为${label}`);
        }
        await loadUsers();
      } else {
        setError(body?.message ?? '角色变更失败');
        setFailedChange(change);
      }
    } catch (err) {
      // 后端 400 PARAM_INVALID（如「不能直接降级自己…」「管理员数量不为 1，已整体回滚」）落成内联错误条
      setError(extractErrorMessage(err, '角色变更失败'));
      setFailedChange(change);
    } finally {
      setBusy(false);
    }
  };

  const confirmRoleChange = () => {
    const change = pending;
    setPending(null);
    if (change) void applyRoleChange(change);
  };

  return (
    <div>
      <div style={subTitleStyle}>用户列表</div>

      {loading && <div style={{ color: COLORS.neutral }}>读取用户列表中…</div>}
      {listError !== null && (
        <div style={errorStyle} data-testid="role-list-error">
          {listError}
          <button
            type="button"
            style={{ ...buttonStyle, marginLeft: SPACING.gapBase }}
            onClick={() => void loadUsers()}
          >
            重试
          </button>
        </div>
      )}
      {!loading && listError === null && (
        <ScrollableTable label="用户列表表">
          <table style={tableStyle} aria-label="用户列表">
            <thead>
              <tr>
                <th scope="col" style={thStyle}>
                  用户名
                </th>
                <th scope="col" style={thStyle}>
                  角色
                </th>
                <th scope="col" style={thStyle}>
                  创建时间
                </th>
                <th scope="col" style={thStyle}>
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 ? (
                <tr>
                  <td style={thTdStyle} colSpan={4}>
                    暂无用户
                  </td>
                </tr>
              ) : (
                users.map((u) => {
                  const isAdmin = u.role === 'admin';
                  const isSelf = self !== null && self !== undefined && u.username === self;
                  // 降级自己 → 禁用（会制造「0 个 admin」，后端同样 400）
                  const demoteDisabled = isAdmin && isSelf;
                  // 库里已有 admin + 目标不是 admin → 「转移管理员」（后端原子转移）
                  const isTransfer = !isAdmin && hasAdmin;
                  const hint = demoteDisabled ? HINT_CANNOT_DEMOTE_SELF : null;
                  return (
                    <tr key={u.id} data-testid="role-row">
                      <td style={thTdStyle}>{u.username}</td>
                      <td style={thTdStyle}>{ROLE_LABEL[u.role] ?? u.role}</td>
                      <td style={thTdStyle}>{u.created_at ?? '-'}</td>
                      <td style={thTdStyle}>
                        {isAdmin ? (
                          <button
                            type="button"
                            style={
                              demoteDisabled ? disabledButtonStyle : { ...buttonStyle, ...dangerButtonStyle }
                            }
                            onClick={() => setPending({ user: u, nextRole: 'user', kind: 'demote' })}
                            disabled={busy || demoteDisabled}
                          >
                            降级为普通用户
                          </button>
                        ) : (
                          <button
                            type="button"
                            style={buttonStyle}
                            aria-label={
                              isTransfer
                                ? `转移管理员给 ${u.username}（你将失去管理员权限）`
                                : `升级 ${u.username} 为管理员`
                            }
                            onClick={() =>
                              setPending({
                                user: u,
                                nextRole: 'admin',
                                kind: isTransfer ? 'transfer' : 'promote',
                              })
                            }
                            disabled={busy}
                          >
                            {isTransfer ? '转移管理员' : '升级为管理员'}
                          </button>
                        )}
                        {hint !== null && (
                          <div style={hintStyle} data-testid="role-hint">
                            {hint}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </ScrollableTable>
      )}

      {/* 内联反馈区 —— 后端拒绝时显示后端原文案 */}
      <div aria-live="polite" aria-busy={busy} data-testid="role-status">
        {notice !== null && (
          <div
            style={{ ...statusBarStyle, ...successStyle, color: COLORS.textSuccess }}
            data-testid="role-notice"
          >
            {notice}
          </div>
        )}
        {error !== null && (
          <div style={{ ...statusBarStyle, ...errorStyle }} data-testid="role-error">
            {error}
            <button
              type="button"
              style={{ ...buttonStyle, marginLeft: SPACING.gapBase }}
              onClick={() => {
                if (failedChange) void applyRoleChange(failedChange);
              }}
              disabled={busy}
            >
              重试
            </button>
          </div>
        )}
      </div>

      {/* 角色变更二次确认 —— 复用既有 ConfirmDialog（自带 role=dialog + ESC 关闭） */}
      <ConfirmDialog
        open={pending !== null}
        title={pending?.kind === 'transfer' ? '确认转移管理员' : '确认变更角色'}
        message={
          pending
            ? pending.kind === 'transfer'
              ? `将管理员角色转移给「${pending.user.username}」？\n确认后你将失去管理员权限，目标用户成为唯一管理员。`
              : `将「${pending.user.username}」的角色改为${
                  pending.nextRole === 'admin' ? '管理员' : '普通用户'
                }，确认继续？`
            : ''
        }
        confirmText={pending?.kind === 'transfer' ? '确认转移' : '确认变更'}
        cancelText="取消"
        danger={pending?.kind === 'transfer' || pending?.nextRole === 'user'}
        onConfirm={confirmRoleChange}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
