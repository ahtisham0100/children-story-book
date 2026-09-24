import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { Prisma } from "@prisma/client";

// GDPR Pathway 3 through the real routes (Fastify inject), with an in-memory
// database. deleteSessionAssets is stubbed here (it has its own tests); what's
// under test is who can call this, when it refuses, and exactly what the
// anonymisation keeps and removes.
const h = vi.hoisted(() => {
  type Row = Record<string, any>;
  const db = {
    customers: [] as Row[],
    authTokens: [] as Row[],
    customerSessions: [] as Row[],
    orders: [] as Row[],
    items: [] as Row[],
    events: [] as Row[],
    sessions: [] as Row[],
    characters: [] as Row[],
    audit: [] as Row[],
  };

  // Just enough of Prisma's `where` to cover the queries under test.
  const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([key, cond]) => {
      if (key === "items" && cond?.some) return db.items.some((i) => i.orderId === row.id && matches(i, cond.some));
      if (cond && typeof cond === "object" && !(cond instanceof Date) && "in" in cond) return cond.in.includes(row[key]);
      if (cond && typeof cond === "object" && !(cond instanceof Date) && "notIn" in cond) return !cond.notIn.includes(row[key]);
      if (cond && typeof cond === "object" && !(cond instanceof Date) && "not" in cond) return row[key] !== cond.not;
      return row[key] === cond;
    });
  const table = (rows: () => Row[], set: (r: Row[]) => void) => ({
    findMany: vi.fn(async (args: { where?: Row; include?: Row } = {}) =>
      rows()
        .filter((r) => matches(r, args.where))
        .map((r) => (args.include?.items ? { ...r, items: db.items.filter((i) => i.orderId === r.id).map((i) => ({ ...i })) } : { ...r })),
    ),
    findUnique: vi.fn(async ({ where }: { where: Row }) => {
      const r = rows().find((x) => matches(x, where));
      return r ? { ...r } : null;
    }),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const r = rows().find((x) => matches(x, where));
      if (!r) throw new Error("not found");
      return Object.assign(r, data);
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const hit = rows().filter((x) => matches(x, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    }),
    deleteMany: vi.fn(async ({ where }: { where: Row }) => {
      const before = rows().length;
      set(rows().filter((x) => !matches(x, where)));
      return { count: before - rows().length };
    }),
    delete: vi.fn(async ({ where }: { where: Row }) => {
      const r = rows().find((x) => matches(x, where));
      if (!r) throw new Error("not found");
      set(rows().filter((x) => x !== r));
      return r;
    }),
    create: vi.fn(async ({ data }: { data: Row }) => {
      rows().push({ ...data });
      return data;
    }),
  });

  const prisma: Row = {
    customer: table(() => db.customers, (r) => (db.customers = r)),
    authToken: table(() => db.authTokens, (r) => (db.authTokens = r)),
    customerSession: table(() => db.customerSessions, (r) => (db.customerSessions = r)),
    order: table(() => db.orders, (r) => (db.orders = r)),
    orderItem: table(() => db.items, (r) => (db.items = r)),
    orderStatusEvent: table(() => db.events, (r) => (db.events = r)),
    session: table(() => db.sessions, (r) => (db.sessions = r)),
    character: table(() => db.characters, (r) => (db.characters = r)),
    deletionAuditLog: table(() => db.audit, (r) => (db.audit = r)),
  };
  prisma.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma));

  const env = {
    GDPR_DELETION_DRY_RUN: true, // must NOT affect a user-triggered deletion
    RL_MY_DATA_IP_MAX: 100,
    RL_MY_DATA_WINDOW_MIN: 60,
    AUTH_SESSION_TTL_DAYS: 30,
    AUTH_COOKIE_SECURE: false,
    AUTH_COOKIE_SAMESITE: "lax",
    AUTH_COOKIE_DOMAIN: undefined,
  };

  const stripe = {
    paymentIntents: {
      retrieve: vi.fn(async (id: string) => ({ id, status: "requires_payment_method" })),
      cancel: vi.fn(async (id: string) => ({ id, status: "canceled" })),
    },
  };

  const deleteSessionAssets = vi.fn(async (sessionId: string, opts: Row) => ({
    sessionId,
    scope: opts.scope,
    fileCount: 4,
    dryRun: opts.dryRun,
  }));

  return { db, prisma, env, stripe, deleteSessionAssets };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));
vi.mock("../../src/env", () => ({ env: h.env }));
vi.mock("../../src/stripeClient", () => ({ stripe: h.stripe }));
vi.mock("../../src/gdpr/deleteSessionAssets", () => ({ deleteSessionAssets: h.deleteSessionAssets }));
vi.mock("../../src/auth/service", () => ({
  normalizeEmail: (e: string) => e.trim().toLowerCase(),
  getCustomerBySessionToken: async (raw: string) => {
    const s = h.db.customerSessions.find((x) => x.tokenHash === `hash:${raw}`);
    return s ? (h.db.customers.find((c) => c.id === s.customerId) ?? null) : null;
  },
}));

import { registerAccountRoutes } from "../../src/routes/account";

const ME = "cust-me";
const OTHER = "cust-other";
const MY_COOKIE = "my-cookie-secret";
const DELIVERED_AT = new Date("2026-09-01T10:00:00Z");
const CREATED_AT = new Date("2026-08-20T10:00:00Z");

const personal = {
  email: "parent@example.com",
  shippingName: "Pat Parent",
  shippingLine1: "1 Rue Exemple",
  shippingLine2: "Apt 2",
  shippingCity: "Paris",
  shippingPostalCode: "75001",
  shippingCountry: "FR",
};

function seed() {
  const d = h.db;
  d.customers = [
    { id: ME, email: personal.email, role: "customer" },
    { id: OTHER, email: "other@example.com", role: "customer" },
  ];
  d.authTokens = [
    { id: "t1", customerId: ME },
    { id: "t2", customerId: OTHER },
  ];
  d.customerSessions = [
    { id: "cs1", customerId: ME, tokenHash: `hash:${MY_COOKIE}` },
    { id: "cs2", customerId: OTHER, tokenHash: "hash:other-cookie" },
  ];
  d.orders = [
    {
      id: "o-delivered", customerId: ME, ...personal, status: "delivered", totalCents: 3999, currency: "eur",
      createdAt: CREATED_AT, deliveredAt: DELIVERED_AT, anonymisedAt: null, stripePaymentIntentId: "pi_paid",
      gdprConsentAt: CREATED_AT,
    },
    {
      id: "o-abandoned", customerId: ME, ...personal, status: "awaiting_payment", totalCents: 2999, currency: "eur",
      createdAt: CREATED_AT, deliveredAt: null, anonymisedAt: null, stripePaymentIntentId: "pi_open",
      gdprConsentAt: CREATED_AT,
    },
    {
      id: "o-other", customerId: OTHER, ...personal, email: "other@example.com", status: "delivered", totalCents: 1000,
      currency: "eur", createdAt: CREATED_AT, deliveredAt: DELIVERED_AT, anonymisedAt: null,
      stripePaymentIntentId: "pi_other", gdprConsentAt: CREATED_AT,
    },
  ];
  d.items = [
    { id: "i1", orderId: "o-delivered", sessionId: "s1", bookTitle: "Space Book", priceCents: 3999,
      configSnapshot: [{ slot: "child_1", childName: "Ada", rawKey: "sessions/s1/characters/c1/raw.jpg" }],
      printPageKeys: ["sessions/s1/pages/p1.png"], printPdfKey: "orders/o-delivered/items/i1/print.pdf" },
    { id: "i2", orderId: "o-abandoned", sessionId: "s2", bookTitle: "Sea Book", priceCents: 2999,
      configSnapshot: [{ slot: "child_1", childName: "Ada", rawKey: "sessions/s2/characters/c2/raw.jpg" }],
      printPageKeys: [], printPdfKey: null },
    { id: "i3", orderId: "o-other", sessionId: "s3", bookTitle: "Other Book", priceCents: 1000,
      configSnapshot: [{ slot: "child_1", childName: "Zed", rawKey: "sessions/s3/characters/c3/raw.jpg" }],
      printPageKeys: [], printPdfKey: "orders/o-other/items/i3/print.pdf" },
  ];
  d.events = [
    { id: "e1", orderId: "o-delivered", status: "paid", source: "stripe_webhook", raw: { receipt_email: personal.email } },
    { id: "e2", orderId: "o-delivered", status: "delivered", source: "gelato_webhook", raw: { address: "1 Rue Exemple" } },
    { id: "e3", orderId: "o-other", status: "paid", source: "stripe_webhook", raw: { receipt_email: "other@example.com" } },
  ];
  const session = (id: string) => ({
    id, expiresAt: new Date("2026-08-25T00:00:00Z"), rawDeletedAt: null, processedDeletedAt: null, previewKey: null,
  });
  d.sessions = [session("s1"), session("s2"), session("s3")];
  d.characters = [
    { id: "c1", sessionId: "s1", childName: "Ada" },
    { id: "c2", sessionId: "s2", childName: "Ada" },
    { id: "c3", sessionId: "s3", childName: "Zed" },
  ];
  d.audit = [];
}

async function request(method: "GET" | "DELETE", opts: { cookie?: string; payload?: object } = {}) {
  const app = Fastify();
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await registerAccountRoutes(app);
  const res = await app.inject({
    method,
    url: "/api/account/my-data",
    headers: opts.cookie ? { cookie: `cbp_session=${opts.cookie}` } : {},
    ...(opts.payload ? { payload: opts.payload } : {}),
  });
  await app.close();
  return res;
}
const deleteMine = (payload: object = { confirm: "DELETE" }) => request("DELETE", { cookie: MY_COOKIE, payload });

beforeEach(() => {
  vi.clearAllMocks();
  h.env.RL_MY_DATA_IP_MAX = 100;
  seed();
});

describe("DELETE /api/account/my-data: who and when", () => {
  it("401 when not logged in, and nothing is touched", async () => {
    const res = await request("DELETE", { payload: { confirm: "DELETE" } });
    expect(res.statusCode).toBe(401);
    expect(h.deleteSessionAssets).not.toHaveBeenCalled();
    expect(h.db.customers).toHaveLength(2);
  });

  it.each([{}, { confirm: "delete" }, { confirm: "yes" }, { confirm: true }])(
    "400 without the exact confirmation (%j)",
    async (payload) => {
      const res = await deleteMine(payload);
      expect(res.statusCode).toBe(400);
      expect(h.deleteSessionAssets).not.toHaveBeenCalled();
      expect(h.db.customers).toHaveLength(2);
    },
  );

  it.each(["paid", "pdf_ready", "submitted_to_print", "processing"])(
    "409 listing an undispatched %s order, deleting nothing",
    async (status) => {
      h.db.orders.push({ ...h.db.orders[0], id: "o-inflight", status, deliveredAt: null });
      const res = await deleteMine();
      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.message).toMatch(/o-inflight/);
      expect(body.orders).toEqual([{ id: "o-inflight", status }]);
      expect(h.deleteSessionAssets).not.toHaveBeenCalled();
      expect(h.stripe.paymentIntents.cancel).not.toHaveBeenCalled();
      expect(h.db.customers.find((c) => c.id === ME)).toBeDefined();
      expect(h.db.orders.find((o) => o.id === "o-delivered")!.email).toBe(personal.email);
    },
  );

  it("does NOT block on dispatched, delivered, cancelled or failed orders", async () => {
    for (const status of ["dispatched", "cancelled", "failed"]) {
      h.db.orders.push({ ...h.db.orders[0], id: `o-${status}`, status, stripePaymentIntentId: null });
    }
    const res = await deleteMine();
    expect(res.statusCode).toBe(200);
  });

  it("rate-limits repeated calls per IP", async () => {
    h.env.RL_MY_DATA_IP_MAX = 2;
    const app = Fastify();
    await app.register(cookie);
    await app.register(rateLimit, { global: false });
    await registerAccountRoutes(app);
    const hit = () =>
      app.inject({ method: "DELETE", url: "/api/account/my-data", payload: { confirm: "nope" } });
    expect((await hit()).statusCode).not.toBe(429);
    expect((await hit()).statusCode).not.toBe(429);
    expect((await hit()).statusCode).toBe(429);
    await app.close();
  });
});

describe("DELETE /api/account/my-data: a successful deletion", () => {
  it("deletes every session's files for real, ignoring the automated dry-run flag", async () => {
    const res = await deleteMine();
    expect(res.statusCode).toBe(200);
    expect(h.deleteSessionAssets).toHaveBeenCalledTimes(2);
    for (const sid of ["s1", "s2"]) {
      expect(h.deleteSessionAssets).toHaveBeenCalledWith(sid, { scope: "all", trigger: "user", actor: ME, dryRun: false });
    }
    expect(res.json()).toEqual({ sessionsDeleted: 2, fileCount: 8, ordersAnonymised: 2, sessionsKeptShared: 0 });
  });

  it("anonymises orders: personal fields gone, accounting fields intact", async () => {
    await deleteMine();
    const o = h.db.orders.find((x) => x.id === "o-delivered")!;
    expect(o).toMatchObject({
      email: "",
      shippingName: "",
      shippingLine1: "",
      shippingLine2: null,
      shippingCity: "",
      shippingPostalCode: "",
      customerId: null,
      // kept for accounting
      status: "delivered",
      totalCents: 3999,
      currency: "eur",
      createdAt: CREATED_AT,
      deliveredAt: DELIVERED_AT,
      stripePaymentIntentId: "pi_paid",
      shippingCountry: "FR", // kept deliberately: VAT accounting
    });
    expect(o.anonymisedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(o)).not.toContain("parent@example.com");
    expect(JSON.stringify(o)).not.toContain("Pat Parent");
    expect(JSON.stringify(o)).not.toContain("Rue Exemple");

    const item = h.db.items.find((i) => i.id === "i1")!;
    expect(item).toMatchObject({ bookTitle: "Space Book", priceCents: 3999, sessionId: "s1", printPdfKey: null });
    expect(item.configSnapshot).toEqual([{ slot: "child_1", childName: "", rawKey: null }]);

    for (const e of h.db.events.filter((x) => x.orderId === "o-delivered")) {
      expect(e.raw).toBe(Prisma.DbNull);
      expect(e.status).toBeDefined();
    }
  });

  it("cancels an abandoned checkout's PaymentIntent and marks that order cancelled", async () => {
    await deleteMine();
    expect(h.stripe.paymentIntents.cancel).toHaveBeenCalledWith("pi_open");
    expect(h.stripe.paymentIntents.cancel).not.toHaveBeenCalledWith("pi_paid");
    const o = h.db.orders.find((x) => x.id === "o-abandoned")!;
    expect(o.status).toBe("cancelled");
    expect(h.db.events).toContainEqual(
      expect.objectContaining({ orderId: "o-abandoned", status: "cancelled", source: "gdpr_account_deletion" }),
    );
  });

  it("deletes session, character, token, login-session and customer rows, and clears the cookie", async () => {
    const res = await deleteMine();
    expect(h.db.sessions.map((s) => s.id)).toEqual(["s3"]);
    expect(h.db.characters.map((c) => c.id)).toEqual(["c3"]);
    expect(h.db.authTokens.map((t) => t.id)).toEqual(["t2"]);
    expect(h.db.customerSessions.map((s) => s.id)).toEqual(["cs2"]);
    expect(h.db.customers.map((c) => c.id)).toEqual([OTHER]);
    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toMatch(/cbp_session=;/);
    expect(setCookie).toMatch(/Max-Age=0/);
  });

  it("leaves another customer's data completely untouched", async () => {
    const before = JSON.stringify({
      order: h.db.orders.find((o) => o.id === "o-other"),
      item: h.db.items.find((i) => i.id === "i3"),
      events: h.db.events.filter((e) => e.orderId === "o-other"),
      session: h.db.sessions.find((s) => s.id === "s3"),
    });
    await deleteMine();
    expect(h.deleteSessionAssets).not.toHaveBeenCalledWith("s3", expect.anything());
    expect(
      JSON.stringify({
        order: h.db.orders.find((o) => o.id === "o-other"),
        item: h.db.items.find((i) => i.id === "i3"),
        events: h.db.events.filter((e) => e.orderId === "o-other"),
        session: h.db.sessions.find((s) => s.id === "s3"),
      }),
    ).toBe(before);
  });

  it("keeps (and reports) a session that another customer's order also uses", async () => {
    h.db.items.push({ ...h.db.items[2], id: "i4", orderId: "o-other", sessionId: "s1" });
    const res = await deleteMine();
    expect(h.deleteSessionAssets).not.toHaveBeenCalledWith("s1", expect.anything());
    expect(h.db.sessions.find((s) => s.id === "s1")).toBeDefined();
    expect(res.json().sessionsKeptShared).toBe(1);
  });

  it("writes one account-level audit row with no personal data", async () => {
    await deleteMine();
    const rows = h.db.audit.filter((r) => r.scope === "account");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ trigger: "user", actor: ME, sessionId: null, dryRun: false, outcome: "succeeded", fileCount: 8 });
    expect(JSON.stringify(rows[0])).not.toContain("@");
  });
});

describe("DELETE /api/account/my-data: failures leave the account intact for a retry", () => {
  it("503 when the open PaymentIntent can't be cancelled; nothing deleted", async () => {
    h.stripe.paymentIntents.cancel.mockRejectedValueOnce(new Error("stripe down"));
    const res = await deleteMine();
    expect(res.statusCode).toBe(503);
    expect(h.deleteSessionAssets).not.toHaveBeenCalled();
    expect(h.db.customers.find((c) => c.id === ME)).toBeDefined();
  });

  it("409 when the 'abandoned' checkout was actually just paid (webhook not processed yet)", async () => {
    h.stripe.paymentIntents.retrieve.mockResolvedValueOnce({ id: "pi_open", status: "succeeded" });
    const res = await deleteMine();
    expect(res.statusCode).toBe(409);
    expect(h.deleteSessionAssets).not.toHaveBeenCalled();
    expect(h.stripe.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  it("treats an already-cancelled PaymentIntent as fine", async () => {
    h.stripe.paymentIntents.retrieve.mockResolvedValueOnce({ id: "pi_open", status: "canceled" });
    const res = await deleteMine();
    expect(res.statusCode).toBe(200);
    expect(h.stripe.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  it("500 when R2 deletion fails; nothing anonymised, customer still there", async () => {
    h.deleteSessionAssets.mockRejectedValueOnce(new Error("R2 refused"));
    const res = await deleteMine();
    expect(res.statusCode).toBe(500);
    expect(h.db.orders.find((o) => o.id === "o-delivered")!.email).toBe(personal.email);
    expect(h.db.customers.find((c) => c.id === ME)).toBeDefined();
    expect(h.db.sessions).toHaveLength(3);
  });
});

describe("GET /api/account/my-data", () => {
  it("401 when not logged in", async () => {
    expect((await request("GET")).statusCode).toBe(401);
  });

  it("lists only my orders with per-item photo status and deletion dates", async () => {
    h.db.sessions.find((s) => s.id === "s1")!.rawDeletedAt = new Date("2026-09-02T11:00:00Z");
    const res = await request("GET", { cookie: MY_COOKIE });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.orders.map((o: { id: string }) => o.id).sort()).toEqual(["o-abandoned", "o-delivered"]);

    const delivered = body.orders.find((o: { id: string }) => o.id === "o-delivered");
    expect(delivered.deliveredAt).toBe(DELIVERED_AT.toISOString());
    expect(delivered.items).toEqual([
      {
        id: "i1",
        sessionId: "s1",
        bookTitle: "Space Book",
        photos: "deleted",
        bookFiles: "stored",
        photosDeletionDueAt: "2026-09-02T10:00:00.000Z",
        bookFilesDeletionDueAt: "2026-10-01T10:00:00.000Z",
      },
    ]);

    // Abandoned checkout: Pathway 1 dates (expiresAt + 24h), previews kept.
    const abandoned = body.orders.find((o: { id: string }) => o.id === "o-abandoned");
    expect(abandoned.items[0]).toMatchObject({
      photos: "stored",
      photosDeletionDueAt: "2026-08-26T00:00:00.000Z",
      bookFilesDeletionDueAt: null,
    });
    expect(JSON.stringify(body)).not.toContain("Zed");
  });
});
