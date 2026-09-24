import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

const h = vi.hoisted(() => ({
  env: { REDIS_URL: "rediss://example" as string | undefined, STRIPE_WEBHOOK_SECRET: "whsec_test", GELATO_WEBHOOK_SECRET: "x", GELATO_WEBHOOK_ALLOW_UNSIGNED: false },
  prisma: {
    order: { findUnique: vi.fn(), update: vi.fn() },
    orderStatusEvent: { create: vi.fn() },
  },
  constructEvent: vi.fn(),
  enqueueFulfillment: vi.fn(),
}));

vi.mock("../../src/env", () => ({ env: h.env }));
vi.mock("../../src/db", () => ({ prisma: h.prisma }));
vi.mock("../../src/stripeClient", () => ({ stripe: { webhooks: { constructEvent: h.constructEvent } } }));
vi.mock("../../src/queue", () => ({ enqueueFulfillment: h.enqueueFulfillment }));

import { registerWebhookRoutes } from "../../src/routes/webhooks";

async function deliver() {
  const app = Fastify();
  await app.register(registerWebhookRoutes);
  const res = await app.inject({
    method: "POST",
    url: "/api/webhooks/stripe",
    headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=sig" },
    payload: "{}",
  });
  await app.close();
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.env.REDIS_URL = "rediss://example";
  h.constructEvent.mockReturnValue({ type: "payment_intent.succeeded", data: { object: { id: "pi_1" } } });
  h.enqueueFulfillment.mockResolvedValue({ id: "order-1" });
});

describe("POST /api/webhooks/stripe → fulfilment enqueue", () => {
  it("marks an awaiting order paid and only enqueues (no inline fulfilment)", async () => {
    h.prisma.order.findUnique.mockResolvedValue({ id: "order-1", status: "awaiting_payment" });
    const res = await deliver();
    expect(res.statusCode).toBe(200);
    expect(h.prisma.order.update).toHaveBeenCalledWith({ where: { id: "order-1" }, data: { status: "paid" } });
    expect(h.enqueueFulfillment).toHaveBeenCalledWith("order-1");
  });

  it("a redelivery for an order still 'paid' enqueues again (deduped by jobId)", async () => {
    h.prisma.order.findUnique.mockResolvedValue({ id: "order-1", status: "paid" });
    const res = await deliver();
    expect(res.statusCode).toBe(200);
    expect(h.prisma.order.update).not.toHaveBeenCalled();
    expect(h.enqueueFulfillment).toHaveBeenCalledWith("order-1");
  });

  it("does not enqueue for an order already past paid", async () => {
    h.prisma.order.findUnique.mockResolvedValue({ id: "order-1", status: "submitted_to_print" });
    expect((await deliver()).statusCode).toBe(200);
    expect(h.enqueueFulfillment).not.toHaveBeenCalled();
  });

  it("answers 5xx when the enqueue fails, so Stripe redelivers", async () => {
    h.prisma.order.findUnique.mockResolvedValue({ id: "order-1", status: "awaiting_payment" });
    h.enqueueFulfillment.mockRejectedValue(new Error("redis down"));
    expect((await deliver()).statusCode).toBe(500);
  });

  it("answers 503 when no queue is configured at all", async () => {
    h.env.REDIS_URL = undefined;
    h.prisma.order.findUnique.mockResolvedValue({ id: "order-1", status: "awaiting_payment" });
    expect((await deliver()).statusCode).toBe(503);
    expect(h.enqueueFulfillment).not.toHaveBeenCalled();
  });
});
