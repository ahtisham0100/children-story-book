import { describe, it, expect } from "vitest";
import { buildConfigSnapshot, buildPrintPageKeys } from "../../src/orderSnapshot";
import type { BookConfig } from "../../src/pipeline/catalog";

describe("buildConfigSnapshot", () => {
  it("snapshots slot, childName, and rawKey for each character", () => {
    const snapshot = buildConfigSnapshot([
      { slot: "child_1", childName: "Amina", rawKey: "sessions/abc/characters/1/raw.jpg" },
    ]);
    expect(snapshot).toEqual([
      { slot: "child_1", childName: "Amina", rawKey: "sessions/abc/characters/1/raw.jpg" },
    ]);
  });

  it("throws if any character has no uploaded photo yet", () => {
    expect(() =>
      buildConfigSnapshot([{ slot: "child_1", childName: "Amina", rawKey: null }]),
    ).toThrow();
  });
});

describe("buildPrintPageKeys", () => {
  it("derives one R2 key per page, in reading order", () => {
    const book: BookConfig = { title: "t", priceCents: 100, pageIds: ["workshop", "astronaut"] };
    expect(buildPrintPageKeys("session-1", book)).toEqual([
      "sessions/session-1/pages/workshop.png",
      "sessions/session-1/pages/astronaut.png",
    ]);
  });
});
