import path from "node:path";
import type { FaceBox } from "./types";

// THE single registry of page artwork and books.
//
// This replaced three overlapping registries (a production `BOOKS`, a demo
// `SCENES`, and a demo `MULTI_SCENES`) that described the same thing in three
// slightly different shapes and drifted apart. Production and the demo harness
// now read from here, so a page can only be defined once.
//
// Adding a page is one entry in PAGES — no code, no per-template calibration.
// The engine reads the character count and the artwork; everything else about
// how the child is drawn comes from the artwork itself.

export interface Page {
  /** Stable slug. Also the storage filename for the finished page. */
  id: string;
  /** The illustrator's finished page artwork. */
  imagePath: string;
  /**
   * How many characters are DRAWN on this page. Default 1.
   *
   * This drives two things. It routes the page (1 = repaint the whole page,
   * which is the simplest and most-proven path; 2+ = crop each character out,
   * personalize separately, composite back). And it caps face detection at this
   * many highest-confidence hits, which is a real defence: on `mc_3` one
   * detection window scored the rocket ship's window 0.874 as a face, with
   * plausible enough landmarks that no geometric check catches it. Unfiltered,
   * that phantom sorted into the middle by x and silently stole a slot from a
   * real character, leaving them un-personalized.
   *
   * This is the DRAWN count, not the cast size. A page that draws three children
   * for a two-child book still says 3 here, and uses `slots` to say which drawn
   * characters get personalized.
   */
  characters?: number;
  /**
   * Which character slot each drawn character maps to, in left-to-right order of
   * the faces on the page. Omit when drawn order already matches the session's
   * character order (the common case). Use it when a page draws the cast in a
   * different order, or when a page features only a subset of the cast.
   */
  slots?: string[];
  /**
   * Strips app chrome baked into the source pixels before anything else runs.
   * Only the reference screenshots need this — the illustrator's own art is
   * already clean.
   */
  crop?: FaceBox;
  caption?: string;
  /**
   * Shown in the free preview. Everything else is only rendered once the book is
   * bought. This is the main cost lever: most visitors never buy, so we don't
   * pay to render their whole book.
   */
  preview?: boolean;
  /**
   * Measured wall-clock seconds for a real run, used for the demo UI countdown.
   * Deliberately PESSIMISTIC — the first estimates came from sequential CLI runs
   * and under-predicted a real parallel browser run by ~25%, because pages
   * running at once contend for the same Replicate account and get queued. In
   * front of a client, an estimate that comes in early is fine; one that
   * overruns is not.
   */
  estimateSeconds?: number;
}

export interface BookConfig {
  title: string;
  /** Page ids, in reading order. */
  pageIds: string[];
  /** Retail price in cents. Integer, never a float — avoids rounding bugs. */
  priceCents: number;
}

const ASSETS = path.resolve(process.cwd(), "../../assets/templates");

/**
 * Every page of artwork we can personalize.
 *
 * The three single-character pages are reference screenshots from a competitor's
 * preview flow, which is why they carry a `crop` — the French UI chrome is baked
 * into the pixels, not overlaid. They are fine for demonstrating the engine, but
 * they are NOT shippable page art; real replacement illustration is needed
 * before this is sold.
 */
export const PAGES: Record<string, Page> = {
  astronaut: {
    id: "astronaut",
    imagePath: path.join(ASSETS, "temp_1.jpeg"),
    crop: { left: 0, top: 0, width: 800, height: 750 },
    caption: "Floating among the planets",
    estimateSeconds: 135,
  },
  plane: {
    id: "plane",
    imagePath: path.join(ASSETS, "temp_2.jpeg"),
    crop: { left: 0, top: 112, width: 810, height: 649 },
    caption: "Off into the clouds",
    estimateSeconds: 195,
  },
  workshop: {
    id: "workshop",
    imagePath: path.join(ASSETS, "WhatsApp Image 2026-07-16 at 8.50.37 AM (2).jpeg"),
    crop: { left: 0, top: 0, width: 800, height: 739 },
    caption: "The young inventor",
    preview: true,
    estimateSeconds: 130,
  },

  // Two-character pages. Clean illustrator art already at the right framing, so
  // no chrome crop. Both draw the ADULT on the left and the CHILD on the right —
  // backwards from the upload convention (child uploaded first, as child_1), so
  // both need `slots` to remap: without it, the child's photo lands on the
  // drawn adult and vice versa. Confirmed live 2026-07-20 — the demo produced
  // exactly that mismatch before this was set.
  newtemp: {
    id: "newtemp",
    imagePath: path.join(ASSETS, "newtemp.jpg"),
    characters: 2,
    slots: ["child_2", "child_1"],
    caption: "Adventure land",
    preview: true,
    estimateSeconds: 185,
  },
  newtemp2: {
    id: "newtemp2",
    imagePath: path.join(ASSETS, "newtemp2.jpg"),
    characters: 2,
    slots: ["child_2", "child_1"],
    caption: "The adventure awaits",
    estimateSeconds: 185,
  },
};

export const BOOKS: Record<string, BookConfig> = {
  "demo-book": {
    title: "Demo book — one child",
    pageIds: ["workshop", "astronaut", "plane"],
    priceCents: 3490,
  },
  "demo-book-duo": {
    title: "Demo book — two children",
    pageIds: ["newtemp", "newtemp2"],
    priceCents: 3490,
  },
};

export function getPage(id: string): Page {
  const page = PAGES[id];
  if (!page) throw new Error(`Unknown page "${id}". Known: ${Object.keys(PAGES).join(", ")}.`);
  return page;
}

/** How many characters a page draws, defaulting to a solo page. */
export const characterCount = (page: Page): number => page.characters ?? 1;

export function getBook(storyId: string): BookConfig {
  const book = BOOKS[storyId];
  if (!book) throw new Error(`No book configured for storyId "${storyId}".`);
  return book;
}

export const bookPages = (book: BookConfig): Page[] => book.pageIds.map(getPage);

/**
 * Preview mode renders only the flagged pages; if a book flags none, the first
 * page stands in so a preview is never empty.
 */
export function pagesFor(book: BookConfig, mode: "preview" | "full"): Page[] {
  const pages = bookPages(book);
  if (mode === "full") return pages;
  const flagged = pages.filter((p) => p.preview);
  return flagged.length > 0 ? flagged : pages.slice(0, 1);
}

/**
 * Finished pages live at a predictable key, so both the worker (writing) and the
 * routes (listing) derive it from the book config alone — no extra bookkeeping
 * in the database.
 */
export const pageObjectKey = (sessionId: string, pageId: string): string =>
  `sessions/${sessionId}/pages/${pageId}.png`;
