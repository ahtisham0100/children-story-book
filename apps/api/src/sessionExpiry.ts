import { env } from "./env";

/**
 * Personalization sessions expire SESSION_TTL_HOURS after their last activity
 * (sliding expiry). The expiry exists for GDPR deletion Pathway 1 (Milestone
 * 4): raw uploads get deleted 24h after a session expires.
 *
 * NOT decided here: a session on a paid order is never "expired" for deletion
 * purposes, whatever expiresAt says. That rule, and every other deletion date,
 * lives in src/gdpr/schedule.ts.
 */
export function sessionExpiresAt(from: Date, ttlHours: number): Date {
  return new Date(from.getTime() + ttlHours * 3_600_000);
}

/** Fields for session.create: a fresh session's expiry. */
export function newSessionExpiry(now = new Date()): { expiresAt: Date; lastActivityAt: Date } {
  return { expiresAt: sessionExpiresAt(now, env.SESSION_TTL_HOURS), lastActivityAt: now };
}

/** Fields for session.update on activity: bump lastActivityAt and slide expiresAt forward. */
export function sessionActivity(now = new Date()): { expiresAt: Date; lastActivityAt: Date } {
  return newSessionExpiry(now);
}
