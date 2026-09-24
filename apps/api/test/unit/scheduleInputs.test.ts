import { beforeEach, describe, expect, it, vi } from "vitest";

// loadScheduleInputs (batched, for the admin table) must hand deletionSchedule()
// exactly what loadScheduleInput (per session, used by the sweeper) does, so
// the dashboard can never disagree with what the sweeper will delete.
const h = await vi.hoisted(async () => (await import("./support/adminHarness")).createAdminHarness());
vi.mock("../../src/db", () => ({ prisma: h.prisma }));

import { loadScheduleInput, loadScheduleInputs } from "../../src/gdpr/candidates";

const D = (s: string) => new Date(s);

beforeEach(() => {
  h.reset();
  h.db.sessions.push(
    { id: "s-unordered", expiresAt: D("2026-09-01T00:00:00Z"), rawDeletedAt: null, processedDeletedAt: null, previewKey: "k" },
    { id: "s-delivered", expiresAt: D("2026-08-01T00:00:00Z"), rawDeletedAt: D("2026-09-03T00:00:00Z"), processedDeletedAt: null },
    { id: "s-shared", expiresAt: D("2026-08-01T00:00:00Z"), rawDeletedAt: null, processedDeletedAt: null },
  );
  h.db.orders.push(
    { id: "o-1", status: "delivered", deliveredAt: D("2026-09-02T00:00:00Z"), email: "x@example.com" },
    { id: "o-2", status: "paid", deliveredAt: null },
    { id: "o-3", status: "delivered", deliveredAt: D("2026-09-05T00:00:00Z") },
  );
  h.db.items.push(
    { id: "i-1", orderId: "o-1", sessionId: "s-delivered" },
    { id: "i-2", orderId: "o-2", sessionId: "s-shared" },
    { id: "i-3", orderId: "o-3", sessionId: "s-shared" },
    // Two items of one order on one session: the order counts once.
    { id: "i-4", orderId: "o-3", sessionId: "s-shared" },
  );
});

describe("loadScheduleInputs", () => {
  it("matches loadScheduleInput for every session, and skips missing ones", async () => {
    const ids = ["s-unordered", "s-delivered", "s-shared", "s-gone"];
    const batched = await loadScheduleInputs(ids);
    for (const id of ids) {
      const single = await loadScheduleInput(id);
      const fromBatch = batched.get(id) ?? null;
      if (single === null) {
        expect(fromBatch, id).toBeNull();
        continue;
      }
      expect(fromBatch!.session, id).toEqual(single.session);
      const sortOrders = (orders: { status: string }[]) => [...orders].sort((a, b) => a.status.localeCompare(b.status));
      expect(sortOrders(fromBatch!.orders), id).toEqual(sortOrders(single.orders));
    }
    expect(batched.has("s-gone")).toBe(false);
  });

  it("returns only the fields the schedule needs (no ids, keys or emails)", async () => {
    const batched = await loadScheduleInputs(["s-unordered", "s-delivered"]);
    expect(Object.keys(batched.get("s-unordered")!.session).sort()).toEqual(["expiresAt", "processedDeletedAt", "rawDeletedAt"]);
    expect(batched.get("s-delivered")!.orders).toEqual([{ status: "delivered", deliveredAt: D("2026-09-02T00:00:00Z") }]);
  });

  it("does no queries for an empty page", async () => {
    expect((await loadScheduleInputs([])).size).toBe(0);
    expect(h.prisma.session.findMany).not.toHaveBeenCalled();
  });
});
