export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

/**
 * A non-2xx API response. `message` is the API's own `{message}` when it sent
 * one, so pages can show it instead of a generic "failed: 409". `body` is the
 * whole parsed JSON body (e.g. the `orders` list on a 409), and `retryAfter`
 * is the Retry-After header in seconds on a 429.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
    readonly retryAfter: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The one fetch wrapper. credentials:"include" so the session cookie the API
 * sets (on login / magic link / activation) is stored and sent back on every
 * call — required for the authenticated /api/auth/me, /api/account/* and
 * /api/admin/* routes to see the session.
 */
export async function apiRequest<T>(
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    credentials: "include",
    cache: "no-store",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!res.ok) {
    const payload: unknown = await res.json().catch(() => null);
    const apiMessage = (payload as { message?: unknown } | null)?.message;
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new ApiError(
      res.status,
      typeof apiMessage === "string" && apiMessage ? apiMessage : `${method} ${path} failed: ${res.status}`,
      payload,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
    );
  }
  return res.json() as Promise<T>;
}

export function apiGet<T>(path: string): Promise<T> {
  return apiRequest<T>("GET", path);
}

export function apiPost<T>(path: string, body: unknown): Promise<T> {
  return apiRequest<T>("POST", path, { body });
}

export function apiDelete<T>(path: string, body?: unknown): Promise<T> {
  return apiRequest<T>("DELETE", path, { body });
}
