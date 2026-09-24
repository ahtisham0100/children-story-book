import { describe, it, expect } from "vitest";
import { canTransitionToPaid, mapGelatoStatus, ORDER_STATUS } from "../../src/orderStatus";

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
