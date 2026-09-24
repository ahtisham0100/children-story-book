import { getObjectBuffer } from "../storage";
import { detectFaces } from "./faceDetect";
import type { ValidationResult } from "./types";

const MIN_DIMENSION = 200;
const FACE_CONFIDENCE_THRESHOLD = 0.9;

export class ValidationError extends Error {}

/**
 * The actual checks, on in-memory bytes. Both entry points share this: the
 * production worker (via `validatePhoto`, which reads the upload from R2) and the
 * standalone homepage (which already holds the photo as a decoded buffer). Keeping
 * one implementation means the demo can't drift into accepting photos the real
 * pipeline would reject downstream — the whole point is to fail fast and free,
 * before any paid repaint/swap runs.
 */
export async function validatePhotoBuffer(buffer: Buffer): Promise<ValidationResult> {
  const { width, height, faces } = await detectFaces(buffer);

  if (width < MIN_DIMENSION || height < MIN_DIMENSION) {
    throw new ValidationError(
      `Photo is too small (${width}x${height}px) — please upload at least ${MIN_DIMENSION}x${MIN_DIMENSION}px.`,
    );
  }

  const confidentFaces = faces.filter((f) => f.score >= FACE_CONFIDENCE_THRESHOLD);

  if (confidentFaces.length === 0) {
    throw new ValidationError("No face detected — please upload a clear photo of the child's face.");
  }
  if (confidentFaces.length > 1) {
    throw new ValidationError("Multiple faces detected — please upload a photo with just one child.");
  }

  const [face] = confidentFaces;
  if (!face) {
    throw new ValidationError("No face detected — please upload a clear photo of the child's face.");
  }

  return { width, height, faceBox: face.box };
}

/** Production-worker entry point: validate an upload sitting in R2. */
export async function validatePhoto(rawKey: string): Promise<ValidationResult> {
  const buffer = await getObjectBuffer(rawKey);
  return validatePhotoBuffer(buffer);
}
