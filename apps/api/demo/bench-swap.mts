// Measure the swap stage, so the speed claim is a number and not an argument.
//
//   npm run bench:swap -- <target.png> <photo.jpg> [--runs 5]
//
// Defaults to a committed keep-demo page as the target and whatever photo you
// pass, because the target only needs to be artwork with a face in it.
//
// Exercises the REAL swapIdentity path, not a hand-rolled HTTP call, so what it
// measures is what the pipeline actually does — including the retry loop.
//
// COST WARNING. With SWAP_BACKEND=local this is FREE and you can run it as many
// times as you like. With SWAP_BACKEND=replicate every run is a PAID prediction
// (~$0.006 and ~55-90s each), so it refuses to run more than once against the
// hosted backend unless you pass --allow-paid.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { swapIdentity } from "../src/pipeline/stages/swap";
import { dataUri } from "../src/pipeline/dataUri";
import { env } from "../src/env";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1] === "--runs"));

const DEFAULT_TARGET = path.resolve(process.cwd(), "demo/keep-demo/astronaut.png");

// One positional means "just the photo" and the target falls back to the
// committed keep-demo page; two means an explicit target and photo.
const targetPath = positional.length >= 2 ? positional[0]! : DEFAULT_TARGET;
const photoPath = positional.length >= 2 ? positional[1] : positional[0];
const runs = Number(flag("--runs") ?? "5");
const allowPaid = argv.includes("--allow-paid");

if (!photoPath) {
  console.error("usage: npm run bench:swap -- [target.png] <photo.jpg> [--runs 5] [--allow-paid]");
  console.error("  target defaults to demo/keep-demo/astronaut.png");
  process.exit(1);
}

const backend = env.SWAP_BACKEND;

// `auto` can ALSO spend money — it falls back to hosted the instant the local
// service is unreachable or errors, silently, which is exactly the case this
// guard exists to catch. Only `local` (strict) is unconditionally free.
if (backend !== "local" && runs > 1 && !allowPaid) {
  const why = backend === "auto" ? "falls back to hosted on any local failure, which" : "";
  console.error(
    `\nSWAP_BACKEND=${backend} — ${why ? why + " " : ""}each run may be a PAID prediction (~$0.006, ~55-90s).\n` +
      `Refusing ${runs} paid runs. Either:\n` +
      `  - set SWAP_BACKEND=local in apps/api/.env (free, and the point of this exercise), or\n` +
      `  - pass --allow-paid if you really want ${runs} hosted runs.\n`,
  );
  process.exit(1);
}

const target = await readFile(targetPath);
const photo = dataUri(await readFile(photoPath));

console.log(`\nbackend : ${backend}${backend === "local" ? ` (${env.SWAP_LOCAL_URL})` : ""}`);
console.log(`target  : ${targetPath}`);
console.log(`photo   : ${photoPath}`);
console.log(`runs    : ${runs}\n`);

const timings: number[] = [];
let failures = 0;

for (let i = 1; i <= runs; i += 1) {
  const started = performance.now();
  try {
    await swapIdentity(target, photo);
    const ms = performance.now() - started;
    timings.push(ms);
    console.log(`  run ${i}: ${(ms / 1000).toFixed(2)}s`);
  } catch (err) {
    failures += 1;
    console.log(`  run ${i}: FAILED — ${(err as Error).message}`);
  }
}

if (timings.length === 0) {
  console.error("\nEvery run failed — nothing to report.\n");
  process.exit(1);
}

const sorted = [...timings].sort((a, b) => a - b);
const mean = timings.reduce((a, b) => a + b, 0) / timings.length;
const median = sorted[Math.floor(sorted.length / 2)]!;

console.log(`\n  n       : ${timings.length}/${runs}${failures ? ` (${failures} failed)` : ""}`);
console.log(`  median  : ${(median / 1000).toFixed(2)}s`);
console.log(`  mean    : ${(mean / 1000).toFixed(2)}s`);
console.log(`  min/max : ${(sorted[0]! / 1000).toFixed(2)}s / ${(sorted.at(-1)! / 1000).toFixed(2)}s`);

// The recorded hosted baseline, from the Replicate account's own prediction
// history. Stated rather than re-measured so this stays free to run.
const HOSTED_BASELINE_S = 70;
if (backend === "local") {
  const speedup = HOSTED_BASELINE_S / (median / 1000);
  console.log(`\n  hosted baseline ~${HOSTED_BASELINE_S}s (measured, 55-90s range)`);
  console.log(`  speedup        : ~${speedup.toFixed(0)}x`);
  console.log(`\n  A 5-page book: ~${((median / 1000) * 5).toFixed(0)}s of swap vs ~${HOSTED_BASELINE_S * 5}s hosted.\n`);
}

// Reliability matters as much as speed here, and the N>=5 rule exists because
// single runs have hidden real bugs on this pipeline before.
if (failures > 0) {
  console.log(`  NOTE: ${failures}/${runs} failed. Detection reliability is a separate axis`);
  console.log(`        from latency — try FACESWAP_DET_SIZE=1024 on the service.\n`);
}
