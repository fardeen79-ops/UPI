# UAE Instant Payments Simulator

A self-contained simulation of a UAE instant payments system in the style of
[Aani](https://aani.ae), the instant payments platform from the Central Bank of the UAE that Al Etihad Payments
operates. It's the UAE counterpart of the [UPI simulator](../README.md) in this repo.

> **Simulation only.** No real money moves and nothing connects to Aani, Al Etihad Payments or any bank.
> Opening an account creates a pretend account holding AED 5,000. Bank names are real; the 3-digit IBAN bank
> codes are only examples.

## How it differs from the UPI version

| | UPI (India) | This simulator (UAE) |
| --- | --- | --- |
| Pay someone by | VPA (`name@oksbi`) | **Mobile number, email, or IBAN** |
| Currency | INR (paise) | **AED (fils)** |
| Identity | Mobile number | UAE mobile (+971 5X) + optional **Emirates ID** (Luhn-checked) |
| Accounts | Account number + IFSC | **UAE IBAN** (`AE` + mod-97 check digits + bank code + 16 digits) |
| Authorisation | UPI PIN per bank account | **6-digit payment passcode** per user (stands in for the bank app's strong authentication) |
| Pull payments | Collect request | **Request to pay** + **split bill** |
| QR | `upi://pay?…` link | **EMVCo-style TLV payload** with CRC-16, currency 784, country AE |
| Limits reset | Midnight IST | **Midnight GST (UTC+4)**; default AED 50,000 per transfer and per day |

## Quick start

```bash
cd uae
npm install
npm run dev          # http://localhost:3001
npm test
```

Register two or three users in separate browser windows (or private windows) using UAE mobile numbers such as
`050 123 4567`, then send money, request money, split a bill or pay each other's QR codes.

## Features

- **Proxy registry:** the user's mobile number is registered automatically on their first account. They can add
  email addresses and choose which account each proxy pays into. Nobody can register a mobile number or email
  that belongs to someone else.
- **Confirmation of payee:** before paying, the payer sees the recipient's masked name, bank and masked IBAN.
- **Transfers** to a mobile number, email or IBAN (including between your own accounts). Each transfer is
  atomic, writes double-entry ledger entries, supports `Idempotency-Key`, and gets a reference like
  `IPP260115…`.
- **Request to pay:** ask someone for money using their mobile or email. They pay with their passcode or
  decline. You can cancel your own request, and requests expire.
- **Split bill:** split a total equally (down to the fil, with you optionally keeping a share) or with custom
  amounts. One request is sent per person, and you can track how much has been collected.
- **QR codes:** generate a static or dynamic (amount set) EMVCo-format payload that carries your IBAN and
  mobile. A payer can parse it, which checks the CRC so damaged or altered codes are rejected.
- **Passcode lockout:** after 3 wrong attempts the passcode locks for 30 minutes (configurable).
- Failed payments (insufficient funds, over a limit) are saved as `FAILED` transactions with a reference.

## API

All routes are under `/api`. Authenticated routes need `Authorization: Bearer <token>`.

| Method & path | Body |
| --- | --- |
| `POST /auth/register` | `{mobile, name, password, emiratesId?}` |
| `POST /auth/login` | `{mobile, password}` |
| `GET /me` · `POST /me/passcode` | `{passcode, oldPasscode?}` |
| `GET /banks` · `GET /accounts` · `POST /accounts` | `{bankCode}` |
| `GET /proxies` · `PUT /proxies` · `DELETE /proxies/:type/:value` | `{type: "MOBILE"\|"EMAIL", value, accountId}` |
| `POST /lookup` | `{to}`: mobile, email or IBAN → masked name, bank, IBAN |
| `POST /transfers` | `{to, amount, note?, fromAccountId?, passcode}` + optional `Idempotency-Key` |
| `GET /transactions?limit=&before=` · `GET /transactions/:id` | |
| `POST /requests` | `{from, amount, note?, toAccountId?, expiresInMinutes?}` |
| `GET /requests/incoming` · `GET /requests/outgoing` | |
| `POST /requests/:id/pay` · `/decline` · `/cancel` | `{passcode, fromAccountId?}` for pay |
| `POST /splits` · `GET /splits` · `GET /splits/:id` | `{total, participants: [{who, amount?}], mode?: "EQUAL"\|"CUSTOM", includeSelf?, note?}` |
| `GET /qr?accountId=&amount=&note=&reference=` | → `{payload, qrDataUrl}` |
| `POST /qr/parse` | `{payload}` → decoded fields + recipient lookup |

## Configuration

| Variable | Default |
| --- | --- |
| `PORT` | `3001` |
| `DB_PATH` | `ipp.db` |
| `JWT_SECRET` | random per start (**required** with `NODE_ENV=production`) |
| `OPENING_BALANCE_FILS` | `500000` (AED 5,000) |
| `LIMIT_PER_TXN_FILS` / `LIMIT_DAILY_FILS` | `5000000` (AED 50,000) |
| `LIMIT_DAILY_COUNT` | `50` |
| `PASSCODE_MAX_ATTEMPTS` / `PASSCODE_LOCK_MINUTES` | `3` / `30` |
| `REQUEST_EXPIRY_MINUTES` | `1440` |
| `MAX_SPLIT_PARTICIPANTS` | `10` |

## Going from simulator to production in the UAE

Aani is open only to licensed financial institutions. Banks and licensed payment service providers connect to
it through Al Etihad Payments. A real product would need:

- **A licence or partner:** either a CBUAE licence (for example under the Retail Payment Services and Card
  Schemes Regulation) or a partnership with a bank or licensed PSP that is already connected to Aani.
- **The official specifications:** Al Etihad Payments' API specs (ISO 20022 messages), its proxy directory,
  and its QR code spec. This simulator's QR uses a made-up identifier (`ae.sim.ipp`), and the official QR
  spec must replace it.
- **Verification and security:** UAE PASS or Emirates ID based eKYC, OTP verification of mobile numbers and
  emails, device binding, and bank-grade strong authentication instead of a server-checked passcode.
- **Compliance:** AML/CFT screening (sanctions lists, goAML reporting), purpose-of-payment codes where they are
  required, data residency in the UAE, and dispute and reconciliation processes.
- **Merchant payments without a licence:** use a licensed UAE payment gateway instead.
