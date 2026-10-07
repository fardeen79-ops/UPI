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
  port: int("PORT", 3001),
  dbPath: process.env.DB_PATH ?? "ipp.db",
  jwtSecret: jwtSecret(),
  jwtTtl: process.env.JWT_TTL ?? "12h",
  /** Balance (in fils) credited to a newly opened simulated bank account. AED 5,000 by default. */
  openingBalanceFils: int("OPENING_BALANCE_FILS", 5_000_00),
  /**
   * Aani's platform ceiling is AED 50,000 per transfer, but each bank sets its own
   * (often lower) limits, so all of these are configurable.
   */
  limits: {
    perTxnFils: int("LIMIT_PER_TXN_FILS", 50_000_00),
    dailyFils: int("LIMIT_DAILY_FILS", 50_000_00),
    dailyCount: int("LIMIT_DAILY_COUNT", 50),
  },
  passcode: {
    maxAttempts: int("PASSCODE_MAX_ATTEMPTS", 3),
    lockMinutes: int("PASSCODE_LOCK_MINUTES", 30),
  },
  requestDefaultExpiryMinutes: int("REQUEST_EXPIRY_MINUTES", 24 * 60),
  maxSplitParticipants: int("MAX_SPLIT_PARTICIPANTS", 10),
};

export type Config = typeof config;
