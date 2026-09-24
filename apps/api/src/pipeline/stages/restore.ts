import { runReplicate, fetchToBuffer } from "../replicate";
import { dataUri } from "../dataUri";

// STAGE 3 of 5 — face restoration, to blend the swap's "double-eye" ghosting.

const CODEFORMER_VERSION = "cc4956dd26fa5a7185d5660cc9100fab1b8070a1d1654a8bb5eb6d443b020bb2";

// High fidelity keeps the result close to the painterly face rather than
// drifting photographic. Do not lower it hoping to fix swap artifacts: swept
// 0.8/0.5/0.3/0.1 against the dark iris-ring artifact and it got WORSE as
// fidelity dropped, losing the pupil entirely at 0.1. That artifact is the eyes
// stage's job.
const FIDELITY = 0.8;

/** Blend the swapped face back into the illustration. Face region only. */
export async function restoreFace(imageBuf: Buffer): Promise<Buffer> {
  const url = await runReplicate("predictions", {
    version: CODEFORMER_VERSION,
    input: { image: dataUri(imageBuf), codeformer_fidelity: FIDELITY, background_enhance: false, face_upsample: false, upscale: 1 },
  });
  return fetchToBuffer(url);
}
