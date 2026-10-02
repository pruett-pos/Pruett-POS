// Central configuration, read from environment variables.
export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL || 'postgres://pruett:pruett@localhost:5432/pruett_pos',
  // Postgres on Railway/Render needs SSL; local does not.
  databaseSsl: process.env.DATABASE_SSL === 'true',
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  // When no Stripe key is configured the card flow runs in a simulator so the register is usable for training.
  get stripeSimulated() { return !this.stripeSecretKey; },
  // AI price agent
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  // Vendor price-sheet inbox (Gmail: IMAP + an App Password)
  imapUser: process.env.PRICE_INBOX_USER || '',
  imapPassword: process.env.PRICE_INBOX_APP_PASSWORD || '',
  imapHost: process.env.PRICE_INBOX_IMAP_HOST || 'imap.gmail.com',
  smtpHost: process.env.PRICE_INBOX_SMTP_HOST || 'smtp.gmail.com',
  inboxPollMinutes: Number(process.env.PRICE_INBOX_POLL_MINUTES || 15),
  notifyEmails: (process.env.PRICE_NOTIFY_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean),
  appUrl: (process.env.APP_URL || '').replace(/\/$/, ''),
  sessionDays: Number(process.env.SESSION_DAYS || 14),
  isProduction: process.env.NODE_ENV === 'production',
};
