import { env } from "../env";
import { findCandidates, loadScheduleInput, type CandidateKind } from "./candidates";
import { deleteSessionAssets, type DeletionScope, type DeletionTrigger } from "./deleteSessionAssets";
import {
  deletionSchedule,
  isProcessedDue,
  isRawDue,
  P1_GRACE_MS,
  P2_PROCESSED_DELAY_MS,
  P2_RAW_DELAY_MS,
  type DeletionSchedule,
  type ScheduleSession,
} from "./schedule";

/**
 * GDPR Pathways 1 & 2: one pass over every session that's due. Run hourly by
 * the gdpr BullMQ job (gdprWorker.ts), or once by hand with `npm run
 * gdpr:sweep` (scripts/gdpr-sweep.mts).
 *
 * For each pathway: page through indexed SQL candidates (candidates.ts), then
 * for EACH one re-read the session and its orders and re-check the policy
 * (schedule.ts) before deleting. The re-check is what makes this safe against
 * a stale or over-broad query, and against races (e.g. a session paid for
 * between the query and the delete). One session failing never stops the
 * sweep: it's logged, counted, and retried on the next run (its markers stay
 * unset).
 */

export interface SweepOptions {
  now?: Date;
  /** Force a dry run. GDPR_DELETION_DRY_RUN forces one regardless of this. */
  dryRun?: boolean;
  onlySessionIds?: string[];
  batchSize?: number;
  /** Max candidates examined per pathway per run; the rest wait for the next run. */
  maxPerRun?: number;
}

export interface PathwayCounts {
  /** Candidates the SQL returned (and were re-checked). */
  candidates: number;
  deleted: number;
  /** Candidates the fresh re-check found not due (or gone). */
  skipped: number;
  failed: number;
  failedSessionIds: string[];
  /** Objects deleted, or in a dry run, that would be. */
  fileCount: number;
}

export interface SweepResult {
  dryRun: boolean;
  now: string;
  p1: PathwayCounts;
  p2Raw: PathwayCounts;
  p2Processed: PathwayCounts;
}

interface PathwaySpec {
  kind: CandidateKind;
  delayMs: number;
  scope: DeletionScope;
  trigger: DeletionTrigger;
  isDue: (session: ScheduleSession, schedule: DeletionSchedule, now: Date) => boolean;
}

const PATHWAYS: PathwaySpec[] = [
  {
    kind: "p1",
    delayMs: P1_GRACE_MS,
    scope: "raw",
    trigger: "auto_p1",
    isDue: (session, schedule, now) => schedule.pathway === "p1" && isRawDue(session, schedule, now),
  },
  {
    kind: "p2_raw",
    delayMs: P2_RAW_DELAY_MS,
    scope: "raw",
    trigger: "auto_p2_raw",
    isDue: (session, schedule, now) => schedule.pathway === "p2" && isRawDue(session, schedule, now),
  },
  {
    kind: "p2_processed",
    delayMs: P2_PROCESSED_DELAY_MS,
    scope: "processed",
    trigger: "auto_p2_processed",
    isDue: (session, schedule, now) => schedule.pathway === "p2" && isProcessedDue(session, schedule, now),
  },
];

function emptyCounts(): PathwayCounts {
  return { candidates: 0, deleted: 0, skipped: 0, failed: 0, failedSessionIds: [], fileCount: 0 };
}

async function sweepPathway(
  spec: PathwaySpec,
  opts: { now: Date; dryRun: boolean; batchSize: number; maxPerRun: number; onlySessionIds?: string[] },
): Promise<PathwayCounts> {
  const counts = emptyCounts();
  const cutoff = new Date(opts.now.getTime() - spec.delayMs);
  let afterId = "";

  while (counts.candidates < opts.maxPerRun) {
    const limit = Math.min(opts.batchSize, opts.maxPerRun - counts.candidates);
    const ids = await findCandidates(spec.kind, { cutoff, afterId, limit, onlySessionIds: opts.onlySessionIds });
    for (const sessionId of ids) {
      counts.candidates++;
      try {
        const input = await loadScheduleInput(sessionId);
        if (!input || !spec.isDue(input.session, deletionSchedule(input.session, input.orders), opts.now)) {
          counts.skipped++;
          continue;
        }
        const result = await deleteSessionAssets(sessionId, {
          scope: spec.scope,
          trigger: spec.trigger,
          actor: "system",
          dryRun: opts.dryRun,
        });
        counts.deleted++;
        counts.fileCount += result.fileCount;
      } catch (error) {
        counts.failed++;
        counts.failedSessionIds.push(sessionId);
        // Session id only: never log keys, names or emails here.
        console.error(
          `[gdpr] ${spec.kind}: session ${sessionId} FAILED:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    // Keyset pagination: markers aren't set in a dry run (or after a failure),
    // so re-querying from the start would return the same rows forever.
    if (ids.length < limit) break;
    afterId = ids[ids.length - 1]!;
  }
  return counts;
}

export async function runGdprSweep(options: SweepOptions = {}): Promise<SweepResult> {
  const now = options.now ?? new Date();
  const dryRun = env.GDPR_DELETION_DRY_RUN || options.dryRun === true;
  const common = {
    now,
    dryRun,
    batchSize: Math.max(1, options.batchSize ?? env.GDPR_SWEEP_BATCH_SIZE),
    maxPerRun: Math.max(1, options.maxPerRun ?? env.GDPR_SWEEP_MAX_PER_RUN),
    onlySessionIds: options.onlySessionIds,
  };

  const [p1, p2Raw, p2Processed] = [
    await sweepPathway(PATHWAYS[0]!, common),
    await sweepPathway(PATHWAYS[1]!, common),
    await sweepPathway(PATHWAYS[2]!, common),
  ];
  const result: SweepResult = { dryRun, now: now.toISOString(), p1, p2Raw, p2Processed };
  console.log(
    `[gdpr] sweep ${dryRun ? "(DRY RUN) " : ""}done: ` +
      `P1 ${p1.deleted}/${p1.candidates} (${p1.failed} failed), ` +
      `P2 raw ${p2Raw.deleted}/${p2Raw.candidates} (${p2Raw.failed} failed), ` +
      `P2 processed ${p2Processed.deleted}/${p2Processed.candidates} (${p2Processed.failed} failed), ` +
      `${p1.fileCount + p2Raw.fileCount + p2Processed.fileCount} file(s)${dryRun ? " would be" : ""} deleted.`,
  );
  return result;
}

export function totalFailed(result: SweepResult): number {
  return result.p1.failed + result.p2Raw.failed + result.p2Processed.failed;
}
