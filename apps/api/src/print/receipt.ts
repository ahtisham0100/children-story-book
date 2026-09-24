import PDFDocument from "pdfkit";
import { PassThrough } from "node:stream";
import { GDPR_DELETION_NOTICE } from "../gdpr/notice";

export interface ReceiptData {
  id: string;
  createdAt: Date;
  email: string;
  currency: string;
  totalCents: number;
  shippingName: string;
  items: { bookTitle: string; priceCents: number }[];
}

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat("en", { style: "currency", currency }).format(cents / 100);
}

/**
 * A simple, self-contained purchase receipt as a one-page PDF. No network, no
 * fonts beyond PDFKit's built-in Helvetica, so it's deterministic and unit-
 * testable (a valid PDF starts with the "%PDF" magic bytes). This is the
 * customer's proof-of-purchase, distinct from the print PDF (the book itself).
 */
export async function buildReceiptPdf(order: ReceiptData): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 56 });
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
  doc.pipe(stream);

  doc.fontSize(22).font("Helvetica-Bold").text("Your Storybook");
  doc.moveDown(0.2);
  doc.fontSize(12).font("Helvetica").fillColor("#666").text("Order receipt");
  doc.fillColor("#000");
  doc.moveDown(1);

  doc.fontSize(10);
  doc.text(`Order ID:  ${order.id}`);
  doc.text(`Date:      ${order.createdAt.toISOString().slice(0, 10)}`);
  doc.text(`Billed to: ${order.email}`);
  doc.text(`Ship to:   ${order.shippingName}`);
  doc.moveDown(1);

  doc.font("Helvetica-Bold").text("Items");
  doc.font("Helvetica");
  doc.moveDown(0.3);
  for (const item of order.items) {
    const price = money(item.priceCents, order.currency);
    // Title left, price right-aligned on the same baseline.
    const y = doc.y;
    doc.text(item.bookTitle, { continued: false });
    doc.text(price, 56, y, { align: "right" });
  }

  doc.moveDown(0.6);
  doc
    .moveTo(56, doc.y)
    .lineTo(doc.page.width - 56, doc.y)
    .strokeColor("#ccc")
    .stroke();
  doc.moveDown(0.4);
  const totalY = doc.y;
  doc.font("Helvetica-Bold").text("Total");
  doc.text(money(order.totalCents, order.currency), 56, totalY, { align: "right" });

  doc.moveDown(2);
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#666")
    .text(GDPR_DELETION_NOTICE);

  doc.end();
  return done;
}
