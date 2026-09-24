import sharp from "sharp";
import * as tf from "@tensorflow/tfjs";
import * as blazeface from "@tensorflow-models/blazeface";
import type { FaceBox } from "./types";

// Local face detection — no API cost, so it is free to run as often as needed.
// Used by validate.ts (exactly-one-face check on a parent's upload), by
// personalize.ts (finding the drawn characters on a page), and by the heal and
// eyes stages (locating the personalized face in a finished render).
//
// Uses @tensorflow/tfjs (pure JS/WASM, CPU backend) + blazeface instead of
// face-api.js, which requires the native `canvas` package — a risky native
// build dependency on Windows under a tight deadline.

let modelPromise: Promise<blazeface.BlazeFaceModel> | undefined;

async function getModel(): Promise<blazeface.BlazeFaceModel> {
  modelPromise ??= (async () => {
    await tf.setBackend("cpu");
    await tf.ready();
    return blazeface.load();
  })();
  return modelPromise;
}

/**
 * Loads the model now instead of on the first real call. Measured at ~5-13s
 * (higher under concurrent CPU load) — a one-time tax per process, not per
 * render, but every caller (validate, detectPageCharacters, heal, eyes) shares
 * the same cached promise, so whichever happens to go first eats it. Call this
 * at server/worker startup so it lands during boot instead of a user's first
 * request.
 */
export async function warmFaceDetector(): Promise<void> {
  await getModel();
}

export interface Point {
  x: number;
  y: number;
}

// blazeface's fixed landmark order: right eye, left eye, nose tip, mouth, right
// ear, left ear — "right"/"left" are the subject's own left/right, i.e. mirrored
// in image space (subject's right eye appears on the left side of the frame).
export interface FaceLandmarks {
  rightEye: Point;
  leftEye: Point;
  noseTip: Point;
  mouth: Point;
  rightEar: Point;
  leftEar: Point;
}

export interface DetectedFace {
  score: number;
  box: FaceBox;
  landmarks: FaceLandmarks | undefined;
}

export interface DetectFacesResult {
  width: number;
  height: number;
  faces: DetectedFace[];
}

export async function detectFaces(imageBuffer: Buffer): Promise<DetectFacesResult> {
  const { data, info } = await sharp(imageBuffer)
    .removeAlpha()
    .toColorspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });

  const model = await getModel();
  const tensor = tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3]);

  try {
    const predictions = await model.estimateFaces(tensor, false);
    const faces: DetectedFace[] = [];

    for (const prediction of predictions) {
      const topLeft = prediction.topLeft as number[];
      const bottomRight = prediction.bottomRight as number[];
      const [tlx, tly] = topLeft;
      const [brx, bry] = bottomRight;
      if (tlx === undefined || tly === undefined || brx === undefined || bry === undefined) {
        continue;
      }
      const rawScore = Array.isArray(prediction.probability)
        ? prediction.probability[0]
        : (prediction.probability as unknown as number);

      const rawLandmarks = prediction.landmarks as number[][] | undefined;
      let landmarks: FaceLandmarks | undefined;
      if (Array.isArray(rawLandmarks) && rawLandmarks.length >= 6) {
        const toPoint = (pair: number[] | undefined): Point => ({ x: pair?.[0] ?? 0, y: pair?.[1] ?? 0 });
        landmarks = {
          rightEye: toPoint(rawLandmarks[0]),
          leftEye: toPoint(rawLandmarks[1]),
          noseTip: toPoint(rawLandmarks[2]),
          mouth: toPoint(rawLandmarks[3]),
          rightEar: toPoint(rawLandmarks[4]),
          leftEar: toPoint(rawLandmarks[5]),
        };
      }

      faces.push({
        score: rawScore ?? 0,
        box: {
          left: Math.max(0, Math.round(tlx)),
          top: Math.max(0, Math.round(tly)),
          width: Math.max(1, Math.round(brx - tlx)),
          height: Math.max(1, Math.round(bry - tly)),
        },
        landmarks,
      });
    }

    return { width: info.width, height: info.height, faces };
  } finally {
    tensor.dispose();
  }
}

// Illustrated faces score lower than photos with a detector trained on real
// faces, so this is well below validate.ts's 0.9.
const PAGE_FACE_CONFIDENCE_THRESHOLD = 0.6;

// Treats two boxes as the same detected face if their centres are close
// relative to their size — more forgiving than IoU when two passes crop the
// same face slightly differently (e.g. whole-image vs. a half-image pass).
function sameFace(a: FaceBox, b: FaceBox): boolean {
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  const bx = b.left + b.width / 2;
  const by = b.top + b.height / 2;
  const scale = Math.min(a.width, a.height, b.width, b.height);
  return Math.hypot(ax - bx, ay - by) < scale * 0.6;
}

/**
 * Finds the drawn characters on a page, left to right.
 *
 * Ordering by x is the whole mapping convention for multi-character pages: the
 * leftmost drawn character is the page's first slot. A page can override this
 * with an explicit `slots` list when the drawn order isn't left-to-right.
 *
 * A single whole-page pass is enough for a solo-character page, but blazeface
 * (a small, mobile-oriented model) was measured to miss one of two children
 * standing side by side in the same wide frame — it only reliably finds both
 * when detected in a narrower crop. It's also sensitive to the *exact* crop
 * width in a way that isn't systematic (a 65%-width crop missed a face that
 * 60%, 62% and 70% all caught) — so rather than pick one "safe" ratio, this
 * runs several overlapping windows and merges whatever any of them find,
 * deduping faces caught by more than one window. All passes are local CPU
 * work (no API cost).
 *
 * `expectedCount`, when given, caps the result at the top-N highest-scoring
 * candidates — a defence against the same multi-window search occasionally
 * finding an extra, lower-confidence false positive (see the comment above
 * `kept` below). Omit it for pages where the drawn face count genuinely
 * isn't known in advance, or where `slots` intentionally selects a subset of
 * a page that draws more characters than are in the cast — that's a
 * different case from a false positive and this option must not be used to
 * paper over it.
 */
export async function detectPageCharacters(pageBuffer: Buffer, expectedCount?: number): Promise<FaceBox[]> {
  const meta = await sharp(pageBuffer).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  const windows = [
    { left: 0, width },
    { left: 0, width: Math.round(width * 0.6) },
    { left: Math.round(width * 0.2), width: Math.round(width * 0.6) },
    { left: Math.round(width * 0.4), width: width - Math.round(width * 0.4) },
  ];

  const results = await Promise.all(
    windows.map(async (w) => {
      const cropWidth = Math.min(w.width, width - w.left);
      const buffer =
        w.left === 0 && cropWidth === width
          ? pageBuffer
          : await sharp(pageBuffer).extract({ left: w.left, top: 0, width: cropWidth, height }).png().toBuffer();
      const { faces } = await detectFaces(buffer);
      return faces.map((f) => ({ box: { ...f.box, left: f.box.left + w.left }, score: f.score }));
    }),
  );

  const candidates = results
    .flat()
    .filter((c) => c.score >= PAGE_FACE_CONFIDENCE_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  const merged: FaceBox[] = [];
  for (const candidate of candidates) {
    if (merged.some((box) => sameFace(box, candidate.box))) continue;
    merged.push(candidate.box);
  }

  // `merged` is still in the descending-score order `candidates` was built in
  // (dedup only ever drops entries, never reorders), so when the caller knows
  // exactly how many characters are drawn, keeping only the top `expectedCount`
  // by score — before the final left-to-right sort — drops the lowest-
  // confidence extras instead of silently including them. Needed for real
  // false positives: on one template, one of the four detection windows
  // scored a rocket ship's window 0.874 as a face (plausible-looking
  // landmarks — a geometric sanity check doesn't catch it), lower than both
  // real characters (0.94, 0.92) but well above PAGE_FACE_CONFIDENCE_THRESHOLD.
  // Left unfiltered, that 3rd box sorts into the middle position by x and
  // silently steals a slot from the real character next to it (assignment in
  // personalizePage is positional, left-to-right).
  const kept = expectedCount !== undefined && merged.length > expectedCount ? merged.slice(0, expectedCount) : merged;

  return kept.sort((a, b) => a.left - b.left);
}

// Generic padded crop around a detected face. `paddingX`/`paddingY` are
// multiples of the face's own width/height — bigger for callers that need to
// redraw more than the face itself (e.g. a full repaint needs hair/shoulders
// in frame), smaller for callers that only need the face plus enough context
// for a model's own internal face detector to work (e.g. a face-swap crop).
export function cropBox(
  face: FaceBox,
  width: number,
  height: number,
  paddingX = 1.1,
  paddingY = 1.1,
): FaceBox {
  const padX = face.width * paddingX;
  const padY = face.height * paddingY;
  const left = Math.max(0, Math.round(face.left - padX));
  const top = Math.max(0, Math.round(face.top - padY));
  const right = Math.min(width, Math.round(face.left + face.width + padX));
  const bottom = Math.min(height, Math.round(face.top + face.height + padY));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}
