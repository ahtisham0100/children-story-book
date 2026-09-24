import { UnrecoverableError } from "bullmq";
import type { Order, OrderItem, Customer } from "@prisma/client";
import { prisma } from "./db";
import { getPipelineQueue, getPipelineQueueEvents } from "./queue";
import { objectExists } from "./storage";
import { assembleItemPdf } from "./print/assemble";
import { GelatoRejectedError, submitOrderToGelato } from "./print/gelato";
import { sendOrderConfirmationEmail } from "./email/orderConfirmation";
import { sendAccountActivationEmail } from "./email/authEmails";
import { issueToken } from "./auth/service";
import { ORDER_STATUS } from "./orderStatus";

// A full book can have several pages, each up to a few minutes (see
// pipeline/catalog.ts's estimateSeconds); generous but bounded so a genuinely
// stuck render surfaces as a failed attempt instead of hanging forever.
const FULL_RENDER_TIMEOUT_MS = 15 * 60_000;

type OrderWithItems = Order & { items: OrderItem[]; customer: Customer | null };

async function appendStatusEvent(
  orderId: string,
  status: string,
  source: "system" | "stripe_webhook" | "gelato_webhook",
  raw?: unknown,
): Promise<void> {
  await prisma.orderStatusEvent.create({
    data: { orderId, status, source, raw: raw === undefined ? undefined : (raw as object) },
  });
}

function log(orderId: string, message: string): void {
  console.log(`[fulfillment] order ${orderId}: ${message}`);
}

/** Step 1: every page each item will print exists in R2, rendering if not. */
async function ensurePagesRendered(order: OrderWithItems): Promise<void> {
  const queue = getPipelineQueue();
  const queueEvents = getPipelineQueueEvents();
  await Promise.all(
    order.items.map(async ({ sessionId, printPageKeys }) => {
      const keys = printPageKeys as string[];
      const present = await Promise.all(keys.map((key) => objectExists(key)));
      if (present.every(Boolean)) {
        log(order.id, `session ${sessionId}: all ${keys.length} pages already rendered — skipping render.`);
        return;
      }

      // Same dedup jobId convention as the render-full route. The pages are
      // missing, so any FINISHED job still holding this id is stale. A failed
      // one especially: add() would be a no-op returning it, and
      // waitUntilFinished would fail straight away, so every retry of this
      // order would fail on the same old job. Remove it and render afresh.
      // A waiting/active job is left alone and simply awaited.
      const jobId = `${sessionId}__full`;
      const existing = await queue.getJob(jobId);
      if (existing && ((await existing.isFailed()) || (await existing.isCompleted()))) {
        log(order.id, `session ${sessionId}: removing stale finished render job ${jobId}.`);
        await existing.remove();
      }
      const job = await queue.add(
        "process",
        { sessionId, mode: "full" },
        { attempts: 1, removeOnComplete: { count: 1000, age: 3600 }, removeOnFail: 100, jobId },
      );
      await job.waitUntilFinished(queueEvents, FULL_RENDER_TIMEOUT_MS);
    }),
  );
}

/** Step 2: every item has a print PDF in R2, building only the missing ones. */
async function ensurePdfs(order: OrderWithItems): Promise<void> {
  for (const item of order.items) {
    if (item.printPdfKey && (await objectExists(item.printPdfKey))) {
      log(order.id, `item ${item.id}: print PDF already stored — skipping.`);
      continue;
    }
    const { key } = await assembleItemPdf(order.id, { id: item.id, printPageKeys: item.printPageKeys as string[] });
    await prisma.orderItem.update({ where: { id: item.id }, data: { printPdfKey: key } });
  }
  // Conditional so a retry, or an order a webhook already moved on, doesn't
  // step the status backwards or duplicate the audit event.
  const moved = await prisma.order.updateMany({
    where: { id: order.id, status: ORDER_STATUS.paid },
    data: { status: ORDER_STATUS.pdfReady },
  });
  if (moved.count > 0) {
    await appendStatusEvent(order.id, ORDER_STATUS.pdfReady, "system");
  }
}

/**
 * Step 3: submit to Gelato AT MOST ONCE.
 *
 * - gelatoOrderId set: already submitted, skip.
 * - gelatoSubmitStartedAt set but no gelatoOrderId: a previous attempt got as
 *   far as calling Gelato and we don't know the outcome (crash, timeout, 5xx,
 *   or the DB write after a success failed). Gelato may already have a print
 *   order, so stop with an UnrecoverableError for a human to reconcile against
 *   Gelato's dashboard rather than risk printing and shipping twice.
 * - A definite 4xx rejection means no order was created, so the marker is
 *   cleared and the next attempt may safely try again.
 */
async function ensureSubmittedToGelato(order: OrderWithItems): Promise<void> {
  if (order.gelatoOrderId) {
    log(order.id, `already submitted to Gelato (${order.gelatoOrderId}) — skipping.`);
    return;
  }
  if (order.gelatoSubmitStartedAt) {
    throw new UnrecoverableError(
      `Order ${order.id}: a Gelato submission started at ${order.gelatoSubmitStartedAt.toISOString()} ` +
        `has an unknown outcome. Check Gelato's dashboard for orderReferenceId ${order.id} before retrying ` +
        `(then set gelatoOrderId if it exists, or clear gelatoSubmitStartedAt if it doesn't).`,
    );
  }

  const items = await prisma.orderItem.findMany({ where: { orderId: order.id } });
  await prisma.order.update({ where: { id: order.id }, data: { gelatoSubmitStartedAt: new Date() } });

  let gelatoOrderId: string;
  try {
    ({ gelatoOrderId } = await submitOrderToGelato({
      id: order.id,
      shippingName: order.shippingName,
      shippingLine1: order.shippingLine1,
      shippingLine2: order.shippingLine2,
      shippingCity: order.shippingCity,
      shippingPostalCode: order.shippingPostalCode,
      shippingCountry: order.shippingCountry,
      items: items.map((i) => ({ id: i.id, bookTitle: i.bookTitle, printPdfKey: i.printPdfKey! })),
    }));
  } catch (error) {
    if (error instanceof GelatoRejectedError) {
      await prisma.order.update({ where: { id: order.id }, data: { gelatoSubmitStartedAt: null } });
    }
    throw error;
  }

  // Record the id first, unconditionally: it's what prevents a resubmission.
  await prisma.order.update({ where: { id: order.id }, data: { gelatoOrderId } });
  // Status only moves forward from our own pre-print states. A Gelato webhook
  // (keyed on our order id) can race ahead of this line.
  const moved = await prisma.order.updateMany({
    where: { id: order.id, status: { in: [ORDER_STATUS.paid, ORDER_STATUS.pdfReady] } },
    data: { status: ORDER_STATUS.submittedToPrint },
  });
  if (moved.count > 0) {
    await appendStatusEvent(order.id, ORDER_STATUS.submittedToPrint, "system", { gelatoOrderId });
  }
}

/**
 * Step 4: emails, each at most once (stamped after a successful send). The
 * remaining gap is a crash between a successful send and its stamp, which would
 * send that one email twice. Rare and harmless compared with never sending.
 */
async function ensureEmailsSent(order: OrderWithItems): Promise<void> {
  if (order.confirmationEmailSentAt) {
    log(order.id, "confirmation email already sent — skipping.");
  } else {
    await sendOrderConfirmationEmail({
      id: order.id,
      email: order.email,
      totalCents: order.totalCents,
      currency: order.currency,
      items: order.items.map((i) => ({ bookTitle: i.bookTitle })),
    });
    await prisma.order.update({ where: { id: order.id }, data: { confirmationEmailSentAt: new Date() } });
  }

  // Post-checkout account activation, only for a brand-new account with no
  // password yet, so repeat buyers aren't re-nagged. Its own try/catch: failing
  // to send this must not fail an otherwise-fulfilled order. It's left
  // unstamped so a later retry could try again.
  if (order.activationEmailSentAt) {
    log(order.id, "activation email already sent — skipping.");
  } else if (order.customer && order.customer.passwordHash === null) {
    try {
      const raw = await issueToken(order.customer.id, "activation");
      await sendAccountActivationEmail(order.customer.email, raw);
      await prisma.order.update({ where: { id: order.id }, data: { activationEmailSentAt: new Date() } });
    } catch (activationError) {
      console.error(`[fulfillment] order ${order.id}: activation email failed:`, activationError);
    }
  }
}

/**
 * Runs one fulfilment attempt for a paid order. Each step checks what a
 * previous attempt already finished and skips it, so this is safe to re-run
 * from the start at any point, which is exactly what a BullMQ retry does.
 * THROWS on failure. The fulfilment worker decides whether that is final (see
 * markFulfillmentFailed).
 */
export async function runFulfillment(orderId: string): Promise<void> {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { items: true, customer: true },
  });

  await ensurePagesRendered(order);
  await ensurePdfs(order);
  await ensureSubmittedToGelato(order);
  await ensureEmailsSent(order);
  log(orderId, "fulfilment complete.");
}

/** True when BullMQ will NOT run this job again after the current failure. */
export function isFinalAttempt(error: unknown, attemptsMade: number, maxAttempts: number): boolean {
  return error instanceof UnrecoverableError || attemptsMade + 1 >= maxAttempts;
}

/**
 * Called once, when fulfilment has failed for good. Before a print order
 * exists, the order is marked failed with an audit event (as before). After
 * Gelato has it, the book IS being printed, so a later failure (e.g. the
 * confirmation email) must not flip a real order to "failed". It is logged,
 * and the failed job stays in the queue for inspection and retry.
 */
export async function markFulfillmentFailed(orderId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { gelatoOrderId: true } });
  if (order?.gelatoOrderId) {
    console.error(
      `[fulfillment] order ${orderId}: post-submission step failed for good (order already with Gelato, status left as is): ${message}`,
    );
    return;
  }
  await prisma.order.update({ where: { id: orderId }, data: { status: ORDER_STATUS.failed } });
  await appendStatusEvent(orderId, ORDER_STATUS.failed, "system", { message });
}
