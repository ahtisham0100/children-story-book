import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type RouteOptions } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { ADMIN_COOKIE, CUSTOMER_COOKIE } from "./support/adminHarness";

// The admin plugin's cross-cutting guards, checked against EVERY route it
// registers (collected with an onRoute hook), so a route added later can't
// forget one: login (401), admin role (403), the CSRF header on mutations
// (403), and the rate limit (429).
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

const ORDER_ID = "11111111-1111-4111-8111-111111111111";

async function build() {
  const routes: RouteOptions[] = [];
  const app = Fastify();
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  app.addHook("onRoute", (route) => {
    routes.push(route);
  });
  await app.register(registerAdminRoutes);
  await app.ready();
  const adminRoutes = routes
    .flatMap((r) => [r.method].flat().map((method) => ({ method: String(method), url: r.url })))
    .filter((r) => r.method !== "HEAD");
  return { app, adminRoutes };
}

function concreteUrl(url: string) {
  return url
    .replace(":name", "fulfillment")
    .replace(":sessionId", "session-1")
    .replace(/:id/g, ORDER_ID);
}

const isMutation = (method: string) => !["GET", "HEAD", "OPTIONS"].includes(method);

beforeEach(() => {
  h.reset();
  h.env.RL_ADMIN_IP_MAX = 1000;
  h.env.RL_ADMIN_MUTATION_IP_MAX = 1000;
});

describe("admin plugin guards", () => {
  it("registers every admin route under /api/admin/", async () => {
    const { app, adminRoutes } = await build();
    // Guards against a vacuous pass: the queue, order, storage and deletion routes all exist.
    expect(adminRoutes.length).toBeGreaterThanOrEqual(15);
    for (const r of adminRoutes) expect(r.url.startsWith("/api/admin/")).toBe(true);
    await app.close();
  });

  it("answers 401 on every route when not logged in", async () => {
    const { app, adminRoutes } = await build();
    for (const r of adminRoutes) {
      const res = await app.inject({
        method: r.method as "GET",
        url: concreteUrl(r.url),
        headers: isMutation(r.method) ? { "x-admin-request": "1" } : {},
        payload: isMutation(r.method) ? {} : undefined,
      });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
    }
    await app.close();
  });

  it("answers 403 on every route for a logged-in customer who isn't an admin", async () => {
    const { app, adminRoutes } = await build();
    for (const r of adminRoutes) {
      const res = await app.inject({
        method: r.method as "GET",
        url: concreteUrl(r.url),
        headers: { cookie: CUSTOMER_COOKIE, ...(isMutation(r.method) ? { "x-admin-request": "1" } : {}) },
        payload: isMutation(r.method) ? {} : undefined,
      });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
      expect(res.json().message).toBe("Forbidden.");
    }
    await app.close();
  });

  it("refuses every mutation without the X-Admin-Request header, even from an admin (CSRF)", async () => {
    const { app, adminRoutes } = await build();
    const mutations = adminRoutes.filter((r) => isMutation(r.method));
    expect(mutations.length).toBeGreaterThanOrEqual(6);
    for (const r of mutations) {
      for (const header of [undefined, "0", "true"]) {
        const res = await app.inject({
          method: r.method as "POST",
          url: concreteUrl(r.url),
          headers: { cookie: ADMIN_COOKIE, ...(header === undefined ? {} : { "x-admin-request": header }) },
          payload: {},
        });
        expect(res.statusCode, `${r.method} ${r.url} header=${header}`).toBe(403);
        expect(res.json().message).toMatch(/X-Admin-Request/);
      }
    }
    // Nothing was written by any refused request.
    expect(h.db.adminLog).toHaveLength(0);
    expect(h.deleteSessionAssets).not.toHaveBeenCalled();
    await app.close();
  });

  it("lets an admin GET without the header (reads aren't state-changing)", async () => {
    const { app } = await build();
    const res = await app.inject({ method: "GET", url: "/api/admin/queues", headers: { cookie: ADMIN_COOKIE } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rate-limits admin routes per IP (429 with Retry-After)", async () => {
    h.env.RL_ADMIN_IP_MAX = 3;
    const { app } = await build();
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({ method: "GET", url: "/api/admin/queues", headers: { cookie: ADMIN_COOKIE } });
      codes.push(res.statusCode);
      if (i === 3) expect(res.headers["retry-after"]).toBeDefined();
    }
    expect(codes).toEqual([200, 200, 200, 429]);
    await app.close();
  });

  it("applies a tighter separate limit to mutations", async () => {
    h.env.RL_ADMIN_MUTATION_IP_MAX = 2;
    const { app } = await build();
    const post = () =>
      app.inject({
        method: "POST",
        url: "/api/admin/deletions/sweep",
        headers: { cookie: ADMIN_COOKIE, "x-admin-request": "1" },
        payload: { dryRun: true },
      });
    expect((await post()).statusCode).toBe(200);
    expect((await post()).statusCode).toBe(200);
    expect((await post()).statusCode).toBe(429);
    // Reads still work: they only count against the general limit.
    const read = await app.inject({ method: "GET", url: "/api/admin/queues", headers: { cookie: ADMIN_COOKIE } });
    expect(read.statusCode).toBe(200);
    await app.close();
  });
});
