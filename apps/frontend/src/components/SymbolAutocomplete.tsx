import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { COLORS, RADIUS, TYPO } from '../theme/tokens';
import { inputStyle } from '../theme/styles';

/**
 * 标的自动补全输入框（T68 从 `pages/TradeInput.tsx` 迁出；V3.8 T142 增强）
 *
 * T142 交付（PRD_v3 §2.1/§2.2 · INV-S1-*，联想走 symbol_dict 快照）：
 * - 输入 ≥ 2 字符 → **防抖 200ms** → `GET /symbols/search?q=...` → 候选列表
 * - **10 条上限**（超出截断，避免长列表滚动）
 * - 键盘 ↑↓ / Enter / Esc（既有行为保留）
 * - **现金类标签**：候选 `asset_class === 'cash'` 显示「现金」徽标（T133 口径）
 * - **唯一命中自动确认**：返回恰好 1 条时自动填入完整代码并置确认态
 * - **确认态提示**：选中/自动确认后输入框右侧显示「✓ {名称}」
 * - 点其它处（失焦 150ms 后）关闭。
 */

export interface SymbolOption {
  symbol: string;
  name: string;
  /** T142：现金类标识（asset_class === 'cash'，T133 判定口径） */
  asset_class?: string;
}

export interface SymbolAutocompleteProps {
  value: string;
  onChange: (val: string) => void;
  /** 控件 id —— 供外层 `<label htmlFor>` 建立程序化关联（T63）*/
  id: string;
}

/** 防抖 200ms（T142）*/
const DEBOUNCE_MS = 200;
/** 候选上限（T142）*/
const MAX_OPTIONS = 10;

export default function SymbolAutocomplete({ value, onChange, id }: SymbolAutocompleteProps) {
  const [options, setOptions] = useState<SymbolOption[]>([]);
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  /** T142：确认态（已选中的标的名称）*/
  const [confirmedName, setConfirmedName] = useState<string | null>(null);

  // 竞态防护：只采纳最新一次请求的结果（防抖 + 异步返回交错）
  const reqSeq = useRef(0);

  const query = value.trim();

  const fetchOptions = async (q: string) => {
    if (q.length < 2) {
      setOptions([]);
      setOpen(false);
      return;
    }
    const seq = ++reqSeq.current;
    try {
      const res = await api.get('/symbols/search', { params: { q } });
      if (seq !== reqSeq.current) return; // 已被更新的请求取代
      const rows = ((res.data?.data ?? []) as SymbolOption[]).slice(0, MAX_OPTIONS);
      setOptions(rows);
      setHighlightIdx(-1);
      // T142：唯一命中自动确认（直接填入完整代码，免点选）
      if (rows.length === 1) {
        select(rows[0]);
        return;
      }
      setOpen(true);
    } catch {
      if (seq === reqSeq.current) setOptions([]);
    }
  };

  /** T142：防抖 —— 停止输入 200ms 后才发请求 */
  useEffect(() => {
    if (query.length < 2) {
      setOptions([]);
      setOpen(false);
      reqSeq.current++; // 作废旧请求
      return;
    }
    const t = setTimeout(() => void fetchOptions(query), DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const select = (opt: SymbolOption) => {
    onChange(opt.symbol);
    setOpen(false);
    setOptions([]);
    setConfirmedName(opt.name || opt.symbol);
  };

  const handleChange = (v: string) => {
    onChange(v);
    setConfirmedName(null); // 重新编辑 → 清除确认态
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIdx((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && highlightIdx >= 0) {
      e.preventDefault();
      select(options[highlightIdx]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
        <input
          id={id}
          style={{ ...inputStyle, flex: 1, width: '100%', boxSizing: 'border-box' }}
          type="text"
          placeholder="输入代码或名称，如 600000 或 浦发"
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            if (options.length > 0) setOpen(true);
          }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          required
          aria-describedby={confirmedName ? `${id}-confirmed` : undefined}
        />
        {/* T142：确认态提示（唯一命中自动确认 / 手动选中后）*/}
        {confirmedName && (
          <span
            id={`${id}-confirmed`}
            role="status"
            style={{
              position: 'absolute',
              right: 10,
              top: '50%',
              transform: 'translateY(-50%)',
              fontSize: TYPO.captionSize,
              color: COLORS.textSuccess,
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
            }}
          >
            ✓ {confirmedName}
          </span>
        )}
      </div>
      {open && options.length > 0 && (
        <ul
          role="listbox"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            margin: 0,
            padding: 0,
            listStyle: 'none',
            border: `1px solid ${COLORS.borderMedium}`,
            borderRadius: RADIUS.sm,
            marginTop: 2,
            background: COLORS.cardBg,
            boxShadow: `0 4px 12px ${COLORS.shadowSoft}`,
            zIndex: 100,
            maxHeight: 240,
            overflowY: 'auto',
          }}
        >
          {options.map((opt, idx) => (
            <li
              key={opt.symbol}
              role="option"
              aria-selected={idx === highlightIdx}
              onClick={() => select(opt)}
              onMouseEnter={() => setHighlightIdx(idx)}
              style={{
                padding: '6px 10px',
                cursor: 'pointer',
                fontSize: TYPO.bodySize,
                background: idx === highlightIdx ? COLORS.brandBg : COLORS.cardBg,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontFamily: TYPO.monoFamily, color: COLORS.brandLink }}>{opt.symbol}</span>
                {/* T142：现金类标签（T133 口径：现金类标的可持但不进信号计算） */}
                {opt.asset_class === 'cash' && (
                  <span
                    style={{
                      fontSize: TYPO.captionSize,
                      color: COLORS.textWarning,
                      border: `1px solid ${COLORS.warning}`,
                      borderRadius: RADIUS.sm,
                      padding: '0 4px',
                    }}
                  >
                    现金
                  </span>
                )}
              </span>
              <span style={{ color: COLORS.neutral }}>{opt.name}</span>
            </li>
          ))}
        </ul>
      )}
      {open && options.length === 0 && query.length >= 2 && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            padding: '8px 10px',
            fontSize: TYPO.smallSize,
            color: COLORS.neutral,
            background: COLORS.cardBg,
            border: `1px solid ${COLORS.borderMedium}`,
            borderRadius: RADIUS.sm,
            marginTop: 2,
            zIndex: 100,
          }}
        >
          无匹配标的
        </div>
      )}
    </div>
  );
}
