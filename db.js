import pg from 'pg';
import { config } from './config.js';

// Return numeric columns as JS numbers (quantities / percentages are small enough).
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// bigint (count(*), bigserial) -> number
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

export const query = (text, params) => pool.query(text, params);

/** Run fn(client) inside a transaction. */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function audit(db, userId, action, entity, entityId, detail) {
  await db.query(
    'INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5)',
    [userId ?? null, action, entity ?? null, entityId == null ? null : String(entityId), detail ?? null],
  );
}
