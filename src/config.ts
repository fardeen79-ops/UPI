import { randomBytes } from "node:crypto";

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

function jwtSecret(): string {
  const s = process.env.JWT_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === "production") throw new Error("JWT_SECRET must be set in production");
  // Dev fallback: tokens are invalidated on restart.
  return randomBytes(32).toString("hex");
}

export const config = {
  port: int("PORT", 3000),
  dbPath: process.env.DB_PATH ?? "upi.db",
  jwtSecret: jwtSecret(),
  jwtTtl: process.env.JWT_TTL ?? "12h",
  /** Balance (in paise) credited to a newly linked simulated bank account. */
  openingBalancePaise: int("OPENING_BALANCE_PAISE", 10_000_00),
  limits: {
    perTxnPaise: int("LIMIT_PER_TXN_PAISE", 1_00_000_00),
    dailyPaise: int("LIMIT_DAILY_PAISE", 1_00_000_00),
    dailyCount: int("LIMIT_DAILY_COUNT", 20),
  },
  pin: {
    maxAttempts: int("PIN_MAX_ATTEMPTS", 3),
    lockMinutes: int("PIN_LOCK_MINUTES", 24 * 60),
  },
  collectDefaultExpiryMinutes: int("COLLECT_EXPIRY_MINUTES", 30),
};

export type Config = typeof config;
