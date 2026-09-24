// Seeds data for every /admin screen: orders in each interesting status, R2
// files for the storage and deletion screens, and a FAILED fulfilment job with
// the "Gelato submission has an unknown outcome" error for the failed-job
// inspector and the reconcile form.
//
//   npx tsx test/seed-admin-demo.mts            # seed (prints ids and what to try)
//   npx tsx test/seed-admin-demo.mts --clean    # remove everything seeded (rows, R2 objects, queue jobs)
//
// Everything is recognisable: order emails start with "admin-test+", session
// ids with "admin-test-". Uses DATABASE_URL, R2_* and REDIS_URL from
// apps/api/.env, so it writes to whichever database, bucket and Redis those
// point at. DeletionAuditLog and AdminActionLog rows are never removed: they're
// the record of what you did while testing.
//
// SAFETY: the failed order has a real (tiny) print PDF, no page keys (so a
// retry never renders), confirmationEmailSentAt set (no email) and no customer
// (no activation email). Reconciling it with "record the Gelato order id" is
// safe. "Clear the marker" makes the retry SUBMIT TO GELATO for real if
// GELATO_API_KEY is set, so only use that path on it without a key configured.
import { randomUUID } from "node:crypto";
import { UnrecoverableError, Worker } from "bullmq";
import type { Prisma } from "@prisma/client";
import { prisma } from "../src/db";
import { env, missingDay1Config } from "../src/env";
import { deleteObjects, listObjectKeys, putObject } from "../src/storage";
import { createRedisConnection } from "../src/redis";
import { enqueueFulfillment, FULFILLMENT_QUEUE_NAME, getFulfillmentQueue } from "../src/queue";
import { runFulfillment } from "../src/fulfillment";

const SESSION_PREFIX = "admin-test-";
const EMAIL_PREFIX = "admin-test+";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const PDF = Buffer.from("%PDF-1.4\n% admin-test placeholder\n%%EOF\n");

interface OrderSpec {
  label: string;
  status: string;
  try: string;
  files: boolean;
  gelatoOrderId?: string;
  gelatoSubmitStartedAt?: Date;
  deliveredAt?: Date;
  /** Status history, oldest first (source, status, hours ago). */
  events: [string, string, number][];
}

async function seedOrder(spec: OrderSpec, n: number, now: Date) {
  const sessionId = `${SESSION_PREFIX}${randomUUID()}`;
  const characterId = randomUUID();
  const orderId = randomUUID();
  const itemId = randomUUID();
  const rawKey = `sessions/${sessionId}/characters/${characterId}/raw.jpg`;
  const pageKeys = [`sessions/${sessionId}/pages/p1.png`, `sessions/${sessionId}/pages/p2.png`];
  const pdfKey = `orders/${orderId}/items/${itemId}/print.pdf`;
  const createdAt = new Date(now.getTime() - (spec.events[0]?.[2] ?? 1) * HOUR - HOUR);

  await prisma.session.create({
    data: {
      id: sessionId,
      storyId: "admin-test-book",
      status: "done",
      createdAt,
      expiresAt: new Date(now.getTime() + 48 * HOUR),
      previewKey: spec.files ? pageKeys[0] : null,
    },
  });
  await prisma.character.create({
    data: { id: characterId, sessionId, slot: "child_1", childName: "Admin Test", rawKey: spec.files ? rawKey : null },
  });
  if (spec.files) {
    await putObject(rawKey, PNG, "image/jpeg");
    for (const key of pageKeys) await putObject(key, PNG, "image/png");
    await putObject(pdfKey, PDF, "application/pdf");
  }

  await prisma.order.create({
    data: {
      id: orderId,
      email: `${EMAIL_PREFIX}${n}-${spec.label}@example.com`,
      shippingName: `Admin Test ${n}`,
      shippingLine1: `${n} Test Street`,
      shippingCity: "Testville",
      shippingPostalCode: "00000",
      shippingCountry: "FR",
      status: spec.status,
      totalCents: 3999,
      currency: "eur",
      gdprConsentAt: createdAt,
      createdAt,
      gelatoOrderId: spec.gelatoOrderId ?? null,
      gelatoSubmitStartedAt: spec.gelatoSubmitStartedAt ?? null,
      deliveredAt: spec.deliveredAt ?? null,
      // No emails from a retry of seeded data.
      confirmationEmailSentAt: spec.status === "awaiting_payment" ? null : createdAt,
      items: {
        create: {
          id: itemId,
          sessionId,
          storyId: "admin-test-book",
          bookTitle: "Admin test book",
          priceCents: 3999,
          configSnapshot: [{ slot: "child_1", childName: "Admin Test", rawKey }] as Prisma.InputJsonValue,
          // Empty: fulfilment's render step then has nothing to do on a retry.
          printPageKeys: [] as Prisma.InputJsonValue,
          printPdfKey: spec.files ? pdfKey : null,
        },
      },
    },
  });
  for (const [source, status, hoursAgo] of spec.events) {
    await prisma.orderStatusEvent.create({
      data: { orderId, status, source, createdAt: new Date(now.getTime() - hoursAgo * HOUR) },
    });
  }
  return { orderId, sessionId };
}

/**
 * Puts the failed order's fulfilment job into BullMQ's failed set by running
 * the REAL fulfilment against it, which stops with the real "unknown outcome"
 * UnrecoverableError. If a worker (npm run dev / worker) picks the job up
 * first, it fails the same way; either is fine.
 */
async function createFailedFulfillmentJob(orderId: string) {
  const queue = getFulfillmentQueue();
  const busy = await queue.getJobCounts("waiting", "active", "delayed", "prioritized");
  if (Object.values(busy).some((count) => count > 0)) {
    console.warn(
      "  ! The fulfillment queue already has waiting/active jobs, so the failed demo job was NOT created " +
        "(taking the next job could grab a real order). Re-run the seed once the queue is idle.",
    );
    return false;
  }
  await enqueueFulfillment(orderId);

  // Give a running worker a moment to take it.
  for (let i = 0; i < 6; i++) {
    const job = await queue.getJob(orderId);
    if (job && (await job.isFailed())) return true;
    if (job && (await job.isActive())) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    break;
  }

  const worker = new Worker(FULFILLMENT_QUEUE_NAME, null, { connection: createRedisConnection(), autorun: false });
  const token = randomUUID();
  try {
    const job = await worker.getNextJob(token);
    if (!job) return (await (await queue.getJob(orderId))?.isFailed()) ?? false;
    if (job.id !== orderId) {
      throw new Error(`Took job ${job.id}, not the seeded one; its lock expires in 30s and a worker will pick it up again.`);
    }
    try {
      await runFulfillment(orderId);
      console.warn("  ! Fulfilment unexpectedly succeeded for the seeded failed order.");
    } catch (error) {
      await job.moveToFailed(error instanceof Error ? error : new UnrecoverableError(String(error)), token, false);
    }
  } finally {
    await worker.close();
  }
  return (await (await queue.getJob(orderId))?.isFailed()) ?? false;
}

async function seed() {
  const now = new Date();
  const specs: OrderSpec[] = [
    {
      label: "awaiting-payment",
      status: "awaiting_payment",
      files: false,
      try: "Orders: allowed transition is only 'cancelled'.",
      events: [],
    },
    {
      label: "paid",
      status: "paid",
      files: true,
      try: "Deletions: dry run shows a 'held' warning; a real delete needs force.",
      events: [["stripe_webhook", "paid", 5]],
    },
    {
      label: "submitted",
      status: "submitted_to_print",
      files: true,
      gelatoOrderId: `admin-test-gelato-${randomUUID().slice(0, 8)}`,
      gelatoSubmitStartedAt: new Date(now.getTime() - 20 * HOUR),
      try: "Orders: change status to processing/dispatched/delivered; 'Sync from Gelato' (502 with a fake id, or 503 without a key).",
      events: [
        ["stripe_webhook", "paid", 24],
        ["system", "pdf_ready", 22],
        ["system", "submitted_to_print", 20],
      ],
    },
    {
      label: "dispatched",
      status: "dispatched",
      files: true,
      gelatoOrderId: `admin-test-gelato-${randomUUID().slice(0, 8)}`,
      gelatoSubmitStartedAt: new Date(now.getTime() - 70 * HOUR),
      try: "Orders: mark delivered (sets deliveredAt, starts the deletion clock).",
      events: [
        ["stripe_webhook", "paid", 72],
        ["system", "submitted_to_print", 70],
        ["gelato_webhook", "dispatched", 30],
      ],
    },
    {
      label: "delivered",
      status: "delivered",
      files: true,
      gelatoOrderId: `admin-test-gelato-${randomUUID().slice(0, 8)}`,
      gelatoSubmitStartedAt: new Date(now.getTime() - 100 * HOUR),
      deliveredAt: new Date(now.getTime() - 2 * DAY),
      try: "Deletions: in 'P2 raw' (overdue) and 'P2 book files' (due in ~28 days); Storage: file list.",
      events: [
        ["stripe_webhook", "paid", 100],
        ["system", "submitted_to_print", 98],
        ["gelato_webhook", "dispatched", 60],
        ["gelato_webhook", "delivered", 48],
      ],
    },
    {
      label: "failed-unknown-outcome",
      status: "failed",
      files: true,
      gelatoSubmitStartedAt: new Date(now.getTime() - 3 * HOUR),
      try: "Queues > fulfillment > failed: error, stack, Retry (409 until reconciled), reconcile form.",
      events: [
        ["stripe_webhook", "paid", 4],
        ["system", "pdf_ready", 3.5],
        ["system", "failed", 3],
      ],
    },
  ];

  console.log("Seeding admin demo data...\n");
  const rows: string[] = [];
  let failedOrderId = "";
  for (const [i, spec] of specs.entries()) {
    const { orderId, sessionId } = await seedOrder(spec, i + 1, now);
    if (spec.label === "failed-unknown-outcome") failedOrderId = orderId;
    rows.push(`  ${spec.status.padEnd(19)} order ${orderId}\n  ${"".padEnd(19)} session ${sessionId}\n  ${"".padEnd(19)} try: ${spec.try}`);
  }
  console.log(rows.join("\n\n"));

  if (!env.REDIS_URL) {
    console.warn("\n  ! REDIS_URL isn't set: no failed fulfilment job was created.");
  } else {
    const ok = await createFailedFulfillmentJob(failedOrderId);
    console.log(ok ? `\nFailed fulfilment job created: fulfillment / ${failedOrderId}` : "\nFailed fulfilment job NOT created (see above).");
  }

  console.log(
    `\nNext:\n` +
      `  npm run make-admin -- <your email>        # if you aren't an admin yet\n` +
      `  open ${env.APP_BASE_URL.replace(/\/+$/, "")}/admin\n` +
      `  npx tsx test/seed-admin-demo.mts --clean  # when done\n` +
      `\nReconcile the failed order with "It exists at Gelato" and any id (e.g. admin-test-gelato-found).` +
      (env.GELATO_API_KEY ? `\nGELATO_API_KEY is set: do NOT use "clear the marker" on it (it would submit a real Gelato order).` : ""),
  );
}

async function clean() {
  const orders = await prisma.order.findMany({
    where: { email: { startsWith: EMAIL_PREFIX } },
    select: { id: true, items: { select: { id: true, sessionId: true } } },
  });
  const orderIds = orders.map((o) => o.id);
  const sessionRows = await prisma.session.findMany({ where: { id: { startsWith: SESSION_PREFIX } }, select: { id: true } });
  const sessionIds = [...new Set([...sessionRows.map((s) => s.id), ...orders.flatMap((o) => o.items.map((i) => i.sessionId))])];

  const keys = (
    await Promise.all([
      ...sessionIds.map((id) => listObjectKeys(`sessions/${id}/`)),
      ...orders.flatMap((o) => o.items.map((i) => listObjectKeys(`orders/${o.id}/items/${i.id}/`))),
    ])
  ).flat();
  if (keys.length > 0) {
    const result = await deleteObjects(keys);
    if (result.errors.length > 0) throw new Error(`R2 refused ${result.errors.length} deletion(s); rows left in place, re-run --clean.`);
  }

  let jobs = 0;
  if (env.REDIS_URL) {
    const queue = getFulfillmentQueue();
    for (const id of orderIds) {
      const job = await queue.getJob(id);
      if (job && !(await job.isActive())) {
        await job.remove();
        jobs++;
      }
    }
    await queue.close();
  }

  await prisma.orderStatusEvent.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.character.deleteMany({ where: { sessionId: { in: sessionIds } } });
  await prisma.session.deleteMany({ where: { id: { in: sessionIds } } });
  console.log(
    `Cleaned ${orderIds.length} order(s), ${sessionIds.length} session(s), ${keys.length} R2 object(s), ${jobs} queue job(s). Audit rows kept.`,
  );
}

async function main() {
  const missing = missingDay1Config();
  if (missing.length > 0) throw new Error(`Missing config: ${missing.join(", ")} (apps/api/.env).`);
  if (process.argv.includes("--clean")) await clean();
  else await seed();
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    // BullMQ/ioredis connections would otherwise keep the process alive.
    process.exit();
  });
