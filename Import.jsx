import { useState } from 'react';
import { api, money } from '../api.js';

const LABELS = {
  sku: 'Part number / SKU *', description: 'Description *', description2: 'Description 2', alt_code: 'Alternate part # (scans too)', upc: 'UPC / barcode', cost: 'Cost', retail: 'Retail price (Paladin)',
  on_hand: 'Quantity on hand', category: 'Department / category', vendor: 'Vendor', vendor_sku: 'Vendor part #', unit: 'Unit of measure',
  reorder_point: 'Min (reorder point)', max_qty: 'Max', location: 'Location / bin', taxable: 'Taxable',
};

function ProductImport() {
  const [staged, setStaged] = useState(null);
  const [mapping, setMapping] = useState({});
  const [options, setOptions] = useState({ priceMode: 'keep', updateOnHand: false });
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const upload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setErr(''); setPreview(null); setResult(null); setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const s = await api.post('/products/import/upload', fd);
      setStaged(s);
      setMapping(s.mapping);
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  };

  const run = async (commit) => {
    setErr(''); setBusy(true);
    try {
      const r = await api.post(`/products/import/${commit ? 'commit' : 'preview'}`, { importId: staged.importId, mapping, options });
      if (commit) { setResult(r); setStaged(null); setPreview(null); } else setPreview(r);
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  };

  const setMap = (k, v) => { setMapping({ ...mapping, [k]: v === '' ? null : Number(v) }); setPreview(null); };

  return (
    <>
      <div className="card stack">
        <p>Export your item list from Paladin (or any spreadsheet) as <strong>.csv</strong> or <strong>.xlsx</strong> and upload it here.
          Existing items are matched by part number and updated; new ones are added.</p>
        <input type="file" accept=".csv,.xlsx,.txt,.tsv" onChange={upload} disabled={busy} />
      </div>
      {err && <p className="error">{err}</p>}

      {result && (
        <div className="card notice ok">
          Import complete: {result.created} added, {result.updated} updated, {result.errors.length} skipped with errors,
          {' '}{result.review.length} flagged for review (Products → Needs review).
          {result.newCategories.length > 0 && <> New categories created at the default margin: {result.newCategories.join(', ')} — set their margins in Settings.</>}
        </div>
      )}

      {staged && (
        <>
          <div className="card stack">
            <h2>1. Match the columns</h2>
            <p className="muted">{staged.rowCount} rows found. We guessed the columns — check them.</p>
            <div className="form-grid">
              {Object.keys(LABELS).map((k) => (
                <label key={k}>{LABELS[k]}
                  <select value={mapping[k] ?? ''} onChange={(e) => setMap(k, e.target.value)}>
                    <option value="">— not in file —</option>
                    {staged.headers.map((h, i) => <option key={i} value={i}>{h}{staged.sample[0]?.[i] ? ` (e.g. ${String(staged.sample[0][i]).slice(0, 24)})` : ''}</option>)}
                  </select>
                </label>
              ))}
            </div>
          </div>
          <div className="card stack">
            <h2>2. Pricing</h2>
            <label className="check"><input type="radio" checked={options.priceMode === 'keep'} onChange={() => { setOptions({ ...options, priceMode: 'keep' }); setPreview(null); }} />
              Keep current prices — each item's current margin becomes its target (recommended)</label>
            <label className="check"><input type="radio" checked={options.priceMode === 'margin'} onChange={() => { setOptions({ ...options, priceMode: 'margin' }); setPreview(null); }} />
              Recalculate retail from cost and category margin</label>
            <label className="check"><input type="checkbox" checked={options.updateOnHand} onChange={(e) => { setOptions({ ...options, updateOnHand: e.target.checked }); setPreview(null); }} />
              Overwrite on-hand counts for items already in the POS</label>
            <div className="row"><button className="btn primary" disabled={busy} onClick={() => run(false)}>Preview import</button></div>
          </div>
        </>
      )}

      {preview && (
        <div className="card stack">
          <h2>3. Review</h2>
          <div className="stats">
            <div><span>New items</span><strong>{preview.created}</strong></div>
            <div><span>Updated items</span><strong>{preview.updated}</strong></div>
            <div><span>Errors</span><strong>{preview.errors.length}</strong></div>
            <div><span>Price changes vs Paladin</span><strong>{preview.priceChanges}</strong></div>
            <div><span>Flagged for review</span><strong>{preview.review.length}</strong></div>
          </div>
          {preview.review.length > 0 && (
            <details><summary>{preview.review.length} items will import and go on the review list</summary>
              <table className="grid small">
                <thead><tr><th>SKU</th><th>Description</th><th>Reason</th><th className="num">Cost</th><th className="num">Price</th></tr></thead>
                <tbody>{preview.review.map((r) => <tr key={r.sku}><td>{r.sku}</td><td>{r.description}</td><td>{r.reason}</td><td className="num">{money(r.cost_cents)}</td><td className="num">{money(r.price_cents)}</td></tr>)}</tbody>
              </table>
            </details>
          )}
          {preview.warnings?.length > 0 && (
            <details><summary>{preview.warnings.length} warnings</summary>
              <table className="grid small"><tbody>{preview.warnings.map((w, i) => <tr key={i}><td>Row {w.row}</td><td>{w.sku}</td><td>{w.warning}</td></tr>)}</tbody></table>
            </details>
          )}
          {preview.newCategories.length > 0 && <p className="notice warn">New categories (will use default margin until you set them): {preview.newCategories.join(', ')}</p>}
          {preview.errors.length > 0 && (
            <details><summary>{preview.errors.length} rows will be skipped</summary>
              <table className="grid small"><tbody>{preview.errors.slice(0, 200).map((e, i) => <tr key={i}><td>Row {e.row}</td><td>{e.sku}</td><td>{e.error}</td></tr>)}</tbody></table>
            </details>
          )}
          {preview.priceImpact.length > 0 && (
            <details open><summary>Biggest price differences (new POS price vs Paladin price)</summary>
              <table className="grid small">
                <thead><tr><th>SKU</th><th>Description</th><th className="num">Cost</th><th className="num">Paladin</th><th className="num">New</th><th className="num">Margin</th></tr></thead>
                <tbody>
                  {preview.priceImpact.slice(0, 100).map((p) => (
                    <tr key={p.sku}><td>{p.sku}</td><td>{p.description}</td><td className="num">{money(p.cost_cents)}</td>
                      <td className="num">{money(p.paladin_retail_cents)}</td><td className="num">{money(p.new_retail_cents)}</td>
                      <td className="num">{p.paladin_margin}% → {p.new_margin}%</td></tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
          <div className="row end"><button className="btn primary big" disabled={busy} onClick={() => run(true)}>Import {preview.created + preview.updated} items</button></div>
        </div>
      )}
    </>
  );
}

export default function Import() {
  const [tab, setTab] = useState('Products');
  return (
    <div className="page">
      <h1>Import</h1>
      <div className="tabs">{['Products', 'Customers'].map((t) => <button key={t} className={t === tab ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>)}</div>
      {tab === 'Products' ? <ProductImport /> : <CustomerImport />}
    </div>
  );
}

function CustomerImport() {
  const [staged, setStaged] = useState(null);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const upload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setErr(''); setResult(null); setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      setStaged(await api.post('/customers/import/upload', fd));
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); e.target.value = ''; }
  };
  const commit = async () => {
    setBusy(true); setErr('');
    try { setResult(await api.post('/customers/import/commit', { importId: staged.importId })); setStaged(null); }
    catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };
  const p = staged?.preview;
  return (
    <>
      <div className="card stack">
        <p>Upload Paladin's customer export (.xlsx or .csv). Customers are matched by their Paladin account Id, so you can re-import safely.
          Pricing plans, credit limits, tax-exempt status, "require PO" and checkout notes come across.
          <strong> Open balances are not imported now</strong> — they are loaded on go-live day.</p>
        <input type="file" accept=".csv,.xlsx" onChange={upload} disabled={busy} />
      </div>
      {err && <p className="error">{err}</p>}
      {result && <div className="card notice ok">Customer import complete: {result.created} added, {result.updated} updated, {result.skipped.length} skipped.</div>}
      {p && (
        <div className="card stack">
          <h2>Review</h2>
          <div className="stats">
            <div><span>New customers</span><strong>{p.created}</strong></div>
            <div><span>Updated</span><strong>{p.updated}</strong></div>
            <div><span>Skipped</span><strong>{p.skipped.length}</strong></div>
            <div><span>Tax exempt</span><strong>{p.taxExempt.length}</strong></div>
          </div>
          <table className="grid small">
            <thead><tr><th>Price level</th><th className="num">Customers</th></tr></thead>
            <tbody>{Object.entries(p.byPlan).sort((a, b) => b[1] - a[1]).map(([k, v]) => <tr key={k}><td>{k}</td><td className="num">{v}</td></tr>)}</tbody>
          </table>
          {p.newPlans.length > 0 && <p className="notice warn">New price levels will be created (set their % in Settings → Price levels): {p.newPlans.join(', ')}</p>}
          <details><summary>Skipped ({p.skipped.length})</summary>
            <table className="grid small"><tbody>{p.skipped.map((x, i) => <tr key={i}><td>{x.name}</td><td>{x.reason}</td></tr>)}</tbody></table>
          </details>
          <details><summary>Tax exempt ({p.taxExempt.length}) — exemption certificate numbers need to be added</summary>
            <p className="small">{p.taxExempt.join(', ')}</p>
          </details>
          {p.warnings.length > 0 && (
            <details><summary>Warnings ({p.warnings.length})</summary>
              <table className="grid small"><tbody>{p.warnings.map((w, i) => <tr key={i}><td>{w.name}</td><td>{w.warning}</td></tr>)}</tbody></table>
            </details>
          )}
          <details><summary>Open balances in this file (not imported): {money(p.openBalanceTotal)} across {p.openBalances.length} accounts</summary>
            <table className="grid small"><tbody>{p.openBalances.map((b) => <tr key={b.name}><td>{b.name}</td><td className="num">{money(b.balance_cents)}</td></tr>)}</tbody></table>
          </details>
          <div className="row end"><button className="btn primary big" disabled={busy} onClick={commit}>Import {p.created + p.updated} customers</button></div>
        </div>
      )}
    </>
  );
}
