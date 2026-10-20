import React from 'react';
import { Navigate } from 'react-router-dom';
import { useUserStore } from '../store/user';

/**
 * 管理员路由守卫（T98）
 *
 * 契约来源：SDD §2.12.2「路由设计」的 `AdminGuard`（语义等价），**按本项目实际适配 3 处口径差异**：
 *
 * | SDD 写法 | 本项目实际 | 本文件实现 |
 * |---|---|---|
 * | `useAuthStore` from `@/stores/authStore` | `useUserStore` from `src/store/user`（前端**无 `@` alias**，走相对导入）| `import { useUserStore } from '../store/user'` |
 * | 非 admin 重定向到 `/dashboard` | 仪表盘路由是 **`/`**（`App.tsx`：`<Route path="/" element={<Dashboard />} />`）| `<Navigate to="/" replace />`（若跳 `/dashboard` 会落到 404 页）|
 * | `createBrowserRouter` 配置式路由 | 本项目是 `<Routes>/<Route>` 声明式路由 | 守卫以组件形式包在 `<Route element={...}>` 上（见 `App.tsx`）|
 *
 * 🔴 **I-12：非 admin 时不得发出任何 admin API 请求。**
 * 实现上必须「**不渲染 children**」，而不是「先渲染再判断」或「在 Admin 内部判断」——
 * 只有 children 根本不挂载，其内部 `useEffect` 才不会执行，请求才不会发出。
 */
export default function AdminGuard({ children }: { children: React.ReactNode }) {
  const token = useUserStore((s) => s.token);
  const role = useUserStore((s) => s.role);

  // 未登录 → 登录页
  if (!token) return <Navigate to="/login" replace />;
  // 已登录但非 admin → 仪表盘（本项目根路由为 `/`）
  if (role !== 'admin') return <Navigate to="/" replace />;

  // 管理员：正常渲染被保护的子组件
  return <>{children}</>;
}
