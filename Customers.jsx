import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, money, toCents, fmtDate } from '../api.js';
import { useSession, isManager } from '../session.jsx';
import Modal from '../components/Modal.jsx';
import { CustomerBadge } from '../components/CustomerPicker.jsx';

export default function Customers() {
  const { user } = useSession();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [editing, setEditing] = useState(null);
  const load = () => api.get(`/customers?q=${encodeURIComponent(q)}`).then(setRows);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="page">
      <div className="row between">
        <h1>Customers</h1>
        <button className="btn primary" onClick={() => setEditing({ name: '', price_level_id: null, charge_account: false, credit_limit_cents: 0, terms_days: 30, tax_exempt: false })}>New customer</button>
      </div>
      <div className="card"><input className="full" autoFocus placeholder="Search name, company, phone, email" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <table className="grid clickable">
        <thead><tr><th>Name</th><th>Company</th><th>Phone</th><th /><th className="num">Balance</th></tr></thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} onClick={async () => setEditing(await api.get(`/customers/${c.id}`))}>
              <td>{c.name}</td><td>{c.company}</td><td>{c.phone}</td><td><CustomerBadge c={c} /></td>
              <td className="num">{c.charge_account ? money(c.balance_cents) : ''}</td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={5} className="empty">No customers found</td></tr>}
        </tbody>
      </table>
      {editing && <CustomerEditor c={editing} mgr={isManager(user)} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function CustomerEditor({ c, mgr, onClose, onSaved }) {
  const [f, setF] = useState({ ...c, credit_limit: ((c.credit_limit_cents || 0) / 100).toFixed(2) });
  const [levels, setLevels] = useState([]);
  useEffect(() => { api.get('/admin/price-levels').then(setLevels); }, []);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const save = async (e) => {
    e.preventDefault();
    setErr('');
    const body = {
      name: f.name, company: f.company || null, phone: f.phone || null, email: f.email || null, address: f.address || null,
      price_level_id: f.price_level_id ? Number(f.price_level_id) : null, charge_account: !!f.charge_account,
      require_po: !!f.require_po, checkout_note: f.checkout_note || null, email_statements: !!f.email_statements, credit_limit_cents: toCents(f.credit_limit) || 0,
      terms_days: Number(f.terms_days) || 30, tax_exempt: !!f.tax_exempt, tax_exempt_cert: f.tax_exempt_cert || null, notes: f.notes || null,
    };
    try {
      if (c.id) await api.put(`/customers/${c.id}`, body);
      else await api.post('/customers', body);
      onSaved();
    } catch (ex) {
      setErr(ex.message);
    }
  };
  return (
    <Modal title={c.id ? c.name : 'New customer'} onClose={onClose} wide>
      <form className="stack" onSubmit={save}>
        <div className="form-grid">
          <label>Name<input value={f.name} onChange={set('name')} required autoFocus /></label>
          <label>Company<input value={f.company || ''} onChange={set('company')} /></label>
          <label>Phone<input value={f.phone || ''} onChange={set('phone')} /></label>
          <label>Email<input value={f.email || ''} onChange={set('email')} /></label>
          <label className="span2">Address<input value={f.address || ''} onChange={set('address')} /></label>
        </div>
        <fieldset disabled={!mgr} className="form-grid">
          <legend>Pricing &amp; account {mgr ? '' : '(manager only)'}</legend>
          <label>Price level
            <select value={f.price_level_id || ''} onChange={set('price_level_id')}>
              <option value="">Retail</option>
              {levels.map((l) => <option key={l.id} value={l.id}>{l.name} — {l.pct == null ? '% not set' : l.kind === 'cost_plus' ? `cost + ${Number(l.pct)}%` : `${Number(l.pct)}% off retail`}</option>)}
            </select>
          </label>
          <label className="check"><input type="checkbox" checked={!!f.require_po} onChange={set('require_po')} /> Require PO / job # on every sale</label>
          <label className="check"><input type="checkbox" checked={!!f.charge_account} onChange={set('charge_account')} /> Charge account</label>
          <label>Credit limit (0 = no limit)<input inputMode="decimal" value={f.credit_limit} onChange={set('credit_limit')} disabled={!f.charge_account} /></label>
          <label>Terms (days)<input type="number" value={f.terms_days} onChange={set('terms_days')} disabled={!f.charge_account} /></label>
          <label className="check"><input type="checkbox" checked={!!f.tax_exempt} onChange={set('tax_exempt')} /> Tax exempt</label>
          <label>Exemption certificate #<input value={f.tax_exempt_cert || ''} onChange={set('tax_exempt_cert')} disabled={!f.tax_exempt} placeholder={f.tax_exempt ? 'Not on file yet' : ''} /></label>
          <label className="check"><input type="checkbox" checked={!!f.email_statements} onChange={set('email_statements')} /> Email monthly statements</label>
        </fieldset>
        <label>Message shown at the register when this customer is selected<input value={f.checkout_note || ''} onChange={set('checkout_note')} /></label>
        <label>Notes<textarea value={f.notes || ''} onChange={set('notes')} rows={2} /></label>
        {err && <p className="error">{err}</p>}
        <div className="row end"><button className="btn primary">Save</button></div>
      </form>
      {c.sales?.length > 0 && (
        <>
          <h3>Recent purchases {c.charge_account && <span className="muted">· balance {money(c.balance_cents)}</span>}</h3>
          <table className="grid small">
            <tbody>
              {c.sales.map((s) => (
                <tr key={s.id}><td><Link to={`/sales/${s.id}`}>#{s.number}</Link></td><td>{fmtDate(s.created_at)}</td><td>{s.po_number}</td>
                  <td>{s.kind === 'return' ? 'Return' : ''}{s.status === 'voided' ? 'Voided' : ''}</td><td className="num">{money(s.total_cents)}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Modal>
  );
}
