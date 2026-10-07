import { randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";

const KEYLEN = 32;

/** Hash a secret (password or UPI PIN) with a random salt using scrypt. */
export function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(secret, salt, KEYLEN);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifySecret(secret: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(secret, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(expected, actual);
}

/** 12-digit numeric reference, in the style of a UPI RRN. */
export function generateRrn(): string {
  return String(randomInt(1, 10)) + String(randomInt(0, 1e11)).padStart(11, "0");
}

/** Simulated 12-digit bank account number. */
export function generateAccountNumber(): string {
  return generateRrn();
}
