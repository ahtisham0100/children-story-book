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
import { registerAdminRoutes } from "./admin/plugin";
import { corsOptions } from "./cors";

export async function buildApp() {
  const app = Fastify({ logger: true, trustProxy: env.TRUST_PROXY }).withTypeProvider<TypeBoxTypeProvider>();

  // Origin allowlist with credentials; see src/cors.ts (also part of the admin CSRF defence).
  await app.register(cors, corsOptions());
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
  // Encapsulated plugin: its auth/CSRF/rate-limit hooks apply to /api/admin/* only.
  await app.register(registerAdminRoutes);
  await app.register(registerWebhookRoutes);

  return app;
}
