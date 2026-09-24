import type { PipelineStep } from "./pipeline/types";
import type { Stage } from "./pipeline/personalize";

// User-facing SSE copy.
export const STEP_MESSAGES: Record<PipelineStep, string> = {
  validate: "Checking your photo…",
  render: "Building your story pages…",
};

// Per-page, per-stage copy for the "render" step — lets a client show what's
// actually happening on a specific page instead of one generic line for the
// whole batch.
export const STAGE_MESSAGES: Record<Stage, string> = {
  repaint: "Repainting the scene…",
  swap: "Matching the face…",
  restore: "Blending…",
  heal: "Cleaning up…",
  eyes: "Finishing the eyes…",
};
