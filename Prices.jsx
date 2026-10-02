import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, money, fmtDate } from '../api.js';
import Modal from '../components/Modal.jsx';

const FLAG = {
  large_change: ['Big change', 'orange', 'Cost moves more than the alert % set in Settings'],
  check_unit: ['Check unit / pack', 'red', 'New cost is less than half or almost double the current cost — likely a carton vs. piece mix-up or wrong item'],
  check_match: ['Check match', 'red', 'Part numbers line up but the descriptions don\'t'],
  confirm_match: ['Matched by description', 'orange', 'Vendor number differs from Pruett\'s — confirm it is the same item'],
  decrease: ['Price drop', 'blue', 'Vendor cost went down'],
  manual_price: ['Manual price', '', 'Cost will update but the retail price stays as set by hand'],
  item_needs_review: ['Item on review list', '', 'This item is on the Needs review list'],
  no_current_cost: ['No current cost', 'orange', 'Item had no cost, so the price column could not be checked'],
  ai_verified: ['AI checked: same item', 'green', 'Claude compared the vendor line and the Pruett item and confirmed they are the same product'],
  old_sheet: ['Old sheet', 'red', 'This price sheet is more than a year old'],
};
const DOUBTFUL = new Set(['check_unit', 'check_match', 'confirm_match', 'old_sheet', 'no_current_cost']);
const STATUS = { pending: 'Waiting for approval', partially_approved: 'Partly approved', approved: 'Approved', rejected: 'Rejected', scheduled: 'Approved — waiting for effective date', empty: 'No changes' };
const pct = (a, b) => (b ? `${a >= b ? '+' : ''}${(((a - b) / b) * 100).toFixed(1)}%` : '');

export default function Prices() {
  const { id } = useParams();
  return id ? <BatchDetail id={id} /> : <PricesHome />;
}

function PricesHome() {
  const [status, setStatus] = useState(null);
  const [batches, setBatches] = useState([]);
  const [docs, setDocs] = useState([]);
  const [msg, setMsg] = useState(null);
  const [notice, setNotice] = useState(null);
  const fileRef = useRef(null);
  const nav = useNavigate();

  const load = () => {
    api.get('/prices/status').then(setStatus);
    api.get('/prices/batches').then(setBatches);
    api.get('/prices/documents').then(setDocs);
  };
  useEffect(() => { load(); }, []);
  // Refresh while documents are being read.
  useEffect(() => {
    if (!docs.some((d) => d.status === 'received' || d.status === 'extracted')) return undefined;
    const t = setTimeout(load, 4000);
    return () => clearTimeout(t);
  }, [docs]);

  const upload = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      await api.post('/prices/upload', fd);
      setMsg({ type: 'ok', text: `Reading "${file.name}"… large price lists take a minute or two.` });
      load();
    } catch (ex) { setMsg({ type: 'error', text: ex.message }); }
  };
  const checkInbox = async () => {
    try {
      const r = await api.post('/prices/check-inbox');
      setMsg({ type: 'ok', text: r.queued ? `${r.queued} new document(s) found` : 'No new vendor emails' });
      load();
    } catch (ex) { setMsg({ type: 'error', text: ex.message }); }
  };
  const retry = async (d) => { await api.post(`/prices/documents/${d.id}/retry`); load(); };

  return (
    <div className="page">
      <div className="row between">
        <h1>Price Updates</h1>
        <div className="row">
          <input ref={fileRef} type="file" accept=".pdf,.xlsx,.csv,.png,.jpg,.jpeg" hidden onChange={upload} />
          <button className="btn" onClick={() => setNotice({ vendor_name: '', product_line: '', pct: '', effective_date: '' })}>Enter % increase</button>
          {status?.inboxConfigured && <button className="btn" onClick={checkInbox}>Check inbox now</button>}
          <button className="btn primary" onClick={() => fileRef.current.click()}>Upload price sheet</button>
        </div>
      </div>
      {status && (
        <div className="row wrap small" style={{ marginBottom: 12 }}>
          <span className={`badge ${status.aiConfigured ? 'green' : 'red'}`}>{status.aiConfigured ? 'AI reader ready' : 'AI reader not set up (ANTHROPIC_API_KEY)'}</span>
          <span className={`badge ${status.inboxConfigured ? 'green' : 'orange'}`}>{status.inboxConfigured ? `Watching ${status.inbox}` : 'Inbox not connected — upload sheets by hand'}</span>
          {status.notify?.length > 0 && <span className="badge">Alerts to {status.notify.join(', ')}</span>}
        </div>
      )}
      {msg && <div className={`notice ${msg.type}`} onClick={() => setMsg(null)}>{msg.text}</div>}

      <h2 style={{ margin: '16px 0 8px' }}>Batches</h2>
      <table className="grid clickable">
        <thead><tr><th>Received</th><th>Vendor</th><th>From</th><th>Effective</th><th className="num">Changes</th><th className="num">To review</th><th>Status</th></tr></thead>
        <tbody>
          {batches.map((b) => (
            <tr key={b.id} onClick={() => nav(`/prices/${b.id}`)}>
              <td>{fmtDate(b.created_at)}</td>
              <td>{b.vendor}{b.kind === 'percent' && <span className="badge">% notice</span>}</td>
              <td className="small">{b.filename || b.subject}</td>
              <td>{b.effective_date ? new Date(b.effective_date).toLocaleDateString('en-US', { timeZone: 'UTC' }) : ''}</td>
              <td className="num">{b.items}</td>
              <td className="num">{b.pending > 0 ? <>{b.pending}{b.flagged > 0 && <span className="badge orange">{b.flagged} flagged</span>}</> : ''}</td>
              <td>{STATUS[b.status] || b.status}</td>
            </tr>
          ))}
          {!batches.length && <tr><td colSpan={7} className="empty">No price updates yet. Upload a vendor price sheet to start.</td></tr>}
        </tbody>
      </table>

      <h2 style={{ margin: '20px 0 8px' }}>Documents received</h2>
      <table className="grid small">
        <thead><tr><th>Received</th><th>From</th><th>File</th><th>Type</th><th className="num">Lines</th><th>Status</th><th /></tr></thead>
        <tbody>
          {docs.map((d) => (
            <tr key={d.id}>
              <td>{fmtDate(d.received_at)}</td>
              <td>{d.vendor || d.sender || (d.source === 'upload' ? 'Uploaded' : '')}</td>
              <td>{d.filename && d.filename !== '(email body)' && d.filename !== '(entered by hand)'
                ? <a href={`/api/prices/documents/${d.id}/file`} target="_blank" rel="noreferrer">{d.filename}</a> : d.filename}
                {d.subject && <div className="muted">{d.subject}</div>}</td>
              <td>{(d.document_type || '').replace('_', ' ')}</td>
              <td className="num">{d.lines || ''}</td>
              <td>
                {d.status === 'failed' ? <span className="error">Failed: {d.error}</span>
                  : d.status === 'ignored' ? <span className="muted">Not a price document</span>
                    : d.status === 'received' || d.status === 'extracted' ? <span>Reading…</span>
                      : d.batch_id ? <Link to={`/prices/${d.batch_id}`}>Batch #{d.batch_id}</Link> : d.status}
              </td>
              <td>{d.status === 'failed' && <button className="btn small" onClick={() => retry(d)}>Retry</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {notice && (
        <Modal title="Enter a % price change" onClose={() => setNotice(null)}>
          <form className="stack" onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api.post('/prices/notice', { ...notice, pct: Number(notice.pct), effective_date: notice.effective_date || null });
              setNotice(null);
              setMsg({ type: 'ok', text: 'Building the batch…' });
              setTimeout(load, 800);
            } catch (ex) { setMsg({ type: 'error', text: ex.message }); }
          }}>
            <p className="muted">For vendor emails like "+6% on vinyl siding effective 8/10". Applies to items already tied to that vendor.</p>
            <label>Vendor<input value={notice.vendor_name} onChange={(e) => setNotice({ ...notice, vendor_name: e.target.value })} required /></label>
            <label>Product line (optional)<input value={notice.product_line} onChange={(e) => setNotice({ ...notice, product_line: e.target.value })} placeholder="Vinyl siding, soffit and accessories" /></label>
            <div className="row">
              <label>Change %<input type="number" step="0.1" value={notice.pct} onChange={(e) => setNotice({ ...notice, pct: e.target.value })} required /></label>
              <label>Effective date<input type="date" value={notice.effective_date} onChange={(e) => setNotice({ ...notice, effective_date: e.target.value })} /></label>
            </div>
            <div className="row end"><button className="btn primary">Create batch</button></div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function BatchDetail({ id }) {
  const [b, setB] = useState(null);
  const [sel, setSel] = useState(new Set());
  const [filter, setFilter] = useState('pending');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async (resetSel = false) => {
    const data = await api.get(`/prices/batches/${id}`);
    setB(data);
    if (resetSel) {
      // Pre-select the clean changes; doubtful ones need a deliberate tick.
      setSel(new Set(data.items.filter((i) => i.decision === 'pending' && !i.flags.some((f) => DOUBTFUL.has(f))).map((i) => i.id)));
    }
  };
  useEffect(() => { load(true); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo(() => {
    if (!b) return [];
    if (filter === 'pending') return b.items.filter((i) => i.decision === 'pending');
    if (filter === 'flagged') return b.items.filter((i) => i.decision === 'pending' && i.flags.length);
    return b.items;
  }, [b, filter]);

  if (!b) return <div className="page">Loading…</div>;
  const pendingCount = b.items.filter((i) => i.decision === 'pending').length;
  const toggle = (iid) => setSel((s) => { const n = new Set(s); if (n.has(iid)) n.delete(iid); else n.add(iid); return n; });
  const allShown = items.filter((i) => i.decision === 'pending').map((i) => i.id);
  const allSelected = allShown.length > 0 && allShown.every((x) => sel.has(x));

  const decide = async (decision) => {
    const ids = [...sel].filter((x) => b.items.find((i) => i.id === x)?.decision === 'pending');
    if (!ids.length) return;
    if (decision === 'approved' && !window.confirm(`Update ${ids.length} item cost(s) and retail prices?`)) return;
    setBusy(true);
    try {
      const r = await api.post(`/prices/batches/${id}/decide`, { item_ids: ids, decision });
      setMsg({ type: 'ok', text: decision === 'approved'
        ? (r.scheduled ? `${ids.length} change(s) approved — they will apply on the effective date.` : `${r.applied} price(s) updated.`)
        : `${r.decided} item(s) ${decision === 'not_a_match' ? 'marked "not a match" — they won\'t be suggested again' : 'rejected'}.` });
      await load(true);
    } catch (ex) { setMsg({ type: 'error', text: ex.message }); } finally { setBusy(false); }
  };

  const currentFamily = (() => {
    const counts = {};
    for (const i of b.items) if (i.price_key?.includes('_')) { const f = i.price_key.slice(0, i.price_key.lastIndexOf('_')); counts[f] = (counts[f] || 0) + 1; }
    return Object.entries(counts).sort((x, y) => y[1] - x[1])[0]?.[0] || '';
  })();
  const switchFamily = async (to) => {
    if (!to || to === currentFamily) return;
    const r = await api.post(`/prices/batches/${id}/column`, { from: currentFamily, to });
    setMsg({ type: 'ok', text: `${r.changed} line(s) now use the "${to}" column. ${b.vendor} will use it from now on.` });
    load(true);
  };
  const colLabel = (key) => (b.price_columns || []).find((c) => c.key === key)?.label || key;

  return (
    <div className="page">
      <p><Link to="/prices">← Price Updates</Link></p>
      <div className="row between">
        <div>
          <h1>{b.vendor} — {b.kind === 'percent' ? '% change notice' : (b.document_type || 'price sheet').replace('_', ' ')}</h1>
          <p className="muted">
            {b.filename && b.document_id ? <a href={`/api/prices/documents/${b.document_id}/file`} target="_blank" rel="noreferrer">{b.filename}</a> : b.filename || b.subject}
            {b.sender && <> · from {b.sender}</>}
            {b.effective_date && <> · effective {new Date(b.effective_date).toLocaleDateString('en-US', { timeZone: 'UTC' })}</>}
            {' · '}{STATUS[b.status] || b.status}
          </p>
        </div>
      </div>
      {b.summary?.old_sheet && <div className="notice error">This sheet is more than a year old. Pruett's current costs are probably newer — check before approving.</div>}
      {b.notes && <div className="notice info">Vendor notes: {b.notes}</div>}
      {b.kind === 'sheet' && (
        <div className="stats card">
          <div><span>Lines on sheet</span><strong>{b.summary?.lines ?? '—'}</strong></div>
          <div><span>Pruett items matched</span><strong>{b.summary?.matched ?? '—'}</strong></div>
          <div><span>Already at this cost</span><strong>{b.summary?.unchanged ?? '—'}</strong></div>
          <div><span>Price changes</span><strong>{b.items.length}</strong></div>
          {b.summary?.dropped_by_check > 0 && <div><span>Wrong matches removed by AI check</span><strong>{b.summary.dropped_by_check}</strong></div>}
        </div>
      )}
      {b.families?.length > 0 && pendingCount > 0 && (
        <div className="card row wrap">
          <span>Price column for this vendor:</span>
          <select value={b.price_prefix || currentFamily} onChange={(e) => switchFamily(e.target.value)}>
            {b.families.map((f) => <option key={f} value={f}>{(b.price_columns || []).find((c) => c.key.startsWith(`${f}_`))?.label?.replace(/ price.*$/i, '') || f}</option>)}
          </select>
          <span className="muted small">e.g. the volume tier Pruett actually buys at. Remembered for next time.</span>
        </div>
      )}
      {msg && <div className={`notice ${msg.type}`} onClick={() => setMsg(null)}>{msg.text}</div>}

      <div className="row between" style={{ margin: '12px 0' }}>
        <div className="tabs" style={{ margin: 0 }}>
          {[['pending', `To review (${pendingCount})`], ['flagged', 'Flagged'], ['all', 'All']].map(([k, l]) => (
            <button key={k} className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>{l}</button>
          ))}
        </div>
        {pendingCount > 0 && (
          <div className="row">
            <span className="muted">{sel.size} selected</span>
            <button className="btn" disabled={busy || !sel.size} onClick={() => decide('not_a_match')} title="The vendor line is a different product">Not a match</button>
            <button className="btn danger" disabled={busy || !sel.size} onClick={() => decide('rejected')}>Reject</button>
            <button className="btn primary" disabled={busy || !sel.size} onClick={() => decide('approved')}>Approve selected</button>
          </div>
        )}
      </div>

      <table className="grid price-table">
        <thead>
          <tr>
            <th><input type="checkbox" checked={allSelected} onChange={() => setSel(allSelected ? new Set() : new Set(allShown))} aria-label="Select all" /></th>
            <th>Pruett item</th><th>Vendor line</th><th className="num">Cost</th><th className="num">Retail</th><th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id} className={i.decision !== 'pending' ? 'decided' : ''}>
              <td>{i.decision === 'pending' ? <input type="checkbox" checked={sel.has(i.id)} onChange={() => toggle(i.id)} /> : <span className="small">{i.decision === 'approved' ? (i.applied_at ? '✓' : '⏱') : '✕'}</span>}</td>
              <td><span className="sku">{i.sku}</span><div>{i.description}</div></td>
              <td className="small">
                {i.increase_pct != null ? <>{i.increase_pct > 0 ? '+' : ''}{Number(i.increase_pct)}% — {i.vendor_desc}</> : <>
                  <span className="sku">{i.vendor_item_no}</span> {i.vendor_desc}
                  <div className="muted">{colLabel(i.price_key)}{Number(i.divisor) > 1 ? ` ÷ ${Number(i.divisor)}` : ''}
                    {i.match_method === 'description' && ` · description match ${Math.round((i.match_confidence || 0) * 100)}%`}</div>
                </>}
              </td>
              <td className="num nowrap">{money(i.old_cost_cents)} → <strong>{money(i.new_cost_cents)}</strong><div className={i.new_cost_cents > i.old_cost_cents ? 'error small' : 'ok small'}>{pct(i.new_cost_cents, i.old_cost_cents)}</div></td>
              <td className="num nowrap">{i.new_retail_cents === i.old_retail_cents ? money(i.old_retail_cents) : <>{money(i.old_retail_cents)} → <strong>{money(i.new_retail_cents)}</strong></>}</td>
              <td>{i.flags.map((f) => <span key={f} className={`badge ${FLAG[f]?.[1] || ''}`} title={FLAG[f]?.[2]}>{FLAG[f]?.[0] || f}</span>)}</td>
            </tr>
          ))}
          {!items.length && <tr><td colSpan={6} className="empty">{b.status === 'empty' ? 'Every matched item is already at these costs.' : 'Nothing here.'}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
