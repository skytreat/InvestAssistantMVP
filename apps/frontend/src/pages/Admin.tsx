import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { extractErrorMessage, extractErrorMessageOrString } from '../api/errors';
import { useUserStore } from '../store/user';
import { COLORS, RADIUS, SPACING, TYPO } from '../theme/tokens';
import {
  pageContainerStyle,
  cardStyle,
  titleStyle,
  cardTitleStyle,
  buttonStyle,
  tableStyle,
  thStyle,
  thTdStyle,
} from './_shared';

/** system_log 的一行（列由后端动态给出，故用索引签名） */
interface LogRow {
  [key: string]: unknown;
}

/** 手动触发数据校验的返回体（/admin/datacheck/trigger） */
interface DatacheckResult {
  /** 各校验项摘要（页面只展示其长度） */
  summaries?: unknown[];
}

/** 手动触发信号生成的统计（/admin/run-signal） */
interface SignalRunStats {
  total?: number;
  success?: number;
  timeout?: number;
  error?: number;
}

/** 手动触发信号生成的返回体（/admin/run-signal） */
interface SignalRunResult {
  stats?: SignalRunStats;
  inserted?: number;
}

/** 行情补跑的返回体（/admin/rerun-quotes） */
interface RerunResult {
  status?: string;
  method?: string;
  message?: string;
}

const RESULT_COLOR: Record<string, string> = {
  SUCCESS: COLORS.success,
  WARN: COLORS.warning,
  ERROR: COLORS.danger,
  SKIP: COLORS.textMuted,
  INFO: COLORS.info,
};

const LOG_TYPE_LABEL: Record<string, string> = {
  tdx2db_update: '行情更新',
  datacheck: '数据校验',
  plugin_execute: '插件执行',
  signal_generate: '信号生成',
  dividend_import: '除权导入',
  backup: '备份',
  trigger_manual: '手动触发',
  startup: '启动',
  trade: '交易',
};

export default function Admin() {
  const { role } = useUserStore();

  const [datacheckLoading, setDatacheckLoading] = useState(false);
  const [datacheckResult, setDatacheckResult] = useState<DatacheckResult | null>(null);
  const [datacheckError, setDatacheckError] = useState<string | null>(null);

  const [signalLoading, setSignalLoading] = useState(false);
  const [signalResult, setSignalResult] = useState<SignalRunResult | null>(null);
  const [signalError, setSignalError] = useState<string | null>(null);

  const [logs, setLogs] = useState<LogRow[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);

  // 最近校验结果卡片
  const [checkSummaries, setCheckSummaries] = useState<
    Array<{ checkId: string; result: string; message: string; detail: string | null }>
  >([]);
  // G8b 展开的校验卡片
  const [expandedCheck, setExpandedCheck] = useState<string | null>(null);
  // 行情补跑
  const [rerunLoading, setRerunLoading] = useState(false);
  const [rerunMsg, setRerunMsg] = useState<string | null>(null);
  const [rerunErr, setRerunErr] = useState<string | null>(null);

  if (role !== 'admin') {
    return (
      <div style={pageContainerStyle}>
        <h1 style={titleStyle}>管理员面板</h1>
        <div style={{ ...cardStyle, color: COLORS.danger }}>无权限</div>
      </div>
    );
  }

  const fetchLogs = async (p: number) => {
    setLogLoading(true);
    setLogError(null);
    try {
      const res = await api.get('/admin/system-log', {
        params: { page: p, page_size: pageSize },
      });
      if (res.data.success) {
        // 后端返回 { success, data: rows[], pagination: { total, totalPages } }
        setLogs(res.data.data ?? []);
        setTotal(res.data.pagination?.total ?? 0);
      } else {
        setLogError(res.data.message ?? '请求失败');
      }
    } catch (err) {
      setLogError(extractErrorMessage(err));
    } finally {
      setLogLoading(false);
    }
  };

  const fetchCheckSummary = async () => {
    try {
      const res = await api.get('/admin/datacheck/result');
      if (res.data.success) setCheckSummaries(res.data.data ?? []);
    } catch {
      /* ignore */
    }
  };

  // ⚠️ 说明：非 admin 角色在上面的 `if (role !== 'admin')` 已提前 return，导致本 useEffect
  // 成为**条件调用**（role 在运行期由 admin 变为 user 时会触发 React 的 hook 数量错误）。
  // 正解是把面板主体拆成子组件（`role !== 'admin'` 时不渲染子组件 → hook 数量恒定），
  // 但那会改变组件结构与状态挂载点，**不属于本次「只改类型、不改运行时行为」的清理范围**，
  // 故此处显式豁免并登记为待办（见本次交付说明「发现但未修的问题」）。
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    fetchLogs(page);
    fetchCheckSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const handleRunDatacheck = async () => {
    setDatacheckLoading(true);
    setDatacheckError(null);
    setDatacheckResult(null);
    try {
      const res = await api.post('/admin/datacheck/trigger');
      if (res.data.success) {
        setDatacheckResult(res.data.data);
        fetchCheckSummary();
      } else {
        setDatacheckError(res.data.message ?? '请求失败');
      }
    } catch (err) {
      setDatacheckError(extractErrorMessage(err));
    } finally {
      setDatacheckLoading(false);
    }
  };

  const handleRunSignal = async () => {
    setSignalLoading(true);
    setSignalError(null);
    setSignalResult(null);
    try {
      const res = await api.post('/admin/run-signal');
      if (res.data.success) {
        setSignalResult(res.data.data);
      } else {
        setSignalError(res.data.message ?? '请求失败');
      }
    } catch (err) {
      setSignalError(extractErrorMessage(err));
    } finally {
      setSignalLoading(false);
    }
  };

  const handleBackup = async () => {
    try {
      const res = await api.post('/admin/backup');
      if (res.data.success) {
        alert('备份已触发，请稍候查看日志');
      }
    } catch (err) {
      alert('备份失败: ' + extractErrorMessageOrString(err));
    }
  };

  const handleRerun = async () => {
    setRerunLoading(true);
    setRerunErr(null);
    setRerunMsg(null);
    try {
      const res = await api.post('/admin/rerun-quotes', { reason: '管理员手动触发' });
      if (res.data.success) {
        const r: RerunResult = res.data.data;
        setRerunMsg(
          r.status === 'SUCCESS'
            ? `补跑成功（通道：${r.method}）`
            : r.status === 'SKIP'
              ? '补跑通道不可用（本机无 tdx2db 二进制 / systemd）'
              : `补跑失败（通道：${r.method}，${r.message}）`,
        );
        if (r.status === 'SUCCESS') fetchCheckSummary();
      } else {
        setRerunErr(res.data.message ?? '请求失败');
      }
    } catch (err) {
      setRerunErr(extractErrorMessage(err));
    } finally {
      setRerunLoading(false);
    }
  };

  const logColumns: string[] = ['log_date', 'log_type', 'level', 'check_item', 'message', 'detail'];
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div style={pageContainerStyle}>
      <h1 style={titleStyle}>管理员面板</h1>

      {/* C1-C12 校验仪表盘（G8b 点击展开 detail） */}
      <div style={cardStyle}>
        <div style={cardTitleStyle}>数据校验结果（C1-C12）— 点击卡片查看详情</div>
        {checkSummaries.length === 0 ? (
          <div style={{ color: COLORS.neutral, padding: 12 }}>暂无校验记录</div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: SPACING.gapBase }}>
            {checkSummaries.map((s) => (
              <div key={s.checkId} style={{ minWidth: 90 }}>
                <div
                  onClick={() => setExpandedCheck(expandedCheck === s.checkId ? null : s.checkId)}
                  style={{
                    padding: '6px 12px',
                    borderRadius: RADIUS.base,
                    fontSize: TYPO.smallSize,
                    fontWeight: TYPO.cardTitleWeight,
                    background: RESULT_COLOR[s.result] ?? COLORS.borderLight,
                    color: COLORS.cardBg,
                    minWidth: 80,
                    textAlign: 'center',
                    cursor: 'pointer',
                    outline: expandedCheck === s.checkId ? `2px solid ${COLORS.brandLink}` : 'none',
                  }}
                  title={s.message}
                >
                  {s.checkId}
                  <br />
                  <span style={{ fontSize: TYPO.captionSize }}>{s.result}</span>
                </div>
                {expandedCheck === s.checkId && (
                  <div
                    style={{
                      marginTop: 4,
                      padding: 8,
                      fontSize: 12,
                      lineHeight: 1.6,
                      background: COLORS.headerBg,
                      border: `1px solid ${COLORS.borderLight}`,
                      borderRadius: RADIUS.sm,
                      color: COLORS.textSecondary,
                      maxWidth: 320,
                      wordBreak: 'break-all',
                    }}
                  >
                    <div style={{ fontWeight: 600, marginBottom: 4, color: RESULT_COLOR[s.result] }}>
                      {s.checkId} · {s.result}
                    </div>
                    <div style={{ marginBottom: 4 }}>{s.message || '（无说明）'}</div>
                    {s.detail && (
                      <pre
                        style={{
                          margin: 0,
                          whiteSpace: 'pre-wrap',
                          fontSize: TYPO.captionSize,
                          color: COLORS.textSecondary,
                          maxHeight: 180,
                          overflow: 'auto',
                        }}
                      >
                        {s.detail}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={cardStyle}>
        <div style={cardTitleStyle}>行情更新补跑（Requirements §5.1 管理员手动补跑）</div>
        <div style={{ fontSize: TYPO.smallSize, color: COLORS.neutral, marginBottom: 8 }}>
          WARN / ERROR 会在 17:01 校验后自动补跑；此处为手动通道。
        </div>
        <button style={buttonStyle} onClick={handleRerun} disabled={rerunLoading}>
          {rerunLoading ? '补跑中...' : '立即补跑行情更新'}
        </button>
        {rerunMsg && <div style={{ color: COLORS.success, marginTop: SPACING.gapBase }}>{rerunMsg}</div>}
        {rerunErr && <div style={{ color: COLORS.danger, marginTop: SPACING.gapBase }}>{rerunErr}</div>}
      </div>

      <div style={cardStyle}>
        <div style={cardTitleStyle}>手动触发数据校验</div>
        <button style={buttonStyle} onClick={handleRunDatacheck} disabled={datacheckLoading}>
          {datacheckLoading ? '执行中...' : '执行数据校验'}
        </button>
        {datacheckError && (
          <div style={{ color: COLORS.danger, marginTop: SPACING.gapBase }}>{datacheckError}</div>
        )}
        {datacheckResult && (
          <div style={{ marginTop: SPACING.gapBase, color: COLORS.success }}>
            校验完成：summaries 数量 = {datacheckResult.summaries?.length ?? '-'}
          </div>
        )}
      </div>

      <div style={cardStyle}>
        <div style={cardTitleStyle}>手动触发信号生成</div>
        <button style={buttonStyle} onClick={handleRunSignal} disabled={signalLoading}>
          {signalLoading ? '执行中...' : '执行信号生成'}
        </button>
        {signalError && <div style={{ color: COLORS.danger, marginTop: SPACING.gapBase }}>{signalError}</div>}
        {signalResult &&
          (() => {
            const stats: SignalRunStats = signalResult.stats ?? {};
            return (
              <div style={{ marginTop: SPACING.gapBase, color: COLORS.success }}>
                生成完成：total={stats.total ?? '-'} success={stats.success ?? '-'} timeout=
                {stats.timeout ?? '-'} error={stats.error ?? '-'} inserted={signalResult.inserted ?? '-'}
              </div>
            );
          })()}
      </div>

      <div style={cardStyle}>
        <div style={cardTitleStyle}>手动备份</div>
        <button style={buttonStyle} onClick={handleBackup}>
          执行备份
        </button>
      </div>

      {/* system_log 分页 */}
      <div style={cardStyle}>
        <div style={cardTitleStyle}>系统日志</div>
        {logLoading && <div>加载中...</div>}
        {logError && <div style={{ color: COLORS.danger }}>{logError}</div>}
        {!logLoading && !logError && (
          <>
            <table style={tableStyle} aria-label="系统日志">
              <thead>
                <tr>
                  {logColumns.map((col) => (
                    <th key={col} scope="col" style={thStyle}>
                      {col === 'log_type' ? '类型' : col === 'level' ? '级别' : col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {logs.length === 0 ? (
                  <tr>
                    <td style={thTdStyle} colSpan={logColumns.length}>
                      暂无日志
                    </td>
                  </tr>
                ) : (
                  logs.map((row, i) => (
                    <tr key={i}>
                      {logColumns.map((col) => {
                        let val = String(row[col] ?? '');
                        if (col === 'log_type') val = LOG_TYPE_LABEL[val] ?? val;
                        if (col === 'level') {
                          const c = RESULT_COLOR[val] ?? COLORS.textSecondary;
                          return (
                            <td key={col} style={{ ...thTdStyle, color: c, fontWeight: 600 }}>
                              {val}
                            </td>
                          );
                        }
                        return (
                          <td key={col} style={thTdStyle}>
                            {val}
                          </td>
                        );
                      })}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
              <button
                style={buttonStyle}
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                上一页
              </button>
              <span style={{ fontSize: TYPO.bodySize }}>
                第 {page} / {totalPages} 页，共 {total} 条
              </span>
              <button style={buttonStyle} disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                下一页
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
