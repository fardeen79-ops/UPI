import express, { type NextFunction, type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { z } from "zod";
import { issueToken, requireAuth, uid } from "./auth.js";
import type { Ctx } from "./context.js";
import { AppError } from "./errors.js";
import { normalizeEmail, normalizeEmiratesId, normalizeMobile } from "./identifiers.js";
import { aedToFils } from "./money.js";
import { buildQrPayload, parseQrPayload } from "./qr.js";
import { listAccounts, listBanks, openAccount, publicAccount, resolveOwnedAccount } from "./services/accounts.js";
import { getUserTxn, listUserTxns, publicTxn, sendMoney } from "./services/payments.js";
import { linkProxy, listProxies, lookupRecipient, publicProxy, unlinkProxy } from "./services/proxies.js";
import {
  cancelRequest,
  createRequest,
  createSplit,
  declineRequest,
  getSplit,
  listRequests,
  listSplits,
  payRequest,
  publicRequest,
} from "./services/requests.js";
import { authenticate, getUser, publicUser, registerUser, setPasscode } from "./services/users.js";

// ---- Request schemas -------------------------------------------------------

const mobile = z.string().transform((v, c) => {
  const m = normalizeMobile(v);
  if (!m) c.addIssue({ code: "custom", message: "Must be a UAE mobile number, e.g. 050 123 4567" });
  return m ?? "";
});
const emiratesId = z.string().transform((v, c) => {
  const id = normalizeEmiratesId(v);
  if (!id) c.addIssue({ code: "custom", message: "Invalid Emirates ID (784-YYYY-NNNNNNN-C)" });
  return id ?? "";
});
const passcode = z.string().regex(/^\d{6}$/, "Passcode must be 6 digits");
const amount = z.union([z.string(), z.number()]).transform((v) => aedToFils(v));
const note = z.string().trim().max(140).optional();
const accountId = z.number().int().positive().optional();

const schemas = {
  register: z.object({
    mobile,
    name: z.string().trim().min(2).max(80),
    password: z.string().min(8).max(128),
    emiratesId: emiratesId.optional(),
  }),
  login: z.object({ mobile, password: z.string() }),
  passcode: z.object({ passcode, oldPasscode: passcode.optional() }),
  openAccount: z.object({ bankCode: z.string() }),
  proxy: z.discriminatedUnion("type", [
    z.object({ type: z.literal("MOBILE"), value: mobile, accountId: z.number().int() }),
    z.object({
      type: z.literal("EMAIL"),
      value: z.string().transform((v, c) => {
        const e = normalizeEmail(v);
        if (!e) c.addIssue({ code: "custom", message: "Invalid email address" });
        return e ?? "";
      }),
      accountId: z.number().int(),
    }),
  ]),
  lookup: z.object({ to: z.string().min(1).max(64) }),
  send: z.object({ fromAccountId: accountId, to: z.string().min(1).max(64), amount, note, passcode }),
  request: z.object({
    from: z.string().min(1).max(64),
    amount,
    note,
    toAccountId: accountId,
    expiresInMinutes: z.number().int().min(5).max(30 * 24 * 60).optional(),
  }),
  payRequest: z.object({ passcode, fromAccountId: accountId }),
  split: z.object({
    mode: z.enum(["EQUAL", "CUSTOM"]).default("EQUAL"),
    total: amount.optional(),
    includeSelf: z.boolean().default(true),
    participants: z
      .array(z.object({ who: z.string().min(1).max(64), amount: amount.optional() }))
      .min(1),
    note,
    toAccountId: accountId,
    expiresInMinutes: z.number().int().min(5).max(30 * 24 * 60).optional(),
  }),
  qrQuery: z.object({
    accountId: z.coerce.number().int().positive().optional(),
    amount: amount.optional(),
    note: z.string().trim().max(50).optional(),
    reference: z.string().trim().max(25).optional(),
  }),
  qrParse: z.object({ payload: z.string().max(512) }),
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
    res.json(listBanks(ctx).map((b) => ({ code: b.code, name: b.name })));
  });

  // Auth & profile
  api.post("/auth/register", (req, res) => {
    const body = parse(schemas.register, req.body);
    const user = registerUser(ctx, body);
    res.status(201).json({ user: publicUser(user), token: issueToken(ctx, user.id) });
  });

  api.post("/auth/login", (req, res) => {
    const body = parse(schemas.login, req.body);
    const user = authenticate(ctx, body.mobile, body.password);
    res.json({ user: publicUser(user), token: issueToken(ctx, user.id) });
  });

  api.get("/me", auth, (req, res) => {
    const userId = uid(req);
    res.json({
      user: publicUser(getUser(ctx, userId)),
      accounts: listAccounts(ctx, userId).map((a) => publicAccount(ctx, a)),
      proxies: listProxies(ctx, userId).map(publicProxy),
    });
  });

  api.post("/me/passcode", auth, (req, res) => {
    const body = parse(schemas.passcode, req.body);
    setPasscode(ctx, uid(req), body.passcode, body.oldPasscode);
    res.json(publicUser(getUser(ctx, uid(req))));
  });

  // Accounts
  api.get("/accounts", auth, (req, res) => {
    res.json(listAccounts(ctx, uid(req)).map((a) => publicAccount(ctx, a)));
  });

  api.post("/accounts", auth, (req, res) => {
    const body = parse(schemas.openAccount, req.body);
    res.status(201).json(publicAccount(ctx, openAccount(ctx, uid(req), body.bankCode)));
  });

  // Proxies (mobile / email aliases)
  api.get("/proxies", auth, (req, res) => {
    res.json(listProxies(ctx, uid(req)).map(publicProxy));
  });

  api.put("/proxies", auth, (req, res) => {
    const body = parse(schemas.proxy, req.body);
    res.json(publicProxy(linkProxy(ctx, uid(req), body.type, body.value, body.accountId)));
  });

  api.delete("/proxies/:type/:value", auth, (req, res) => {
    const type = parse(z.enum(["MOBILE", "EMAIL"]), String(req.params.type).toUpperCase());
    unlinkProxy(ctx, uid(req), type, String(req.params.value).toLowerCase());
    res.status(204).end();
  });

  // POST so phone numbers and emails are not written to access logs as URLs.
  api.post("/lookup", auth, (req, res) => {
    res.json(lookupRecipient(ctx, parse(schemas.lookup, req.body).to));
  });

  // Transfers
  api.post("/transfers", auth, (req, res) => {
    const body = parse(schemas.send, req.body);
    const key = req.header("Idempotency-Key");
    if (key !== undefined && (key.length === 0 || key.length > 100)) {
      throw new AppError("VALIDATION_ERROR", "Idempotency-Key must be 1-100 characters");
    }
    const { txn, replayed } = sendMoney(ctx, uid(req), {
      fromAccountId: body.fromAccountId,
      to: body.to,
      amountFils: body.amount,
      note: body.note,
      passcode: body.passcode,
      idempotencyKey: key,
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

  // Request to pay
  api.post("/requests", auth, (req, res) => {
    const body = parse(schemas.request, req.body);
    const r = createRequest(ctx, uid(req), { ...body, amountFils: body.amount });
    res.status(201).json(publicRequest(ctx, r));
  });

  api.get("/requests/incoming", auth, (req, res) => {
    res.json(listRequests(ctx, uid(req), "incoming").map((r) => publicRequest(ctx, r)));
  });

  api.get("/requests/outgoing", auth, (req, res) => {
    res.json(listRequests(ctx, uid(req), "outgoing").map((r) => publicRequest(ctx, r)));
  });

  api.post("/requests/:id/pay", auth, (req, res) => {
    const body = parse(schemas.payRequest, req.body);
    const userId = uid(req);
    const { request, txn } = payRequest(ctx, userId, idParam(req), body);
    res.json({ request: publicRequest(ctx, request), transaction: publicTxn(ctx, txn, userId) });
  });

  api.post("/requests/:id/decline", auth, (req, res) => {
    res.json(publicRequest(ctx, declineRequest(ctx, uid(req), idParam(req))));
  });

  api.post("/requests/:id/cancel", auth, (req, res) => {
    res.json(publicRequest(ctx, cancelRequest(ctx, uid(req), idParam(req))));
  });

  // Split bills
  api.post("/splits", auth, (req, res) => {
    const body = parse(schemas.split, req.body);
    const split = createSplit(ctx, uid(req), {
      mode: body.mode,
      totalFils: body.total,
      includeSelf: body.includeSelf,
      participants: body.participants.map((p) => ({ who: p.who, amountFils: p.amount })),
      note: body.note,
      toAccountId: body.toAccountId,
      expiresInMinutes: body.expiresInMinutes,
    });
    res.status(201).json(split);
  });

  api.get("/splits", auth, (req, res) => {
    res.json(listSplits(ctx, uid(req)));
  });

  api.get("/splits/:id", auth, (req, res) => {
    res.json(getSplit(ctx, uid(req), idParam(req)));
  });

  // QR codes
  api.get("/qr", auth, async (req, res) => {
    const userId = uid(req);
    const q = parse(schemas.qrQuery, req.query);
    const account = resolveOwnedAccount(ctx, userId, q.accountId);
    const user = getUser(ctx, userId);
    const mobileProxy = listProxies(ctx, userId).find((p) => p.type === "MOBILE" && p.account_id === account.id);
    const payload = buildQrPayload({
      iban: account.iban,
      mobile: mobileProxy?.value,
      name: user.name,
      city: "Dubai",
      amountFils: q.amount,
      note: q.note,
      reference: q.reference,
    });
    res.json({ payload, qrDataUrl: await QRCode.toDataURL(payload, { margin: 1, width: 280 }) });
  });

  api.post("/qr/parse", auth, (req, res) => {
    const { payload } = parse(schemas.qrParse, req.body);
    const qr = parseQrPayload(payload);
    // Prefer the IBAN: it identifies the exact account the QR was generated for.
    const to = qr.iban ?? qr.mobile!;
    res.json({ ...qr, to, recipient: lookupRecipient(ctx, to) });
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
