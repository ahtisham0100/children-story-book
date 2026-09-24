import { describe, it, expect } from "vitest";
import { priceCentsForBook, computeTotalCents } from "../../src/pricing";

describe("priceCentsForBook", () => {
  it("returns the configured price for a known book", () => {
    expect(priceCentsForBook("demo-book")).toBe(3490);
  });

  it("throws for an unknown storyId", () => {
    expect(() => priceCentsForBook("no-such-book")).toThrow();
  });
});

describe("computeTotalCents", () => {
  it("sums prices across multiple books", () => {
    const result = computeTotalCents(["demo-book", "demo-book-duo"]);
    expect(result.totalCents).toBe(6980);
    expect(result.currency).toBe("eur");
  });

  it("returns zero for an empty cart", () => {
    expect(computeTotalCents([]).totalCents).toBe(0);
  });
});
