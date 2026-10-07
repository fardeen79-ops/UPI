import request from "supertest";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import type { Ctx } from "../src/context.js";
import { openDb } from "../src/db.js";

export const OPENING = 5_000_00;
export const PASS = "123456";

export function setup(overrides: Partial<typeof config> = {}) {
  let now = new Date("2026-01-15T06:00:00Z");
  const ctx: Ctx = { db: openDb(":memory:"), config: { ...config, ...overrides }, now: () => now };
  const http = request(createApp(ctx));

  async function user(mobile: string, name: string, bank = "ENBD") {
    const reg = await http.post("/api/auth/register").send({ mobile, name, password: "password123" }).expect(201);
    const token: string = reg.body.token;
    const u = {
      token,
      mobile: reg.body.user.mobile as string,
      get: (url: string) => http.get(url).set("Authorization", `Bearer ${token}`),
      post: (url: string) => http.post(url).set("Authorization", `Bearer ${token}`),
      put: (url: string) => http.put(url).set("Authorization", `Bearer ${token}`),
      del: (url: string) => http.delete(url).set("Authorization", `Bearer ${token}`),
    };
    const acct = await u.post("/api/accounts").send({ bankCode: bank }).expect(201);
    await u.post("/api/me/passcode").send({ passcode: PASS }).expect(200);
    return { ...u, accountId: acct.body.id as number, iban: acct.body.iban as string };
  }

  async function balance(u: { get: (url: string) => request.Test }, accountId?: number) {
    const res = await u.get("/api/accounts").expect(200);
    const a = accountId ? res.body.find((x: { id: number }) => x.id === accountId) : res.body[0];
    return a.balanceFils as number;
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
