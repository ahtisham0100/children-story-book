import type { FastifyReply, FastifyRequest } from "fastify";
import type { Customer } from "@prisma/client";
import { SESSION_COOKIE } from "./session";
import { getCustomerBySessionToken } from "./service";

/**
 * Resolves the logged-in customer from the session cookie, or null. Never
 * throws — a missing/expired/forged cookie is simply "not logged in".
 */
export async function getCustomerFromRequest(request: FastifyRequest): Promise<Customer | null> {
  const raw = request.cookies?.[SESSION_COOKIE];
  if (!raw) return null;
  return getCustomerBySessionToken(raw);
}

/**
 * Guard for authenticated routes. On success returns the customer; on failure
 * it has ALREADY sent a 401 and returns null, so a handler does:
 *
 *   const customer = await requireCustomer(request, reply);
 *   if (!customer) return; // 401 already sent
 *
 * This is the front door for row-level security: every account route resolves
 * the customer here first, then filters data by customer.id — a customer can
 * never name someone else's id, only ride their own cookie.
 */
export async function requireCustomer(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Customer | null> {
  const customer = await getCustomerFromRequest(request);
  if (!customer) {
    reply.code(401).send({ message: "Not authenticated." });
    return null;
  }
  return customer;
}

export const CUSTOMER_ROLE = {
  customer: "customer",
  admin: "admin",
} as const;

/**
 * Guard for /admin API routes. Same contract as requireCustomer: returns the
 * admin, or null after it has ALREADY replied (401 when not logged in, 403
 * when logged in but not an admin):
 *
 *   const admin = await requireAdmin(request, reply);
 *   if (!admin) return;
 *
 * The role is read fresh from the database on every request (via the session
 * lookup), so revoking it takes effect immediately. Nothing in the API can
 * grant it; see scripts/make-admin.mts.
 */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<Customer | null> {
  const customer = await requireCustomer(request, reply);
  if (!customer) return null; // 401 already sent
  if (customer.role !== CUSTOMER_ROLE.admin) {
    reply.code(403).send({ message: "Forbidden." });
    return null;
  }
  return customer;
}
