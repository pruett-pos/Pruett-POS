import { useCallback, useEffect, useRef, useState } from 'react';
import { api, money, toCents, qtyFmt, registerConfig } from '../api.js';
import { useApproval } from '../components/Approval.jsx';
import CustomerPicker from '../components/CustomerPicker.jsx';
import Receipt from '../components/Receipt.jsx';
import Modal from '../components/Modal.jsx';

let keySeq = 0;
const newKey = () => `l${Date.now()}_${++keySeq}`;
const CART_KEY = 'pos.cart';

function loadCart() {
  try { return JSON.parse(sessionStorage.getItem(CART_KEY)) || null; } catch { return null; }
}

export default function Register() {
  const saved = loadCart();
  const [lines, setLines] = useState(saved?.lines || []);
  const [customer, setCustomer] = useState(saved?.customer || null);
  const [po, setPo] = useState(saved?.po || '');
  const [priced, setPriced] = useState(null);
  const [scan, setScan] = useState('');
  const [results, setResults] = useState(null);
  const [msg, setMsg] = useState(null);
  const [payments, setPayments] = useState([]);
  const [tender, setTender] = useState(null);   // which payment dialog is open
  const [cardFlow, setCardFlow] = useState(null);
  const [done, setDone] = useState(null);       // completed sale (receipt)
  const [busy, setBusy] = useState(false);
  const [misc, setMisc] = useState(null);
  const scanRef = useRef(null);
  const { withApproval } = useApproval();
  const reg = registerConfig.get();

  const paying = payments.length > 0;
  const cartValid = lines.length > 0 && lines.every((l) => Number(l.qty) > 0) && !!priced;

  useEffect(() => {
    try { sessionStorage.setItem(CART_KEY, JSON.stringify({ lines, customer, po })); } catch { /* ignore */ }
  }, [lines, customer, po]);

  // Server prices the cart (tier pricing, tax) whenever it changes.
  useEffect(() => {
    if (!lines.length) { setPriced(null); return undefined; }
    if (lines.some((l) => !(Number(l.qty) > 0))) return undefined; // wait until the qty is valid
    const t = setTimeout(() => {
      api.post('/sales/price', { customer_id: customer?.id ?? null, lines: lines.map(toApiLine) })
        .then(setPriced)
        .catch((e) => setMsg({ type: 'error', text: e.message }));
    }, 120);
    return () => clearTimeout(t);
  }, [lines, customer]);

  const focusScan = useCallback(() => setTimeout(() => scanRef.current?.focus(), 0), []);
  useEffect(() => { focusScan(); }, [focusScan]);

  const addProduct = (p, qty = 1) => {
    setLines((ls) => {
      const last = ls[ls.length - 1];
      if (last && last.product?.id === p.id && last.unit_price_cents == null) {
        return ls.map((l) => (l === last ? { ...l, qty: Number(l.qty) + qty } : l));
      }
      return [...ls, { key: newKey(), product: p, qty, unit_price_cents: null }];
    });
    if (!p.retail_cents) setMsg({ type: 'warn', text: `${p.sku} has no price in the system — tap its price to enter one` });
    else if (p.on_hand <= 0) setMsg({ type: 'warn', text: `${p.sku}: system shows ${qtyFmt(p.on_hand)} on hand` });
    else setMsg(null);
  };

  const onScan = async (e) => {
    e.preventDefault();
    let code = scan.trim();
    if (!code) return;
    let qty = 1;
    const m = /^(\d+(?:\.\d+)?)\*(.+)$/.exec(code); // "5*2X4-8" adds 5
    if (m) { qty = Number(m[1]); code = m[2].trim(); }
    setScan('');
    setResults(null);
    try {
      const p = await api.get(`/products/lookup/${encodeURIComponent(code)}`);
      addProduct(p, qty);
    } catch {
      const r = await api.get(`/products?q=${encodeURIComponent(code)}&limit=25`);
      if (r.items.length === 1) addProduct(r.items[0], qty);
      else if (r.items.length) setResults({ items: r.items, qty });
      else setMsg({ type: 'error', text: `Nothing found for "${code}"` });
    }
    focusScan();
  };

  const updateLine = (key, patch) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const removeLine = (key) => setLines((ls) => ls.filter((l) => l.key !== key));

  const total = priced?.totalCents ?? 0;
  const paid = payments.reduce((s, p) => s + p.amount_cents, 0);
  const remaining = total - paid;

  const clearSale = () => {
    setLines([]); setCustomer(null); setPo(''); setPayments([]); setPriced(null); setMsg(null); setResults(null);
    focusScan();
  };

  const cancelPayments = async () => {
    for (const p of payments.filter((x) => x.method === 'card')) {
      await api.post(`/sales/card/${p.payment_intent_id}/cancel`).catch(() => {});
    }
    setPayments([]);
  };

  const voidCart = async () => {
    if (!window.confirm('Clear this sale?')) return;
    await cancelPayments();
    clearSale();
  };

  const complete = async (allPayments) => {
    setBusy(true);
    try {
      const sale = await withApproval((token) => api.post('/sales', {
        customer_id: customer?.id ?? null,
        lines: lines.map(toApiLine),
        payments: allPayments.map(({ label, ...p }) => p),
        po_number: po || null,
        register: reg.name || null,
        approval_token: token,
      }));
      setDone(sale);
      clearSale();
    } catch (e) {
      if (!e.canceled) setMsg({ type: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const addPayment = (p) => {
    const next = [...payments, p];
    setPayments(next);
    setTender(null);
    const left = total - next.reduce((s, x) => s + x.amount_cents, 0);
    if (left === 0) complete(next);
  };

  // ---- card flow: start on reader, poll until approved/declined ----
  const startCard = async (amount) => {
    setTender(null);
    setCardFlow({ status: 'starting', amount });
    try {
      const r = await api.post('/sales/card/start', { amount_cents: amount, reader_id: reg.readerId || null });
      setCardFlow({ status: 'processing', amount, pi: r.payment_intent_id, mode: r.mode });
    } catch (e) {
      setCardFlow({ status: 'failed', amount, message: e.message });
    }
  };
  useEffect(() => {
    if (cardFlow?.status !== 'processing') return undefined;
    let stop = false;
    const poll = async () => {
      if (stop) return;
      try {
        const s = await api.get(`/sales/card/${cardFlow.pi}`);
        if (stop) return;
        if (s.status === 'approved') {
          setCardFlow(null);
          addPayment({ method: 'card', amount_cents: cardFlow.amount, payment_intent_id: cardFlow.pi, label: `Card ${s.brand?.toUpperCase() || ''} ••${s.last4 || ''}` });
          return;
        }
        if (s.status === 'failed' || s.status === 'canceled') {
          setCardFlow({ ...cardFlow, status: 'failed', message: s.message || 'Card was not approved' });
          return;
        }
      } catch { /* keep polling */ }
      setTimeout(poll, 1000);
    };
    const t = setTimeout(poll, 800);
    return () => { stop = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardFlow?.pi, cardFlow?.status]);

  const cancelCard = async () => {
    if (cardFlow?.pi) await api.post(`/sales/card/${cardFlow.pi}/cancel`).catch(() => {});
    setCardFlow(null);
  };

  const pricedLine = (i) => priced?.lines?.[i];

  return (
    <div className="register">
      <section className="cart-pane">
        <form onSubmit={onScan} className="scan-row">
          <input
            ref={scanRef}
            className="scan"
            placeholder="Scan barcode or type SKU / description (5*SKU adds 5)"
            value={scan}
            disabled={paying}
            onChange={(e) => setScan(e.target.value)}
          />
          <button className="btn" disabled={paying}>Add</button>
          <button type="button" className="btn" disabled={paying} onClick={() => setMisc({ description: '', price: '', qty: 1, taxable: true })}>Misc item</button>
        </form>
        {msg && <div className={`notice ${msg.type}`} onClick={() => setMsg(null)}>{msg.text}</div>}
        {results && (
          <div className="results">
            <div className="row between"><strong>Pick an item</strong><button className="btn small" onClick={() => setResults(null)}>Close</button></div>
            {results.items.map((p) => (
              <button key={p.id} className="result" onClick={() => { addProduct(p, results.qty); setResults(null); focusScan(); }}>
                <span className="sku">{p.sku}</span> {p.description}
                <span className="right">{money(p.retail_cents)} <span className="muted">· {qtyFmt(p.on_hand)} on hand</span></span>
              </button>
            ))}
          </div>
        )}
        <table className="cart">
          <thead>
            <tr><th>Item</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Total</th><th /></tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const pl = pricedLine(i);
              return (
                <tr key={l.key}>
                  <td>
                    <div>{l.product?.description || l.misc?.description}</div>
                    <div className="muted small">
                      {l.product?.sku || 'MISC'}
                      {pl?.unitPriceCents < pl?.listPriceCents && !pl?.overridden && <span className="badge blue">{priced?.tier} (reg {money(pl.listPriceCents)})</span>}
                      {pl?.overridden && <span className="badge orange">Price changed (was {money(pl.tierPriceCents)})</span>}
                      {pl?.flooredAtCost && <span className="badge">at cost</span>}
                      {!pl?.taxable && <span className="badge">non-taxable</span>}
                    </div>
                  </td>
                  <td className="num">
                    <input className="qty" type="number" min="0" step="any" value={l.qty} disabled={paying}
                      onChange={(e) => updateLine(l.key, { qty: e.target.value === '' ? '' : Number(e.target.value) })} />
                  </td>
                  <td className="num">
                    {l.product ? (
                      <PriceCell line={l} pl={pl} disabled={paying} onChange={(c) => updateLine(l.key, { unit_price_cents: c })} />
                    ) : money(l.misc.price_cents)}
                  </td>
                  <td className="num">{pl ? money(Math.round(pl.qty * pl.unitPriceCents)) : ''}</td>
                  <td><button className="icon-btn" disabled={paying} onClick={() => removeLine(l.key)} aria-label="Remove">✕</button></td>
                </tr>
              );
            })}
            {!lines.length && <tr><td colSpan={5} className="empty">Scan an item to start a sale</td></tr>}
          </tbody>
        </table>
      </section>

      <aside className="pay-pane">
        <CustomerPicker value={customer} onChange={(c) => { setCustomer(c); focusScan(); }} disabled={paying} />
        {customer?.checkout_note && <div className="notice warn"><strong>Note:</strong> {customer.checkout_note}</div>}
        {priced?.levelNotSet && <div className="notice warn">{priced.tier} pricing % isn't set yet — charging retail. A manager can set it in Settings → Price levels.</div>}
        <input placeholder={customer?.require_po ? 'PO / Job name (REQUIRED for this customer)' : 'PO / Job name (optional)'} value={po}
          className={customer?.require_po && !po ? 'required' : ''} onChange={(e) => setPo(e.target.value)} disabled={paying} />
        <div className="totals">
          <div><span>Subtotal</span><span>{money(priced?.subtotalCents ?? 0)}</span></div>
          <div><span>Tax{priced ? ` (${customer?.tax_exempt ? 'exempt' : `${priced.taxRatePct}%`})` : ''}</span><span>{money(priced?.taxCents ?? 0)}</span></div>
          <div className="grand"><span>Total</span><span>{money(total)}</span></div>
          {payments.map((p, i) => <div key={i} className="paid"><span>{p.label}</span><span>-{money(p.amount_cents)}</span></div>)}
          {paying && <div className="grand due"><span>Remaining</span><span>{money(remaining)}</span></div>}
        </div>
        <div className="tenders">
          <button className="btn tender" disabled={!cartValid || busy || remaining <= 0} onClick={() => setTender('cash')}>Cash</button>
          <button className="btn tender" disabled={!cartValid || busy || remaining <= 0} onClick={() => setTender('card')}>Card</button>
          <button className="btn tender" disabled={!cartValid || busy || remaining <= 0} onClick={() => setTender('check')}>Check</button>
          <button className="btn tender" disabled={!cartValid || busy || remaining <= 0 || !customer?.charge_account} onClick={() => setTender('charge')}
            title={customer?.charge_account ? '' : 'Select a customer with a charge account'}>Charge</button>
        </div>
        {paying && remaining === 0 && <button className="btn primary big" disabled={busy} onClick={() => complete(payments)}>Finish sale</button>}
        <div className="row between">
          {paying ? <button className="btn" onClick={cancelPayments}>Undo payments</button> : <span />}
          <button className="btn danger" disabled={!lines.length || busy} onClick={voidCart}>Clear sale</button>
        </div>
      </aside>

      {tender && (
        <TenderDialog kind={tender} remaining={remaining} customer={customer} onClose={() => { setTender(null); focusScan(); }}
          onCash={(amount, tendered) => addPayment({ method: 'cash', amount_cents: amount, tendered_cents: tendered, label: `Cash ${money(tendered)}` })}
          onCheck={(amount, num) => addPayment({ method: 'check', amount_cents: amount, check_number: num, label: `Check${num ? ` #${num}` : ''}` })}
          onCharge={(amount) => addPayment({ method: 'charge', amount_cents: amount, label: 'Charge account' })}
          onCard={startCard} />
      )}

      {cardFlow && (
        <Modal title="Card payment" onClose={cardFlow.status === 'failed' ? () => setCardFlow(null) : undefined}>
          <div className="stack center">
            <div className="big-amount">{money(cardFlow.amount)}</div>
            {cardFlow.status === 'starting' && <p>Sending to card reader…</p>}
            {cardFlow.status === 'processing' && <p>Ask the customer to tap, insert or swipe their card.</p>}
            {cardFlow.status === 'failed' && <p className="error">{cardFlow.message}</p>}
            <div className="row center">
              {cardFlow.status === 'processing' && cardFlow.mode === 'stripe' && (
                <button className="btn small" onClick={() => api.post(`/sales/card/${cardFlow.pi}/simulate-tap`).catch((e) => setMsg({ type: 'error', text: e.message }))}>Simulate tap (test mode)</button>
              )}
              {cardFlow.status !== 'failed' && <button className="btn danger" onClick={cancelCard}>Cancel</button>}
              {cardFlow.status === 'failed' && <button className="btn primary" onClick={() => startCard(cardFlow.amount)}>Try again</button>}
            </div>
          </div>
        </Modal>
      )}

      {misc && (
        <Modal title="Misc / non-stock item" onClose={() => setMisc(null)}>
          <form className="stack" onSubmit={(e) => {
            e.preventDefault();
            const c = toCents(misc.price);
            if (!misc.description || c == null) return;
            setLines((ls) => [...ls, { key: newKey(), misc: { description: misc.description, price_cents: c, taxable: misc.taxable }, qty: Number(misc.qty) || 1 }]);
            setMisc(null);
            focusScan();
          }}>
            <label>Description<input autoFocus value={misc.description} onChange={(e) => setMisc({ ...misc, description: e.target.value })} /></label>
            <div className="row">
              <label>Price<input inputMode="decimal" value={misc.price} onChange={(e) => setMisc({ ...misc, price: e.target.value })} /></label>
              <label>Qty<input type="number" step="any" value={misc.qty} onChange={(e) => setMisc({ ...misc, qty: e.target.value })} /></label>
            </div>
            <label className="check"><input type="checkbox" checked={misc.taxable} onChange={(e) => setMisc({ ...misc, taxable: e.target.checked })} /> Taxable</label>
            <div className="row end"><button className="btn primary">Add</button></div>
          </form>
        </Modal>
      )}

      {done && (
        <Modal title={`Sale #${done.number} complete`} onClose={() => { setDone(null); focusScan(); }}
          footer={<div className="row end">
            <button className="btn" onClick={() => window.print()}>Print receipt</button>
            <button className="btn primary" autoFocus onClick={() => { setDone(null); focusScan(); }}>New sale</button>
          </div>}>
          {done.payments.some((p) => p.change_cents > 0) && (
            <div className="change-due">Change due: {money(done.payments.reduce((s, p) => s + (p.change_cents || 0), 0))}</div>
          )}
          <Receipt sale={done} />
        </Modal>
      )}
    </div>
  );
}

function toApiLine(l) {
  if (l.misc) return { product_id: null, description: l.misc.description, unit_price_cents: l.misc.price_cents, taxable: l.misc.taxable, qty: Number(l.qty) || 0 };
  return { product_id: l.product.id, qty: Number(l.qty) || 0, unit_price_cents: l.unit_price_cents ?? null };
}

function PriceCell({ line, pl, disabled, onChange }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');
  if (editing) {
    return (
      <form onSubmit={(e) => { e.preventDefault(); const c = toCents(val); onChange(c); setEditing(false); }}>
        <input className="qty" autoFocus inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value)} onBlur={() => setEditing(false)} />
      </form>
    );
  }
  return (
    <button className="link" disabled={disabled} title="Change price (manager approval)"
      onClick={() => { setVal(((pl?.unitPriceCents ?? line.product.retail_cents) / 100).toFixed(2)); setEditing(true); }}>
      {money(pl?.unitPriceCents ?? line.product.retail_cents)}
    </button>
  );
}

function TenderDialog({ kind, remaining, customer, onClose, onCash, onCheck, onCharge, onCard }) {
  const [amount, setAmount] = useState((remaining / 100).toFixed(2));
  const [tendered, setTendered] = useState('');
  const [checkNo, setCheckNo] = useState('');
  const [err, setErr] = useState('');
  const amt = toCents(amount);

  const quick = [...new Set([remaining, Math.ceil(remaining / 500) * 500, Math.ceil(remaining / 1000) * 1000, Math.ceil(remaining / 2000) * 2000, Math.ceil(remaining / 5000) * 5000, 10000])]
    .filter((v) => v >= remaining).sort((a, b) => a - b).slice(0, 5);

  const validAmount = () => {
    if (amt == null || amt <= 0) { setErr('Enter an amount'); return false; }
    if (amt > remaining) { setErr(`Amount is more than the ${money(remaining)} remaining`); return false; }
    return true;
  };

  const payCash = (t) => {
    const tCents = t ?? toCents(tendered);
    if (tCents == null || tCents <= 0) { setErr('Enter cash received'); return; }
    // Cash covers the remaining balance (with change) or part of it.
    onCash(Math.min(tCents, remaining), tCents);
  };

  const titles = { cash: 'Cash', card: 'Card', check: 'Check', charge: 'Charge to account' };
  return (
    <Modal title={`${titles[kind]} — ${money(remaining)} due`} onClose={onClose}>
      <div className="stack">
        {kind === 'cash' && (
          <>
            <div className="quick">
              {quick.map((q) => <button key={q} className="btn big" onClick={() => payCash(q)}>{q === remaining ? `Exact ${money(q)}` : money(q)}</button>)}
            </div>
            <form className="row" onSubmit={(e) => { e.preventDefault(); payCash(); }}>
              <label className="grow">Cash received<input autoFocus inputMode="decimal" value={tendered} onChange={(e) => setTendered(e.target.value)} /></label>
              <button className="btn primary">OK</button>
            </form>
            {toCents(tendered) > remaining && <p className="change-due">Change: {money(toCents(tendered) - remaining)}</p>}
          </>
        )}
        {kind === 'card' && (
          <form className="stack" onSubmit={(e) => { e.preventDefault(); if (validAmount()) onCard(amt); }}>
            <label>Amount on card (change for split payments)<input autoFocus inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
            <button className="btn primary big">Send to card reader</button>
          </form>
        )}
        {kind === 'check' && (
          <form className="stack" onSubmit={(e) => { e.preventDefault(); if (validAmount()) onCheck(amt, checkNo); }}>
            <label>Check number<input autoFocus value={checkNo} onChange={(e) => setCheckNo(e.target.value)} /></label>
            <label>Amount<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
            <button className="btn primary big">Accept check</button>
          </form>
        )}
        {kind === 'charge' && (
          <form className="stack" onSubmit={(e) => { e.preventDefault(); if (validAmount()) onCharge(amt); }}>
            <p>{customer.name}{customer.company ? ` — ${customer.company}` : ''}<br />
              Balance {money(customer.balance_cents)}{customer.credit_limit_cents ? ` of ${money(customer.credit_limit_cents)} limit` : ''} · Net {customer.terms_days}</p>
            <label>Amount<input autoFocus inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
            <button className="btn primary big">Charge to account</button>
          </form>
        )}
        {err && <p className="error">{err}</p>}
      </div>
    </Modal>
  );
}
