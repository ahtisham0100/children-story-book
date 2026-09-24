import PDFDocument from "pdfkit";
import { PassThrough } from "node:stream";
import sharp from "sharp";
import { getObjectBuffer, putObject } from "../storage";
import { env } from "../env";

const POINTS_PER_INCH = 72;
// 300 DPI at the configured trim size — see env.ts for the caveat that actual
// sharpness is bounded by the pipeline's current render resolution (~800x739px),
// not by anything in this file. This file does the color-space part correctly
// regardless: RGB PNG -> CMYK JPEG -> embedded in a CMYK-safe PDF.
const DPI = 300;

function pageSizePoints(): { width: number; height: number } {
  return {
    width: env.PRINT_TRIM_WIDTH_IN * POINTS_PER_INCH,
    height: env.PRINT_TRIM_HEIGHT_IN * POINTS_PER_INCH,
  };
}

function pageSizePixels(): { width: number; height: number } {
  return {
    width: Math.round(env.PRINT_TRIM_WIDTH_IN * DPI),
    height: Math.round(env.PRINT_TRIM_HEIGHT_IN * DPI),
  };
}

/**
 * Converts one rendered page (RGB PNG) to a print-ready CMYK JPEG at the
 * configured trim size. `.toColourspace("cmyk")` before `.jpeg()` is what makes
 * the output an actual CMYK JPEG (with the Adobe APP14 marker readers use to
 * tell it apart from RGB) rather than an RGB JPEG that merely claims to be
 * print-ready.
 */
export async function renderPageToCmykJpeg(pngBuffer: Buffer): Promise<Buffer> {
  const { width, height } = pageSizePixels();
  return sharp(pngBuffer)
    .resize(width, height, { fit: "cover" })
    .flatten({ background: "#ffffff" })
    .toColourspace("cmyk")
    .jpeg({ quality: 95 })
    .toBuffer();
}

function assemblePdfBuffer(cmykJpegPages: Buffer[]): Promise<Buffer> {
  const { width, height } = pageSizePoints();
  const doc = new PDFDocument({ size: [width, height], margin: 0, autoFirstPage: false });
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
  doc.pipe(stream);
  for (const jpeg of cmykJpegPages) {
    doc.addPage({ size: [width, height], margin: 0 });
    doc.image(jpeg, 0, 0, { width, height });
  }
  doc.end();
  return done;
}

export const printPdfObjectKey = (orderId: string, orderItemId: string): string =>
  `orders/${orderId}/items/${orderItemId}/print.pdf`;

/** Pulls every rendered page for one OrderItem, converts, assembles, uploads. */
export async function assembleItemPdf(
  orderId: string,
  item: { id: string; printPageKeys: string[] },
): Promise<{ key: string }> {
  const pngBuffers = await Promise.all(item.printPageKeys.map((key) => getObjectBuffer(key)));
  const cmykPages = await Promise.all(pngBuffers.map((buf) => renderPageToCmykJpeg(buf)));
  const pdfBuffer = await assemblePdfBuffer(cmykPages);
  const key = printPdfObjectKey(orderId, item.id);
  await putObject(key, pdfBuffer, "application/pdf");
  return { key };
}
