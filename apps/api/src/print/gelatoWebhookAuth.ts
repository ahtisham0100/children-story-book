import { timingSafeEqual } from "node:crypto";

/**
 * Decides whether a Gelato webhook request is authentic. Fails CLOSED: with no
 * GELATO_WEBHOOK_SECRET configured every request is rejected, unless the
 * explicit dev-only GELATO_WEBHOOK_ALLOW_UNSIGNED=true flag is set. Otherwise
 * anyone who can reach the URL could flip any order to "delivered" or
 * "cancelled".
 *
 * `provided` is the raw header value: undefined when absent, an array when the
 * header was sent more than once (both rejected).
 */
export function isGelatoWebhookAuthorized(
  provided: string | string[] | undefined,
  configuredSecret: string | undefined,
  allowUnsigned: boolean,
): boolean {
  if (!configuredSecret) return allowUnsigned;
  if (typeof provided !== "string") return false;

  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(configuredSecret, "utf8");
  // timingSafeEqual throws on unequal lengths. Leaking only the secret's
  // LENGTH via this early return is the standard, accepted trade-off.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
