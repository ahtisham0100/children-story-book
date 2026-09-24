const CART_KEY = "storybook_cart_session_ids";

export function getCartSessionIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CART_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function saveCartSessionIds(ids: string[]): void {
  window.localStorage.setItem(CART_KEY, JSON.stringify(ids));
}

export function addSessionToCart(sessionId: string): void {
  const ids = getCartSessionIds();
  if (!ids.includes(sessionId)) saveCartSessionIds([...ids, sessionId]);
}

export function removeSessionFromCart(sessionId: string): void {
  saveCartSessionIds(getCartSessionIds().filter((id) => id !== sessionId));
}

export function clearCart(): void {
  window.localStorage.removeItem(CART_KEY);
}
