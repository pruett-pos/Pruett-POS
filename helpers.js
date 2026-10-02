// Test helpers: fresh database + running app on a random port.
process.env.DATABASE_URL ||= 'postgres://pruett:pruett@localhost:5432/pruett_test';
process.env.CARD_SIM_DELAY_MS = '0';
process.env.ADMIN_PASSWORD = 'admin-password-123';
delete process.env.STRIPE_SECRET_KEY;
process.env.ANTHROPIC_API_KEY = 'test-key'; // Claude calls are replaced by a fake client in tests
delete process.env.PRICE_INBOX_USER;

const { pool, query } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { ensureAdmin } = await import('../src/seed.js');
const { createApp } = await import('../src/app.js');

export { pool, query };

export async function freshDb() {
  await query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate({ log: () => {} });
  await ensureAdmin();
  await query(`INSERT INTO settings (key, value) VALUES ('tax_rate_pct', '8.5')`);
}

export async function startServer() {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

/** Tiny client that keeps the session cookie. */
export function client(base) {
  let cookie = '';
  async function call(method, path, body, { raw } = {}) {
    const headers = { cookie };
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + path, { method, headers, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => null);
    if (raw) return { status: res.status, data };
    if (!res.ok) throw Object.assign(new Error(`${method} ${path} -> ${res.status}: ${data?.error}`), { status: res.status, data });
    return data;
  }
  return {
    get: (p, o) => call('GET', p, undefined, o),
    post: (p, b, o) => call('POST', p, b, o),
    put: (p, b, o) => call('PUT', p, b, o),
    del: (p, o) => call('DELETE', p, undefined, o),
    login: (u, pw) => call('POST', '/api/auth/login', { username: u, password: pw }),
  };
}
