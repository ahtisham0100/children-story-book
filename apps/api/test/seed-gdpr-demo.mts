// Seeds sessions in every GDPR-deletion state, with real (tiny) objects in R2,
// so the sweeper and account deletion can be verified end to end: dry run
// first, then for real. See docs/superpowers/specs/2026-09-24-gdpr-deletion-design.md.
//
//   npx tsx test/seed-gdpr-demo.mts                    # seed (prints ids + commands)
//   npx tsx test/seed-gdpr-demo.mts --status           # what's in R2 / DB for each seeded session
//   npx tsx test/seed-gdpr-demo.mts --mark-dispatched  # move the paid order on, so account deletion is allowed
//   npx tsx test/seed-gdpr-demo.mts --clean            # remove everything seeded (rows + R2 objects)
//
// Everything seeded is recognisable: session ids start with "gdpr-test-"
// (objects at sessions/gdpr-test-<uuid>/..., the real layout, so the real
// prefix listing is exercised) and customer emails with "gdpr-test". Uses
// DATABASE_URL and R2_* from apps/api/.env, so it writes to whichever database
// and bucket those point at. DeletionAuditLog rows are never removed by
// --clean: they're the record of what the test deleted.
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../src/db";
import { env, missingDay1Config } from "../src/env";
import { listObjectKeys, deleteObjects, putObject } from "../src/storage";
import { createSession } from "../src/auth/service";

const SESSION_PREFIX = "gdpr-test-";
const EMAIL_PREFIX = "gdpr-test";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// 1x1 transparent PNG, and a minimal PDF-looking file: content doesn't matter,
// only that real objects exist at the real keys.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const PDF = Buffer.from("%PDF-1.4\n% gdpr-test placeholder\n%%EOF\n");

type Label = "expired-unordered" | "delivered-25h" | "delivered-31d" | "paid-undispatched" | "bystander-dispatched";

interface SeedSpec {
  label: Label;
  expected: string;
  owner: "me" | "bystander" | null;
  expiresAt: Date;
  order?: { status: string; deliveredAt: Date | null };
}

async function seedSession(spec: SeedSpec, customers: { me: string; bystander: string }, now: Date) {
  const sessionId = `${SESSION_PREFIX}${randomUUID()}`;
  const characterId = randomUUID();
  const rawKey = `sessions/${sessionId}/characters/${characterId}/raw.jpg`;
  const pageKeys = [`sessions/${sessionId}/pages/p1.png`, `sessions/${sessionId}/pages/p2.png`];

  await prisma.session.create({
    data: {
      id: sessionId,
      storyId: "gdpr-test-book",
      status: "done",
      expiresAt: spec.expiresAt,
      lastActivityAt: new Date(spec.expiresAt.getTime() - env.SESSION_TTL_HOURS * HOUR),
      previewKey: pageKeys[0],
    },
  });
  await prisma.character.create({
    data: { id: characterId, sessionId, slot: "child_1", childName: `${EMAIL_PREFIX} child`, rawKey },
  });

  await putObject(rawKey, PNG, "image/jpeg");
  // An orphan: upload-url issued a .png too but only the .jpg was confirmed.
  // Only the prefix listing can find this one.
  await putObject(`sessions/${sessionId}/characters/${characterId}/raw.png`, PNG, "image/png");
  for (const key of pageKeys) await putObject(key, PNG, "image/png");

  if (spec.order && spec.owner) {
    const orderId = randomUUID();
    const itemId = randomUUID();
    const pdfKey = `orders/${orderId}/items/${itemId}/print.pdf`;
    await prisma.order.create({
      data: {
        id: orderId,
        customerId: customers[spec.owner],
        email: `${EMAIL_PREFIX}-${spec.owner}@example.com`,
        shippingName: `${EMAIL_PREFIX} ${spec.owner}`,
        shippingLine1: "1 Test Street",
        shippingCity: "Testville",
        shippingPostalCode: "00000",
        shippingCountry: "FR",
        status: spec.order.status,
        deliveredAt: spec.order.deliveredAt,
        totalCents: 3999,
        currency: "eur",
        gdprConsentAt: now,
        items: {
          create: {
            id: itemId,
            sessionId,
            storyId: "gdpr-test-book",
            bookTitle: "GDPR test book",
            priceCents: 3999,
            configSnapshot: [{ slot: "child_1", childName: `${EMAIL_PREFIX} child`, rawKey }] as Prisma.InputJsonValue,
            printPageKeys: pageKeys as Prisma.InputJsonValue,
            printPdfKey: pdfKey,
          },
        },
      },
    });
    await putObject(pdfKey, PDF, "application/pdf");
  }
  return sessionId;
}

async function seededSessionIds(): Promise<string[]> {
  const rows = await prisma.session.findMany({
    where: { id: { startsWith: SESSION_PREFIX } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => r.id);
}

/** Every seeded order id, found through the items (orders may be anonymised by then). */
async function seededOrderIds(sessionIds: string[]): Promise<string[]> {
  const items = await prisma.orderItem.findMany({ where: { sessionId: { in: sessionIds } }, select: { orderId: true } });
  return [...new Set(items.map((i) => i.orderId))];
}

async function seed() {
  const now = new Date();
  const tag = randomUUID().slice(0, 8);
  const me = await prisma.customer.create({ data: { email: `${EMAIL_PREFIX}+${tag}@example.com` } });
  const bystander = await prisma.customer.create({ data: { email: `${EMAIL_PREFIX}-bystander+${tag}@example.com` } });
  const customers = { me: me.id, bystander: bystander.id };

  const specs: SeedSpec[] = [
    {
      label: "expired-unordered",
      expected: "P1: raw x2 deleted (orphan .png too), pages KEPT",
      owner: null,
      expiresAt: new Date(now.getTime() - 25 * HOUR),
    },
    {
      label: "delivered-25h",
      expected: "P2a: raw x2 deleted, pages + PDF kept",
      owner: "me",
      expiresAt: new Date(now.getTime() - 60 * DAY),
      order: { status: "delivered", deliveredAt: new Date(now.getTime() - 25 * HOUR) },
    },
    {
      label: "delivered-31d",
      expected: "P2a + P2b: raw x2, pages x2 and the print PDF all deleted",
      owner: "me",
      expiresAt: new Date(now.getTime() - 90 * DAY),
      order: { status: "delivered", deliveredAt: new Date(now.getTime() - 31 * DAY) },
    },
    {
      label: "paid-undispatched",
      expected: "untouched by the sweep; blocks account deletion (409)",
      owner: "me",
      expiresAt: new Date(now.getTime() - 60 * DAY),
      order: { status: "paid", deliveredAt: null },
    },
    {
      label: "bystander-dispatched",
      expected: "another customer's book: untouched by everything",
      owner: "bystander",
      expiresAt: new Date(now.getTime() - 60 * DAY),
      order: { status: "dispatched", deliveredAt: null },
    },
  ];

  const rows: string[] = [];
  const ids: string[] = [];
  for (const spec of specs) {
    const id = await seedSession(spec, customers, now);
    ids.push(id);
    rows.push(`  ${spec.label.padEnd(22)} ${id}\n  ${"".padEnd(22)} expect: ${spec.expected}`);
  }

  // A login for the "me" customer, for the account-deletion calls below.
  // Test account only: this is a session secret for gdpr-test data.
  const cookie = await createSession(me.id);
  const api = env.API_PUBLIC_URL.replace(/\/+$/, "");

  console.log(`\nSeeded 5 sessions (customer ${me.email}, bystander ${bystander.email}):\n`);
  console.log(rows.join("\n"));
  console.log(`\nSession ids for --sessions:\n  ${ids.join(",")}\n`);
  console.log("PowerShell, from apps/api (the API must be running for the last two):");
  console.log(`  npm run gdpr:sweep -- --dry-run --sessions ${ids.join(",")}`);
  console.log(`  $env:GDPR_DELETION_DRY_RUN="false"; npm run gdpr:sweep -- --sessions ${ids.join(",")}; Remove-Item Env:GDPR_DELETION_DRY_RUN`);
  console.log(`  npx tsx test/seed-gdpr-demo.mts --status`);
  console.log(
    `  Invoke-RestMethod -Method Get -Uri ${api}/api/account/my-data -Headers @{ Cookie = "cbp_session=${cookie}" } | ConvertTo-Json -Depth 6`,
  );
  console.log(
    `  Invoke-WebRequest -UseBasicParsing -Method Delete -Uri ${api}/api/account/my-data -Headers @{ Cookie = "cbp_session=${cookie}" } -ContentType "application/json" -Body '{"confirm":"DELETE"}'`,
  );
  console.log("");
}

async function status() {
  const ids = await seededSessionIds();
  const orderIds = await seededOrderIds(ids);
  const orders = await prisma.order.findMany({ where: { id: { in: orderIds } }, include: { items: true } });
  const orphanOrders = orders.filter((o) => o.items.every((i) => !ids.includes(i.sessionId)));

  if (ids.length === 0 && orders.length === 0) return console.log("Nothing seeded.");
  for (const id of ids) {
    const s = await prisma.session.findUnique({ where: { id }, include: { characters: true } });
    const raw = await listObjectKeys(`sessions/${id}/characters/`);
    const pages = await listObjectKeys(`sessions/${id}/pages/`);
    const order = orders.find((o) => o.items.some((i) => i.sessionId === id));
    const item = order?.items.find((i) => i.sessionId === id);
    const pdf = item ? await listObjectKeys(`orders/${order!.id}/items/${item.id}/`) : [];
    console.log(
      `${id}\n  order: ${order ? `${order.status}${order.anonymisedAt ? " (anonymised)" : ""}` : "none"}` +
        `  R2: raw ${raw.length}, pages ${pages.length}, pdf ${pdf.length}` +
        `  DB: rawKey ${s?.characters[0]?.rawKey ? "set" : "null"}, rawDeletedAt ${s?.rawDeletedAt?.toISOString() ?? "-"}, ` +
        `processedDeletedAt ${s?.processedDeletedAt?.toISOString() ?? "-"}`,
    );
  }
  for (const o of orphanOrders) {
    // Orders whose sessions were deleted by account deletion.
    const pdfs = (await Promise.all(o.items.map((i) => listObjectKeys(`orders/${o.id}/items/${i.id}/`)))).flat();
    console.log(
      `order ${o.id} (session rows deleted)\n  status ${o.status}, anonymised ${o.anonymisedAt ? "yes" : "no"}, ` +
        `email "${o.email}", customerId ${o.customerId ?? "null"}, total ${o.totalCents}, R2 pdf ${pdfs.length}`,
    );
  }
  const audit = await prisma.deletionAuditLog.findMany({
    where: { OR: [{ sessionId: { in: ids } }, { sessionId: { startsWith: SESSION_PREFIX } }, { scope: "account" }] },
    orderBy: { createdAt: "asc" },
  });
  console.log(`\nAudit rows (${audit.length}):`);
  for (const a of audit) {
    console.log(
      `  ${a.createdAt.toISOString()} ${a.trigger.padEnd(17)} ${a.scope.padEnd(9)} ${String(a.sessionId ?? "-").padEnd(48)} ` +
        `files ${String(a.fileCount).padStart(2)} dryRun ${a.dryRun} ${a.outcome}${a.error ? ` (${a.error})` : ""}`,
    );
  }
}

async function markDispatched() {
  const ids = await seededSessionIds();
  const orderIds = await seededOrderIds(ids);
  const result = await prisma.order.updateMany({
    where: { id: { in: orderIds }, status: "paid" },
    data: { status: "dispatched" },
  });
  console.log(`Moved ${result.count} seeded paid order(s) to "dispatched".`);
}

async function clean() {
  const ids = await seededSessionIds();
  // Orders are found through items, whose sessionId stays even after account
  // deletion removed the Session rows.
  const items = await prisma.orderItem.findMany({
    where: { sessionId: { startsWith: SESSION_PREFIX } },
    select: { id: true, orderId: true, sessionId: true },
  });
  const orderIds = [...new Set(items.map((i) => i.orderId))];
  const sessionIds = [...new Set([...ids, ...items.map((i) => i.sessionId)])];

  const keys = (
    await Promise.all([
      ...sessionIds.map((id) => listObjectKeys(`sessions/${id}/`)),
      ...items.map((i) => listObjectKeys(`orders/${i.orderId}/items/${i.id}/`)),
    ])
  ).flat();
  if (keys.length > 0) {
    const result = await deleteObjects(keys);
    if (result.errors.length > 0) throw new Error(`R2 refused ${result.errors.length} deletion(s); rows left in place, re-run --clean.`);
  }

  await prisma.orderStatusEvent.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.character.deleteMany({ where: { sessionId: { in: sessionIds } } });
  await prisma.session.deleteMany({ where: { id: { in: sessionIds } } });
  const customers = await prisma.customer.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  console.log(
    `Cleaned ${sessionIds.length} session(s), ${orderIds.length} order(s), ${customers.count} customer(s), ${keys.length} R2 object(s). Audit rows kept.`,
  );
}

async function main() {
  const missing = missingDay1Config();
  if (missing.length > 0) throw new Error(`Missing config: ${missing.join(", ")} (apps/api/.env).`);
  if (process.argv.includes("--clean")) await clean();
  else if (process.argv.includes("--status")) await status();
  else if (process.argv.includes("--mark-dispatched")) await markDispatched();
  else await seed();
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
