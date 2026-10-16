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

const LEVEL_LABEL: Record<string, string> = {
  INFO: '信息',
  WARN: '警告',
  ERROR: '错误',
  SKIP: '跳过',
  SUCCESS: '成功',
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

  const logColumns: string[] = logs.length > 0 ? Object.keys(logs[0]) : [];
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const COLUMN_LABELS: Record<string, string> = {
    id: 'ID',
    log_type: '类型',
    level: '级别',
    message: '消息',
    detail: '详情',
    log_date: '日期',
    created_at: '创建时间',
    source: '来源',
  };

  return (
    <div style={pageContainerStyle}>
      <h1 style={titleStyle}>管理员面板</h1>

      <div style={cardStyle}>
        <div style={cardTitleStyle}>手动触发数据校验</div>
        <button style={buttonStyle} onClick={handleRunDatacheck} disabled={datacheckLoading}>
          {datacheckLoading ? '执行中...' : '执行数据校验'}
        </button>
        {datacheckError && <div style={{ color: '#dc2626', marginTop: 8 }}>{datacheckError}</div>}
        {datacheckResult && (
          <div style={{ marginTop: 8, color: '#16a34a' }}>
            校验完成：共 {datacheckResult.summaries?.length ?? '-'} 条检查结果
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
              生成完成：总插件={stats.total ?? '-'} 成功={stats.success ?? '-'}
              {' '}超时={stats.timeout ?? '-'} 错误={stats.error ?? '-'} 跳过={stats.skip ?? '-'}
              {' '}插入={signalResult.inserted ?? '-'} 忽略={signalResult.skipped ?? '-'}
            </div>
          );
        })()}
      </div>

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
                    <th key={col} style={thStyle}>
                      {COLUMN_LABELS[col] ?? col}
                    </th>
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
                        if (col === 'level') val = LEVEL_LABEL[val] ?? val;
                        return <td key={col} style={thTdStyle}>{val}</td>;
                      })}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
              <button style={buttonStyle} disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
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
