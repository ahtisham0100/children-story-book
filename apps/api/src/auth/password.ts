import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

// scrypt is in Node's standard library, so password hashing needs no native
// dependency (bcrypt/argon2 would). Format stored in Customer.passwordHash is
// `scrypt$<saltHex>$<hashHex>` — self-describing so the algorithm can be
// migrated later without guessing what produced an existing hash.
const KEYLEN = 64;
const SALT_BYTES = 16;
const PREFIX = "scrypt";

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = (await scrypt(password, salt, KEYLEN)) as Buffer;
  return `${PREFIX}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/**
 * Constant-time verification. Returns false (never throws) for a malformed or
 * unrecognized stored value, so a corrupt row can't crash a login.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== PREFIX) return false;
  const salt = Buffer.from(parts[1]!, "hex");
  const expected = Buffer.from(parts[2]!, "hex");
  if (expected.length === 0) return false;
  const derived = (await scrypt(password, salt, expected.length)) as Buffer;
  // Both buffers are the same length here, so timingSafeEqual is safe to call.
  return timingSafeEqual(derived, expected);
}

export interface PasswordStrength {
  /** 0 (empty/weakest) .. 4 (strongest). Drives the meter's fill and colour. */
  score: 0 | 1 | 2 | 3 | 4;
  label: "Too weak" | "Weak" | "Fair" | "Good" | "Strong";
  /** The gate: the API rejects a password that isn't at least this. */
  acceptable: boolean;
}

// The minimum the server enforces AND the meter's pass threshold, kept in one
// place. A near-identical copy lives in apps/web/lib/password.ts for the live
// meter; if this rule changes, change both (the server is the real gate).
export const MIN_PASSWORD_LENGTH = 8;

/**
 * A deliberately simple, dependency-free strength estimate: length plus
 * character-class variety. Not a substitute for a breach check, but enough to
 * steer parents away from "12345678" and to power a live meter. Pure and
 * synchronous so both the API gate and the UI can call it.
 */
export function assessPasswordStrength(password: string): PasswordStrength {
  let variety = 0;
  if (/[a-z]/.test(password)) variety += 1;
  if (/[A-Z]/.test(password)) variety += 1;
  if (/[0-9]/.test(password)) variety += 1;
  if (/[^A-Za-z0-9]/.test(password)) variety += 1;

  let score = 0;
  if (password.length >= MIN_PASSWORD_LENGTH) {
    score = 1;
    if (variety >= 2) score = 2;
    if (variety >= 3 && password.length >= 10) score = 3;
    if (variety >= 4 && password.length >= 12) score = 4;
  }

  const labels: PasswordStrength["label"][] = ["Too weak", "Weak", "Fair", "Good", "Strong"];
  return {
    score: score as PasswordStrength["score"],
    label: labels[score]!,
    // Acceptable once it clears the length floor AND has at least two classes,
    // i.e. score >= 2 — so "password" (length ok, one class) is still rejected.
    acceptable: password.length >= MIN_PASSWORD_LENGTH && variety >= 2,
  };
}
