import React, { useEffect, useId } from 'react';
import { COLORS, SPACING, TYPO } from '../theme/tokens';
// ⚠️ T66 分层收口：样式对象来自 `theme/`（纯常量层），**不再从 `pages/_shared` 取** ——
//    组件层反向依赖页面层属于依赖倒置。
import { buttonStyle, cardStyle } from '../theme/styles';

/**
 * 确认对话框（T65 · ui-spec §4「焦点锁定」项的前置件）
 *
 * **a11y**：
 * - `role="dialog"` + `aria-modal="true"` —— 语义化弹窗；
 * - `aria-labelledby` 指向标题节点（`useId` 生成唯一 id，多实例不串）；
 * - `aria-describedby` 指向正文节点（无正文时不加该属性）；
 * - **ESC 关闭**（纯 JS、成本极低）—— 监听 `document` 的 `keydown`。
 *
 * ⚠️ **焦点锁定 / 焦点回归不在本任务范围** —— 属 **T76 ⑤**（弹窗焦点管理）。
 *    届时需补：打开时把焦点移入弹窗（建议聚焦确认按钮）、
 *    Tab 键在弹窗内循环、关闭后把焦点还给触发元素。
 *    本组件目前**不做**这两件事，避免与 T76 重复实现 / 互相覆盖。
 *
 * `open=false` 时**不渲染任何 DOM**（返回 null）—— 不占位、不进无障碍树。
 */
export interface ConfirmDialogProps {
  /** 是否打开；false 时不渲染任何 DOM */
  open: boolean;
  /** 弹窗标题（必填） */
  title: string;
  /** 正文（可选） */
  message?: string;
  /** 确认按钮文案，默认「确认」 */
  confirmText?: string;
  /** 取消按钮文案，默认「取消」 */
  cancelText?: string;
  /** 危险操作（删除 / 软删除等）→ 确认按钮用红色 */
  danger?: boolean;
  /** 点「确认」 */
  onConfirm: () => void;
  /** 点「取消」或按 ESC */
  onCancel: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmText = '确认',
  cancelText = '取消',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const messageId = useId();

  // ESC 关闭：只在 open 时挂监听，卸载时摘掉
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 只处理本弹窗，避免同时打开的多层弹窗一起被 ESC 关掉
      e.stopPropagation();
      onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  const hasMessage = message !== undefined && message !== null && message !== '';

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: COLORS.maskOverlay,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: SPACING.gapRelaxed,
        zIndex: 400,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hasMessage ? messageId : undefined}
        style={{
          ...cardStyle,
          maxWidth: 480,
          width: '100%',
          marginBottom: 0,
        }}
      >
        <div
          id={titleId}
          style={{
            fontSize: TYPO.h2Size,
            fontWeight: TYPO.h2Weight,
            color: COLORS.textPrimary,
            marginBottom: SPACING.gapBase,
          }}
        >
          {title}
        </div>
        {hasMessage && (
          <div
            id={messageId}
            style={{
              fontSize: TYPO.bodySize,
              color: COLORS.textSecondary,
              whiteSpace: 'pre-wrap',
            }}
          >
            {message}
          </div>
        )}
        <div
          style={{
            display: 'flex',
            gap: SPACING.gapBase,
            justifyContent: 'flex-end',
            marginTop: SPACING.gapRelaxed,
          }}
        >
          <button type="button" style={{ ...buttonStyle, background: COLORS.neutral }} onClick={onCancel}>
            {cancelText}
          </button>
          <button
            type="button"
            style={{
              ...buttonStyle,
              background: danger ? COLORS.danger : COLORS.brand,
            }}
            onClick={onConfirm}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
