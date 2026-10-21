import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { isOkEnvelope } from '../api/envelope';
import { extractErrorMessage } from '../api/errors';
import { COLORS, SPACING, TYPO } from '../theme/tokens';
import { buttonStyle, cardStyle, errorStyle, pageContainerStyle, titleStyle } from './_shared';
import CandidateTable, { type CandidateItem, type PriceMode } from '../components/CandidateTable';
import WatchListPanel, { type WatchItem } from '../components/WatchListPanel';

/**
 * Candidates.tsx —— 候选池页 `/candidates`（T74 · F-G3）
 *
 * ## 这一页要满足的**明文要求**（逐条对应）
 *
 * | 出处 | 要求 | 本页落点 |
 * |---|---|---|
 * | PRD S3 | 选股结果可一键加入候选池 | 本页是候选池的**查看与管理**面（加入动作在选股页）|
 * | PRD S4 | 手动加标的时基准价固化为加入日收盘价 | 「基准价」列（`candidate_base_price`）|
 * | PRD S5 | 迁移自选可选复用基准价 / 用现价 | 工具栏的**价格模式**单选（base / current）|
 * | PRD S5 | 迁移**只打标记**，不自动创建自选关联 | 见下方「迁移语义」小节 |
 * | Requirements §5.7 #1 | 候选池**独立于**自选列表 | 页面下方独立的「自选列表」分区 |
 * | T74 卡片 | 候选列表 7 个字段 | `components/CandidateTable.tsx` 的表格列 |
 * | T74 卡片 | 【移除】软删 | 行操作【移除】→ `DELETE /api/candidate/:asset_code` |
 * | T74 卡片 | 批量操作 | 工具栏的【批量迁移自选】/【批量移除】|
 * | PRD §5.8 #7 | 候选池要有导航入口 | `pages/_shared.tsx` 的桌面导航 + 移动端 Tab |
 * | PRD §5.8 #3 | 超时需有 loading 状态 | 加载态 / 空态 / 错误态三态齐备 |
 *
 * ## 迁移语义（**最容易做错的一处**）
 *
 * PRD S5 + SDD §12.3 B6 + T92：**候选 → 自选的「迁移」只打标记，不建 watch 关联**。
 * 后端 `POST /api/candidate/:id/migrate` 的返回体里有 `autoCreated: false` 与中文提示。
 *
 * ⇒ 本页**不做**任何「顺手把标的加进自选」的事：
 *   - 迁移成功后**重新拉取**自选列表（用来向用户证明「自选里没有它」）；
 *   - 「加入自选」是**另一个显式按钮**（`POST /api/watch`），与迁移分开。
 *
 * ⚠️ **接口清单**（T90 路由对齐后的实际路径，勿照抄旧文档）：
 *   - `GET    /api/candidate`                —— 候选列表
 *   - `GET    /api/watch`                    —— 自选列表
 *   - `POST   /api/candidate/:id/migrate`    —— 迁移（**只打标记**）
 *   - `DELETE /api/candidate/:asset_code`    —— 移除候选（软删）
 *   - `POST   /api/watch`                    —— 显式加入自选
 */

/** 一次操作的结果 */
interface OpResult {
  ok: boolean;
  message: string;
}

export default function Candidates() {
  const navigate = useNavigate();

  // ── 数据 ────────────────────────────────────────────────
  const [rows, setRows] = useState<CandidateItem[]>([]);
  const [watchRows, setWatchRows] = useState<WatchItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [watchLoading, setWatchLoading] = useState(true);
  const [watchError, setWatchError] = useState<string | null>(null);

  // ── 交互状态 ────────────────────────────────────────────
  /** 迁移价格模式（PRD S5：复用基准价 / 使用现价）*/
  const [priceMode, setPriceMode] = useState<PriceMode>('base');
  /** 已勾选的标的代码 */
  const [selected, setSelected] = useState<string[]>([]);
  /** 正在操作中的标的（单行操作时的行级 loading）*/
  const [pending, setPending] = useState<string | null>(null);
  /** 批量操作进行中 */
  const [batchBusy, setBatchBusy] = useState(false);
  /** 操作结果提示（成功）*/
  const [notice, setNotice] = useState<string | null>(null);
  /** 操作失败提示 */
  const [opError, setOpError] = useState<string | null>(null);

  /** 拉取候选列表 */
  const loadCandidates = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/candidate');
      if (isOkEnvelope(res.data)) {
        setRows(Array.isArray(res.data.data) ? (res.data.data as CandidateItem[]) : []);
      } else {
        setError(res.data?.message ?? '候选池加载失败');
      }
    } catch (err) {
      setError(extractErrorMessage(err, '候选池加载失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  /** 拉取自选列表（用于「迁移 ≠ 加入自选」的可视化验证）*/
  const loadWatch = useCallback(async () => {
    setWatchLoading(true);
    setWatchError(null);
    try {
      const res = await api.get('/watch');
      if (isOkEnvelope(res.data)) {
        setWatchRows(Array.isArray(res.data.data) ? (res.data.data as WatchItem[]) : []);
      } else {
        setWatchError(res.data?.message ?? '自选列表加载失败');
      }
    } catch (err) {
      setWatchError(extractErrorMessage(err, '自选列表加载失败'));
    } finally {
      setWatchLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCandidates();
    void loadWatch();
  }, [loadCandidates, loadWatch]);

  // ── 单个操作（内部实现，不碰 UI 状态，便于批量复用）────────
  const migrateOne = useCallback(
    async (assetCode: string): Promise<OpResult> => {
      try {
        const res = await api.post(`/candidate/${assetCode}/migrate`, { price_mode: priceMode });
        if (isOkEnvelope(res.data)) {
          const message =
            (res.data?.data as { message?: string } | undefined)?.message ??
            '已标记为迁移完成；不会自动加入自选，需手动从候选池加入自选';
          return { ok: true, message };
        }
        return { ok: false, message: res.data?.message ?? '迁移失败' };
      } catch (err) {
        return { ok: false, message: extractErrorMessage(err, '迁移失败') };
      }
    },
    [priceMode],
  );

  const removeOne = useCallback(async (assetCode: string): Promise<OpResult> => {
    try {
      const res = await api.delete(`/candidate/${assetCode}`);
      if (isOkEnvelope(res.data)) {
        return { ok: true, message: '已从候选池移除' };
      }
      return { ok: false, message: res.data?.message ?? '移除失败' };
    } catch (err) {
      return { ok: false, message: extractErrorMessage(err, '移除失败') };
    }
  }, []);

  const addWatchOne = useCallback(async (assetCode: string): Promise<OpResult> => {
    try {
      const res = await api.post('/watch', { asset_code: assetCode });
      if (isOkEnvelope(res.data)) {
        return { ok: true, message: '已加入自选' };
      }
      return { ok: false, message: res.data?.message ?? '加入自选失败' };
    } catch (err) {
      return { ok: false, message: extractErrorMessage(err, '加入自选失败') };
    }
  }, []);

  /** 行操作：迁移（只打标记）*/
  const handleMigrate = useCallback(
    async (assetCode: string) => {
      setPending(assetCode);
      setNotice(null);
      setOpError(null);
      const result = await migrateOne(assetCode);
      if (result.ok) {
        setNotice(result.message);
        // 重新拉取候选（标记变了）与自选（证明迁移**没有**建关联）
        await loadCandidates();
        await loadWatch();
      } else {
        setOpError(result.message);
      }
      setPending(null);
    },
    [migrateOne, loadCandidates, loadWatch],
  );

  /** 行操作：移除候选（软删）*/
  const handleRemove = useCallback(
    async (assetCode: string) => {
      setPending(assetCode);
      setNotice(null);
      setOpError(null);
      const result = await removeOne(assetCode);
      if (result.ok) {
        setNotice(result.message);
        setSelected((prev) => prev.filter((code) => code !== assetCode));
        await loadCandidates();
      } else {
        setOpError(result.message);
      }
      setPending(null);
    },
    [removeOne, loadCandidates],
  );

  /** 行操作：显式加入自选（与「迁移自选」是两回事）*/
  const handleAddWatch = useCallback(
    async (assetCode: string) => {
      setPending(assetCode);
      setNotice(null);
      setOpError(null);
      const result = await addWatchOne(assetCode);
      if (result.ok) {
        setNotice(result.message);
        await loadWatch();
      } else {
        setOpError(result.message);
      }
      setPending(null);
    },
    [addWatchOne, loadWatch],
  );

  // ── 批量操作 ────────────────────────────────────────────
  const handleBatchMigrate = useCallback(async () => {
    if (selected.length === 0) return;
    setBatchBusy(true);
    setNotice(null);
    setOpError(null);
    const failed: string[] = [];
    for (const code of selected) {
      const result = await migrateOne(code);
      if (!result.ok) failed.push(`${code}：${result.message}`);
    }
    if (failed.length === 0) {
      setNotice(`已批量迁移 ${selected.length} 只（只打标记，不会自动加入自选）`);
    } else {
      setOpError(`批量迁移部分失败 —— ${failed.join('；')}`);
    }
    await loadCandidates();
    await loadWatch();
    setBatchBusy(false);
  }, [selected, migrateOne, loadCandidates, loadWatch]);

  const handleBatchRemove = useCallback(async () => {
    if (selected.length === 0) return;
    setBatchBusy(true);
    setNotice(null);
    setOpError(null);
    const failed: string[] = [];
    for (const code of selected) {
      const result = await removeOne(code);
      if (!result.ok) failed.push(`${code}：${result.message}`);
    }
    if (failed.length === 0) {
      setNotice(`已批量移除 ${selected.length} 只`);
    } else {
      setOpError(`批量移除部分失败 —— ${failed.join('；')}`);
    }
    setSelected([]);
    await loadCandidates();
    setBatchBusy(false);
  }, [selected, removeOne, loadCandidates]);

  // ── 选择 ────────────────────────────────────────────────
  const handleToggle = useCallback((assetCode: string) => {
    setSelected((prev) =>
      prev.includes(assetCode) ? prev.filter((c) => c !== assetCode) : [...prev, assetCode],
    );
  }, []);

  const handleToggleAll = useCallback(
    (checked: boolean) => {
      setSelected(checked ? rows.map((r) => r.asset_code) : []);
    },
    [rows],
  );

  /** 已在自选里的标的（用于「加入自选」按钮置灰）*/
  const watchCodes = useMemo(() => watchRows.map((r) => r.asset_code), [watchRows]);

  const toolbarStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: SPACING.gapBase,
    flexWrap: 'wrap',
    marginBottom: SPACING.gapBase,
  };

  const fieldsetStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: SPACING.gapBase,
    border: 'none',
    margin: 0,
    padding: 0,
    flexWrap: 'wrap',
  };

  const legendStyle: React.CSSProperties = {
    fontSize: TYPO.smallSize,
    color: COLORS.textSecondary,
    padding: 0,
  };

  return (
    <div style={pageContainerStyle}>
      <h1 style={titleStyle}>候选池</h1>

      <div style={cardStyle} aria-busy={loading}>
        {/* ── 工具栏：迁移价格模式 + 批量操作 + 刷新 ── */}
        <div style={toolbarStyle}>
          <fieldset style={fieldsetStyle}>
            <legend style={legendStyle}>迁移价格模式</legend>
            <label htmlFor="candidate-price-mode-base" style={{ fontSize: TYPO.bodySize }}>
              <input
                id="candidate-price-mode-base"
                type="radio"
                name="candidate-price-mode"
                value="base"
                checked={priceMode === 'base'}
                onChange={() => setPriceMode('base')}
              />
              复用基准价
            </label>
            <label htmlFor="candidate-price-mode-current" style={{ fontSize: TYPO.bodySize }}>
              <input
                id="candidate-price-mode-current"
                type="radio"
                name="candidate-price-mode"
                value="current"
                checked={priceMode === 'current'}
                onChange={() => setPriceMode('current')}
              />
              使用现价
            </label>
          </fieldset>

          <button
            style={buttonStyle}
            disabled={selected.length === 0 || batchBusy}
            onClick={() => void handleBatchMigrate()}
          >
            批量迁移自选（{selected.length}）
          </button>
          <button
            style={buttonStyle}
            disabled={selected.length === 0 || batchBusy}
            onClick={() => void handleBatchRemove()}
          >
            批量移除（{selected.length}）
          </button>
          <button style={buttonStyle} onClick={() => void loadCandidates()} disabled={loading}>
            刷新
          </button>
        </div>

        {/* 操作结果（成功 / 失败）—— `aria-live` 让读屏也能听到反馈 */}
        <div aria-live="polite">
          {notice !== null && (
            <div
              data-testid="candidate-notice"
              style={{ color: COLORS.textSuccess, fontSize: TYPO.bodySize }}
            >
              {notice}
            </div>
          )}
          {opError !== null && (
            <div data-testid="candidate-op-error" style={errorStyle}>
              {opError}
            </div>
          )}
        </div>

        <div style={{ marginTop: SPACING.gapBase }}>
          <CandidateTable
            rows={rows}
            selected={selected}
            onToggle={handleToggle}
            onToggleAll={handleToggleAll}
            onMigrate={(code) => void handleMigrate(code)}
            onRemove={(code) => void handleRemove(code)}
            onAddWatch={(code) => void handleAddWatch(code)}
            pending={pending}
            watchCodes={watchCodes}
            loading={loading}
            error={error}
            onRetry={() => void loadCandidates()}
          />
        </div>

        {/* ── 自选列表分区（候选池独立于自选，Requirements §5.7 #1）── */}
        <WatchListPanel rows={watchRows} loading={watchLoading} error={watchError} />
      </div>

      {/*
        候选池为空时的引导：去「条件选股」把选股结果一键加入候选池（PRD S3）。
        放在页面底部，避免与表格的空态抢焦点。
      */}
      {rows.length === 0 && !loading && error === null && (
        <div style={{ marginTop: SPACING.gapBase }}>
          <button style={buttonStyle} onClick={() => navigate('/stockscan')}>
            去条件选股
          </button>
        </div>
      )}
    </div>
  );
}
