// Getting vendor documents in: manual upload, or the price-sheet inbox (Gmail over IMAP with an App Password).
// Every document is stored, read by Claude, matched, and turned into a batch for approval.

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { query, tx } from '../../db.js';
import { config } from '../../config.js';
import { extractDocument } from './extract.js';
import { buildBatch, applyDueChanges } from './batches.js';

const FILE_RE = /\.(pdf|xlsx|csv|tsv|png|jpe?g)$/i;
const PRICE_WORDS = /\b(price|pricing|prices|increase|price list|price sheet|quote|quotation|order confirmation)\b/i;

/** Store a document and queue it for reading. Returns the document id (or null if it was already received). */
export async function receiveDocument({ source, buffer, filename, mimeType, sender, subject, emailText, sourceRef, userId }) {
  const { rows } = await query(
    `INSERT INTO price_documents (source, source_ref, sender, subject, filename, mime_type, file_data, created_by, extracted)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (source_ref, filename) WHERE source = 'email' DO NOTHING RETURNING id`,
    [source, sourceRef || null, sender || null, subject || null, filename || null, mimeType || null, buffer || null, userId || null,
      emailText ? { email_text: String(emailText).slice(0, 50000) } : null],
  );
  if (!rows[0]) return null;
  enqueue(rows[0].id);
  return rows[0].id;
}

// --- simple in-process queue so uploads return immediately ---
const queue = [];
let running = false;
export function enqueue(id) {
  queue.push(id);
  if (!running) drain();
}
async function drain() {
  running = true;
  while (queue.length) {
    const id = queue.shift();
    try {
      await processDocument(id);
    } catch (err) {
      console.error(`price document ${id}:`, err.message);
    }
  }
  running = false;
}
export const queueIdle = () => new Promise((resolve) => {
  const check = () => (running || queue.length ? setTimeout(check, 50) : resolve());
  check();
});

/** Read, match and batch one stored document. */
export async function processDocument(id) {
  const { rows: [d] } = await query('SELECT * FROM price_documents WHERE id = $1', [id]);
  if (!d) return;
  try {
    if (!d.extracted?.items) {
      const extracted = await extractDocument({
        buffer: d.file_data, mimeType: d.mime_type, filename: d.filename, sender: d.sender, subject: d.subject,
        emailText: d.extracted?.email_text,
      });
      await query(`UPDATE price_documents SET extracted = $2, status = 'extracted', document_type = $3, error = NULL WHERE id = $1`,
        [id, extracted, extracted.document_type]);
    }
    const result = await tx((db) => buildBatch(db, id));
    if (result.batchId && result.summary.changes > 0) await notifyBatch(result.batchId).catch((e) => console.error('notify:', e.message));
    return result;
  } catch (err) {
    await query(`UPDATE price_documents SET status = 'failed', error = $2 WHERE id = $1`, [id, err.message]);
    throw err;
  }
}

// ---------- email notifications ----------
let transport = null;
function mailer() {
  if (!config.imapUser || !config.imapPassword) return null;
  transport ||= nodemailer.createTransport({ host: config.smtpHost, port: 465, secure: true, auth: { user: config.imapUser, pass: config.imapPassword } });
  return transport;
}

export async function notifyBatch(batchId) {
  const m = mailer();
  if (!m || !config.notifyEmails.length) return false;
  const { rows: [b] } = await query(
    `SELECT b.*, v.name AS vendor, (SELECT count(*) FROM price_batch_items i WHERE i.batch_id = b.id) AS items,
       (SELECT count(*) FROM price_batch_items i WHERE i.batch_id = b.id AND cardinality(i.flags) > 0) AS flagged
     FROM price_batches b JOIN vendors v ON v.id = b.vendor_id WHERE b.id = $1`, [batchId]);
  if (!b || b.notified_at) return false;
  const link = config.appUrl ? `${config.appUrl}/prices/${b.id}` : `Price Updates → batch #${b.id}`;
  await m.sendMail({
    from: config.imapUser,
    to: config.notifyEmails.join(', '),
    subject: `Pruett POS: ${b.items} price changes from ${b.vendor} need approval`,
    text: `${b.vendor} sent new pricing${b.effective_date ? ` (effective ${b.effective_date.toISOString().slice(0, 10)})` : ''}.\n\n`
      + `${b.items} items would change; ${b.flagged} are flagged for a closer look.\n\nReview and approve: ${link}\n\n`
      + 'Nothing changes in the store until a manager approves.',
  });
  await query('UPDATE price_batches SET notified_at = now() WHERE id = $1', [batchId]);
  return true;
}

// ---------- inbox polling ----------
async function getLastUid() {
  const { rows } = await query(`SELECT value FROM settings WHERE key = 'price_inbox_last_uid'`);
  return rows[0] ? Number(rows[0].value) : null;
}
async function setLastUid(uid) {
  await query(`INSERT INTO settings (key, value) VALUES ('price_inbox_last_uid', $1)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(uid)]);
}

/** Look for new vendor emails. Returns how many documents were queued. */
export async function checkInbox() {
  if (!config.imapUser || !config.imapPassword) return 0;
  const client = new ImapFlow({ host: config.imapHost, port: 993, secure: true, auth: { user: config.imapUser, pass: config.imapPassword }, logger: false });
  await client.connect();
  let queued = 0;
  const lock = await client.getMailboxLock('INBOX');
  try {
    const last = await getLastUid();
    // First run: look back 14 days only.
    const range = last ? { uid: `${last + 1}:*` } : { since: new Date(Date.now() - 14 * 86400000) };
    let maxUid = last || 0;
    for await (const msg of client.fetch(range, { uid: true, source: true }, { uid: true })) {
      if (last && msg.uid <= last) continue;
      maxUid = Math.max(maxUid, msg.uid);
      const mail = await simpleParser(msg.source);
      const sender = mail.from?.text || '';
      if (config.imapUser && sender.toLowerCase().includes(config.imapUser.toLowerCase())) continue; // our own notifications
      const text = mail.text || '';
      const files = (mail.attachments || []).filter((a) => FILE_RE.test(a.filename || '') && a.size < 20 * 1024 * 1024);
      const looksLikePricing = PRICE_WORDS.test(`${mail.subject || ''} ${text.slice(0, 3000)}`) || files.some((a) => PRICE_WORDS.test(a.filename));
      if (!looksLikePricing) continue;
      const base = { source: 'email', sender, subject: mail.subject, sourceRef: mail.messageId || `uid:${msg.uid}`, emailText: text };
      if (files.length) {
        for (const a of files) {
          if (await receiveDocument({ ...base, buffer: a.content, filename: a.filename, mimeType: a.contentType })) queued++;
        }
      } else if (await receiveDocument({ ...base, filename: '(email body)' })) queued++;
    }
    if (maxUid > (last || 0)) await setLastUid(maxUid);
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  return queued;
}

/** Start background jobs: inbox polling and applying scheduled price changes. */
export function startPriceAgent() {
  const run = async () => {
    try {
      const n = await checkInbox();
      if (n) console.log(`price inbox: ${n} new document(s)`);
    } catch (err) {
      console.error('price inbox:', err.message);
    }
    try {
      const applied = await tx((db) => applyDueChanges(db));
      if (applied) console.log(`applied ${applied} scheduled price change(s)`);
    } catch (err) {
      console.error('scheduled prices:', err.message);
    }
  };
  setTimeout(run, 10_000).unref();
  setInterval(run, config.inboxPollMinutes * 60_000).unref();
  // Retry anything left half-done by a restart.
  query(`SELECT id FROM price_documents WHERE status = 'received' ORDER BY id`).then(({ rows }) => rows.forEach((r) => enqueue(r.id))).catch(() => {});
}
