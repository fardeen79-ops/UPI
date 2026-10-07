import { AppError } from "./errors.js";

/**
 * Parse a rupee amount ("150", "150.5", "150.50") into integer paise.
 * All money is stored and computed as integer paise to avoid float errors.
 */
export function rupeesToPaise(input: string | number): number {
  const s = typeof input === "number" ? String(input) : input.trim();
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new AppError("VALIDATION_ERROR", `Invalid amount: ${JSON.stringify(input)}`);
  const paise = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (paise <= 0) throw new AppError("VALIDATION_ERROR", "Amount must be greater than zero");
  return paise;
}

/** Format paise as a fixed two-decimal rupee string, e.g. 15050 -> "150.50". */
export function paiseToRupees(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
