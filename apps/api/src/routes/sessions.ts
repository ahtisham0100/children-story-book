import type { FastifyInstance } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { prisma } from "../db";
import { env } from "../env";
import { createUploadUrl, createDownloadUrl, rawObjectKey, objectExists, isIssuedRawObjectKey } from "../storage";
import { getPipelineQueue } from "../queue";
import { subscribeStatus } from "../status-events";
import { getBook, bookPages, pageObjectKey } from "../pipeline/catalog";
import { rateLimitPreHandler } from "../rateLimit";
import { newSessionExpiry, sessionActivity } from "../sessionExpiry";
import { filesDeletedMessage } from "../gdpr/schedule";

const ErrorResponse = Type.Object({ message: Type.String() });

const CreateSessionBody = Type.Object({
  locale: Type.Optional(Type.String({ default: "fr" })),
  storyId: Type.String({ minLength: 1 }),
  characters: Type.Array(
    Type.Object({
      slot: Type.String({ minLength: 1 }),
      childName: Type.String({ minLength: 1, maxLength: 100 }),
    }),
    { minItems: 1 },
  ),
});
const CreateSessionResponse = Type.Object({
  sessionId: Type.String(),
  characters: Type.Array(
    Type.Object({ characterId: Type.String(), slot: Type.String(), childName: Type.String() }),
  ),
});

const SessionParams = Type.Object({ id: Type.String({ format: "uuid" }) });
const CharacterParams = Type.Object({
  id: Type.String({ format: "uuid" }),
  characterId: Type.String({ format: "uuid" }),
});

const UploadUrlBody = Type.Object({
  contentType: Type.Union([
    Type.Literal("image/jpeg"),
    Type.Literal("image/png"),
    Type.Literal("image/webp"),
  ]),
});
const UploadUrlResponse = Type.Object({
  uploadUrl: Type.String(),
  objectKey: Type.String(),
});

const UploadConfirmBody = Type.Object({
  objectKey: Type.String({ minLength: 1 }),
  // Which render to auto-enqueue once every character has uploaded. Defaults
  // to "preview" (the real product's normal flow: show a couple of pages
  // free, render the rest via POST .../render-full after purchase). A caller
  // that already knows it wants the whole book right away (e.g. the
  // homepage demo, which shows every page at once) can pass "full" here
  // instead of enqueueing a preview job and then immediately enqueueing a
  // second full one behind it — two sequential BullMQ jobs (WORKER_CONCURRENCY
  // defaults to 1) took roughly twice as long as one job rendering every page
  // concurrently.
  mode: Type.Optional(Type.Union([Type.Literal("preview"), Type.Literal("full")])),
});
const UploadConfirmResponse = Type.Object({ ok: Type.Literal(true), allUploaded: Type.Boolean() });

const CharacterView = Type.Object({
  id: Type.String(),
  slot: Type.String(),
  childName: Type.String(),
  rawKey: Type.Union([Type.String(), Type.Null()]),
});
const RenderFullResponse = Type.Object({
  ok: Type.Literal(true),
  jobId: Type.Union([Type.String(), Type.Null()]),
});

const PageView = Type.Object({
  id: Type.String(),
  caption: Type.Union([Type.String(), Type.Null()]),
  preview: Type.Boolean(),
  ready: Type.Boolean(),
  url: Type.Union([Type.String(), Type.Null()]),
});
const PagesResponse = Type.Object({
  sessionId: Type.String(),
  storyId: Type.String(),
  title: Type.String(),
  pages: Type.Array(PageView),
});

const SessionView = Type.Object({
  id: Type.String(),
  locale: Type.String(),
  storyId: Type.String(),
  status: Type.String(),
  createdAt: Type.String(),
  previewKey: Type.Union([Type.String(), Type.Null()]),
  characters: Type.Array(CharacterView),
});

export async function registerSessionRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();

  api.post(
    "/api/sessions",
    {
      schema: {
        tags: ["sessions"],
        body: CreateSessionBody,
        response: { 201: CreateSessionResponse, 429: ErrorResponse },
      },
      // Each session can go on to trigger paid renders, so creation is capped per IP.
      preHandler: rateLimitPreHandler(app, {
        ipMax: env.RL_SESSION_CREATE_IP_MAX,
        windowMinutes: env.RL_SESSION_CREATE_WINDOW_MIN,
      }),
    },
    async (request, reply) => {
      const { locale, storyId, characters } = request.body;
      const session = await prisma.session.create({
        data: {
          locale: locale ?? "fr",
          storyId,
          ...newSessionExpiry(),
          characters: { create: characters.map((c) => ({ slot: c.slot, childName: c.childName })) },
        },
        include: { characters: true },
      });
      reply.code(201);
      return {
        sessionId: session.id,
        characters: session.characters.map((c) => ({
          characterId: c.id,
          slot: c.slot,
          childName: c.childName,
        })),
      };
    },
  );

  api.get(
    "/api/sessions/:id",
    {
      schema: {
        tags: ["sessions"],
        params: SessionParams,
        response: { 200: SessionView, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      const session = await prisma.session.findUnique({
        where: { id: request.params.id },
        include: { characters: true },
      });
      if (!session) {
        return reply.code(404).send({ message: "Session not found" });
      }
      return { ...session, createdAt: session.createdAt.toISOString() };
    },
  );

  api.post(
    "/api/sessions/:id/characters/:characterId/upload-url",
    {
      schema: {
        tags: ["sessions"],
        params: CharacterParams,
        body: UploadUrlBody,
        response: { 200: UploadUrlResponse, 404: ErrorResponse, 410: ErrorResponse },
      },
    },
    async (request, reply) => {
      const { id, characterId } = request.params;
      const { contentType } = request.body;

      const character = await prisma.character.findFirst({
        where: { id: characterId, sessionId: id },
        include: { session: { select: { rawDeletedAt: true, processedDeletedAt: true } } },
      });
      if (!character) {
        return reply.code(404).send({ message: "Character not found" });
      }
      const deleted = filesDeletedMessage(character.session);
      if (deleted) return reply.code(410).send({ message: deleted });

      const objectKey = rawObjectKey(id, characterId, contentType);
      const uploadUrl = await createUploadUrl(objectKey, contentType, 60);

      return { uploadUrl, objectKey };
    },
  );

  api.post(
    "/api/sessions/:id/characters/:characterId/upload-confirm",
    {
      schema: {
        tags: ["sessions"],
        params: CharacterParams,
        body: UploadConfirmBody,
        response: { 200: UploadConfirmResponse, 400: ErrorResponse, 404: ErrorResponse, 410: ErrorResponse },
      },
    },
    async (request, reply) => {
      const { id, characterId } = request.params;
      const { objectKey, mode } = request.body;

      const character = await prisma.character.findFirst({
        where: { id: characterId, sessionId: id },
        include: { session: { select: { rawDeletedAt: true, processedDeletedAt: true } } },
      });
      if (!character) {
        return reply.code(404).send({ message: "Character not found" });
      }
      const deleted = filesDeletedMessage(character.session);
      if (deleted) return reply.code(410).send({ message: deleted });

      // Only a key we issued for THIS character (see isIssuedRawObjectKey), and
      // only once the upload has actually landed in R2.
      if (!isIssuedRawObjectKey(id, characterId, objectKey)) {
        return reply.code(400).send({ message: "Invalid objectKey for this character." });
      }
      if (!(await objectExists(objectKey))) {
        return reply.code(400).send({ message: "Upload not found — PUT the photo to the upload URL first." });
      }

      await prisma.character.update({ where: { id: characterId }, data: { rawKey: objectKey } });
      // Activity slides the session's expiry forward (see sessionExpiry.ts).
      await prisma.session.update({ where: { id }, data: sessionActivity() });

      const remaining = await prisma.character.count({ where: { sessionId: id, rawKey: null } });
      const allUploaded = remaining === 0;

      if (allUploaded) {
        await prisma.session.update({ where: { id }, data: { status: "uploaded" } });

        if (env.REDIS_URL) {
          // Default "preview": only the preview pages are rendered up front,
          // the rest of the book is rendered by POST /render-full once it's
          // bought. A caller can pass mode:"full" to skip straight to
          // rendering everything in this one job instead.
          //
          // jobId IS the race fix: two characters' upload-confirm requests
          // landing close together can both observe "0 characters remaining"
          // after both DB updates commit (check-then-act, no transaction) and
          // both reach this line. A plain queue.add() would enqueue two jobs
          // for the same session — harmless today only because
          // WORKER_CONCURRENCY=1 forces them to run one after another (the
          // second finds every page already rendered and no-ops), but a real
          // double-render the moment that concurrency is raised. Giving both
          // calls the SAME deterministic jobId makes BullMQ itself the dedup:
          // the second add() for an id that's already waiting/active is a
          // no-op. Scoped to `${id}__${mode}`, not just `id`, so a genuine
          // preview-then-full sequence isn't accidentally deduped against
          // itself.
          const job = await getPipelineQueue().add(
            "process",
            { sessionId: id, mode: mode ?? "preview" },
            { attempts: 1, removeOnComplete: true, removeOnFail: false, jobId: `${id}__${mode ?? "preview"}` },
          );
          // Paired with worker.ts's "job picked up" log — the gap between these
          // two timestamps is genuine BullMQ queue wait (job sitting unconsumed),
          // as distinct from work that happens after pickup.
          console.log(`[sessions] session ${id}: enqueued job ${job.id ?? "-"} (mode: ${mode ?? "preview"})`);
          await prisma.character.updateMany({ where: { sessionId: id }, data: { jobId: job.id } });
        } else {
          request.log.warn("REDIS_URL not configured — skipping pipeline enqueue.");
        }
      }

      return { ok: true as const, allUploaded };
    },
  );

  api.post(
    "/api/sessions/:id/render-full",
    {
      schema: {
        tags: ["sessions"],
        params: SessionParams,
        response: { 202: RenderFullResponse, 404: ErrorResponse, 409: ErrorResponse, 410: ErrorResponse, 503: ErrorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const session = await prisma.session.findUnique({ where: { id }, include: { characters: true } });
      if (!session) {
        return reply.code(404).send({ message: "Session not found" });
      }
      const deleted = filesDeletedMessage(session);
      if (deleted) return reply.code(410).send({ message: deleted });
      if (session.characters.some((c) => !c.rawKey)) {
        return reply.code(409).send({ message: "Every character needs an uploaded photo first." });
      }
      if (!env.REDIS_URL) {
        return reply.code(503).send({ message: "Rendering is not configured yet (REDIS_URL missing)." });
      }
      await prisma.session.update({ where: { id }, data: sessionActivity() });

      // Pages already rendered for the preview are reused, not re-paid for —
      // the worker skips any page that already exists in storage. Same jobId
      // dedup as upload-confirm above: a double-click or client retry on this
      // endpoint gets deduped by BullMQ instead of enqueueing a second "full"
      // job for the same session.
      const job = await getPipelineQueue().add(
        "process",
        { sessionId: id, mode: "full" },
        { attempts: 1, removeOnComplete: true, removeOnFail: false, jobId: `${id}__full` },
      );
      reply.code(202);
      return { ok: true as const, jobId: job.id ?? null };
    },
  );

  api.get(
    "/api/sessions/:id/pages",
    {
      schema: {
        tags: ["sessions"],
        params: SessionParams,
        response: { 200: PagesResponse, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const session = await prisma.session.findUnique({ where: { id } });
      if (!session) {
        return reply.code(404).send({ message: "Session not found" });
      }

      let book;
      try {
        book = getBook(session.storyId);
      } catch {
        return reply.code(404).send({ message: `No book configured for "${session.storyId}".` });
      }

      // Pages live at a predictable key, so what's ready is derived from storage
      // rather than tracked separately in the database.
      const pages = await Promise.all(
        bookPages(book).map(async (page) => {
          const key = pageObjectKey(id, page.id);
          const ready = await objectExists(key);
          return {
            id: page.id,
            caption: page.caption ?? null,
            preview: page.preview ?? false,
            ready,
            url: ready ? await createDownloadUrl(key, 3600) : null,
          };
        }),
      );

      return { sessionId: id, storyId: session.storyId, title: book.title, pages };
    },
  );

  api.get(
    "/api/sessions/:id/status",
    {
      schema: {
        tags: ["sessions"],
        params: SessionParams,
        response: { 404: ErrorResponse, 503: ErrorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const session = await prisma.session.findUnique({ where: { id } });
      if (!session) {
        return reply.code(404).send({ message: "Session not found" });
      }
      if (!env.REDIS_URL) {
        return reply
          .code(503)
          .send({ message: "Live status streaming is not configured yet (REDIS_URL missing)." });
      }

      // @fastify/cors stages Access-Control-Allow-Origin via an onRequest hook
      // using reply.header(), which only ever gets flushed by Fastify's OWN
      // reply.send() pipeline. reply.hijack() + reply.raw.writeHead() below
      // bypasses that pipeline entirely and writes straight to the raw Node
      // response — so the CORS header was silently never sent on this route,
      // even though every other endpoint has it. A cross-origin browser
      // client (the homepage on a different port) then fails CORS validation
      // and EventSource goes straight to a terminal CLOSED state with no
      // retry — confirmed live: the exact same request via a same-origin
      // Node fetch (not subject to CORS) received real events fine, proving
      // the server side was always working and only the browser was ever
      // rejecting it. Must set the header explicitly here.
      const origin = request.headers.origin;
      const allowedOrigin = origin && env.CORS_ORIGIN.includes(origin) ? origin : undefined;

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...(allowedOrigin ? { "Access-Control-Allow-Origin": allowedOrigin, Vary: "Origin" } : {}),
      });

      const send = (eventName: string, data: unknown) => {
        reply.raw.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        void unsubscribe();
        reply.raw.end();
      };

      const unsubscribe = subscribeStatus(id, (event) => {
        if (event.type === "status") {
          send("status", { step: event.step, slot: event.slot, page: event.page, stage: event.stage, message: event.message });
        } else if (event.type === "done") {
          send("done", { previewUrl: event.previewUrl });
          cleanup();
        } else if (event.type === "error") {
          send("error", { step: event.step, slot: event.slot, page: event.page, message: event.message });
          cleanup();
        }
      });

      request.raw.on("close", cleanup);
    },
  );
}
