// The demo CLI — feed photos, get finished pages out.
//
//   npm run personalize -- <photo> [photo2 ...] [options]
//
// Options:
//   --page <id|all>   which page(s) to render. Default: all. See PAGES in
//                     src/pipeline/catalog.ts for the ids.
//   --out <dir>       where to write results. Default: demo/output
//   --detect-only     FREE. Runs only local face detection and writes the crops
//                     that WOULD be sent for repainting, plus an overlay of the
//                     crop rectangles. No API calls, no credits. Always run this
//                     before paid work when crop geometry has changed.
//   --debug           also write every intermediate stage frame
//   --lite            use nano-banana-2-lite for the repaint (cost/latency
//                     comparison — unverified on our painterly art, so opt-in).
//                     Writes to <page>.lite.png so it can't overwrite a proven
//                     result.
//   --no-swap         stop after the repaint. The repaint already SEES the photo
//                     so it carries likeness on its own; this trades identity
//                     sharpness for guaranteed freedom from swap artifacts.
//                     Writes to <page>.noswap.png.
//   --no-eyes         skip the eyes stage (paints the repaint's eyes back over
//                     the swap's). Writes to <page>.noeyes.png.
//
// Photos map to the drawn characters in LEFT-TO-RIGHT order UNLESS the page sets
// `slots` in catalog.ts, in which case that order wins instead — some pages draw
// the adult on the left, so passing photos "left to right" would put the child's
// photo on the drawn adult. The fixed, page-independent convention is: child
// first, then adult. `--detect-only`'s output shows the real face<-photo mapping
// (including any slots remap), so check that before paid work either way.
//
// Examples:
//   npm run personalize -- kid.jpg                          every page
//   npm run personalize -- kid.jpg --page astronaut         one solo page
//   npm run personalize -- kid.jpg dad.png --page newtemp   one two-character page
//   npm run personalize -- kid.jpg dad.png --detect-only    free preflight
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { PAGES, getPage, characterCount, type Page } from "../src/pipeline/catalog";
import { detectPageCharacters } from "../src/pipeline/faceDetect";
import { characterCrop } from "../src/pipeline/compose";
import { personalizePage, loadPageArt } from "../src/pipeline/personalize";
import { dataUri } from "../src/pipeline/dataUri";
import type { RepaintModel } from "../src/pipeline/stages/repaint";
import type { CharacterInput } from "../src/pipeline/types";

const VALUE_FLAGS = ["--page", "--out"];

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
};
// Positionals are everything that isn't a flag or a flag's value.
const photoPaths = argv.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(argv[i - 1] ?? ""));

const pageArg = flag("--page") ?? "all";
const outDir = flag("--out") ?? "demo/output";
const debug = argv.includes("--debug");
const lite = argv.includes("--lite");
const noSwap = argv.includes("--no-swap");
const noEyes = argv.includes("--no-eyes");
const detectOnly = argv.includes("--detect-only");
const repaintModel: RepaintModel = lite ? "nano-banana-2-lite" : "nano-banana";

if (photoPaths.length === 0) {
  console.error("usage: npm run personalize -- <photo> [photo2 ...] [--page <id|all>] [--out <dir>] [--detect-only] [--debug] [--lite] [--no-swap] [--no-eyes]");
  console.error(`pages: ${Object.keys(PAGES).join(", ")}, all`);
  process.exit(1);
}

const pages: Page[] = pageArg === "all" ? Object.values(PAGES) : [getPage(pageArg)];
await mkdir(outDir, { recursive: true });

// Photos become data URIs — the same shape production passes as a signed URL.
const characters: CharacterInput[] = await Promise.all(
  photoPaths.map(async (p, i) => ({
    slot: `child_${i + 1}`,
    photoUrl: dataUri(await readFile(p), p.toLowerCase().endsWith(".png") ? "png" : "jpeg"),
  })),
);

const suffix = `${lite ? ".lite" : ""}${noSwap ? ".noswap" : ""}${noEyes ? ".noeyes" : ""}`;

/** Free preflight: what the crops would be, without spending anything. */
async function detect(page: Page): Promise<void> {
  const art = await loadPageArt(page);
  const meta = await sharp(art).metadata();

  // Solo pages never go through detection or cropping — the whole page is
  // repainted in one call — so there is nothing here to preflight.
  if (characterCount(page) === 1) {
    console.log(`  ${meta.width}x${meta.height}, solo page — repainted whole, no detection or cropping.`);
    return;
  }

  const faces = await detectPageCharacters(art, characterCount(page));

  // Mirror personalizePage's own assignment logic (personalize.ts) exactly, so
  // this preview can't lie about which photo lands on which face — it did,
  // silently, before `slots` support was added here: it zipped faces[i] straight
  // to photoPaths[i], ignoring any page.slots remap.
  const characterSlots = photoPaths.map((_, i) => `child_${i + 1}`);
  const slotOrder = page.slots ?? characterSlots;

  console.log(`  ${meta.width}x${meta.height}, ${faces.length} drawn character(s) detected left-to-right:`);
  faces.forEach((f, i) => {
    const slot = slotOrder[i];
    const photoIndex = slot ? characterSlots.indexOf(slot) : -1;
    const photoPath = photoIndex !== -1 ? photoPaths[photoIndex] : undefined;
    const slotNote = page.slots ? ` [slot ${slot ?? "none"}]` : "";
    console.log(`    ${i + 1}. box=[${f.left},${f.top} ${f.width}x${f.height}]  <- ${photoPath ?? "(no photo — left as drawn)"}${slotNote}`);
  });
  if (faces.length !== photoPaths.length) {
    console.warn(`  WARNING: ${faces.length} face(s) detected but ${photoPaths.length} photo(s) given — extras are ignored.`);
  }

  const boxes: sharp.OverlayOptions[] = [];
  for (const [i, face] of faces.entries()) {
    const crop = characterCrop(face, faces, meta.width ?? 0, meta.height ?? 0);
    const cropPath = path.join(outDir, `${page.id}.crop.${i + 1}.png`);
    await writeFile(cropPath, await sharp(art).extract(crop).png().toBuffer());
    console.log(`    -> ${cropPath}  (crop [${crop.left},${crop.top} ${crop.width}x${crop.height}])`);
    boxes.push({
      input: Buffer.from(
        `<svg width="${crop.width}" height="${crop.height}"><rect x="1" y="1" width="${crop.width - 2}" height="${crop.height - 2}" fill="none" stroke="#ff0000" stroke-width="4"/></svg>`,
      ),
      left: crop.left,
      top: crop.top,
    });
  }
  const boxesPath = path.join(outDir, `${page.id}.boxes.png`);
  await writeFile(boxesPath, await sharp(art).composite(boxes).png().toBuffer());
  console.log(`    -> ${boxesPath}  (crop rectangles overlaid)`);
}

async function render(page: Page): Promise<void> {
  const t0 = Date.now();
  // personalizePage's onStage doesn't say which character a frame belongs to, so
  // for multi-character pages these numbers are COMPLETION order, not
  // left-to-right.
  const stageCounts = new Map<string, number>();
  const out = await personalizePage(page, characters, {
    repaintModel,
    swap: !noSwap,
    eyeFix: !noEyes,
    onStage: async (stage, buf) => {
      const n = (stageCounts.get(stage) ?? 0) + 1;
      stageCounts.set(stage, n);
      if (debug) await writeFile(path.join(outDir, `${page.id}${suffix}.${stage}.${n}.png`), buf);
      console.log(`  ${stage} ok${characterCount(page) > 1 ? ` (character ${n})` : ""}`);
    },
  });
  const outPath = path.join(outDir, `${page.id}${suffix}.png`);
  await writeFile(outPath, out);
  console.log(`  -> ${outPath}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}

for (const page of pages) {
  console.log(`\n=== ${page.id}${lite ? " (nano-banana-2-lite)" : ""} ===`);
  if (detectOnly) await detect(page);
  else await render(page);
}

console.log(detectOnly ? "\ndetect-only: no API calls made, no credits spent" : "\ndone");
