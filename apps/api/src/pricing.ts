import { getBook } from "./pipeline/catalog";

/** Retail price of one book, in cents. Throws if storyId is unknown. */
export function priceCentsForBook(storyId: string): number {
  return getBook(storyId).priceCents;
}

/** Sums book prices for a cart's list of storyIds. Single currency (eur) for now. */
export function computeTotalCents(storyIds: string[]): { totalCents: number; currency: "eur" } {
  const totalCents = storyIds.reduce((sum, storyId) => sum + priceCentsForBook(storyId), 0);
  return { totalCents, currency: "eur" };
}
