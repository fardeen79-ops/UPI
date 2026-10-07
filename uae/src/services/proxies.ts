import type { Ctx } from "../context.js";
import { AppError } from "../errors.js";
import { maskIban, maskName, parseRecipient, type Recipient } from "../identifiers.js";
import { getAccount, getBank, getOwnedAccount, type AccountRow } from "./accounts.js";
import { getUser, type UserRow } from "./users.js";

export interface ProxyRow {
  type: "MOBILE" | "EMAIL";
  value: string;
  user_id: number;
  account_id: number;
  created_at: string;
}

export function listProxies(ctx: Ctx, userId: number): ProxyRow[] {
  return ctx.db.prepare("SELECT * FROM proxies WHERE user_id = ? ORDER BY type, value").all(userId) as ProxyRow[];
}

export function publicProxy(p: ProxyRow) {
  return { type: p.type, value: p.value, accountId: p.account_id, createdAt: p.created_at };
}

/**
 * Point a proxy at one of the user's accounts (creating it if needed).
 * A user may only register their own verified mobile number. Emails are accepted as-is here;
 * a real deployment verifies ownership with an OTP first.
 */
export function linkProxy(ctx: Ctx, userId: number, type: "MOBILE" | "EMAIL", value: string, accountId: number): ProxyRow {
  const account = getOwnedAccount(ctx, userId, accountId);
  if (type === "MOBILE" && value !== getUser(ctx, userId).mobile) {
    throw new AppError("FORBIDDEN", "You can only register your own mobile number");
  }
  const existing = ctx.db.prepare("SELECT * FROM proxies WHERE type = ? AND value = ?").get(type, value) as
    | ProxyRow
    | undefined;
  if (existing && existing.user_id !== userId) throw new AppError("PROXY_TAKEN", `${value} is registered to someone else`);
  ctx.db
    .prepare(
      `INSERT INTO proxies (type, value, user_id, account_id) VALUES (?, ?, ?, ?)
       ON CONFLICT (type, value) DO UPDATE SET account_id = excluded.account_id`,
    )
    .run(type, value, userId, account.id);
  return ctx.db.prepare("SELECT * FROM proxies WHERE type = ? AND value = ?").get(type, value) as ProxyRow;
}

export function unlinkProxy(ctx: Ctx, userId: number, type: "MOBILE" | "EMAIL", value: string): void {
  const res = ctx.db.prepare("DELETE FROM proxies WHERE type = ? AND value = ? AND user_id = ?").run(type, value, userId);
  if (res.changes === 0) throw new AppError("NOT_FOUND", "Proxy not found");
}

export interface ResolvedRecipient {
  recipient: Recipient;
  account: AccountRow;
  user: UserRow;
}

export function parseRecipientOrThrow(input: string): Recipient {
  const r = parseRecipient(input);
  if (!r) throw new AppError("VALIDATION_ERROR", "Enter a UAE mobile number, email address or IBAN");
  return r;
}

/** Route a mobile number, email or IBAN to the account that should receive the money. */
export function resolveRecipient(ctx: Ctx, input: string): ResolvedRecipient {
  const recipient = parseRecipientOrThrow(input);
  let account: AccountRow | undefined;
  if (recipient.kind === "IBAN") {
    account = ctx.db.prepare("SELECT * FROM accounts WHERE iban = ?").get(recipient.value) as AccountRow | undefined;
  } else {
    const proxy = ctx.db
      .prepare("SELECT * FROM proxies WHERE type = ? AND value = ?")
      .get(recipient.kind, recipient.value) as ProxyRow | undefined;
    if (proxy) account = getAccount(ctx, proxy.account_id);
  }
  if (!account) throw new AppError("RECIPIENT_NOT_FOUND", `No account is registered for ${recipient.value}`);
  return { recipient, account, user: getUser(ctx, account.user_id) };
}

/** Confirmation-of-payee lookup shown before the payer confirms. */
export function lookupRecipient(ctx: Ctx, input: string) {
  const { recipient, account, user } = resolveRecipient(ctx, input);
  return {
    via: recipient.kind,
    value: recipient.value,
    name: maskName(user.name),
    bank: getBank(ctx, account.bank_code).name,
    iban: maskIban(account.iban),
  };
}
