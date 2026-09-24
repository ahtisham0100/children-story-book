import { beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_COOKIE, buildAdminTestApp } from "./support/adminHarness";

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
  loadScheduleInputs: h.loadScheduleInputs,
}));

import { registerAdminRoutes } from "../../src/admin/plugin";
import { categorize } from "../../src/admin/storage";

const T = new Date("2026-09-20T10:00:00Z");
const obj = (key: string, size: number) => ({ key, size, lastModified: T });

let app: Awaited<ReturnType<typeof buildAdminTestApp>>;
const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie: ADMIN_COOKIE } });

beforeEach(async () => {
  h.reset();
  app = await buildAdminTestApp(registerAdminRoutes);
});

describe("categorize", () => {
  it("buckets keys by the storage layout", () => {
    expect(categorize("sessions/s1/characters/c1/raw.jpg")).toBe("raw");
    expect(categorize("sessions/s1/pages/p1.png")).toBe("processed");
    expect(categorize("orders/o1/items/i1/print.pdf")).toBe("printPdf");
    expect(categorize("scratch/swap/abc.png")).toBe("other");
    expect(categorize("sessions/s1/notes.txt")).toBe("other");
    expect(categorize("orders/o1/items/i1/other.pdf")).toBe("other");
  });
});

describe("GET /api/admin/storage/summary", () => {
  const LISTING = [
    obj("sessions/s1/characters/c1/raw.jpg", 100),
    obj("sessions/s1/characters/c2/raw.png", 50),
    obj("sessions/s1/pages/p1.png", 1000),
    obj("orders/o1/items/i1/print.pdf", 5000),
    obj("scratch/swap/x.png", 7),
  ];

  it("totals objects and bytes per category from one bucket listing", async () => {
    h.listObjects.mockResolvedValueOnce(LISTING);
    const res = await get("/api/admin/storage/summary");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(h.listObjects).toHaveBeenCalledWith("");
    expect(body.categories).toEqual({
      raw: { count: 2, bytes: 150 },
      processed: { count: 1, bytes: 1000 },
      printPdf: { count: 1, bytes: 5000 },
      other: { count: 1, bytes: 7 },
    });
    expect(body.total).toEqual({ count: 5, bytes: 6157 });
    expect(body.cached).toBe(false);
    expect(new Date(body.computedAt).toString()).not.toBe("Invalid Date");
  });

  it("serves the cached result for 10 minutes, and recomputes on refresh=1", async () => {
    h.listObjects.mockResolvedValue(LISTING);
    const first = (await get("/api/admin/storage/summary")).json();
    expect(h.redis.set).toHaveBeenCalledWith("admin:storage-summary", expect.any(String), "EX", 600);

    const second = (await get("/api/admin/storage/summary")).json();
    expect(second.cached).toBe(true);
    expect(second.computedAt).toBe(first.computedAt);
    expect(h.listObjects).toHaveBeenCalledTimes(1);

    const refreshed = (await get("/api/admin/storage/summary?refresh=1")).json();
    expect(refreshed.cached).toBe(false);
    expect(h.listObjects).toHaveBeenCalledTimes(2);
  });

  it("still answers when Redis is down (uncached)", async () => {
    h.listObjects.mockResolvedValue(LISTING);
    h.redis.get.mockRejectedValueOnce(new Error("ECONNRESET"));
    h.redis.set.mockRejectedValueOnce(new Error("ECONNRESET"));
    const res = await get("/api/admin/storage/summary");
    expect(res.statusCode).toBe(200);
    expect(res.json().total.count).toBe(5);
  });
});

describe("GET /api/admin/storage/sessions/:sessionId", () => {
  it("400 for an id that isn't SAFE_ID (it becomes an R2 prefix)", async () => {
    for (const bad of ["a.b", "a%2Fb", "a%20b"]) {
      expect((await get(`/api/admin/storage/sessions/${bad}`)).statusCode, bad).toBe(400);
    }
    // ".." doesn't even match the route; either way it never reaches a listing.
    expect([400, 404]).toContain((await get("/api/admin/storage/sessions/..")).statusCode);
    expect(h.listObjects).not.toHaveBeenCalled();
  });

  it("lists the session's own files and its order items' files, with markers and schedule, and no URLs", async () => {
    h.db.sessions.push({
      id: "s-1",
      expiresAt: new Date("2026-09-01T00:00:00Z"),
      rawDeletedAt: new Date("2026-09-05T00:00:00Z"),
      processedDeletedAt: null,
    });
    h.db.orders.push({ id: "o-1", status: "delivered", deliveredAt: new Date("2026-09-03T00:00:00Z") });
    h.db.items.push({ id: "i-1", orderId: "o-1", sessionId: "s-1" });
    h.listObjects.mockImplementation(async (prefix: string) =>
      prefix === "sessions/s-1/"
        ? [obj("sessions/s-1/pages/p1.png", 1000)]
        : prefix === "orders/o-1/items/i-1/"
          ? [obj("orders/o-1/items/i-1/print.pdf", 5000)]
          : [],
    );
    const res = await get("/api/admin/storage/sessions/s-1");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.files).toEqual([
      { key: "orders/o-1/items/i-1/print.pdf", size: 5000, lastModified: T.toISOString(), category: "printPdf" },
      { key: "sessions/s-1/pages/p1.png", size: 1000, lastModified: T.toISOString(), category: "processed" },
    ]);
    expect(body.session).toMatchObject({ rawDeletedAt: "2026-09-05T00:00:00.000Z", processedDeletedAt: null });
    expect(body.orders).toEqual([{ id: "o-1", status: "delivered" }]);
    expect(body.schedule).toMatchObject({ pathway: "p2", processedDueAt: "2026-10-03T00:00:00.000Z" });
    expect(JSON.stringify(body)).not.toMatch(/https?:\/\//);
  });

  it("works for a session row that no longer exists (files may remain)", async () => {
    h.listObjects.mockResolvedValue([]);
    const res = await get("/api/admin/storage/sessions/gone-1");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ files: [], session: null, orders: [], schedule: null });
  });
});
