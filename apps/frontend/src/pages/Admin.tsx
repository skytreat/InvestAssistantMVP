import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { isOkEnvelope } from '../api/envelope';
import { pageContainerStyle, cardStyle, titleStyle, cardTitleStyle } from './_shared';
import AdminBackupPanel from '../components/AdminBackupPanel';
import AdminLogPanel from '../components/AdminLogPanel';
import AdminRolePanel from '../components/AdminRolePanel';
import AdminTriggerPanel from '../components/AdminTriggerPanel';
import DatacheckCards from '../components/DatacheckCards';

/**
 * 管理员面板（Wave 7 · T75 · 卡 6 接线收口）
 *
 * ## 这个页面现在只做「布局 + 接线」
 *
 * 旧实现把**校验卡片 / 系统日志表 / 备份 / 角色管理 / 手动触发**全部内联在本文件里，
 * 由此产生 4 个真实缺陷：
 *
 * | 旧实现的缺陷 | 根因 | 现在由谁负责 |
 * |---|---|---|
 * | `admin@375` 横向溢出 **+213 ~ +412px** | 内联 6 列系统日志表（`message`/`detail` 是长路径文本）**且无滚动容器** | `components/AdminLogPanel.tsx`（`ScrollableTable` + 截断 + `<768px` 卡片化）|
 * | **26 条 serious color-contrast** | 内联校验卡片用「彩色底 + 白字」，且 `RESULT_COLOR` **没有 `PASS` 键** ⇒ PASS 卡退化成浅灰底白字 | `components/DatacheckCards.tsx`（浅色底 + 深色字，四态齐全）|
 * | **2 处 `alert()`**（阻塞式弹窗，无法承载「失败后重试」） | 备份结果用 `alert()` 反馈 | `components/AdminBackupPanel.tsx`（内联状态条 + 重试按钮）|
 * | **11 条 eslint unused-var** | 接线后旧的内联块留下的死变量（`RESULT_COLOR` / `LOG_TYPE_LABEL` / 各 handler）| 旧块整体删除 |
 *
 * ## 分层约定
 *
 * - 页面**管布局**（卡片区结构 + 标题层级），组件**管内容**；
 * - 组件**不 import 本页面**（卡 1/2/3 的并行前提），只认 props；
 * - 「日志类型 → 中文」映射的**唯一权威**是 `AdminLogPanel` 导出的 `LOG_TYPE_LABEL`
 *   （含后端 CHECK 白名单里的 `candidate_migrate`，旧页面的副本漏了它）⇒
 *   本文件**不再保留第二份副本**。
 */
export default function Admin() {
  /**
   * 校验卡片的刷新计数
   *
   * 手动触发校验 / 补跑行情之后，`AdminTriggerPanel` 会回调 `onChecksRefreshed`
   * ⇒ 计数 +1 ⇒ `DatacheckCards` 重新拉一次 `GET /admin/datacheck/result`。
   */
  const [checksRefreshKey, setChecksRefreshKey] = useState(0);
  const [latestQuoteDate, setLatestQuoteDate] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get('/api/market/latest-date');
        if (cancelled) return;
        if (isOkEnvelope(res.data)) {
          const d = (res.data.data as { date?: string | null } | null)?.date ?? null;
          setLatestQuoteDate(d);
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const handleChecksRefreshed = useCallback(() => {
    setChecksRefreshKey((k) => k + 1);
  }, []);

  return (
    <div style={pageContainerStyle}>
      <h1 style={titleStyle}>管理员面板</h1>
      {latestQuoteDate && (
        <div style={{ fontSize: 13, color: '#666', marginBottom: 8 }}>
          最新行情日期：{latestQuoteDate}
        </div>
      )}

      {/*
        ① 数据校验结果（C1-C12）
        ⚠️ `DatacheckCards` **自带卡片外框与卡片标题**（与旧页面文案逐字一致），
           故这里不再套一层 `cardStyle`（避免双层边框）。
      */}
      <DatacheckCards refreshKey={checksRefreshKey} />

      {/*
        ② 手动触发（行情更新补跑 / 数据校验 / 信号生成）
        ⚠️ `AdminTriggerPanel` **不带外框**（卡 2 的分层约定）⇒ 外框与标题由本页提供。
      */}
      <div style={cardStyle}>
        <div style={cardTitleStyle}>手动触发</div>
        <AdminTriggerPanel onChecksRefreshed={handleChecksRefreshed} />
      </div>

      {/*
        ③ 备份与恢复（手动备份 / 备份列表 / 恢复 + 二次确认）
        ⚠️ `AdminBackupPanel` **不带外框** ⇒ 外框与标题由本页提供。
      */}
      <div style={cardStyle}>
        <div style={cardTitleStyle}>备份与恢复</div>
        <AdminBackupPanel />
      </div>

      {/*
        ④ 角色管理（用户列表 / 升级降级 + 二次确认）
        ⚠️ `AdminRolePanel` **不带外框** ⇒ 外框与标题由本页提供。
      */}
      <div style={cardStyle}>
        <div style={cardTitleStyle}>角色管理</div>
        <AdminRolePanel />
      </div>

      {/*
        ⑤ 系统日志（三类筛选 + 长文本截断 + `<768px` 卡片化）
        ⚠️ `AdminLogPanel` **自带卡片外框与 `<h2>` 标题**（与旧页面文案逐字一致），
           故这里不再套一层 `cardStyle`。
      */}
      <AdminLogPanel pageSize={20} />
    </div>
  );
}
