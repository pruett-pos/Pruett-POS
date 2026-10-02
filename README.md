# Pruett POS

Point of sale for Pruett Home Improvement Supply.

**Built so far (phases 1–2):** register and checkout, contractor pricing, cash / check / card (Stripe Terminal) / charge accounts,
split payments, returns, voids, manager approvals, products and inventory, customers, Paladin import, end-of-day drawer count.

**Phase 3 (done): AI price agent** — reads vendor price sheets from the Pruett inbox or an upload, matches them to Pruett
items, and queues price changes for approval.

**Coming next:** Hover job quotes + shelf labels + quotes/special orders (phase 4), QuickBooks Online sync + reports (phase 5).

## How pricing works

| | Rule |
|---|---|
| Retail | `cost ÷ (1 − margin)`, rounded to the nearest $0.05. Margin = the item's own margin if set, else its category's, else the store default |
| Price levels | Paladin's pricing plans (CONTRACTOR, Contractor 2, Builder, Wholesale, Pruett, COST): % off retail, or cost + %. Never below cost. A level with no % charges retail |
| Manual price | tick "Set price by hand" on a product — margin changes and the price agent leave it alone |
| Tax | one store rate (Settings), skipped for tax-exempt customers and non-taxable items |

Changing a category's margin shows a preview of every price that will change before anything is saved.
Every price change is logged in the product's price history.

## Who can do what

| | Cashier | Manager | Admin |
|---|---|---|---|
| Sell, returns with receipt, add customers | ✓ | ✓ | ✓ |
| Change a price at the register, void, return without receipt, go over credit limit | manager approves on screen | ✓ | ✓ |
| Products, categories/margins, import, settings, contractor & charge accounts | | ✓ | ✓ |
| Create admins | | | ✓ |

Cashiers can log in with a 4+ digit PIN. Managers and admins need 10+ character passwords.

## Run it on your computer

Needs Node.js 20+ and PostgreSQL.

```bash
npm install
npm run build            # builds the screens (web/)
cp .env.example .env     # then edit it
npm run seed -- --demo   # optional: sample products and customers for training
npm start                # http://localhost:3000
npm test                 # automated tests (uses database pruett_test)
```

## Deploy on Railway

1. Push this folder to a private GitHub repo.
2. Railway → New Project → Deploy from GitHub repo → pick the repo.
3. In the project, **+ New → Database → PostgreSQL**.
4. On the app service → **Variables**: add `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`, `NODE_ENV=production`,
   `ADMIN_PASSWORD`, `ADMIN_NAME`, and later `STRIPE_SECRET_KEY`.
5. **Settings → Build command:** `npm run build` · **Start command:** `npm start`.
6. **Settings → Networking → Generate domain** (or add `pos.pruettsupply.com`).
7. Open the site, log in as `admin`, then in **Settings**: set the sales tax rate, contractor discount, category margins,
   store address, and add users.

The database tables are created automatically on start.

## AI price agent

**What it does**

1. Every 15 minutes it checks `pruetthomesupply@gmail.com` for vendor emails that look like pricing (attachments named or
   mentioning price lists, quotes, order confirmations, or "price increase" in the text). Managers can also upload a file on
   **Price Updates**, or type in a "% increase" notice by hand.
2. Claude reads the document — PDF price lists, Excel/CSV sheets, photos, order confirmations, or an email that only says
   "+6% effective 8/10" — and pulls out every item number, description, pack size and price column.
3. The matcher ties each line to Pruett items using the patterns in Pruett's part numbers:
   exact numbers (Wausau `139710993`), color suffixes (Lynch `20` → `20 AL`, `20 BZ`; Rollex `A-SYS312L-` → `A-SYS312L-9`),
   and tier suffixes (CertainTeed `33110` / `33110D` deluxe). Order confirmations are also matched by description.
4. It works out which price applies — piece price, carton ÷ pieces, square price, the right color tier — by comparing with
   the item's current cost, and keeps a whole sheet on one volume tier. Doubtful matches get a second look from Claude.
5. A batch appears on **Price Updates** and an email goes to `PRICE_NOTIFY_EMAILS`. New retail = new cost ÷ (1 − the item's
   margin), rounded to $0.05. Manual-price items keep their retail.
6. A manager ticks what to approve. Clean changes are pre-ticked; flagged ones (check unit/pack, check match, description
   match, sheet over a year old) are not. **Nothing changes in the store until someone approves.** Approved changes with a
   future effective date apply automatically on that date. Approvals are remembered, so the next sheet from that vendor
   matches itself; "Not a match" is remembered too.

**Setup**

1. `ANTHROPIC_API_KEY` — create one at console.anthropic.com and add billing; each document read is billed per use (see Anthropic's pricing page).
2. Gmail App Password for pruetthomesupply@gmail.com: Google Account → Security → 2-Step Verification (on) → App passwords →
   create "Pruett POS" → put the 16 letters in `PRICE_INBOX_APP_PASSWORD`. Make sure IMAP is enabled in Gmail settings.
3. `PRICE_NOTIFY_EMAILS` (you and the store manager) and `APP_URL`.

Without the API key the screens still work — upload and % notices are stored, and the status bar says the AI reader isn't set up.

## Card readers (Stripe Terminal)

1. Create a Stripe account for Pruett and get the secret key (Developers → API keys).
2. Order readers (Stripe Dashboard → Terminal → Hardware). The BBPOS WisePOS E or Stripe Reader S700 connect over Wi-Fi to this server-driven setup.
3. Register each reader to a Terminal location in the Stripe Dashboard.
4. Set `STRIPE_SECRET_KEY`. Start with a `sk_test_` key: you can create a **simulated reader** in the Dashboard and use
   the "Simulate tap" button at the register.
5. On each counter PC: **Settings → This register** → name it and pick its reader.

Cards are authorized on the reader and only captured when the sale is saved, so an abandoned sale never charges the customer.
Returns to card are refunded through Stripe automatically.

Until a key is set, card payments run in a **simulator** (yellow banner at the top) — good for training.

## Counter hardware

- **Barcode scanner:** any USB scanner in keyboard mode. The scan box stays focused; `5*SKU` adds five.
- **Receipt printer:** 80 mm thermal (e.g. Epson TM-T20/T88) set as the PC's default printer. Receipts print via the browser.
- **Cash drawer:** plug into the receipt printer and enable "open drawer when printing" in the printer driver.

## Importing from Paladin

**Pruett's own files (what we did):** Import → Products → upload `inventoryforupload.xlsx` → "Keep current prices" → Import.
Every item keeps today's exact price and its current margin becomes its item margin, so when the price agent later updates
a cost, the price moves to hold that margin. Items with no price, no cost, or a price below cost import with their price
locked and show under Products → **Needs review**. Alternate part numbers become extra barcodes.
Then Import → Customers → upload `customer list.xlsx`. Pricing plans, credit limits, tax-exempt status, require-PO and
checkout notes come across. Deleted accounts and Paladin's "RETAIL" placeholder are skipped. **Open balances are loaded on
go-live day**, not before.

**Any other spreadsheet:**

Export items from Paladin to CSV or Excel (include part number, description, department, vendor, vendor part #, UPC,
cost, retail, on hand, min/max). Then **Import** → upload → check the column matches → choose pricing:

- **Recalculate from margin** (recommended): retail = cost ÷ (1 − category margin). The preview lists the biggest
  differences from Paladin's prices so you can adjust margins first.
- **Keep Paladin prices**: imports their retail as manual prices.

Re-importing the same file updates existing items (matched by part number).

## Project layout

```
server/src/pricing.js            pricing rules (margin, contractor, tax, rounding)
server/src/services/checkout.js  sales, returns, voids
server/src/services/cardPayments.js  Stripe Terminal + simulator
server/src/services/importer.js  Paladin / spreadsheet import
server/src/services/priceAgent/  AI price agent: extract.js (Claude), match.js, batches.js, intake.js (inbox, uploads, emails)
server/test/fixtures/price-sheets/  real vendor sheets (Lynch, Rollex, CertainTeed, Wausau, Alside) used in tests
server/src/services/catalog.js   products, repricing, inventory
server/migrations/               database schema
web/src/pages/                   screens (Register, Returns, Products, ...)
```
