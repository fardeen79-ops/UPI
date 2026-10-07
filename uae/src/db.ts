import Database from "better-sqlite3";

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS banks (
  code      TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  iban_code TEXT NOT NULL UNIQUE      -- 3-digit bank identifier inside the IBAN
);

CREATE TABLE IF NOT EXISTS users (
  id                     INTEGER PRIMARY KEY,
  mobile                 TEXT NOT NULL UNIQUE,   -- E.164, +9715XXXXXXXX
  name                   TEXT NOT NULL,
  emirates_id            TEXT UNIQUE,
  password_hash          TEXT NOT NULL,
  passcode_hash          TEXT,                   -- 6-digit payment passcode
  passcode_failed_count  INTEGER NOT NULL DEFAULT 0,
  passcode_locked_until  TEXT,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS accounts (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  bank_code    TEXT NOT NULL REFERENCES banks(code),
  iban         TEXT NOT NULL UNIQUE,
  balance_fils INTEGER NOT NULL CHECK (balance_fils >= 0),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Proxy (alias) registry: a mobile number or email that routes to one account.
CREATE TABLE IF NOT EXISTS proxies (
  type       TEXT NOT NULL CHECK (type IN ('MOBILE','EMAIL')),
  value      TEXT NOT NULL,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (type, value)
);

CREATE TABLE IF NOT EXISTS transactions (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL CHECK (type IN ('TRANSFER','REQUEST')),
  status           TEXT NOT NULL CHECK (status IN ('SUCCESS','FAILED')),
  payer_account_id INTEGER NOT NULL REFERENCES accounts(id),
  payee_account_id INTEGER NOT NULL REFERENCES accounts(id),
  payee_via        TEXT NOT NULL,      -- how the payer addressed the payee: MOBILE / EMAIL / IBAN
  payee_label      TEXT NOT NULL,      -- the mobile / email / IBAN used
  amount_fils      INTEGER NOT NULL CHECK (amount_fils > 0),
  note             TEXT,
  failure_code     TEXT,
  failure_message  TEXT,
  initiated_by     INTEGER NOT NULL REFERENCES users(id),
  idempotency_key  TEXT,
  created_at       TEXT NOT NULL,
  UNIQUE (initiated_by, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_txn_payer ON transactions(payer_account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_txn_payee ON transactions(payee_account_id, created_at);

-- Double-entry ledger: every successful transaction writes one DEBIT and one CREDIT.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id            INTEGER PRIMARY KEY,
  txn_id        TEXT NOT NULL REFERENCES transactions(id),
  account_id    INTEGER NOT NULL REFERENCES accounts(id),
  direction     TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_fils   INTEGER NOT NULL CHECK (amount_fils > 0),
  balance_after INTEGER NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_entries(account_id, id);

CREATE TABLE IF NOT EXISTS splits (
  id                INTEGER PRIMARY KEY,
  requester_id      INTEGER NOT NULL REFERENCES users(id),
  payee_account_id  INTEGER NOT NULL REFERENCES accounts(id),
  total_fils        INTEGER NOT NULL CHECK (total_fils > 0),
  note              TEXT,
  created_at        TEXT NOT NULL
);

-- Request to pay: the requester asks a payer (by mobile/email) for money.
CREATE TABLE IF NOT EXISTS payment_requests (
  id               INTEGER PRIMARY KEY,
  requester_id     INTEGER NOT NULL REFERENCES users(id),
  payee_account_id INTEGER NOT NULL REFERENCES accounts(id),
  payer_id         INTEGER NOT NULL REFERENCES users(id),
  payer_label      TEXT NOT NULL,
  amount_fils      INTEGER NOT NULL CHECK (amount_fils > 0),
  note             TEXT,
  split_id         INTEGER REFERENCES splits(id),
  status           TEXT NOT NULL CHECK (status IN ('PENDING','PAID','DECLINED','EXPIRED','CANCELLED','FAILED')),
  txn_id           TEXT REFERENCES transactions(id),
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_req_payer ON payment_requests(payer_id, status);
CREATE INDEX IF NOT EXISTS idx_req_requester ON payment_requests(requester_id);
`;

// Bank names are real UAE banks; the 3-digit IBAN codes here are illustrative, not authoritative.
const BANKS = [
  { code: "ENBD", name: "Emirates NBD", iban_code: "026" },
  { code: "FAB", name: "First Abu Dhabi Bank", iban_code: "035" },
  { code: "ADCB", name: "Abu Dhabi Commercial Bank", iban_code: "030" },
  { code: "MASHREQ", name: "Mashreq", iban_code: "033" },
  { code: "DIB", name: "Dubai Islamic Bank", iban_code: "024" },
];

export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  const insert = db.prepare("INSERT OR IGNORE INTO banks (code, name, iban_code) VALUES (@code, @name, @iban_code)");
  for (const b of BANKS) insert.run(b);
  return db;
}
