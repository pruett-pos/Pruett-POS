// Small fetch wrapper. Errors carry the server message and flags like needsApproval.
export class ApiError extends Error {
  constructor(status, data) {
    super(data?.error || `Request failed (${status})`);
    this.status = status;
    this.data = data || {};
  }
}

async function request(method, path, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, opts);
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login') window.dispatchEvent(new Event('pos:logged-out'));
    throw new ApiError(res.status, data);
  }
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b ?? {}),
  put: (p, b) => request('PUT', p, b),
  del: (p) => request('DELETE', p),
};

export const money = (cents) => {
  if (cents == null || Number.isNaN(cents)) return '';
  const neg = cents < 0;
  const s = (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${neg ? '-' : ''}$${s}`;
};

/** "12.34" / "$12" -> cents, or null */
export const toCents = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

export const fmtDate = (d) => (d ? new Date(d).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' }) : '');

export const qtyFmt = (q) => (Number.isInteger(Number(q)) ? String(Number(q)) : Number(q).toFixed(3).replace(/0+$/, ''));

// Per-device register settings (name + card reader) live in this browser.
export const registerConfig = {
  get() {
    try { return JSON.parse(localStorage.getItem('pos.register') || '{}'); } catch { return {}; }
  },
  set(v) {
    try { localStorage.setItem('pos.register', JSON.stringify(v)); } catch { /* ignore */ }
  },
};
