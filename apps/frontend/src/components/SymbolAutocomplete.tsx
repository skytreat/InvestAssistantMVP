import React, { useState } from 'react';
import { api } from '../api/client';
import { COLORS, RADIUS, TYPO } from '../theme/tokens';
import { inputStyle } from '../theme/styles';

/**
 * 标的自动补全输入框（T68 从 `pages/TradeInput.tsx` 原样迁出）
 *
 * 迁出的原因：T68 把交易录入页重写成「Tab 组 + 预估面板 + 标签行」，
 * 页面文件会变得很长；把与「交易录入业务」无关的通用输入控件拆到组件层，
 * 页面只保留业务编排。
 *
 * ⚠️ **行为逐字未变**（与迁出前一致）：
 * - 输入 ≥ 2 个字符 → `GET /symbols/search?q=...` → 弹出匹配列表；
 * - 点击候选项 → 用后端返回的**完整代码**覆盖输入值（如 `sh600519`）；
 * - ↑ / ↓ 移动高亮，Enter 选中，Esc 关闭；
 * - 点其它处（失焦 150ms 后）关闭。
 */

export interface SymbolOption {
  symbol: string;
  name: string;
}

export interface SymbolAutocompleteProps {
  value: string;
  onChange: (val: string) => void;
  /** 控件 id —— 供外层 `<label htmlFor>` 建立程序化关联（T63）*/
  id: string;
}

export default function SymbolAutocomplete({ value, onChange, id }: SymbolAutocompleteProps) {
  const [options, setOptions] = useState<SymbolOption[]>([]);
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);

  const query = value.trim();

  const fetchOptions = async (q: string) => {
    if (q.length < 2) {
      setOptions([]);
      setOpen(false);
      return;
    }
    try {
      const res = await api.get('/symbols/search', { params: { q } });
      setOptions((res.data?.data ?? []) as SymbolOption[]);
      setOpen(true);
      setHighlightIdx(-1);
    } catch {
      /* ignore */
    }
  };

  const handleChange = (v: string) => {
    onChange(v);
    void fetchOptions(v);
  };

  const handleSelect = (opt: SymbolOption) => {
    // 自动补全前缀：如果当前值没有前缀，从 option.symbol 取
    const sym = opt.symbol;
    onChange(sym);
    setOpen(false);
    setOptions([]);
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
      handleSelect(options[highlightIdx]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
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
      />
      {open && options.length > 0 && (
        <ul
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
              onClick={() => handleSelect(opt)}
              onMouseEnter={() => setHighlightIdx(idx)}
              style={{
                padding: '6px 10px',
                cursor: 'pointer',
                fontSize: TYPO.bodySize,
                background: idx === highlightIdx ? COLORS.brandBg : COLORS.cardBg,
                display: 'flex',
                justifyContent: 'space-between',
              }}
            >
              <span style={{ fontFamily: TYPO.monoFamily, color: COLORS.brandLink }}>{opt.symbol}</span>
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
