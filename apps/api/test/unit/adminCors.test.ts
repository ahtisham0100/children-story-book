import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import cors from "@fastify/cors";

// The admin CSRF defence is "mutations need X-Admin-Request". That only holds
// if a cross-site page can't get a browser to send that header, i.e. the CORS
// preflight for it must FAIL for any origin not in CORS_ORIGIN. This uses the
// app's real CORS options (src/cors.ts).
const env = vi.hoisted(() => ({ CORS_ORIGIN: ["http://localhost:3000", "https://shop.example"] }));
vi.mock("../../src/env", () => ({ env }));

import { corsOptions } from "../../src/cors";

async function preflight(origin: string) {
  const app = Fastify();
  await app.register(cors, corsOptions());
  app.post("/api/admin/deletions/sweep", async () => ({ ok: true }));
  const res = await app.inject({
    method: "OPTIONS",
    url: "/api/admin/deletions/sweep",
    headers: {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,x-admin-request",
    },
  });
  await app.close();
  return res;
}

describe("CORS for admin requests", () => {
  it("does not allow a foreign origin to send X-Admin-Request (preflight gets no allow-origin)", async () => {
    const res = await preflight("https://evil.example");
    // No Access-Control-Allow-Origin = the browser refuses the preflight and
    // never sends the real request. (@fastify/cors still emits
    // allow-credentials: true, which is meaningless without an allowed origin.)
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("does not allow a look-alike origin", async () => {
    for (const origin of ["http://localhost:3000.evil.example", "https://shop.example.evil.example", "null"]) {
      const res = await preflight(origin);
      expect(res.headers["access-control-allow-origin"], origin).toBeUndefined();
    }
  });

  it("allows the configured web origin, with credentials and the admin header", async () => {
    const res = await preflight("http://localhost:3000");
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(String(res.headers["access-control-allow-headers"]).toLowerCase()).toContain("x-admin-request");
  });

  it("never answers with a wildcard origin (credentials require an exact origin)", async () => {
    const res = await preflight("https://shop.example");
    expect(res.headers["access-control-allow-origin"]).toBe("https://shop.example");
    expect(res.headers["access-control-allow-origin"]).not.toBe("*");
  });
});
