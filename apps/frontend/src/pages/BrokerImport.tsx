import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { isOkEnvelope } from '../api/envelope';
import { extractErrorMessage } from '../api/errors';
import ConfirmDialog from '../components/ConfirmDialog';
import { COLORS, SPACING, TYPO } from '../theme/tokens';
import { buttonStyle, cardStyle, errorStyle, pageContainerStyle, successStyle, titleStyle } from './_shared';

/**
 * BrokerImport.tsx —— 券商文件导入向导 `/broker/import`（V3.8 T143 · PRD_v3 §3.1）
 *
 * 三步向导：
 *   ① 选文件 + 券商标识 → ② 探测结果（类型/编码/列映射建议/未识别列醒目）→ ③ 预览（前 5 行 + 统计）→ 确认导入
 *
 * 导入批次（T122 / SDD_v3 §9.1）：列表 + 撤销入口。撤销只软删事实层（is_deleted=1），
 * 原始行证据（raw_row_json）保留，可重新导入同一文件。
 *
 * 后端契约（T121/T122）：
 *   - POST /api/broker-import/upload   { filename, fileBase64, brokerCode } → 探测 + 预览 + 映射建议（不落库）
 *   - POST /api/broker-import/confirm  同 body → 落事实层 + 批次（不写业务层）
 *   - GET  /api/broker-import/batches  批次列表（含统计与撤销入口）
 *   - POST /api/broker-import/batches/:id/revoke 撤销批次（软删事实层）
 * 权限：仅 admin（SDD_v3 §10.3；路由挂 AdminGuard）
 */

interface DetectResult {
  fileKind: string;
  encoding: string;
  headerRowIndex: number;
  columns: Array<{ name?: string; index?: number }>;
  mappingSuggestion?: { byField?: Record<string, { column?: number; confidence?: string } | null> };
  previewRows: unknown[];
  rowTotal: number;
  warnings: Array<{ code?: string; message?: string; rowNo?: number }>;
  /** T151①：从元数据行推断出的券商名（推断不出为 undefined） */
  brokerNameHint?: string;
}

interface ConfirmResult {
  batchId?: number;
  fileHash?: string;
  rowTotal?: number;
  rowInserted?: number;
  rowDeduped?: number;
  rowExcluded?: number;
  duplicateFile?: boolean;
}

/** 导入批次（GET /api/broker-import/batches 的 batch 行，字段见 broker_import_batch DDL） */
interface BatchRow {
  id: number;
  broker_code: string;
  file_kind: string;
  file_name: string | null;
  status: string;
  row_total: number;
  row_inserted: number;
  row_deduped: number;
  row_excluded: number;
  created_at: string;
}

const BATCH_STATUS_LABELS: Record<string, string> = {
  pending: '待处理',
  parsed: '已解析',
  imported: '已导入',
  revoked: '已撤销',
};

const FILE_KIND_LABELS: Record<string, string> = {
  settlement: '交割单',
  trade: '成交流水',
};

/** 字段中文名（与后端 SEMANTIC_ALIASES 保持可读性） */
const FIELD_LABELS: Record<string, string> = {
  tradeDate: '成交日期',
  settleDate: '交收日期',
  tradeTime: '成交时间',
  symbol: '证券代码',
  name: '证券名称',
  direction: '交易类别',
  price: '成交价格',
  quantity: '成交数量',
  amount: '成交金额',
  cashFlow: '发生金额',
  cashBalance: '剩余金额',
  balance: '证券余额',
  feeTotal: '费用合计',
  tradeId: '成交编号',
  contractNo: '合同序号',
};

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result as string;
      resolve(url.split(',')[1] ?? '');
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export default function BrokerImport() {
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);

  const [brokerCode, setBrokerCode] = useState('');
  /** T151①：券商标识是否由文件推断自动填入（可改；改动后标记为手动） */
  const [brokerAutoFilled, setBrokerAutoFilled] = useState(false);
  /** T151②：多文件 */
  const [files, setFiles] = useState<File[]>([]);
  /** 探测结果：文件名 → DetectResult / 错误信息 */
  const [detects, setDetects] = useState<Record<string, DetectResult | string>>({});
  const [busy, setBusy] = useState(false);
  /** T151②：按批次（券商）的确认结果 */
  const [confirmResults, setConfirmResults] = useState<
    Array<{ key: string; results: Array<{ filename: string; result: ConfirmResult }> }>
  >([]);

  // ── 导入批次（列表 + 撤销）──
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [batchesLoading, setBatchesLoading] = useState(true);
  const [batchesError, setBatchesError] = useState<string | null>(null);
  const [batchesNotice, setBatchesNotice] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<BatchRow | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);

  const loadBatches = useCallback(async () => {
    setBatchesLoading(true);
    setBatchesError(null);
    try {
      const res = await api.get('/broker-import/batches');
      if (isOkEnvelope(res.data)) {
        const data = res.data.data as { batches?: BatchRow[] };
        setBatches(data.batches ?? []);
      } else {
        setBatchesError(String(res.data?.message ?? '加载导入批次失败'));
      }
    } catch (err) {
      setBatchesError(extractErrorMessage(err, '加载导入批次失败'));
    } finally {
      setBatchesLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBatches();
  }, [loadBatches]);

  /** 探测（不落库）：每个文件各探一次；T151① 单文件 + 标识框为空 + 有推断 → 自动填入
   *  （多文件不自动填——不同券商需分组提示分批，避免首个文件的 hint 污染分组） */
  const runDetect = useCallback(
    async (f: File, totalFiles: number) => {
      setBusy(true);
      setDetects((d) => ({ ...d, [f.name]: 'detecting' as unknown as string }));
      setConfirmResults([]);
      try {
        const fileBase64 = await fileToBase64(f);
        const res = await api.post('/broker-import/upload', { filename: f.name, fileBase64, brokerCode });
        if (isOkEnvelope(res.data)) {
          const d = res.data.data as DetectResult;
          setDetects((prev) => ({ ...prev, [f.name]: d }));
          // T151①：仅单文件 + 标识为空 + 有推断 → 自动填入（多文件需分组，避免污染）
          if (totalFiles === 1 && !brokerCode && d.brokerNameHint) {
            setBrokerCode(d.brokerNameHint);
            setBrokerAutoFilled(true);
          }
        } else {
          setDetects((prev) => ({ ...prev, [f.name]: String(res.data?.message ?? '无法识别文件类型') }));
        }
      } catch (err) {
        setDetects((prev) => ({ ...prev, [f.name]: String((err as Error).message) }));
      } finally {
        setBusy(false);
      }
    },
    [brokerCode],
  );

  /** T151②：文件按其有效券商分组（手填标识优先；否则用推断名；无 → unknown） */
  const groups = useMemo(() => {
    const m = new Map<string, File[]>();
    for (const f of files) {
      const d = detects[f.name];
      let key: string;
      if (brokerCode.trim()) key = brokerCode.trim();
      else if (d && typeof d === 'object' && d.brokerNameHint) key = d.brokerNameHint;
      else key = '未识别';
      m.set(key, [...(m.get(key) ?? []), f]);
    }
    return [...m.entries()];
  }, [files, detects, brokerCode]);

  const detectOk = (f: File): f is File & { detect: DetectResult } =>
    detects[f.name] !== undefined && typeof detects[f.name] === 'object';

  /** 确认导入（落事实层）：按组逐文件顺序确认（每文件 = 一个批次）
   *  groupCode：该组实际落库的券商标识（手填标识优先，否则 = 推断券商名） */
  const runConfirmGroup = useCallback(
    async (groupCode: string, groupFiles: File[]) => {
      setBusy(true);
      const out: Array<{ filename: string; result: ConfirmResult }> = [];
      try {
        for (const f of groupFiles) {
          const fileBase64 = await fileToBase64(f);
          const res = await api.post('/broker-import/confirm', {
            filename: f.name,
            fileBase64,
            brokerCode: groupCode,
          });
          if (isOkEnvelope(res.data)) {
            out.push({ filename: f.name, result: res.data.data as ConfirmResult });
          } else {
            out.push({
              filename: f.name,
              result: { rowTotal: 0, rowInserted: 0, rowDeduped: 0, rowExcluded: 0 },
            });
          }
        }
        setConfirmResults((prev) => [
          ...prev.filter((g) => g.key !== groupCode),
          { key: groupCode, results: out },
        ]);
        await loadBatches();
      } finally {
        setBusy(false);
      }
    },
    [loadBatches],
  );

  /** 撤销批次（二次确认后调用；后端软删事实层，原始证据保留） */
  const doRevoke = useCallback(
    async (batch: BatchRow) => {
      setRevokeBusy(true);
      setBatchesError(null);
      setBatchesNotice(null);
      try {
        const res = await api.post(`/broker-import/batches/${batch.id}/revoke`);
        if (isOkEnvelope(res.data)) {
          const data = res.data.data as { affectedRows?: number };
          setBatchesNotice(
            `已撤销批次 #${batch.id}（软删除 ${data.affectedRows ?? 0} 行事实记录，原始数据仍保留）`,
          );
          await loadBatches();
        } else {
          setBatchesError(String(res.data?.message ?? '撤销失败'));
        }
      } catch (err) {
        setBatchesError(extractErrorMessage(err, '撤销失败'));
      } finally {
        setRevokeBusy(false);
      }
    },
    [loadBatches],
  );

  const confirmRevoke = () => {
    const target = revokeTarget;
    setRevokeTarget(null);
    if (target) void doRevoke(target);
  };

  return (
    <div style={pageContainerStyle}>
      <h1 style={titleStyle}>券商文件导入</h1>
      <p style={{ color: COLORS.textSecondary, margin: '0 0 16px' }}>
        上传券商交割单 / 成交流水（xlsx / xls / csv / txt，≤10MB）。导入只落**事实层**，不会自动写入交易记录；
        补录在「对账报告」页显式确认。
      </p>

      <div style={cardStyle}>
        <div style={{ display: 'flex', gap: SPACING.gapRelaxed, flexWrap: 'wrap', alignItems: 'center' }}>
          <label>
            {/* T151①：必填（红星 + 空标识不可确认） */}
            <span style={{ fontSize: TYPO.smallSize }}>
              <span style={{ color: COLORS.danger }}>*</span> 券商标识（用户自维护，如 gt / hb）：
            </span>
            <input
              style={{ ...inputStyle, marginLeft: 8 }}
              value={brokerCode}
              onChange={(e) => {
                setBrokerCode(e.target.value);
                setBrokerAutoFilled(false);
              }}
              placeholder="必填（选文件后可自动推断）"
              aria-required="true"
            />
            {brokerAutoFilled && (
              <span style={{ fontSize: TYPO.captionSize, color: COLORS.textSuccess, marginLeft: 8 }}>
                已按文件内容自动推断，可修改
              </span>
            )}
          </label>
          <label>
            <span style={{ fontSize: TYPO.smallSize }}>选择文件（可多选，xlsx / xls / csv / txt）：</span>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv,.txt"
              multiple
              onChange={(e) => {
                const fs = Array.from(e.target.files ?? []);
                // 追加而非替换：多次选择不覆盖已选文件（按 name+size 去重）
                setFiles((prev) => {
                  const seen = new Set(prev.map((f) => `${f.name}|${f.size}`));
                  return [...prev, ...fs.filter((f) => !seen.has(`${f.name}|${f.size}`))];
                });
                setConfirmResults([]);
                fs.forEach((f) => void runDetect(f, fs.length));
              }}
              style={{ fontSize: TYPO.smallSize }}
            />
          </label>
          <span style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary }}>
            {files.length > 0
              ? `已选 ${files.length} 个文件：${files.map((f) => f.name).join('、')}`
              : '未选择文件'}
          </span>
        </div>

        {busy && <p style={{ ...typing, marginTop: 12 }}>处理中…</p>}
        {files.map((f) => {
          const d = detects[f.name];
          return typeof d === 'string' ? (
            <p key={`err-${f.name}`} style={{ ...errorStyle, marginTop: 8 }}>
              {f.name}：{d}
            </p>
          ) : null;
        })}
      </div>

      {/* T151②：探测结果（每文件一卡）+ 分批提示 */}
      {files.map((f) => {
        const d = detects[f.name];
        if (typeof d !== 'object' || d === null) return null;
        const entries = Object.entries(d.mappingSuggestion?.byField ?? {});
        return (
          <div key={f.name} style={{ ...cardStyle, marginTop: 16 }}>
            <h2 style={subtitleStyle}>探测结果</h2>
            <p style={{ fontSize: TYPO.smallSize, color: COLORS.textMuted, margin: '0 0 8px' }}>
              文件：{f.name}
              {d.brokerNameHint ? ` · 推断券商：${d.brokerNameHint}` : ''}
            </p>
            <dl style={dlStyle}>
              <dt>文件类型</dt>
              <dd>
                {d.fileKind === 'settlement' ? '交割单' : d.fileKind === 'trade' ? '成交流水' : d.fileKind}
              </dd>
              <dt>编码</dt>
              <dd>{d.encoding}</dd>
              <dt>行数</dt>
              <dd>{d.rowTotal}</dd>
            </dl>

            {(d.warnings?.length ?? 0) > 0 && (
              <div style={{ ...warningBox, marginBottom: 12 }}>
                {d.warnings.slice(0, 5).map((w, i) => (
                  <div key={i} style={{ fontSize: TYPO.smallSize }}>
                    {w.rowNo != null ? `第${w.rowNo}行：` : ''}
                    {w.message}
                  </div>
                ))}
              </div>
            )}

            <h3 style={subtitleStyle}>列映射建议（未命中 = 该列将忽略）</h3>
            {entries.length > 0 ? (
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>语义字段</th>
                    <th style={thStyle}>映射列</th>
                    <th style={thStyle}>置信度</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map(([field, m]) => (
                    <tr key={field} style={!m ? { color: COLORS.warning } : undefined}>
                      <td style={tdStyle}>{FIELD_LABELS[field] ?? field}</td>
                      <td style={tdStyle}>{m ? `第 ${(m.column ?? 0) + 1} 列` : '（未识别）'}</td>
                      <td style={tdStyle}>{m?.confidence ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p style={{ color: COLORS.textSecondary }}>无映射建议</p>
            )}

            <h3 style={{ ...subtitleStyle, marginTop: 16 }}>预览（前 {d.previewRows.length} 行）</h3>
            <pre style={{ ...preStyle, maxHeight: 240 }}>{JSON.stringify(d.previewRows, null, 2)}</pre>
          </div>
        );
      })}

      {/* T151②：确认导入（单券商一批 / 多券商提示分批） */}
      {groups.length > 0 && (
        <div style={{ ...cardStyle, marginTop: 16 }}>
          <h2 style={subtitleStyle}>确认导入</h2>
          {groups.length > 1 && (
            <div style={{ ...warningBox, marginBottom: 12 }}>
              <strong>
                检测到 {files.length} 个文件属于 {groups.length} 个不同券商（
                {groups.map(([k]) => k).join('、')}）。
              </strong>
              <div style={{ fontSize: TYPO.smallSize }}>
                <strong>不支持跨券商批量导入</strong>：每次批量确认仅接受同一券商的多文件（如成交流水 +
                交割单）。不同券商须<strong>分别点击</strong>下方各券商的「确认导入」按钮，逐批执行。
              </div>
            </div>
          )}
          {groups.length === 1 && groups[0][1].length > 1 && (
            <div style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary, marginBottom: 8 }}>
              同券商多文件（如成交流水 + 交割单）可一次批量导入，导入后自动回填交割单缺失的成交时间。
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {groups.map(([key, groupFiles]) => {
              const code = brokerCode.trim() || key;
              const importable = groupFiles.filter((f) => detectOk(f));
              if (importable.length === 0) return null;
              return (
                <div key={key} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <button
                    style={{ ...buttonStyle, ...primaryButton }}
                    onClick={() => void runConfirmGroup(code, importable)}
                    disabled={!code || busy}
                  >
                    确认导入【{key}】（{importable.length} 个文件）
                  </button>
                  <span style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary }}>
                    券商：{code} · 这将写入事实层记录，可随时撤销批次
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 导入完成（按批次结果） */}
      {confirmResults.length > 0 && (
        <div style={{ ...cardStyle, marginTop: 16 }}>
          <h2 style={subtitleStyle}>导入完成</h2>
          {confirmResults.map((g) => (
            <div key={g.key} style={{ marginBottom: 12 }}>
              <h3 style={subtitleStyle}>批次【{g.key}】</h3>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>文件</th>
                    <th style={thStyle}>总行数</th>
                    <th style={thStyle}>新写入</th>
                    <th style={thStyle}>去重跳过</th>
                    <th style={thStyle}>排除</th>
                  </tr>
                </thead>
                <tbody>
                  {g.results.map((r) => (
                    <tr key={r.filename}>
                      <td style={tdStyle}>
                        {r.filename}
                        {r.result.duplicateFile ? '（此前已导入，幂等跳过）' : ''}
                      </td>
                      <td style={tdStyle}>{r.result.rowTotal}</td>
                      <td style={tdStyle}>{r.result.rowInserted}</td>
                      <td style={tdStyle}>{r.result.rowDeduped}</td>
                      <td style={tdStyle}>{r.result.rowExcluded}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button
                style={{ ...buttonStyle, ...primaryButton, marginTop: 8 }}
                onClick={() => navigate(`/broker/reconcile?brokerCode=${encodeURIComponent(g.key)}`)}
              >
                查看对账报告 →
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ ...cardStyle, marginTop: 16 }}>
        <h2 style={subtitleStyle}>导入批次</h2>
        <p style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary, margin: '0 0 8px' }}>
          撤销批次只软删除事实层记录（对账不再计入），原始行数据仍保留，可重新导入同一文件。
        </p>
        <div aria-live="polite">
          {batchesNotice !== null && (
            <p style={successStyle} data-testid="batch-notice">
              {batchesNotice}
            </p>
          )}
          {batchesError !== null && (
            <p style={errorStyle} data-testid="batch-error">
              {batchesError}
            </p>
          )}
        </div>
        {batchesLoading ? (
          <p style={{ ...typing, marginTop: 12 }}>加载中…</p>
        ) : batches.length === 0 ? (
          <p style={{ color: COLORS.textSecondary }}>暂无导入批次</p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>批次</th>
                <th style={thStyle}>券商</th>
                <th style={thStyle}>文件</th>
                <th style={thStyle}>类型</th>
                <th style={thStyle}>行数（总/写入/排除）</th>
                <th style={thStyle}>状态</th>
                <th style={thStyle}>导入时间</th>
                <th style={thStyle}>操作</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => {
                const revoked = b.status === 'revoked';
                return (
                  <tr key={b.id}>
                    <td style={tdStyle}>{b.id}</td>
                    <td style={tdStyle}>{b.broker_code ?? '—'}</td>
                    <td style={tdStyle}>{b.file_name ?? '—'}</td>
                    <td style={tdStyle}>{FILE_KIND_LABELS[b.file_kind] ?? b.file_kind ?? '—'}</td>
                    <td style={tdStyle}>
                      {b.row_total ?? 0} / {b.row_inserted ?? 0} / {b.row_excluded ?? 0}
                    </td>
                    <td style={tdStyle}>{BATCH_STATUS_LABELS[b.status] ?? b.status ?? '—'}</td>
                    <td style={tdStyle}>{b.created_at ?? '—'}</td>
                    <td style={tdStyle}>
                      {!revoked && (
                        <button
                          type="button"
                          aria-label={`撤销批次 #${b.id}`}
                          style={{ ...buttonStyle, padding: '2px 8px', fontSize: TYPO.captionSize }}
                          onClick={() => setRevokeTarget(b)}
                          disabled={revokeBusy}
                        >
                          撤销
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <ConfirmDialog
        open={revokeTarget !== null}
        title="确认撤销导入批次"
        message={
          revokeTarget
            ? `撤销批次 #${revokeTarget.id}（${revokeTarget.file_name ?? '未命名文件'}）会软删除该批次全部事实层记录，对账结果将不再包含这些流水。\n原始行数据仍保留，可重新导入同一文件。\n确认继续？`
            : ''
        }
        confirmText="确认撤销"
        cancelText="取消"
        danger
        onConfirm={confirmRevoke}
        onCancel={() => setRevokeTarget(null)}
      />
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  border: `1px solid ${COLORS.borderMedium}`,
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: TYPO.smallSize,
  fontFamily: 'inherit',
};
const subtitleStyle: React.CSSProperties = {
  fontSize: TYPO.cardTitleSize,
  fontWeight: 600,
  margin: '0 0 8px',
};
const dlStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  gap: '4px 12px',
  margin: '8px 0',
};
const warningBox: React.CSSProperties = {
  background: COLORS.bgPillWarning,

  border: `1px solid ${COLORS.borderPillWarning}`,
  borderRadius: 6,
  padding: '8px 12px',
};
const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: TYPO.smallSize,
};
const thStyle: React.CSSProperties = {
  textAlign: 'left',
  borderBottom: `1px solid ${COLORS.borderLight}`,
  padding: '4px 8px',
  color: COLORS.textSecondary,
};
const tdStyle: React.CSSProperties = { borderBottom: `1px solid ${COLORS.borderLight}`, padding: '4px 8px' };
const preStyle: React.CSSProperties = {
  background: COLORS.headerBg,
  border: `1px solid ${COLORS.borderMedium}`,
  borderRadius: 6,
  padding: 12,
  overflow: 'auto',
  fontSize: TYPO.captionSize,
};
const primaryButton: React.CSSProperties = { background: COLORS.brand, color: '#fff', border: 'none' };
const typing: React.CSSProperties = { color: COLORS.textSecondary, fontSize: TYPO.smallSize };
