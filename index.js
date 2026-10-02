import { createApp } from './app.js';
import { migrate } from './migrate.js';
import { ensureAdmin } from './seed.js';
import { config } from './config.js';
import { query } from './db.js';
import { startPriceAgent } from './services/priceAgent/intake.js';

await migrate();
await ensureAdmin();
// Clear expired sessions and stale card attempts daily.
setInterval(() => {
  query('DELETE FROM sessions WHERE expires_at < now()').catch(() => {});
}, 24 * 3600 * 1000).unref();

startPriceAgent();

createApp().listen(config.port, () => {
  console.log(`Pruett POS listening on :${config.port} (cards: ${config.stripeSimulated ? 'SIMULATED' : 'Stripe'})`);
});
