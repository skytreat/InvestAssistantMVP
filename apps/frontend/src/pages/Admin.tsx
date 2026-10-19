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
        <div style={{ ...cardStyle, color: '#dc2626' }}>无权限</div>
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
    } catch (err: any) {
      setLogError(err?.response?.data?.message ?? '网络错误');
    } finally {
      setLogLoading(false);
    }
  };

  const fetchCheckSummary = async () => {
    try {
      const res = await api.get('/admin/datacheck/result');
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
      const res = await api.post('/admin/datacheck/trigger');
      if (res.data.success) {
        setDatacheckResult(res.data.data);
        fetchCheckSummary();
      } else {
        setDatacheckError(res.data.message ?? '请求失败');
      }
    } catch (err: any) {
      setDatacheckError(err?.response?.data?.message ?? '网络错误');
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
    } catch (err: any) {
      setSignalError(err?.response?.data?.message ?? '网络错误');
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
      alert('备份失败: ' + (err?.response?.data?.message ?? String(err)));
    }
  };

  const handleRerun = async () => {
    setRerunLoading(true);
    setRerunErr(null);
    setRerunMsg(null);
    try {
      const res = await api.post('/admin/rerun-quotes', { reason: '管理员手动触发' });
      if (res.data.success) {
        const r = res.data.data;
        setRerunMsg(
          r.status === 'SUCCESS'
            ? `补跑成功（通道：${r.method}）`
            : r.status === 'SKIP'
              ? '补跑通道不可用（本机无 tdx2db 二进制 / systemd）'
              : `补跑失败（通道：${r.method}，${r.message}）`
        );
        if (r.status === 'SUCCESS') fetchCheckSummary();
      } else {
        setRerunErr(res.data.message ?? '请求失败');
      }
    } catch (err: any) {
      setRerunErr(err?.response?.data?.message ?? '网络错误');
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
        <div style={cardTitleStyle}>
          数据校验结果（C1-C12）— 点击卡片查看详情
        </div>
        {checkSummaries.length === 0 ? (
          <div style={{ color: '#6b7280', padding: 12 }}>暂无校验记录</div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {checkSummaries.map((s) => (
              <div key={s.checkId} style={{ minWidth: 90 }}>
                <div
                  onClick={() => setExpandedCheck(expandedCheck === s.checkId ? null : s.checkId)}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 6,
                    fontSize: 13,
                    fontWeight: 600,
                    background: RESULT_COLOR[s.result] ?? '#e5e7eb',
                    color: '#fff',
                    minWidth: 80,
                    textAlign: 'center',
                    cursor: 'pointer',
                    outline: expandedCheck === s.checkId ? '2px solid #1e40af' : 'none',
                  }}
                  title={s.message}
                >
                  {s.checkId}<br /><span style={{ fontSize: 11 }}>{s.result}</span>
                </div>
                {expandedCheck === s.checkId && (
                  <div style={{
                    marginTop: 4, padding: 8, fontSize: 12, lineHeight: 1.6,
                    background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 4,
                    color: '#374151', maxWidth: 320, wordBreak: 'break-all',
                  }}>
                    <div style={{ fontWeight: 600, marginBottom: 4, color: RESULT_COLOR[s.result] }}>
                      {s.checkId} · {s.result}
                    </div>
                    <div style={{ marginBottom: 4 }}>{s.message || '（无说明）'}</div>
                    {s.detail && (
                      <pre style={{
                        margin: 0, whiteSpace: 'pre-wrap', fontSize: 11,
                        color: '#4b5563', maxHeight: 180, overflow: 'auto',
                      }}>{s.detail}</pre>
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
        <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 8 }}>
          WARN / ERROR 会在 17:01 校验后自动补跑；此处为手动通道。
        </div>
        <button style={buttonStyle} onClick={handleRerun} disabled={rerunLoading}>
          {rerunLoading ? '补跑中...' : '立即补跑行情更新'}
        </button>
        {rerunMsg && <div style={{ color: '#16a34a', marginTop: 8 }}>{rerunMsg}</div>}
        {rerunErr && <div style={{ color: '#dc2626', marginTop: 8 }}>{rerunErr}</div>}
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
