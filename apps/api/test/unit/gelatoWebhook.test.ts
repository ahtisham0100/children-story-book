import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

// Mutable env stand-in so each test can flip the secret / dev flag.
const mockEnv = vi.hoisted(() => ({
  GELATO_WEBHOOK_SECRET: undefined as string | undefined,
  GELATO_WEBHOOK_ALLOW_UNSIGNED: false,
  STRIPE_WEBHOOK_SECRET: undefined as string | undefined,
}));
const mockPrisma = vi.hoisted(() => ({
  order: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  orderStatusEvent: { create: vi.fn() },
}));

vi.mock("../../src/env", () => ({ env: mockEnv }));
vi.mock("../../src/db", () => ({ prisma: mockPrisma }));
vi.mock("../../src/stripeClient", () => ({ stripe: { webhooks: { constructEvent: vi.fn() } } }));
vi.mock("../../src/queue", () => ({ enqueueFulfillment: vi.fn() }));

import { isGelatoWebhookAuthorized } from "../../src/print/gelatoWebhookAuth";
import { registerWebhookRoutes } from "../../src/routes/webhooks";

describe("isGelatoWebhookAuthorized", () => {
  it("accepts the exact configured secret", () => {
    expect(isGelatoWebhookAuthorized("s3cret-value", "s3cret-value", false)).toBe(true);
  });

  it("rejects a wrong secret of the same length", () => {
    expect(isGelatoWebhookAuthorized("s3cret-valuX", "s3cret-value", false)).toBe(false);
  });

  it("rejects a secret of a different length without throwing", () => {
    expect(isGelatoWebhookAuthorized("short", "s3cret-value", false)).toBe(false);
    expect(isGelatoWebhookAuthorized("s3cret-value-longer", "s3cret-value", false)).toBe(false);
    expect(isGelatoWebhookAuthorized("", "s3cret-value", false)).toBe(false);
  });

  it("rejects a missing or repeated header", () => {
    expect(isGelatoWebhookAuthorized(undefined, "s3cret-value", false)).toBe(false);
    expect(isGelatoWebhookAuthorized(["s3cret-value", "s3cret-value"], "s3cret-value", false)).toBe(false);
  });

  it("fails closed when no secret is configured", () => {
    expect(isGelatoWebhookAuthorized(undefined, undefined, false)).toBe(false);
    expect(isGelatoWebhookAuthorized("anything", undefined, false)).toBe(false);
  });

  it("allows unsigned requests only with the explicit dev flag", () => {
    expect(isGelatoWebhookAuthorized(undefined, undefined, true)).toBe(true);
  });

  it("still requires the secret when one is configured, even with the dev flag on", () => {
    expect(isGelatoWebhookAuthorized(undefined, "s3cret-value", true)).toBe(false);
  });
});

describe("POST /api/webhooks/gelato", () => {
  const SECRET = "test-gelato-secret";
  const ORDER_ID = "11111111-1111-4111-8111-111111111111";

  async function post(body: string, headers: Record<string, string> = { "x-gelato-webhook-secret": SECRET }) {
    const app = Fastify();
    await app.register(registerWebhookRoutes);
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/gelato",
      headers: { "content-type": "application/json", ...headers },
      payload: body,
    });
    await app.close();
    return res;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.GELATO_WEBHOOK_SECRET = SECRET;
    mockEnv.GELATO_WEBHOOK_ALLOW_UNSIGNED = false;
  });

  it("rejects every request when no secret is configured", async () => {
    mockEnv.GELATO_WEBHOOK_SECRET = undefined;
    const res = await post(JSON.stringify({ orderReferenceId: ORDER_ID, status: "shipped" }), {});
    expect(res.statusCode).toBe(401);
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret", async () => {
    const res = await post(JSON.stringify({ orderReferenceId: ORDER_ID, status: "shipped" }), {
      "x-gelato-webhook-secret": "nope",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 400 (not 500) for malformed JSON", async () => {
    const res = await post("{not json");
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for a JSON body that isn't an object", async () => {
    expect((await post("null")).statusCode).toBe(400);
    expect((await post("[1,2]")).statusCode).toBe(400);
  });

  it("returns 400 when fields are missing", async () => {
    expect((await post(JSON.stringify({ status: "shipped" }))).statusCode).toBe(400);
  });

  it("acknowledges an unknown order with 200 and writes nothing", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(null);
    const res = await post(JSON.stringify({ orderReferenceId: ORDER_ID, status: "shipped" }));
    expect(res.statusCode).toBe(200);
    expect(mockPrisma.orderStatusEvent.create).not.toHaveBeenCalled();
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });

  it("records the event and updates a known order", async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ id: ORDER_ID });
    const res = await post(JSON.stringify({ orderReferenceId: ORDER_ID, status: "shipped" }));
    expect(res.statusCode).toBe(200);
    expect(mockPrisma.orderStatusEvent.create).toHaveBeenCalledOnce();
    expect(mockPrisma.order.update).toHaveBeenCalledWith({ where: { id: ORDER_ID }, data: { status: "dispatched" } });
  });

  it("accepts unsigned requests with the dev flag and no secret", async () => {
    mockEnv.GELATO_WEBHOOK_SECRET = undefined;
    mockEnv.GELATO_WEBHOOK_ALLOW_UNSIGNED = true;
    mockPrisma.order.findUnique.mockResolvedValue({ id: ORDER_ID });
    const res = await post(JSON.stringify({ orderReferenceId: ORDER_ID, status: "shipped" }), {});
    expect(res.statusCode).toBe(200);
  });

  it("stamps deliveredAt only while it is still null, so a re-sent webhook can't push GDPR deletion back", async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ id: ORDER_ID });
    const res = await post(JSON.stringify({ orderReferenceId: ORDER_ID, status: "delivered" }));
    expect(res.statusCode).toBe(200);
    expect(mockPrisma.order.update).toHaveBeenCalledWith({ where: { id: ORDER_ID }, data: { status: "delivered" } });
    expect(mockPrisma.order.updateMany).toHaveBeenCalledOnce();
    const args = mockPrisma.order.updateMany.mock.calls[0]![0];
    expect(args.where).toEqual({ id: ORDER_ID, deliveredAt: null });
    expect(args.data.deliveredAt).toBeInstanceOf(Date);
  });

  it("does not touch deliveredAt for other statuses", async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ id: ORDER_ID });
    await post(JSON.stringify({ orderReferenceId: ORDER_ID, status: "shipped" }));
    expect(mockPrisma.order.updateMany).not.toHaveBeenCalled();
  });
});
