import { describe, expect, it } from "vitest";
import {
  deletionSchedule,
  isProcessedDue,
  isRawDue,
  P1_GRACE_MS,
  P2_PROCESSED_DELAY_MS,
  P2_RAW_DELAY_MS,
  type ScheduleOrder,
  type ScheduleSession,
} from "../../src/gdpr/schedule";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = new Date("2026-09-01T12:00:00Z");
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

function session(overrides: Partial<ScheduleSession> = {}): ScheduleSession {
  return { expiresAt: T0, rawDeletedAt: null, processedDeletedAt: null, ...overrides };
}
const order = (status: string, deliveredAt: Date | null = null): ScheduleOrder => ({ status, deliveredAt });

describe("the policy constants", () => {
  it("match the confirmed policy", () => {
    expect(P1_GRACE_MS).toBe(DAY);
    expect(P2_RAW_DELAY_MS).toBe(DAY);
    expect(P2_PROCESSED_DELAY_MS).toBe(30 * DAY);
  });
});

describe("Pathway 1: sessions with no paid order", () => {
  it("raw is due strictly after expiresAt + 24h", () => {
    const s = session();
    const sched = deletionSchedule(s, []);
    expect(sched.pathway).toBe("p1");
    expect(sched.rawDueAt).toEqual(at(DAY));
    expect(isRawDue(s, sched, at(DAY - MINUTE))).toBe(false);
    expect(isRawDue(s, sched, at(DAY))).toBe(false); // "now > due", not >=
    expect(isRawDue(s, sched, at(DAY + MINUTE))).toBe(true);
  });

  it("never schedules processed files (rendered previews are kept)", () => {
    const s = session();
    const sched = deletionSchedule(s, []);
    expect(sched.processedDueAt).toBeNull();
    expect(isProcessedDue(s, sched, at(365 * DAY))).toBe(false);
  });

  it("treats an abandoned checkout (awaiting_payment) as unordered", () => {
    const sched = deletionSchedule(session(), [order("awaiting_payment")]);
    expect(sched.pathway).toBe("p1");
    expect(sched.rawDueAt).toEqual(at(DAY));
  });

  it("treats a cancelled order as unordered", () => {
    const sched = deletionSchedule(session(), [order("cancelled"), order("awaiting_payment")]);
    expect(sched.pathway).toBe("p1");
  });

  it("is not due once raw is already deleted", () => {
    const s = session({ rawDeletedAt: at(DAY + HOUR) });
    expect(isRawDue(s, deletionSchedule(s, []), at(10 * DAY))).toBe(false);
  });
});

describe("paid orders take a session out of Pathway 1", () => {
  for (const status of ["paid", "pdf_ready", "submitted_to_print", "processing", "dispatched", "failed"]) {
    it(`a ${status} order holds the session, far past expiry`, () => {
      const s = session();
      const sched = deletionSchedule(s, [order(status)]);
      expect(sched.pathway).toBe("held");
      expect(sched.rawDueAt).toBeNull();
      expect(sched.processedDueAt).toBeNull();
      expect(isRawDue(s, sched, at(365 * DAY))).toBe(false);
      expect(isProcessedDue(s, sched, at(365 * DAY))).toBe(false);
    });
  }

  it("a paid order holds the session even alongside an abandoned one", () => {
    expect(deletionSchedule(session(), [order("awaiting_payment"), order("paid")]).pathway).toBe("held");
  });
});

describe("Pathway 2: delivered orders", () => {
  const delivered = at(10 * DAY);

  it("raw is due strictly after deliveredAt + 24h", () => {
    const s = session();
    const sched = deletionSchedule(s, [order("delivered", delivered)]);
    expect(sched.pathway).toBe("p2");
    expect(sched.rawDueAt).toEqual(new Date(delivered.getTime() + DAY));
    expect(isRawDue(s, sched, new Date(delivered.getTime() + DAY - MINUTE))).toBe(false);
    expect(isRawDue(s, sched, new Date(delivered.getTime() + DAY + MINUTE))).toBe(true);
  });

  it("processed is due strictly after deliveredAt + 30 days", () => {
    const s = session();
    const sched = deletionSchedule(s, [order("delivered", delivered)]);
    expect(sched.processedDueAt).toEqual(new Date(delivered.getTime() + 30 * DAY));
    expect(isProcessedDue(s, sched, new Date(delivered.getTime() + 30 * DAY - MINUTE))).toBe(false);
    expect(isProcessedDue(s, sched, new Date(delivered.getTime() + 30 * DAY + MINUTE))).toBe(true);
  });

  it("ignores expiresAt entirely for a delivered order", () => {
    const s = session({ expiresAt: at(-100 * DAY) });
    const sched = deletionSchedule(s, [order("delivered", delivered)]);
    expect(isRawDue(s, sched, at(10 * DAY + HOUR))).toBe(false);
  });

  it("a delivered status with no deliveredAt is held, never guessed", () => {
    const sched = deletionSchedule(session(), [order("delivered", null)]);
    expect(sched.pathway).toBe("held");
    expect(sched.rawDueAt).toBeNull();
  });

  it("a reorder still in progress holds the session (no deletion under an active order)", () => {
    const s = session();
    const sched = deletionSchedule(s, [order("delivered", delivered), order("processing")]);
    expect(sched.pathway).toBe("held");
    expect(isRawDue(s, sched, at(100 * DAY))).toBe(false);
  });

  it("anchors on the LATEST delivery when a session was ordered twice", () => {
    const later = at(20 * DAY);
    const sched = deletionSchedule(session(), [order("delivered", delivered), order("delivered", later)]);
    expect(sched.rawDueAt).toEqual(new Date(later.getTime() + DAY));
    expect(sched.processedDueAt).toEqual(new Date(later.getTime() + 30 * DAY));
  });

  it("an abandoned or cancelled second order doesn't block a delivered one", () => {
    const sched = deletionSchedule(session(), [
      order("delivered", delivered),
      order("awaiting_payment"),
      order("cancelled"),
    ]);
    expect(sched.pathway).toBe("p2");
  });

  it("is not due once each marker is set", () => {
    const s = session({ rawDeletedAt: at(12 * DAY), processedDeletedAt: at(41 * DAY) });
    const sched = deletionSchedule(s, [order("delivered", delivered)]);
    expect(isRawDue(s, sched, at(100 * DAY))).toBe(false);
    expect(isProcessedDue(s, sched, at(100 * DAY))).toBe(false);
  });
});
