import { describe, it, expect } from "vitest";
import {
  ADMIN_STATUS_TRANSITIONS,
  adminTransitionsFrom,
  canAdminTransition,
  canTransitionToPaid,
  mapGelatoStatus,
  ORDER_STATUS,
} from "../../src/orderStatus";

describe("canTransitionToPaid", () => {
  it("allows the transition from awaiting_payment", () => {
    expect(canTransitionToPaid(ORDER_STATUS.awaitingPayment)).toBe(true);
  });

  it("rejects a second payment_intent.succeeded delivery (idempotency)", () => {
    expect(canTransitionToPaid(ORDER_STATUS.paid)).toBe(false);
    expect(canTransitionToPaid(ORDER_STATUS.dispatched)).toBe(false);
  });
});

describe("mapGelatoStatus", () => {
  it("maps known Gelato statuses to canonical order statuses", () => {
    expect(mapGelatoStatus("printed")).toBe(ORDER_STATUS.processing);
    expect(mapGelatoStatus("shipped")).toBe(ORDER_STATUS.dispatched);
    expect(mapGelatoStatus("delivered")).toBe(ORDER_STATUS.delivered);
  });

  it("returns null for an unrecognized status instead of guessing", () => {
    expect(mapGelatoStatus("some_future_gelato_status")).toBeNull();
  });
});

describe("admin manual status transitions", () => {
  const ALL = Object.values(ORDER_STATUS);

  it("defines targets for every status, using only real statuses and never a no-op", () => {
    expect(Object.keys(ADMIN_STATUS_TRANSITIONS).sort()).toEqual([...ALL].sort());
    for (const [from, targets] of Object.entries(ADMIN_STATUS_TRANSITIONS)) {
      for (const to of targets) {
        expect(ALL).toContain(to);
        expect(to).not.toBe(from);
      }
    }
  });

  it("allows the corrections an admin needs when Gelato's webhooks don't arrive", () => {
    expect(canAdminTransition("submitted_to_print", "processing")).toBe(true);
    expect(canAdminTransition("processing", "dispatched")).toBe(true);
    expect(canAdminTransition("dispatched", "delivered")).toBe(true);
    expect(canAdminTransition("submitted_to_print", "delivered")).toBe(true);
    expect(canAdminTransition("awaiting_payment", "cancelled")).toBe(true);
    expect(canAdminTransition("failed", "cancelled")).toBe(true);
  });

  it("never moves an order back into payment or pre-print states by hand", () => {
    for (const from of ALL) {
      expect(canAdminTransition(from, "awaiting_payment")).toBe(false);
      expect(canAdminTransition(from, "paid")).toBe(false); // only a fulfilment retry does failed -> paid
      expect(canAdminTransition(from, "pdf_ready")).toBe(false);
      expect(canAdminTransition(from, "submitted_to_print")).toBe(false); // only Gelato reconcile sets this
    }
  });

  it("treats delivered and cancelled as final", () => {
    expect(adminTransitionsFrom("delivered")).toEqual([]);
    expect(adminTransitionsFrom("cancelled")).toEqual([]);
  });

  it("doesn't mark a paid order delivered or dispatched (it hasn't been printed)", () => {
    expect(canAdminTransition("paid", "delivered")).toBe(false);
    expect(canAdminTransition("paid", "dispatched")).toBe(false);
    expect(canAdminTransition("paid", "failed")).toBe(true);
  });

  it("returns false / [] for unknown statuses instead of throwing", () => {
    expect(canAdminTransition("teleported", "delivered")).toBe(false);
    expect(canAdminTransition("processing", "teleported")).toBe(false);
    expect(adminTransitionsFrom("teleported")).toEqual([]);
  });
});
