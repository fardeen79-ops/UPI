import type { Ctx } from "../context.js";
import { AppError } from "../errors.js";
import { getBank, getOwnedAccount } from "./accounts.js";
import { getUser } from "./users.js";
import { maskName, normalizeVpa } from "../vpa.js";

export interface VpaRow {
  address: string;
  user_id: number;
  account_id: number;
  created_at: string;
}

export function createVpa(ctx: Ctx, userId: number, username: string, accountId: number): VpaRow {
  const account = getOwnedAccount(ctx, userId, accountId);
  const bank = getBank(ctx, account.bank_code);
  const address = `${username.toLowerCase()}@${bank.vpa_handle}`;
  if (ctx.db.prepare("SELECT 1 FROM vpas WHERE address = ?").get(address)) {
    throw new AppError("VPA_TAKEN", `${address} is already taken`);
  }
  ctx.db.prepare("INSERT INTO vpas (address, user_id, account_id) VALUES (?, ?, ?)").run(address, userId, account.id);
  return getVpa(ctx, address);
}

export function findVpa(ctx: Ctx, address: string): VpaRow | undefined {
  return ctx.db.prepare("SELECT * FROM vpas WHERE address = ?").get(normalizeVpa(address)) as VpaRow | undefined;
}

export function getVpa(ctx: Ctx, address: string): VpaRow {
  const vpa = findVpa(ctx, address);
  if (!vpa) throw new AppError("VPA_NOT_FOUND", `VPA ${normalizeVpa(address)} does not exist`);
  return vpa;
}

export function getOwnedVpa(ctx: Ctx, userId: number, address: string): VpaRow {
  const vpa = getVpa(ctx, address);
  if (vpa.user_id !== userId) throw new AppError("FORBIDDEN", `You do not own ${vpa.address}`);
  return vpa;
}

export function listVpas(ctx: Ctx, userId: number): VpaRow[] {
  return ctx.db.prepare("SELECT * FROM vpas WHERE user_id = ? ORDER BY created_at").all(userId) as VpaRow[];
}

/** Payee name lookup shown to the payer before they confirm a payment. */
export function resolveVpa(ctx: Ctx, address: string) {
  const vpa = getVpa(ctx, address);
  const user = getUser(ctx, vpa.user_id);
  return { address: vpa.address, name: maskName(user.name) };
}

export function publicVpa(v: VpaRow) {
  return { address: v.address, accountId: v.account_id, createdAt: v.created_at };
}
