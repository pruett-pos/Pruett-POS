import { useEffect, useState } from 'react';
import { api, money } from '../api.js';

const LABEL = { cash: 'Cash', check: 'Checks', card: 'Cards', charge: 'Charge accounts' };

export default function EndOfDay() {
  const today = new Date().toLocaleDateString('en-CA');
  const [date, setDate] = useState(today);
  const [data, setData] = useState(null);
  const [counted, setCounted] = useState('');
  const [startCash, setStartCash] = useState('');
  useEffect(() => { api.get(`/sales/summary/day?date=${date}`).then(setData); }, [date]);
  if (!data) return <div className="page">Loading…</div>;
  const cash = data.tenders.find((t) => t.method === 'cash')?.amount_cents || 0;
  const expected = cash + Math.round((Number(startCash) || 0) * 100);
  const diff = counted === '' ? null : Math.round(Number(counted) * 100) - expected;
  return (
    <div className="page narrow">
      <div className="row between"><h1>End of Day</h1><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
      <div className="card">
        <div className="stats">
          <div><span>Sales</span><strong>{data.totals.sales}</strong></div>
          <div><span>Returns</span><strong>{data.totals.returns}</strong></div>
          <div><span>Net sales (pre-tax)</span><strong>{money(data.totals.subtotal_cents)}</strong></div>
          <div><span>Sales tax collected</span><strong>{money(data.totals.tax_cents)}</strong></div>
          <div><span>Gross profit</span><strong>{money(data.totals.gross_profit_cents)}</strong></div>
          <div><span>Voids</span><strong>{data.voids.count} ({money(data.voids.amount_cents)})</strong></div>
        </div>
      </div>
      <div className="card">
        <h2>By payment type</h2>
        <table className="grid">
          <tbody>
            {data.tenders.map((t) => <tr key={t.method}><td>{LABEL[t.method]}</td><td className="num">{t.count}</td><td className="num">{money(t.amount_cents)}</td></tr>)}
          </tbody>
        </table>
      </div>
      <div className="card stack">
        <h2>Count the drawer</h2>
        <div className="row">
          <label>Starting cash<input inputMode="decimal" value={startCash} onChange={(e) => setStartCash(e.target.value)} placeholder="e.g. 200.00" /></label>
          <label>Cash counted<input inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} /></label>
        </div>
        <p>Expected in drawer: <strong>{money(expected)}</strong>
          {diff !== null && <> · <span className={diff === 0 ? 'ok' : 'error'}>{diff === 0 ? 'Balanced' : `${diff > 0 ? 'Over' : 'Short'} ${money(Math.abs(diff))}`}</span></>}</p>
        <button className="btn" onClick={() => window.print()}>Print</button>
      </div>
    </div>
  );
}
