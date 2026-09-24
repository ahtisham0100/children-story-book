import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { prisma } from "../db";
import { env } from "../env";
import { stripe } from "../stripeClient";
import { canTransitionToPaid, mapGelatoStatus, ORDER_STATUS, type OrderStatus } from "../orderStatus";
import { enqueueFulfillment } from "../queue";
import { isGelatoWebhookAuthorized } from "../print/gelatoWebhookAuth";

/**
 * Its own encapsulated plugin (registered via app.register, not called
 * directly like registerSessionRoutes) so the raw-body content-type parser
 * below applies ONLY to these two routes — Fastify plugin encapsulation means
 * every other route keeps normal JSON parsing.
 */
export async function registerWebhookRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  app.post("/api/webhooks/stripe", async (request, reply) => {
    const signature = request.headers["stripe-signature"];
    if (typeof signature !== "string") {
      return reply.code(400).send({ message: "Missing stripe-signature header." });
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        request.body as Buffer,
        signature,
        env.STRIPE_WEBHOOK_SECRET ?? "",
      );
    } catch (error) {
      request.log.error({ error }, "Stripe webhook signature verification failed");
      return reply.code(400).send({ message: "Invalid signature." });
    }

    if (event.type === "payment_intent.succeeded") {
      const paymentIntent = event.data.object as { id: string };
      const order = await prisma.order.findUnique({ where: { stripePaymentIntentId: paymentIntent.id } });
      if (!order) {
        request.log.warn(`Stripe webhook for unknown PaymentIntent ${paymentIntent.id}`);
        return reply.code(200).send({ received: true });
      }
      // Prisma models order.status as a plain string column (not a native
      // Postgres enum), so this cast is the same "we own the vocabulary, the
      // DB doesn't enforce it" trust already implicit in ORDER_STATUS itself.
      let status = order.status;
      if (canTransitionToPaid(order.status as OrderStatus)) {
        await prisma.order.update({ where: { id: order.id }, data: { status: ORDER_STATUS.paid } });
        await prisma.orderStatusEvent.create({
          data: { orderId: order.id, status: ORDER_STATUS.paid, source: "stripe_webhook", raw: event as object },
        });
        status = ORDER_STATUS.paid;
      }
      // Enqueue whenever the order is "paid" (not only on the first
      // transition). If the enqueue fails, we answer 5xx so Stripe redelivers,
      // and that redelivery, which no longer transitions, still gets to
      // enqueue. Duplicates are deduped by jobId = orderId. Only enqueuing:
      // Stripe expects a fast response, and the fulfillment worker does the
      // minutes-long render + PDF + Gelato work.
      if (status === ORDER_STATUS.paid) {
        if (!env.REDIS_URL) {
          request.log.error(`Order ${order.id} is paid but REDIS_URL is not configured — cannot enqueue fulfilment.`);
          return reply.code(503).send({ message: "Fulfilment queue unavailable." });
        }
        try {
          await enqueueFulfillment(order.id);
        } catch (error) {
          request.log.error({ error }, `Failed to enqueue fulfilment for order ${order.id}`);
          return reply.code(500).send({ message: "Failed to enqueue fulfilment." });
        }
      }
    }

    return reply.code(200).send({ received: true });
  });

  // Logged once at boot (this plugin registers once per process, in both
  // index.ts and server.ts run modes).
  if (!env.GELATO_WEBHOOK_SECRET) {
    if (env.GELATO_WEBHOOK_ALLOW_UNSIGNED) {
      app.log.warn(
        "⚠ GELATO_WEBHOOK_ALLOW_UNSIGNED=true — /api/webhooks/gelato accepts UNSIGNED requests. Dev only; never set this in production.",
      );
    } else {
      app.log.warn("GELATO_WEBHOOK_SECRET not set — /api/webhooks/gelato will reject every request (fail closed).");
    }
  }

  app.post("/api/webhooks/gelato", async (request, reply) => {
    const authorized = isGelatoWebhookAuthorized(
      request.headers["x-gelato-webhook-secret"],
      env.GELATO_WEBHOOK_SECRET,
      env.GELATO_WEBHOOK_ALLOW_UNSIGNED,
    );
    if (!authorized) {
      return reply.code(401).send({ message: "Invalid webhook secret." });
    }

    let payload: { orderReferenceId?: unknown; status?: unknown };
    try {
      const parsed: unknown = JSON.parse((request.body as Buffer).toString("utf-8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return reply.code(400).send({ message: "Body must be a JSON object." });
      }
      payload = parsed as typeof payload;
    } catch {
      return reply.code(400).send({ message: "Malformed JSON body." });
    }
    const { orderReferenceId, status } = payload;
    if (typeof orderReferenceId !== "string" || !orderReferenceId || typeof status !== "string" || !status) {
      return reply.code(400).send({ message: "Missing orderReferenceId or status." });
    }

    // An unknown order must not 500: Gelato would retry it forever. Log it and
    // acknowledge. (Writing the status event first used to fail on the orderId
    // foreign key, which is exactly that 500.)
    const order = await prisma.order.findUnique({ where: { id: orderReferenceId }, select: { id: true } });
    if (!order) {
      request.log.warn(`Gelato webhook for unknown order ${orderReferenceId} (status "${status}") — acknowledged and ignored.`);
      return reply.code(200).send({ received: true });
    }

    const mapped = mapGelatoStatus(status);
    await prisma.orderStatusEvent.create({
      data: {
        orderId: orderReferenceId,
        status: mapped ?? status,
        source: "gelato_webhook",
        raw: payload as object,
      },
    });
    if (mapped) {
      await prisma.order.update({ where: { id: orderReferenceId }, data: { status: mapped } });
      // GDPR Pathway 2 anchors on the FIRST delivery report. The deliveredAt
      // IS NULL condition makes a re-sent "delivered" webhook a no-op, so it
      // can never push the deletion date back (src/gdpr/schedule.ts).
      if (mapped === ORDER_STATUS.delivered) {
        await prisma.order.updateMany({
          where: { id: orderReferenceId, deliveredAt: null },
          data: { deliveredAt: new Date() },
        });
      }
    } else {
      request.log.warn(`Unrecognized Gelato status "${status}" for order ${orderReferenceId} — stored raw, order.status left unchanged.`);
    }

    return reply.code(200).send({ received: true });
  });
}
