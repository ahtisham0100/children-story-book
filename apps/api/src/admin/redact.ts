/**
 * Scrubs personal data and live credentials from BullMQ job data, return
 * values, failure reasons and stack traces before the admin API returns them.
 * Job payloads are mostly ids, but some aren't:
 *  - stage jobs carry `photoUrl`, a signed R2 URL for the child's raw photo
 *    (usable by anyone holding it until it expires);
 *  - failure messages can echo a customer's email (Resend, Stripe) or a
 *    signed URL (the pipeline's 429 retry logging).
 * Object keys (sessions/<id>/...) are kept: they're ids, not personal data,
 * and the admin needs them to debug.
 */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_PATTERN = /https?:\/\/[^\s"'<>()]+/g;
const R2_HOST = /(^|\.)r2\.(cloudflarestorage\.com|dev)$/i;
const SIGNED_QUERY = /[?&](X-Amz-[A-Za-z]+|Signature)=/i;

function isSensitiveUrl(raw: string): boolean {
  if (SIGNED_QUERY.test(raw)) return true;
  try {
    return R2_HOST.test(new URL(raw).hostname);
  } catch {
    return false;
  }
}

function redactString(value: string): string {
  return value
    .replace(URL_PATTERN, (url) => (isSensitiveUrl(url) ? "[redacted-url]" : url))
    .replace(EMAIL, "[redacted-email]");
}

/** A redacted deep copy; the input is not modified. */
export function redact<T>(value: T): T {
  if (typeof value === "string") return redactString(value) as T;
  if (Array.isArray(value)) return value.map((item) => redact(item)) as T;
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)])) as T;
  }
  return value;
}

/** Redacted one-line JSON for job tables, at most `max` characters. */
export function summarize(value: unknown, max = 200): string {
  if (value === undefined) return "";
  const json = JSON.stringify(redact(value)) ?? "";
  return json.length > max ? `${json.slice(0, max - 1)}…` : json;
}
