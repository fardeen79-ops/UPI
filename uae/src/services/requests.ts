import type { Ctx } from "../context.js";
import { AppError } from "../errors.js";
import { maskName } from "../identifiers.js";
import { filsToAed } from "../money.js";
import { getAccount, resolveOwnedAccount } from "./accounts.js";
import { executeTransfer, type TxnRow } from "./payments.js";
import { parseRecipientOrThrow, resolveRecipient } from "./proxies.js";
import { getUser, verifyPasscode } from "./users.js";

export type RequestStatus = "PENDING" | "PAID" | "DECLINED" | "EXPIRED" | "CANCELLED" | "FAILED";

export interface RequestRow {
  id: number;
  requester_id: number;
  payee_account_id: number;
  payer_id: number;
  payer_label: string;
  amount_fils: number;
  note: string | null;
  split_id: number | null;
  status: RequestStatus;
  txn_id: string | null;
  expires_at: string;
  created_at: string;
}

export interface SplitRow {
  id: number;
  requester_id: number;
  payee_account_id: number;
  total_fils: number;
  note: string | null;
  created_at: string;
}

export function publicRequest(ctx: Ctx, r: RequestRow) {
  return {
    id: r.id,
    requester: { name: getUser(ctx, r.requester_id).name },
    payer: { label: r.payer_label, name: maskName(getUser(ctx, r.payer_id).name) },
    amount: filsToAed(r.amount_fils),
    amountFils: r.amount_fils,
    currency: "AED",
    note: r.note,
    splitId: r.split_id,
    status: r.status,
    txnId: r.txn_id,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  };
}

function expireStale(ctx: Ctx): void {
  ctx.db
    .prepare("UPDATE payment_requests SET status = 'EXPIRED' WHERE status = 'PENDING' AND expires_at <= ?")
    .run(ctx.now().toISOString());
}

function getRequest(ctx: Ctx, id: number): RequestRow {
  const r = ctx.db.prepare("SELECT * FROM payment_requests WHERE id = ?").get(id) as RequestRow | undefined;
  if (!r) throw new AppError("NOT_FOUND", "Payment request not found");
  return r;
}

interface NewRequest {
  from: string; // payer's mobile number or email
  amountFils: number;
  note?: string;
  toAccountId?: number;
  expiresInMinutes?: number;
}

function insertRequest(ctx: Ctx, userId: number, input: NewRequest, splitId: number | null): number {
  const recipient = parseRecipientOrThrow(input.from);
  if (recipient.kind === "IBAN") throw new AppError("VALIDATION_ERROR", "Request money from a mobile number or email, not an IBAN");
  const payee = resolveOwnedAccount(ctx, userId, input.toAccountId);
  const payer = resolveRecipient(ctx, input.from).user;
  if (payer.id === userId) throw new AppError("SAME_ACCOUNT", "You cannot request money from yourself");
  if (input.amountFils > ctx.config.limits.perTxnFils) {
    throw new AppError("LIMIT_EXCEEDED", `Amount exceeds the per-transfer limit of AED ${filsToAed(ctx.config.limits.perTxnFils)}`);
  }
  const now = ctx.now();
  const minutes = input.expiresInMinutes ?? ctx.config.requestDefaultExpiryMinutes;
  const info = ctx.db
    .prepare(
      `INSERT INTO payment_requests
         (requester_id, payee_account_id, payer_id, payer_label, amount_fils, note, split_id, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
    )
    .run(
      userId,
      payee.id,
      payer.id,
      recipient.value,
      input.amountFils,
      input.note ?? null,
      splitId,
      new Date(now.getTime() + minutes * 60_000).toISOString(),
      now.toISOString(),
    );
  return Number(info.lastInsertRowid);
}

export function createRequest(ctx: Ctx, userId: number, input: NewRequest): RequestRow {
  return getRequest(ctx, insertRequest(ctx, userId, input, null));
}

export function listRequests(ctx: Ctx, userId: number, role: "incoming" | "outgoing"): RequestRow[] {
  expireStale(ctx);
  const column = role === "incoming" ? "payer_id" : "requester_id";
  return ctx.db
    .prepare(`SELECT * FROM payment_requests WHERE ${column} = ? ORDER BY created_at DESC, id DESC LIMIT 100`)
    .all(userId) as RequestRow[];
}

function pendingFor(ctx: Ctx, userId: number, id: number, role: "payer" | "requester"): RequestRow {
  expireStale(ctx);
  const r = getRequest(ctx, id);
  if ((role === "payer" ? r.payer_id : r.requester_id) !== userId) throw new AppError("NOT_FOUND", "Payment request not found");
  if (r.status === "EXPIRED") throw new AppError("REQUEST_EXPIRED", "This payment request has expired");
  if (r.status !== "PENDING") throw new AppError("REQUEST_NOT_PENDING", `This payment request is already ${r.status}`);
  return r;
}

export function payRequest(
  ctx: Ctx,
  userId: number,
  id: number,
  input: { passcode: string; fromAccountId?: number },
): { request: RequestRow; txn: TxnRow } {
  const r = pendingFor(ctx, userId, id, "payer");
  const payer = resolveOwnedAccount(ctx, userId, input.fromAccountId);
  const payee = getAccount(ctx, r.payee_account_id);
  verifyPasscode(ctx, userId, input.passcode);

  const run = ctx.db.transaction(() => {
    // Claim the request first so two concurrent approvals cannot both pay.
    const claimed = ctx.db
      .prepare("UPDATE payment_requests SET status = 'PAID' WHERE id = ? AND status = 'PENDING' AND expires_at > ?")
      .run(r.id, ctx.now().toISOString());
    if (claimed.changes !== 1) throw new AppError("REQUEST_NOT_PENDING", "This payment request is no longer pending");
    const txn = executeTransfer(ctx, {
      type: "REQUEST",
      payer,
      payee,
      via: "MOBILE",
      label: getUser(ctx, r.requester_id).mobile,
      amountFils: r.amount_fils,
      note: r.note ?? undefined,
      initiatedBy: userId,
      idempotencyKey: `request:${r.id}`,
    });
    ctx.db
      .prepare("UPDATE payment_requests SET status = ?, txn_id = ? WHERE id = ?")
      .run(txn.status === "SUCCESS" ? "PAID" : "FAILED", txn.id, r.id);
    return txn;
  });
  const txn = run.immediate();
  return { request: getRequest(ctx, r.id), txn };
}

export function declineRequest(ctx: Ctx, userId: number, id: number): RequestRow {
  const r = pendingFor(ctx, userId, id, "payer");
  ctx.db.prepare("UPDATE payment_requests SET status = 'DECLINED' WHERE id = ? AND status = 'PENDING'").run(r.id);
  return getRequest(ctx, r.id);
}

export function cancelRequest(ctx: Ctx, userId: number, id: number): RequestRow {
  const r = pendingFor(ctx, userId, id, "requester");
  ctx.db.prepare("UPDATE payment_requests SET status = 'CANCELLED' WHERE id = ? AND status = 'PENDING'").run(r.id);
  return getRequest(ctx, r.id);
}

// ---- Split bills -----------------------------------------------------------

export interface SplitInput {
  totalFils?: number; // required for EQUAL
  mode: "EQUAL" | "CUSTOM";
  includeSelf: boolean; // EQUAL only: the requester also bears a share
  participants: { who: string; amountFils?: number }[];
  note?: string;
  toAccountId?: number;
  expiresInMinutes?: number;
}

/** Divide `total` into `n` shares that differ by at most one fil, larger shares first. */
export function equalShares(total: number, n: number): number[] {
  const base = Math.floor(total / n);
  const extra = total % n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

/** Split a bill: one request-to-pay per participant, grouped under a split. */
export function createSplit(ctx: Ctx, userId: number, input: SplitInput) {
  const { participants } = input;
  if (participants.length === 0) throw new AppError("VALIDATION_ERROR", "Add at least one person to split with");
  if (participants.length > ctx.config.maxSplitParticipants) {
    throw new AppError("VALIDATION_ERROR", `You can split with at most ${ctx.config.maxSplitParticipants} people`);
  }
  const seen = new Set<number>();
  for (const p of participants) {
    const payer = resolveRecipient(ctx, p.who).user;
    if (seen.has(payer.id)) throw new AppError("VALIDATION_ERROR", `${p.who} is listed more than once`);
    seen.add(payer.id);
  }

  let amounts: number[];
  let total: number;
  if (input.mode === "EQUAL") {
    if (input.totalFils === undefined) throw new AppError("VALIDATION_ERROR", "total is required for an equal split");
    total = input.totalFils;
    const shares = equalShares(total, participants.length + (input.includeSelf ? 1 : 0));
    // If the requester shares the bill, they keep the last (smallest) share.
    amounts = shares.slice(0, participants.length);
    if (amounts.some((a) => a <= 0)) throw new AppError("VALIDATION_ERROR", "Total is too small to split");
  } else {
    if (participants.some((p) => p.amountFils === undefined)) {
      throw new AppError("VALIDATION_ERROR", "Every participant needs an amount for a custom split");
    }
    amounts = participants.map((p) => p.amountFils!);
    total = input.totalFils ?? amounts.reduce((a, b) => a + b, 0);
    if (amounts.reduce((a, b) => a + b, 0) > total) {
      throw new AppError("VALIDATION_ERROR", "Participants' amounts add up to more than the total");
    }
  }

  const payee = resolveOwnedAccount(ctx, userId, input.toAccountId);
  const run = ctx.db.transaction(() => {
    const info = ctx.db
      .prepare("INSERT INTO splits (requester_id, payee_account_id, total_fils, note, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(userId, payee.id, total, input.note ?? null, ctx.now().toISOString());
    const splitId = Number(info.lastInsertRowid);
    participants.forEach((p, i) =>
      insertRequest(
        ctx,
        userId,
        { from: p.who, amountFils: amounts[i]!, note: input.note, toAccountId: payee.id, expiresInMinutes: input.expiresInMinutes },
        splitId,
      ),
    );
    return splitId;
  });
  return getSplit(ctx, userId, run());
}

export function getSplit(ctx: Ctx, userId: number, id: number) {
  expireStale(ctx);
  const s = ctx.db.prepare("SELECT * FROM splits WHERE id = ? AND requester_id = ?").get(id, userId) as SplitRow | undefined;
  if (!s) throw new AppError("NOT_FOUND", "Split not found");
  const requests = ctx.db.prepare("SELECT * FROM payment_requests WHERE split_id = ? ORDER BY id").all(id) as RequestRow[];
  const collected = requests.filter((r) => r.status === "PAID").reduce((a, r) => a + r.amount_fils, 0);
  return {
    id: s.id,
    total: filsToAed(s.total_fils),
    totalFils: s.total_fils,
    collected: filsToAed(collected),
    collectedFils: collected,
    note: s.note,
    requests: requests.map((r) => publicRequest(ctx, r)),
    createdAt: s.created_at,
  };
}

export function listSplits(ctx: Ctx, userId: number) {
  const ids = ctx.db
    .prepare("SELECT id FROM splits WHERE requester_id = ? ORDER BY created_at DESC, id DESC LIMIT 50")
    .all(userId) as { id: number }[];
  return ids.map(({ id }) => getSplit(ctx, userId, id));
}
