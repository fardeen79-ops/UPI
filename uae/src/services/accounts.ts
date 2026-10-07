import type { Ctx } from "../context.js";
import { AppError } from "../errors.js";
import { buildIban, formatIban } from "../identifiers.js";
import { filsToAed } from "../money.js";
import { randomDigits } from "../security.js";
import { getUser } from "./users.js";

export interface BankRow {
  code: string;
  name: string;
  iban_code: string;
}

export interface AccountRow {
  id: number;
  user_id: number;
  bank_code: string;
  iban: string;
  balance_fils: number;
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

export function publicAccount(ctx: Ctx, a: AccountRow) {
  const bank = getBank(ctx, a.bank_code);
  const proxies = ctx.db
    .prepare("SELECT type, value FROM proxies WHERE account_id = ? ORDER BY type")
    .all(a.id) as { type: string; value: string }[];
  return {
    id: a.id,
    bank: { code: bank.code, name: bank.name },
    iban: formatIban(a.iban),
    balance: filsToAed(a.balance_fils),
    balanceFils: a.balance_fils,
    proxies,
    createdAt: a.created_at,
  };
}

/**
 * Open a simulated bank account with a demo balance. The user's mobile number is registered
 * as a proxy for their first account automatically, as Aani onboarding does.
 */
export function openAccount(ctx: Ctx, userId: number, bankCode: string): AccountRow {
  const bank = getBank(ctx, bankCode);
  const user = getUser(ctx, userId);
  const run = ctx.db.transaction(() => {
    let iban: string;
    do iban = buildIban(bank.iban_code, randomDigits(16));
    while (ctx.db.prepare("SELECT 1 FROM accounts WHERE iban = ?").get(iban));
    const info = ctx.db
      .prepare("INSERT INTO accounts (user_id, bank_code, iban, balance_fils) VALUES (?, ?, ?, ?)")
      .run(userId, bank.code, iban, ctx.config.openingBalanceFils);
    const accountId = Number(info.lastInsertRowid);
    ctx.db
      .prepare("INSERT OR IGNORE INTO proxies (type, value, user_id, account_id) VALUES ('MOBILE', ?, ?, ?)")
      .run(user.mobile, userId, accountId);
    return accountId;
  });
  return getAccount(ctx, run());
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

/** The account a user pays from / receives into when none is specified: the one their mobile proxy points to. */
export function defaultAccount(ctx: Ctx, userId: number): AccountRow {
  const row = ctx.db
    .prepare(
      `SELECT a.* FROM accounts a JOIN users u ON u.id = a.user_id
       LEFT JOIN proxies p ON p.account_id = a.id AND p.type = 'MOBILE' AND p.value = u.mobile
       WHERE a.user_id = ? ORDER BY p.value IS NULL, a.id LIMIT 1`,
    )
    .get(userId) as AccountRow | undefined;
  if (!row) throw new AppError("NOT_FOUND", "Open a bank account first");
  return row;
}

export function resolveOwnedAccount(ctx: Ctx, userId: number, accountId?: number): AccountRow {
  return accountId === undefined ? defaultAccount(ctx, userId) : getOwnedAccount(ctx, userId, accountId);
}
