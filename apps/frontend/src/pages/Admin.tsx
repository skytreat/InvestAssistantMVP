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

  // 权限拦截
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

  useEffect(() => {
    fetchLogs(page);
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

  // 日志表头取第一行的 keys
  const logColumns: string[] = logs.length > 0 ? Object.keys(logs[0]) : [];
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div style={pageContainerStyle}>
      <h1 style={titleStyle}>管理员面板</h1>

      {/* 手动触发数据校验 */}
      <div style={cardStyle}>
        <div style={cardTitleStyle}>手动触发数据校验</div>
        <button style={buttonStyle} onClick={handleRunDatacheck} disabled={datacheckLoading}>
          {datacheckLoading ? '执行中...' : '执行数据校验'}
        </button>
        {datacheckError && <div style={{ color: '#dc2626', marginTop: 8 }}>{datacheckError}</div>}
        {datacheckResult && (
          <div style={{ marginTop: 8, color: '#16a34a' }}>
            校验完成：summaries 数量 ={' '}
            {datacheckResult.summaries?.length ?? datacheckResult.summaries ?? JSON.stringify(datacheckResult)}
          </div>
        )}
      </div>

      {/* 手动触发信号生成 */}
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
              生成完成：
              total={stats.total ?? '-'} , success={stats.success ?? '-'} , timeout=
              {stats.timeout ?? '-'} , error={stats.error ?? '-'} , skip={stats.skip ?? '-'} ,
              inserted={signalResult.inserted ?? '-'} , skipped={signalResult.skipped ?? '-'}
            </div>
          );
        })()}
      </div>

      {/* system_log 分页 */}
      <div style={cardStyle}>
        <div style={cardTitleStyle}>system_log</div>
        {logLoading && <div>加载中...</div>}
        {logError && <div style={{ color: '#dc2626' }}>{logError}</div>}
        {!logLoading && !logError && (
          <>
            <table style={tableStyle}>
              <thead>
                <tr>
                  {logColumns.map((col) => (
                    <th key={col} style={thStyle}>
                      {col}
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
                      {logColumns.map((col) => (
                        <td key={col} style={thTdStyle}>
                          {String(row[col] ?? '')}
                        </td>
                      ))}
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
              <span style={{ fontSize: 14 }}>
                第 {page} / {totalPages} 页，共 {total} 条
              </span>
              <button
                style={buttonStyle}
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                下一页
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
