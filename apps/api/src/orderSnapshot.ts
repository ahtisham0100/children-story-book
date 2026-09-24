import { bookPages, pageObjectKey, type BookConfig } from "./pipeline/catalog";

export interface ConfigSnapshotEntry {
  slot: string;
  childName: string;
  rawKey: string;
}

interface CharacterLike {
  slot: string;
  childName: string;
  rawKey: string | null;
}

/**
 * Denormalizes a session's characters onto an OrderItem at checkout time, so
 * the order stays provably pinned to what was previewed even if Session rules
 * ever changed later. Throws if any character hasn't uploaded a photo — the
 * caller (checkout route) is expected to have already checked this and turned
 * it into a 409, so this throw is a defensive backstop, not the primary check.
 */
export function buildConfigSnapshot(characters: CharacterLike[]): ConfigSnapshotEntry[] {
  return characters.map((c) => {
    if (!c.rawKey) {
      throw new Error(`Character in slot "${c.slot}" has no uploaded photo — cannot snapshot.`);
    }
    return { slot: c.slot, childName: c.childName, rawKey: c.rawKey };
  });
}

/** The R2 keys every page of a book will land at once fully rendered, in reading order. */
export function buildPrintPageKeys(sessionId: string, book: BookConfig): string[] {
  return bookPages(book).map((page) => pageObjectKey(sessionId, page.id));
}
