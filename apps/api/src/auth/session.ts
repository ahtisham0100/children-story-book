import type { CookieSerializeOptions } from "@fastify/cookie";
import { env } from "../env";

// Name of the session cookie. httpOnly + validated-against-DB random secret;
// see CustomerSession in schema.prisma.
export const SESSION_COOKIE = "cbp_session";

export function sessionTtlMs(): number {
  return env.AUTH_SESSION_TTL_DAYS * 24 * 60 * 60_000;
}

/**
 * Cookie flags for the session, derived from env. Pure (given env) so the
 * hardening rules can be asserted in a unit test:
 *  - httpOnly  — JS can't read it, blunting XSS token theft.
 *  - sameSite/secure — configurable; see env.ts for the cross-site guidance.
 *  - path "/"  — sent to every API route.
 * `maxAgeMs` lets the caller pass 0 to build a clearing cookie for logout.
 */
export function sessionCookieOptions(maxAgeMs: number = sessionTtlMs()): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: env.AUTH_COOKIE_SECURE,
    sameSite: env.AUTH_COOKIE_SAMESITE as "lax" | "strict" | "none",
    path: "/",
    domain: env.AUTH_COOKIE_DOMAIN,
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}
