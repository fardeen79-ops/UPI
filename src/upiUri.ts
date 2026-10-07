import { AppError } from "./errors.js";
import { paiseToRupees, rupeesToPaise } from "./money.js";
import { isValidVpa, normalizeVpa } from "./vpa.js";

/**
 * UPI deep link / QR payload, following the NPCI linking spec shape:
 *   upi://pay?pa=<vpa>&pn=<name>&am=<amount>&cu=INR&tn=<note>&tr=<ref>
 */
export interface UpiPayLink {
  pa: string; // payee address (VPA)
  pn?: string; // payee name
  amountPaise?: number; // am (optional: payer enters amount if absent)
  tn?: string; // transaction note
  tr?: string; // transaction reference (merchant order id)
  mc?: string; // merchant category code
}

export function buildUpiUri(link: UpiPayLink): string {
  const params = new URLSearchParams();
  params.set("pa", link.pa);
  if (link.pn) params.set("pn", link.pn);
  if (link.amountPaise !== undefined) params.set("am", paiseToRupees(link.amountPaise));
  params.set("cu", "INR");
  if (link.tn) params.set("tn", link.tn);
  if (link.tr) params.set("tr", link.tr);
  if (link.mc) params.set("mc", link.mc);
  // URLSearchParams encodes spaces as "+" and "@" as "%40"; UPI apps expect "%20" and a literal "@".
  return `upi://pay?${params.toString().replace(/\+/g, "%20").replace(/%40/g, "@")}`;
}

export function parseUpiUri(uri: string): UpiPayLink {
  let url: URL;
  try {
    url = new URL(uri.trim());
  } catch {
    throw new AppError("VALIDATION_ERROR", "Not a valid URI");
  }
  if (url.protocol !== "upi:" || (url.hostname || url.pathname.replace(/^\/+/, "")) !== "pay") {
    throw new AppError("VALIDATION_ERROR", "Only upi://pay links are supported");
  }
  const q = url.searchParams;
  const pa = normalizeVpa(q.get("pa") ?? "");
  if (!isValidVpa(pa)) throw new AppError("VALIDATION_ERROR", "Missing or invalid payee address (pa)");
  const cu = q.get("cu");
  if (cu && cu.toUpperCase() !== "INR") throw new AppError("VALIDATION_ERROR", "Only INR is supported");
  const am = q.get("am");
  const result: UpiPayLink = { pa };
  if (am) result.amountPaise = rupeesToPaise(am);
  for (const key of ["pn", "tn", "tr", "mc"] as const) {
    const v = q.get(key);
    if (v) result[key] = v;
  }
  return result;
}
