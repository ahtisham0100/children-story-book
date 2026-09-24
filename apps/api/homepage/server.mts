// The product homepage — feed it photos in a browser, get finished pages back.
//
//   npm run homepage        (then open http://localhost:5174)
//
// This is a THIN CLIENT of the real production API (src/app.ts + src/worker.ts),
// not a separate pipeline. The browser talks to the production API directly
// (CORS-enabled — see env.CORS_ORIGIN) for everything that touches a render:
// creating a session, uploading photos straight to R2 via presigned URLs,
// confirming uploads (which enqueues the real BullMQ job), streaming status over
// SSE, and polling for finished pages. What a client sees here is the actual
// product working end to end — same Postgres session, same R2 storage, same
// queue, same worker — not a demo-only shortcut.
//
// This server's own job is small: serve the static UI, answer the free/local
// "which pages exist" catalog lookup (no pipeline, no API calls), do a free
// pre-flight photo validation (face detection only, before anything is
// uploaded), and tell the browser where the production API lives.
//
// Requires the production API (`npm run dev` or `npm start`, port 3001 by
// default) AND its worker to be running, with DATABASE_URL, REDIS_URL and the
// R2_* vars all configured — this will not render anything on its own.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { PAGES, getPage, characterCount } from "../src/pipeline/catalog";
import { validatePhotoBuffer, ValidationError } from "../src/pipeline/validate";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.HOMEPAGE_PORT ?? 5174);

// Where the real production API lives. Same machine, different port, by
// default — override for a deployed API. NOT derived from env.PORT: that var
// is ambient (also read by src/index.ts for the API's OWN port) and this
// process's launcher may set process.env.PORT to homepage's own port (5174),
// which dotenv cannot override — deriving from it here would silently point
// at the wrong server.
const DEFAULT_PRODUCTION_API_PORT = 3001;
const PRODUCTION_API_URL = process.env.PRODUCTION_API_URL ?? `http://localhost:${DEFAULT_PRODUCTION_API_PORT}`;

// The UI offers two modes, which is just a split of the catalog by how many
// characters a page draws: "single" needs one photo, "multi" needs two. This
// mirrors the two demo books in src/pipeline/catalog.ts (`demo-book`,
// `demo-book-duo`) exactly — same page ids, same order.
const soloPages = Object.values(PAGES).filter((p) => characterCount(p) === 1);
const duoPages = Object.values(PAGES).filter((p) => characterCount(p) > 1);

const DEFAULT_ESTIMATE_SECONDS = 120;
const estimate = (key: string): number => getPage(key).estimateSeconds ?? DEFAULT_ESTIMATE_SECONDS;

function decodePhoto(uri: string): { buf: Buffer; ext: "png" | "jpeg" } {
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(uri);
  if (!m) throw new Error("Photo must be a PNG or JPEG data URI.");
  const ext = m[1]!.toLowerCase().startsWith("jp") ? "jpeg" : "png";
  return { buf: Buffer.from(m[2]!, "base64"), ext };
}

const app = Fastify({ bodyLimit: 40 * 1024 * 1024, logger: false });

app.get("/", async (_req, reply) => {
  reply.type("text/html").send(await readFile(path.join(HERE, "index.html"), "utf8"));
});

// Static catalog metadata only — no pipeline call, no cost. Tells the browser
// which pages exist per mode and the storyId to create a session against.
app.get("/api/scenes", async () => ({
  apiBase: PRODUCTION_API_URL,
  single: { storyId: "demo-book", pages: soloPages.map((p) => ({ key: p.id, estimate: estimate(p.id) })) },
  multi: { storyId: "demo-book-duo", pages: duoPages.map((p) => ({ key: p.id, estimate: estimate(p.id) })) },
}));

// Free, local, no R2/Postgres/paid-API involvement: the same face-detection
// guard the production worker runs (min 200x200, exactly one clear face), so a
// bad upload fails fast here instead of costing an R2 upload + a BullMQ job
// that fails downstream in validatePhoto.
app.post("/api/validate", async (req, reply) => {
  const body = req.body as { photo?: string };
  if (!body.photo) return reply.code(400).send({ error: "No photo provided." });
  let decoded: { buf: Buffer; ext: "png" | "jpeg" };
  try {
    decoded = decodePhoto(body.photo);
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
  try {
    await validatePhotoBuffer(decoded.buf);
  } catch (e) {
    if (e instanceof ValidationError) return reply.code(400).send({ error: e.message });
    throw e;
  }
  return { ok: true };
});

const address = await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(`\n  Homepage running at ${address.replace("0.0.0.0", "localhost")}`);
console.log(`  Talking to production API at ${PRODUCTION_API_URL} — make sure it (and its worker) are running.\n`);
