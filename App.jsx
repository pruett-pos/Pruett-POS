import { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api } from './api.js';
import { SessionContext, isManager } from './session.jsx';
import { ApprovalProvider } from './components/Approval.jsx';
import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import Returns from './pages/Returns.jsx';
import Sales from './pages/Sales.jsx';
import Products from './pages/Products.jsx';
import Customers from './pages/Customers.jsx';
import Import from './pages/Import.jsx';
import Settings from './pages/Settings.jsx';
import EndOfDay from './pages/EndOfDay.jsx';
import Prices from './pages/Prices.jsx';

export default function App() {
  const [session, setSession] = useState(null); // null = loading
  const [settings, setSettings] = useState(null);
  const [waiting, setWaiting] = useState(0);

  const refresh = useCallback(async () => {
    const me = await api.get('/auth/me').catch(() => ({ user: null }));
    setSession(me);
    if (me.user) setSettings(await api.get('/admin/settings').catch(() => null));
    if (me.user && (me.user.role === 'manager' || me.user.role === 'admin')) {
      api.get('/prices/status').then((s) => setWaiting(Number(s.waiting) || 0)).catch(() => {});
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const out = () => setSession({ user: null });
    window.addEventListener('pos:logged-out', out);
    return () => window.removeEventListener('pos:logged-out', out);
  }, []);

  if (!session) return <div className="center-page">Loading…</div>;
  if (!session.user) return <Login onLogin={refresh} />;

  const mgr = isManager(session.user);
  const logout = async () => { await api.post('/auth/logout'); setSession({ user: null }); };

  return (
    <SessionContext.Provider value={{ ...session, settings, refresh }}>
      <ApprovalProvider>
        <div className="app">
          <header className="topbar">
            <div className="brand">{session.store?.name || 'Pruett POS'}</div>
            <nav>
              <NavLink to="/register">Register</NavLink>
              <NavLink to="/returns">Returns</NavLink>
              <NavLink to="/sales">Sales</NavLink>
              <NavLink to="/products">Products</NavLink>
              <NavLink to="/customers">Customers</NavLink>
              <NavLink to="/end-of-day">End of Day</NavLink>
              {mgr && <NavLink to="/prices">Price Updates{waiting > 0 && <span className="nav-count">{waiting}</span>}</NavLink>}
              {mgr && <NavLink to="/import">Import</NavLink>}
              {mgr && <NavLink to="/settings">Settings</NavLink>}
            </nav>
            <div className="who">
              <span>{session.user.name}</span>
              <button className="btn small" onClick={logout}>Log out</button>
            </div>
          </header>
          {settings && settings.tax_rate_pct == null && (
            <div className="banner warn">Sales tax rate is not set — a manager must set it in Settings before the register can complete sales.</div>
          )}
          {session.cardMode !== 'stripe' && (
            <div className="banner info">
              Card payments are in {session.cardMode === 'simulated' ? 'SIMULATION' : 'Stripe TEST'} mode — no real cards are charged.
            </div>
          )}
          <main>
            <Routes>
              <Route path="/register" element={<Register />} />
              <Route path="/returns" element={<Returns />} />
              <Route path="/sales" element={<Sales />} />
              <Route path="/sales/:id" element={<Sales />} />
              <Route path="/products" element={<Products />} />
              <Route path="/customers" element={<Customers />} />
              <Route path="/end-of-day" element={<EndOfDay />} />
              {mgr && <Route path="/prices" element={<Prices />} />}
              {mgr && <Route path="/prices/:id" element={<Prices />} />}
              {mgr && <Route path="/import" element={<Import />} />}
              {mgr && <Route path="/settings" element={<Settings />} />}
              <Route path="*" element={<Navigate to="/register" replace />} />
            </Routes>
          </main>
        </div>
      </ApprovalProvider>
    </SessionContext.Provider>
  );
}
