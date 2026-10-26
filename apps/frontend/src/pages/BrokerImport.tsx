import React, { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { isOkEnvelope } from '../api/envelope';
import { COLORS, SPACING, TYPO } from '../theme/tokens';
import { buttonStyle, cardStyle, errorStyle, pageContainerStyle, titleStyle } from './_shared';

/**
 * BrokerImport.tsx —— 券商文件导入向导 `/broker/import`（V3.8 T143 · PRD_v3 §3.1）
 *
 * 三步向导：
 *   ① 选文件 + 券商标识 → ② 探测结果（类型/编码/列映射建议/未识别列醒目）→ ③ 预览（前 5 行 + 统计）→ 确认导入
 *
 * 后端契约（T121/T122）：
 *   - POST /api/broker-import/upload   { filename, fileBase64, brokerCode } → 探测 + 预览 + 映射建议（不落库）
 *   - POST /api/broker-import/confirm  同 body → 落事实层 + 批次（不写业务层）
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
  const [file, setFile] = useState<File | null>(null);
  const [detect, setDetect] = useState<DetectResult | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmResult, setConfirmResult] = useState<ConfirmResult | null>(null);

  /** 探测（不落库）：上传即探 */
  const runDetect = useCallback(
    async (f: File) => {
      setBusy(true);
      setDetect(null);
      setConfirmResult(null);
      setDetectError(null);
      try {
        const fileBase64 = await fileToBase64(f);
        const res = await api.post('/broker-import/upload', { filename: f.name, fileBase64, brokerCode });
        if (isOkEnvelope(res.data)) {
          setDetect(res.data.data as DetectResult);
        } else {
          setDetectError(String(res.data?.message ?? '无法识别文件类型'));
        }
      } catch (err) {
        setDetectError(String((err as Error).message));
      } finally {
        setBusy(false);
      }
    },
    [brokerCode],
  );

  /** 确认导入（落事实层） */
  const runConfirm = useCallback(async () => {
    if (!file) return;
    setBusy(true);
    setDetectError(null);
    try {
      const fileBase64 = await fileToBase64(file);
      const res = await api.post('/broker-import/confirm', {
        filename: file.name,
        fileBase64,
        brokerCode: brokerCode.trim(),
      });
      if (isOkEnvelope(res.data)) {
        setConfirmResult(res.data.data as ConfirmResult);
      } else {
        setDetectError(String(res.data?.message ?? '导入失败'));
      }
    } catch (err) {
      setDetectError(String((err as Error).message));
    } finally {
      setBusy(false);
    }
  }, [file, brokerCode]);

  const mappingEntries = Object.entries(detect?.mappingSuggestion?.byField ?? {});

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
            <span style={{ fontSize: TYPO.smallSize }}>券商标识（用户自维护，如 gt / hb）：</span>
            <input
              style={{ ...inputStyle, marginLeft: 8 }}
              value={brokerCode}
              onChange={(e) => setBrokerCode(e.target.value)}
              placeholder="必填"
            />
          </label>
          <label>
            <span style={{ fontSize: TYPO.smallSize }}>选择文件（xlsx / xls / csv / txt）：</span>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv,.txt"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                if (f) void runDetect(f);
              }}
              style={{ fontSize: TYPO.smallSize }}
            />
          </label>
          <span style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary }}>
            {file?.name ?? '未选择文件'}
          </span>
        </div>

        {busy && <p style={{ ...typing, marginTop: 12 }}>处理中…</p>}
        {detectError && <p style={{ ...errorStyle, marginTop: 12 }}>{detectError}</p>}
      </div>

      {detect && !confirmResult && (
        <div style={{ ...cardStyle, marginTop: 16 }}>
          <h2 style={subtitleStyle}>探测结果</h2>
          <dl style={dlStyle}>
            <dt>文件类型</dt>
            <dd>
              {detect.fileKind === 'settlement'
                ? '交割单'
                : detect.fileKind === 'trade'
                  ? '成交流水'
                  : detect.fileKind}
            </dd>
            <dt>编码</dt>
            <dd>{detect.encoding}</dd>
            <dt>行数</dt>
            <dd>{detect.rowTotal}</dd>
          </dl>

          {(detect.warnings?.length ?? 0) > 0 && (
            <div style={{ ...warningBox, marginBottom: 12 }}>
              {detect.warnings.slice(0, 5).map((w, i) => (
                <div key={i} style={{ fontSize: TYPO.smallSize }}>
                  {w.rowNo != null ? `第${w.rowNo}行：` : ''}
                  {w.message}
                </div>
              ))}
            </div>
          )}

          <h3 style={subtitleStyle}>列映射建议（未命中 = 该列将忽略）</h3>
          {mappingEntries.length > 0 ? (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>语义字段</th>
                  <th style={thStyle}>映射列</th>
                  <th style={thStyle}>置信度</th>
                </tr>
              </thead>
              <tbody>
                {mappingEntries.map(([field, m]) => (
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

          <h3 style={{ ...subtitleStyle, marginTop: 16 }}>预览（前 {detect.previewRows.length} 行）</h3>
          <pre style={{ ...preStyle, maxHeight: 240 }}>{JSON.stringify(detect.previewRows, null, 2)}</pre>

          <div style={{ marginTop: 16, display: 'flex', gap: 12 }}>
            <button
              style={{ ...buttonStyle, ...primaryButton }}
              onClick={() => void runConfirm()}
              disabled={!brokerCode.trim() || busy}
            >
              确认导入
            </button>
            <span style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary, alignSelf: 'center' }}>
              这将写入事实层记录，可随时撤销批次
            </span>
          </div>
        </div>
      )}

      {confirmResult && (
        <div style={{ ...cardStyle, marginTop: 16 }}>
          <h2 style={subtitleStyle}>导入完成</h2>
          <dl style={dlStyle}>
            <dt>批次</dt>
            <dd>{confirmResult.batchId}</dd>
            <dt>总行数</dt>
            <dd>{confirmResult.rowTotal}</dd>
            <dt>新写入</dt>
            <dd>{confirmResult.rowInserted}</dd>
            <dt>去重跳过</dt>
            <dd>{confirmResult.rowDeduped}</dd>
            <dt>排除</dt>
            <dd>{confirmResult.rowExcluded}</dd>
          </dl>
          {confirmResult.duplicateFile && (
            <p style={{ ...warningBox, margin: '8px 0' }}>该文件此前已导入过（幂等跳过）。</p>
          )}
          <button
            style={{ ...buttonStyle, ...primaryButton }}
            onClick={() => navigate(`/broker/reconcile?brokerCode=${encodeURIComponent(brokerCode.trim())}`)}
          >
            查看对账报告 →
          </button>
        </div>
      )}
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
