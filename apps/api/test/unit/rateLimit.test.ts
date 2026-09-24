import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { Type } from "@sinclair/typebox";
import { rateLimitPreHandler, type LimitSpec } from "../../src/rateLimit";

// A minimal app wired exactly the way app.ts + the auth routes wire it:
// plugin registered with global:false, limiter attached as a preHandler after
// body validation.
async function buildTestApp(spec: LimitSpec) {
  const app = Fastify();
  await app.register(rateLimit, { global: false });
  app.post(
    "/limited",
    {
      schema: { body: Type.Object({ email: Type.String() }) },
      preHandler: rateLimitPreHandler(app, spec),
    },
    async () => ({ ok: true }),
  );
  app.post("/ip-only", { preHandler: rateLimitPreHandler(app, { ipMax: 2, windowMinutes: 1 }) }, async () => ({
    ok: true,
  }));
  app.post("/unlimited", async () => ({ ok: true }));
  return app;
}

function post(app: Awaited<ReturnType<typeof buildTestApp>>, url: string, email: string, ip: string) {
  return app.inject({ method: "POST", url, remoteAddress: ip, payload: { email } });
}

describe("rateLimitPreHandler", () => {
  it("blocks one IP after ipMax requests, even across different emails", async () => {
    const app = await buildTestApp({ ipMax: 3, emailMax: 100, windowMinutes: 15 });
    for (let i = 0; i < 3; i += 1) {
      expect((await post(app, "/limited", `user${i}@example.com`, "10.0.0.1")).statusCode).toBe(200);
    }
    const blocked = await post(app, "/limited", "another@example.com", "10.0.0.1");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    // A different IP is unaffected.
    expect((await post(app, "/limited", "another@example.com", "10.0.0.2")).statusCode).toBe(200);
    await app.close();
  });

  it("blocks one email after emailMax requests, even from different IPs", async () => {
    const app = await buildTestApp({ ipMax: 100, emailMax: 2, windowMinutes: 15 });
    expect((await post(app, "/limited", "victim@example.com", "10.0.0.1")).statusCode).toBe(200);
    expect((await post(app, "/limited", "victim@example.com", "10.0.0.2")).statusCode).toBe(200);
    expect((await post(app, "/limited", "victim@example.com", "10.0.0.3")).statusCode).toBe(429);
    // Other emails are unaffected.
    expect((await post(app, "/limited", "other@example.com", "10.0.0.3")).statusCode).toBe(200);
    await app.close();
  });

  it("normalises the email so case/whitespace variants share one bucket", async () => {
    const app = await buildTestApp({ ipMax: 100, emailMax: 2, windowMinutes: 15 });
    expect((await post(app, "/limited", "Victim@Example.com", "10.0.0.1")).statusCode).toBe(200);
    expect((await post(app, "/limited", "  victim@example.com ", "10.0.0.2")).statusCode).toBe(200);
    expect((await post(app, "/limited", "VICTIM@EXAMPLE.COM", "10.0.0.3")).statusCode).toBe(429);
    await app.close();
  });

  it("gives the same 429 body regardless of which limit tripped", async () => {
    const app = await buildTestApp({ ipMax: 1, emailMax: 1, windowMinutes: 15 });
    await post(app, "/limited", "a@example.com", "10.0.0.1");
    const byIp = await post(app, "/limited", "b@example.com", "10.0.0.1");
    const byEmail = await post(app, "/limited", "a@example.com", "10.0.0.9");
    expect(byIp.statusCode).toBe(429);
    expect(byEmail.statusCode).toBe(429);
    expect(byIp.json()).toEqual(byEmail.json());
    await app.close();
  });

  it("supports IP-only limits and leaves routes without a limiter alone", async () => {
    const app = await buildTestApp({ ipMax: 100, emailMax: 100, windowMinutes: 15 });
    expect((await post(app, "/ip-only", "x@example.com", "10.0.0.1")).statusCode).toBe(200);
    expect((await post(app, "/ip-only", "x@example.com", "10.0.0.1")).statusCode).toBe(200);
    expect((await post(app, "/ip-only", "x@example.com", "10.0.0.1")).statusCode).toBe(429);
    for (let i = 0; i < 10; i += 1) {
      expect((await post(app, "/unlimited", "x@example.com", "10.0.0.1")).statusCode).toBe(200);
    }
    await app.close();
  });
});
