import request from "supertest";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import type { Ctx } from "../src/context.js";
import { openDb } from "../src/db.js";

export function setup(overrides: Partial<typeof config> = {}) {
  let now = new Date("2026-01-15T06:00:00Z");
  const ctx: Ctx = { db: openDb(":memory:"), config: { ...config, ...overrides }, now: () => now };
  const app = createApp(ctx);
  const http = request(app);

  async function user(phone: string, name: string, bank = "SBI", username?: string, pin = "1234") {
    const reg = await http.post("/api/auth/register").send({ phone, name, password: "password123" }).expect(201);
    const token: string = reg.body.token;
    const authed = {
      get: (url: string) => http.get(url).set("Authorization", `Bearer ${token}`),
      post: (url: string) => http.post(url).set("Authorization", `Bearer ${token}`),
    };
    const acct = await authed.post("/api/accounts").send({ bankCode: bank }).expect(201);
    await authed.post(`/api/accounts/${acct.body.id}/pin`).send({ pin }).expect(200);
    const vpa = await authed
      .post("/api/vpas")
      .send({ username: username ?? name.toLowerCase().split(" ")[0], accountId: acct.body.id })
      .expect(201);
    return { token, accountId: acct.body.id as number, vpa: vpa.body.address as string, ...authed };
  }

  async function balance(u: { post: (url: string) => request.Test; accountId: number }, pin = "1234") {
    const res = await u.post(`/api/accounts/${u.accountId}/balance`).send({ pin }).expect(200);
    return res.body.balancePaise as number;
  }

  return {
    ctx,
    http,
    user,
    balance,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}
