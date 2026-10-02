import { money, fmtDate, qtyFmt } from '../api.js';
import { useSession } from '../session.jsx';

const METHOD = { cash: 'Cash', check: 'Check', card: 'Card', charge: 'Charge account' };

export default function Receipt({ sale }) {
  const { store, settings } = useSession();
  const isReturn = sale.kind === 'return';
  return (
    <div className="receipt" id="receipt">
      <div className="r-center">
        <div className="r-store">{store?.name}</div>
        {store?.address && <div>{store.address}</div>}
        {store?.phone && <div>{store.phone}</div>}
      </div>
      <div className="r-meta">
        <div>{isReturn ? 'RETURN' : 'SALE'} #{sale.number}{sale.status === 'voided' ? ' — VOIDED' : ''}</div>
        {sale.original_number && <div>Original receipt #{sale.original_number}</div>}
        <div>{fmtDate(sale.completed_at || sale.created_at)}</div>
        <div>Cashier: {sale.cashier}{sale.register ? ` · ${sale.register}` : ''}</div>
        {sale.customer_name && <div>Customer: {sale.customer_name}{sale.customer_company ? ` (${sale.customer_company})` : ''}</div>}
        {sale.po_number && <div>PO / Job: {sale.po_number}</div>}
      </div>
      <table className="r-lines">
        <tbody>
          {sale.lines.map((l) => (
            <tr key={l.id}>
              <td>
                <div>{l.description}</div>
                <div className="r-sub">{l.sku} · {qtyFmt(l.qty)} @ {money(l.unit_price_cents)}{l.unit_price_cents < l.list_price_cents ? ` (reg ${money(l.list_price_cents)})` : ''}{l.taxable ? '' : ' · N'}</div>
              </td>
              <td className="num">{money(l.line_total_cents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="r-totals">
        <tbody>
          <tr><td>Subtotal</td><td className="num">{money(sale.subtotal_cents)}</td></tr>
          <tr><td>Tax {sale.tax_exempt ? '(exempt)' : `(${Number(sale.tax_rate_pct)}%)`}</td><td className="num">{money(sale.tax_cents)}</td></tr>
          <tr className="r-total"><td>{isReturn ? 'Refund' : 'Total'}</td><td className="num">{money(sale.total_cents)}</td></tr>
          {sale.payments.map((p) => (
            <tr key={p.id}>
              <td>{METHOD[p.method]}{p.card_brand ? ` ${p.card_brand.toUpperCase()} ••${p.card_last4}` : ''}{p.check_number ? ` #${p.check_number}` : ''}</td>
              <td className="num">{money(p.method === 'cash' && p.tendered_cents ? p.tendered_cents : p.amount_cents)}</td>
            </tr>
          ))}
          {sale.payments.filter((p) => p.change_cents > 0).map((p) => (
            <tr key={`c${p.id}`} className="r-total"><td>Change</td><td className="num">{money(p.change_cents)}</td></tr>
          ))}
        </tbody>
      </table>
      {sale.payments.some((p) => p.method === 'charge') && (
        <div className="r-sign">Charged to account. Signature:<br /><br />______________________________</div>
      )}
      <div className="r-center r-footer">{settings?.receipt_footer}</div>
    </div>
  );
}
