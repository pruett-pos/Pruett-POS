import { useEffect, useState } from 'react';
import { api, money } from '../api.js';
import Modal from './Modal.jsx';

export function CustomerBadge({ c }) {
  if (!c) return null;
  return (
    <span className="badges">
      {c.level_name && <span className="badge blue">{c.level_name}{c.level_pct == null ? ' (% not set)' : ''}</span>}
      {c.require_po && <span className="badge orange">PO required</span>}
      {c.charge_account && <span className="badge">Charge {money(c.balance_cents)} / {c.credit_limit_cents ? money(c.credit_limit_cents) : 'no limit'}</span>}
      {c.tax_exempt && <span className="badge green">Tax exempt</span>}
    </span>
  );
}

export default function CustomerPicker({ value, onChange, disabled }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => {
      api.get(`/customers?q=${encodeURIComponent(q)}`).then(setResults).catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q, open]);

  const saveNew = async (e) => {
    e.preventDefault();
    setErr('');
    try {
      const c = await api.post('/customers', adding);
      onChange(c);
      setAdding(null);
      setOpen(false);
    } catch (ex) {
      setErr(ex.message);
    }
  };

  if (value) {
    return (
      <div className="customer-chip">
        <div>
          <strong>{value.name}</strong>{value.company ? ` — ${value.company}` : ''}
          <div><CustomerBadge c={value} /></div>
        </div>
        {!disabled && <button className="btn small" onClick={() => onChange(null)}>Remove</button>}
      </div>
    );
  }
  return (
    <div className="customer-picker">
      <input
        placeholder="Customer: search name, company or phone"
        value={q}
        disabled={disabled}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 200)}
        onChange={(e) => setQ(e.target.value)}
      />
      {open && (
        <div className="dropdown">
          {results.map((c) => (
            <button key={c.id} className="dropdown-item" onMouseDown={() => { onChange(c); setQ(''); setOpen(false); }}>
              <strong>{c.name}</strong> {c.company && <span className="muted">{c.company}</span>} <span className="muted">{c.phone}</span>
              <CustomerBadge c={c} />
            </button>
          ))}
          <button className="dropdown-item add" onMouseDown={() => setAdding({ name: q, phone: '', email: '' })}>+ New customer{q ? ` "${q}"` : ''}</button>
        </div>
      )}
      {adding && (
        <Modal title="New customer" onClose={() => setAdding(null)}>
          <form className="stack" onSubmit={saveNew}>
            <label>Name<input autoFocus value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} /></label>
            <label>Company<input value={adding.company || ''} onChange={(e) => setAdding({ ...adding, company: e.target.value })} /></label>
            <label>Phone<input value={adding.phone} onChange={(e) => setAdding({ ...adding, phone: e.target.value })} /></label>
            <label>Email<input value={adding.email} onChange={(e) => setAdding({ ...adding, email: e.target.value })} /></label>
            <p className="muted small">Contractor pricing and charge accounts are set up by a manager on the Customers page.</p>
            {err && <p className="error">{err}</p>}
            <div className="row end"><button className="btn primary">Save customer</button></div>
          </form>
        </Modal>
      )}
    </div>
  );
}
