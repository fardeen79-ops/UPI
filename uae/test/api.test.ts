import { describe, expect, it } from "vitest";
import { OPENING, PASS, setup } from "./helpers.js";

describe("onboarding", () => {
  it("normalises the mobile number and registers it as a proxy on the first account", async () => {
    const t = setup();
    const fatima = await t.user("050 123 4567", "Fatima Al Mansoori");
    expect(fatima.mobile).toBe("+971501234567");
    expect(fatima.iban).toMatch(/^AE\d{2} 026\d \d{4} \d{4} \d{4} \d{3}$/);
    const me = await fatima.get("/api/me").expect(200);
    expect(me.body.user.passcodeSet).toBe(true);
    expect(me.body.proxies).toEqual([expect.objectContaining({ type: "MOBILE", value: "+971501234567" })]);
    expect(me.body.accounts[0]).toMatchObject({ balance: "5000.00", bank: { code: "ENBD" } });
  });

  it("validates mobile numbers and Emirates IDs", async () => {
    const t = setup();
    for (const mobile of ["0412345678", "0591234567", "05012345", "+447700900123"]) {
      await t.http.post("/api/auth/register").send({ mobile, name: "Test User", password: "password123" }).expect(400);
    }
    await t.http
      .post("/api/auth/register")
      .send({ mobile: "0501234567", name: "Test User", password: "password123", emiratesId: "784-1990-1234567-0" })
      .expect(400);
    const ok = await t.http
      .post("/api/auth/register")
      .send({ mobile: "0501234567", name: "Test User", password: "password123", emiratesId: "784-1990-1234567-6" })
      .expect(201);
    expect(ok.body.user.emiratesId).toBe("784-****-*****67-6");
  });

  it("logs in with any mobile format", async () => {
    const t = setup();
    await t.user("0501234567", "Fatima Al Mansoori");
    await t.http.post("/api/auth/login").send({ mobile: "+971 50 123 4567", password: "password123" }).expect(200);
    await t.http.post("/api/auth/login").send({ mobile: "0501234567", password: "wrongpass" }).expect(401);
  });
});

describe("proxies and lookup", () => {
  it("routes a mobile number, an email and an IBAN to the right account with a masked name", async () => {
    const t = setup();
    const fatima = await t.user("0501234567", "Fatima Al Mansoori");
    const omar = await t.user("0559876543", "Omar Khan", "FAB");
    await omar.put("/api/proxies").send({ type: "EMAIL", value: "Omar@Example.com", accountId: omar.accountId }).expect(200);

    for (const to of ["055 987 6543", "omar@example.com", omar.iban]) {
      const res = await fatima.post("/api/lookup").send({ to }).expect(200);
      expect(res.body).toMatchObject({ name: "Omar K***", bank: "First Abu Dhabi Bank" });
    }
    await fatima.post("/api/lookup").send({ to: "0521111111" }).expect(404);
    await fatima.post("/api/lookup").send({ to: "AE070331234567890123450" }).expect(400); // bad checksum
  });

  it("refuses to register someone else's mobile or email", async () => {
    const t = setup();
    const fatima = await t.user("0501234567", "Fatima Al Mansoori");
    const omar = await t.user("0559876543", "Omar Khan", "FAB");
    await fatima.put("/api/proxies").send({ type: "MOBILE", value: "0559876543", accountId: fatima.accountId }).expect(403);
    await omar.put("/api/proxies").send({ type: "EMAIL", value: "omar@example.com", accountId: omar.accountId }).expect(200);
    const res = await fatima
      .put("/api/proxies")
      .send({ type: "EMAIL", value: "omar@example.com", accountId: fatima.accountId })
      .expect(409);
    expect(res.body.error.code).toBe("PROXY_TAKEN");
  });

  it("re-points the mobile proxy to another account", async () => {
    const t = setup();
    const fatima = await t.user("0501234567", "Fatima Al Mansoori");
    const omar = await t.user("0559876543", "Omar Khan", "FAB");
    const second = await fatima.post("/api/accounts").send({ bankCode: "DIB" }).expect(201);
    expect(second.body.proxies).toEqual([]); // mobile stays on the first account
    await fatima.put("/api/proxies").send({ type: "MOBILE", value: "0501234567", accountId: second.body.id }).expect(200);
    await omar.post("/api/transfers").send({ to: "0501234567", amount: "10", passcode: PASS }).expect(201);
    expect(await t.balance(fatima, second.body.id)).toBe(OPENING + 1000);
    expect(await t.balance(fatima, fatima.accountId)).toBe(OPENING);
  });
});

describe("transfers", () => {
  it("sends money by mobile number atomically and records both sides", async () => {
    const t = setup();
    const fatima = await t.user("0501234567", "Fatima Al Mansoori");
    const omar = await t.user("0559876543", "Omar Khan", "FAB");
    const res = await fatima
      .post("/api/transfers")
      .send({ to: "0559876543", amount: "250.75", note: "Dinner", passcode: PASS })
      .expect(201);
    expect(res.body).toMatchObject({
      status: "SUCCESS",
      direction: "DEBIT",
      amount: "250.75",
      currency: "AED",
      counterparty: { name: "Omar Khan", label: "+971559876543" },
    });
    expect(res.body.id).toMatch(/^IPP260115\d{10}$/);
    expect(await t.balance(fatima)).toBe(OPENING - 25075);
    expect(await t.balance(omar)).toBe(OPENING + 25075);

    const omarView = await omar.get(`/api/transactions/${res.body.id}`).expect(200);
    expect(omarView.body).toMatchObject({ direction: "CREDIT", counterparty: { name: "Fatima Al Mansoori" } });
    expect(omarView.body.counterparty.label).toMatch(/^AE\d{2} \*{4} \*{4} \d{4}$/);
  });

  it("sends money by IBAN", async () => {
    const t = setup();
    const fatima = await t.user("0501234567", "Fatima Al Mansoori");
    const omar = await t.user("0559876543", "Omar Khan", "FAB");
    const res = await fatima.post("/api/transfers").send({ to: omar.iban, amount: 100, passcode: PASS }).expect(201);
    expect(res.body.status).toBe("SUCCESS");
    expect(await t.balance(omar)).toBe(OPENING + 100_00);
  });

  it("records insufficient funds as FAILED without moving money, hidden from the payee", async () => {
    const t = setup();
    const fatima = await t.user("0501234567", "Fatima Al Mansoori");
    const omar = await t.user("0559876543", "Omar Khan", "FAB");
    const res = await fatima.post("/api/transfers").send({ to: omar.mobile, amount: "5000.01", passcode: PASS }).expect(201);
    expect(res.body).toMatchObject({ status: "FAILED", failure: { code: "INSUFFICIENT_FUNDS" } });
    expect(await t.balance(fatima)).toBe(OPENING);
    await omar.get(`/api/transactions/${res.body.id}`).expect(404);
  });

  it("rejects invalid amounts and paying your own account", async () => {
    const t = setup();
    const fatima = await t.user("0501234567", "Fatima Al Mansoori");
    const omar = await t.user("0559876543", "Omar Khan", "FAB");
    for (const amount of ["0", "-1", "1.005", "abc"]) {
      await fatima.post("/api/transfers").send({ to: omar.mobile, amount, passcode: PASS }).expect(400);
    }
    const res = await fatima.post("/api/transfers").send({ to: fatima.mobile, amount: "1", passcode: PASS }).expect(422);
    expect(res.body.error.code).toBe("SAME_ACCOUNT");
  });

  it("can transfer between your own accounts by IBAN", async () => {
    const t = setup();
    const fatima = await t.user("0501234567", "Fatima Al Mansoori");
    const second = await fatima.post("/api/accounts").send({ bankCode: "ADCB" }).expect(201);
    const res = await fatima.post("/api/transfers").send({ to: second.body.iban, amount: "40", passcode: PASS }).expect(201);
    expect(res.body.direction).toBe("SELF");
    expect(await t.balance(fatima, second.body.id)).toBe(OPENING + 4000);
  });

  it("is idempotent per Idempotency-Key", async () => {
    const t = setup();
    const fatima = await t.user("0501234567", "Fatima Al Mansoori");
    const omar = await t.user("0559876543", "Omar Khan", "FAB");
    const body = { to: omar.mobile, amount: "100", passcode: PASS };
    const first = await fatima.post("/api/transfers").set("Idempotency-Key", "k1").send(body).expect(201);
    const again = await fatima.post("/api/transfers").set("Idempotency-Key", "k1").send(body).expect(200);
    expect(again.body.id).toBe(first.body.id);
    expect(await t.balance(fatima)).toBe(OPENING - 100_00);
    await fatima.post("/api/transfers").set("Idempotency-Key", "k1").send({ ...body, amount: "200" }).expect(409);
  });

  it("enforces limits, resetting at midnight UAE time", async () => {
    const t = setup({ limits: { perTxnFils: 3_000_00, dailyFils: 4_000_00, dailyCount: 50 } });
    const fatima = await t.user("0501234567", "Fatima Al Mansoori");
    const omar = await t.user("0559876543", "Omar Khan", "FAB");
    const send = (amount: string) =>
      fatima.post("/api/transfers").send({ to: omar.mobile, amount, passcode: PASS }).expect(201);
    expect((await send("3000.01")).body.failure.code).toBe("LIMIT_EXCEEDED");
    expect((await send("3000")).body.status).toBe("SUCCESS");
    expect((await send("1000.01")).body.failure.code).toBe("LIMIT_EXCEEDED");
    expect((await send("1000")).body.status).toBe("SUCCESS");
    // Clock is 06:00Z = 10:00 GST; midnight GST is 20:00Z.
    t.advance(14 * 60 * 60 * 1000 - 1);
    expect((await send("1")).body.failure.code).toBe("LIMIT_EXCEEDED");
    t.advance(1);
    expect((await send("1")).body.status).toBe("SUCCESS");
  });

  it("lists history newest first with a cursor", async () => {
    const t = setup();
    const fatima = await t.user("0501234567", "Fatima Al Mansoori");
    const omar = await t.user("0559876543", "Omar Khan", "FAB");
    for (const amount of ["1", "2", "3"]) {
      await fatima.post("/api/transfers").send({ to: omar.mobile, amount, passcode: PASS }).expect(201);
      t.advance(1000);
    }
    const p1 = await fatima.get("/api/transactions?limit=2").expect(200);
    expect(p1.body.map((x: { amount: string }) => x.amount)).toEqual(["3.00", "2.00"]);
    const p2 = await fatima.get(`/api/transactions?limit=2&before=${p1.body[1].createdAt}`).expect(200);
    expect(p2.body.map((x: { amount: string }) => x.amount)).toEqual(["1.00"]);
  });
});

describe("passcode", () => {
  it("locks after repeated wrong passcodes and unlocks after the lock period", async () => {
    const t = setup({ passcode: { maxAttempts: 3, lockMinutes: 30 } });
    const fatima = await t.user("0501234567", "Fatima Al Mansoori");
    const omar = await t.user("0559876543", "Omar Khan", "FAB");
    const send = (passcode: string) => fatima.post("/api/transfers").send({ to: omar.mobile, amount: "1", passcode });
    const r1 = await send("000000");
    expect(r1.status).toBe(401);
    expect(r1.body.error.details.attemptsRemaining).toBe(2);
    await send("000000").expect(401);
    expect((await send("000000")).status).toBe(423);
    expect((await send(PASS)).status).toBe(423);
    t.advance(31 * 60 * 1000);
    expect((await send(PASS)).status).toBe(201);
  });

  it("requires the old passcode to change it", async () => {
    const t = setup();
    const fatima = await t.user("0501234567", "Fatima Al Mansoori");
    await fatima.post("/api/me/passcode").send({ passcode: "654321" }).expect(409);
    await fatima.post("/api/me/passcode").send({ passcode: "654321", oldPasscode: "111111" }).expect(401);
    await fatima.post("/api/me/passcode").send({ passcode: "654321", oldPasscode: PASS }).expect(200);
  });
});

describe("request to pay", () => {
  it("lets the requester ask by mobile and the payer pay with their passcode", async () => {
    const t = setup();
    const fatima = await t.user("0501234567", "Fatima Al Mansoori");
    const omar = await t.user("0559876543", "Omar Khan", "FAB");
    const r = await omar.post("/api/requests").send({ from: "0501234567", amount: "75", note: "Taxi" }).expect(201);
    expect(r.body).toMatchObject({ status: "PENDING", payer: { name: "Fatima A* M*******" } });

    const incoming = await fatima.get("/api/requests/incoming").expect(200);
    expect(incoming.body).toHaveLength(1);
    await omar.post(`/api/requests/${r.body.id}/pay`).send({ passcode: PASS }).expect(404);

    const paid = await fatima.post(`/api/requests/${r.body.id}/pay`).send({ passcode: PASS }).expect(200);
    expect(paid.body.request.status).toBe("PAID");
    expect(paid.body.transaction).toMatchObject({ type: "REQUEST", status: "SUCCESS", direction: "DEBIT" });
    expect(await t.balance(fatima)).toBe(OPENING - 75_00);
    expect(await t.balance(omar)).toBe(OPENING + 75_00);
    const again = await fatima.post(`/api/requests/${r.body.id}/pay`).send({ passcode: PASS }).expect(409);
    expect(again.body.error.code).toBe("REQUEST_NOT_PENDING");
  });

  it("supports decline, cancel and expiry", async () => {
    const t = setup();
    const fatima = await t.user("0501234567", "Fatima Al Mansoori");
    const omar = await t.user("0559876543", "Omar Khan", "FAB");
    const r1 = await omar.post("/api/requests").send({ from: fatima.mobile, amount: "1" }).expect(201);
    expect((await fatima.post(`/api/requests/${r1.body.id}/decline`).expect(200)).body.status).toBe("DECLINED");
    const r2 = await omar.post("/api/requests").send({ from: fatima.mobile, amount: "1" }).expect(201);
    await fatima.post(`/api/requests/${r2.body.id}/cancel`).expect(404); // only the requester may cancel
    expect((await omar.post(`/api/requests/${r2.body.id}/cancel`).expect(200)).body.status).toBe("CANCELLED");
    const r3 = await omar.post("/api/requests").send({ from: fatima.mobile, amount: "1", expiresInMinutes: 10 }).expect(201);
    t.advance(10 * 60 * 1000);
    const res = await fatima.post(`/api/requests/${r3.body.id}/pay`).send({ passcode: PASS }).expect(410);
    expect(res.body.error.code).toBe("REQUEST_EXPIRED");
    expect(await t.balance(fatima)).toBe(OPENING);
  });

  it("does not allow requesting from an IBAN or from yourself", async () => {
    const t = setup();
    const fatima = await t.user("0501234567", "Fatima Al Mansoori");
    const omar = await t.user("0559876543", "Omar Khan", "FAB");
    await omar.post("/api/requests").send({ from: fatima.iban, amount: "1" }).expect(400);
    await omar.post("/api/requests").send({ from: omar.mobile, amount: "1" }).expect(422);
  });
});

describe("split bills", () => {
  it("splits a bill equally, including the requester, to the fil", async () => {
    const t = setup();
    const fatima = await t.user("0501234567", "Fatima Al Mansoori");
    const omar = await t.user("0559876543", "Omar Khan", "FAB");
    const priya = await t.user("0521112222", "Priya Nair", "MASHREQ");
    const split = await fatima
      .post("/api/splits")
      .send({ total: "100", participants: [{ who: omar.mobile }, { who: priya.mobile }], note: "Brunch" })
      .expect(201);
    // AED 100 / 3 = 33.34 + 33.33 + 33.33; Fatima keeps the last share.
    expect(split.body.requests.map((r: { amount: string }) => r.amount)).toEqual(["33.34", "33.33"]);
    expect(split.body).toMatchObject({ total: "100.00", collected: "0.00" });

    const omarReq = (await omar.get("/api/requests/incoming").expect(200)).body[0];
    await omar.post(`/api/requests/${omarReq.id}/pay`).send({ passcode: PASS }).expect(200);
    const after = await fatima.get(`/api/splits/${split.body.id}`).expect(200);
    expect(after.body.collected).toBe("33.34");
    expect(after.body.requests.map((r: { status: string }) => r.status)).toEqual(["PAID", "PENDING"]);
  });

  it("supports custom amounts and rejects duplicates and overspends", async () => {
    const t = setup();
    const fatima = await t.user("0501234567", "Fatima Al Mansoori");
    const omar = await t.user("0559876543", "Omar Khan", "FAB");
    const priya = await t.user("0521112222", "Priya Nair", "MASHREQ");
    const ok = await fatima
      .post("/api/splits")
      .send({ mode: "CUSTOM", total: "90", participants: [{ who: omar.mobile, amount: "50" }, { who: priya.mobile, amount: "25" }] })
      .expect(201);
    expect(ok.body.requests.map((r: { amount: string }) => r.amount)).toEqual(["50.00", "25.00"]);
    await fatima
      .post("/api/splits")
      .send({ mode: "CUSTOM", total: "50", participants: [{ who: omar.mobile, amount: "40" }, { who: priya.mobile, amount: "20" }] })
      .expect(400);
    await fatima.post("/api/splits").send({ total: "50", participants: [{ who: omar.mobile }, { who: "055 987 6543" }] }).expect(400);
  });
});

describe("QR codes", () => {
  it("generates an EMVCo-style payload and pays from it", async () => {
    const t = setup();
    const fatima = await t.user("0501234567", "Fatima Al Mansoori");
    const omar = await t.user("0559876543", "Omar Khan", "FAB");
    const qr = await omar.get("/api/qr?amount=42.5&note=Coffee&reference=INV-7").expect(200);
    expect(qr.body.payload).toMatch(/^000201010212/);
    expect(qr.body.payload).toContain("5303784");
    expect(qr.body.payload).toContain("5802AE");
    expect(qr.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);

    const parsed = await fatima.post("/api/qr/parse").send({ payload: qr.body.payload }).expect(200);
    expect(parsed.body).toMatchObject({
      amountFils: 4250,
      note: "Coffee",
      reference: "INV-7",
      mobile: "+971559876543",
      recipient: { name: "Omar K***" },
    });
    const sent = await fatima
      .post("/api/transfers")
      .send({ to: parsed.body.to, amount: "42.50", note: "Coffee", passcode: PASS })
      .expect(201);
    expect(sent.body.status).toBe("SUCCESS");
  });

  it("rejects a tampered QR", async () => {
    const t = setup();
    const omar = await t.user("0559876543", "Omar Khan", "FAB");
    const qr = await omar.get("/api/qr?amount=10").expect(200);
    const tampered = qr.body.payload.replace("540510.00", "540519.00");
    const res = await omar.post("/api/qr/parse").send({ payload: tampered }).expect(400);
    expect(res.body.error.message).toMatch(/checksum/);
  });
});

describe("ledger invariant", () => {
  it("conserves total money and keeps the ledger consistent with balances", async () => {
    const t = setup();
    const users = [
      await t.user("0500000001", "Aisha One"),
      await t.user("0520000002", "Bilal Two", "FAB"),
      await t.user("0540000003", "Chen Three", "DIB"),
    ];
    for (let i = 0; i < 30; i++) {
      const from = users[i % 3]!;
      const to = users[(i + 1) % 3]!;
      await from.post("/api/transfers").send({ to: to.mobile, amount: String(((i * 37) % 900) + 1), passcode: PASS }).expect(201);
    }
    const { total } = t.ctx.db.prepare("SELECT SUM(balance_fils) AS total FROM accounts").get() as { total: number };
    expect(total).toBe(3 * OPENING);
    const mismatches = t.ctx.db
      .prepare(
        `SELECT a.id FROM accounts a WHERE a.balance_fils != ? +
           COALESCE((SELECT SUM(CASE direction WHEN 'CREDIT' THEN amount_fils ELSE -amount_fils END)
                     FROM ledger_entries l WHERE l.account_id = a.id), 0)`,
      )
      .all(OPENING);
    expect(mismatches).toEqual([]);
  });
});
