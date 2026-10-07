import type { Ctx } from "../context.js";
import { AppError } from "../errors.js";
import { paiseToRupees } from "../money.js";
import { generateAccountNumber, hashSecret, verifySecret } from "../security.js";

export interface BankRow {
  code: string;
  name: string;
  ifsc_prefix: string;
  vpa_handle: string;
}

export interface AccountRow {
  id: number;
  user_id: number;
  bank_code: string;
  account_number: string;
  ifsc: string;
  balance_paise: number;
  pin_hash: string | null;
  pin_failed_count: number;
  pin_locked_until: string | null;
  created_at: string;
}

export function listBanks(ctx: Ctx): BankRow[] {
  return ctx.db.prepare("SELECT * FROM banks ORDER BY name").all() as BankRow[];
}

export function getBank(ctx: Ctx, code: string): BankRow {
  const bank = ctx.db.prepare("SELECT * FROM banks WHERE code = ?").get(code) as BankRow | undefined;
  if (!bank) throw new AppError("NOT_FOUND", `Unknown bank: ${code}`);
  return bank;
}

/** Public view of an account. Never exposes the balance (that needs a PIN) or the full account number. */
export function publicAccount(ctx: Ctx, a: AccountRow) {
  const bank = getBank(ctx, a.bank_code);
  return {
    id: a.id,
    bank: { code: bank.code, name: bank.name },
    maskedAccountNumber: "XXXXXXXX" + a.account_number.slice(-4),
    ifsc: a.ifsc,
    pinSet: a.pin_hash !== null,
    createdAt: a.created_at,
  };
}

/**
 * Link a bank account. In real UPI the PSP discovers accounts registered to the user's
 * mobile number at the bank; here we simulate that by opening an account with a demo balance.
 */
export function linkAccount(ctx: Ctx, userId: number, bankCode: string): AccountRow {
  const bank = getBank(ctx, bankCode);
  const accountNumber = generateAccountNumber();
  const ifsc = `${bank.ifsc_prefix}0${accountNumber.slice(0, 6)}`;
  const info = ctx.db
    .prepare(
      "INSERT INTO accounts (user_id, bank_code, account_number, ifsc, balance_paise) VALUES (?, ?, ?, ?, ?)",
    )
    .run(userId, bank.code, accountNumber, ifsc, ctx.config.openingBalancePaise);
  return getAccount(ctx, Number(info.lastInsertRowid));
}

export function getAccount(ctx: Ctx, id: number): AccountRow {
  const a = ctx.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
  if (!a) throw new AppError("NOT_FOUND", "Account not found");
  return a;
}

export function getOwnedAccount(ctx: Ctx, userId: number, id: number): AccountRow {
  const a = getAccount(ctx, id);
  if (a.user_id !== userId) throw new AppError("NOT_FOUND", "Account not found");
  return a;
}

export function listAccounts(ctx: Ctx, userId: number): AccountRow[] {
  return ctx.db.prepare("SELECT * FROM accounts WHERE user_id = ? ORDER BY id").all(userId) as AccountRow[];
}

export function setPin(ctx: Ctx, userId: number, accountId: number, pin: string, oldPin?: string): void {
  const account = getOwnedAccount(ctx, userId, accountId);
  if (account.pin_hash !== null) {
    if (oldPin === undefined) throw new AppError("PIN_ALREADY_SET", "UPI PIN already set; provide oldPin to change it");
    verifyPin(ctx, account, oldPin);
  }
  ctx.db
    .prepare("UPDATE accounts SET pin_hash = ?, pin_failed_count = 0, pin_locked_until = NULL WHERE id = ?")
    .run(hashSecret(pin), account.id);
}

/**
 * Verify a UPI PIN, tracking failed attempts and locking the account after too many.
 * Must be called outside any enclosing DB transaction that may roll back, so that
 * failed-attempt counters are always persisted.
 */
export function verifyPin(ctx: Ctx, account: AccountRow, pin: string): void {
  if (account.pin_hash === null) throw new AppError("PIN_NOT_SET", "UPI PIN is not set for this account");
  const now = ctx.now();
  if (account.pin_locked_until && new Date(account.pin_locked_until) > now) {
    throw new AppError("PIN_LOCKED", "UPI PIN is locked due to too many incorrect attempts", {
      lockedUntil: account.pin_locked_until,
    });
  }
  if (verifySecret(pin, account.pin_hash)) {
    if (account.pin_failed_count !== 0 || account.pin_locked_until !== null) {
      ctx.db.prepare("UPDATE accounts SET pin_failed_count = 0, pin_locked_until = NULL WHERE id = ?").run(account.id);
    }
    return;
  }
  const failed = account.pin_failed_count + 1;
  const { maxAttempts, lockMinutes } = ctx.config.pin;
  if (failed >= maxAttempts) {
    const lockedUntil = new Date(now.getTime() + lockMinutes * 60_000).toISOString();
    ctx.db
      .prepare("UPDATE accounts SET pin_failed_count = 0, pin_locked_until = ? WHERE id = ?")
      .run(lockedUntil, account.id);
    throw new AppError("PIN_LOCKED", "Incorrect UPI PIN. PIN is now locked due to too many attempts", { lockedUntil });
  }
  ctx.db.prepare("UPDATE accounts SET pin_failed_count = ? WHERE id = ?").run(failed, account.id);
  throw new AppError("INVALID_PIN", "Incorrect UPI PIN", { attemptsRemaining: maxAttempts - failed });
}

export function checkBalance(ctx: Ctx, userId: number, accountId: number, pin: string) {
  const account = getOwnedAccount(ctx, userId, accountId);
  verifyPin(ctx, account, pin);
  return { accountId: account.id, balance: paiseToRupees(account.balance_paise), balancePaise: account.balance_paise };
}
