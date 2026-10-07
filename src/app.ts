import express, { type NextFunction, type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { z } from "zod";
import { issueToken, requireAuth, uid } from "./auth.js";
import type { Ctx } from "./context.js";
import { AppError } from "./errors.js";
import { rupeesToPaise } from "./money.js";
import {
  checkBalance,
  getOwnedAccount,
  linkAccount,
  listAccounts,
  listBanks,
  publicAccount,
  setPin,
} from "./services/accounts.js";
import { approveCollect, createCollect, declineCollect, listCollects, publicCollect } from "./services/collect.js";
import { getUserTxn, listUserTxns, pay, publicTxn } from "./services/payments.js";
import { authenticate, getUser, publicUser, registerUser } from "./services/users.js";
import { createVpa, getOwnedVpa, listVpas, publicVpa, resolveVpa } from "./services/vpas.js";
import { buildUpiUri, parseUpiUri } from "./upiUri.js";
import { normalizeVpa, USERNAME_RE, VPA_RE } from "./vpa.js";

// ---- Request schemas -------------------------------------------------------

const phone = z.string().regex(/^[6-9]\d{9}$/, "Must be a 10-digit Indian mobile number");
const pin = z.string().regex(/^(\d{4}|\d{6})$/, "UPI PIN must be 4 or 6 digits");
const vpa = z
  .string()
  .transform(normalizeVpa)
  .pipe(z.string().regex(VPA_RE, "Invalid VPA (expected name@handle)"));
const amount = z.union([z.string(), z.number()]).transform((v) => rupeesToPaise(v));
const note = z.string().trim().max(80).optional();

const schemas = {
  register: z.object({ phone, name: z.string().trim().min(2).max(80), password: z.string().min(8).max(128) }),
  login: z.object({ phone, password: z.string() }),
  linkAccount: z.object({ bankCode: z.string() }),
  setPin: z.object({ pin, oldPin: pin.optional() }),
  balance: z.object({ pin }),
  createVpa: z.object({
    username: z.string().toLowerCase().regex(USERNAME_RE, "3-50 chars: letters, digits, '.', '_' or '-'"),
    accountId: z.number().int(),
  }),
  pay: z.object({ fromVpa: vpa, toVpa: vpa, amount, note, pin }),
  collect: z.object({
    payeeVpa: vpa,
    payerVpa: vpa,
    amount,
    note,
    expiresInMinutes: z.number().int().min(1).max(7 * 24 * 60).optional(),
  }),
  approve: z.object({ pin }),
  qrParse: z.object({ uri: z.string().max(2048) }),
  qrQuery: z.object({ amount: amount.optional(), note }),
  txnQuery: z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    before: z.iso.datetime().optional(),
  }),
};

function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Invalid request",
      result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return result.data;
}

function idParam(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new AppError("VALIDATION_ERROR", "Invalid id");
  return id;
}

// ---- App -------------------------------------------------------------------

export function createApp(ctx: Ctx) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));
  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));

  const auth = requireAuth(ctx);
  const api = express.Router();

  api.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  api.get("/banks", (_req, res) => {
    res.json(listBanks(ctx).map((b) => ({ code: b.code, name: b.name, vpaHandle: b.vpa_handle })));
  });

  // Auth
  api.post("/auth/register", (req, res) => {
    const body = parse(schemas.register, req.body);
    const user = registerUser(ctx, body);
    res.status(201).json({ user: publicUser(user), token: issueToken(ctx, user.id) });
  });

  api.post("/auth/login", (req, res) => {
    const body = parse(schemas.login, req.body);
    const user = authenticate(ctx, body.phone, body.password);
    res.json({ user: publicUser(user), token: issueToken(ctx, user.id) });
  });

  api.get("/me", auth, (req, res) => {
    const userId = uid(req);
    res.json({
      user: publicUser(getUser(ctx, userId)),
      accounts: listAccounts(ctx, userId).map((a) => publicAccount(ctx, a)),
      vpas: listVpas(ctx, userId).map(publicVpa),
    });
  });

  // Bank accounts
  api.get("/accounts", auth, (req, res) => {
    res.json(listAccounts(ctx, uid(req)).map((a) => publicAccount(ctx, a)));
  });

  api.post("/accounts", auth, (req, res) => {
    const body = parse(schemas.linkAccount, req.body);
    res.status(201).json(publicAccount(ctx, linkAccount(ctx, uid(req), body.bankCode)));
  });

  api.post("/accounts/:id/pin", auth, (req, res) => {
    const body = parse(schemas.setPin, req.body);
    setPin(ctx, uid(req), idParam(req), body.pin, body.oldPin);
    res.json(publicAccount(ctx, getOwnedAccount(ctx, uid(req), idParam(req))));
  });

  // POST because the PIN must not appear in a URL.
  api.post("/accounts/:id/balance", auth, (req, res) => {
    const body = parse(schemas.balance, req.body);
    res.json(checkBalance(ctx, uid(req), idParam(req), body.pin));
  });

  // VPAs
  api.get("/vpas", auth, (req, res) => {
    res.json(listVpas(ctx, uid(req)).map(publicVpa));
  });

  api.post("/vpas", auth, (req, res) => {
    const body = parse(schemas.createVpa, req.body);
    res.status(201).json(publicVpa(createVpa(ctx, uid(req), body.username, body.accountId)));
  });

  api.get("/vpas/:address/resolve", auth, (req, res) => {
    const address = parse(vpa, req.params.address);
    res.json(resolveVpa(ctx, address));
  });

  api.get("/vpas/:address/qr", auth, async (req, res) => {
    const address = parse(vpa, req.params.address);
    const owned = getOwnedVpa(ctx, uid(req), address);
    const q = parse(schemas.qrQuery, req.query);
    const uri = buildUpiUri({
      pa: owned.address,
      pn: getUser(ctx, owned.user_id).name,
      amountPaise: q.amount,
      tn: q.note,
    });
    res.json({ uri, qrDataUrl: await QRCode.toDataURL(uri, { margin: 1, width: 280 }) });
  });

  api.post("/qr/parse", auth, (req, res) => {
    const { uri } = parse(schemas.qrParse, req.body);
    const link = parseUpiUri(uri);
    const payee = resolveVpa(ctx, link.pa);
    res.json({ ...link, payee });
  });

  // Payments
  api.post("/payments", auth, (req, res) => {
    const body = parse(schemas.pay, req.body);
    const keyHeader = req.header("Idempotency-Key");
    if (keyHeader !== undefined && (keyHeader.length === 0 || keyHeader.length > 100)) {
      throw new AppError("VALIDATION_ERROR", "Idempotency-Key must be 1-100 characters");
    }
    const { txn, replayed } = pay(ctx, uid(req), {
      fromVpa: body.fromVpa,
      toVpa: body.toVpa,
      amountPaise: body.amount,
      note: body.note,
      pin: body.pin,
      idempotencyKey: keyHeader,
    });
    res.status(replayed ? 200 : 201).json(publicTxn(ctx, txn, uid(req)));
  });

  api.get("/transactions", auth, (req, res) => {
    const q = parse(schemas.txnQuery, req.query);
    const userId = uid(req);
    res.json(listUserTxns(ctx, userId, q).map((t) => publicTxn(ctx, t, userId)));
  });

  api.get("/transactions/:id", auth, (req, res) => {
    const userId = uid(req);
    res.json(publicTxn(ctx, getUserTxn(ctx, userId, String(req.params.id)), userId));
  });

  // Collect requests
  api.post("/collect", auth, (req, res) => {
    const body = parse(schemas.collect, req.body);
    const c = createCollect(ctx, uid(req), {
      payeeVpa: body.payeeVpa,
      payerVpa: body.payerVpa,
      amountPaise: body.amount,
      note: body.note,
      expiresInMinutes: body.expiresInMinutes,
    });
    res.status(201).json(publicCollect(c));
  });

  api.get("/collect/incoming", auth, (req, res) => {
    res.json(listCollects(ctx, uid(req), "incoming").map(publicCollect));
  });

  api.get("/collect/outgoing", auth, (req, res) => {
    res.json(listCollects(ctx, uid(req), "outgoing").map(publicCollect));
  });

  api.post("/collect/:id/approve", auth, (req, res) => {
    const body = parse(schemas.approve, req.body);
    const userId = uid(req);
    const { collect, txn } = approveCollect(ctx, userId, idParam(req), body.pin);
    res.json({ collect: publicCollect(collect), transaction: publicTxn(ctx, txn, userId) });
  });

  api.post("/collect/:id/decline", auth, (req, res) => {
    res.json(publicCollect(declineCollect(ctx, uid(req), idParam(req))));
  });

  app.use("/api", api);

  app.use("/api", (_req, _res, next) => next(new AppError("NOT_FOUND", "Route not found")));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    if (err instanceof SyntaxError && "body" in err) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Malformed JSON body" } });
      return;
    }
    console.error(err);
    res.status(500).json({ error: { code: "INTERNAL", message: "Internal server error" } });
  });

  return app;
}
