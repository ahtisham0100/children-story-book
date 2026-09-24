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

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let app: Awaited<ReturnType<typeof buildAdminTestApp>>;
const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie: ADMIN_COOKIE } });
const post = (url: string, payload: object = {}) => app.inject({ method: "POST", url, headers: ADMIN_HEADERS, payload });

beforeEach(async () => {
  h.reset();
  app = await buildAdminTestApp(registerAdminRoutes);
});

describe("GET /api/admin/deletions/scheduled", () => {
  it("uses the sweeper's candidate query with a cutoff shifted by the look-ahead window", async () => {
    const before = Date.now();
    await get("/api/admin/deletions/scheduled?kind=p1&withinDays=7&limit=10");
    const [kind, q] = h.findCandidates.mock.calls[0]!;
    expect(kind).toBe("p1");
    // p1 is due at expiresAt + 24h, so "due within 7 days" means expiresAt < now + 7d - 24h.
    const expected = before + 7 * DAY - DAY;
    expect(Math.abs(q.cutoff.getTime() - expected)).toBeLessThan(5_000);
    expect(q).toMatchObject({ afterId: "", limit: 10 });
  });

  it("returns due dates from schedule.ts, dropping held sessions and those outside the window", async () => {
    const now = Date.now();
    h.findCandidates.mockResolvedValueOnce(["a-overdue", "b-soon", "c-held", "d-later", "e-gone"]);
    const delivered = (daysAgo: number) => [{ status: "delivered", deliveredAt: new Date(now - daysAgo * DAY) }];
    const session = { expiresAt: new Date(now - 60 * DAY), rawDeletedAt: new Date(now - 50 * DAY), processedDeletedAt: null };
    h.loadScheduleInput.mockImplementation(async (sid: string) => {
      switch (sid) {
        case "a-overdue":
          return { session, orders: delivered(31) };
        case "b-soon":
          return { session, orders: delivered(28) };
        case "c-held":
          return { session, orders: [...delivered(40), { status: "paid", deliveredAt: null }] };
        case "d-later":
          return { session, orders: delivered(1) };
        default:
          return null;
      }
    });
    const res = await get("/api/admin/deletions/scheduled?kind=p2_processed&withinDays=7&limit=5");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((i: { sessionId: string }) => i.sessionId)).toEqual(["a-overdue", "b-soon"]);
    expect(body.items[0]).toMatchObject({ pathway: "p2", scope: "processed", overdue: true });
    expect(body.items[1]).toMatchObject({ overdue: false });
    expect(new Date(body.items[1].dueAt).getTime()).toBeCloseTo(now + 2 * DAY, -4);
    // A full page means there may be more: the cursor is the last id the SQL returned.
    expect(body.nextCursor).toBe("e-gone");
  });

  it("skips p1 candidates whose raw photos are already deleted", async () => {
    h.findCandidates.mockResolvedValueOnce(["done"]);
    h.loadScheduleInput.mockResolvedValueOnce({
      session: { expiresAt: new Date(Date.now() - 3 * DAY), rawDeletedAt: new Date(), processedDeletedAt: null },
      orders: [],
    });
    const body = (await get("/api/admin/deletions/scheduled?kind=p1")).json();
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it("validates kind, window and cursor", async () => {
    expect((await get("/api/admin/deletions/scheduled")).statusCode).toBe(400);
    expect((await get("/api/admin/deletions/scheduled?kind=p9")).statusCode).toBe(400);
    expect((await get("/api/admin/deletions/scheduled?kind=p1&withinDays=61")).statusCode).toBe(400);
    expect((await get("/api/admin/deletions/scheduled?kind=p1&cursor=a%27--")).statusCode).toBe(400);
  });
});

describe("GET /api/admin/deletions/audit", () => {
  beforeEach(() => {
    const row = (n: number, fields: Record<string, unknown>) =>
      h.db.deletionAudit.push({
        id: `a${n}`,
        createdAt: new Date(`2026-09-${String(10 + n).padStart(2, "0")}T00:00:00Z`),
        trigger: "auto_p1",
        scope: "raw",
        sessionId: `s${n}`,
        fileCount: n,
        actor: "system",
        dryRun: false,
        outcome: "succeeded",
        error: null,
        force: false,
        ...fields,
      });
    row(1, {});
    row(2, { trigger: "admin", actor: ADMIN.id, force: true });
    row(3, { outcome: "failed", error: "R2 down" });
    row(4, { trigger: "user", scope: "account", sessionId: null });
  });

  it("lists newest first with paging", async () => {
    const body = (await get("/api/admin/deletions/audit?limit=2")).json();
    expect(body).toMatchObject({ total: 4, page: 1, limit: 2 });
    expect(body.items.map((r: { id: string }) => r.id)).toEqual(["a4", "a3"]);
  });

  it("filters by trigger, outcome, session and date", async () => {
    expect((await get("/api/admin/deletions/audit?trigger=admin")).json().items).toEqual([
      expect.objectContaining({ id: "a2", force: true, actor: ADMIN.id }),
    ]);
    expect((await get("/api/admin/deletions/audit?outcome=failed")).json().items[0].error).toBe("R2 down");
    expect((await get("/api/admin/deletions/audit?sessionId=s1")).json().total).toBe(1);
    expect((await get("/api/admin/deletions/audit?from=2026-09-12&to=2026-09-13")).json().total).toBe(2);
  });
});

describe("POST /api/admin/deletions/sessions/:sessionId", () => {
  const url = "/api/admin/deletions/sessions/s-1";
  const holding = () => {
    h.db.orders.push({ id: "o-1", status: "processing" });
    h.db.items.push({ id: "i-1", orderId: "o-1", sessionId: "s-1" });
  };

  it("requires confirm: DELETE and a valid scope", async () => {
    expect((await post(url, { scope: "all" })).statusCode).toBe(400);
    expect((await post(url, { scope: "all", confirm: "delete" })).statusCode).toBe(400);
    expect((await post(url, { scope: "everything", confirm: "DELETE" })).statusCode).toBe(400);
    expect(h.deleteSessionAssets).not.toHaveBeenCalled();
  });

  it("400 for an unsafe session id, before anything is touched", async () => {
    const res = await post("/api/admin/deletions/sessions/a.b", { scope: "all", confirm: "DELETE" });
    expect(res.statusCode).toBe(400);
    expect(h.deleteSessionAssets).not.toHaveBeenCalled();
  });

  it("deletes via deleteSessionAssets as trigger admin, actor = the admin", async () => {
    const res = await post(url, { scope: "raw", confirm: "DELETE" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sessionId: "s-1", scope: "raw", fileCount: 5, dryRun: false, force: false });
    expect(h.deleteSessionAssets).toHaveBeenCalledWith("s-1", {
      scope: "raw",
      trigger: "admin",
      actor: ADMIN.id,
      dryRun: false,
      force: false,
    });
  });

  it("ignores GDPR_DELETION_DRY_RUN (a manual action, like the customer's own request)", async () => {
    h.env.GDPR_DELETION_DRY_RUN = true;
    await post(url, { scope: "all", confirm: "DELETE" });
    expect(h.deleteSessionAssets.mock.calls[0]![1].dryRun).toBe(false);
  });

  it("passes dryRun through and reports holding orders without refusing, so the UI can preview", async () => {
    holding();
    const res = await post(url, { scope: "all", confirm: "DELETE", dryRun: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ fileCount: 7, dryRun: true, holdingOrders: [{ id: "o-1", status: "processing" }] });
    expect(h.deleteSessionAssets.mock.calls[0]![1]).toMatchObject({ dryRun: true });
  });

  it("409 for a session on an order in a holding status, unless force", async () => {
    holding();
    const refused = await post(url, { scope: "all", confirm: "DELETE" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().orders).toEqual([{ id: "o-1", status: "processing" }]);
    expect(h.deleteSessionAssets).not.toHaveBeenCalled();

    const forced = await post(url, { scope: "all", confirm: "DELETE", force: true });
    expect(forced.statusCode).toBe(200);
    expect(h.deleteSessionAssets).toHaveBeenCalledWith("s-1", expect.objectContaining({ force: true, trigger: "admin" }));
  });

  it("doesn't count cancelled or delivered orders as holding", async () => {
    h.db.orders.push({ id: "o-2", status: "delivered" }, { id: "o-3", status: "cancelled" });
    h.db.items.push({ id: "i-2", orderId: "o-2", sessionId: "s-1" }, { id: "i-3", orderId: "o-3", sessionId: "s-1" });
    expect((await post(url, { scope: "all", confirm: "DELETE" })).statusCode).toBe(200);
  });

  it("502 with the failure message when R2 deletion fails", async () => {
    h.deleteSessionAssets.mockRejectedValueOnce(new Error("R2 refused to delete 2 of 5 object(s)"));
    const res = await post(url, { scope: "all", confirm: "DELETE" });
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toContain("R2 refused");
  });
});

describe("POST /api/admin/deletions/sweep", () => {
  it("enqueues a sweep on the gdpr queue, dry run by default, and audits it", async () => {
    const res = await post("/api/admin/deletions/sweep", {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ dryRun: true, effectiveDryRun: true });
    expect(h.queue("gdpr").add).toHaveBeenCalledWith("sweep-manual", { dryRun: true }, expect.objectContaining({ attempts: 1 }));
    expect(h.db.adminLog[0]).toMatchObject({ action: "gdpr.sweep", targetType: "queue", targetId: "gdpr" });
  });

  it("reports that GDPR_DELETION_DRY_RUN still forces a dry run", async () => {
    h.env.GDPR_DELETION_DRY_RUN = true;
    expect((await post("/api/admin/deletions/sweep", { dryRun: false })).json()).toMatchObject({
      dryRun: false,
      effectiveDryRun: true,
    });
    h.env.GDPR_DELETION_DRY_RUN = false;
    expect((await post("/api/admin/deletions/sweep", { dryRun: false })).json().effectiveDryRun).toBe(false);
  });

  it("503 without Redis", async () => {
    h.env.REDIS_URL = undefined;
    expect((await post("/api/admin/deletions/sweep", {})).statusCode).toBe(503);
  });
});
