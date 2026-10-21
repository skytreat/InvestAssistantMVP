import { useState } from 'react';
import { api } from '../api/client';
import { isOkEnvelope } from '../api/envelope';
import { extractErrorMessage } from '../api/errors';
import { COLORS, RADIUS, SPACING, TYPO } from '../theme/tokens';
import { buttonDisabledStyle, buttonStyle, errorStyle, successStyle } from '../theme/styles';
import ConfirmDialog from './ConfirmDialog';

/**
 * 管理员「手动触发」面板（Wave 7 · T75 ① · PRD §5.7 行 269）
 *
 * ## 交付了什么
 *
 * | PRD 要求 | 本组件的落点 |
 * |---|---|
 * | 手动触发行情更新按钮 | 「立即补跑行情更新」→ `POST /api/admin/rerun-quotes` |
 * | **二次确认弹窗** | 复用 `components/ConfirmDialog.tsx`（**不自造裸遮罩**）|
 * | **进度轮询显示** | 进度轨迹（已提交 → 补跑中 → 完成（通道：…））|
 * | 不阻塞 | **禁止原生 `alert` 弹窗**，反馈走页面内 `aria-live="polite"` 状态区 |
 * | 失败可重试 | 失败状态条上带「重试」按钮 |
 *
 * 另外把「手动触发数据校验」「手动触发信号生成」一并收进本面板 ——
 * 三者都是**管理员手动触发的重操作**，统一走同一套「二次确认 + 内联状态 + 可重试」。
 *
 * ## 关于「进度轮询」
 *
 * 后端 `POST /api/admin/rerun-quotes` 是**同步**接口（补跑完才返回），
 * 没有「查任务状态」的轮询端点 ⇒ 这里的「进度」是**请求生命周期内的阶段轨迹**
 * （已提交 / 补跑中 / 完成），不是定时轮询。若将来后端改成异步任务，
 * 只需把「补跑中」这一段换成轮询，UI 契约不变。
 */

/** 后端统一 envelope 的最小形状（只取本组件读得到的字段） */
interface ApiEnvelope<T> {
  /** 🔴 T89b：成功判定唯一口径 `code === 0`（后端已删 `success` 字段） */
  readonly code?: number | string;
  readonly message?: string;
  readonly data?: T;
}

/** `POST /api/admin/rerun-quotes` 的返回体里本组件用得到的部分 */
interface RerunResult {
  readonly status?: string;
  readonly method?: string;
  readonly message?: string;
}

/** `POST /api/admin/datacheck/trigger` 的返回体里本组件用得到的部分 */
interface DatacheckResult {
  readonly summaries?: unknown[];
}

/** `POST /api/admin/run-signal` 的返回体里本组件用得到的部分 */
interface SignalRunResult {
  readonly stats?: { total?: number; success?: number; timeout?: number; error?: number };
  readonly inserted?: number;
}

/** 触发种类 —— 决定请求地址与二次确认文案 */
type TriggerKind = 'rerun' | 'datacheck' | 'signal';

export interface AdminTriggerPanelProps {
  /** 手动触发校验 / 补跑成功后回调（页面可借此刷新校验卡片） */
  readonly onChecksRefreshed?: () => void;
}

/** 面板内部的次级标题 */
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

/** 状态条底色 —— 浅底 + 边框，避免「彩色底 + 白字」的对比度不足 */
const statusBarStyle = {
  marginTop: SPACING.gapBase,
  padding: SPACING.gapBase,
  borderRadius: RADIUS.sm,
  border: `1px solid ${COLORS.borderLight}`,
  background: COLORS.headerBg,
  fontSize: TYPO.bodySize,
};

/** 各触发动作的展示元数据 */
const TRIGGER_META: Record<
  TriggerKind,
  { buttonText: string; busyText: string; title: string; confirmTitle: string; confirmMessage: string }
> = {
  rerun: {
    buttonText: '立即补跑行情更新',
    busyText: '补跑中…',
    title: '行情更新补跑',
    confirmTitle: '确认补跑行情更新',
    confirmMessage: '补跑会重新拉取并写入全市场日线，耗时较长且会覆盖当日行情数据。\n确认继续？',
  },
  datacheck: {
    buttonText: '执行数据校验',
    busyText: '执行中…',
    title: '手动触发数据校验',
    confirmTitle: '确认执行数据校验',
    confirmMessage: '将执行 C1-C12 全量校验，占用后端计算资源。\n确认继续？',
  },
  signal: {
    buttonText: '执行信号生成',
    busyText: '执行中…',
    title: '手动触发信号生成',
    confirmTitle: '确认执行信号生成',
    confirmMessage: '将按当前自选与持仓执行全部插件并写入信号表。\n确认继续？',
  },
};

export default function AdminTriggerPanel({ onChecksRefreshed }: AdminTriggerPanelProps) {
  // 二次确认弹窗当前针对的动作
  const [pendingKind, setPendingKind] = useState<TriggerKind | null>(null);

  // 行情补跑的进度轨迹（已提交 / 补跑中 / 完成（通道：…））
  const [rerunProgress, setRerunProgress] = useState<string[]>([]);
  const [rerunBusy, setRerunBusy] = useState(false);
  const [rerunError, setRerunError] = useState<string | null>(null);

  // 校验 / 信号的结果
  const [datacheckBusy, setDatacheckBusy] = useState(false);
  const [datacheckNotice, setDatacheckNotice] = useState<string | null>(null);
  const [datacheckError, setDatacheckError] = useState<string | null>(null);

  const [signalBusy, setSignalBusy] = useState(false);
  const [signalNotice, setSignalNotice] = useState<string | null>(null);
  const [signalError, setSignalError] = useState<string | null>(null);

  /** 手动补跑行情更新 —— 二次确认通过后才真正发请求 */
  const runRerun = async () => {
    if (rerunBusy) return;
    setRerunBusy(true);
    setRerunError(null);
    setRerunProgress(['已提交']);
    try {
      // 「补跑中」进轨迹 —— 补跑是同步接口，这一段覆盖整个请求时长
      setRerunProgress((p) => [...p, '补跑中']);
      const res = await api.post('/admin/rerun-quotes', { reason: '管理员手动触发' });
      const body = res.data as ApiEnvelope<RerunResult>;
      if (isOkEnvelope(body)) {
        const result = body.data ?? {};
        if (result.status === 'SUCCESS') {
          setRerunProgress((p) => [...p, `完成（通道：${result.method ?? '未知'}）`]);
          onChecksRefreshed?.();
        } else if (result.status === 'SKIP') {
          setRerunProgress((p) => [...p, '已跳过（本机无 tdx2db 二进制 / systemd 通道）']);
        } else {
          const reason = result.message ?? '未知原因';
          setRerunProgress((p) => [...p, `失败（通道：${result.method ?? '未知'}，${reason}）`]);
          setRerunError(`补跑失败：${reason}`);
        }
      } else {
        setRerunError(body?.message ?? '补跑失败');
        setRerunProgress((p) => [...p, '失败']);
      }
    } catch (err) {
      const message = extractErrorMessage(err, '补跑失败');
      setRerunError(message);
      setRerunProgress((p) => [...p, `失败：${message}`]);
    } finally {
      setRerunBusy(false);
    }
  };

  /** 手动触发数据校验 */
  const runDatacheck = async () => {
    if (datacheckBusy) return;
    setDatacheckBusy(true);
    setDatacheckError(null);
    setDatacheckNotice(null);
    try {
      const res = await api.post('/admin/datacheck/trigger');
      const body = res.data as ApiEnvelope<DatacheckResult>;
      if (isOkEnvelope(body)) {
        const count = body.data?.summaries?.length ?? 0;
        setDatacheckNotice(`校验完成：summaries 数量 = ${count}`);
        onChecksRefreshed?.();
      } else {
        setDatacheckError(body?.message ?? '校验失败');
      }
    } catch (err) {
      setDatacheckError(extractErrorMessage(err, '校验失败'));
    } finally {
      setDatacheckBusy(false);
    }
  };

  /** 手动触发信号生成 */
  const runSignal = async () => {
    if (signalBusy) return;
    setSignalBusy(true);
    setSignalError(null);
    setSignalNotice(null);
    try {
      const res = await api.post('/admin/run-signal');
      const body = res.data as ApiEnvelope<SignalRunResult>;
      if (isOkEnvelope(body)) {
        const stats = body.data?.stats ?? {};
        setSignalNotice(
          `生成完成：total=${stats.total ?? '-'} success=${stats.success ?? '-'} ` +
            `timeout=${stats.timeout ?? '-'} error=${stats.error ?? '-'} ` +
            `inserted=${body.data?.inserted ?? '-'}`,
        );
      } else {
        setSignalError(body?.message ?? '信号生成失败');
      }
    } catch (err) {
      setSignalError(extractErrorMessage(err, '信号生成失败'));
    } finally {
      setSignalBusy(false);
    }
  };

  /** 二次确认通过 —— 按动作种类分发 */
  const confirmTrigger = () => {
    const kind = pendingKind;
    setPendingKind(null);
    if (kind === 'rerun') void runRerun();
    else if (kind === 'datacheck') void runDatacheck();
    else if (kind === 'signal') void runSignal();
  };

  return (
    <div>
      {/* 行情更新补跑 */}
      <div style={subTitleStyle}>{TRIGGER_META.rerun.title}</div>
      <div style={{ fontSize: TYPO.smallSize, color: COLORS.neutral, marginBottom: SPACING.gapBase }}>
        WARN / ERROR 会在 17:01 校验后自动补跑；此处为手动通道。
      </div>
      <button type="button" style={buttonStyle} onClick={() => setPendingKind('rerun')} disabled={rerunBusy}>
        {rerunBusy ? TRIGGER_META.rerun.busyText : TRIGGER_META.rerun.buttonText}
      </button>
      <div aria-live="polite" aria-busy={rerunBusy} data-testid="rerun-status">
        {rerunProgress.length > 0 && (
          <div style={statusBarStyle} data-testid="rerun-progress">
            {rerunProgress.map((step, i) => (
              <span key={`${step}-${i}`}>
                {i > 0 ? ' → ' : ''}
                {step}
              </span>
            ))}
          </div>
        )}
        {rerunError !== null && (
          <div style={{ ...statusBarStyle, ...errorStyle }} data-testid="rerun-error">
            {rerunError}
            <button
              type="button"
              style={{ ...buttonStyle, marginLeft: SPACING.gapBase }}
              onClick={() => void runRerun()}
              disabled={rerunBusy}
            >
              重试
            </button>
          </div>
        )}
      </div>

      {/* 手动触发数据校验 */}
      <div style={{ ...subTitleStyle, marginTop: SPACING.gapRelaxed }}>{TRIGGER_META.datacheck.title}</div>
      <button
        type="button"
        style={datacheckBusy ? disabledButtonStyle : buttonStyle}
        onClick={() => setPendingKind('datacheck')}
        disabled={datacheckBusy}
      >
        {datacheckBusy ? TRIGGER_META.datacheck.busyText : TRIGGER_META.datacheck.buttonText}
      </button>
      <div aria-live="polite" aria-busy={datacheckBusy} data-testid="datacheck-status">
        {datacheckNotice !== null && (
          <div
            style={{ ...statusBarStyle, ...successStyle, color: COLORS.textSuccess }}
            data-testid="datacheck-notice"
          >
            {datacheckNotice}
          </div>
        )}
        {datacheckError !== null && (
          <div style={{ ...statusBarStyle, ...errorStyle }} data-testid="datacheck-error">
            {datacheckError}
            <button
              type="button"
              style={{ ...buttonStyle, marginLeft: SPACING.gapBase }}
              onClick={() => void runDatacheck()}
              disabled={datacheckBusy}
            >
              重试
            </button>
          </div>
        )}
      </div>

      {/* 手动触发信号生成 */}
      <div style={{ ...subTitleStyle, marginTop: SPACING.gapRelaxed }}>{TRIGGER_META.signal.title}</div>
      <button
        type="button"
        style={signalBusy ? disabledButtonStyle : buttonStyle}
        onClick={() => setPendingKind('signal')}
        disabled={signalBusy}
      >
        {signalBusy ? TRIGGER_META.signal.busyText : TRIGGER_META.signal.buttonText}
      </button>
      <div aria-live="polite" aria-busy={signalBusy} data-testid="signal-status">
        {signalNotice !== null && (
          <div
            style={{ ...statusBarStyle, ...successStyle, color: COLORS.textSuccess }}
            data-testid="signal-notice"
          >
            {signalNotice}
          </div>
        )}
        {signalError !== null && (
          <div style={{ ...statusBarStyle, ...errorStyle }} data-testid="signal-error">
            {signalError}
            <button
              type="button"
              style={{ ...buttonStyle, marginLeft: SPACING.gapBase }}
              onClick={() => void runSignal()}
              disabled={signalBusy}
            >
              重试
            </button>
          </div>
        )}
      </div>

      {/* 二次确认 —— 复用既有 ConfirmDialog（自带 role=dialog + ESC 关闭） */}
      <ConfirmDialog
        open={pendingKind !== null}
        title={pendingKind ? TRIGGER_META[pendingKind].confirmTitle : ''}
        message={pendingKind ? TRIGGER_META[pendingKind].confirmMessage : ''}
        confirmText="确认执行"
        cancelText="取消"
        danger={pendingKind === 'rerun'}
        onConfirm={confirmTrigger}
        onCancel={() => setPendingKind(null)}
      />
    </div>
  );
}
