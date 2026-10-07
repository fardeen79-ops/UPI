# UPI Simulator

A self-contained, UPI-style payment system: virtual payment addresses (`name@oksbi`), UPI PIN, instant
push payments, collect (request-money) flows, `upi://` QR codes and transaction history, with a web UI.

> Looking for the UAE version (Aani-style: mobile/email/IBAN proxies, AED, request-to-pay, split bills)?
> See [`uae/`](uae/README.md).

> **Simulation only.** No real money moves and nothing connects to NPCI or any bank. Linking an account opens
> a simulated bank account with a demo balance (₹10,000 by default).

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000  (auto-reload)
# or
npm run build && npm start
npm test             # API + unit tests
```

Open the app in two browser windows (or one normal, one private) and register two users to pay each other.

## Features

| Area | What it does |
| --- | --- |
| Users | Register/login with mobile number + password (scrypt-hashed), JWT sessions |
| Bank accounts | Link simulated accounts at SBI, HDFC, ICICI, Axis; masked account numbers |
| UPI PIN | 4/6-digit PIN per account, scrypt-hashed; locks after 3 wrong attempts (24h) |
| VPAs | Create `username@<bank handle>` addresses; payee-name lookup with masked name |
| Push payments | PIN-authorised, atomic, `Idempotency-Key` support, 12-digit RRN-style reference |
| Collect requests | Payee requests money, payer approves with PIN or declines; requests expire |
| QR codes | Generate NPCI-style `upi://pay?pa=…&pn=…&am=…&cu=INR` links + PNG QR; parse links to pay |
| Limits | Per-transaction amount, daily amount and daily count, reset at IST midnight |
| Ledger | Double-entry ledger (`DEBIT` + `CREDIT` per success); balances can never go negative |

## How a payment works

1. Payer's VPA must belong to them; payee VPA is resolved.
2. The UPI PIN is verified *outside* the money transaction, so failed attempts are always counted.
3. In a single `BEGIN IMMEDIATE` SQLite transaction: limits and balance are checked, the transaction row is
   written, the payer is debited (guarded by `balance >= amount`), the payee is credited, and two ledger
   entries are written.
4. Business failures (insufficient funds, limits) are **recorded as `FAILED` transactions** and returned with
   HTTP 201, so the payer always gets a reference. Validation, auth and PIN errors are HTTP 4xx with no record.

All amounts are stored as integer paise. The API accepts rupee strings (`"150.50"`) and returns both
`amount` (string) and `amountPaise`.

## API

All endpoints are under `/api`. Authenticated routes need `Authorization: Bearer <token>`.
Errors look like `{ "error": { "code": "INSUFFICIENT_FUNDS", "message": "…", "details": … } }`.

| Method & path | Body | Notes |
| --- | --- | --- |
| `POST /auth/register` | `{phone, name, password}` | Returns `{user, token}` |
| `POST /auth/login` | `{phone, password}` | Returns `{user, token}` |
| `GET /me` | | User, accounts, VPAs |
| `GET /banks` | | Public |
| `POST /accounts` | `{bankCode}` | Link a simulated account |
| `POST /accounts/:id/pin` | `{pin, oldPin?}` | `oldPin` required to change |
| `POST /accounts/:id/balance` | `{pin}` | POST so the PIN is never in a URL |
| `POST /vpas` | `{username, accountId}` | Creates `username@<bank handle>` |
| `GET /vpas/:address/resolve` | | `{address, name}` with masked name |
| `GET /vpas/:address/qr?amount=&note=` | | Own VPA only; `{uri, qrDataUrl}` |
| `POST /qr/parse` | `{uri}` | Parsed link + resolved payee |
| `POST /payments` | `{fromVpa, toVpa, amount, note?, pin}` | Optional `Idempotency-Key` header; replay returns 200 |
| `GET /transactions?limit=&before=` | | Newest first; `before` = ISO timestamp cursor |
| `GET /transactions/:id` | | |
| `POST /collect` | `{payeeVpa, payerVpa, amount, note?, expiresInMinutes?}` | |
| `GET /collect/incoming`, `GET /collect/outgoing` | | |
| `POST /collect/:id/approve` | `{pin}` | Returns `{collect, transaction}` |
| `POST /collect/:id/decline` | | |

Example:

```bash
TOKEN=$(curl -s localhost:3000/api/auth/login -H 'content-type: application/json' \
  -d '{"phone":"9876543210","password":"password123"}' | jq -r .token)

curl -s localhost:3000/api/payments -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H 'Idempotency-Key: order-42' \
  -d '{"fromVpa":"asha@oksbi","toVpa":"ravi@okhdfc","amount":"250","note":"Dinner","pin":"1234"}'
```

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `3000` | |
| `DB_PATH` | `upi.db` | SQLite file |
| `JWT_SECRET` | random per start | **Required** when `NODE_ENV=production` |
| `JWT_TTL` | `12h` | |
| `OPENING_BALANCE_PAISE` | `1000000` | ₹10,000 |
| `LIMIT_PER_TXN_PAISE` | `10000000` | ₹1,00,000 |
| `LIMIT_DAILY_PAISE` | `10000000` | ₹1,00,000 |
| `LIMIT_DAILY_COUNT` | `20` | |
| `PIN_MAX_ATTEMPTS` | `3` | |
| `PIN_LOCK_MINUTES` | `1440` | |
| `COLLECT_EXPIRY_MINUTES` | `30` | Default collect-request expiry |

## Project layout

```
src/
  app.ts              Express routes + request validation (zod)
  services/           accounts, vpas, payments (transfer engine), collect, users
  db.ts               SQLite schema and bank seed data
  upiUri.ts           upi://pay link builder/parser
  money.ts, vpa.ts, security.ts, auth.ts, config.ts
public/               Vanilla JS web client
test/                 Vitest + supertest suites
```

## Going from simulator to production

This is a learning/demo system. A real UPI product would need, among other things: NPCI membership via a
sponsor bank (as a TPAP/PSP), the NPCI UPI switch APIs and common library (the PIN is captured and encrypted
on-device, never seen by the app server), device binding via SMS, a proper core-banking integration,
reconciliation and dispute handling, rate limiting, audit logging, and RBI/NPCI compliance. To accept real
UPI payments as a merchant without that, integrate a payment gateway (Razorpay, Cashfree, PhonePe PG, etc.).
