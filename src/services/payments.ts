import type { Ctx } from "../context.js";
import { AppError, type ErrorCode } from "../errors.js";
import { paiseToRupees } from "../money.js";
import { generateRrn } from "../security.js";
import { getAccount, verifyPin } from "./accounts.js";
import { getOwnedVpa, getVpa, type VpaRow } from "./vpas.js";

export type TxnStatus = "PENDING" | "SUCCESS" | "FAILED";

export interface TxnRow {
  id: string;
  type: "PAY" | "COLLECT";
  status: TxnStatus;
  payer_vpa: string;
  payee_vpa: string;
  payer_account_id: number | null;
  payee_account_id: number | null;
  amount_paise: number;
  note: string | null;
  failure_code: string | null;
  failure_message: string | null;
  initiated_by: number;
  idempotency_key: string | null;
  created_at: string;
  completed_at: string | null;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Start of the current calendar day in India (IST), as an ISO UTC timestamp. Limits reset at IST midnight. */
export function startOfIstDay(now: Date): string {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - IST_OFFSET_MS).toISOString();
}

export function getTxn(ctx: Ctx, id: string): TxnRow {
  const t = ctx.db.prepare("SELECT * FROM transactions WHERE id = ?").get(id) as TxnRow | undefined;
  if (!t) throw new AppError("NOT_FOUND", "Transaction not found");
  return t;
}

function userAccountIds(ctx: Ctx, userId: number): number[] {
  return (ctx.db.prepare("SELECT id FROM accounts WHERE user_id = ?").all(userId) as { id: number }[]).map((r) => r.id);
}

/** Transaction as seen by a particular user; direction is relative to them. */
export function publicTxn(ctx: Ctx, t: TxnRow, userId: number) {
  const mine = new Set(userAccountIds(ctx, userId));
  const isPayer = t.payer_account_id !== null && mine.has(t.payer_account_id);
  const isPayee = t.payee_account_id !== null && mine.has(t.payee_account_id);
  return {
    id: t.id,
    type: t.type,
    status: t.status,
    direction: isPayer && isPayee ? "SELF" : isPayer ? "DEBIT" : "CREDIT",
    payerVpa: t.payer_vpa,
    payeeVpa: t.payee_vpa,
    amount: paiseToRupees(t.amount_paise),
    amountPaise: t.amount_paise,
    note: t.note,
    failure: t.failure_code ? { code: t.failure_code, message: t.failure_message } : null,
    createdAt: t.created_at,
    completedAt: t.completed_at,
  };
}

export function getUserTxn(ctx: Ctx, userId: number, id: string): TxnRow {
  const t = getTxn(ctx, id);
  const mine = new Set(userAccountIds(ctx, userId));
  const visible =
    (t.payer_account_id !== null && mine.has(t.payer_account_id)) ||
    (t.status === "SUCCESS" && t.payee_account_id !== null && mine.has(t.payee_account_id));
  if (!visible) throw new AppError("NOT_FOUND", "Transaction not found");
  return t;
}

export function listUserTxns(ctx: Ctx, userId: number, opts: { limit: number; before?: string }): TxnRow[] {
  // Payers see all their attempts; payees only see money that actually arrived.
  const sql = `
    SELECT t.* FROM transactions t
    WHERE (t.payer_account_id IN (SELECT id FROM accounts WHERE user_id = @userId)
        OR (t.status = 'SUCCESS' AND t.payee_account_id IN (SELECT id FROM accounts WHERE user_id = @userId)))
      ${opts.before ? "AND t.created_at < @before" : ""}
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT @limit`;
  return ctx.db.prepare(sql).all({ userId, limit: opts.limit, before: opts.before }) as TxnRow[];
}

interface TransferInput {
  type: "PAY" | "COLLECT";
  payer: VpaRow;
  payee: VpaRow;
  amountPaise: number;
  note?: string;
  initiatedBy: number;
  idempotencyKey?: string;
}

/**
 * Move money between the accounts behind two VPAs, atomically.
 *
 * Business-rule failures (insufficient funds, limits) do not throw: they are recorded as
 * a FAILED transaction so the payer has a reference and history entry, like real UPI.
 * The caller must already have verified the payer's UPI PIN.
 */
export function executeTransfer(ctx: Ctx, input: TransferInput): TxnRow {
  const { db, config } = ctx;
  const run = db.transaction((): TxnRow => {
    const now = ctx.now();
    const nowIso = now.toISOString();
    const payerAccount = getAccount(ctx, input.payer.account_id);
    const payeeAccount = getAccount(ctx, input.payee.account_id);

    let failure: { code: ErrorCode; message: string } | null = null;
    if (input.amountPaise > config.limits.perTxnPaise) {
      failure = { code: "LIMIT_EXCEEDED", message: `Amount exceeds per-transaction limit of ₹${paiseToRupees(config.limits.perTxnPaise)}` };
    } else {
      const today = db
        .prepare(
          `SELECT COALESCE(SUM(amount_paise), 0) AS total, COUNT(*) AS count FROM transactions
           WHERE payer_account_id = ? AND status = 'SUCCESS' AND created_at >= ?`,
        )
        .get(payerAccount.id, startOfIstDay(now)) as { total: number; count: number };
      if (today.count >= config.limits.dailyCount) {
        failure = { code: "LIMIT_EXCEEDED", message: `Daily limit of ${config.limits.dailyCount} transactions reached` };
      } else if (today.total + input.amountPaise > config.limits.dailyPaise) {
        failure = { code: "LIMIT_EXCEEDED", message: `Amount exceeds daily limit of ₹${paiseToRupees(config.limits.dailyPaise)}` };
      } else if (payerAccount.balance_paise < input.amountPaise) {
        failure = { code: "INSUFFICIENT_FUNDS", message: "Insufficient balance in payer account" };
      }
    }

    const id = generateRrn();
    db.prepare(
      `INSERT INTO transactions
         (id, type, status, payer_vpa, payee_vpa, payer_account_id, payee_account_id, amount_paise, note,
          failure_code, failure_message, initiated_by, idempotency_key, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.type,
      failure ? "FAILED" : "SUCCESS",
      input.payer.address,
      input.payee.address,
      payerAccount.id,
      payeeAccount.id,
      input.amountPaise,
      input.note ?? null,
      failure?.code ?? null,
      failure?.message ?? null,
      input.initiatedBy,
      input.idempotencyKey ?? null,
      nowIso,
      nowIso,
    );
    if (failure) return getTxn(ctx, id);

    // Guarded debit: even if a check above were wrong, the balance can never go negative.
    const debited = db
      .prepare("UPDATE accounts SET balance_paise = balance_paise - ? WHERE id = ? AND balance_paise >= ?")
      .run(input.amountPaise, payerAccount.id, input.amountPaise);
    if (debited.changes !== 1) throw new Error("Invariant violated: debit failed after balance check");
    db.prepare("UPDATE accounts SET balance_paise = balance_paise + ? WHERE id = ?").run(input.amountPaise, payeeAccount.id);

    const ledger = db.prepare(
      `INSERT INTO ledger_entries (txn_id, account_id, direction, amount_paise, balance_after, created_at)
       VALUES (?, ?, ?, ?, (SELECT balance_paise FROM accounts WHERE id = ?), ?)`,
    );
    ledger.run(id, payerAccount.id, "DEBIT", input.amountPaise, payerAccount.id, nowIso);
    ledger.run(id, payeeAccount.id, "CREDIT", input.amountPaise, payeeAccount.id, nowIso);
    return getTxn(ctx, id);
  });
  return run.immediate();
}

export interface PayInput {
  fromVpa: string;
  toVpa: string;
  amountPaise: number;
  note?: string;
  pin: string;
  idempotencyKey?: string;
}

/** Push payment: the payer sends money to a payee VPA, authorised with their UPI PIN. */
export function pay(ctx: Ctx, userId: number, input: PayInput): { txn: TxnRow; replayed: boolean } {
  if (input.idempotencyKey) {
    const existing = ctx.db
      .prepare("SELECT * FROM transactions WHERE initiated_by = ? AND idempotency_key = ?")
      .get(userId, input.idempotencyKey) as TxnRow | undefined;
    if (existing) {
      const same =
        existing.type === "PAY" &&
        existing.payer_vpa === input.fromVpa &&
        existing.payee_vpa === input.toVpa &&
        existing.amount_paise === input.amountPaise &&
        (existing.note ?? undefined) === input.note;
      if (!same) throw new AppError("IDEMPOTENCY_MISMATCH", "Idempotency-Key was already used with different parameters");
      return { txn: existing, replayed: true };
    }
  }

  const payer = getOwnedVpa(ctx, userId, input.fromVpa);
  const payee = getVpa(ctx, input.toVpa);
  if (payer.account_id === payee.account_id) {
    throw new AppError("SAME_ACCOUNT", "Payer and payee resolve to the same bank account");
  }
  verifyPin(ctx, getAccount(ctx, payer.account_id), input.pin);

  const txn = executeTransfer(ctx, {
    type: "PAY",
    payer,
    payee,
    amountPaise: input.amountPaise,
    note: input.note,
    initiatedBy: userId,
    idempotencyKey: input.idempotencyKey,
  });
  return { txn, replayed: false };
}
