import type { Ctx } from "../context.js";
import { AppError } from "../errors.js";
import { maskEmiratesId } from "../identifiers.js";
import { hashSecret, verifySecret } from "../security.js";

export interface UserRow {
  id: number;
  mobile: string;
  name: string;
  emirates_id: string | null;
  password_hash: string;
  passcode_hash: string | null;
  passcode_failed_count: number;
  passcode_locked_until: string | null;
  created_at: string;
}

export function publicUser(u: UserRow) {
  return {
    id: u.id,
    mobile: u.mobile,
    name: u.name,
    emiratesId: u.emirates_id ? maskEmiratesId(u.emirates_id) : null,
    passcodeSet: u.passcode_hash !== null,
    createdAt: u.created_at,
  };
}

export function registerUser(
  ctx: Ctx,
  input: { mobile: string; name: string; password: string; emiratesId?: string },
): UserRow {
  if (ctx.db.prepare("SELECT 1 FROM users WHERE mobile = ?").get(input.mobile)) {
    throw new AppError("CONFLICT", "A user with this mobile number already exists");
  }
  if (input.emiratesId && ctx.db.prepare("SELECT 1 FROM users WHERE emirates_id = ?").get(input.emiratesId)) {
    throw new AppError("CONFLICT", "This Emirates ID is already registered");
  }
  const info = ctx.db
    .prepare("INSERT INTO users (mobile, name, emirates_id, password_hash) VALUES (?, ?, ?, ?)")
    .run(input.mobile, input.name.trim(), input.emiratesId ?? null, hashSecret(input.password));
  return getUser(ctx, Number(info.lastInsertRowid));
}

export function authenticate(ctx: Ctx, mobile: string, password: string): UserRow {
  const user = ctx.db.prepare("SELECT * FROM users WHERE mobile = ?").get(mobile) as UserRow | undefined;
  if (!user || !verifySecret(password, user.password_hash)) {
    throw new AppError("UNAUTHORIZED", "Invalid mobile number or password");
  }
  return user;
}

export function getUser(ctx: Ctx, id: number): UserRow {
  const user = ctx.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  if (!user) throw new AppError("NOT_FOUND", "User not found");
  return user;
}

export function setPasscode(ctx: Ctx, userId: number, passcode: string, oldPasscode?: string): void {
  const user = getUser(ctx, userId);
  if (user.passcode_hash !== null) {
    if (oldPasscode === undefined) {
      throw new AppError("PASSCODE_ALREADY_SET", "Payment passcode already set; provide oldPasscode to change it");
    }
    verifyPasscode(ctx, userId, oldPasscode);
  }
  ctx.db
    .prepare("UPDATE users SET passcode_hash = ?, passcode_failed_count = 0, passcode_locked_until = NULL WHERE id = ?")
    .run(hashSecret(passcode), userId);
}

/**
 * Verify the payment passcode (the simulator's stand-in for the bank app's strong customer
 * authentication), counting failures and locking after too many. Call it outside any DB
 * transaction that may roll back, so failed attempts are always persisted.
 */
export function verifyPasscode(ctx: Ctx, userId: number, passcode: string): void {
  const user = getUser(ctx, userId);
  if (user.passcode_hash === null) throw new AppError("PASSCODE_NOT_SET", "Set a payment passcode first");
  const now = ctx.now();
  if (user.passcode_locked_until && new Date(user.passcode_locked_until) > now) {
    throw new AppError("PASSCODE_LOCKED", "Passcode is locked due to too many incorrect attempts", {
      lockedUntil: user.passcode_locked_until,
    });
  }
  if (verifySecret(passcode, user.passcode_hash)) {
    if (user.passcode_failed_count !== 0 || user.passcode_locked_until !== null) {
      ctx.db.prepare("UPDATE users SET passcode_failed_count = 0, passcode_locked_until = NULL WHERE id = ?").run(userId);
    }
    return;
  }
  const failed = user.passcode_failed_count + 1;
  const { maxAttempts, lockMinutes } = ctx.config.passcode;
  if (failed >= maxAttempts) {
    const lockedUntil = new Date(now.getTime() + lockMinutes * 60_000).toISOString();
    ctx.db
      .prepare("UPDATE users SET passcode_failed_count = 0, passcode_locked_until = ? WHERE id = ?")
      .run(lockedUntil, userId);
    throw new AppError("PASSCODE_LOCKED", "Incorrect passcode. Passcode is now locked due to too many attempts", {
      lockedUntil,
    });
  }
  ctx.db.prepare("UPDATE users SET passcode_failed_count = ? WHERE id = ?").run(failed, userId);
  throw new AppError("INVALID_PASSCODE", "Incorrect passcode", { attemptsRemaining: maxAttempts - failed });
}
