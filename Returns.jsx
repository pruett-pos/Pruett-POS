import { useState } from 'react';
import { api, money, qtyFmt, registerConfig } from '../api.js';
import { useApproval } from '../components/Approval.jsx';
import Receipt from '../components/Receipt.jsx';
import Modal from '../components/Modal.jsx';
import CustomerPicker from '../components/CustomerPicker.jsx';

export default function Returns() {
  const [number, setNumber] = useState('');
  const [sale, setSale] = useState(null);
  const [qtys, setQtys] = useState({});
  const [method, setMethod] = useState('cash');
  const [restock, setRestock] = useState(true);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null);
  const [noReceipt, setNoReceipt] = useState(null); // { customer, items: [{product, qty}] }
  const [search, setSearch] = useState('');
  const { withApproval } = useApproval();

  const find = async (e) => {
    e.preventDefault();
    setErr('');
    setSale(null);
    try {
      const s = await api.get(`/sales/number/${encodeURIComponent(number.trim().replace(/^#/, ''))}`);
      if (s.kind !== 'sale') throw new Error('That receipt is a return');
      if (s.status === 'voided') throw new Error('That sale was voided');
      setSale(s);
      setQtys({});
      setMethod('original');
    } catch (ex) {
      setErr(ex.message);
    }
  };

  const submit = async () => {
    setErr('');
    try {
      const body = noReceipt
        ? { customer_id: noReceipt.customer?.id ?? null, lines: noReceipt.items.map((i) => ({ product_id: i.product.id, qty: Number(i.qty) })) }
        : { original_sale_id: sale.id, lines: Object.entries(qtys).filter(([, q]) => Number(q) > 0).map(([id, q]) => ({ original_line_id: Number(id), qty: Number(q) })) };
      const r = await withApproval((token) => api.post('/sales/returns', { ...body, refund_method: method, restock, approval_token: token, register: registerConfig.get().name || null }));
      setDone(r);
      setSale(null);
      setNoReceipt(null);
      setNumber('');
    } catch (ex) {
      if (!ex.canceled) setErr(ex.message);
    }
  };

  const addNoReceiptItem = async (e) => {
    e.preventDefault();
    if (!search.trim()) return;
    try {
      const p = await api.get(`/products/lookup/${encodeURIComponent(search.trim())}`);
      setNoReceipt((n) => ({ ...n, items: [...n.items, { product: p, qty: 1 }] }));
      setSearch('');
    } catch (ex) {
      setErr(ex.message);
    }
  };

  const selectedTotal = sale ? sale.lines.reduce((s, l) => s + Math.round((Number(qtys[l.id]) || 0) * l.unit_price_cents), 0) : 0;
  const cardOnSale = sale?.payments.some((p) => p.method === 'card');

  return (
    <div className="page narrow">
      <h1>Returns</h1>
      {!sale && !noReceipt && (
        <div className="card stack">
          <form className="row" onSubmit={find}>
            <label className="grow">Receipt number<input autoFocus value={number} onChange={(e) => setNumber(e.target.value)} placeholder="e.g. 100123" /></label>
            <button className="btn primary">Find receipt</button>
          </form>
          <p className="muted">No receipt? <button className="link" onClick={() => { setNoReceipt({ customer: null, items: [] }); setMethod('cash'); }}>Return without a receipt</button> (manager approval, refunds at today's price)</p>
        </div>
      )}

      {sale && (
        <div className="card stack">
          <div className="row between">
            <h2>Receipt #{sale.number} · {new Date(sale.completed_at).toLocaleDateString()}</h2>
            <button className="btn small" onClick={() => setSale(null)}>Back</button>
          </div>
          {sale.customer_name && <p>Customer: {sale.customer_name}</p>}
          <table className="grid">
            <thead><tr><th>Item</th><th className="num">Sold</th><th className="num">Returned</th><th className="num">Price</th><th className="num">Return qty</th></tr></thead>
            <tbody>
              {sale.lines.map((l) => {
                const left = Number(l.qty) - Number(l.returned_qty);
                return (
                  <tr key={l.id}>
                    <td>{l.description}<div className="muted small">{l.sku}</div></td>
                    <td className="num">{qtyFmt(l.qty)}</td>
                    <td className="num">{qtyFmt(l.returned_qty)}</td>
                    <td className="num">{money(l.unit_price_cents)}</td>
                    <td className="num">
                      <input className="qty" type="number" min="0" max={left} step="any" disabled={left <= 0} value={qtys[l.id] ?? ''}
                        onChange={(e) => setQtys({ ...qtys, [l.id]: e.target.value })} />
                      {left > 0 && <button className="link small" onClick={() => setQtys({ ...qtys, [l.id]: left })}>all</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <RefundOptions method={method} setMethod={setMethod} restock={restock} setRestock={setRestock}
            allowCard={cardOnSale} allowCharge={sale.payments.some((p) => p.method === 'charge')} allowOriginal />
          <div className="row between">
            <span>Refund before tax: <strong>{money(selectedTotal)}</strong> <span className="muted">(tax added at original rate)</span></span>
            <button className="btn primary" disabled={!selectedTotal} onClick={submit}>Process return</button>
          </div>
        </div>
      )}

      {noReceipt && (
        <div className="card stack">
          <div className="row between"><h2>Return without receipt</h2><button className="btn small" onClick={() => setNoReceipt(null)}>Back</button></div>
          <CustomerPicker value={noReceipt.customer} onChange={(c) => setNoReceipt({ ...noReceipt, customer: c })} />
          <form className="row" onSubmit={addNoReceiptItem}>
            <input className="grow" placeholder="Scan or type SKU" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
            <button className="btn">Add</button>
          </form>
          <table className="grid">
            <tbody>
              {noReceipt.items.map((i, idx) => (
                <tr key={idx}>
                  <td>{i.product.description}<div className="muted small">{i.product.sku}</div></td>
                  <td className="num"><input className="qty" type="number" min="0" step="any" value={i.qty}
                    onChange={(e) => setNoReceipt({ ...noReceipt, items: noReceipt.items.map((x, j) => (j === idx ? { ...x, qty: e.target.value } : x)) })} /></td>
                  <td><button className="icon-btn" onClick={() => setNoReceipt({ ...noReceipt, items: noReceipt.items.filter((_, j) => j !== idx) })}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <RefundOptions method={method} setMethod={setMethod} restock={restock} setRestock={setRestock} allowCard={false} allowCharge={!!noReceipt.customer?.charge_account} />
          <div className="row end"><button className="btn primary" disabled={!noReceipt.items.length} onClick={submit}>Process return</button></div>
        </div>
      )}

      {err && <p className="error">{err}</p>}

      {done && (
        <Modal title={`Return #${done.number} complete`} onClose={() => setDone(null)}
          footer={<div className="row end"><button className="btn" onClick={() => window.print()}>Print receipt</button><button className="btn primary" onClick={() => setDone(null)}>Done</button></div>}>
          <div className="change-due">Refund {money(-done.total_cents)} — {done.payments.map((p) => p.method).join(', ')}</div>
          <Receipt sale={done} />
        </Modal>
      )}
    </div>
  );
}

function RefundOptions({ method, setMethod, restock, setRestock, allowCard, allowCharge, allowOriginal }) {
  return (
    <div className="row wrap">
      <span>Refund to:</span>
      {[...(allowOriginal ? ['original'] : []), 'cash', 'card', 'check', 'charge'].map((m) => (
        <label key={m} className="check">
          <input type="radio" name="refund" checked={method === m} disabled={(m === 'card' && !allowCard) || (m === 'charge' && !allowCharge)}
            onChange={() => setMethod(m)} />
          {m === 'original' ? 'Same as paid' : m === 'card' ? 'Original card' : m === 'charge' ? 'Charge account credit' : m[0].toUpperCase() + m.slice(1)}
        </label>
      ))}
      <label className="check"><input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} /> Put back in stock</label>
    </div>
  );
}
