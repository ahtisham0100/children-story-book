import sharp from "sharp";
import { cropBox } from "./faceDetect";
import type { FaceBox } from "./types";

// Multi-character geometry: how a page is cut into per-character crops, and how
// the finished crops are blended back onto the page.
//
// No API calls happen in this file, but the FIRST half of it decides what the
// models receive, so the two halves have very different risk profiles:
//
//   characterCrop  — changes what nano-banana and the swap model are sent.
//                    Any change needs a full repaint+swap re-verification.
//   cropOverlay    — only changes how the finished result is blended back in.
//                    Cannot affect swap reliability; free to iterate on.
//
// Fix cosmetic seam problems in cropOverlay, never in characterCrop.
//
// The measurements cited below were taken on a template (MC_1.jpeg) that has
// since been retired. They are kept deliberately: they are what justify these
// constants. They are history, not live references.

// How much wider than a face-swap crop (cropBox's 1.1x default) a repaint crop
// needs to be: repaint redraws hair and visible skin, not just the face, so it
// needs the child's whole head and some shoulder/arm in frame.
const REPAINT_CROP_PADDING_X = 1.8;
const REPAINT_CROP_PADDING_Y = 2.2;

// How much of the gap to a horizontal neighbour a crop may reach into, as a
// fraction of the gap between the two faces. NOT 0.5 (the midpoint): measured on
// a 417x502 page with ~78px faces and a 72px face-to-face gap, a raised hand
// reaching toward the other character starts ~20px into the gap from the near
// face's edge (~28% of the gap) — well short of the midpoint. At the midpoint
// clamp, the boy's repaint crop caught the man's fingertips; nano-banana then
// hallucinated a second partial head from that fragment (same hairstyle as the
// real boy, cut off at the crop edge), and the swap model's detector picked
// between the two inconsistently — "Couldn't find a usable face" on 4 of 5 real
// attempts against the exact same crop. 0.25 was confirmed clean by bisecting
// the actual crop width against that hand (safe to ~198px, artifact visible at
// 200px; 0.25 of the 72px gap lands at 196px).
const NEIGHBOR_CLAIM_FRACTION = 0.25;

// The proven single-character pages all crop landscape or square — 800x750
// (1.07), 800x739 (1.08), 810x649 (1.25) — never taller than wide. A standing
// character clamped tight against a neighbour is the opposite: cropBox's Y
// padding is unconstrained by a neighbour the way X is, so one clamped crop came
// out 196x470 — ratio 0.42, over twice as tall as the widest proven crop is
// narrow. nano-banana returned visibly inconsistent geometry on it (896x1152 vs
// a clean 1024x1024 for the unclamped neighbour) and hallucinated an artifact
// near the horizon; the swap model's detector then failed 8 of 10 real attempts
// against several different repaints of that same crop, while the square
// neighbour crop succeeded essentially every time. Capping height to width keeps
// the shape in the proven range without touching NEIGHBOR_CLAIM_FRACTION.
const MAX_HEIGHT_TO_WIDTH = 1.25;

/**
 * The repaint crop for one drawn character, bounded so it can never reach a
 * neighbouring character's face — or, close enough, their gesturing hand — and
 * shaped like the crops the recipe is actually proven on.
 *
 * cropBox's padding is generous by design, and on a page where characters stand
 * close together that padding overruns the neighbour. A crop holding any hint of
 * a second character has no defined behaviour: REPAINT_PROMPT describes a single
 * child, and swapIdentity picks a face on its own. Unclamped, two crops on the
 * same page were 318px and 302px wide and each contained BOTH faces.
 *
 * The vertical split is centred on the face's own centre. This exact split is
 * the one confirmed end-to-end; a later attempt to bias more room above the face
 * (to fix an unrelated cosmetic seam) changed what the models received and swap
 * reliability regressed — reverted. DO NOT CHANGE THE SPLIT.
 *
 * Horizontal clamp only: pages place characters side by side and detection sorts
 * left-to-right, so a vertical neighbour clamp would be untested generality.
 */
export function characterCrop(face: FaceBox, faces: FaceBox[], width: number, height: number): FaceBox {
  const crop = cropBox(face, width, height, REPAINT_CROP_PADDING_X, REPAINT_CROP_PADDING_Y);
  const faceRight = face.left + face.width;
  let left = crop.left;
  let right = crop.left + crop.width;

  for (const other of faces) {
    if (other === face) continue;
    const otherRight = other.left + other.width;
    if (otherRight <= face.left) {
      const gap = face.left - otherRight;
      left = Math.max(left, Math.round(face.left - gap * NEIGHBOR_CLAIM_FRACTION)); // neighbour to the left
    } else if (other.left >= faceRight) {
      const gap = other.left - faceRight;
      right = Math.min(right, Math.round(faceRight + gap * NEIGHBOR_CLAIM_FRACTION)); // neighbour to the right
    }
  }
  const cropWidth = Math.max(1, right - left);

  let top = crop.top;
  let bottom = crop.top + crop.height;
  const maxHeight = cropWidth * MAX_HEIGHT_TO_WIDTH;
  if (bottom - top > maxHeight) {
    const faceCenterY = face.top + face.height / 2;
    top = Math.max(0, Math.round(faceCenterY - maxHeight / 2));
    bottom = Math.min(height, Math.round(faceCenterY + maxHeight / 2));
  }

  return { left, top, width: cropWidth, height: Math.max(1, bottom - top) };
}

/**
 * Feathers a finished (repainted) crop back onto its rectangular slot.
 *
 * `fit: "cover"` (scale to fill, centre-cropping the overhang), not "fill":
 * nano-banana doesn't preserve the input crop's aspect ratio (a 185x232 input
 * crop came back a flat 1024x1024 square). "fill" would stretch that mismatch to
 * force an exact fit, warping proportions and shifting the head off the position
 * the crop was measured for. "cover" keeps proportions correct, and since
 * nano-banana keeps the face roughly centred in its own output, the
 * centre-cropped face stays aligned with where the slot expects it.
 *
 * THREE SIDES GET A TIGHT MARGIN, THE BOTTOM GETS A WIDE ONE. Repaint redraws
 * hair a different colour and volume than the original illustration's, so near
 * the top edge the original and repainted hair silhouettes don't occupy the same
 * pixels. A wide fade there blends partially-transparent ORIGINAL content with
 * partially-transparent REPAINTED content across the whole band — a visible
 * ghost/double-exposure halo above the head. A near-hard cut avoids the blend
 * entirely: outside the crop is unchanged original background, inside is fully
 * the repainted character, and the seam sits in plain background.
 *
 * Left and right need the same tight margin, because characterCrop's neighbour
 * clamp pulls the crop in close on whichever side faces another character — so
 * that character's face and hands end up near the edge too, and a wide fade
 * showed the identical ghosting next to a neighbour's face and waving arm.
 *
 * Only the bottom stays generous: it fades into torso and clothing, which
 * repaint leaves unchanged, so there is no silhouette mismatch to blend.
 */
export async function cropOverlay(finishedCrop: Buffer, crop: FaceBox): Promise<sharp.OverlayOptions> {
  const normalized = await sharp(finishedCrop)
    .resize(crop.width, crop.height, { fit: "cover", position: "centre" })
    .ensureAlpha()
    .toBuffer();

  const tight = (size: number) => Math.max(4, Math.round(size * 0.04));
  const marginLeft = tight(crop.width);
  const marginRight = tight(crop.width);
  const marginTop = tight(crop.height);
  const marginBottom = Math.max(4, Math.round(crop.height * 0.15));
  const edgeFade = (pos: number, size: number, marginStart: number, marginEnd: number) => {
    if (pos < marginStart) return pos / marginStart;
    if (pos > size - marginEnd) return (size - pos) / marginEnd;
    return 1;
  };

  const rgba = Buffer.alloc(crop.width * crop.height * 4);
  const { data: src, info } = await sharp(normalized).raw().toBuffer({ resolveWithObject: true });
  for (let y = 0; y < crop.height; y += 1) {
    const fy = edgeFade(y, crop.height, marginTop, marginBottom);
    for (let x = 0; x < crop.width; x += 1) {
      const fx = edgeFade(x, crop.width, marginLeft, marginRight);
      const si = (y * crop.width + x) * info.channels;
      const di = (y * crop.width + x) * 4;
      rgba[di] = src[si] ?? 0;
      rgba[di + 1] = src[si + 1] ?? 0;
      rgba[di + 2] = src[si + 2] ?? 0;
      rgba[di + 3] = Math.round(255 * Math.max(0, Math.min(1, fx * fy)));
    }
  }
  const png = await sharp(rgba, { raw: { width: crop.width, height: crop.height, channels: 4 } }).png().toBuffer();
  return { input: png, left: crop.left, top: crop.top };
}
