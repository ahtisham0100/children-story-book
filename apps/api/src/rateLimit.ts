import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import "@fastify/rate-limit"; // type augmentation for app.createRateLimit
import { normalizeEmail } from "./auth/service";

/**
 * Strict per-route limits for the abuse-prone endpoints (auth + session
 * creation). @fastify/rate-limit is registered with global:false in app.ts, so
 * nothing else is limited.
 *
 * Why a custom preHandler rather than the plugin's route `config.rateLimit` or
 * `app.rateLimit()`: those set a per-request "rate limit already ran" flag, so a
 * second limiter on the same request (IP *and* email) is silently skipped.
 * `app.createRateLimit()` returns a bare check with no such flag, and each call
 * gets its own counter store, so the IP and email limits count independently.
 *
 * Runs as a preHandler, after body validation, so the email limit keys on the
 * validated body. The email is normalised exactly as the auth service
 * normalises it, so case/whitespace variants share one bucket.
 *
 * Anti-enumeration: counters are incremented whether or not an account exists,
 * and the 429 is identical either way. Nothing here reads the database.
 *
 * Store: in-memory, per API process. Correct for today's single API process;
 * switch to the plugin's Redis store before running more than one API instance,
 * or each instance enforces its own separate budget.
 */
export interface LimitSpec {
  /** Max requests per IP in the window. */
  ipMax: number;
  /** Max requests per normalised `body.email` in the window. Omit for IP-only. */
  emailMax?: number;
  windowMinutes: number;
}

type Check = (req: FastifyRequest) => Promise<{ isAllowed: boolean; isExceeded?: boolean; ttlInSeconds?: number }>;

function emailFromBody(request: FastifyRequest): string | undefined {
  const body = request.body as { email?: unknown } | undefined;
  return typeof body?.email === "string" ? normalizeEmail(body.email) : undefined;
}

export function rateLimitPreHandler(app: FastifyInstance, spec: LimitSpec) {
  const timeWindow = spec.windowMinutes * 60_000;
  const checks: Check[] = [
    app.createRateLimit({ max: spec.ipMax, timeWindow, keyGenerator: (req) => req.ip }),
  ];
  if (spec.emailMax !== undefined) {
    checks.push(
      app.createRateLimit({
        max: spec.emailMax,
        timeWindow,
        // A missing email can't reach here (schema validation runs first), but
        // fall back to the IP rather than a shared "undefined" bucket.
        keyGenerator: (req) => emailFromBody(req) ?? `ip:${req.ip}`,
      }),
    );
  }

  return async function enforceRateLimit(request: FastifyRequest, reply: FastifyReply) {
    for (const check of checks) {
      const result = await check(request);
      if (!result.isAllowed && result.isExceeded) {
        const retryAfter = result.ttlInSeconds ?? Math.ceil(timeWindow / 1000);
        return reply
          .code(429)
          .header("retry-after", retryAfter)
          .send({ message: "Too many requests. Please wait a few minutes and try again." });
      }
    }
  };
}
