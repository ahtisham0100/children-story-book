import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUI from "@fastify/swagger-ui";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { env } from "./env";
import { registerSessionRoutes } from "./routes/sessions";
import { registerCheckoutRoutes } from "./routes/checkout";
import { registerWebhookRoutes } from "./routes/webhooks";
import { registerOrderRoutes } from "./routes/orders";
import { registerAuthRoutes } from "./routes/auth";
import { registerAccountRoutes } from "./routes/account";

export async function buildApp() {
  const app = Fastify({ logger: true, trustProxy: env.TRUST_PROXY }).withTypeProvider<TypeBoxTypeProvider>();

  // credentials:true so the browser sends/stores the session cookie on
  // cross-origin (web:3000 -> api:3001) requests. This requires a concrete
  // origin list, never "*", which is exactly what env.CORS_ORIGIN already is.
  await app.register(cors, { origin: env.CORS_ORIGIN, credentials: true });
  await app.register(cookie);
  // global:false — only the routes that opt in (via src/rateLimit.ts) are limited.
  await app.register(rateLimit, { global: false });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "Children's Book Platform — Prototype API",
        description:
          "Multi-character storybook pipeline: upload a photo of each child, then redraw the " +
          "illustrator's finished page artwork so the drawn characters become those children.",
        version: "0.1.0",
      },
    },
  });
  await app.register(swaggerUI, { routePrefix: "/docs" });

  app.get("/health", async () => ({ ok: true }));

  await registerSessionRoutes(app);
  await registerCheckoutRoutes(app);
  await registerOrderRoutes(app);
  await registerAuthRoutes(app);
  await registerAccountRoutes(app);
  await app.register(registerWebhookRoutes);

  return app;
}
