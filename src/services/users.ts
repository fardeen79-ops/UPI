import type { Ctx } from "../context.js";
import { AppError } from "../errors.js";
import { hashSecret, verifySecret } from "../security.js";

export interface UserRow {
  id: number;
  phone: string;
  name: string;
  password_hash: string;
  created_at: string;
}

export function publicUser(u: UserRow) {
  return { id: u.id, phone: u.phone, name: u.name, createdAt: u.created_at };
}

export function registerUser(ctx: Ctx, input: { phone: string; name: string; password: string }): UserRow {
  const exists = ctx.db.prepare("SELECT 1 FROM users WHERE phone = ?").get(input.phone);
  if (exists) throw new AppError("CONFLICT", "A user with this phone number already exists");
  const info = ctx.db
    .prepare("INSERT INTO users (phone, name, password_hash) VALUES (?, ?, ?)")
    .run(input.phone, input.name.trim(), hashSecret(input.password));
  return getUser(ctx, Number(info.lastInsertRowid));
}

export function authenticate(ctx: Ctx, phone: string, password: string): UserRow {
  const user = ctx.db.prepare("SELECT * FROM users WHERE phone = ?").get(phone) as UserRow | undefined;
  if (!user || !verifySecret(password, user.password_hash)) {
    throw new AppError("UNAUTHORIZED", "Invalid phone number or password");
  }
  return user;
}

export function getUser(ctx: Ctx, id: number): UserRow {
  const user = ctx.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  if (!user) throw new AppError("NOT_FOUND", "User not found");
  return user;
}
