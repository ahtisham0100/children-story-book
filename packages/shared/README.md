# packages/shared — placeholder, still EMPTY

> **Nothing was ever built here.** This directory contains only this README. It is kept
> as a slot for the future, not as a dependency — nothing imports it, and the workspace
> builds fine without it.

**Update (2026-08-30):** the original justification for deferring this — "an API-only
build has nothing to share *with*" — is no longer true. `apps/web` was built on this date
(cart/checkout/confirmation/track pages), so a second consumer now exists. It's still
*not* populated, deliberately: `apps/api` and `apps/web` are two independent npm projects
with no root workspace linking them, so a real shared package would need actual workspace
plumbing (npm/pnpm workspaces, a build step for the shared package) — a bigger structural
change than the handful of DTOs currently justify. `apps/web`'s `lib/pricing.ts` instead
hand-duplicates the couple of fields it needs from `apps/api`'s `catalog.ts`, explicitly
marked "display only, not the source of truth" in a comment there.

**Where those things actually live today, all in `apps/api`:**

| Planned to live here | Actually lives in |
|---|---|
| Session/Character status unions, pipeline step names | `src/pipeline/types.ts` |
| Order status vocabulary | `src/orderStatus.ts` |
| User-facing SSE copy strings | `src/messages.ts` |
| API request/response DTOs | `src/routes/*.ts` (TypeBox schemas, which also generate the OpenAPI docs) |

**Revisit this if type drift between `apps/api` and `apps/web` becomes a real, recurring
bug** (a response shape changes in one place and silently breaks the other) — that's the
actual condition that justifies the workspace-plumbing cost, not just "two consumers now
exist."
