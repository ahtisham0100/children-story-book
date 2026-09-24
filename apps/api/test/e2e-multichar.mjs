// Multi-character end-to-end check: creates a session with N children, uploads a
// different photo for each, watches the SSE stream, then lists the rendered
// pages.
//
// Each child is personalized onto their own drawn character on every page. The
// mapping is left-to-right by default: the leftmost drawn character on a page
// becomes the first slot. A page can override that with `slots` in
// src/pipeline/catalog.ts.
//
// Usage:
//   node test/e2e-multichar.mjs <storyId> <photo1> <slot1> <name1> [<photo2> <slot2> <name2> ...]
// e.g.
//   node test/e2e-multichar.mjs demo-book-duo ./a.jpg child_1 Ada ./b.jpg child_2 Bo
//
// Requires the API server running (npm run dev) with REDIS_URL, R2 and
// REPLICATE_API_TOKEN configured. Note this renders the PREVIEW pages only;
// call POST /api/sessions/:id/render-full for the rest of the book.

import { readFile } from "node:fs/promises";
import { Agent, fetch as undiciFetch } from "undici";

const baseUrl = process.env.API_BASE_URL ?? "http://localhost:3001";
const longPollAgent = new Agent({ headersTimeout: 15 * 60 * 1000, bodyTimeout: 15 * 60 * 1000 });

const [storyId, ...rest] = process.argv.slice(2);
if (!storyId || rest.length < 3 || rest.length % 3 !== 0) {
  console.error("Usage: node test/e2e-multichar.mjs <storyId> <photo> <slot> <name> [<photo> <slot> <name> ...]");
  process.exit(1);
}

const children = [];
for (let i = 0; i < rest.length; i += 3) {
  children.push({ photoPath: rest[i], slot: rest[i + 1], childName: rest[i + 2] });
}

async function listenToStatus(sessionId) {
  const response = await undiciFetch(`${baseUrl}/api/sessions/${sessionId}/status`, {
    headers: { Accept: "text/event-stream" },
    dispatcher: longPollAgent,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to open status stream: ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let frameEnd = buffer.indexOf("\n\n");
    while (frameEnd !== -1) {
      const frame = buffer.slice(0, frameEnd);
      buffer = buffer.slice(frameEnd + 2);
      const eventLine = frame.split("\n").find((l) => l.startsWith("event:"));
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      const event = eventLine?.slice("event:".length).trim();
      const data = dataLine ? JSON.parse(dataLine.slice("data:".length).trim()) : undefined;
      console.log(`[${event}]`, data);
      if (event === "done" || event === "error") return data;
      frameEnd = buffer.indexOf("\n\n");
    }
  }
}

async function uploadPhoto(sessionId, characterId, photoPath) {
  const uploadUrlResponse = await fetch(
    `${baseUrl}/api/sessions/${sessionId}/characters/${characterId}/upload-url`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentType: "image/jpeg" }),
    },
  );
  const { uploadUrl, objectKey } = await uploadUrlResponse.json();

  const putResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "image/jpeg" },
    body: await readFile(photoPath),
  });
  if (!putResponse.ok) throw new Error(`Upload to R2 failed: ${putResponse.status}`);
  console.log(`Uploaded ${photoPath} -> ${objectKey}`);

  return fetch(`${baseUrl}/api/sessions/${sessionId}/characters/${characterId}/upload-confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ objectKey }),
  }).then((r) => r.json());
}

async function main() {
  const createResponse = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storyId,
      characters: children.map((c) => ({ slot: c.slot, childName: c.childName })),
    }),
  });
  const { sessionId, characters } = await createResponse.json();
  console.log(`Session created: ${sessionId}`);
  console.log("Characters:", characters);

  // Listen before the last confirm, so the first status event isn't missed
  // (the pipeline is enqueued as soon as every photo is in).
  const statusPromise = listenToStatus(sessionId);

  for (const child of children) {
    const match = characters.find((c) => c.slot === child.slot);
    if (!match) throw new Error(`Session has no character for slot "${child.slot}"`);
    const confirm = await uploadPhoto(sessionId, match.characterId, child.photoPath);
    console.log(`Confirm ${child.slot}:`, confirm);
  }

  const finalEvent = await statusPromise;
  console.log("Final event:", finalEvent);

  const pages = await fetch(`${baseUrl}/api/sessions/${sessionId}/pages`).then((r) => r.json());
  console.log("\nPages:");
  for (const page of pages.pages ?? []) {
    console.log(`  ${page.ready ? "✓" : "·"} ${page.id}${page.preview ? " (preview)" : ""}  ${page.url ?? "not rendered"}`);
  }
  console.log(`\nTo render the rest of the book: POST ${baseUrl}/api/sessions/${sessionId}/render-full`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
