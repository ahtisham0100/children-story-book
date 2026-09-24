export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

// credentials:"include" so the session cookie the API sets (on login / magic
// link / activation) is stored and sent back on every call — required for the
// authenticated /api/auth/me and /api/account/* routes to see the session.
export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, { credentials: "include" });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error((payload as { message?: string }).message ?? `POST ${path} failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}
