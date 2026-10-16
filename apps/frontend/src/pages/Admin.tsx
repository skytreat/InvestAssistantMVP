import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useUserStore } from '../store/user';
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

interface LogRow {
  [key: string]: any;
}

const RESULT_COLOR: Record<string, string> = {
  SUCCESS: '#16a34a', WARN: '#d97706', ERROR: '#dc2626', SKIP: '#9ca3af', INFO: '#3b82f6',
};

const LOG_TYPE_LABEL: Record<string, string> = {
  tdx2db_update: '行情更新', datacheck: '数据校验', plugin_execute: '插件执行',
  signal_generate: '信号生成', dividend_import: '除权导入', backup: '备份',
  trigger_manual: '手动触发', startup: '启动', trade: '交易',
};

export default function Admin() {
  const { role } = useUserStore();

  const [datacheckLoading, setDatacheckLoading] = useState(false);
  const [datacheckResult, setDatacheckResult] = useState<any>(null);
  const [datacheckError, setDatacheckError] = useState<string | null>(null);

  const [signalLoading, setSignalLoading] = useState(false);
  const [signalResult, setSignalResult] = useState<any>(null);
  const [signalError, setSignalError] = useState<string | null>(null);

  const [logs, setLogs] = useState<LogRow[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);

  // 最近校验结果卡片
  const [checkSummaries, setCheckSummaries] = useState<Array<{ checkId: string; result: string; message: string; detail: string | null }>>([]);

  if (role !== 'admin') {
    return (
      <div style={pageContainerStyle}>
        <h1 style={titleStyle}>管理员面板</h1>
        <div style={{ ...cardStyle, color: '#dc2626' }}>无权限</div>
      </div>
    );
  }

  const fetchLogs = async (p: number) => {
    setLogLoading(true);
    setLogError(null);
    try {
      const res = await api.get('/admin/system-log', {
        params: { page, page_size: pageSize },
      });
      if (res.data.success) {
        const data = res.data.data ?? {};
        setLogs(data.rows ?? []);
        setTotal(data.total ?? data.count ?? 0);
      } else {
        setLogError(res.data.error ?? '请求失败');
      }
    } catch (err: any) {
      setLogError(err?.response?.data?.error ?? '网络错误');
    } finally {
      setLogLoading(false);
    }
  };

  const fetchCheckSummary = async () => {
    try {
      const res = await api.get('/datacheck/latest');
      if (res.data.success) setCheckSummaries(res.data.data ?? []);
    } catch { /* ignore */ }
  };

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
      const res = await api.post('/admin/run-datacheck');
      if (res.data.success) {
        setDatacheckResult(res.data.data);
        fetchCheckSummary();
      } else {
        setDatacheckError(res.data.error ?? '请求失败');
      }
    } catch (err: any) {
      setDatacheckError(err?.response?.data?.error ?? '网络错误');
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
        setSignalError(res.data.error ?? '请求失败');
      }
    } catch (err: any) {
      setSignalError(err?.response?.data?.error ?? '网络错误');
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
    } catch (err: any) {
      alert('备份失败: ' + (err?.response?.data?.error ?? String(err)));
    }
  };

  const logColumns: string[] = logs.length > 0 ? Object.keys(logs[0]) : [];
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div style={pageContainerStyle}>
      <h1 style={titleStyle}>管理员面板</h1>

      {/* C1-C12 校验仪表盘 */}
      <div style={cardStyle}>
        <div style={cardTitleStyle}>数据校验结果（C1-C12）</div>
        {checkSummaries.length === 0 ? (
          <div style={{ color: '#6b7280', padding: 12 }}>暂无校验记录</div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {checkSummaries.map((s) => (
              <div
                key={s.checkId}
                style={{
                  padding: '6px 12px',
                  borderRadius: 6,
                  fontSize: 13,
                  fontWeight: 600,
                  background: RESULT_COLOR[s.result] ?? '#e5e7eb',
                  color: '#fff',
                  minWidth: 80,
                  textAlign: 'center',
                }}
                title={s.message}
              >
                {s.checkId}<br /><span style={{ fontSize: 11 }}>{s.result}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={cardStyle}>
        <div style={cardTitleStyle}>手动触发数据校验</div>
        <button style={buttonStyle} onClick={handleRunDatacheck} disabled={datacheckLoading}>
          {datacheckLoading ? '执行中...' : '执行数据校验'}
        </button>
        {datacheckError && <div style={{ color: '#dc2626', marginTop: 8 }}>{datacheckError}</div>}
        {datacheckResult && (
          <div style={{ marginTop: 8, color: '#16a34a' }}>
            校验完成：summaries 数量 = {datacheckResult.summaries?.length ?? '-'}
          </div>
        )}
      </div>

      <div style={cardStyle}>
        <div style={cardTitleStyle}>手动触发信号生成</div>
        <button style={buttonStyle} onClick={handleRunSignal} disabled={signalLoading}>
          {signalLoading ? '执行中...' : '执行信号生成'}
        </button>
        {signalError && <div style={{ color: '#dc2626', marginTop: 8 }}>{signalError}</div>}
        {signalResult && (() => {
          const stats = signalResult.stats ?? {};
          return (
            <div style={{ marginTop: 8, color: '#16a34a' }}>
              生成完成：total={stats.total ?? '-'} success={stats.success ?? '-'} timeout={stats.timeout ?? '-'} error={stats.error ?? '-'} inserted={signalResult.inserted ?? '-'}
            </div>
          );
        })()}
      </div>

      <div style={cardStyle}>
        <div style={cardTitleStyle}>手动备份</div>
        <button style={buttonStyle} onClick={handleBackup}>执行备份</button>
      </div>

      {/* system_log 分页 */}
      <div style={cardStyle}>
        <div style={cardTitleStyle}>系统日志</div>
        {logLoading && <div>加载中...</div>}
        {logError && <div style={{ color: '#dc2626' }}>{logError}</div>}
        {!logLoading && !logError && (
          <>
            <table style={tableStyle}>
              <thead>
                <tr>
                  {logColumns.map((col) => (
                    <th key={col} style={thStyle}>{col === 'log_type' ? '类型' : col === 'level' ? '级别' : col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {logs.length === 0 ? (
                  <tr><td style={thTdStyle} colSpan={logColumns.length}>暂无日志</td></tr>
                ) : (
                  logs.map((row, i) => (
                    <tr key={i}>
                      {logColumns.map((col) => {
                        let val = String(row[col] ?? '');
                        if (col === 'log_type') val = LOG_TYPE_LABEL[val] ?? val;
                        if (col === 'level') {
                          const c = RESULT_COLOR[val] ?? '#374151';
                          return <td key={col} style={{ ...thTdStyle, color: c, fontWeight: 600 }}>{val}</td>;
                        }
                        return <td key={col} style={thTdStyle}>{val}</td>;
                      })}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
              <button style={buttonStyle} disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>上一页</button>
              <span style={{ fontSize: 14 }}>第 {page} / {totalPages} 页，共 {total} 条</span>
              <button style={buttonStyle} disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>下一页</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
