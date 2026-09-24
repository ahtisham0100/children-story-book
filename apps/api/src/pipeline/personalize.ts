import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { detectPageCharacters } from "./faceDetect";
import { characterCrop, cropOverlay } from "./compose";
import { mapWithConcurrency } from "./pool";
import { characterCount, type Page } from "./catalog";
import { repaintScene, type RepaintModel } from "./stages/repaint";
import { swapIdentity } from "./stages/swap";
import { restoreFace } from "./stages/restore";
import { healSwapArtifacts } from "./stages/heal";
import { restoreEyeRegion } from "./stages/eyes";
import type { CharacterInput, FaceBox } from "./types";

// THE ENGINE — the one entry point everything else calls.
//
// Production (worker.ts) and the demo harness (demo/) both come through here, so
// what a client sees in the demo is exactly what production renders.
//
// The recipe, in order:
//   1. repaint  — redraw the illustration as this child          (the real work)
//   2. swap     — pin the likeness to exactly this child
//   3. restore  — blend the swap back into the painterly art
//   4. heal     — remove small bright swap specks
//   5. eyes     — paint the repaint's eyes back over the swap's
//
// Stages 3-5 only run if the swap ran; each is individually skippable. See the
// individual stage files for why each one exists and what was tried instead.

export class PersonalizeError extends Error {}

export type Stage = "repaint" | "swap" | "restore" | "heal" | "eyes";

// Indirection point for WHERE each stage actually runs. Default (below) calls
// the stage functions directly, in-process — exactly what always happened
// here, and what the CLI and homepage_local keep doing (they have no queue
// infra to run against). Production (worker.ts) can instead pass
// queueStageRunner (pipeline/queueStageRunner.ts), which runs each stage as
// its own BullMQ job on its own queue, consumed by a dedicated stage-worker.ts
// process per stage — see docs/INFRA_AND_PIPELINE_TRACE.md. Either way,
// personalizeBuffer only ever sees "give me a Buffer back for this stage."
export interface StageRunner {
  repaint(templateBuf: Buffer, photoUri: string, model: RepaintModel): Promise<Buffer>;
  swap(targetBuf: Buffer, photoUri: string): Promise<Buffer>;
  restore(imageBuf: Buffer): Promise<Buffer>;
  heal(imageBuf: Buffer): Promise<Buffer>;
  eyes(swappedBuf: Buffer, repaintBuf: Buffer): Promise<Buffer>;
}

const directStageRunner: StageRunner = {
  repaint: repaintScene,
  swap: swapIdentity,
  restore: restoreFace,
  heal: healSwapArtifacts,
  eyes: restoreEyeRegion,
};

export interface PersonalizeOptions {
  swap?: boolean; // default true
  restore?: boolean; // default true (only runs when swap ran)
  heal?: boolean; // default true (only runs when swap ran)
  eyeFix?: boolean; // default true (only runs when swap ran)
  repaintModel?: RepaintModel; // default "nano-banana"
  /** default: run every stage in-process — see StageRunner above. */
  stageRunner?: StageRunner;
  /**
   * Called after each stage with a copy of the intermediate. Lets a CLI save
   * debug frames, and the demo UI report live progress, without the engine
   * knowing about either.
   */
  onStage?: (stage: Stage, image: Buffer) => void | Promise<void>;
}

/**
 * The recipe, on any in-memory image — a whole page, or one character's crop of
 * one.
 *
 * @param templateBuf the art to personalize
 * @param photoUri    URL or data URI of the child's photo (the face source)
 */
export async function personalizeBuffer(
  templateBuf: Buffer,
  photoUri: string,
  opts: PersonalizeOptions = {},
): Promise<Buffer> {
  const {
    swap = true,
    restore = true,
    heal = true,
    eyeFix = true,
    repaintModel = "nano-banana",
    stageRunner = directStageRunner,
    onStage,
  } = opts;

  let result = await stageRunner.repaint(templateBuf, photoUri, repaintModel);
  await onStage?.("repaint", result);

  if (swap) {
    // Held for the eyes stage — it needs the pre-swap eyes to paint back.
    const repainted = result;
    result = await stageRunner.swap(result, photoUri);
    await onStage?.("swap", result);

    if (restore) {
      result = await stageRunner.restore(result);
      await onStage?.("restore", result);
    }
    if (heal) {
      result = await stageRunner.heal(result);
      await onStage?.("heal", result);
    }
    // Last, so neither restore nor heal can reintroduce the iris ring.
    if (eyeFix) {
      result = await stageRunner.eyes(result, repainted);
      await onStage?.("eyes", result);
    }
  }

  return result;
}

// A page may have more crops in flight than the caller already has pages
// running, so cap per-page character concurrency too — otherwise a
// many-character page could spike total in-flight Replicate calls.
const CHARACTER_CONCURRENCY = 3;

/**
 * Loads a page's artwork and strips any baked-in app chrome. Exported so the
 * demo CLI's free preflight inspects the exact same bytes the engine works on —
 * running detection against the uncropped original would report crops the
 * pipeline would never actually use.
 */
export async function loadPageArt(page: Page): Promise<Buffer> {
  const original = await readFile(page.imagePath);
  if (!page.crop) return original;
  return sharp(original).extract(page.crop as FaceBox).png().toBuffer();
}

/**
 * Personalizes one book page, end to end. This is the function to call.
 *
 * SOLO PAGES (the common case) repaint the whole page directly — no detection,
 * no cropping, no compositing. It is the simplest path and the most proven.
 *
 * MULTI-CHARACTER PAGES give each drawn character their own generous crop,
 * personalized individually against their own photo — so every child gets the
 * fully-proven solo recipe — then feather the finished crops back onto the
 * original page. Faces map to character slots left-to-right unless the page
 * overrides that with `slots`. See compose.ts for the crop geometry and the
 * compositing, both of which took real measurement to get right.
 *
 * A drawn character with no child mapped to them is left exactly as the
 * illustrator drew them.
 */
export async function personalizePage(
  page: Page,
  characters: CharacterInput[],
  opts: PersonalizeOptions = {},
): Promise<Buffer> {
  const art = await loadPageArt(page);
  const drawnCount = characterCount(page);

  if (drawnCount === 1) {
    const slot = page.slots?.[0];
    const character = slot ? characters.find((c) => c.slot === slot) : characters[0];
    if (!character) {
      throw new PersonalizeError(`Page "${page.id}" has no uploaded child to personalize.`);
    }
    return personalizeBuffer(art, character.photoUrl, opts);
  }

  const drawnFaces = await detectPageCharacters(art, drawnCount);
  if (drawnFaces.length === 0) {
    throw new PersonalizeError(`No character face detected on page "${page.id}".`);
  }

  const slotOrder = page.slots ?? characters.map((c) => c.slot);
  const assignments: { face: FaceBox; character: CharacterInput }[] = [];
  for (let i = 0; i < drawnFaces.length; i += 1) {
    const slot = slotOrder[i];
    const character = slot ? characters.find((c) => c.slot === slot) : undefined;
    const face = drawnFaces[i];
    if (character && face) assignments.push({ face, character });
  }
  if (assignments.length === 0) {
    throw new PersonalizeError(`No character on page "${page.id}" maps to an uploaded child.`);
  }

  const meta = await sharp(art).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  const allFaces = assignments.map((a) => a.face);
  const overlays = await mapWithConcurrency(assignments, CHARACTER_CONCURRENCY, async ({ face, character }) => {
    const crop = characterCrop(face, allFaces, width, height);
    const cropBuffer = await sharp(art).extract(crop).png().toBuffer();
    const finished = await personalizeBuffer(cropBuffer, character.photoUrl, opts);
    return cropOverlay(finished, crop);
  });

  return sharp(art).ensureAlpha().composite(overlays).png().toBuffer();
}
