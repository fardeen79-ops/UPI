import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

const OPENING = 10_000_00;

describe("onboarding", () => {
  it("registers, links an account, sets PIN and creates a VPA", async () => {
    const t = setup();
    const asha = await t.user("9876543210", "Asha Kumar");
    expect(asha.vpa).toBe("asha@oksbi");
    const me = await asha.get("/api/me").expect(200);
    expect(me.body.accounts[0]).toMatchObject({ pinSet: true, bank: { code: "SBI" } });
    expect(me.body.accounts[0].maskedAccountNumber).toMatch(/^X{8}\d{4}$/);
    expect(await t.balance(asha)).toBe(OPENING);
  });

  it("rejects duplicate phone numbers and taken VPAs", async () => {
    const t = setup();
    await t.user("9876543210", "Asha Kumar");
    await t.http.post("/api/auth/register").send({ phone: "9876543210", name: "X Y", password: "password123" }).expect(409);
    const other = await t.user("9876500000", "Ravi Shah");
    const res = await other.post("/api/vpas").send({ username: "asha", accountId: other.accountId }).expect(409);
    expect(res.body.error.code).toBe("VPA_TAKEN");
  });

  it("requires auth and rejects bad tokens", async () => {
    const t = setup();
    await t.http.get("/api/me").expect(401);
    await t.http.get("/api/me").set("Authorization", "Bearer nope").expect(401);
  });

  it("resolves a VPA to a masked name", async () => {
    const t = setup();
    const asha = await t.user("9876543210", "Asha Kumar");
    await t.user("9876500000", "Ravi Shah", "HDFC");
    const res = await asha.get("/api/vpas/ravi@okhdfc/resolve").expect(200);
    expect(res.body).toEqual({ address: "ravi@okhdfc", name: "Ravi S***" });
    await asha.get("/api/vpas/ghost@okhdfc/resolve").expect(404);
  });
});

describe("push payments", () => {
  it("moves money atomically and records both sides", async () => {
    const t = setup();
    const asha = await t.user("9876543210", "Asha Kumar");
    const ravi = await t.user("9876500000", "Ravi Shah", "HDFC");
    const res = await asha
      .post("/api/payments")
      .send({ fromVpa: asha.vpa, toVpa: ravi.vpa, amount: "250.75", note: "Dinner", pin: "1234" })
      .expect(201);
    expect(res.body).toMatchObject({ status: "SUCCESS", direction: "DEBIT", amount: "250.75", amountPaise: 25075 });
    expect(res.body.id).toMatch(/^\d{12}$/);
    expect(await t.balance(asha)).toBe(OPENING - 25075);
    expect(await t.balance(ravi)).toBe(OPENING + 25075);

    const raviView = await ravi.get(`/api/transactions/${res.body.id}`).expect(200);
    expect(raviView.body.direction).toBe("CREDIT");

    const ledger = t.ctx.db.prepare("SELECT direction, amount_paise FROM ledger_entries WHERE txn_id = ?").all(res.body.id);
    expect(ledger).toEqual([
      { direction: "DEBIT", amount_paise: 25075 },
      { direction: "CREDIT", amount_paise: 25075 },
    ]);
  });

  it("records insufficient funds as a FAILED transaction without moving money", async () => {
    const t = setup();
    const asha = await t.user("9876543210", "Asha Kumar");
    const ravi = await t.user("9876500000", "Ravi Shah", "HDFC");
    const res = await asha
      .post("/api/payments")
      .send({ fromVpa: asha.vpa, toVpa: ravi.vpa, amount: "10000.01", pin: "1234" })
      .expect(201);
    expect(res.body).toMatchObject({ status: "FAILED", failure: { code: "INSUFFICIENT_FUNDS" } });
    expect(await t.balance(asha)).toBe(OPENING);
    expect(await t.balance(ravi)).toBe(OPENING);
    // Payee does not see failed attempts.
    await ravi.get(`/api/transactions/${res.body.id}`).expect(404);
  });

  it("validates amounts", async () => {
    const t = setup();
    const asha = await t.user("9876543210", "Asha Kumar");
    const ravi = await t.user("9876500000", "Ravi Shah", "HDFC");
    for (const amount of ["0", "-5", "1.234", "abc", "1e3"]) {
      await asha.post("/api/payments").send({ fromVpa: asha.vpa, toVpa: ravi.vpa, amount, pin: "1234" }).expect(400);
    }
  });

  it("refuses to pay from a VPA the user does not own", async () => {
    const t = setup();
    const asha = await t.user("9876543210", "Asha Kumar");
    const ravi = await t.user("9876500000", "Ravi Shah", "HDFC");
    const res = await asha
      .post("/api/payments")
      .send({ fromVpa: ravi.vpa, toVpa: asha.vpa, amount: "1", pin: "1234" })
      .expect(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("is idempotent per Idempotency-Key", async () => {
    const t = setup();
    const asha = await t.user("9876543210", "Asha Kumar");
    const ravi = await t.user("9876500000", "Ravi Shah", "HDFC");
    const body = { fromVpa: asha.vpa, toVpa: ravi.vpa, amount: "100", pin: "1234" };
    const first = await asha.post("/api/payments").set("Idempotency-Key", "k1").send(body).expect(201);
    const again = await asha.post("/api/payments").set("Idempotency-Key", "k1").send(body).expect(200);
    expect(again.body.id).toBe(first.body.id);
    expect(await t.balance(asha)).toBe(OPENING - 100_00);
    const mismatch = await asha
      .post("/api/payments")
      .set("Idempotency-Key", "k1")
      .send({ ...body, amount: "200" })
      .expect(409);
    expect(mismatch.body.error.code).toBe("IDEMPOTENCY_MISMATCH");
  });

  it("enforces per-transaction and daily limits, resetting at IST midnight", async () => {
    const t = setup({ limits: { perTxnPaise: 5_000_00, dailyPaise: 6_000_00, dailyCount: 20 } });
    const asha = await t.user("9876543210", "Asha Kumar");
    const ravi = await t.user("9876500000", "Ravi Shah", "HDFC");
    const pay = (amount: string) =>
      asha.post("/api/payments").send({ fromVpa: asha.vpa, toVpa: ravi.vpa, amount, pin: "1234" }).expect(201);

    expect((await pay("5000.01")).body.failure.code).toBe("LIMIT_EXCEEDED");
    expect((await pay("4000")).body.status).toBe("SUCCESS");
    expect((await pay("2500")).body.failure.code).toBe("LIMIT_EXCEEDED");
    expect((await pay("2000")).body.status).toBe("SUCCESS");
    // Clock is 06:00Z = 11:30 IST; IST midnight is 18:30Z.
    t.advance(12.5 * 60 * 60 * 1000 + 1);
    expect((await pay("1000")).body.status).toBe("SUCCESS");
  });

  it("enforces the daily transaction count", async () => {
    const t = setup({ limits: { perTxnPaise: 1_00_000_00, dailyPaise: 1_00_000_00, dailyCount: 2 } });
    const asha = await t.user("9876543210", "Asha Kumar");
    const ravi = await t.user("9876500000", "Ravi Shah", "HDFC");
    const pay = () => asha.post("/api/payments").send({ fromVpa: asha.vpa, toVpa: ravi.vpa, amount: "1", pin: "1234" });
    expect((await pay()).body.status).toBe("SUCCESS");
    expect((await pay()).body.status).toBe("SUCCESS");
    expect((await pay()).body.failure.code).toBe("LIMIT_EXCEEDED");
  });

  it("rejects paying a VPA on the same account", async () => {
    const t = setup();
    const asha = await t.user("9876543210", "Asha Kumar");
    await asha.post("/api/vpas").send({ username: "asha.k", accountId: asha.accountId }).expect(201);
    const res = await asha
      .post("/api/payments")
      .send({ fromVpa: asha.vpa, toVpa: "asha.k@oksbi", amount: "1", pin: "1234" })
      .expect(422);
    expect(res.body.error.code).toBe("SAME_ACCOUNT");
  });

  it("lists history newest first with pagination", async () => {
    const t = setup();
    const asha = await t.user("9876543210", "Asha Kumar");
    const ravi = await t.user("9876500000", "Ravi Shah", "HDFC");
    for (const amount of ["1", "2", "3"]) {
      await asha.post("/api/payments").send({ fromVpa: asha.vpa, toVpa: ravi.vpa, amount, pin: "1234" }).expect(201);
      t.advance(1000);
    }
    const page1 = await asha.get("/api/transactions?limit=2").expect(200);
    expect(page1.body.map((x: { amount: string }) => x.amount)).toEqual(["3.00", "2.00"]);
    const page2 = await asha.get(`/api/transactions?limit=2&before=${page1.body[1].createdAt}`).expect(200);
    expect(page2.body.map((x: { amount: string }) => x.amount)).toEqual(["1.00"]);
  });
});

describe("UPI PIN", () => {
  it("locks after repeated wrong PINs and unlocks after the lock period", async () => {
    const t = setup({ pin: { maxAttempts: 3, lockMinutes: 60 } });
    const asha = await t.user("9876543210", "Asha Kumar");
    const ravi = await t.user("9876500000", "Ravi Shah", "HDFC");
    const pay = (pin: string) => asha.post("/api/payments").send({ fromVpa: asha.vpa, toVpa: ravi.vpa, amount: "1", pin });

    let res = await pay("0000");
    expect(res.status).toBe(401);
    expect(res.body.error.details.attemptsRemaining).toBe(2);
    await pay("0000").expect(401);
    res = await pay("0000");
    expect(res.status).toBe(423);
    // Correct PIN is refused while locked.
    expect((await pay("1234")).status).toBe(423);
    t.advance(61 * 60 * 1000);
    expect((await pay("1234")).status).toBe(201);
    expect(await t.balance(asha)).toBe(OPENING - 100);
  });

  it("requires the old PIN to change it", async () => {
    const t = setup();
    const asha = await t.user("9876543210", "Asha Kumar");
    await asha.post(`/api/accounts/${asha.accountId}/pin`).send({ pin: "567890" }).expect(409);
    await asha.post(`/api/accounts/${asha.accountId}/pin`).send({ pin: "567890", oldPin: "9999" }).expect(401);
    await asha.post(`/api/accounts/${asha.accountId}/pin`).send({ pin: "567890", oldPin: "1234" }).expect(200);
    expect(await t.balance(asha, "567890")).toBe(OPENING);
  });

  it("does not expose other users' accounts", async () => {
    const t = setup();
    const asha = await t.user("9876543210", "Asha Kumar");
    const ravi = await t.user("9876500000", "Ravi Shah", "HDFC");
    await asha.post(`/api/accounts/${ravi.accountId}/balance`).send({ pin: "1234" }).expect(404);
  });
});

describe("collect requests", () => {
  it("lets a payee request money and the payer approve it with their PIN", async () => {
    const t = setup();
    const asha = await t.user("9876543210", "Asha Kumar");
    const ravi = await t.user("9876500000", "Ravi Shah", "HDFC");
    const req = await ravi
      .post("/api/collect")
      .send({ payeeVpa: ravi.vpa, payerVpa: asha.vpa, amount: "499", note: "Movie tickets" })
      .expect(201);
    expect(req.body.status).toBe("PENDING");

    const incoming = await asha.get("/api/collect/incoming").expect(200);
    expect(incoming.body).toHaveLength(1);
    // Payee cannot approve their own request.
    await ravi.post(`/api/collect/${req.body.id}/approve`).send({ pin: "1234" }).expect(404);

    const approved = await asha.post(`/api/collect/${req.body.id}/approve`).send({ pin: "1234" }).expect(200);
    expect(approved.body.collect.status).toBe("APPROVED");
    expect(approved.body.transaction).toMatchObject({ type: "COLLECT", status: "SUCCESS", direction: "DEBIT" });
    expect(await t.balance(asha)).toBe(OPENING - 499_00);
    expect(await t.balance(ravi)).toBe(OPENING + 499_00);

    // Cannot be approved twice.
    const again = await asha.post(`/api/collect/${req.body.id}/approve`).send({ pin: "1234" }).expect(409);
    expect(again.body.error.code).toBe("COLLECT_NOT_PENDING");
  });

  it("supports declining and expiry", async () => {
    const t = setup();
    const asha = await t.user("9876543210", "Asha Kumar");
    const ravi = await t.user("9876500000", "Ravi Shah", "HDFC");
    const r1 = await ravi.post("/api/collect").send({ payeeVpa: ravi.vpa, payerVpa: asha.vpa, amount: "10" }).expect(201);
    expect((await asha.post(`/api/collect/${r1.body.id}/decline`).expect(200)).body.status).toBe("DECLINED");

    const r2 = await ravi
      .post("/api/collect")
      .send({ payeeVpa: ravi.vpa, payerVpa: asha.vpa, amount: "10", expiresInMinutes: 5 })
      .expect(201);
    t.advance(5 * 60 * 1000);
    const res = await asha.post(`/api/collect/${r2.body.id}/approve`).send({ pin: "1234" }).expect(410);
    expect(res.body.error.code).toBe("COLLECT_EXPIRED");
    const out = await ravi.get("/api/collect/outgoing").expect(200);
    expect(out.body.map((c: { status: string }) => c.status)).toEqual(["EXPIRED", "DECLINED"]);
    expect(await t.balance(asha)).toBe(OPENING);
  });

  it("marks the request FAILED when the payer lacks funds", async () => {
    const t = setup();
    const asha = await t.user("9876543210", "Asha Kumar");
    const ravi = await t.user("9876500000", "Ravi Shah", "HDFC");
    const r = await ravi.post("/api/collect").send({ payeeVpa: ravi.vpa, payerVpa: asha.vpa, amount: "20000" }).expect(201);
    const res = await asha.post(`/api/collect/${r.body.id}/approve`).send({ pin: "1234" }).expect(200);
    expect(res.body.collect.status).toBe("FAILED");
    expect(res.body.transaction.failure.code).toBe("INSUFFICIENT_FUNDS");
    expect(await t.balance(asha)).toBe(OPENING);
  });
});

describe("QR codes", () => {
  it("generates a upi:// link with QR and parses it back", async () => {
    const t = setup();
    const asha = await t.user("9876543210", "Asha Kumar");
    const ravi = await t.user("9876500000", "Ravi Shah", "HDFC");
    const qr = await ravi.get(`/api/vpas/${ravi.vpa}/qr?amount=99.5&note=Chai%20and%20snacks`).expect(200);
    expect(qr.body.uri).toBe("upi://pay?pa=ravi@okhdfc&pn=Ravi%20Shah&am=99.50&cu=INR&tn=Chai%20and%20snacks");
    expect(qr.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);

    const parsed = await asha.post("/api/qr/parse").send({ uri: qr.body.uri }).expect(200);
    expect(parsed.body).toMatchObject({
      pa: "ravi@okhdfc",
      amountPaise: 9950,
      tn: "Chai and snacks",
      payee: { address: "ravi@okhdfc", name: "Ravi S***" },
    });
  });

  it("rejects non-UPI and non-INR links", async () => {
    const t = setup();
    const asha = await t.user("9876543210", "Asha Kumar");
    await asha.post("/api/qr/parse").send({ uri: "https://example.com" }).expect(400);
    await asha.post("/api/qr/parse").send({ uri: "upi://pay?pa=asha@oksbi&cu=USD" }).expect(400);
  });
});

describe("ledger invariant", () => {
  it("conserves total money across many transfers", async () => {
    const t = setup();
    const users = [
      await t.user("9000000001", "Anil One"),
      await t.user("9000000002", "Bina Two", "HDFC"),
      await t.user("9000000003", "Chetan Three", "AXIS"),
    ];
    for (let i = 0; i < 30; i++) {
      const from = users[i % 3]!;
      const to = users[(i + 1) % 3]!;
      await from
        .post("/api/payments")
        .send({ fromVpa: from.vpa, toVpa: to.vpa, amount: String(((i * 37) % 900) + 1), pin: "1234" })
        .expect(201);
    }
    const { total } = t.ctx.db.prepare("SELECT SUM(balance_paise) AS total FROM accounts").get() as { total: number };
    expect(total).toBe(3 * OPENING);
    // Ledger balances match account balances for every account.
    const mismatches = t.ctx.db
      .prepare(
        `SELECT a.id FROM accounts a WHERE a.balance_paise != ? +
           COALESCE((SELECT SUM(CASE direction WHEN 'CREDIT' THEN amount_paise ELSE -amount_paise END)
                     FROM ledger_entries l WHERE l.account_id = a.id), 0)`,
      )
      .all(OPENING);
    expect(mismatches).toEqual([]);
  });
});
