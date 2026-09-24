import { API_BASE_URL, apiPost } from "./api";

export interface Me {
  id: string;
  email: string;
  hasPassword: boolean;
}

/** Current logged-in customer, or null if not authenticated (401). */
export async function getMe(): Promise<Me | null> {
  const res = await fetch(`${API_BASE_URL}/api/auth/me`, { credentials: "include" });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`GET /api/auth/me failed: ${res.status}`);
  return (await res.json()) as Me;
}

export function requestMagicLink(email: string): Promise<{ ok: boolean }> {
  return apiPost("/api/auth/magic-link/request", { email });
}

export function loginWithPassword(email: string, password: string): Promise<{ ok: boolean }> {
  return apiPost("/api/auth/login", { email, password });
}

export function requestPasswordReset(email: string): Promise<{ ok: boolean }> {
  return apiPost("/api/auth/password-reset/request", { email });
}

export function setPassword(token: string, password: string): Promise<{ ok: boolean }> {
  return apiPost("/api/auth/set-password", { token, password });
}

export function logout(): Promise<{ ok: boolean }> {
  return apiPost("/api/auth/logout", {});
}

/** The magic-link email points here — the API sets the cookie then redirects. */
export function magicLinkVerifyUrl(token: string): string {
  return `${API_BASE_URL}/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`;
}
