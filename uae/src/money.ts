import { AppError } from "./errors.js";

/**
 * Parse a dirham amount ("150", "150.5", "150.50") into integer fils (1 AED = 100 fils).
 * All money is stored and computed as integer fils to avoid float errors.
 */
export function aedToFils(input: string | number): number {
  const s = typeof input === "number" ? String(input) : input.trim();
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new AppError("VALIDATION_ERROR", `Invalid amount: ${JSON.stringify(input)}`);
  const fils = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (fils <= 0) throw new AppError("VALIDATION_ERROR", "Amount must be greater than zero");
  return fils;
}

/** Format fils as a fixed two-decimal dirham string, e.g. 15050 -> "150.50". */
export function filsToAed(fils: number): string {
  const sign = fils < 0 ? "-" : "";
  const abs = Math.abs(fils);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
