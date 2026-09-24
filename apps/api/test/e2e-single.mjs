// End-to-end check for the one-child book "demo-book". Creates a session,
// uploads one real photo, and watches the SSE stream through validate ->
// render (the pages of the book are rendered in parallel).
//
// Usage: node test/e2e-single.mjs <photo.jpg> [childName]
// Requires the API server running (npm run dev) with REDIS_URL, R2 and
// REPLICATE_API_TOKEN configured. Budget a few minutes: the repaint stage is the
// slow one at ~90-170s per page, and a cold Replicate boot adds to the first.

import { readFile } from "node:fs/promises";
import { Agent, fetch as undiciFetch } from "undici";

const baseUrl = process.env.API_BASE_URL ?? "http://localhost:3001";
const longPollAgent = new Agent({ headersTimeout: 15 * 60 * 1000, bodyTimeout: 15 * 60 * 1000 });

const [photoPath, childName = "Test Child"] = process.argv.slice(2);
if (!photoPath) {
  console.error("Usage: node test/e2e-single.mjs <photo.jpg> [childName]");
  process.exit(1);
}

const STORY_ID = "demo-book";
const SLOT = "child_1";

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
      const eventLine = frame.split("\n").find((line) => line.startsWith("event:"));
      const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
      const event = eventLine?.slice("event:".length).trim();
      const data = dataLine ? JSON.parse(dataLine.slice("data:".length).trim()) : undefined;
      console.log(`[${event}]`, data);
      if (event === "done" || event === "error") {
        return data;
      }
      frameEnd = buffer.indexOf("\n\n");
    }
  }
}

async function main() {
  const createResponse = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storyId: STORY_ID,
      characters: [{ slot: SLOT, childName }],
    }),
  });
  const { sessionId, characters } = await createResponse.json();
  console.log(`Session created: ${sessionId}`);
  const character = characters.find((c) => c.slot === SLOT);

  const uploadUrlResponse = await fetch(
    `${baseUrl}/api/sessions/${sessionId}/characters/${character.characterId}/upload-url`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentType: "image/jpeg" }),
    },
  );
  const { uploadUrl, objectKey } = await uploadUrlResponse.json();

  const fileBuffer = await readFile(photoPath);
  const putResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "image/jpeg" },
    body: fileBuffer,
  });
  if (!putResponse.ok) {
    throw new Error(`Upload to R2 failed: ${putResponse.status}`);
  }
  console.log(`Uploaded ${photoPath} -> ${objectKey}`);

  // Start listening before confirming, so we don't miss the first status event.
  const statusPromise = listenToStatus(sessionId);

  const confirm = await fetch(
    `${baseUrl}/api/sessions/${sessionId}/characters/${character.characterId}/upload-confirm`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ objectKey }),
    },
  ).then((r) => r.json());
  console.log("Upload confirmed:", confirm);

  const finalEvent = await statusPromise;
  console.log("Final event:", finalEvent);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
