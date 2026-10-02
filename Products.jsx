import { useEffect, useState } from 'react';
import { api, money, toCents, qtyFmt, fmtDate } from '../api.js';
import { useSession, isManager } from '../session.jsx';
import Modal from '../components/Modal.jsx';

const SOURCES = { manual: 'Manual', import: 'Import', category_margin: 'Margin change', price_agent: 'Price agent' };

export default function Products() {
  const { user } = useSession();
  const mgr = isManager(user);
  const [q, setQ] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [lowStock, setLowStock] = useState(false);
  const [review, setReview] = useState(false);
  const [data, setData] = useState({ items: [], total: 0 });
  const [cats, setCats] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [editing, setEditing] = useState(null);

  const load = () => {
    const p = new URLSearchParams({ q, limit: '100' });
    if (categoryId) p.set('category_id', categoryId);
    if (lowStock) p.set('low_stock', '1');
    if (review) p.set('needs_review', '1');
    api.get(`/products?${p}`).then(setData);
  };
  useEffect(() => {
    api.get('/admin/categories').then(setCats);
    api.get('/admin/vendors').then(setVendors);
  }, []);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [q, categoryId, lowStock, review]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = async (id) => setEditing(await api.get(`/products/${id}`));

  return (
    <div className="page">
      <div className="row between">
        <h1>Products <span className="muted">({data.total})</span></h1>
        {mgr && <button className="btn primary" onClick={() => setEditing({ sku: '', description: '', cost_cents: 0, taxable: true, unit: 'EA', active: true })}>New product</button>}
      </div>
      <div className="row wrap card">
        <input className="grow" autoFocus placeholder="Search SKU, UPC, vendor part or description" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">All categories</option>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={lowStock} onChange={(e) => setLowStock(e.target.checked)} /> Needs reorder</label>
        <label className="check"><input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} /> Needs review</label>
      </div>
      <table className="grid clickable">
        <thead><tr><th>SKU</th><th>Description</th><th>Category</th><th className="num">Cost</th><th className="num">Retail</th><th className="num">Margin</th><th className="num">On hand</th></tr></thead>
        <tbody>
          {data.items.map((p) => (
            <tr key={p.id} onClick={() => open(p.id)}>
              <td className="sku">{p.sku}</td>
              <td>{p.description}{p.description2 && <div className="muted small">{p.description2}</div>}
                {p.price_override && <span className="badge orange">Manual price</span>}{p.needs_review && <span className="badge red">{p.needs_review}</span>}</td>
              <td>{p.category}</td>
              <td className="num">{money(p.cost_cents)}</td>
              <td className="num">{money(p.retail_cents)}</td>
              <td className="num">{p.retail_cents ? `${Math.round(((p.retail_cents - p.cost_cents) / p.retail_cents) * 1000) / 10}%` : ''}</td>
              <td className={`num ${p.reorder_point != null && p.on_hand <= p.reorder_point ? 'error' : ''}`}>{qtyFmt(p.on_hand)} {p.unit}</td>
            </tr>
          ))}
          {!data.items.length && <tr><td colSpan={7} className="empty">No products found</td></tr>}
        </tbody>
      </table>
      {editing && <ProductEditor product={editing} cats={cats} vendors={vendors} canEdit={mgr} onClose={() => setEditing(null)} onSaved={(p) => { load(); if (p) open(p.id); else setEditing(null); }} />}
    </div>
  );
}

function ProductEditor({ product, cats, vendors, canEdit, onClose, onSaved }) {
  const { settings } = useSession();
  const isNew = !product.id;
  const [f, setF] = useState({
    ...product,
    cost: (product.cost_cents / 100).toFixed(2),
    retail: product.retail_cents != null ? (product.retail_cents / 100).toFixed(2) : '',
  });
  const [err, setErr] = useState('');
  const [stock, setStock] = useState({ mode: 'receive', qty: '', ref: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  // Live preview of the margin rule.
  const cat = cats.find((c) => String(c.id) === String(f.category_id));
  const catMargin = cat ? Number(cat.margin_pct) : Number(settings?.default_margin_pct ?? 35);
  const itemMargin = f.target_margin_pct === '' || f.target_margin_pct == null ? null : Number(f.target_margin_pct);
  const margin = itemMargin ?? catMargin;
  const marginSource = itemMargin != null ? 'item margin' : cat ? `${cat.name} margin` : 'default margin';
  const costC = toCents(f.cost) ?? 0;
  const inc = settings?.price_rounding_cents || 5;
  const calc = Math.round(costC / (1 - margin / 100) / inc) * inc;
  // Unchanged pricing inputs keep today's exact price (imported prices aren't re-rounded).
  const inputsChanged = isNew || costC !== product.cost_cents || String(f.category_id || '') !== String(product.category_id || '')
    || String(itemMargin ?? '') !== String(product.target_margin_pct ?? '') || !!f.price_override !== !!product.price_override;
  const shownRetail = f.price_override ? toCents(f.retail) ?? 0 : inputsChanged ? calc : product.retail_cents;

  const save = async (e) => {
    e.preventDefault();
    setErr('');
    const body = {
      sku: f.sku, upc: f.upc || null, description: f.description,
      category_id: f.category_id ? Number(f.category_id) : null, vendor_id: f.vendor_id ? Number(f.vendor_id) : null,
      vendor_sku: f.vendor_sku || null, unit: f.unit || 'EA', cost_cents: costC,
      price_override: !!f.price_override, retail_cents: f.price_override ? toCents(f.retail) : null,
      taxable: !!f.taxable, active: !!f.active, location: f.location || null,
      target_margin_pct: itemMargin, description2: f.description2 || null, needs_review: f.needs_review || null,
      reorder_point: f.reorder_point === '' || f.reorder_point == null ? null : Number(f.reorder_point),
      reorder_qty: f.reorder_qty === '' || f.reorder_qty == null ? null : Number(f.reorder_qty),
    };
    if (isNew) body.on_hand = Number(f.on_hand) || 0;
    try {
      const p = isNew ? await api.post('/products', body) : await api.put(`/products/${product.id}`, body);
      onSaved(p);
    } catch (ex) {
      setErr(ex.message);
    }
  };

  const adjust = async (e) => {
    e.preventDefault();
    setErr('');
    try {
      await api.post(`/products/${product.id}/adjust`, { mode: stock.mode, qty: Number(stock.qty), ref: stock.ref || undefined });
      setStock({ mode: 'receive', qty: '', ref: '' });
      onSaved(product);
    } catch (ex) {
      setErr(ex.message);
    }
  };

  const ro = !canEdit;
  return (
    <Modal title={isNew ? 'New product' : `${product.sku} — ${product.description}`} onClose={onClose} wide>
      <form className="stack" onSubmit={save}>
        <fieldset disabled={ro} className="form-grid">
          <label>SKU / Part #<input value={f.sku} onChange={set('sku')} required /></label>
          <label>UPC / Barcode<input value={f.upc || ''} onChange={set('upc')} /></label>
          <label className="span2">Description<input value={f.description} onChange={set('description')} required /></label>
          <label className="span2">Description 2<input value={f.description2 || ''} onChange={set('description2')} /></label>
          <label>Category
            <select value={f.category_id || ''} onChange={set('category_id')}>
              <option value="">— none (default {settings?.default_margin_pct}%) —</option>
              {cats.map((c) => <option key={c.id} value={c.id}>{c.name} ({Number(c.margin_pct)}%)</option>)}
            </select>
          </label>
          <label>Vendor
            <select value={f.vendor_id || ''} onChange={set('vendor_id')}>
              <option value="">—</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </label>
          <label>Vendor part #<input value={f.vendor_sku || ''} onChange={set('vendor_sku')} /></label>
          <label>Unit<input value={f.unit || ''} onChange={set('unit')} /></label>
          <label>Cost<input inputMode="decimal" value={f.cost} onChange={set('cost')} /></label>
          <label>Retail price
            <input inputMode="decimal" value={f.price_override ? f.retail : (shownRetail / 100).toFixed(2)} disabled={!f.price_override} onChange={set('retail')} />
          </label>
          <label>Item margin % (blank = use category {catMargin}%)
            <input type="number" step="0.001" value={f.target_margin_pct ?? ''} disabled={!!f.price_override} onChange={set('target_margin_pct')} />
          </label>
          <label className="check span2"><input type="checkbox" checked={!!f.price_override} onChange={set('price_override')} />
            Set price by hand (ignore margins and the price agent)</label>
          <div className="span2 notice info">
            Retail {money(shownRetail)} · actual margin {shownRetail ? Math.round(((shownRetail - costC) / shownRetail) * 1000) / 10 : 0}%
            {!f.price_override && <> · priced from {marginSource} ({margin}%)</>}
          </div>
          <label>Location / bin<input value={f.location || ''} onChange={set('location')} /></label>
          {isNew && <label>Starting on hand<input type="number" step="any" value={f.on_hand ?? ''} onChange={set('on_hand')} /></label>}
          <label>Reorder when at or below<input type="number" step="any" value={f.reorder_point ?? ''} onChange={set('reorder_point')} /></label>
          <label>Reorder quantity<input type="number" step="any" value={f.reorder_qty ?? ''} onChange={set('reorder_qty')} /></label>
          <label className="check"><input type="checkbox" checked={!!f.taxable} onChange={set('taxable')} /> Taxable</label>
          <label className="check"><input type="checkbox" checked={!!f.active} onChange={set('active')} /> Active</label>
        </fieldset>
        {f.needs_review && (
          <div className="notice warn row between">
            <span>Needs review: {f.needs_review}</span>
            {canEdit && <button type="button" className="btn small" onClick={() => setF({ ...f, needs_review: null })}>Mark reviewed</button>}
          </div>
        )}
        {err && <p className="error">{err}</p>}
        {canEdit && <div className="row end"><button className="btn primary">{isNew ? 'Create product' : 'Save changes'}</button></div>}
      </form>

      {!isNew && (
        <>
          <hr />
          <h3>Stock — {qtyFmt(product.on_hand)} {product.unit} on hand</h3>
          {canEdit && (
            <form className="row wrap" onSubmit={adjust}>
              <select value={stock.mode} onChange={(e) => setStock({ ...stock, mode: e.target.value })}>
                <option value="receive">Receive (+)</option>
                <option value="adjust">Adjust (+/−)</option>
                <option value="set">Set count to</option>
              </select>
              <input type="number" step="any" placeholder="Qty" value={stock.qty} onChange={(e) => setStock({ ...stock, qty: e.target.value })} required />
              <input placeholder="Reference (PO, reason)" value={stock.ref} onChange={(e) => setStock({ ...stock, ref: e.target.value })} />
              <button className="btn">Update stock</button>
            </form>
          )}
          <div className="two-col">
            <div>
              <h4>Price history</h4>
              <table className="grid small">
                <tbody>
                  {product.history.map((h) => (
                    <tr key={h.id}><td>{fmtDate(h.created_at)}</td><td>{SOURCES[h.source] || h.source}</td>
                      <td className="num">{money(h.old_cost_cents)} → {money(h.new_cost_cents)}</td>
                      <td className="num">{money(h.old_retail_cents)} → {money(h.new_retail_cents)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <h4>Stock movements</h4>
              <table className="grid small">
                <tbody>
                  {product.movements.map((m) => (
                    <tr key={m.id}><td>{fmtDate(m.created_at)}</td><td>{m.reason}</td><td>{m.ref}</td><td className="num">{m.qty_change > 0 ? '+' : ''}{qtyFmt(m.qty_change)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}
