import { apiRequest } from "./api";

/**
 * Client for /api/admin/*. Every call sends X-Admin-Request: 1, which the API
 * requires on every admin mutation as its CSRF check (apps/api/src/admin/plugin.ts).
 * Sent on reads too, so there's one code path. Errors are ApiError with the
 * API's own message, so pages can show it as-is.
 */
const ADMIN_HEADERS = { "X-Admin-Request": "1" };

export function adminGet<T>(path: string): Promise<T> {
  return apiRequest<T>("GET", path, { headers: ADMIN_HEADERS });
}

export function adminPost<T>(path: string, body: unknown = {}): Promise<T> {
  return apiRequest<T>("POST", path, { body, headers: ADMIN_HEADERS });
}

/** A query string from the non-empty entries, e.g. qs({ status: "", page: 2 }) → "?page=2". */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

// --- Response shapes (apps/api/src/routes/admin/*) ------------------------

export interface Paged<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
}

export type JobState = "active" | "waiting" | "delayed" | "completed" | "failed";
export const JOB_STATES: JobState[] = ["failed", "active", "waiting", "delayed", "completed"];

export interface QueueCounts {
  name: string;
  counts: Record<JobState, number>;
}

export interface JobSummary {
  id: string;
  name: string;
  state: string;
  timestamp: number | null;
  processedOn: number | null;
  finishedOn: number | null;
  attemptsMade: number;
  maxAttempts: number;
  dataSummary: string;
}

export interface JobDetail extends JobSummary {
  queue: string;
  data: unknown;
  returnvalue: unknown;
  failedReason: string | null;
  stacktrace: string[];
  gelatoUnknownOutcome: boolean;
}

export interface AdminOrderRow {
  id: string;
  email: string;
  status: string;
  totalCents: number;
  currency: string;
  createdAt: string;
  itemCount: number;
  gelatoOrderId: string | null;
  anonymisedAt: string | null;
}

export interface AdminOrderDetail {
  id: string;
  email: string;
  status: string;
  totalCents: number;
  currency: string;
  createdAt: string;
  customerId: string | null;
  stripePaymentIntentId: string | null;
  shipping: { name: string; line1: string; line2: string | null; city: string; postalCode: string; country: string };
  gelatoOrderId: string | null;
  gelatoSubmitStartedAt: string | null;
  deliveredAt: string | null;
  anonymisedAt: string | null;
  items: { id: string; bookTitle: string; priceCents: number; sessionId: string; hasPrintPdf: boolean }[];
  statusEvents: { status: string; source: string; createdAt: string; note: string | null }[];
  allowedTransitions: string[];
  gelatoUnknownOutcome: boolean;
  fulfillmentJob: { state: string; attemptsMade: number; failedReason: string | null } | null;
}

export const ORDER_STATUSES = [
  "awaiting_payment",
  "paid",
  "pdf_ready",
  "submitted_to_print",
  "processing",
  "dispatched",
  "delivered",
  "failed",
  "cancelled",
];

export interface StorageTotals {
  count: number;
  bytes: number;
}
export type StorageCategory = "raw" | "processed" | "printPdf" | "other";

export interface StorageSummary {
  categories: Record<StorageCategory, StorageTotals>;
  total: StorageTotals;
  computedAt: string;
  cached: boolean;
}

export interface SessionStorage {
  sessionId: string;
  files: { key: string; size: number; lastModified: string | null; category: StorageCategory }[];
  session: { expiresAt: string | null; rawDeletedAt: string | null; processedDeletedAt: string | null } | null;
  orders: { id: string; status: string }[];
  schedule: { pathway: string; rawDueAt: string | null; processedDueAt: string | null } | null;
}

export type DeletionKind = "p1" | "p2_raw" | "p2_processed";

export interface ScheduledDeletion {
  sessionId: string;
  pathway: string;
  scope: string;
  dueAt: string;
  overdue: boolean;
}

export interface DeletionAuditRow {
  id: string;
  createdAt: string;
  trigger: string;
  scope: string;
  sessionId: string | null;
  fileCount: number;
  actor: string;
  dryRun: boolean;
  force: boolean;
  outcome: string;
  error: string | null;
}

export interface ManualDeletionResult {
  sessionId: string;
  scope: string;
  fileCount: number;
  dryRun: boolean;
  force: boolean;
  holdingOrders: { id: string; status: string }[];
}

/** Session ids become R2 prefixes; the API enforces this too (SAFE_ID). */
export const SAFE_ID = /^[A-Za-z0-9-]+$/;
