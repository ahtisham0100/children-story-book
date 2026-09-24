import type { FastifyCorsOptions } from "@fastify/cors";
import { env } from "./env";

/**
 * CORS for the API (registered in app.ts). credentials:true so the browser
 * sends/stores the session cookie on cross-origin (web:3000 -> api:3001)
 * requests, which requires a concrete origin list, never "*"; that's exactly
 * what env.CORS_ORIGIN is.
 *
 * This is also half of the admin CSRF defence (src/admin/plugin.ts): admin
 * mutations require an X-Admin-Request header, and a browser only sends a
 * custom header cross-origin after a preflight that THIS list must approve.
 * A foreign origin gets no Access-Control-Allow-Origin, so the browser never
 * sends the real request. Tested in test/unit/adminCors.test.ts.
 */
export function corsOptions(): FastifyCorsOptions {
  return { origin: env.CORS_ORIGIN, credentials: true };
}
