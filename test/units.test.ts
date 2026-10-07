import { describe, expect, it } from "vitest";
import { paiseToRupees, rupeesToPaise } from "../src/money.js";
import { startOfIstDay } from "../src/services/payments.js";
import { buildUpiUri, parseUpiUri } from "../src/upiUri.js";
import { isValidVpa, maskName } from "../src/vpa.js";

describe("money", () => {
  it("parses rupees to integer paise", () => {
    expect(rupeesToPaise("1")).toBe(100);
    expect(rupeesToPaise("1.5")).toBe(150);
    expect(rupeesToPaise("0.01")).toBe(1);
    expect(rupeesToPaise(19.99)).toBe(1999);
    expect(() => rupeesToPaise("0.00")).toThrow();
    expect(() => rupeesToPaise("1.001")).toThrow();
  });
  it("formats paise", () => {
    expect(paiseToRupees(1)).toBe("0.01");
    expect(paiseToRupees(123456)).toBe("1234.56");
  });
});

describe("vpa", () => {
  it("validates addresses", () => {
    expect(isValidVpa("asha.k@oksbi")).toBe(true);
    expect(isValidVpa("a@oksbi")).toBe(false);
    expect(isValidVpa("asha@")).toBe(false);
    expect(isValidVpa("asha@@oksbi")).toBe(false);
  });
  it("masks names", () => {
    expect(maskName("Asha")).toBe("Asha");
    expect(maskName("Asha Rani Kumar")).toBe("Asha R*** K****");
  });
});

describe("upi uri", () => {
  it("round-trips", () => {
    const uri = buildUpiUri({ pa: "shop@okaxis", pn: "Corner Shop", amountPaise: 12000, tr: "ORD-1" });
    expect(parseUpiUri(uri)).toEqual({ pa: "shop@okaxis", pn: "Corner Shop", amountPaise: 12000, tr: "ORD-1" });
  });
  it("accepts links without an amount", () => {
    expect(parseUpiUri("upi://pay?pa=Shop@OkAxis")).toEqual({ pa: "shop@okaxis" });
  });
});

describe("startOfIstDay", () => {
  it("uses the IST calendar day", () => {
    expect(startOfIstDay(new Date("2026-01-15T06:00:00Z"))).toBe("2026-01-14T18:30:00.000Z");
    expect(startOfIstDay(new Date("2026-01-15T18:29:59Z"))).toBe("2026-01-14T18:30:00.000Z");
    expect(startOfIstDay(new Date("2026-01-15T18:30:00Z"))).toBe("2026-01-15T18:30:00.000Z");
  });
});
