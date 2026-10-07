/** A VPA looks like `username@handle`, e.g. `asha.k@oksbi`. */
export const VPA_RE = /^[a-z0-9][a-z0-9._-]{1,48}[a-z0-9]@[a-z][a-z0-9]{1,19}$/;
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,48}[a-z0-9]$/;

export function normalizeVpa(vpa: string): string {
  return vpa.trim().toLowerCase();
}

export function isValidVpa(vpa: string): boolean {
  return VPA_RE.test(vpa);
}

/** Mask a full name for payee confirmation, e.g. "Asha Kumar" -> "Asha K****". */
export function maskName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0]!;
  return [parts[0], ...parts.slice(1).map((p) => p[0] + "*".repeat(Math.max(p.length - 1, 1)))].join(" ");
}
