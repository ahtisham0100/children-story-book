import sharp from "sharp";
import { detectFaces } from "../faceDetect";

// STAGE 4 of 5 — remove the small bright specks the swap leaves on face skin
// (the "white dot under the eye", tear-track streaks). CodeFormer preserves
// them, so they have to be healed explicitly.
//
// Scope is deliberately narrow: NEAR-WHITE specks only. The dark iris-ring
// artifact is a different problem and belongs to the eyes stage.
//
// Fail-safe by design — no face, no landmarks, or nothing speck-like means the
// image comes back untouched. It never invents an edit.

interface Speck {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  pixels: number;
}

/** 4-connected components of a bright-pixel mask, restricted to a region. */
function findClusters(bright: Uint8Array, W: number, x0: number, y0: number, x1: number, y1: number): Speck[] {
  const seen = new Uint8Array(bright.length);
  const specks: Speck[] = [];
  const stack: number[] = [];
  for (let sy = y0; sy < y1; sy += 1) {
    for (let sx = x0; sx < x1; sx += 1) {
      const start = sy * W + sx;
      if (!bright[start] || seen[start]) continue;
      let minX = sx, maxX = sx, minY = sy, maxY = sy, count = 0;
      stack.push(start);
      seen[start] = 1;
      while (stack.length) {
        const p = stack.pop() as number;
        const px = p % W, py = (p - px) / W;
        count += 1;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = px + dx, ny = py + dy;
          if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1) continue;
          const np = ny * W + nx;
          if (bright[np] && !seen[np]) {
            seen[np] = 1;
            stack.push(np);
          }
        }
      }
      specks.push({ minX, maxX, minY, maxY, pixels: count });
    }
  }
  return specks;
}

/**
 * Median skin colour of the ring of non-bright pixels around a speck's bbox,
 * or null if this speck should be left alone.
 *
 * This ring test is the pipeline's real discriminator between an artifact and a
 * legitimate highlight: a genuine eye catchlight is ringed by dark iris, an
 * artifact sitting on the cheek is ringed by skin.
 */
function ringMedianColour(
  data: Buffer,
  W: number,
  H: number,
  C: number,
  bright: Uint8Array,
  s: Speck,
  ring: number,
): [number, number, number] | null {
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  let ringTotal = 0, ringDark = 0;
  for (let y = s.minY - ring; y <= s.maxY + ring; y += 1) {
    for (let x = s.minX - ring; x <= s.maxX + ring; x += 1) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const inBbox = x >= s.minX && x <= s.maxX && y >= s.minY && y <= s.maxY;
      if (inBbox) continue;
      const i = (y * W + x) * C;
      const r = data[i] ?? 0, g = data[i + 1] ?? 0, b = data[i + 2] ?? 0;
      ringTotal += 1;
      if (Math.min(r, g, b) < 70) ringDark += 1; // dark neighbour = edge of an eye/mouth, not skin
      if (bright[y * W + x]) continue; // sample skin tone from the non-bright ring pixels only
      rs.push(r); gs.push(g); bs.push(b);
    }
  }
  // Heal only a speck that sits ON skin. Ringed by dark pixels = an eye
  // catchlight (dark iris) or a tooth highlight (dark mouth) — leave it.
  if (rs.length < 6 || ringTotal === 0 || ringDark / ringTotal > 0.5) return null;
  const mid = (arr: number[]) => arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)] ?? 0;
  const median: [number, number, number] = [mid(rs), mid(gs), mid(bs)];
  // Warm mid-tone sanity — never paint a bright/near-white or unnaturally cool patch.
  if (median[0] < median[2] || Math.min(...median) > 225) return null;
  return median;
}

/** A feathered elliptical patch of solid `colour`, sized to cover the speck. */
async function healPatch(colour: [number, number, number], s: Speck, pad: number): Promise<sharp.OverlayOptions> {
  const pw = s.maxX - s.minX + 1 + 2 * pad;
  const ph = s.maxY - s.minY + 1 + 2 * pad;
  const cx = pw / 2, cy = ph / 2, rx = pw / 2, ry = ph / 2;
  const rgba = Buffer.alloc(pw * ph * 4);
  for (let y = 0; y < ph; y += 1) {
    for (let x = 0; x < pw; x += 1) {
      const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
      const alpha = d >= 1 ? 0 : d < 0.55 ? 255 : Math.round(255 * (1 - (d - 0.55) / 0.45));
      const i = (y * pw + x) * 4;
      rgba[i] = colour[0]; rgba[i + 1] = colour[1]; rgba[i + 2] = colour[2]; rgba[i + 3] = alpha;
    }
  }
  const png = await sharp(rgba, { raw: { width: pw, height: ph, channels: 4 } }).png().toBuffer();
  return { input: png, left: s.minX - pad, top: s.minY - pad };
}

/** Heal small near-white swap artifacts on the personalized child's face. */
export async function healSwapArtifacts(imageBuf: Buffer): Promise<Buffer> {
  const { faces } = await detectFaces(imageBuf);
  if (faces.length === 0) return imageBuf;
  // The personalized child is the most prominent face on the page.
  const face = [...faces].sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0];
  const lm = face?.landmarks;
  if (!face || !lm) return imageBuf; // without landmarks we can't protect eye/teeth highlights — don't risk it

  const { data, info } = await sharp(imageBuf).removeAlpha().toColorspace("srgb").raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, C = info.channels;

  const fb = face.box;
  const x0 = Math.max(0, fb.left), x1 = Math.min(W, fb.left + fb.width);
  const y0 = Math.max(0, fb.top), y1 = Math.min(H, fb.top + fb.height);

  // The eyes are NOT protected by a distance disc: measured, the blazeface eye
  // landmark is ~14px off the actual catchlight, and swap artifacts (tear-track
  // streaks) sit only 3-11px below the eye — so any disc big enough to cover the
  // catchlight also swallows the artifact. ringMedianColour's skin gate is the
  // reliable discriminator instead. Only the nose specular and the teeth —
  // bright features ringed by skin/lips, which the ring gate can't tell from an
  // artifact — still need an explicit disc.
  const eyeDist = Math.hypot(lm.leftEye.x - lm.rightEye.x, lm.leftEye.y - lm.rightEye.y) || fb.width * 0.3;
  const discs = [
    { x: lm.mouth.x, y: lm.mouth.y, r: eyeDist * 0.4 },
    { x: lm.noseTip.x, y: lm.noseTip.y, r: eyeDist * 0.25 },
  ];
  const protectedPx = (x: number, y: number) => discs.some((d) => Math.hypot(x - d.x, y - d.y) < d.r);

  // Near-white, low-saturation pixels on the face skin = candidate specks.
  const bright = new Uint8Array(W * H);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (protectedPx(x, y)) continue;
      const i = (y * W + x) * C;
      const r = data[i] ?? 0, g = data[i + 1] ?? 0, b = data[i + 2] ?? 0;
      const mn = Math.min(r, g, b), mx = Math.max(r, g, b);
      if (mn > 200 && mx - mn < 40) bright[y * W + x] = 1;
    }
  }
  // Dilate by 1px so a streak fragmented by anti-aliasing heals as one clean
  // patch instead of a scatter of overlapping dots.
  const dilated = new Uint8Array(W * H);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (!bright[y * W + x]) continue;
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx, ny = y + dy;
        if (nx >= x0 && nx < x1 && ny >= y0 && ny < y1) dilated[ny * W + nx] = 1;
      }
    }
  }

  // Keep only small clusters — real swap specks are small; a large bright blob
  // is more likely a legitimate highlight we should leave alone.
  const specks = findClusters(dilated, W, x0, y0, x1, y1)
    .filter((s) => s.pixels >= 3 && s.pixels <= 200 && s.maxX - s.minX <= 40 && s.maxY - s.minY <= 40)
    .sort((a, b) => b.pixels - a.pixels)
    .slice(0, 15);
  if (specks.length === 0) return imageBuf;

  const overlays: sharp.OverlayOptions[] = [];
  for (const s of specks) {
    const colour = ringMedianColour(data, W, H, C, bright, s, 4);
    if (process.env.HEAL_DEBUG) {
      console.error(`speck bbox=[${s.minX},${s.minY},${s.maxX},${s.maxY}] px=${s.pixels} -> ${colour ? `HEAL ${colour}` : "reject"}`);
    }
    if (colour) overlays.push(await healPatch(colour, s, 3));
  }
  if (overlays.length === 0) return imageBuf;
  return sharp(imageBuf).composite(overlays).png().toBuffer();
}
