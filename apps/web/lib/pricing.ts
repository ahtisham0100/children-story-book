// DISPLAY ONLY. apps/api/src/pipeline/catalog.ts is the sole source of truth
// for the actual charge — POST /api/checkout computes the real total
// server-side regardless of what's shown here. Keep these numbers in sync
// with that file when either changes, but a mismatch here is a cosmetic bug,
// never a billing bug.
export const BOOK_PRICES_CENTS: Record<string, number> = {
  "demo-book": 3490,
  "demo-book-duo": 3490,
};

export function formatMoney(cents: number, currency = "EUR"): string {
  return new Intl.NumberFormat("en", { style: "currency", currency }).format(cents / 100);
}
