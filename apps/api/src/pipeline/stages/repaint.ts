import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { runReplicate, fetchToBuffer } from "../replicate";
import { dataUri } from "../dataUri";

// STAGE 1 of 5 — redraw the whole illustration as this child.
//
// This is the stage that does the real work. nano-banana SEES the photograph, so
// one generic prompt personalizes any child with no per-child hair/skin text, and
// because it redraws the artwork cohesively there are no seams or halos. The
// later stages only clean up after it.
//
// COST vs LATENCY — these are different stages, which is easy to get backwards.
// Reconstructed from the Replicate account's real prediction history: repaint is
// the dominant COST at a flat $0.039/image (Google's own price, no Replicate
// markup) but is FAST at ~9-12s. The swap is the dominant LATENCY at ~55-90s.
// A whole page runs ~90-170s wall time. Don't optimize repaint for speed or the
// swap for cost.
//
// nano-banana-2-lite is kept behind a flag but is NOT a usable cost lever: tried
// once, it discarded the template scene entirely and hallucinated an unrelated
// one instead of editing it. It is not "unverified" — it was verified and it
// failed. No cost lever has survived scrutiny at this quality bar, other than
// nano-banana's batch API (~50% off), which needs a 24h turnaround and so can't
// serve a real-time flow.
export type RepaintModel = "nano-banana" | "nano-banana-2-lite";

// The single generic repaint prompt. Every clause here was added to fix a
// specific observed failure, so treat it as tuned configuration rather than
// prose — and note that prompt hardening has repeatedly FAILED to control the
// child's facial geometry (hair length, eyebrows, eye size all resisted it).
// Eye size in particular is fixed downstream by the eyes stage, not here.
// Changing this text busts the repaint cache, since it is part of the cache key.
export const REPAINT_PROMPT = `The first image is a children's book illustration of a child. The second image is a photograph of a real child. Redraw the illustrated child so they clearly and recognisably become the specific child in the photograph.

CHANGE these to match the photograph exactly:
- FACE: same face shape, features, skin tone and proportions as the photo, prioritising a true likeness over stylisation — this must be recognisable as the exact child in the photograph, not a similar-looking generic child (keep a warm children's-book expression). This applies EQUALLY no matter how much of the face a helmet, hat, or other headwear covers — wherever skin and facial features ARE visible, they must still track the actual photograph, not fall back toward the original illustrated character's face just because less of it shows. Do not let the child's identity drift toward a generic or "safe" children's-book face — every visible feature must keep matching the photograph all the way through to the final image, not soften or revert back toward the illustration's original design partway through. Draw exactly two eyes. Draw exactly one eyebrow above each eye: a single, solid, continuous arch — one eyebrow shape per eye, two eyebrows total on the whole face.
- EYE SIZE (most important, and the rule illustrations most often break for a CHILD specifically — read this twice): children's-book art has a strong, automatic habit of drawing young characters with big, appealing, oversized eyes. That habit must be actively and deliberately overridden here. Treat this child's eyes exactly as you would treat an adult character's eyes in the same illustration: copy the eye size and shape directly from the photograph, with zero "cuteness" enlargement and zero rounding-up for being a child. Each eye must be roughly ONE FIFTH of the face's width — the proportion in a real human face, the same proportion an adult face would use — and the coloured iris must be a small circle, not a large glossy disc. Large round eyes spanning a third or more of the face width are WRONG, even though that look is the normal default for this art style. If the original illustration draws this character with big round anime or chibi eyes, forcefully shrink them to realistic human proportions — this one feature overrides the illustration's usual house style, with no exception for the character's age.
- EYE COLOUR CONTAINMENT (a common and specific mistake — do not skip this): the iris and eye colour must stay perfectly contained inside the eye's own outline, as one small, crisp circle with a hard edge, never a soft gradient. There must be NO halo, glow, tint, smudge or wash of the iris colour appearing outside the eye shape — especially on the skin directly UNDER the eye, which is the single most common place this leaks. The eyelid, the skin under the eye and the skin around the eye must be the exact same clean, even skin tone as the rest of the face, with an immediate, sharp transition from eye to skin. If you can see the eye colour "fading out" or feathering into the surrounding skin at all, that is wrong — eye colour ends exactly at the eye's edge, with nothing beyond it. Do NOT let eye colour escape, leak, spread or bleed into the under-eye or surrounding skin — this is a mistake to actively avoid, not a style choice. Also, the area directly under and around each eye must ALWAYS be fully painted in the child's skin tone, with no exceptions: never leave it white, blank, unpainted, washed-out or a pale/light patch of any kind, and never leave any gap, highlight blob or empty space there. That area is skin and only skin — the exact same tone as the rest of the face, with no accidental white spaces under the eyes.
- OTHER FACIAL PROPORTIONS: the nose and mouth must be clearly drawn and properly defined, not shrunk to tiny marks, and the head, jaw and cheek shape must follow real human proportions rather than a rounded cartoon ball. Together with the eye rules above this overrides the art-style match below, for facial geometry only.
- SKIN TONE (do this even if it means a LARGE change from the original illustration): completely REPLACE the illustrated character's skin colour with the child's actual skin colour from the photograph, across ALL visible skin — face (including the skin around and between the eyes), ears, neck, hands, fingers and arms. Do not blend, average, tint or partially shift toward the photo's tone while keeping some of the original illustration's colour — the original character's skin colour must not remain visible anywhere, no matter how different it is from the photo. Every visible hand and finger, including ones gripping, holding or touching an object, must be repainted the SAME skin tone as the face. This is the single most common mistake to avoid: do NOT leave hands, fingers, arms, or the skin around the eyes paler, lighter or a different colour than the rest of the face.
- HAIR: give them the SAME hairstyle as in the photograph. Look carefully at the photo and copy the hair's real length, cut, shape, volume, hairline, TEXTURE and colour. Match the TEXTURE precisely — straight, wavy, curly, coily or braided, exactly as photographed: do not straighten curly or coily hair, and do not add curl or wave to straight hair. Match the LENGTH precisely: if the child in the photo has SHORT hair that does not cover the ears or reach the neck, draw short hair that does not cover the ears or reach the neck — do NOT lengthen it into a bob, chin-length or longer style. If the photo shows long hair, draw long hair. If the original illustration has a different hairstyle, or any headband, hair clip, ribbon or hair accessory that this child does NOT have in the photo, REMOVE it completely and redraw the hair from scratch to match the photo. Do not keep the illustration's original hair length, texture or shape.

KEEP everything else identical to the first illustration: the same scene, the same pose and body position, the same clothing (other than hair accessories), the same background, the same composition and camera angle, and the identical soft painterly children's book illustration art style — except for the facial proportions above, which must stay realistically human even where the original art is more stylised.`;

// google/nano-banana's `aspect_ratio` input defaults to "match_input_image", but
// `image_input` carries TWO images (the template crop AND the child's photo) and
// it resolves against the PHOTO. Measured: a 0.80 portrait crop with a 1.50 photo
// returned a 1.50 landscape frame; nano-banana re-composed the scene to fill it
// and the face shrank from 32.7% to 19.8% of frame width, at which point the swap
// model's detector failed 5/5. A square photo on the same page distorted less and
// swapped fine. Left alone, whether a page renders depends on the shape of the
// selfie a parent happens to upload. Pinning the ratio to the template crop makes
// output geometry independent of the photo. The input is an enum, so snap to the
// nearest supported value.
const NANO_BANANA_RATIOS: ReadonlyArray<readonly [string, number]> = [
  ["1:1", 1], ["2:3", 2 / 3], ["3:2", 3 / 2], ["3:4", 3 / 4], ["4:3", 4 / 3],
  ["4:5", 4 / 5], ["5:4", 5 / 4], ["9:16", 9 / 16], ["16:9", 16 / 9], ["21:9", 21 / 9],
];

export function nearestAspectRatio(width: number, height: number): string {
  const target = width / Math.max(1, height);
  return NANO_BANANA_RATIOS.reduce((best, cur) =>
    Math.abs(cur[1] - target) < Math.abs(best[1] - target) ? cur : best,
  )[0];
}

async function templateAspectRatio(templateBuf: Buffer): Promise<string> {
  const meta = await sharp(templateBuf).metadata();
  return nearestAspectRatio(meta.width ?? 1, meta.height ?? 1);
}

// Repaint is billed per image regardless of how many times the same
// template+photo pair is repainted, and dev/demo runs re-test the same pair
// repeatedly while tuning the later stages — so cache the output on disk, keyed
// by exactly what determines it: model, prompt, cropped template bytes, photo.
//
// In production this key never repeats (childPhotoUrl mints a fresh signed URL
// per call), so the cache simply never fires there; production's dedup is the
// worker's page-level objectExists() skip, which already avoids re-paying for an
// already-rendered page.
const REPAINT_CACHE_DIR = path.resolve(process.cwd(), ".cache/repaint");

function cacheKey(templateBuf: Buffer, photoUri: string, model: RepaintModel): string {
  return createHash("sha256").update(model).update(REPAINT_PROMPT).update(templateBuf).update(photoUri).digest("hex");
}

/** Redraw `templateBuf` as the child in `photoUri`. */
export async function repaintScene(
  templateBuf: Buffer,
  photoUri: string,
  model: RepaintModel = "nano-banana",
): Promise<Buffer> {
  const cacheFile = path.join(REPAINT_CACHE_DIR, `${cacheKey(templateBuf, photoUri, model)}.png`);
  try {
    const cached = await readFile(cacheFile);
    console.error(`[repaint] cache hit (${model}), skipping repaint call -> ${cacheFile}`);
    return cached;
  } catch {
    // Cache miss — fall through to the real call.
  }

  const url =
    model === "nano-banana-2-lite"
      ? await runReplicate("models/google/nano-banana-2-lite/predictions", {
          input: { prompt: REPAINT_PROMPT, images: [dataUri(templateBuf), photoUri], match_input_image: true, output_format: "png" },
        })
      : await runReplicate("models/google/nano-banana/predictions", {
          input: {
            prompt: REPAINT_PROMPT,
            image_input: [dataUri(templateBuf), photoUri],
            output_format: "png",
            aspect_ratio: await templateAspectRatio(templateBuf),
          },
        });
  const result = await fetchToBuffer(url);

  await mkdir(REPAINT_CACHE_DIR, { recursive: true });
  await writeFile(cacheFile, result);
  return result;
}
