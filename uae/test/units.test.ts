import { describe, expect, it } from "vitest";
import {
  buildIban,
  maskName,
  normalizeEmiratesId,
  normalizeIban,
  normalizeMobile,
  parseRecipient,
} from "../src/identifiers.js";
import { aedToFils, filsToAed } from "../src/money.js";
import { buildQrPayload, crc16, parseQrPayload } from "../src/qr.js";
import { startOfGstDay } from "../src/services/payments.js";
import { equalShares } from "../src/services/requests.js";

describe("money", () => {
  it("converts AED and fils", () => {
    expect(aedToFils("1.5")).toBe(150);
    expect(aedToFils(19.99)).toBe(1999);
    expect(filsToAed(123456)).toBe("1234.56");
    expect(() => aedToFils("0")).toThrow();
  });
});

describe("identifiers", () => {
  it("normalises UAE mobile numbers", () => {
    for (const m of ["0501234567", "501234567", "971501234567", "+971 50 123 4567", "00971-50-123-4567"]) {
      expect(normalizeMobile(m)).toBe("+971501234567");
    }
    expect(normalizeMobile("0421234567")).toBeNull(); // Dubai landline
    expect(normalizeMobile("0511234567")).toBeNull(); // not a mobile operator prefix
  });

  it("builds and validates IBANs", () => {
    expect(buildIban("033", "1234567890123456")).toBe("AE070331234567890123456");
    expect(normalizeIban("ae07 0331 2345 6789 0123 456")).toBe("AE070331234567890123456");
    expect(normalizeIban("AE080331234567890123456")).toBeNull();
    expect(normalizeIban("GB82WEST12345698765432")).toBeNull();
  });

  it("validates Emirates IDs with the Luhn check digit", () => {
    expect(normalizeEmiratesId("784-1990-1234567-6")).toBe("784199012345676");
    expect(normalizeEmiratesId("784-1990-1234567-5")).toBeNull();
    expect(normalizeEmiratesId("123-1990-1234567-6")).toBeNull();
  });

  it("detects recipient kinds", () => {
    expect(parseRecipient("050 123 4567")).toEqual({ kind: "MOBILE", value: "+971501234567" });
    expect(parseRecipient("A@B.ae")).toEqual({ kind: "EMAIL", value: "a@b.ae" });
    expect(parseRecipient("AE07 0331 2345 6789 0123 456")).toEqual({ kind: "IBAN", value: "AE070331234567890123456" });
    expect(parseRecipient("hello")).toBeNull();
  });

  it("masks names", () => {
    expect(maskName("Omar")).toBe("Omar");
    expect(maskName("Fatima Al Mansoori")).toBe("Fatima A* M*******");
  });
});

describe("qr", () => {
  it("computes CRC-16/CCITT-FALSE", () => {
    expect(crc16("123456789")).toBe("29B1"); // standard check value
  });

  it("round-trips a payload", () => {
    const p = { iban: "AE070331234567890123456", mobile: "+971501234567", name: "Corner Cafe", city: "Dubai", amountFils: 1250, reference: "T-9", note: "Latte" };
    expect(parseQrPayload(buildQrPayload(p))).toEqual(p);
  });

  it("marks static codes and omits the amount", () => {
    const payload = buildQrPayload({ mobile: "+971501234567", name: "A", city: "Dubai" });
    expect(payload.slice(0, 12)).toBe("000201010211");
    expect(parseQrPayload(payload).amountFils).toBeUndefined();
  });
});

describe("helpers", () => {
  it("uses the UAE calendar day", () => {
    expect(startOfGstDay(new Date("2026-01-15T06:00:00Z"))).toBe("2026-01-14T20:00:00.000Z");
    expect(startOfGstDay(new Date("2026-01-15T20:00:00Z"))).toBe("2026-01-15T20:00:00.000Z");
  });

  it("splits equally to the fil", () => {
    expect(equalShares(10000, 3)).toEqual([3334, 3333, 3333]);
    expect(equalShares(10, 4)).toEqual([3, 3, 2, 2]);
  });
});
