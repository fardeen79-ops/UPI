import type { Ctx } from "../context.js";
import { AppError, type ErrorCode } from "../errors.js";
import { maskIban } from "../identifiers.js";
import { filsToAed } from "../money.js";
import { generateReference } from "../security.js";
import { getAccount, resolveOwnedAccount, type AccountRow } from "./accounts.js";
import { resolveRecipient } from "./proxies.js";
import { getUser, verifyPasscode } from "./users.js";

export interface TxnRow {
  id: string;
  type: "TRANSFER" | "REQUEST";
  status: "SUCCESS" | "FAILED";
  payer_account_id: number;
  payee_account_id: number;
  payee_via: "MOBILE" | "EMAIL" | "IBAN";
  payee_label: string;
  amount_fils: number;
  note: string | null;
  failure_code: string | null;
  failure_message: string | null;
  initiated_by: number;
  idempotency_key: string | null;
  created_at: string;
}

const GST_OFFSET_MS = 4 * 60 * 60 * 1000;

/** Start of the current calendar day in the UAE (Gulf Standard Time, UTC+4), as ISO UTC. Limits reset then. */
export function startOfGstDay(now: Date): string {
  const gst = new Date(now.getTime() + GST_OFFSET_MS);
  gst.setUTCHours(0, 0, 0, 0);
  return new Date(gst.getTime() - GST_OFFSET_MS).toISOString();
}

export function getTxn(ctx: Ctx, id: string): TxnRow {
  const t = ctx.db.prepare("SELECT * FROM transactions WHERE id = ?").get(id) as TxnRow | undefined;
  if (!t) throw new AppError("NOT_FOUND", "Transaction not found");
  return t;
}

/** Transaction as seen by a particular user; direction and counterparty are relative to them. */
export function publicTxn(ctx: Ctx, t: TxnRow, userId: number) {
  const payer = getAccount(ctx, t.payer_account_id);
  const payee = getAccount(ctx, t.payee_account_id);
  const isPayer = payer.user_id === userId;
  const isPayee = payee.user_id === userId;
  const direction = isPayer && isPayee ? "SELF" : isPayer ? "DEBIT" : "CREDIT";
  const other = direction === "CREDIT" ? payer : payee;
  return {
    id: t.id,
    type: t.type,
    status: t.status,
    direction,
    counterparty: {
      name: getUser(ctx, other.user_id).name,
      // The payer sees how they addressed the payee; the payee sees a masked payer IBAN.
      label: direction === "CREDIT" ? maskIban(payer.iban) : t.payee_label,
    },
    accountId: direction === "CREDIT" ? payee.id : payer.id,
    amount: filsToAed(t.amount_fils),
    amountFils: t.amount_fils,
    currency: "AED",
    note: t.note,
    failure: t.failure_code ? { code: t.failure_code, message: t.failure_message } : null,
    createdAt: t.created_at,
  };
}

const VISIBLE_SQL = `
  (t.payer_account_id IN (SELECT id FROM accounts WHERE user_id = @userId)
   OR (t.status = 'SUCCESS' AND t.payee_account_id IN (SELECT id FROM accounts WHERE user_id = @userId)))`;

export function getUserTxn(ctx: Ctx, userId: number, id: string): TxnRow {
  const t = ctx.db.prepare(`SELECT t.* FROM transactions t WHERE t.id = @id AND ${VISIBLE_SQL}`).get({ id, userId }) as
    | TxnRow
    | undefined;
  if (!t) throw new AppError("NOT_FOUND", "Transaction not found");
  return t;
}

/** Payers see all their attempts; payees only see money that actually arrived. */
export function listUserTxns(ctx: Ctx, userId: number, opts: { limit: number; before?: string }): TxnRow[] {
  return ctx.db
    .prepare(
      `SELECT t.* FROM transactions t WHERE ${VISIBLE_SQL}
       ${opts.before ? "AND t.created_at < @before" : ""}
       ORDER BY t.created_at DESC, t.id DESC LIMIT @limit`,
    )
    .all({ userId, limit: opts.limit, before: opts.before }) as TxnRow[];
}

interface TransferInput {
  type: "TRANSFER" | "REQUEST";
  payer: AccountRow;
  payee: AccountRow;
  via: TxnRow["payee_via"];
  label: string;
  amountFils: number;
  note?: string;
  initiatedBy: number;
  idempotencyKey?: string;
}

/**
 * Move money between two accounts atomically. Business-rule failures (insufficient funds,
 * limits) are recorded as FAILED transactions rather than thrown, so the payer always has a
 * reference. The caller must already have verified the payer's passcode.
 */
export function executeTransfer(ctx: Ctx, input: TransferInput): TxnRow {
  const { db, config } = ctx;
  const run = db.transaction((): TxnRow => {
    const now = ctx.now();
    const nowIso = now.toISOString();
    const payer = getAccount(ctx, input.payer.id);
    const payee = getAccount(ctx, input.payee.id);

    let failure: { code: ErrorCode; message: string } | null = null;
    if (input.amountFils > config.limits.perTxnFils) {
      failure = { code: "LIMIT_EXCEEDED", message: `Amount exceeds the per-transfer limit of AED ${filsToAed(config.limits.perTxnFils)}` };
    } else {
      const today = db
        .prepare(
          `SELECT COALESCE(SUM(amount_fils), 0) AS total, COUNT(*) AS count FROM transactions
           WHERE payer_account_id = ? AND status = 'SUCCESS' AND created_at >= ?`,
        )
        .get(payer.id, startOfGstDay(now)) as { total: number; count: number };
      if (today.count >= config.limits.dailyCount) {
        failure = { code: "LIMIT_EXCEEDED", message: `Daily limit of ${config.limits.dailyCount} transfers reached` };
      } else if (today.total + input.amountFils > config.limits.dailyFils) {
        failure = { code: "LIMIT_EXCEEDED", message: `Amount exceeds the daily limit of AED ${filsToAed(config.limits.dailyFils)}` };
      } else if (payer.balance_fils < input.amountFils) {
        failure = { code: "INSUFFICIENT_FUNDS", message: "Insufficient balance" };
      }
    }

    let id: string;
    do id = generateReference(now);
    while (db.prepare("SELECT 1 FROM transactions WHERE id = ?").get(id));
    db.prepare(
      `INSERT INTO transactions
         (id, type, status, payer_account_id, payee_account_id, payee_via, payee_label, amount_fils, note,
          failure_code, failure_message, initiated_by, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.type,
      failure ? "FAILED" : "SUCCESS",
      payer.id,
      payee.id,
      input.via,
      input.label,
      input.amountFils,
      input.note ?? null,
      failure?.code ?? null,
      failure?.message ?? null,
      input.initiatedBy,
      input.idempotencyKey ?? null,
      nowIso,
    );
    if (failure) return getTxn(ctx, id);

    // Guarded debit: the balance can never go negative even if a check above were wrong.
    const debited = db
      .prepare("UPDATE accounts SET balance_fils = balance_fils - ? WHERE id = ? AND balance_fils >= ?")
      .run(input.amountFils, payer.id, input.amountFils);
    if (debited.changes !== 1) throw new Error("Invariant violated: debit failed after balance check");
    db.prepare("UPDATE accounts SET balance_fils = balance_fils + ? WHERE id = ?").run(input.amountFils, payee.id);

    const ledger = db.prepare(
      `INSERT INTO ledger_entries (txn_id, account_id, direction, amount_fils, balance_after, created_at)
       VALUES (?, ?, ?, ?, (SELECT balance_fils FROM accounts WHERE id = ?), ?)`,
    );
    ledger.run(id, payer.id, "DEBIT", input.amountFils, payer.id, nowIso);
    ledger.run(id, payee.id, "CREDIT", input.amountFils, payee.id, nowIso);
    return getTxn(ctx, id);
  });
  return run.immediate();
}

export interface SendInput {
  fromAccountId?: number;
  to: string;
  amountFils: number;
  note?: string;
  passcode: string;
  idempotencyKey?: string;
}

/** Send money to a mobile number, email or IBAN. */
export function sendMoney(ctx: Ctx, userId: number, input: SendInput): { txn: TxnRow; replayed: boolean } {
  const payer = resolveOwnedAccount(ctx, userId, input.fromAccountId);
  const { recipient, account: payee } = resolveRecipient(ctx, input.to);

  if (input.idempotencyKey) {
    const existing = ctx.db
      .prepare("SELECT * FROM transactions WHERE initiated_by = ? AND idempotency_key = ?")
      .get(userId, input.idempotencyKey) as TxnRow | undefined;
    if (existing) {
      const same =
        existing.type === "TRANSFER" &&
        existing.payer_account_id === payer.id &&
        existing.payee_account_id === payee.id &&
        existing.amount_fils === input.amountFils &&
        (existing.note ?? undefined) === input.note;
      if (!same) throw new AppError("IDEMPOTENCY_MISMATCH", "Idempotency-Key was already used with different parameters");
      return { txn: existing, replayed: true };
    }
  }

  if (payer.id === payee.id) throw new AppError("SAME_ACCOUNT", "You cannot send money to the same account");
  verifyPasscode(ctx, userId, input.passcode);

  const txn = executeTransfer(ctx, {
    type: "TRANSFER",
    payer,
    payee,
    via: recipient.kind,
    label: recipient.value,
    amountFils: input.amountFils,
    note: input.note,
    initiatedBy: userId,
    idempotencyKey: input.idempotencyKey,
  });
  return { txn, replayed: false };
}
