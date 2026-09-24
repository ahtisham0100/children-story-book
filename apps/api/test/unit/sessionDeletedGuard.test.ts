import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";

// Once GDPR deletion has run for a session, the upload and render routes must
// refuse it: a fresh upload after the marker is set would never be swept again.
const h = vi.hoisted(() => {
  const markers = { rawDeletedAt: null as Date | null, processedDeletedAt: null as Date | null };
  const character = { id: "c1", sessionId: "s1", slot: "child_1", childName: "Ada", rawKey: null as string | null };
  const prisma = {
    character: {
      findFirst: vi.fn(async () => ({ ...character, session: { ...markers } })),
      update: vi.fn(),
      count: vi.fn(async () => 1),
      updateMany: vi.fn(),
    },
    session: {
      findUnique: vi.fn(async () => ({
        id: "s1",
        ...markers,
        characters: [{ ...character, rawKey: "sessions/s1/characters/c1/raw.jpg" }],
      })),
      update: vi.fn(),
    },
  };
  return {
    markers,
    prisma,
    createUploadUrl: vi.fn(async () => "https://signed.example/put"),
    objectExists: vi.fn(async () => true),
    queueAdd: vi.fn(async () => ({ id: "job-1" })),
  };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));
vi.mock("../../src/env", () => ({
  env: { REDIS_URL: "rediss://example", RL_SESSION_CREATE_IP_MAX: 100, RL_SESSION_CREATE_WINDOW_MIN: 60, CORS_ORIGIN: [] },
}));
vi.mock("../../src/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/storage")>()),
  createUploadUrl: h.createUploadUrl,
  objectExists: h.objectExists,
}));
vi.mock("../../src/queue", () => ({ getPipelineQueue: () => ({ add: h.queueAdd }) }));
vi.mock("../../src/status-events", () => ({ subscribeStatus: vi.fn() }));

import { registerSessionRoutes } from "../../src/routes/sessions";

const SID = "11111111-1111-4111-8111-111111111111";
const CID = "22222222-2222-4222-8222-222222222222";

async function call(url: string, payload: object) {
  const app = Fastify();
  await app.register(rateLimit, { global: false });
  await registerSessionRoutes(app);
  const res = await app.inject({ method: "POST", url, payload });
  await app.close();
  return res;
}

const uploadUrl = () =>
  call(`/api/sessions/${SID}/characters/${CID}/upload-url`, { contentType: "image/jpeg" });
const uploadConfirm = () =>
  call(`/api/sessions/${SID}/characters/${CID}/upload-confirm`, {
    objectKey: `sessions/${SID}/characters/${CID}/raw.jpg`,
  });
const renderFull = () => call(`/api/sessions/${SID}/render-full`, {});

beforeEach(() => {
  vi.clearAllMocks();
  h.markers.rawDeletedAt = null;
  h.markers.processedDeletedAt = null;
});

describe.each([
  ["raw deleted", "rawDeletedAt"],
  ["processed deleted", "processedDeletedAt"],
] as const)("a session with %s", (_label, marker) => {
  beforeEach(() => {
    h.markers[marker] = new Date("2026-09-01T00:00:00Z");
  });

  it("upload-url answers 410 and issues no URL", async () => {
    const res = await uploadUrl();
    expect(res.statusCode).toBe(410);
    expect(h.createUploadUrl).not.toHaveBeenCalled();
  });

  it("upload-confirm answers 410 and records nothing", async () => {
    const res = await uploadConfirm();
    expect(res.statusCode).toBe(410);
    expect(h.prisma.character.update).not.toHaveBeenCalled();
  });

  it("render-full answers 410 and enqueues nothing", async () => {
    const res = await renderFull();
    expect(res.statusCode).toBe(410);
    expect(h.queueAdd).not.toHaveBeenCalled();
  });
});

describe("a session with nothing deleted", () => {
  it("still gets an upload URL", async () => {
    const res = await uploadUrl();
    expect(res.statusCode).toBe(200);
  });

  it("still renders", async () => {
    const res = await renderFull();
    expect(res.statusCode).toBe(202);
  });
});
