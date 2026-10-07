import Database from "better-sqlite3";

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS banks (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  ifsc_prefix TEXT NOT NULL,
  vpa_handle  TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  phone         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS accounts (
  id               INTEGER PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  bank_code        TEXT NOT NULL REFERENCES banks(code),
  account_number   TEXT NOT NULL UNIQUE,
  ifsc             TEXT NOT NULL,
  balance_paise    INTEGER NOT NULL CHECK (balance_paise >= 0),
  pin_hash         TEXT,
  pin_failed_count INTEGER NOT NULL DEFAULT 0,
  pin_locked_until TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS vpas (
  address    TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id                 TEXT PRIMARY KEY,           -- 12-digit RRN-style reference
  type               TEXT NOT NULL CHECK (type IN ('PAY','COLLECT')),
  status             TEXT NOT NULL CHECK (status IN ('PENDING','SUCCESS','FAILED')),
  payer_vpa          TEXT NOT NULL,
  payee_vpa          TEXT NOT NULL,
  payer_account_id   INTEGER REFERENCES accounts(id),
  payee_account_id   INTEGER REFERENCES accounts(id),
  amount_paise       INTEGER NOT NULL CHECK (amount_paise > 0),
  note               TEXT,
  failure_code       TEXT,
  failure_message    TEXT,
  initiated_by       INTEGER NOT NULL REFERENCES users(id),
  idempotency_key    TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at       TEXT,
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
  amount_paise  INTEGER NOT NULL CHECK (amount_paise > 0),
  balance_after INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_entries(account_id, id);

CREATE TABLE IF NOT EXISTS collect_requests (
  id           INTEGER PRIMARY KEY,
  payee_vpa    TEXT NOT NULL REFERENCES vpas(address),
  payer_vpa    TEXT NOT NULL REFERENCES vpas(address),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  note         TEXT,
  status       TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','DECLINED','EXPIRED','FAILED')),
  txn_id       TEXT REFERENCES transactions(id),
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_collect_payer ON collect_requests(payer_vpa, status);
`;

const BANKS = [
  { code: "SBI", name: "State Bank of India", ifsc_prefix: "SBIN", vpa_handle: "oksbi" },
  { code: "HDFC", name: "HDFC Bank", ifsc_prefix: "HDFC", vpa_handle: "okhdfc" },
  { code: "ICICI", name: "ICICI Bank", ifsc_prefix: "ICIC", vpa_handle: "okicici" },
  { code: "AXIS", name: "Axis Bank", ifsc_prefix: "UTIB", vpa_handle: "okaxis" },
];

export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO banks (code, name, ifsc_prefix, vpa_handle) VALUES (@code, @name, @ifsc_prefix, @vpa_handle)",
  );
  for (const b of BANKS) insert.run(b);
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}
