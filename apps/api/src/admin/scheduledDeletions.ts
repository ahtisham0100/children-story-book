import { findCandidates, loadScheduleInput, type CandidateKind } from "../gdpr/candidates";
import {
  deletionSchedule,
  P1_GRACE_MS,
  P2_PROCESSED_DELAY_MS,
  P2_RAW_DELAY_MS,
  type DeletionPathway,
  type DeletionSchedule,
  type ScheduleSession,
} from "../gdpr/schedule";

/**
 * Upcoming GDPR deletions for the admin dashboard, built from the SAME pieces
 * the sweeper uses (src/gdpr/sweeper.ts): the indexed candidate SQL
 * (candidates.ts) as a pre-filter, then a fresh read of each session and its
 * orders run through deletionSchedule() (schedule.ts). The policy isn't
 * restated here; the only difference from the sweeper is the cutoff, moved
 * forward by the look-ahead window so sessions due soon show up too.
 */

const DAY_MS = 24 * 3_600_000;

interface KindSpec {
  delayMs: number;
  scope: "raw" | "processed";
  pathway: DeletionPathway;
  /** The due date this kind acts on, or null if it doesn't apply or is already done. */
  dueAt: (session: ScheduleSession, schedule: DeletionSchedule) => Date | null;
}

// Mirrors the sweeper's PATHWAYS table: which schedule date each candidate kind acts on.
const KINDS: Record<CandidateKind, KindSpec> = {
  p1: {
    delayMs: P1_GRACE_MS,
    scope: "raw",
    pathway: "p1",
    dueAt: (s, sch) => (sch.pathway === "p1" && !s.rawDeletedAt ? sch.rawDueAt : null),
  },
  p2_raw: {
    delayMs: P2_RAW_DELAY_MS,
    scope: "raw",
    pathway: "p2",
    dueAt: (s, sch) => (sch.pathway === "p2" && !s.rawDeletedAt ? sch.rawDueAt : null),
  },
  p2_processed: {
    delayMs: P2_PROCESSED_DELAY_MS,
    scope: "processed",
    pathway: "p2",
    dueAt: (s, sch) => (sch.pathway === "p2" && !s.processedDeletedAt ? sch.processedDueAt : null),
  },
};

export interface ScheduledDeletion {
  sessionId: string;
  pathway: DeletionPathway;
  scope: "raw" | "processed";
  dueAt: string;
  /** Past due: the next sweep deletes it (or, in dry-run mode, logs it again). */
  overdue: boolean;
}

export async function listScheduledDeletions(options: {
  kind: CandidateKind;
  withinDays: number;
  cursor?: string;
  limit: number;
  now?: Date;
}): Promise<{ items: ScheduledDeletion[]; nextCursor: string | null }> {
  const spec = KINDS[options.kind];
  const now = options.now ?? new Date();
  const horizon = now.getTime() + options.withinDays * DAY_MS;

  const ids = await findCandidates(options.kind, {
    cutoff: new Date(horizon - spec.delayMs),
    afterId: options.cursor ?? "",
    limit: options.limit,
  });

  const items: ScheduledDeletion[] = [];
  for (const sessionId of ids) {
    const input = await loadScheduleInput(sessionId);
    if (!input) continue;
    const dueAt = spec.dueAt(input.session, deletionSchedule(input.session, input.orders));
    if (!dueAt || dueAt.getTime() > horizon) continue;
    items.push({
      sessionId,
      pathway: spec.pathway,
      scope: spec.scope,
      dueAt: dueAt.toISOString(),
      // The sweeper deletes strictly after the due time (schedule.ts isRawDue).
      overdue: now.getTime() > dueAt.getTime(),
    });
  }
  // Keyset pagination over the SQL's ids: a full page may have more behind it,
  // even if some of this page were filtered out.
  return { items, nextCursor: ids.length === options.limit ? ids[ids.length - 1]! : null };
}
