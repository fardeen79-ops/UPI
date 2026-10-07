/**
 * UAE identifiers: mobile numbers, emails, IBANs and Emirates ID numbers.
 */

// UAE mobile numbers are +971 5X XXX XXXX, where 5X is an operator prefix (etisalat by e& / du / virgin).
const MOBILE_PREFIXES = new Set(["50", "52", "54", "55", "56", "58"]);

/**
 * Normalise a UAE mobile number to E.164 (+9715XXXXXXXX). Accepts 05XXXXXXXX, 5XXXXXXXX,
 * 9715XXXXXXXX, 009715XXXXXXXX and +9715XXXXXXXX, with optional spaces or dashes.
 * Returns null if it is not a UAE mobile number.
 */
export function normalizeMobile(input: string): string | null {
  let d = input.replace(/[\s\-()]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  else if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("971")) d = d.slice(3);
  else if (d.startsWith("0")) d = d.slice(1);
  if (!/^5\d{8}$/.test(d) || !MOBILE_PREFIXES.has(d.slice(0, 2))) return null;
  return `+971${d}`;
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[a-z]{2,}$/i;

export function normalizeEmail(input: string): string | null {
  const e = input.trim().toLowerCase();
  return EMAIL_RE.test(e) ? e : null;
}

// ---- IBAN ------------------------------------------------------------------
// UAE IBAN: "AE" + 2 check digits + 3-digit bank code + 16-digit account number = 23 characters.

function mod97(numeric: string): number {
  let r = 0;
  for (let i = 0; i < numeric.length; i += 7) r = Number(String(r) + numeric.slice(i, i + 7)) % 97;
  return r;
}

function ibanNumeric(country: string, check: string, bban: string): string {
  const letters = (s: string) => [...s].map((c) => (/[A-Z]/.test(c) ? String(c.charCodeAt(0) - 55) : c)).join("");
  return letters(bban) + letters(country) + check;
}

export function buildIban(bankCode: string, accountNumber: string): string {
  if (!/^\d{3}$/.test(bankCode) || !/^\d{16}$/.test(accountNumber)) throw new Error("Invalid IBAN parts");
  const bban = bankCode + accountNumber;
  const check = 98 - mod97(ibanNumeric("AE", "00", bban));
  return `AE${String(check).padStart(2, "0")}${bban}`;
}

/** Normalise and validate a UAE IBAN (format + ISO 7064 mod-97 checksum). Returns null if invalid. */
export function normalizeIban(input: string): string | null {
  const iban = input.replace(/\s/g, "").toUpperCase();
  if (!/^AE\d{21}$/.test(iban)) return null;
  return mod97(ibanNumeric("AE", iban.slice(2, 4), iban.slice(4))) === 1 ? iban : null;
}

export function formatIban(iban: string): string {
  return iban.replace(/(.{4})/g, "$1 ").trim();
}

export function maskIban(iban: string): string {
  return `${iban.slice(0, 4)} **** **** ${iban.slice(-4)}`;
}

// ---- Emirates ID -----------------------------------------------------------
// 15 digits: 784 (UAE) + 4-digit birth year + 7-digit serial + Luhn check digit, often written 784-YYYY-NNNNNNN-C.

function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function normalizeEmiratesId(input: string): string | null {
  const d = input.replace(/[\s-]/g, "");
  if (!/^784\d{12}$/.test(d) || !luhnValid(d)) return null;
  return d;
}

export function maskEmiratesId(id: string): string {
  return `784-****-*****${id.slice(-3, -1)}-${id.slice(-1)}`;
}

export function maskMobile(m: string): string {
  return `${m.slice(0, 6)}*****${m.slice(-2)}`;
}

/** Mask a full name for recipient confirmation, e.g. "Fatima Al Mansoori" -> "Fatima A* M*******". */
export function maskName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0]!;
  return [parts[0], ...parts.slice(1).map((p) => p[0] + "*".repeat(Math.max(p.length - 1, 1)))].join(" ");
}

export type Recipient =
  | { kind: "MOBILE"; value: string }
  | { kind: "EMAIL"; value: string }
  | { kind: "IBAN"; value: string };

/** Work out whether a free-text recipient is an IBAN, email or mobile number. */
export function parseRecipient(input: string): Recipient | null {
  const s = input.trim();
  if (/^ae/i.test(s.replace(/\s/g, ""))) {
    const iban = normalizeIban(s);
    return iban ? { kind: "IBAN", value: iban } : null;
  }
  if (s.includes("@")) {
    const email = normalizeEmail(s);
    return email ? { kind: "EMAIL", value: email } : null;
  }
  const mobile = normalizeMobile(s);
  return mobile ? { kind: "MOBILE", value: mobile } : null;
}
