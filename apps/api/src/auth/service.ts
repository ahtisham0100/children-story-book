import type { Customer } from "@prisma/client";
import { prisma } from "../db";
import { hashPassword, verifyPassword } from "./password";
import { expiryFrom, generateToken, hashToken, isTokenUsable, type TokenPurpose } from "./tokens";
import { sessionTtlMs } from "./session";

/** Emails are matched case-insensitively; store and look up the normalized form. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The "silent account at checkout" primitive: idempotent by email, so a repeat
 * buyer reuses their existing account and a first-time buyer gets one with no
 * sign-up step. Never touches passwordHash, so calling it again can't wipe a
 * password a customer already set.
 */
export async function findOrCreateCustomerByEmail(email: string): Promise<Customer> {
  const normalized = normalizeEmail(email);
  return prisma.customer.upsert({
    where: { email: normalized },
    update: {},
    create: { email: normalized },
  });
}

export async function findCustomerByEmail(email: string): Promise<Customer | null> {
  return prisma.customer.findUnique({ where: { email: normalizeEmail(email) } });
}

/** Mints a single-use token for a known customer and returns the RAW value to email. */
export async function issueToken(customerId: string, purpose: TokenPurpose): Promise<string> {
  const { raw, hash } = generateToken();
  await prisma.authToken.create({
    data: { customerId, purpose, tokenHash: hash, expiresAt: expiryFrom(purpose) },
  });
  return raw;
}

/**
 * Consumes a token if — and only if — it is unexpired, unconsumed, and of one of
 * the allowed purposes. Marks it consumed atomically (updateMany guarded on
 * consumedAt IS NULL) so a double-submit can't use the same link twice. Returns
 * the owning customer, or null for any failure — callers must not distinguish
 * "wrong token" from "expired" to the user beyond a generic message.
 */
export async function consumeToken(
  raw: string,
  allowedPurposes: TokenPurpose[],
): Promise<Customer | null> {
  const token = await prisma.authToken.findUnique({ where: { tokenHash: hashToken(raw) } });
  if (!token) return null;
  if (!allowedPurposes.includes(token.purpose as TokenPurpose)) return null;
  if (!isTokenUsable(token)) return null;

  const marked = await prisma.authToken.updateMany({
    where: { id: token.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (marked.count !== 1) return null; // lost a race — already consumed.

  return prisma.customer.findUnique({ where: { id: token.customerId } });
}

export async function setCustomerPassword(customerId: string, password: string): Promise<void> {
  await prisma.customer.update({
    where: { id: customerId },
    data: { passwordHash: await hashPassword(password) },
  });
}

/**
 * Password login. Returns the customer on success, null otherwise. A customer
 * who has only ever used magic links has no passwordHash, so this returns null
 * for them — the login route surfaces that as the same generic failure, not a
 * "no password set" oracle.
 */
export async function verifyCredentials(email: string, password: string): Promise<Customer | null> {
  const customer = await findCustomerByEmail(email);
  if (!customer || !customer.passwordHash) return null;
  const ok = await verifyPassword(password, customer.passwordHash);
  return ok ? customer : null;
}

// ---- Browser sessions ---------------------------------------------------

/** Creates a session row and returns the RAW secret to put in the cookie. */
export async function createSession(customerId: string): Promise<string> {
  const { raw, hash } = generateToken();
  await prisma.customerSession.create({
    data: { customerId, tokenHash: hash, expiresAt: new Date(Date.now() + sessionTtlMs()) },
  });
  return raw;
}

/**
 * Resolves a cookie secret to its customer, or null if the session is missing
 * or expired. An expired session is deleted on the way out so it can't linger.
 */
export async function getCustomerBySessionToken(raw: string): Promise<Customer | null> {
  const session = await prisma.customerSession.findUnique({
    where: { tokenHash: hashToken(raw) },
    include: { customer: true },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.customerSession.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  return session.customer;
}

export async function destroySession(raw: string): Promise<void> {
  await prisma.customerSession.deleteMany({ where: { tokenHash: hashToken(raw) } });
}
