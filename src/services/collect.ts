import type { Ctx } from "../context.js";
import { AppError } from "../errors.js";
import { paiseToRupees } from "../money.js";
import { getAccount, verifyPin } from "./accounts.js";
import { executeTransfer, type TxnRow } from "./payments.js";
import { getOwnedVpa, getVpa } from "./vpas.js";

export type CollectStatus = "PENDING" | "APPROVED" | "DECLINED" | "EXPIRED" | "FAILED";

export interface CollectRow {
  id: number;
  payee_vpa: string;
  payer_vpa: string;
  amount_paise: number;
  note: string | null;
  status: CollectStatus;
  txn_id: string | null;
  expires_at: string;
  created_at: string;
}

export function publicCollect(c: CollectRow) {
  return {
    id: c.id,
    payeeVpa: c.payee_vpa,
    payerVpa: c.payer_vpa,
    amount: paiseToRupees(c.amount_paise),
    amountPaise: c.amount_paise,
    note: c.note,
    status: c.status,
    txnId: c.txn_id,
    expiresAt: c.expires_at,
    createdAt: c.created_at,
  };
}

function expireStale(ctx: Ctx): void {
  ctx.db
    .prepare("UPDATE collect_requests SET status = 'EXPIRED' WHERE status = 'PENDING' AND expires_at <= ?")
    .run(ctx.now().toISOString());
}

function getCollect(ctx: Ctx, id: number): CollectRow {
  const c = ctx.db.prepare("SELECT * FROM collect_requests WHERE id = ?").get(id) as CollectRow | undefined;
  if (!c) throw new AppError("NOT_FOUND", "Collect request not found");
  return c;
}

/** Pull payment: the payee asks a payer VPA for money. The payer must approve with their PIN. */
export function createCollect(
  ctx: Ctx,
  userId: number,
  input: { payeeVpa: string; payerVpa: string; amountPaise: number; note?: string; expiresInMinutes?: number },
): CollectRow {
  const payee = getOwnedVpa(ctx, userId, input.payeeVpa);
  const payer = getVpa(ctx, input.payerVpa);
  if (payer.account_id === payee.account_id) {
    throw new AppError("SAME_ACCOUNT", "Payer and payee resolve to the same bank account");
  }
  if (input.amountPaise > ctx.config.limits.perTxnPaise) {
    throw new AppError("LIMIT_EXCEEDED", `Amount exceeds per-transaction limit of ₹${paiseToRupees(ctx.config.limits.perTxnPaise)}`);
  }
  const minutes = input.expiresInMinutes ?? ctx.config.collectDefaultExpiryMinutes;
  const now = ctx.now();
  const expiresAt = new Date(now.getTime() + minutes * 60_000).toISOString();
  const info = ctx.db
    .prepare(
      `INSERT INTO collect_requests (payee_vpa, payer_vpa, amount_paise, note, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, 'PENDING', ?, ?)`,
    )
    .run(payee.address, payer.address, input.amountPaise, input.note ?? null, expiresAt, now.toISOString());
  return getCollect(ctx, Number(info.lastInsertRowid));
}

export function listCollects(ctx: Ctx, userId: number, role: "incoming" | "outgoing"): CollectRow[] {
  expireStale(ctx);
  const column = role === "incoming" ? "payer_vpa" : "payee_vpa";
  return ctx.db
    .prepare(
      `SELECT c.* FROM collect_requests c JOIN vpas v ON v.address = c.${column}
       WHERE v.user_id = ? ORDER BY c.created_at DESC, c.id DESC LIMIT 100`,
    )
    .all(userId) as CollectRow[];
}

/** Load a collect request the user may act on as payer, and ensure it is still pending. */
function pendingForPayer(ctx: Ctx, userId: number, id: number): CollectRow {
  expireStale(ctx);
  const c = getCollect(ctx, id);
  const payer = getVpa(ctx, c.payer_vpa);
  if (payer.user_id !== userId) throw new AppError("NOT_FOUND", "Collect request not found");
  if (c.status === "EXPIRED") throw new AppError("COLLECT_EXPIRED", "Collect request has expired");
  if (c.status !== "PENDING") throw new AppError("COLLECT_NOT_PENDING", `Collect request is already ${c.status}`);
  return c;
}

export function approveCollect(ctx: Ctx, userId: number, id: number, pin: string): { collect: CollectRow; txn: TxnRow } {
  const c = pendingForPayer(ctx, userId, id);
  const payer = getVpa(ctx, c.payer_vpa);
  const payee = getVpa(ctx, c.payee_vpa);
  verifyPin(ctx, getAccount(ctx, payer.account_id), pin);

  const run = ctx.db.transaction(() => {
    // Claim the request first so two concurrent approvals cannot both pay.
    const claimed = ctx.db
      .prepare("UPDATE collect_requests SET status = 'APPROVED' WHERE id = ? AND status = 'PENDING' AND expires_at > ?")
      .run(c.id, ctx.now().toISOString());
    if (claimed.changes !== 1) throw new AppError("COLLECT_NOT_PENDING", "Collect request is no longer pending");
    const txn = executeTransfer(ctx, {
      type: "COLLECT",
      payer,
      payee,
      amountPaise: c.amount_paise,
      note: c.note ?? undefined,
      initiatedBy: userId,
      idempotencyKey: `collect:${c.id}`,
    });
    ctx.db
      .prepare("UPDATE collect_requests SET status = ?, txn_id = ? WHERE id = ?")
      .run(txn.status === "SUCCESS" ? "APPROVED" : "FAILED", txn.id, c.id);
    return txn;
  });
  const txn = run.immediate();
  return { collect: getCollect(ctx, c.id), txn };
}

export function declineCollect(ctx: Ctx, userId: number, id: number): CollectRow {
  const c = pendingForPayer(ctx, userId, id);
  ctx.db.prepare("UPDATE collect_requests SET status = 'DECLINED' WHERE id = ? AND status = 'PENDING'").run(c.id);
  return getCollect(ctx, c.id);
}
