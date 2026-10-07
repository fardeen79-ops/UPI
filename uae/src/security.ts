import { randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";

const KEYLEN = 32;

/** Hash a secret (password or payment passcode) with a random salt using scrypt. */
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

export function randomDigits(n: number): string {
  let s = "";
  while (s.length < n) s += String(randomInt(0, 1e9)).padStart(9, "0");
  return s.slice(0, n);
}

/** Transaction reference, e.g. "IPP260115" + 10 random digits. Date part is in Gulf Standard Time. */
export function generateReference(now: Date): string {
  const gst = new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString();
  return `IPP${gst.slice(2, 4)}${gst.slice(5, 7)}${gst.slice(8, 10)}${randomDigits(10)}`;
}
