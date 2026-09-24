import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Customer } from "@prisma/client";
import { env } from "../env";
import { requireAdmin } from "../auth/guard";
import { rateLimitPreHandler } from "../rateLimit";
import { registerAdminQueueRoutes } from "../routes/admin/queues";
import { registerAdminOrderRoutes } from "../routes/admin/orders";
import { registerAdminStorageRoutes } from "../routes/admin/storage";
import { registerAdminDeletionRoutes } from "../routes/admin/deletions";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the admin plugin's auth hook for every /api/admin route. */
    admin: Customer | null;
  }
}

/**
 * CSRF defence for the cookie-authenticated admin API. Every non-GET admin
 * request must carry `X-Admin-Request: 1`. A cross-site form or <img> can't set
 * a custom header, and a cross-site fetch() that sets one triggers a CORS
 * preflight, which fails for any origin outside CORS_ORIGIN (src/cors.ts), so
 * the browser never sends the real request. The web app's lib/admin.ts always
 * sends it.
 */
export const ADMIN_REQUEST_HEADER = "x-admin-request";
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The admin resolved by the plugin's auth hook. Only valid inside admin routes. */
export function currentAdmin(request: FastifyRequest): Customer {
  if (!request.admin) throw new Error("currentAdmin() called outside the admin plugin.");
  return request.admin;
}

/**
 * Every /api/admin route, in one encapsulated plugin (registered with
 * app.register in app.ts). The hooks below run for every route registered in
 * here, so no admin route can forget its guards, which is the point:
 *
 *   1. rate limit: all requests per IP, plus a tighter budget for mutations;
 *   2. CSRF header on mutations (403);
 *   3. requireAdmin: 401 if not logged in, 403 if not an admin. The role is
 *      read from the database on every request.
 *
 * test/unit/adminGuard.test.ts enumerates the registered routes and checks all
 * three on each. The API is the security boundary: the web app hiding /admin
 * from non-admins is cosmetic.
 */
export async function registerAdminRoutes(app: FastifyInstance) {
  const allRequests = rateLimitPreHandler(app, {
    ipMax: env.RL_ADMIN_IP_MAX,
    windowMinutes: env.RL_ADMIN_WINDOW_MIN,
  });
  const mutations = rateLimitPreHandler(app, {
    ipMax: env.RL_ADMIN_MUTATION_IP_MAX,
    windowMinutes: env.RL_ADMIN_WINDOW_MIN,
  });

  app.decorateRequest("admin", null);

  app.addHook("onRequest", allRequests);
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!READ_METHODS.has(request.method)) return mutations(request, reply);
  });
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (READ_METHODS.has(request.method)) return;
    if (request.headers[ADMIN_REQUEST_HEADER] !== "1") {
      return reply
        .code(403)
        .send({ message: "Missing X-Admin-Request header: admin changes must come from the admin dashboard." });
    }
  });
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return reply; // 401/403 already sent
    request.admin = admin;
  });

  await registerAdminQueueRoutes(app);
  await registerAdminOrderRoutes(app);
  await registerAdminStorageRoutes(app);
  await registerAdminDeletionRoutes(app);
}
