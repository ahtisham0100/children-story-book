import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnrecoverableError, type Job } from "bullmq";

// In-memory stand-ins for exactly what fulfillment.ts touches. Each test sets
// up an order in some partially-fulfilled state and checks which steps run.
const h = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const state = { order: {} as Row, items: [] as Row[], events: [] as Row[] };

  const matches = (row: Row, where: Row) =>
    Object.entries(where).every(([k, v]) =>
      v && typeof v === "object" && "in" in (v as Row) ? ((v as { in: unknown[] }).in).includes(row[k]) : row[k] === v,
    );

  const prisma = {
    order: {
      findUniqueOrThrow: vi.fn(async () => ({ ...state.order, items: state.items.map((i) => ({ ...i })) })),
      findUnique: vi.fn(async () => ({ ...state.order })),
      update: vi.fn(async ({ data }: { data: Row }) => Object.assign(state.order, data)),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        if (!matches(state.order, where)) return { count: 0 };
        Object.assign(state.order, data);
        return { count: 1 };
      }),
    },
    orderItem: {
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) =>
        Object.assign(state.items.find((i) => i.id === where.id)!, data),
      ),
      findMany: vi.fn(async () => state.items.map((i) => ({ ...i }))),
    },
    orderStatusEvent: { create: vi.fn(async ({ data }: { data: Row }) => state.events.push(data)) },
  };

  const renderJob = { waitUntilFinished: vi.fn(async () => undefined) };
  const pipelineQueue = {
    getJob: vi.fn(async (): Promise<unknown> => undefined),
    add: vi.fn(async () => renderJob),
  };

  return {
    state,
    prisma,
    pipelineQueue,
    renderJob,
    objectExists: vi.fn(async (_key: string) => true),
    assembleItemPdf: vi.fn(async (orderId: string, item: { id: string }) => ({ key: `orders/${orderId}/items/${item.id}/print.pdf` })),
    submitOrderToGelato: vi.fn(async () => ({ gelatoOrderId: "gel-123" })),
    sendOrderConfirmationEmail: vi.fn(async () => undefined),
    sendAccountActivationEmail: vi.fn(async () => undefined),
    issueToken: vi.fn(async () => "raw-token"),
  };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));
vi.mock("../../src/redis", () => ({ createRedisConnection: vi.fn(), createQueueRedisConnection: vi.fn() }));
vi.mock("../../src/queue", () => ({
  FULFILLMENT_ATTEMPTS: 5,
  FULFILLMENT_QUEUE_NAME: "fulfillment",
  getPipelineQueue: () => h.pipelineQueue,
  getPipelineQueueEvents: () => ({}),
}));
vi.mock("../../src/storage", () => ({ objectExists: h.objectExists }));
vi.mock("../../src/print/assemble", () => ({ assembleItemPdf: h.assembleItemPdf }));
vi.mock("../../src/print/gelato", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/print/gelato")>()),
  submitOrderToGelato: h.submitOrderToGelato,
}));
vi.mock("../../src/email/orderConfirmation", () => ({ sendOrderConfirmationEmail: h.sendOrderConfirmationEmail }));
vi.mock("../../src/email/authEmails", () => ({ sendAccountActivationEmail: h.sendAccountActivationEmail }));
vi.mock("../../src/auth/service", () => ({ issueToken: h.issueToken }));

import { isFinalAttempt, markFulfillmentFailed, runFulfillment } from "../../src/fulfillment";
import { processFulfillmentJob } from "../../src/fulfillmentWorker";
import { GelatoRejectedError } from "../../src/print/gelato";

const ORDER_ID = "order-1";

function freshOrder(overrides: Record<string, unknown> = {}) {
  h.state.order = {
    id: ORDER_ID,
    email: "parent@example.com",
    status: "paid",
    totalCents: 3490,
    currency: "eur",
    shippingName: "A Parent",
    shippingLine1: "1 Test St",
    shippingLine2: null,
    shippingCity: "Paris",
    shippingPostalCode: "75001",
    shippingCountry: "FR",
    gelatoOrderId: null,
    gelatoSubmitStartedAt: null,
    confirmationEmailSentAt: null,
    activationEmailSentAt: null,
    customer: { id: "cust-1", email: "parent@example.com", passwordHash: null },
    ...overrides,
  };
  h.state.items = [
    { id: "item-1", sessionId: "sess-1", bookTitle: "Book", printPageKeys: ["p1.png", "p2.png"], printPdfKey: null },
  ];
  h.state.events = [];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.objectExists.mockImplementation(async () => true);
  h.pipelineQueue.getJob.mockImplementation(async () => undefined);
  h.submitOrderToGelato.mockImplementation(async () => ({ gelatoOrderId: "gel-123" }));
  freshOrder();
});

describe("runFulfillment — happy path from a freshly paid order", () => {
  it("runs every step once and records the markers", async () => {
    h.objectExists.mockImplementation(async (key: string) => key.endsWith(".png")); // pages yes, PDF no
    await runFulfillment(ORDER_ID);

    expect(h.pipelineQueue.add).not.toHaveBeenCalled(); // pages were already rendered
    expect(h.assembleItemPdf).toHaveBeenCalledOnce();
    expect(h.submitOrderToGelato).toHaveBeenCalledOnce();
    expect(h.sendOrderConfirmationEmail).toHaveBeenCalledOnce();
    expect(h.sendAccountActivationEmail).toHaveBeenCalledOnce();
    expect(h.state.order).toMatchObject({ status: "submitted_to_print", gelatoOrderId: "gel-123" });
    expect(h.state.order.confirmationEmailSentAt).toBeInstanceOf(Date);
    expect(h.state.order.activationEmailSentAt).toBeInstanceOf(Date);
    expect(h.state.events.map((e) => e.status)).toEqual(["pdf_ready", "submitted_to_print"]);
  });
});

describe("render step", () => {
  it("skips the render when every page already exists", async () => {
    await runFulfillment(ORDER_ID);
    expect(h.pipelineQueue.add).not.toHaveBeenCalled();
  });

  it("renders when a page is missing, and waits for it", async () => {
    h.objectExists.mockImplementation(async (key: string) => key !== "p2.png");
    await runFulfillment(ORDER_ID);
    expect(h.pipelineQueue.add).toHaveBeenCalledWith(
      "process",
      { sessionId: "sess-1", mode: "full" },
      expect.objectContaining({ jobId: "sess-1__full" }),
    );
    expect(h.renderJob.waitUntilFinished).toHaveBeenCalledOnce();
  });

  it("removes a stale FAILED render job before re-adding (a retry must not reuse it)", async () => {
    h.objectExists.mockImplementation(async (key: string) => key !== "p2.png");
    const stale = { isFailed: vi.fn(async () => true), isCompleted: vi.fn(async () => false), remove: vi.fn() };
    h.pipelineQueue.getJob.mockImplementation(async () => stale);
    await runFulfillment(ORDER_ID);
    expect(stale.remove).toHaveBeenCalledOnce();
    expect(h.pipelineQueue.add).toHaveBeenCalledOnce();
  });

  it("leaves an in-flight render job alone and just awaits it", async () => {
    h.objectExists.mockImplementation(async (key: string) => key !== "p2.png");
    const active = { isFailed: vi.fn(async () => false), isCompleted: vi.fn(async () => false), remove: vi.fn() };
    h.pipelineQueue.getJob.mockImplementation(async () => active);
    await runFulfillment(ORDER_ID);
    expect(active.remove).not.toHaveBeenCalled();
  });
});

describe("PDF step", () => {
  it("skips an item whose PDF is already stored", async () => {
    h.state.items[0]!.printPdfKey = "orders/order-1/items/item-1/print.pdf";
    await runFulfillment(ORDER_ID);
    expect(h.assembleItemPdf).not.toHaveBeenCalled();
  });

  it("rebuilds when the key is recorded but the object is gone", async () => {
    h.state.items[0]!.printPdfKey = "orders/order-1/items/item-1/print.pdf";
    h.objectExists.mockImplementation(async (key: string) => !key.endsWith(".pdf"));
    await runFulfillment(ORDER_ID);
    expect(h.assembleItemPdf).toHaveBeenCalledOnce();
  });

  it("does not re-append pdf_ready when the order has already moved past paid", async () => {
    freshOrder({ status: "pdf_ready" });
    await runFulfillment(ORDER_ID);
    expect(h.state.events.map((e) => e.status)).not.toContain("pdf_ready");
  });
});

describe("Gelato step — never submits twice", () => {
  it("skips submission when gelatoOrderId is already set", async () => {
    freshOrder({ gelatoOrderId: "gel-existing", status: "submitted_to_print" });
    await runFulfillment(ORDER_ID);
    expect(h.submitOrderToGelato).not.toHaveBeenCalled();
    expect(h.state.order.gelatoOrderId).toBe("gel-existing");
  });

  it("refuses to resubmit after an ambiguous earlier attempt (UnrecoverableError)", async () => {
    freshOrder({ gelatoSubmitStartedAt: new Date("2026-09-23T10:00:00Z") });
    await expect(runFulfillment(ORDER_ID)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(h.submitOrderToGelato).not.toHaveBeenCalled();
    expect(h.sendOrderConfirmationEmail).not.toHaveBeenCalled();
  });

  it("clears the marker on a definite 4xx rejection so a retry may try again", async () => {
    h.submitOrderToGelato.mockImplementation(async () => {
      throw new GelatoRejectedError(400, "complete the company information");
    });
    await expect(runFulfillment(ORDER_ID)).rejects.toBeInstanceOf(GelatoRejectedError);
    expect(h.state.order.gelatoSubmitStartedAt).toBeNull();
  });

  it("keeps the marker on an ambiguous failure (network/5xx)", async () => {
    h.submitOrderToGelato.mockImplementation(async () => {
      throw new Error("Gelato order create failed: 502 Bad Gateway");
    });
    await expect(runFulfillment(ORDER_ID)).rejects.toThrow("502");
    expect(h.state.order.gelatoSubmitStartedAt).toBeInstanceOf(Date);
    // …so the next attempt stops instead of resubmitting.
    await expect(runFulfillment(ORDER_ID)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(h.submitOrderToGelato).toHaveBeenCalledOnce();
  });
});

describe("email step", () => {
  it("does not resend emails that were already sent", async () => {
    freshOrder({
      gelatoOrderId: "gel-123",
      status: "submitted_to_print",
      confirmationEmailSentAt: new Date(),
      activationEmailSentAt: new Date(),
    });
    await runFulfillment(ORDER_ID);
    expect(h.sendOrderConfirmationEmail).not.toHaveBeenCalled();
    expect(h.sendAccountActivationEmail).not.toHaveBeenCalled();
    expect(h.issueToken).not.toHaveBeenCalled();
  });

  it("does not stamp the confirmation email when sending fails, so a retry resends it", async () => {
    h.sendOrderConfirmationEmail.mockRejectedValueOnce(new Error("resend down"));
    await expect(runFulfillment(ORDER_ID)).rejects.toThrow("resend down");
    expect(h.state.order.confirmationEmailSentAt).toBeNull();

    await runFulfillment(ORDER_ID); // the retry
    expect(h.submitOrderToGelato).toHaveBeenCalledOnce(); // not resubmitted
    expect(h.sendOrderConfirmationEmail).toHaveBeenCalledTimes(2);
    expect(h.state.order.confirmationEmailSentAt).toBeInstanceOf(Date);
  });

  it("skips activation for a customer who already has a password", async () => {
    freshOrder({ customer: { id: "cust-1", email: "parent@example.com", passwordHash: "hash" } });
    await runFulfillment(ORDER_ID);
    expect(h.sendAccountActivationEmail).not.toHaveBeenCalled();
  });

  it("an activation email failure doesn't fail the order and leaves it unstamped", async () => {
    h.sendAccountActivationEmail.mockRejectedValueOnce(new Error("resend down"));
    await expect(runFulfillment(ORDER_ID)).resolves.toBeUndefined();
    expect(h.state.order.activationEmailSentAt).toBeNull();
  });
});

describe("final-failure handling", () => {
  it("isFinalAttempt: only the last attempt, or an unrecoverable error, is final", () => {
    expect(isFinalAttempt(new Error("x"), 0, 5)).toBe(false);
    expect(isFinalAttempt(new Error("x"), 3, 5)).toBe(false);
    expect(isFinalAttempt(new Error("x"), 4, 5)).toBe(true);
    expect(isFinalAttempt(new UnrecoverableError("x"), 0, 5)).toBe(true);
  });

  function job(attemptsMade: number) {
    return { data: { orderId: ORDER_ID }, attemptsMade, opts: { attempts: 5 } } as unknown as Job<{ orderId: string }>;
  }

  it("a non-final failure rethrows without marking the order failed", async () => {
    h.submitOrderToGelato.mockImplementation(async () => {
      throw new GelatoRejectedError(400, "nope");
    });
    await expect(processFulfillmentJob(job(0))).rejects.toThrow();
    expect(h.state.order.status).not.toBe("failed");
  });

  it("the final failure marks the order failed with an audit event", async () => {
    h.submitOrderToGelato.mockImplementation(async () => {
      throw new GelatoRejectedError(400, "nope");
    });
    await expect(processFulfillmentJob(job(4))).rejects.toThrow();
    expect(h.state.order.status).toBe("failed");
    expect(h.state.events.at(-1)).toMatchObject({ status: "failed", source: "system" });
  });

  it("never marks an order failed once Gelato already has it", async () => {
    freshOrder({ gelatoOrderId: "gel-123", status: "submitted_to_print" });
    await markFulfillmentFailed(ORDER_ID, new Error("email failed"));
    expect(h.state.order.status).toBe("submitted_to_print");
    expect(h.state.events).toHaveLength(0);
  });
});
