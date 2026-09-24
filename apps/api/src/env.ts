import dotenv from "dotenv";

dotenv.config();

function readOptional(key: string): string | undefined {
  const value = process.env[key];
  return value && value.length > 0 ? value : undefined;
}

export const env = {
  DATABASE_URL: readOptional("DATABASE_URL"),
  R2_ACCOUNT_ID: readOptional("R2_ACCOUNT_ID"),
  R2_ACCESS_KEY_ID: readOptional("R2_ACCESS_KEY_ID"),
  R2_SECRET_ACCESS_KEY: readOptional("R2_SECRET_ACCESS_KEY"),
  R2_BUCKET_NAME: readOptional("R2_BUCKET_NAME"),
  REDIS_URL: readOptional("REDIS_URL"),
  REPLICATE_API_TOKEN: readOptional("REPLICATE_API_TOKEN"),
  // Second Replicate account, used as an immediate-switch fallback (not a
  // patient retry) the moment the primary account gets rate-limited — see
  // replicate.ts's acquireAccount/fetchReplicateWithAccountFallback. Optional:
  // with this unset, behavior is identical to before (one account, waits out
  // its own rate limit as it always did).
  REPLICATE_API_TOKEN_FALLBACK: readOptional("REPLICATE_API_TOKEN_FALLBACK"),
  // Comma-separated so the homepage (its own origin, :5174) and any future
  // deployed frontend can both be allowed without editing code per-origin.
  CORS_ORIGIN: (readOptional("CORS_ORIGIN") ?? "http://localhost:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  PORT: Number(readOptional("PORT") ?? "3001"),
  // Set to "true" when the API runs behind a reverse proxy / load balancer
  // (Railway, Render, Fly…) so request.ip is the real client from
  // X-Forwarded-For. Without it every request appears to come from the proxy,
  // and the per-IP rate limits below collapse into ONE bucket shared by every
  // visitor. Leave false when the API is reached directly (local dev), or
  // clients could spoof their IP via the header.
  TRUST_PROXY: readOptional("TRUST_PROXY") === "true",

  // Rate limits (see src/rateLimit.ts). Each window is in minutes.
  //  - auth "send me a link" endpoints (magic-link + password-reset request)
  RL_AUTH_LINK_IP_MAX: Number(readOptional("RL_AUTH_LINK_IP_MAX") ?? "10"),
  RL_AUTH_LINK_EMAIL_MAX: Number(readOptional("RL_AUTH_LINK_EMAIL_MAX") ?? "3"),
  RL_AUTH_LINK_WINDOW_MIN: Number(readOptional("RL_AUTH_LINK_WINDOW_MIN") ?? "15"),
  //  - password login (brute-force brake)
  RL_LOGIN_IP_MAX: Number(readOptional("RL_LOGIN_IP_MAX") ?? "20"),
  RL_LOGIN_EMAIL_MAX: Number(readOptional("RL_LOGIN_EMAIL_MAX") ?? "10"),
  RL_LOGIN_WINDOW_MIN: Number(readOptional("RL_LOGIN_WINDOW_MIN") ?? "15"),
  //  - session creation (each session can lead to paid Replicate renders)
  RL_SESSION_CREATE_IP_MAX: Number(readOptional("RL_SESSION_CREATE_IP_MAX") ?? "10"),
  RL_SESSION_CREATE_WINDOW_MIN: Number(readOptional("RL_SESSION_CREATE_WINDOW_MIN") ?? "60"),
  //  - DELETE /api/account/my-data (irreversible; one real call is all anyone needs)
  RL_MY_DATA_IP_MAX: Number(readOptional("RL_MY_DATA_IP_MAX") ?? "5"),
  RL_MY_DATA_WINDOW_MIN: Number(readOptional("RL_MY_DATA_WINDOW_MIN") ?? "60"),
  //  - /api/admin/* (src/admin/plugin.ts): every request per IP, plus a
  //    tighter budget for POSTs. The dashboard polls queues every 5s (about 24
  //    reads a minute per open tab), so the read budget is generous.
  RL_ADMIN_IP_MAX: Number(readOptional("RL_ADMIN_IP_MAX") ?? "600"),
  RL_ADMIN_MUTATION_IP_MAX: Number(readOptional("RL_ADMIN_MUTATION_IP_MAX") ?? "60"),
  RL_ADMIN_WINDOW_MIN: Number(readOptional("RL_ADMIN_WINDOW_MIN") ?? "10"),

  // Which backend runs the swap stage:
  //   replicate (default) — hosted only. A checkout without the local service
  //                         running behaves exactly as before.
  //   local               — local only (services/faceswap). Errors if the
  //                         service is down. For testing the local path alone.
  //   auto                — try local first, fall back to hosted on any failure.
  //                         The production-resilient mode: fast when the box is
  //                         healthy, degrades to slow-but-working when it isn't.
  SWAP_BACKEND: (() => {
    const v = readOptional("SWAP_BACKEND");
    return v === "local" || v === "auto" ? v : "replicate";
  })(),
  SWAP_LOCAL_URL: readOptional("SWAP_LOCAL_URL") ?? "http://127.0.0.1:5175",

  // Which of the 5 pipeline stages (repaint/swap/restore/heal/eyes) actually
  // run in-process vs. as their own BullMQ job on their own queue:
  //   direct (default) — worker.ts calls each stage function itself, in-process.
  //                       Zero extra setup; what the CLI and homepage_local always do.
  //   queued            — each stage is enqueued to its own queue and awaited via
  //                       BullMQ, consumed by dedicated stage-worker.ts processes
  //                       (npm run stage:repaint / stage:swap / ...). Requires those
  //                       processes to be running or a session's render hangs
  //                       waiting for a stage that never gets picked up.
  // See docs/INFRA_AND_PIPELINE_TRACE.md for why this split exists.
  STAGE_EXECUTION: (() => {
    const v = readOptional("STAGE_EXECUTION");
    return v === "queued" ? "queued" : "direct";
  })(),

  // Where the customer-facing frontend lives, used to build the links in
  // activation / magic-link / password-reset emails. Defaults to the local web
  // app; set to the real domain in production.
  APP_BASE_URL: readOptional("APP_BASE_URL") ?? "http://localhost:3000",

  // The API's own public origin, used to build magic-link URLs — the link must
  // hit the API (to set the session cookie) before redirecting to the frontend.
  // Defaults to the local API port.
  API_PUBLIC_URL: readOptional("API_PUBLIC_URL") ?? `http://localhost:${Number(readOptional("PORT") ?? "3001")}`,

  // Session cookie hardening. Defaults suit local dev over http where the API
  // (:3001) and web (:3000) are same-site. In production set
  //   AUTH_COOKIE_SECURE=true
  // and, if the API and frontend are on genuinely cross-site domains,
  //   AUTH_COOKIE_SAMESITE=none   (which REQUIRES secure=true to be honoured).
  AUTH_COOKIE_SECURE: readOptional("AUTH_COOKIE_SECURE") === "true",
  AUTH_COOKIE_SAMESITE: (() => {
    const v = readOptional("AUTH_COOKIE_SAMESITE");
    return v === "none" || v === "strict" ? v : "lax";
  })(),
  // Optional explicit cookie domain (e.g. ".example.com" to share across
  // api. and www.). Unset = host-only cookie, correct for localhost.
  AUTH_COOKIE_DOMAIN: readOptional("AUTH_COOKIE_DOMAIN"),
  AUTH_SESSION_TTL_DAYS: Number(readOptional("AUTH_SESSION_TTL_DAYS") ?? "30"),

  // Personalization-session lifetime in hours, sliding: each upload-confirm or
  // render request pushes it forward (src/sessionExpiry.ts). Drives GDPR
  // deletion Pathway 1 (raw photos deleted 24h after expiry). Not the same
  // thing as AUTH_SESSION_TTL_DAYS, which is the login cookie.
  SESSION_TTL_HOURS: Number(readOptional("SESSION_TTL_HOURS") ?? "72"),

  // GDPR deletion (src/gdpr/). DRY RUN UNLESS EXPLICITLY DISABLED: only the
  // exact string "false" lets the automated sweeper (Pathways 1 & 2) delete
  // anything. A missing, empty or mistyped value stays a dry run, which only
  // writes audit rows saying what WOULD be deleted. The customer's own
  // DELETE /api/account/my-data is not automated and ignores this flag.
  GDPR_DELETION_DRY_RUN: readOptional("GDPR_DELETION_DRY_RUN") !== "false",
  // How often the gdpr queue's repeatable sweep job runs, in minutes.
  GDPR_SWEEP_INTERVAL_MINUTES: Number(readOptional("GDPR_SWEEP_INTERVAL_MINUTES") ?? "60"),
  // Sessions fetched per candidate query, and the most examined per pathway per
  // run (anything beyond waits for the next run, so one run stays bounded).
  GDPR_SWEEP_BATCH_SIZE: Number(readOptional("GDPR_SWEEP_BATCH_SIZE") ?? "50"),
  GDPR_SWEEP_MAX_PER_RUN: Number(readOptional("GDPR_SWEEP_MAX_PER_RUN") ?? "1000"),

  STRIPE_SECRET_KEY: readOptional("STRIPE_SECRET_KEY"),
  STRIPE_WEBHOOK_SECRET: readOptional("STRIPE_WEBHOOK_SECRET"),
  GELATO_API_KEY: readOptional("GELATO_API_KEY"),
  GELATO_PRODUCT_UID: readOptional("GELATO_PRODUCT_UID"),
  // Shared secret Gelato sends in the x-gelato-webhook-secret header. The
  // webhook route FAILS CLOSED: with this unset, every request is rejected
  // (401) — an unauthenticated route that can set any order's status is not a
  // safe default.
  GELATO_WEBHOOK_SECRET: readOptional("GELATO_WEBHOOK_SECRET"),
  // Dev-only escape hatch: accept unsigned Gelato webhooks when no secret is
  // set (e.g. to replay a captured payload locally). Logged loudly at startup.
  GELATO_WEBHOOK_ALLOW_UNSIGNED: readOptional("GELATO_WEBHOOK_ALLOW_UNSIGNED") === "true",
  RESEND_API_KEY: readOptional("RESEND_API_KEY"),
  RESEND_FROM_ADDRESS: readOptional("RESEND_FROM_ADDRESS") ?? "orders@example.com",
  // Print trim size in inches. 8.5x8.5 is a common square kids-book size;
  // override once you've picked a real Gelato product.
  PRINT_TRIM_WIDTH_IN: Number(readOptional("PRINT_TRIM_WIDTH_IN") ?? "8.5"),
  PRINT_TRIM_HEIGHT_IN: Number(readOptional("PRINT_TRIM_HEIGHT_IN") ?? "8.5"),
};

const DAY1_REQUIRED_KEYS = [
  "DATABASE_URL",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
] as const;

export function missingDay1Config(): string[] {
  return DAY1_REQUIRED_KEYS.filter((key) => !env[key]);
}
