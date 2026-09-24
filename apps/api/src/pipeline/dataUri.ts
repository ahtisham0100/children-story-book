/**
 * Replicate takes images as URLs or data URIs. Everything the engine passes
 * between stages is an in-memory Buffer, so this is the one place that converts.
 */
export const dataUri = (buf: Buffer, ext: "png" | "jpeg" = "png"): string =>
  `data:image/${ext};base64,${buf.toString("base64")}`;
