import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, money, fmtDate } from '../api.js';
import { useApproval } from '../components/Approval.jsx';
import Receipt from '../components/Receipt.jsx';
import Modal from '../components/Modal.jsx';

export default function Sales() {
  const { id } = useParams();
  const nav = useNavigate();
  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState({ q: '', from: '', to: '' });
  const [sale, setSale] = useState(null);
  const [err, setErr] = useState('');
  const { withApproval } = useApproval();

  const load = () => {
    const p = new URLSearchParams(Object.entries(filter).filter(([, v]) => v));
    if (/^\d+$/.test(filter.q)) { p.delete('q'); p.set('number', filter.q); }
    api.get(`/sales?${p}`).then(setRows).catch((e) => setErr(e.message));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (id) api.get(`/sales/${id}`).then(setSale).catch((e) => setErr(e.message));
    else setSale(null);
  }, [id]);

  const doVoid = async () => {
    const reason = window.prompt('Reason for voiding this sale?');
    if (reason === null) return;
    try {
      const s = await withApproval((token) => api.post(`/sales/${sale.id}/void`, { approval_token: token, reason }));
      setSale(s);
      load();
    } catch (e) {
      if (!e.canceled) setErr(e.message);
    }
  };

  return (
    <div className="page">
      <h1>Sales</h1>
      <form className="row wrap card" onSubmit={(e) => { e.preventDefault(); load(); }}>
        <input placeholder="Receipt #, customer, or PO" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />
        <label className="inline">From <input type="date" value={filter.from} onChange={(e) => setFilter({ ...filter, from: e.target.value })} /></label>
        <label className="inline">To <input type="date" value={filter.to} onChange={(e) => setFilter({ ...filter, to: e.target.value })} /></label>
        <button className="btn">Search</button>
      </form>
      {err && <p className="error">{err}</p>}
      <table className="grid clickable">
        <thead><tr><th>#</th><th>Date</th><th>Customer</th><th>PO / Job</th><th>Paid by</th><th>Cashier</th><th className="num">Total</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} onClick={() => nav(`/sales/${r.id}`)} className={r.status === 'voided' ? 'voided' : ''}>
              <td>{r.number}{r.kind === 'return' && <span className="badge orange">Return</span>}{r.status === 'voided' && <span className="badge">Voided</span>}</td>
              <td>{fmtDate(r.created_at)}</td>
              <td>{r.customer_name}{r.customer_company ? ` (${r.customer_company})` : ''}</td>
              <td>{r.po_number}</td>
              <td>{r.methods}</td>
              <td>{r.cashier}</td>
              <td className="num">{money(r.total_cents)}</td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={7} className="empty">No sales found</td></tr>}
        </tbody>
      </table>
      {sale && (
        <Modal title={`${sale.kind === 'return' ? 'Return' : 'Sale'} #${sale.number}`} onClose={() => nav('/sales')}
          footer={<div className="row between">
            {sale.status === 'completed' && sale.kind === 'sale' ? <button className="btn danger" onClick={doVoid}>Void sale</button> : <span />}
            <button className="btn primary" onClick={() => window.print()}>Print</button>
          </div>}>
          <Receipt sale={sale} />
        </Modal>
      )}
    </div>
  );
}
