import { beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN, ADMIN_COOKIE, ADMIN_HEADERS, buildAdminTestApp } from "./support/adminHarness";

const h = await vi.hoisted(async () => (await import("./support/adminHarness")).createAdminHarness());

vi.mock("../../src/db", () => ({ prisma: h.prisma }));
vi.mock("../../src/env", () => ({ env: h.env }));
vi.mock("../../src/auth/service", () => ({
  normalizeEmail: (e: string) => e.trim().toLowerCase(),
  getCustomerBySessionToken: h.getCustomerBySessionToken,
}));
vi.mock("../../src/queue", () => ({
  getPipelineQueue: () => h.queue("pipeline"),
  getFulfillmentQueue: () => h.queue("fulfillment"),
  getGdprQueue: () => h.queue("gdpr"),
  enqueueFulfillment: h.enqueueFulfillment,
  GDPR_SWEEP_JOB_OPTIONS: { attempts: 1 },
}));
vi.mock("../../src/pipeline/queueStageRunner", () => ({ getStageQueue: (s: string) => h.queue(`stage-${s}`) }));
vi.mock("../../src/storage", () => ({ listObjects: h.listObjects }));
vi.mock("../../src/redis", () => ({ getCacheRedis: () => h.redis }));
vi.mock("../../src/print/gelato", () => ({ getGelatoOrder: h.getGelatoOrder }));
vi.mock("../../src/gdpr/deleteSessionAssets", () => ({
  deleteSessionAssets: h.deleteSessionAssets,
  SAFE_ID: /^[A-Za-z0-9-]+$/,
  GdprDeletionError: class extends Error {},
}));
vi.mock("../../src/gdpr/candidates", () => ({
  findCandidates: h.findCandidates,
  loadScheduleInput: h.loadScheduleInput,
}));

import { registerAdminRoutes } from "../../src/admin/plugin";

const ORDER_ID = "22222222-2222-4222-8222-222222222222";
const UNKNOWN_OUTCOME =
  `Order ${ORDER_ID}: a Gelato submission started at 2026-09-20T10:00:00.000Z has an unknown outcome. ` +
  `Check Gelato's dashboard for orderReferenceId ${ORDER_ID} before retrying.`;

let app: Awaited<ReturnType<typeof buildAdminTestApp>>;
const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie: ADMIN_COOKIE } });
const post = (url: string, payload: object = {}) => app.inject({ method: "POST", url, headers: ADMIN_HEADERS, payload });

function seedOrder(fields: Record<string, unknown> = {}) {
  h.db.orders.push({
    id: ORDER_ID,
    email: "buyer@example.com",
    status: "failed",
    gelatoOrderId: null,
    gelatoSubmitStartedAt: null,
    deliveredAt: null,
    createdAt: new Date("2026-09-20T09:00:00Z"),
    ...fields,
  });
}

beforeEach(async () => {
  h.reset();
  app = await buildAdminTestApp(registerAdminRoutes);
});

describe("GET /api/admin/queues", () => {
  it("lists the core queues with their five counts", async () => {
    h.addJob("fulfillment", { id: "f1", state: "failed" });
    h.addJob("fulfillment", { id: "f2", state: "completed" });
    h.addJob("pipeline", { id: "p1", state: "active" });
    const res = await get("/api/admin/queues");
    expect(res.statusCode).toBe(200);
    const { queues } = res.json();
    expect(queues.map((q: { name: string }) => q.name)).toEqual(["pipeline", "fulfillment", "gdpr"]);
    expect(queues[1].counts).toEqual({ active: 0, waiting: 0, delayed: 0, completed: 1, failed: 1 });
    expect(queues[0].counts.active).toBe(1);
  });

  it("includes the five stage queues only when STAGE_EXECUTION=queued", async () => {
    h.env.STAGE_EXECUTION = "queued";
    const res = await get("/api/admin/queues");
    expect(res.json().queues.map((q: { name: string }) => q.name)).toEqual([
      "pipeline",
      "fulfillment",
      "gdpr",
      "stage-repaint",
      "stage-swap",
      "stage-restore",
      "stage-heal",
      "stage-eyes",
    ]);
  });

  it("503 when Redis isn't configured", async () => {
    h.env.REDIS_URL = undefined;
    expect((await get("/api/admin/queues")).statusCode).toBe(503);
  });
});

describe("queue name whitelist", () => {
  it("404s an unknown queue name without constructing a queue for it", async () => {
    for (const name of ["nope", "stage-repaint", "__proto__", "fulfillment%00"]) {
      const res = await get(`/api/admin/queues/${name}/jobs?state=failed`);
      expect(res.statusCode, name).toBe(404);
    }
    // Only whitelisted names ever reached the queue factory.
    expect(h.queue("nope").getJobs).not.toHaveBeenCalled();
  });

  it("serves stage queues once STAGE_EXECUTION=queued", async () => {
    h.env.STAGE_EXECUTION = "queued";
    expect((await get("/api/admin/queues/stage-swap/jobs?state=failed")).statusCode).toBe(200);
  });
});

describe("GET /api/admin/queues/:name/jobs", () => {
  it("requires a known state", async () => {
    expect((await get("/api/admin/queues/fulfillment/jobs")).statusCode).toBe(400);
    expect((await get("/api/admin/queues/fulfillment/jobs?state=everything")).statusCode).toBe(400);
  });

  it("pages the jobs in one state, with a redacted data summary", async () => {
    for (let i = 0; i < 5; i++) {
      h.addJob("pipeline", {
        id: `j${i}`,
        state: "failed",
        name: "process",
        data: { sessionId: `s${i}`, photoUrl: "https://a.r2.cloudflarestorage.com/b/k?X-Amz-Signature=x" },
        attemptsMade: 1,
        opts: { attempts: 1 },
      });
    }
    h.addJob("pipeline", { id: "done", state: "completed" });
    const res = await get("/api/admin/queues/pipeline/jobs?state=failed&page=2&limit=2");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ page: 2, limit: 2, total: 5 });
    expect(body.items.map((j: { id: string }) => j.id)).toEqual(["j2", "j3"]);
    expect(body.items[0]).toMatchObject({ name: "process", state: "failed", attemptsMade: 1, maxAttempts: 1 });
    expect(body.items[0].dataSummary).toContain("[redacted-url]");
    expect(JSON.stringify(body)).not.toContain("X-Amz-Signature");
  });

  it("caps limit at 100", async () => {
    expect((await get("/api/admin/queues/pipeline/jobs?state=failed&limit=101")).statusCode).toBe(400);
  });
});

describe("GET /api/admin/queues/:name/jobs/:id", () => {
  it("returns full failure detail, redacted", async () => {
    h.addJob("fulfillment", {
      id: ORDER_ID,
      state: "failed",
      name: "fulfill",
      data: { orderId: ORDER_ID },
      attemptsMade: 5,
      opts: { attempts: 5 },
      failedReason: "Resend rejected buyer@example.com",
      stacktrace: ["Error: Resend rejected buyer@example.com\n    at send (email.ts:1)"],
    });
    seedOrder();
    const res = await get(`/api/admin/queues/fulfillment/jobs/${ORDER_ID}`);
    expect(res.statusCode).toBe(200);
    const job = res.json();
    expect(job).toMatchObject({
      id: ORDER_ID,
      state: "failed",
      attemptsMade: 5,
      maxAttempts: 5,
      failedReason: "Resend rejected [redacted-email]",
      data: { orderId: ORDER_ID },
      gelatoUnknownOutcome: false,
    });
    expect(job.stacktrace[0]).toContain("[redacted-email]");
    expect(JSON.stringify(job)).not.toContain("buyer@example.com");
  });

  it("flags a fulfilment job whose order has an unreconciled Gelato submission", async () => {
    h.addJob("fulfillment", { id: ORDER_ID, state: "failed", data: { orderId: ORDER_ID }, failedReason: UNKNOWN_OUTCOME });
    seedOrder({ gelatoSubmitStartedAt: new Date("2026-09-20T10:00:00Z") });
    expect((await get(`/api/admin/queues/fulfillment/jobs/${ORDER_ID}`)).json().gelatoUnknownOutcome).toBe(true);
  });

  it("404 for a missing job", async () => {
    expect((await get("/api/admin/queues/fulfillment/jobs/nope")).statusCode).toBe(404);
  });
});

describe("POST /api/admin/queues/:name/jobs/:id/retry", () => {
  it("retries a failed job and audits it", async () => {
    const job = h.addJob("pipeline", { id: "s1__full", state: "failed", failedReason: "boom", attemptsMade: 1 });
    const res = await post("/api/admin/queues/pipeline/jobs/s1__full/retry");
    expect(res.statusCode).toBe(200);
    expect(job.retry).toHaveBeenCalledWith("failed", { resetAttemptsMade: true });
    expect(h.db.adminLog).toHaveLength(1);
    expect(h.db.adminLog[0]).toMatchObject({
      adminId: ADMIN.id,
      action: "job.retry",
      targetType: "job",
      targetId: "pipeline:s1__full",
    });
  });

  it("409 for a job that isn't failed", async () => {
    const job = h.addJob("pipeline", { id: "a1", state: "active" });
    const res = await post("/api/admin/queues/pipeline/jobs/a1/retry");
    expect(res.statusCode).toBe(409);
    expect(job.retry).not.toHaveBeenCalled();
    expect(h.db.adminLog).toHaveLength(0);
  });

  it("409 gelato_unknown_outcome instead of a pointless retry, until the order is reconciled", async () => {
    const job = h.addJob("fulfillment", { id: ORDER_ID, state: "failed", data: { orderId: ORDER_ID }, failedReason: UNKNOWN_OUTCOME });
    seedOrder({ gelatoSubmitStartedAt: new Date("2026-09-20T10:00:00Z") });
    const res = await post(`/api/admin/queues/fulfillment/jobs/${ORDER_ID}/retry`);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("gelato_unknown_outcome");
    expect(job.retry).not.toHaveBeenCalled();
  });

  it("moves a failed order back to paid before retrying its fulfilment, so success can move it forward", async () => {
    const job = h.addJob("fulfillment", { id: ORDER_ID, state: "failed", data: { orderId: ORDER_ID }, failedReason: "render timeout" });
    seedOrder({ status: "failed" });
    const res = await post(`/api/admin/queues/fulfillment/jobs/${ORDER_ID}/retry`);
    expect(res.statusCode).toBe(200);
    expect(job.retry).toHaveBeenCalled();
    expect(h.db.orders[0]!.status).toBe("paid");
    expect(h.db.events).toEqual([expect.objectContaining({ orderId: ORDER_ID, status: "paid", source: "admin" })]);
  });

  it("leaves the status alone when the order is already with Gelato", async () => {
    h.addJob("fulfillment", { id: ORDER_ID, state: "failed", data: { orderId: ORDER_ID }, failedReason: "email failed" });
    seedOrder({ status: "submitted_to_print", gelatoOrderId: "g-1" });
    expect((await post(`/api/admin/queues/fulfillment/jobs/${ORDER_ID}/retry`)).statusCode).toBe(200);
    expect(h.db.orders[0]!.status).toBe("submitted_to_print");
    expect(h.db.events).toHaveLength(0);
  });
});
