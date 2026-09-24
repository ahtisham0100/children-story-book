import type { RepaintModel } from "./stages/repaint";

// Shared contract between the producer (queueStageRunner.ts, called from
// worker.ts) and the consumer (stage-worker.ts) — one BullMQ queue per stage,
// so each can be scaled, deployed, and kept warm independently. See
// docs/INFRA_AND_PIPELINE_TRACE.md for the full design.

export const STAGE_NAMES = ["repaint", "swap", "restore", "heal", "eyes"] as const;
export type StageName = (typeof STAGE_NAMES)[number];

export function stageQueueName(stage: StageName): string {
  return `stage-${stage}`;
}

// Application-level liveness signal for "is a worker for this stage actually
// connected right now" — deliberately NOT BullMQ's own Queue#getWorkers().
// getWorkers() introspects via Redis's CLIENT LIST, filtered by connection
// name — verified unreliable against this project's Upstash instance: a live,
// correctly-listening stage-worker (confirmed via its own boot log) was
// reported as "0 workers" by getWorkers(), and WHICH stage came back missing
// changed between runs with no code change — a CLIENT LIST/SETNAME visibility
// gap, not a real connectivity problem. A plain heartbeat key that each
// stage-worker refreshes itself sidesteps that entirely — it only depends on
// GET/SET, not on Redis exposing accurate cross-connection introspection.
export function heartbeatKey(stage: StageName): string {
  return `stage-worker:heartbeat:${stage}`;
}
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const HEARTBEAT_TTL_SECONDS = 30; // 3x the interval — tolerates one missed beat

export interface StageJobData {
  /** R2 key of this stage's input image. */
  inputKey: string;
  /** repaint + swap only — the child's photo (signed R2 URL in production). */
  photoUrl?: string;
  /** repaint only. */
  repaintModel?: RepaintModel;
  /** eyes only — R2 key of the pre-swap repaint output, to blend eyes back from. */
  repaintedKey?: string;
}

export interface StageJobResult {
  /** R2 key of this stage's output image. */
  outputKey: string;
}
