import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import type { Ctx } from "./context.js";
import { AppError } from "./errors.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: number;
    }
  }
}

export function issueToken(ctx: Ctx, userId: number): string {
  return jwt.sign({}, ctx.config.jwtSecret, {
    subject: String(userId),
    expiresIn: ctx.config.jwtTtl as jwt.SignOptions["expiresIn"],
  });
}

export function requireAuth(ctx: Ctx) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) return next(new AppError("UNAUTHORIZED", "Missing bearer token"));
    try {
      const payload = jwt.verify(token, ctx.config.jwtSecret) as jwt.JwtPayload;
      const userId = Number(payload.sub);
      if (!Number.isSafeInteger(userId)) throw new Error("bad subject");
      const exists = ctx.db.prepare("SELECT 1 FROM users WHERE id = ?").get(userId);
      if (!exists) throw new Error("unknown user");
      req.userId = userId;
      next();
    } catch {
      next(new AppError("UNAUTHORIZED", "Invalid or expired token"));
    }
  };
}

/** userId is guaranteed to be set on routes behind requireAuth. */
export function uid(req: Request): number {
  if (req.userId === undefined) throw new AppError("UNAUTHORIZED", "Not authenticated");
  return req.userId;
}
