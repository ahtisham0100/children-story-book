import { createHash, randomBytes } from "node:crypto";

// Every emailed link (activation, magic-link login, password reset) is a random
// secret we hand out once and store only as a hash. The raw value goes in the
// URL; the SHA-256 goes in AuthToken.tokenHash. Lookups hash the incoming raw
// token and match on the hash, so the database never holds anything that can be
// replayed as a link.

export type TokenPurpose = "activation" | "magic_link" | "password_reset";

/** Time-to-live per purpose, in milliseconds. */
export const TOKEN_TTL_MS: Record<TokenPurpose, number> = {
  // Activation follows a purchase; a parent may not open email for days.
  activation: 7 * 24 * 60 * 60_000,
  // Login links are used within minutes; keep the replay window short.
  magic_link: 15 * 60_000,
  // Spec: password reset expires in 30 minutes.
  password_reset: 30 * 60_000,
};

export interface GeneratedToken {
  /** Goes in the emailed URL. Never stored. */
  raw: string;
  /** Goes in the database. */
  hash: string;
}

export function generateToken(): GeneratedToken {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function expiryFrom(purpose: TokenPurpose, now: Date = new Date()): Date {
  return new Date(now.getTime() + TOKEN_TTL_MS[purpose]);
}

/**
 * A token is usable only if it hasn't been consumed and hasn't expired. Pure so
 * the single-use/expiry rule can be unit-tested without a database.
 */
export function isTokenUsable(
  token: { consumedAt: Date | null; expiresAt: Date },
  now: Date = new Date(),
): boolean {
  if (token.consumedAt !== null) return false;
  return token.expiresAt.getTime() > now.getTime();
}
