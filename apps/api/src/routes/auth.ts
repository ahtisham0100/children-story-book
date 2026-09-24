import type { FastifyInstance } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { env } from "../env";
import { assessPasswordStrength } from "../auth/password";
import { SESSION_COOKIE, sessionCookieOptions } from "../auth/session";
import {
  consumeToken,
  createSession,
  destroySession,
  findCustomerByEmail,
  issueToken,
  setCustomerPassword,
  verifyCredentials,
} from "../auth/service";
import { getCustomerFromRequest } from "../auth/guard";
import { sendMagicLinkEmail, sendPasswordResetEmail } from "../email/authEmails";
import { rateLimitPreHandler } from "../rateLimit";

const Ok = Type.Object({ ok: Type.Boolean() });
const ErrorResponse = Type.Object({ message: Type.String() });
const EmailBody = Type.Object({ email: Type.String({ format: "email" }) });

// Anti-enumeration: the "request a link" endpoints ALWAYS report success, so an
// attacker can't tell a registered email from an unregistered one by the reply.
const GENERIC_LINK_SENT = { ok: true as const };

export async function registerAuthRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();

  // Per IP AND per email (see src/rateLimit.ts). Counted identically whether or
  // not the account exists, so a 429 reveals nothing the 200 does not.
  // Each endpoint gets its own counters.
  const authLinkLimit = () =>
    rateLimitPreHandler(app, {
      ipMax: env.RL_AUTH_LINK_IP_MAX,
      emailMax: env.RL_AUTH_LINK_EMAIL_MAX,
      windowMinutes: env.RL_AUTH_LINK_WINDOW_MIN,
    });

  // --- Magic-link login (passwordless) -----------------------------------
  api.post(
    "/api/auth/magic-link/request",
    {
      schema: { tags: ["auth"], body: EmailBody, response: { 200: Ok, 429: ErrorResponse } },
      preHandler: authLinkLimit(),
    },
    async (request) => {
      const customer = await findCustomerByEmail(request.body.email);
      if (customer) {
        const raw = await issueToken(customer.id, "magic_link");
        await sendMagicLinkEmail(customer.email, raw);
      }
      return GENERIC_LINK_SENT;
    },
  );

  // Clicked from the email. Consumes the token, opens a session, then bounces to
  // the frontend — GET (not POST) because it's a link, and it sets the cookie on
  // the API origin before redirecting so /account can immediately read /me.
  api.get(
    "/api/auth/magic-link/verify",
    { schema: { tags: ["auth"], querystring: Type.Object({ token: Type.String() }) } },
    async (request, reply) => {
      const customer = await consumeToken(request.query.token, ["magic_link"]);
      if (!customer) {
        return reply.redirect(`${env.APP_BASE_URL}/login?error=link_expired`);
      }
      const raw = await createSession(customer.id);
      reply.setCookie(SESSION_COOKIE, raw, sessionCookieOptions());
      return reply.redirect(`${env.APP_BASE_URL}/account`);
    },
  );

  // --- Password login ----------------------------------------------------
  api.post(
    "/api/auth/login",
    {
      schema: {
        tags: ["auth"],
        body: Type.Object({ email: Type.String({ format: "email" }), password: Type.String() }),
        response: { 200: Ok, 401: ErrorResponse, 429: ErrorResponse },
      },
      // Brute-force brake: per IP, plus per email so one account can't be
      // guessed at from many IPs. Trade-off: the per-email limit also lets a
      // stranger lock a real customer out of PASSWORD login for one window
      // (magic-link login still works). Tune RL_LOGIN_EMAIL_MAX accordingly.
      preHandler: rateLimitPreHandler(app, {
        ipMax: env.RL_LOGIN_IP_MAX,
        emailMax: env.RL_LOGIN_EMAIL_MAX,
        windowMinutes: env.RL_LOGIN_WINDOW_MIN,
      }),
    },
    async (request, reply) => {
      const customer = await verifyCredentials(request.body.email, request.body.password);
      if (!customer) {
        return reply.code(401).send({ message: "Invalid email or password." });
      }
      const raw = await createSession(customer.id);
      reply.setCookie(SESSION_COOKIE, raw, sessionCookieOptions());
      return { ok: true };
    },
  );

  // --- Set / reset password (activation + reset share this) --------------
  api.post(
    "/api/auth/set-password",
    {
      schema: {
        tags: ["auth"],
        body: Type.Object({ token: Type.String(), password: Type.String() }),
        response: { 200: Ok, 400: ErrorResponse },
      },
    },
    async (request, reply) => {
      const { token, password } = request.body;
      // Server-side gate — the client meter is a convenience, this is the rule.
      if (!assessPasswordStrength(password).acceptable) {
        return reply.code(400).send({
          message: "Password too weak — use at least 8 characters with a mix of letters and numbers.",
        });
      }
      const customer = await consumeToken(token, ["activation", "password_reset"]);
      if (!customer) {
        return reply.code(400).send({ message: "This link is invalid or has expired." });
      }
      await setCustomerPassword(customer.id, password);
      // Log them straight in — activating an account shouldn't then demand a login.
      const raw = await createSession(customer.id);
      reply.setCookie(SESSION_COOKIE, raw, sessionCookieOptions());
      return { ok: true };
    },
  );

  api.post(
    "/api/auth/password-reset/request",
    {
      schema: { tags: ["auth"], body: EmailBody, response: { 200: Ok, 429: ErrorResponse } },
      preHandler: authLinkLimit(),
    },
    async (request) => {
      const customer = await findCustomerByEmail(request.body.email);
      if (customer) {
        const raw = await issueToken(customer.id, "password_reset");
        await sendPasswordResetEmail(customer.email, raw);
      }
      return GENERIC_LINK_SENT;
    },
  );

  // --- Session introspection + logout ------------------------------------
  api.get(
    "/api/auth/me",
    {
      schema: {
        tags: ["auth"],
        response: {
          200: Type.Object({ id: Type.String(), email: Type.String(), hasPassword: Type.Boolean() }),
          401: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const customer = await getCustomerFromRequest(request);
      if (!customer) return reply.code(401).send({ message: "Not authenticated." });
      return { id: customer.id, email: customer.email, hasPassword: customer.passwordHash !== null };
    },
  );

  api.post(
    "/api/auth/logout",
    { schema: { tags: ["auth"], response: { 200: Ok } } },
    async (request, reply) => {
      const raw = request.cookies?.[SESSION_COOKIE];
      if (raw) await destroySession(raw);
      reply.clearCookie(SESSION_COOKIE, sessionCookieOptions(0));
      return { ok: true };
    },
  );
}
