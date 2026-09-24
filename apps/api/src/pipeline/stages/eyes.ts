import sharp from "sharp";
import { detectFaces } from "../faceDetect";

// STAGE 5 of 5 — paint the repaint's eyes back over the swap's.
//
// THE PROBLEM: the swap aligns the photo's face to the REPAINT's landmarks. On a
// children's-book child those landmarks describe a large stylised eye, so the
// photo's much smaller real eye lands inside it and the repaint's original iris
// survives around the edge as a dark ring — a small realistic eye floating in a
// large brown disc. The artifact is produced INSIDE the swap output, so it is
// not a compositing bug.
//
// EVERYTHING ELSE TRIED, AND WHY IT FAILED (do not retry these):
//   - Prompt hardening. Failed three times over (hair length, eyebrows, eye
//     size). Even a concrete "each eye = one fifth of face width" instruction
//     did not shrink the child's eyes — the adult character complied, the child
//     never did. Prompts do not control child facial geometry.
//   - CodeFormer at lower fidelity. Swept 0.8/0.5/0.3/0.1; it DEGRADES as
//     fidelity drops, losing the pupil entirely at 0.1.
//   - The heal stage. By design it only touches near-white specks; this
//     artifact is dark, so it is skipped.
//   - Skipping the swap entirely. Removes the artifact and looks lovely, but
//     likeness collapses to a generic cartoon kid. Kept as a flag, not shipped.
//
// THE TRADE-OFF, stated honestly: the child keeps the illustration's eye colour
// and shape rather than the photograph's. Identity comes from face shape, skin
// and hair instead. This is the accepted cost of removing the ring.
//
// Runs LAST so neither restore nor heal can reintroduce the ring.
// Fail-safe: no face or no landmarks means the image is returned untouched.

// How far the patch reaches, as a multiple of the inter-eye distance. The swap's
// malformed iris is WIDER than the eye it replaced, so a patch sized to the eye
// alone leaves a brown crescent below it. Sized by local sweep at zero API cost:
// 0.42x0.34 and 0.55x0.48 both left a visible ring; 0.65x0.58 is the first clean
// one.
const EYE_PATCH_RX = 0.65;
const EYE_PATCH_RY = 0.58;
const EYE_PATCH_FEATHER = 0.35; // fraction of the radius spent fading out

/** Blend the pre-swap eye region back over the swapped result. */
export async function restoreEyeRegion(swappedBuf: Buffer, repaintBuf: Buffer): Promise<Buffer> {
  const { faces } = await detectFaces(swappedBuf);
  if (faces.length === 0) return swappedBuf;
  const face = [...faces].sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0];
  const lm = face?.landmarks;
  if (!face || !lm) return swappedBuf;

  const meta = await sharp(swappedBuf).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (W === 0 || H === 0) return swappedBuf;

  // The repaint is the same crop, but restore/heal upstream may have changed the
  // pixel grid — align defensively before sampling.
  const repaintRaw = await sharp(repaintBuf).resize(W, H, { fit: "fill" }).removeAlpha().toColourspace("srgb").raw().toBuffer();
  const swapRaw = await sharp(swappedBuf).removeAlpha().toColourspace("srgb").raw().toBuffer();

  const eyeDist = Math.hypot(lm.leftEye.x - lm.rightEye.x, lm.leftEye.y - lm.rightEye.y) || face.box.width * 0.3;
  const rx = eyeDist * EYE_PATCH_RX;
  const ry = eyeDist * EYE_PATCH_RY;

  const out = Buffer.from(swapRaw);
  for (const eye of [lm.leftEye, lm.rightEye]) {
    const x0 = Math.max(0, Math.floor(eye.x - rx));
    const x1 = Math.min(W, Math.ceil(eye.x + rx));
    const y0 = Math.max(0, Math.floor(eye.y - ry));
    const y1 = Math.min(H, Math.ceil(eye.y + ry));
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const d = Math.hypot((x - eye.x) / rx, (y - eye.y) / ry);
        if (d >= 1) continue;
        const a = d < 1 - EYE_PATCH_FEATHER ? 1 : (1 - d) / EYE_PATCH_FEATHER;
        const i = (y * W + x) * 3;
        for (let c = 0; c < 3; c += 1) {
          out[i + c] = Math.round((swapRaw[i + c] ?? 0) * (1 - a) + (repaintRaw[i + c] ?? 0) * a);
        }
      }
    }
  }
  return sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}
