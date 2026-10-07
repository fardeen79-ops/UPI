import { AppError } from "./errors.js";
import { filsToAed, aedToFils } from "./money.js";
import { normalizeIban, normalizeMobile } from "./identifiers.js";

/**
 * Merchant-presented QR payload in the EMVCo TLV format (tag: 2 digits, length: 2 digits, value),
 * the format used by most national instant-payment QR schemes. The merchant account template (tag 26)
 * uses a simulator-specific GUI; a real deployment must follow the CBUAE / Al Etihad Payments QR spec.
 */
export const QR_GUI = "ae.sim.ipp";
const CURRENCY_AED = "784"; // ISO 4217 numeric

export interface QrPayment {
  /** Payee IBAN and/or mobile proxy. At least one is required. */
  iban?: string;
  mobile?: string;
  name: string;
  city: string;
  amountFils?: number;
  reference?: string; // tag 62.01 bill number
  note?: string; // tag 62.08 purpose of transaction
  mcc?: string;
}

function tlv(tag: string, value: string): string {
  if (value.length > 99) throw new AppError("VALIDATION_ERROR", `QR field ${tag} is too long`);
  return tag + String(value.length).padStart(2, "0") + value;
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF), as required by EMVCo tag 63. */
export function crc16(data: string): string {
  let crc = 0xffff;
  for (const byte of Buffer.from(data, "utf8")) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function parseTlv(data: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < data.length) {
    const tag = data.slice(i, i + 2);
    const len = Number(data.slice(i + 2, i + 4));
    if (!/^\d{2}$/.test(tag) || !Number.isInteger(len) || i + 4 + len > data.length) {
      throw new AppError("VALIDATION_ERROR", "Malformed QR payload");
    }
    out.set(tag, data.slice(i + 4, i + 4 + len));
    i += 4 + len;
  }
  return out;
}

export function buildQrPayload(p: QrPayment): string {
  if (!p.iban && !p.mobile) throw new Error("QR needs an IBAN or mobile proxy");
  const account = tlv("00", QR_GUI) + (p.iban ? tlv("01", p.iban) : "") + (p.mobile ? tlv("02", p.mobile) : "");
  const additional = (p.reference ? tlv("01", p.reference) : "") + (p.note ? tlv("08", p.note) : "");
  let payload =
    tlv("00", "01") +
    tlv("01", p.amountFils !== undefined ? "12" : "11") + // 12 = dynamic (amount set), 11 = static
    tlv("26", account) +
    tlv("52", p.mcc ?? "0000") +
    tlv("53", CURRENCY_AED) +
    (p.amountFils !== undefined ? tlv("54", filsToAed(p.amountFils)) : "") +
    tlv("58", "AE") +
    tlv("59", p.name.slice(0, 25)) +
    tlv("60", p.city.slice(0, 15)) +
    (additional ? tlv("62", additional) : "");
  payload += "6304";
  return payload + crc16(payload);
}

export function parseQrPayload(raw: string): QrPayment {
  const data = raw.trim();
  if (data.length < 8 || data.slice(-8, -4) !== "6304") throw new AppError("VALIDATION_ERROR", "QR payload has no CRC");
  if (crc16(data.slice(0, -4)) !== data.slice(-4).toUpperCase()) {
    throw new AppError("VALIDATION_ERROR", "QR checksum mismatch: the code is damaged or was altered");
  }
  const top = parseTlv(data.slice(0, -8));
  if (top.get("00") !== "01") throw new AppError("VALIDATION_ERROR", "Unsupported QR payload format");
  if (top.get("53") !== CURRENCY_AED) throw new AppError("VALIDATION_ERROR", "Only AED payments are supported");
  const accountTemplate = top.get("26");
  const account = accountTemplate ? parseTlv(accountTemplate) : undefined;
  if (!account || account.get("00") !== QR_GUI) throw new AppError("VALIDATION_ERROR", "Not a supported instant-payment QR");

  const result: QrPayment = { name: top.get("59") ?? "", city: top.get("60") ?? "" };
  const iban = account.get("01");
  const mobile = account.get("02");
  if (iban) {
    const v = normalizeIban(iban);
    if (!v) throw new AppError("VALIDATION_ERROR", "QR contains an invalid IBAN");
    result.iban = v;
  }
  if (mobile) {
    const v = normalizeMobile(mobile);
    if (!v) throw new AppError("VALIDATION_ERROR", "QR contains an invalid mobile number");
    result.mobile = v;
  }
  if (!result.iban && !result.mobile) throw new AppError("VALIDATION_ERROR", "QR has no payee account");
  const amount = top.get("54");
  if (amount) result.amountFils = aedToFils(amount);
  const mcc = top.get("52");
  if (mcc && mcc !== "0000") result.mcc = mcc;
  const extra = top.get("62");
  if (extra) {
    const add = parseTlv(extra);
    if (add.get("01")) result.reference = add.get("01");
    if (add.get("08")) result.note = add.get("08");
  }
  return result;
}
