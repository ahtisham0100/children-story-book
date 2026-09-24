import { describe, it, expect } from "vitest";
import { buildReceiptPdf } from "../../src/print/receipt";

describe("buildReceiptPdf", () => {
  it("produces a valid PDF buffer", async () => {
    const pdf = await buildReceiptPdf({
      id: "order-123",
      createdAt: new Date("2026-09-15T10:00:00Z"),
      email: "parent@example.com",
      currency: "eur",
      totalCents: 3490,
      shippingName: "A Parent",
      items: [{ bookTitle: "Demo book — one child", priceCents: 3490 }],
    });
    expect(Buffer.isBuffer(pdf)).toBe(true);
    // Every PDF starts with the "%PDF" magic bytes.
    expect(pdf.subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(pdf.length).toBeGreaterThan(500);
  });

  it("handles a multi-item order", async () => {
    const pdf = await buildReceiptPdf({
      id: "order-456",
      createdAt: new Date(),
      email: "p@example.com",
      currency: "eur",
      totalCents: 6980,
      shippingName: "Two Books",
      items: [
        { bookTitle: "Book A", priceCents: 3490 },
        { bookTitle: "Book B", priceCents: 3490 },
      ],
    });
    expect(pdf.subarray(0, 4).toString("latin1")).toBe("%PDF");
  });
});
