// Domain rules for the admin allowlist form. Deliberately pure and
// dependency-free so they can be tested without a database. Whether an
// address is eligible to register is decided server-side by
// is_email_domain_allowed(); nothing here can answer that.

/** Lowercase, trim, and forgive a leading `@` an admin may type out of habit. */
export function normalizeDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/^@/, '')
}

/**
 * A plausible domain: at least two dot-separated labels, no `@`, no
 * whitespace. Not a full DNS validation — just enough to reject the two
 * mistakes that actually happen, a pasted email address and a bare label.
 */
export function isValidDomain(raw: string): boolean {
  const domain = normalizeDomain(raw)
  if (!domain || domain.includes('@') || /\s/.test(domain)) return false
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)
}
