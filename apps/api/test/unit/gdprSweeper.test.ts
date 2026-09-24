import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

// The sweeper's SQL candidate queries are stubbed (candidates.ts); what's under
// test is what it DOES with candidates: re-check each one against the policy
// on fresh data, pick scope + trigger, force dry run from the env, continue
// past failures, and paginate within its bound.
const h = vi.hoisted(() => {
  type Kind = "p1" | "p2_raw" | "p2_processed";
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const NOW = new Date("2026-10-01T12:00:00Z");
  const ago = (ms: number) => new Date(NOW.getTime() - ms);

  interface Fixture {
    session: { expiresAt: Date; rawDeletedAt: Date | null; processedDeletedAt: Date | null };
    orders: { status: string; deliveredAt: Date | null }[];
  }
  const state = {
    env: { GDPR_DELETION_DRY_RUN: true, GDPR_SWEEP_BATCH_SIZE: 50, GDPR_SWEEP_MAX_PER_RUN: 1000 },
    candidates: { p1: [], p2_raw: [], p2_processed: [] } as Record<Kind, string[]>,
    fixtures: {} as Record<string, Fixture>,
    failing: new Set<string>(),
  };

  const findCandidates = vi.fn(
    async (kind: Kind, q: { cutoff: Date; afterId: string; limit: number; onlySessionIds?: string[] }) =>
      state.candidates[kind]
        .filter((id) => id > q.afterId)
        .filter((id) => !q.onlySessionIds || q.onlySessionIds.includes(id))
        .sort()
        .slice(0, q.limit),
  );
  const loadScheduleInput = vi.fn(async (id: string) => state.fixtures[id] ?? null);
  const deleteSessionAssets = vi.fn(async (sessionId: string, opts: { scope: string; dryRun: boolean }) => {
    if (state.failing.has(sessionId)) throw new Error("R2 exploded");
    return { sessionId, scope: opts.scope, fileCount: 3, dryRun: opts.dryRun };
  });

  return { state, findCandidates, loadScheduleInput, deleteSessionAssets, NOW, DAY, HOUR, ago };
});

vi.mock("../../src/env", () => ({ env: h.state.env }));
vi.mock("../../src/gdpr/candidates", () => ({
  findCandidates: h.findCandidates,
  loadScheduleInput: h.loadScheduleInput,
}));
vi.mock("../../src/gdpr/deleteSessionAssets", () => ({ deleteSessionAssets: h.deleteSessionAssets }));
vi.mock("../../src/redis", () => ({ createRedisConnection: vi.fn(), createQueueRedisConnection: vi.fn() }));

import { runGdprSweep } from "../../src/gdpr/sweeper";
import { processGdprJob } from "../../src/gdprWorker";

const { NOW, DAY, HOUR, ago } = h;
const fresh = { rawDeletedAt: null, processedDeletedAt: null };

function unorderedExpired(id: string, expiredAgo = 25 * HOUR) {
  h.state.fixtures[id] = { session: { expiresAt: ago(expiredAgo), ...fresh }, orders: [] };
}
function delivered(id: string, deliveredAgo: number, extraOrders: { status: string; deliveredAt: Date | null }[] = []) {
  h.state.fixtures[id] = {
    session: { expiresAt: ago(100 * DAY), ...fresh },
    orders: [{ status: "delivered", deliveredAt: ago(deliveredAgo) }, ...extraOrders],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.env.GDPR_DELETION_DRY_RUN = false;
  h.state.env.GDPR_SWEEP_BATCH_SIZE = 50;
  h.state.env.GDPR_SWEEP_MAX_PER_RUN = 1000;
  h.state.candidates = { p1: [], p2_raw: [], p2_processed: [] };
  h.state.fixtures = {};
  h.state.failing = new Set();
});

describe("Pathway 1", () => {
  it("deletes raw (only) for an expired unordered session, as system, trigger auto_p1", async () => {
    unorderedExpired("s1");
    h.state.candidates.p1 = ["s1"];
    const result = await runGdprSweep({ now: NOW });

    expect(h.deleteSessionAssets).toHaveBeenCalledOnce();
    expect(h.deleteSessionAssets).toHaveBeenCalledWith("s1", {
      scope: "raw",
      trigger: "auto_p1",
      actor: "system",
      dryRun: false,
    });
    expect(result.p1).toMatchObject({ candidates: 1, deleted: 1, skipped: 0, failed: 0 });
  });

  it("skips a candidate that isn't due on fresh data (just under 24h past expiry)", async () => {
    unorderedExpired("s1", 24 * HOUR - 60_000);
    h.state.candidates.p1 = ["s1"];
    const result = await runGdprSweep({ now: NOW });
    expect(h.deleteSessionAssets).not.toHaveBeenCalled();
    expect(result.p1).toMatchObject({ candidates: 1, deleted: 0, skipped: 1 });
  });

  it("skips a session that got PAID since the query ran (race with checkout)", async () => {
    h.state.fixtures.s1 = { session: { expiresAt: ago(30 * HOUR), ...fresh }, orders: [{ status: "paid", deliveredAt: null }] };
    h.state.candidates.p1 = ["s1"];
    await runGdprSweep({ now: NOW });
    expect(h.deleteSessionAssets).not.toHaveBeenCalled();
  });

  it("skips a session row that vanished", async () => {
    h.state.candidates.p1 = ["gone"];
    const result = await runGdprSweep({ now: NOW });
    expect(h.deleteSessionAssets).not.toHaveBeenCalled();
    expect(result.p1.skipped).toBe(1);
  });
});

describe("Pathway 2", () => {
  it("delivered 25h ago: raw deleted (auto_p2_raw), processed not yet", async () => {
    delivered("s2", 25 * HOUR);
    h.state.candidates.p2_raw = ["s2"];
    h.state.candidates.p2_processed = ["s2"]; // over-selected by SQL on purpose; the re-check must refuse
    const result = await runGdprSweep({ now: NOW });

    expect(h.deleteSessionAssets).toHaveBeenCalledOnce();
    expect(h.deleteSessionAssets).toHaveBeenCalledWith("s2", expect.objectContaining({ scope: "raw", trigger: "auto_p2_raw" }));
    expect(result.p2Processed).toMatchObject({ deleted: 0, skipped: 1 });
  });

  it("delivered 31 days ago: processed deleted (auto_p2_processed)", async () => {
    delivered("s3", 31 * DAY);
    h.state.candidates.p2_raw = ["s3"];
    h.state.candidates.p2_processed = ["s3"];
    await runGdprSweep({ now: NOW });
    expect(h.deleteSessionAssets).toHaveBeenCalledWith("s3", expect.objectContaining({ scope: "raw", trigger: "auto_p2_raw" }));
    expect(h.deleteSessionAssets).toHaveBeenCalledWith(
      "s3",
      expect.objectContaining({ scope: "processed", trigger: "auto_p2_processed" }),
    );
  });

  it.each(["paid", "pdf_ready", "submitted_to_print", "processing", "dispatched", "failed"])(
    "never sweeps a session whose only order is %s, even if SQL returns it",
    async (status) => {
      h.state.fixtures.s4 = { session: { expiresAt: ago(100 * DAY), ...fresh }, orders: [{ status, deliveredAt: null }] };
      h.state.candidates = { p1: ["s4"], p2_raw: ["s4"], p2_processed: ["s4"] };
      await runGdprSweep({ now: NOW });
      expect(h.deleteSessionAssets).not.toHaveBeenCalled();
    },
  );

  it("never sweeps a delivered session with a reorder still in production", async () => {
    delivered("s5", 40 * DAY, [{ status: "processing", deliveredAt: null }]);
    h.state.candidates = { p1: [], p2_raw: ["s5"], p2_processed: ["s5"] };
    await runGdprSweep({ now: NOW });
    expect(h.deleteSessionAssets).not.toHaveBeenCalled();
  });
});

describe("dry run", () => {
  beforeEach(() => {
    unorderedExpired("s1");
    h.state.candidates.p1 = ["s1"];
  });

  it("GDPR_DELETION_DRY_RUN forces dryRun even when the caller asks for a real run", async () => {
    h.state.env.GDPR_DELETION_DRY_RUN = true;
    const result = await runGdprSweep({ now: NOW, dryRun: false });
    expect(result.dryRun).toBe(true);
    expect(h.deleteSessionAssets).toHaveBeenCalledWith("s1", expect.objectContaining({ dryRun: true }));
  });

  it("a caller can force dry run on even when the env allows real deletion", async () => {
    const result = await runGdprSweep({ now: NOW, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(h.deleteSessionAssets).toHaveBeenCalledWith("s1", expect.objectContaining({ dryRun: true }));
  });
});

describe("resilience and bounds", () => {
  it("continues past a failing session, counting and naming it", async () => {
    for (const id of ["a", "b", "c"]) unorderedExpired(id);
    h.state.candidates.p1 = ["a", "b", "c"];
    h.state.failing.add("b");
    const result = await runGdprSweep({ now: NOW });
    expect(h.deleteSessionAssets).toHaveBeenCalledTimes(3);
    expect(result.p1).toMatchObject({ candidates: 3, deleted: 2, failed: 1, failedSessionIds: ["b"] });
  });

  it("paginates by id cursor in batches", async () => {
    const ids = ["a", "b", "c", "d", "e"];
    ids.forEach((id) => unorderedExpired(id));
    h.state.candidates.p1 = ids;
    const result = await runGdprSweep({ now: NOW, batchSize: 2 });
    expect(result.p1.deleted).toBe(5);
    const p1Calls = h.findCandidates.mock.calls.filter(([kind]) => kind === "p1").map(([, q]) => q.afterId);
    expect(p1Calls).toEqual(["", "b", "d"]);
  });

  it("stops at maxPerRun per pathway (the rest waits for the next run)", async () => {
    const ids = ["a", "b", "c", "d", "e"];
    ids.forEach((id) => unorderedExpired(id));
    h.state.candidates.p1 = ids;
    const result = await runGdprSweep({ now: NOW, batchSize: 2, maxPerRun: 3 });
    expect(result.p1.candidates).toBe(3);
    expect(h.deleteSessionAssets).toHaveBeenCalledTimes(3);
  });

  it("passes cutoffs of now-24h (P1, P2 raw) and now-30d (P2 processed) to the queries", async () => {
    await runGdprSweep({ now: NOW });
    const cutoff = (kind: string) =>
      (h.findCandidates.mock.calls.find(([k]) => k === kind)![1] as { cutoff: Date }).cutoff.getTime();
    expect(cutoff("p1")).toBe(NOW.getTime() - DAY);
    expect(cutoff("p2_raw")).toBe(NOW.getTime() - DAY);
    expect(cutoff("p2_processed")).toBe(NOW.getTime() - 30 * DAY);
  });

  it("restricts to onlySessionIds when given", async () => {
    unorderedExpired("mine");
    unorderedExpired("real-customer");
    h.state.candidates.p1 = ["mine", "real-customer"];
    await runGdprSweep({ now: NOW, onlySessionIds: ["mine"] });
    expect(h.deleteSessionAssets).toHaveBeenCalledOnce();
    expect(h.deleteSessionAssets).toHaveBeenCalledWith("mine", expect.anything());
  });
});

describe("the BullMQ job", () => {
  const job = { id: "repeat:gdpr-sweep:1", data: {} } as unknown as Job;

  // The job sweeps as of the real clock; pin it to the fixtures' NOW.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("completes when nothing failed", async () => {
    unorderedExpired("s1");
    h.state.candidates.p1 = ["s1"];
    await expect(processGdprJob(job)).resolves.toMatchObject({ p1: { deleted: 1 } });
  });

  it("fails (after processing everything) when any session failed, so the job is kept for inspection", async () => {
    for (const id of ["a", "b"]) unorderedExpired(id);
    h.state.candidates.p1 = ["a", "b"];
    h.state.failing.add("a");
    await expect(processGdprJob(job)).rejects.toThrow(/1 session/);
    expect(h.deleteSessionAssets).toHaveBeenCalledTimes(2);
  });

  it("honours dryRun on a manual sweep job (POST /api/admin/deletions/sweep)", async () => {
    h.state.env.GDPR_DELETION_DRY_RUN = false;
    unorderedExpired("s1");
    h.state.candidates.p1 = ["s1"];
    const manual = { id: "m1", data: { dryRun: true } } as unknown as Job;
    await expect(processGdprJob(manual)).resolves.toMatchObject({ dryRun: true });
    expect(h.deleteSessionAssets.mock.calls[0]![1]).toMatchObject({ dryRun: true });
  });

  it("a manual job asking for a real run still can't override GDPR_DELETION_DRY_RUN", async () => {
    h.state.env.GDPR_DELETION_DRY_RUN = true;
    unorderedExpired("s1");
    h.state.candidates.p1 = ["s1"];
    const manual = { id: "m2", data: { dryRun: false } } as unknown as Job;
    await expect(processGdprJob(manual)).resolves.toMatchObject({ dryRun: true });
  });
});
