import { useEffect, useState } from 'react';
import { api, money, registerConfig } from '../api.js';
import { useSession } from '../session.jsx';
import Modal from '../components/Modal.jsx';

const TABS = ['Store & pricing', 'Price levels', 'Categories', 'Vendors', 'Users', 'This register'];

export default function Settings() {
  const [tab, setTab] = useState(TABS[0]);
  return (
    <div className="page">
      <h1>Settings</h1>
      <div className="tabs">{TABS.map((t) => <button key={t} className={t === tab ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>)}</div>
      {tab === 'Store & pricing' && <StoreSettings />}
      {tab === 'Price levels' && <PriceLevels />}
      {tab === 'Categories' && <Categories />}
      {tab === 'Vendors' && <Vendors />}
      {tab === 'Users' && <Users />}
      {tab === 'This register' && <ThisRegister />}
    </div>
  );
}

function StoreSettings() {
  const { refresh } = useSession();
  const [s, setS] = useState(null);
  const [msg, setMsg] = useState('');
  useEffect(() => { api.get('/admin/settings').then(setS); }, []);
  if (!s) return null;
  const save = async (e) => {
    e.preventDefault();
    setMsg('');
    try {
      await api.put('/admin/settings', {
        store: s.store,
        tax_rate_pct: s.tax_rate_pct === '' || s.tax_rate_pct == null ? null : Number(s.tax_rate_pct),
        price_rounding_cents: Number(s.price_rounding_cents),
        default_margin_pct: Number(s.default_margin_pct),
        receipt_footer: s.receipt_footer,
        require_manager_for_price_override: !!s.require_manager_for_price_override,
        large_change_flag_pct: Number(s.large_change_flag_pct),
      });
      setMsg('Saved');
      refresh();
    } catch (ex) {
      setMsg(ex.message);
    }
  };
  const store = (k) => (e) => setS({ ...s, store: { ...s.store, [k]: e.target.value } });
  const set = (k) => (e) => setS({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <form className="card stack" onSubmit={save}>
      <div className="form-grid">
        <label>Store name<input value={s.store.name} onChange={store('name')} /></label>
        <label>Phone<input value={s.store.phone} onChange={store('phone')} /></label>
        <label className="span2">Address (printed on receipts)<input value={s.store.address} onChange={store('address')} /></label>
        <label>Sales tax rate %<input type="number" step="0.001" value={s.tax_rate_pct ?? ''} onChange={set('tax_rate_pct')} placeholder="Confirm with your accountant" /></label>
        <label>Round prices to
          <select value={s.price_rounding_cents} onChange={set('price_rounding_cents')}>
            <option value={1}>Nearest $0.01</option><option value={5}>Nearest $0.05</option><option value={10}>Nearest $0.10</option><option value={25}>Nearest $0.25</option>
          </select>
        </label>
        <label>Default margin % (items with no category)<input type="number" step="0.1" value={s.default_margin_pct} onChange={set('default_margin_pct')} /></label>
        <label>Price agent: flag changes bigger than %<input type="number" step="1" value={s.large_change_flag_pct} onChange={set('large_change_flag_pct')} /></label>
        <label className="check"><input type="checkbox" checked={!!s.require_manager_for_price_override} onChange={set('require_manager_for_price_override')} /> Cashier price changes need manager approval</label>
        <label className="span2">Receipt footer<input value={s.receipt_footer} onChange={set('receipt_footer')} /></label>
      </div>
      <div className="row end">{msg && <span className={msg === 'Saved' ? 'ok' : 'error'}>{msg}</span>}<button className="btn primary">Save settings</button></div>
    </form>
  );
}

function PriceLevels() {
  const [rows, setRows] = useState([]);
  const [edit, setEdit] = useState(null);
  const [err, setErr] = useState('');
  const load = () => api.get('/admin/price-levels').then(setRows);
  useEffect(() => { load(); }, []);
  const save = async (e) => {
    e.preventDefault();
    setErr('');
    try {
      const body = { name: edit.name, kind: edit.kind, pct: edit.pct === '' || edit.pct == null ? null : Number(edit.pct) };
      if (edit.id) await api.put(`/admin/price-levels/${edit.id}`, body); else await api.post('/admin/price-levels', body);
      setEdit(null); load();
    } catch (ex) { setErr(ex.message); }
  };
  const describe = (l) => (l.pct == null ? <span className="error">Not set — charging retail</span>
    : l.kind === 'cost_plus' ? `Cost + ${Number(l.pct)}%` : `${Number(l.pct)}% off retail`);
  return (
    <div className="card stack">
      <div className="row between">
        <p className="muted">Pricing plans from Paladin. Customers with no plan pay retail. Plan prices are rounded to the nearest
          nickel and never go below cost.</p>
        <button className="btn primary" onClick={() => setEdit({ name: '', kind: 'discount', pct: '' })}>Add level</button>
      </div>
      <table className="grid clickable">
        <thead><tr><th>Price level</th><th>Rule</th><th className="num">Customers</th></tr></thead>
        <tbody>{rows.map((l) => (
          <tr key={l.id} onClick={() => setEdit({ ...l, pct: l.pct ?? '' })}><td>{l.name}</td><td>{describe(l)}</td><td className="num">{l.customer_count}</td></tr>
        ))}</tbody>
      </table>
      {edit && (
        <Modal title={edit.id ? edit.name : 'New price level'} onClose={() => setEdit(null)}>
          <form className="stack" onSubmit={save}>
            <label>Name<input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required /></label>
            <label>Rule
              <select value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}>
                <option value="discount">% off retail</option>
                <option value="cost_plus">Cost plus %</option>
              </select>
            </label>
            <label>{edit.kind === 'discount' ? 'Discount %' : 'Markup on cost %'}
              <input type="number" step="0.01" value={edit.pct} onChange={(e) => setEdit({ ...edit, pct: e.target.value })} placeholder="blank = not set" /></label>
            {err && <p className="error">{err}</p>}
            <div className="row end"><button className="btn primary">Save</button></div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function Categories() {
  const [cats, setCats] = useState([]);
  const [edit, setEdit] = useState(null);
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState('');
  const load = () => api.get('/admin/categories').then(setCats);
  useEffect(() => { load(); }, []);

  const check = async () => {
    setErr('');
    try {
      if (!edit.id) {
        await api.post('/admin/categories', { name: edit.name, margin_pct: Number(edit.margin_pct) });
        setEdit(null); load(); return;
      }
      setPreview(await api.put(`/admin/categories/${edit.id}`, { name: edit.name, margin_pct: Number(edit.margin_pct) }));
    } catch (ex) { setErr(ex.message); }
  };
  const apply = async () => {
    try {
      await api.put(`/admin/categories/${edit.id}`, { name: edit.name, margin_pct: Number(edit.margin_pct), apply: true });
      setEdit(null); setPreview(null); load();
    } catch (ex) { setErr(ex.message); }
  };

  return (
    <div className="card stack">
      <div className="row between">
        <p className="muted">Retail = cost ÷ (1 − margin). Changing a margin reprices every item in that category except items with a manual price.</p>
        <button className="btn primary" onClick={() => { setEdit({ name: '', margin_pct: 30 }); setPreview(null); }}>Add category</button>
      </div>
      <table className="grid clickable">
        <thead><tr><th>Category</th><th className="num">Margin</th><th className="num">Markup equiv.</th><th className="num">Items</th></tr></thead>
        <tbody>
          {cats.map((c) => (
            <tr key={c.id} onClick={() => { setEdit({ ...c }); setPreview(null); setErr(''); }}>
              <td>{c.name}</td><td className="num">{Number(c.margin_pct)}%</td>
              <td className="num">{Math.round((Number(c.margin_pct) / (100 - Number(c.margin_pct))) * 1000) / 10}%</td>
              <td className="num">{c.product_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && (
        <Modal title={edit.id ? `Edit ${edit.name}` : 'New category'} onClose={() => setEdit(null)} wide>
          <div className="stack">
            <div className="row">
              <label className="grow">Name<input value={edit.name} onChange={(e) => { setEdit({ ...edit, name: e.target.value }); setPreview(null); }} /></label>
              <label>Margin %<input type="number" step="0.1" value={edit.margin_pct} onChange={(e) => { setEdit({ ...edit, margin_pct: e.target.value }); setPreview(null); }} /></label>
            </div>
            {err && <p className="error">{err}</p>}
            {!preview && <div className="row end"><button className="btn primary" onClick={check}>{edit.id ? 'Preview price changes' : 'Create'}</button></div>}
            {preview && (
              <>
                <p><strong>{preview.changeCount}</strong> item prices will change.</p>
                {preview.changes.length > 0 && (
                  <table className="grid small">
                    <thead><tr><th>SKU</th><th>Description</th><th className="num">Cost</th><th className="num">Now</th><th className="num">New</th></tr></thead>
                    <tbody>{preview.changes.slice(0, 50).map((c) => (
                      <tr key={c.id}><td>{c.sku}</td><td>{c.description}</td><td className="num">{money(c.cost_cents)}</td><td className="num">{money(c.retail_cents)}</td><td className="num">{money(c.new_retail_cents)}</td></tr>
                    ))}</tbody>
                  </table>
                )}
                <div className="row end"><button className="btn primary" onClick={apply}>Save and update {preview.changeCount} prices</button></div>
              </>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

function Vendors() {
  const [rows, setRows] = useState([]);
  const [edit, setEdit] = useState(null);
  const [err, setErr] = useState('');
  const load = () => api.get('/admin/vendors').then(setRows);
  useEffect(() => { load(); }, []);
  const save = async (e) => {
    e.preventDefault();
    try {
      const body = { name: edit.name, email: edit.email || null, account_no: edit.account_no || null, notes: edit.notes || null };
      if (edit.id) await api.put(`/admin/vendors/${edit.id}`, body); else await api.post('/admin/vendors', body);
      setEdit(null); load();
    } catch (ex) { setErr(ex.message); }
  };
  return (
    <div className="card stack">
      <div className="row between"><p className="muted">The price agent will use the vendor email to know who sent a price sheet.</p>
        <button className="btn primary" onClick={() => setEdit({ name: '' })}>Add vendor</button></div>
      <table className="grid clickable">
        <thead><tr><th>Vendor</th><th>Price sheet email</th><th>Account #</th></tr></thead>
        <tbody>{rows.map((v) => <tr key={v.id} onClick={() => setEdit(v)}><td>{v.name}</td><td>{v.email}</td><td>{v.account_no}</td></tr>)}</tbody>
      </table>
      {edit && (
        <Modal title={edit.id ? edit.name : 'New vendor'} onClose={() => setEdit(null)}>
          <form className="stack" onSubmit={save}>
            <label>Name<input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required /></label>
            <label>Email price sheets come from<input value={edit.email || ''} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></label>
            <label>Our account #<input value={edit.account_no || ''} onChange={(e) => setEdit({ ...edit, account_no: e.target.value })} /></label>
            <label>Notes<textarea value={edit.notes || ''} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></label>
            {err && <p className="error">{err}</p>}
            <div className="row end"><button className="btn primary">Save</button></div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function Users() {
  const { user } = useSession();
  const [rows, setRows] = useState([]);
  const [edit, setEdit] = useState(null);
  const [err, setErr] = useState('');
  const load = () => api.get('/admin/users').then(setRows);
  useEffect(() => { load(); }, []);
  const save = async (e) => {
    e.preventDefault();
    setErr('');
    try {
      const body = { username: edit.username, name: edit.name, email: edit.email || null, role: edit.role, active: edit.active !== false };
      if (edit.password) body.password = edit.password;
      if (edit.id) await api.put(`/admin/users/${edit.id}`, body); else await api.post('/admin/users', body);
      setEdit(null); load();
    } catch (ex) { setErr(ex.message); }
  };
  return (
    <div className="card stack">
      <div className="row between"><p className="muted">Cashiers can use a 4+ digit PIN. Managers and admins need a 10+ character password.</p>
        <button className="btn primary" onClick={() => setEdit({ username: '', name: '', role: 'cashier', password: '' })}>Add user</button></div>
      <table className="grid clickable">
        <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th></tr></thead>
        <tbody>{rows.map((u) => <tr key={u.id} onClick={() => setEdit({ ...u, password: '' })}><td>{u.name}</td><td>{u.username}</td><td>{u.role}</td><td>{u.active ? 'Active' : 'Disabled'}</td></tr>)}</tbody>
      </table>
      {edit && (
        <Modal title={edit.id ? edit.name : 'New user'} onClose={() => setEdit(null)}>
          <form className="stack" onSubmit={save}>
            <label>Full name<input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required /></label>
            <label>Username<input value={edit.username} onChange={(e) => setEdit({ ...edit, username: e.target.value })} required /></label>
            <label>Role
              <select value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })}>
                <option value="cashier">Cashier</option><option value="manager">Manager</option>
                {user.role === 'admin' && <option value="admin">Admin</option>}
              </select>
            </label>
            <label>{edit.id ? 'New password / PIN (leave blank to keep)' : 'Password / PIN'}
              <input type="password" autoComplete="new-password" value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} /></label>
            {edit.id && edit.id !== user.id && <label className="check"><input type="checkbox" checked={edit.active !== false} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Active</label>}
            {err && <p className="error">{err}</p>}
            <div className="row end"><button className="btn primary">Save</button></div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function ThisRegister() {
  const [cfg, setCfg] = useState(registerConfig.get());
  const [readers, setReaders] = useState(null);
  const [msg, setMsg] = useState('');
  useEffect(() => { api.get('/sales/card/readers').then(setReaders).catch((e) => setMsg(e.message)); }, []);
  const save = () => { registerConfig.set(cfg); setMsg('Saved on this device'); };
  return (
    <div className="card stack">
      <p className="muted">These settings are stored on this computer/tablet only, so each counter can have its own name and card reader.</p>
      <label>Register name<input value={cfg.name || ''} onChange={(e) => setCfg({ ...cfg, name: e.target.value })} placeholder="Counter 1" /></label>
      <label>Card reader
        <select value={cfg.readerId || ''} onChange={(e) => setCfg({ ...cfg, readerId: e.target.value })}>
          <option value="">— choose —</option>
          {readers?.readers.map((r) => <option key={r.id} value={r.id}>{r.label || r.id} ({r.status})</option>)}
        </select>
      </label>
      {readers && <p className="muted small">Card mode: {readers.mode}</p>}
      <div className="row end">{msg && <span className="ok">{msg}</span>}<button className="btn primary" onClick={save}>Save</button></div>
    </div>
  );
}
