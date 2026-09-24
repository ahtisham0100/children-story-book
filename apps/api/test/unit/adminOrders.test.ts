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

const id = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

let app: Awaited<ReturnType<typeof buildAdminTestApp>>;
const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie: ADMIN_COOKIE } });
const post = (url: string, payload: object = {}) => app.inject({ method: "POST", url, headers: ADMIN_HEADERS, payload });

function order(n: number, fields: Record<string, unknown> = {}) {
  const row = {
    id: id(n),
    email: `buyer${n}@example.com`,
    status: "paid",
    totalCents: 3999,
    currency: "eur",
    shippingName: "Buyer",
    shippingLine1: "1 Road",
    shippingLine2: null,
    shippingCity: "Paris",
    shippingPostalCode: "75001",
    shippingCountry: "FR",
    gelatoOrderId: null,
    gelatoSubmitStartedAt: null,
    deliveredAt: null,
    anonymisedAt: null,
    createdAt: new Date(`2026-09-${String(10 + n).padStart(2, "0")}T12:00:00Z`),
    updatedAt: new Date(),
    ...fields,
  };
  h.db.orders.push(row);
  h.db.items.push({ id: `item-${n}`, orderId: row.id, sessionId: `session-${n}`, bookTitle: "Space Book", priceCents: 3999, printPdfKey: null });
  return row;
}

beforeEach(async () => {
  h.reset();
  app = await buildAdminTestApp(registerAdminRoutes);
});

describe("GET /api/admin/orders", () => {
  beforeEach(() => {
    order(1, { status: "paid", email: "Alice@Example.com" });
    order(2, { status: "delivered" });
    order(3, { status: "delivered" });
    order(4, { status: "failed" });
  });

  it("lists newest first with emails and paging", async () => {
    const res = await get("/api/admin/orders?page=1&limit=3");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ page: 1, limit: 3, total: 4 });
    expect(body.items.map((o: { id: string }) => o.id)).toEqual([id(4), id(3), id(2)]);
    expect(body.items[0]).toMatchObject({ email: "buyer4@example.com", status: "failed", itemCount: 1, totalCents: 3999 });
  });

  it("filters by status and by date range (inclusive day bounds)", async () => {
    expect((await get("/api/admin/orders?status=delivered")).json().total).toBe(2);
    const ranged = (await get("/api/admin/orders?from=2026-09-12&to=2026-09-13")).json();
    expect(ranged.items.map((o: { id: string }) => o.id)).toEqual([id(3), id(2)]);
  });

  it("searches by exact order id, or case-insensitively by email", async () => {
    expect((await get(`/api/admin/orders?q=${id(3)}`)).json().items.map((o: { id: string }) => o.id)).toEqual([id(3)]);
    expect((await get("/api/admin/orders?q=alice@example")).json().items.map((o: { id: string }) => o.id)).toEqual([id(1)]);
  });

  it("rejects a bad date or an oversized page", async () => {
    expect((await get("/api/admin/orders?from=yesterday")).statusCode).toBe(400);
    expect((await get("/api/admin/orders?limit=500")).statusCode).toBe(400);
  });
});

describe("GET /api/admin/orders/:id", () => {
  it("returns items, the timeline, allowed transitions and the fulfilment job, without raw webhook bodies", async () => {
    order(1, { status: "processing", gelatoOrderId: "g-1" });
    h.db.events.push(
      { id: "e1", orderId: id(1), status: "paid", source: "stripe_webhook", raw: { receipt_email: "buyer1@example.com" }, createdAt: new Date("2026-09-11T12:00:00Z") },
      { id: "e2", orderId: id(1), status: "processing", source: "admin", raw: { note: "Gelato said so", adminId: ADMIN.id }, createdAt: new Date("2026-09-12T12:00:00Z") },
    );
    h.addJob("fulfillment", { id: id(1), state: "completed", attemptsMade: 1 });
    const res = await get(`/api/admin/orders/${id(1)}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      id: id(1),
      email: "buyer1@example.com",
      status: "processing",
      gelatoOrderId: "g-1",
      gelatoUnknownOutcome: false,
      fulfillmentJob: { state: "completed", attemptsMade: 1 },
    });
    expect(body.allowedTransitions).toEqual(["dispatched", "delivered", "failed", "cancelled"]);
    expect(body.items[0]).toMatchObject({ id: "item-1", sessionId: "session-1", hasPrintPdf: false });
    expect(body.statusEvents.map((e: { status: string }) => e.status)).toEqual(["paid", "processing"]);
    expect(body.statusEvents[1].note).toBe("Gelato said so");
    expect(JSON.stringify(body.statusEvents)).not.toContain("receipt_email");
  });

  it("404 for an unknown order; 400 for a non-uuid", async () => {
    expect((await get(`/api/admin/orders/${id(9)}`)).statusCode).toBe(404);
    expect((await get("/api/admin/orders/not-a-uuid")).statusCode).toBe(400);
  });
});

describe("POST /api/admin/orders/:id/status", () => {
  it("applies an allowed transition, records an admin event and an audit row", async () => {
    order(1, { status: "submitted_to_print" });
    const res = await post(`/api/admin/orders/${id(1)}/status`, { status: "dispatched", note: "Tracking from Gelato email" });
    expect(res.statusCode).toBe(200);
    expect(h.db.orders[0]!.status).toBe("dispatched");
    expect(h.db.events).toEqual([
      expect.objectContaining({
        orderId: id(1),
        status: "dispatched",
        source: "admin",
        raw: { note: "Tracking from Gelato email", adminId: ADMIN.id },
      }),
    ]);
    expect(h.db.adminLog[0]).toMatchObject({
      adminId: ADMIN.id,
      action: "order.status",
      targetType: "order",
      targetId: id(1),
      before: { status: "submitted_to_print" },
      after: { status: "dispatched" },
      note: "Tracking from Gelato email",
    });
  });

  it("409 for a transition that isn't allowed, and changes nothing", async () => {
    order(1, { status: "delivered", deliveredAt: new Date("2026-09-01T00:00:00Z") });
    const res = await post(`/api/admin/orders/${id(1)}/status`, { status: "paid", note: "" });
    expect(res.statusCode).toBe(409);
    expect(res.json().allowed).toEqual([]);
    expect(h.db.orders[0]!.status).toBe("delivered");
    expect(h.db.events).toHaveLength(0);
    expect(h.db.adminLog).toHaveLength(0);
  });

  it("400 for a status that doesn't exist", async () => {
    order(1);
    expect((await post(`/api/admin/orders/${id(1)}/status`, { status: "teleported", note: "" })).statusCode).toBe(400);
  });

  it("setting delivered stamps deliveredAt (GDPR Pathway 2 anchor), once", async () => {
    order(1, { status: "dispatched" });
    expect((await post(`/api/admin/orders/${id(1)}/status`, { status: "delivered", note: "" })).statusCode).toBe(200);
    expect(h.db.orders[0]!.deliveredAt).toBeInstanceOf(Date);
    expect(h.prisma.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: id(1), deliveredAt: null } }),
    );
  });

  it("409 when the order changed between read and write", async () => {
    order(1, { status: "processing" });
    // Simulate a concurrent webhook: the conditional update matches nothing.
    h.prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await post(`/api/admin/orders/${id(1)}/status`, { status: "dispatched", note: "" });
    expect(res.statusCode).toBe(409);
    expect(h.db.events).toHaveLength(0);
  });
});

describe("POST /api/admin/orders/:id/gelato-sync", () => {
  it("409 when the order has no Gelato id", async () => {
    order(1, { status: "paid" });
    expect((await post(`/api/admin/orders/${id(1)}/gelato-sync`)).statusCode).toBe(409);
    expect(h.getGelatoOrder).not.toHaveBeenCalled();
  });

  it("503 without a Gelato API key", async () => {
    order(1, { status: "submitted_to_print", gelatoOrderId: "g-1" });
    h.env.GELATO_API_KEY = undefined;
    expect((await post(`/api/admin/orders/${id(1)}/gelato-sync`)).statusCode).toBe(503);
  });

  it("applies Gelato's status through the webhook's code path", async () => {
    order(1, { status: "submitted_to_print", gelatoOrderId: "g-1" });
    h.getGelatoOrder.mockResolvedValueOnce({ status: "delivered" });
    const res = await post(`/api/admin/orders/${id(1)}/gelato-sync`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ gelatoStatus: "delivered", applied: true, status: "delivered" });
    expect(h.getGelatoOrder).toHaveBeenCalledWith("g-1");
    expect(h.db.orders[0]!.status).toBe("delivered");
    expect(h.db.orders[0]!.deliveredAt).toBeInstanceOf(Date);
    expect(h.db.events[0]).toMatchObject({ status: "delivered", source: "gelato_sync" });
    expect(h.db.adminLog[0]).toMatchObject({ action: "order.gelato_sync", targetId: id(1) });
  });

  it("stores an unrecognised Gelato status without changing the order", async () => {
    order(1, { status: "submitted_to_print", gelatoOrderId: "g-1" });
    h.getGelatoOrder.mockResolvedValueOnce({ status: "teleporting" });
    const res = await post(`/api/admin/orders/${id(1)}/gelato-sync`);
    expect(res.json()).toMatchObject({ gelatoStatus: "teleporting", applied: false, status: "submitted_to_print" });
    expect(h.db.orders[0]!.status).toBe("submitted_to_print");
    expect(h.db.events[0]).toMatchObject({ status: "teleporting", source: "gelato_sync" });
  });

  it("502 with Gelato's error when the fetch fails", async () => {
    order(1, { status: "submitted_to_print", gelatoOrderId: "g-1" });
    h.getGelatoOrder.mockRejectedValueOnce(new Error("Gelato order fetch failed: 404 not found"));
    const res = await post(`/api/admin/orders/${id(1)}/gelato-sync`);
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toContain("404");
  });
});

describe("POST /api/admin/orders/:id/gelato-reconcile", () => {
  const STARTED = new Date("2026-09-20T10:00:00Z");

  it("409 unless the order has an unknown-outcome Gelato submission", async () => {
    order(1, { status: "failed" });
    expect((await post(`/api/admin/orders/${id(1)}/gelato-reconcile`, { clearSubmitMarker: true })).statusCode).toBe(409);
    order(2, { status: "submitted_to_print", gelatoOrderId: "g-2", gelatoSubmitStartedAt: STARTED });
    expect((await post(`/api/admin/orders/${id(2)}/gelato-reconcile`, { gelatoOrderId: "g-x" })).statusCode).toBe(409);
  });

  it("400 unless exactly one of gelatoOrderId / clearSubmitMarker is given", async () => {
    order(1, { status: "failed", gelatoSubmitStartedAt: STARTED });
    expect((await post(`/api/admin/orders/${id(1)}/gelato-reconcile`, {})).statusCode).toBe(400);
    expect(
      (await post(`/api/admin/orders/${id(1)}/gelato-reconcile`, { gelatoOrderId: "g", clearSubmitMarker: true })).statusCode,
    ).toBe(400);
  });

  it("records an existing Gelato order, moves the order on, and retries the failed job", async () => {
    order(1, { status: "failed", gelatoSubmitStartedAt: STARTED });
    const job = h.addJob("fulfillment", { id: id(1), state: "failed", data: { orderId: id(1) } });
    const res = await post(`/api/admin/orders/${id(1)}/gelato-reconcile`, { gelatoOrderId: "g-found" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ fulfillment: "retried", order: { status: "submitted_to_print", gelatoOrderId: "g-found" } });
    expect(job.retry).toHaveBeenCalledWith("failed", { resetAttemptsMade: true });
    expect(h.db.events[0]).toMatchObject({ status: "submitted_to_print", source: "admin" });
    expect(h.db.adminLog[0]).toMatchObject({
      action: "order.gelato_reconcile",
      before: { gelatoOrderId: null, status: "failed" },
      after: { gelatoOrderId: "g-found", status: "submitted_to_print" },
    });
  });

  it("clears the marker (no Gelato order exists), resets failed to paid, and retries", async () => {
    order(1, { status: "failed", gelatoSubmitStartedAt: STARTED });
    const job = h.addJob("fulfillment", { id: id(1), state: "failed", data: { orderId: id(1) } });
    const res = await post(`/api/admin/orders/${id(1)}/gelato-reconcile`, { clearSubmitMarker: true });
    expect(res.statusCode).toBe(200);
    expect(h.db.orders[0]).toMatchObject({ gelatoSubmitStartedAt: null, status: "paid" });
    expect(job.retry).toHaveBeenCalled();
    expect(res.json().fulfillment).toBe("retried");
  });

  it("enqueues fulfilment when there's no job to retry", async () => {
    order(1, { status: "failed", gelatoSubmitStartedAt: STARTED });
    const res = await post(`/api/admin/orders/${id(1)}/gelato-reconcile`, { clearSubmitMarker: true });
    expect(res.json().fulfillment).toBe("enqueued");
    expect(h.enqueueFulfillment).toHaveBeenCalledWith(id(1));
  });

  it("503 (before changing anything) when Redis isn't configured", async () => {
    order(1, { status: "failed", gelatoSubmitStartedAt: STARTED });
    h.env.REDIS_URL = undefined;
    expect((await post(`/api/admin/orders/${id(1)}/gelato-reconcile`, { clearSubmitMarker: true })).statusCode).toBe(503);
    expect(h.db.orders[0]!.gelatoSubmitStartedAt).toEqual(STARTED);
  });
});
