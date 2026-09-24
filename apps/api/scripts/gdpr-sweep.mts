// Runs ONE GDPR deletion sweep (Pathways 1 & 2) right now, in-process, with no
// Redis needed. The same code the hourly gdpr job runs (src/gdpr/sweeper.ts).
//
//   npm run gdpr:sweep -- --dry-run                       # report only, deletes nothing
//   npm run gdpr:sweep -- --dry-run --sessions id1,id2    # only these sessions
//   npm run gdpr:sweep -- --sessions id1,id2              # real, IF GDPR_DELETION_DRY_RUN=false
//
// Dry run is forced unless GDPR_DELETION_DRY_RUN is exactly "false" (in .env,
// or for one command in PowerShell: $env:GDPR_DELETION_DRY_RUN="false"), and
// --dry-run forces it on regardless. Either way every examined session gets a
// DeletionAuditLog row. Uses DATABASE_URL and R2_* from apps/api/.env, so it
// acts on whichever database and bucket those point at.
import { prisma } from "../src/db";
import { env } from "../src/env";
import { runGdprSweep, totalFailed } from "../src/gdpr/sweeper";

const args = process.argv.slice(2);
const forceDryRun = args.includes("--dry-run");
const sessionsIdx = args.indexOf("--sessions");
const onlySessionIds =
  sessionsIdx >= 0
    ? (args[sessionsIdx + 1] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

async function main(): Promise<number> {
  if (sessionsIdx >= 0 && (!onlySessionIds || onlySessionIds.length === 0)) {
    console.error("Usage: npm run gdpr:sweep -- [--dry-run] [--sessions id1,id2]");
    return 1;
  }
  const dryRun = env.GDPR_DELETION_DRY_RUN || forceDryRun;
  console.log(
    dryRun
      ? "DRY RUN: nothing will be deleted; audit rows record what would be."
      : "REAL RUN: due files WILL be permanently deleted.",
  );
  if (onlySessionIds) console.log(`Restricted to ${onlySessionIds.length} session(s).`);

  const result = await runGdprSweep({ dryRun: forceDryRun, onlySessionIds });
  console.log(JSON.stringify(result, null, 2));
  return totalFailed(result) > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
