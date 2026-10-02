// Card payments through Stripe Terminal (server-driven integration).
//
// Flow at the register:
//   1. start()   -> creates a PaymentIntent (manual capture) and pushes it to the counter's reader
//   2. status()  -> polled by the register until the customer taps/inserts and the card is approved
//   3. capture() -> called when the sale is saved, so money is only taken for completed sales
//   cancel()     -> clears the reader and cancels the PaymentIntent
//   refund()     -> full or partial refund for returns / voids
//
// With no STRIPE_SECRET_KEY configured, a simulator approves every card after ~2 seconds so the
// register can be used for training and testing.

import Stripe from 'stripe';
import { config } from '../config.js';
import { HttpError } from '../http.js';

let stripe = null;
function client() {
  if (!stripe) stripe = new Stripe(config.stripeSecretKey);
  return stripe;
}

// ---------------- simulator ----------------
const sim = new Map();
const simDelayMs = Number(process.env.CARD_SIM_DELAY_MS ?? 2000);
let simSeq = 0;

const simulator = {
  mode: 'simulated',
  async listReaders() {
    return [{ id: 'sim_reader_1', label: 'Simulated reader (counter 1)', status: 'online', device_type: 'simulated' },
      { id: 'sim_reader_2', label: 'Simulated reader (counter 2)', status: 'online', device_type: 'simulated' }];
  },
  async start({ amountCents, readerId }) {
    const id = `pi_sim_${Date.now()}_${++simSeq}`;
    sim.set(id, { amountCents, readerId, startedAt: Date.now(), state: 'processing', refunded: 0 });
    return { paymentIntentId: id };
  },
  async status(id) {
    const p = sim.get(id);
    if (!p) throw new HttpError(404, 'Unknown card payment');
    if (p.state === 'processing' && Date.now() - p.startedAt >= simDelayMs) p.state = 'approved';
    return { status: p.state, brand: p.state === 'approved' ? 'visa' : null, last4: p.state === 'approved' ? '4242' : null, amountCents: p.amountCents };
  },
  async capture(id) {
    const s = await this.status(id);
    if (s.status !== 'approved') throw new HttpError(409, 'Card payment is not approved');
    sim.get(id).state = 'captured';
    return { brand: 'visa', last4: '4242' };
  },
  async cancel(id) {
    const p = sim.get(id);
    if (p && p.state !== 'captured') p.state = 'canceled';
  },
  async refund(id, amountCents) {
    const p = sim.get(id);
    // Captured payments from a previous server run aren't in memory; accept them in simulation.
    if (p) p.refunded += amountCents;
    return { refundId: `re_sim_${Date.now()}_${++simSeq}` };
  },
  async simulateTap() { /* simulator approves automatically */ },
};

// ---------------- real Stripe ----------------
const live = {
  mode: 'stripe',
  async listReaders() {
    const r = await client().terminal.readers.list({ limit: 20 });
    return r.data.map((x) => ({ id: x.id, label: x.label, status: x.status, device_type: x.device_type }));
  },
  async start({ amountCents, readerId, description }) {
    if (!readerId) throw new HttpError(400, 'No card reader selected for this register (Settings → This register)');
    const pi = await client().paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      payment_method_types: ['card_present'],
      capture_method: 'manual',
      description,
    });
    try {
      await client().terminal.readers.processPaymentIntent(readerId, { payment_intent: pi.id });
    } catch (err) {
      await client().paymentIntents.cancel(pi.id).catch(() => {});
      throw new HttpError(502, `Card reader error: ${err.message}`);
    }
    return { paymentIntentId: pi.id };
  },
  async status(id, readerId) {
    const pi = await client().paymentIntents.retrieve(id, { expand: ['latest_charge'] });
    const card = pi.latest_charge?.payment_method_details?.card_present;
    if (pi.status === 'requires_capture') return { status: 'approved', brand: card?.brand, last4: card?.last4, amountCents: pi.amount };
    if (pi.status === 'succeeded') return { status: 'captured', brand: card?.brand, last4: card?.last4, amountCents: pi.amount };
    if (pi.status === 'canceled') return { status: 'canceled', amountCents: pi.amount };
    // Declines show up on the reader action.
    if (readerId) {
      const reader = await client().terminal.readers.retrieve(readerId);
      const action = reader.action;
      if (action?.process_payment_intent?.payment_intent === id && action.status === 'failed') {
        return { status: 'failed', message: action.failure_message || 'Card declined', amountCents: pi.amount };
      }
    }
    if (pi.last_payment_error) return { status: 'failed', message: pi.last_payment_error.message, amountCents: pi.amount };
    return { status: 'processing', amountCents: pi.amount };
  },
  async capture(id) {
    const pi = await client().paymentIntents.capture(id, { expand: ['latest_charge'] });
    const card = pi.latest_charge?.payment_method_details?.card_present;
    return { brand: card?.brand, last4: card?.last4 };
  },
  async cancel(id, readerId) {
    if (readerId) await client().terminal.readers.cancelAction(readerId).catch(() => {});
    await client().paymentIntents.cancel(id).catch(() => {});
  },
  async refund(id, amountCents) {
    const r = await client().refunds.create({ payment_intent: id, amount: amountCents });
    return { refundId: r.id };
  },
  /** Test-mode only: make Stripe's simulated reader "tap" a test card. */
  async simulateTap(readerId) {
    if (!config.stripeSecretKey.startsWith('sk_test_')) throw new HttpError(400, 'Only available with a Stripe test key');
    await client().testHelpers.terminal.readers.presentPaymentMethod(readerId);
  },
};

export function cards() {
  return config.stripeSimulated ? simulator : live;
}
