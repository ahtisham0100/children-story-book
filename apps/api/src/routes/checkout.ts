import type { FastifyInstance } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { stripe } from "../stripeClient";
import { getBook } from "../pipeline/catalog";
import { computeTotalCents } from "../pricing";
import { buildConfigSnapshot, buildPrintPageKeys } from "../orderSnapshot";
import { findOrCreateCustomerByEmail } from "../auth/service";
import { sessionActivity } from "../sessionExpiry";

const ErrorResponse = Type.Object({ message: Type.String() });

const CheckoutBody = Type.Object({
  sessionIds: Type.Array(Type.String({ format: "uuid" }), { minItems: 1 }),
  email: Type.String({ format: "email" }),
  shippingAddress: Type.Object({
    name: Type.String({ minLength: 1 }),
    line1: Type.String({ minLength: 1 }),
    line2: Type.Optional(Type.String()),
    city: Type.String({ minLength: 1 }),
    postalCode: Type.String({ minLength: 1 }),
    country: Type.String({ minLength: 2, maxLength: 2 }),
  }),
  gdprConsent: Type.Literal(true),
});
const CheckoutResponse = Type.Object({ orderId: Type.String(), clientSecret: Type.String() });

export async function registerCheckoutRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();

  api.post(
    "/api/checkout",
    {
      schema: {
        tags: ["checkout"],
        body: CheckoutBody,
        response: { 201: CheckoutResponse, 404: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request, reply) => {
      // gdprConsent isn't read here — Type.Literal(true) above already means
      // Fastify rejected the request before this handler ran if it was false/missing.
      const { sessionIds, email, shippingAddress } = request.body;

      const sessions = await prisma.session.findMany({
        where: { id: { in: sessionIds } },
        include: { characters: true },
      });
      if (sessions.length !== sessionIds.length) {
        return reply.code(404).send({ message: "One or more sessions were not found." });
      }
      for (const session of sessions) {
        if (session.characters.some((c) => !c.rawKey)) {
          return reply
            .code(409)
            .send({ message: `Session ${session.id} has a character with no uploaded photo.` });
        }
      }

      // Checkout is activity: slide each session's expiry forward, so GDPR
      // Pathway 1 can't delete the raw photos between this order being created
      // (awaiting_payment, which P1 treats as unordered) and the payment
      // landing. See src/gdpr/schedule.ts.
      await prisma.session.updateMany({ where: { id: { in: sessionIds } }, data: sessionActivity() });

      const storyIds = sessions.map((s) => s.storyId);
      const { totalCents, currency } = computeTotalCents(storyIds);

      // Silent account creation — no sign-up wall. Idempotent by email, so a
      // repeat buyer reuses their account and a first-timer gets one they can
      // later activate from the post-checkout email. Never overwrites a
      // password that already exists.
      const customer = await findOrCreateCustomerByEmail(email);

      const paymentIntent = await stripe.paymentIntents.create({
        amount: totalCents,
        currency,
        receipt_email: email,
        metadata: { sessionIds: sessionIds.join(",") },
      });

      const order = await prisma.order.create({
        data: {
          customerId: customer.id,
          email,
          shippingName: shippingAddress.name,
          shippingLine1: shippingAddress.line1,
          shippingLine2: shippingAddress.line2 ?? null,
          shippingCity: shippingAddress.city,
          shippingPostalCode: shippingAddress.postalCode,
          shippingCountry: shippingAddress.country,
          totalCents,
          currency,
          // gdprConsent is Type.Literal(true) in the schema above — reaching
          // this line already proves consent, so we just timestamp it.
          gdprConsentAt: new Date(),
          stripePaymentIntentId: paymentIntent.id,
          items: {
            create: sessions.map((session) => {
              const book = getBook(session.storyId);
              return {
                sessionId: session.id,
                storyId: session.storyId,
                bookTitle: book.title,
                priceCents: book.priceCents,
                // Prisma's Json input type wants a bare index-signature object,
                // not our named array type — this is a type-system-only cast,
                // the runtime value is unchanged.
                configSnapshot: buildConfigSnapshot(session.characters) as unknown as Prisma.InputJsonValue,
                printPageKeys: buildPrintPageKeys(session.id, book) as unknown as Prisma.InputJsonValue,
              };
            }),
          },
        },
      });

      reply.code(201);
      return { orderId: order.id, clientSecret: paymentIntent.client_secret! };
    },
  );
}
