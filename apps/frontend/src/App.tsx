import { Routes, Route, Navigate } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import TradeInput from './pages/TradeInput';
import Signals from './pages/Signals';
import Admin from './pages/Admin';
import Login from './pages/Login';
import { useUserStore } from './store/user';
import { Navbar } from './pages/_shared';

export default function App() {
  const token = useUserStore((s) => s.token);
  if (!token) return <Login />;

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 1200, margin: '0 auto', padding: 20 }}>
      <Navbar />
      <hr style={{ margin: '16px 0' }} />
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/trade" element={<TradeInput />} />
        <Route path="/signals" element={<Signals />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
