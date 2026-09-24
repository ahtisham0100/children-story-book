import { Type } from "@sinclair/typebox";

/** Shared pieces of the /api/admin route schemas. */

export const PageQuery = {
  page: Type.Integer({ minimum: 1, default: 1 }),
  limit: Type.Integer({ minimum: 1, maximum: 100, default: 25 }),
};

export function pageWindow(page: number, limit: number) {
  return { skip: (page - 1) * limit, take: limit };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A `from`/`to` query value: a YYYY-MM-DD day (what <input type="date"> sends)
 * or a full ISO timestamp. Day bounds are inclusive: `to=2026-09-13` covers
 * the whole of that day (UTC). Returns undefined when absent, null when invalid.
 */
export function parseDateBound(value: string | undefined, bound: "from" | "to"): Date | null | undefined {
  if (value === undefined || value === "") return undefined;
  const date = new Date(DATE_ONLY.test(value) ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(date.getTime())) return null;
  if (bound === "to" && DATE_ONLY.test(value)) return new Date(date.getTime() + 24 * 3_600_000 - 1);
  return date;
}

/** { gte, lte } for Prisma, or "invalid" for a 400. */
export function dateRange(from?: string, to?: string): { gte?: Date; lte?: Date } | undefined | "invalid" {
  const gte = parseDateBound(from, "from");
  const lte = parseDateBound(to, "to");
  if (gte === null || lte === null) return "invalid";
  if (!gte && !lte) return undefined;
  return { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) };
}

export const INVALID_DATE = { message: "from/to must be a date (YYYY-MM-DD) or an ISO timestamp." };

export const NO_REDIS = { message: "Redis isn't configured (REDIS_URL), so the job queues aren't available." };

export const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null);
