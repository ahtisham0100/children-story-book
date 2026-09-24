import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { deleteObjects, listObjectKeys, objectExists } from "../storage";

/**
 * THE deletion primitive for GDPR photo deletion. Every pathway (the P1/P2
 * sweeper, the customer's DELETE /api/account/my-data, the admin
 * override) goes through here, so the guarantees hold everywhere:
 *
 *  - Finds objects two ways: by LISTING the session's own R2 prefixes (catches
 *    orphans, e.g. a raw.png issued by upload-url but never confirmed) AND by
 *    the keys stored in the DB.
 *  - R2 first, DB second. Markers (rawDeletedAt/processedDeletedAt) and nulled
 *    key columns are written only after R2 confirms the objects are gone, so a
 *    failure anywhere leaves the session "not deleted" and the next run retries.
 *  - Idempotent: re-running on a deleted session succeeds with fileCount 0.
 *  - Exactly one DeletionAuditLog row per call: success, dry run or failure.
 *  - Never deletes a key outside this session's own prefixes, whatever the DB
 *    says: a corrupt or hostile key column can't reach another customer's files.
 *
 * Key layout (see the inventory in the design spec):
 *   raw        sessions/<sid>/characters/<cid>/raw.<ext>
 *   processed  sessions/<sid>/pages/<page>.png   (previewKey is one of these)
 *              orders/<oid>/items/<iid>/print.pdf (outside the session prefix,
 *              reached through OrderItem.sessionId)
 */

export type DeletionScope = "raw" | "processed" | "all";
export type DeletionTrigger = "auto_p1" | "auto_p2_raw" | "auto_p2_processed" | "user" | "admin";

export interface DeleteSessionAssetsOptions {
  scope: DeletionScope;
  trigger: DeletionTrigger;
  /** customerId, admin customerId, or "system". Never an email. */
  actor: string;
  dryRun: boolean;
  /** Admin override of the "held by an order in production" refusal; recorded in the audit row. */
  force?: boolean;
}

export interface DeleteSessionAssetsResult {
  sessionId: string;
  scope: DeletionScope;
  /** Objects deleted (or, in a dry run, that would be). */
  fileCount: number;
  dryRun: boolean;
}

export class GdprDeletionError extends Error {
  constructor(
    message: string,
    /** Objects actually deleted before the failure. */
    readonly deletedCount: number,
  ) {
    super(message);
    this.name = "GdprDeletionError";
  }
}

// Ids become R2 key prefixes, so they must not contain "/" or be empty: an id
// of "" would turn `sessions/<id>/` into `sessions//` and a "/" could reach a
// different session's folder. Real ids are UUIDs (seeded ones gdpr-test-<uuid>).
// Exported so the admin routes validate ids the same way before listing or deleting.
export const SAFE_ID = /^[A-Za-z0-9-]+$/;

const includesRaw = (scope: DeletionScope) => scope === "raw" || scope === "all";
const includesProcessed = (scope: DeletionScope) => scope === "processed" || scope === "all";

interface SnapshotEntry {
  rawKey?: unknown;
  [k: string]: unknown;
}

function snapshotRawKeys(snapshot: Prisma.JsonValue): string[] {
  if (!Array.isArray(snapshot)) return [];
  return snapshot
    .map((entry) => (entry && typeof entry === "object" ? (entry as SnapshotEntry).rawKey : undefined))
    .filter((key): key is string => typeof key === "string" && key.length > 0);
}

function stringKeys(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.filter((k): k is string => typeof k === "string" && k.length > 0) : [];
}

function withRawKeysNulled(snapshot: Prisma.JsonValue): Prisma.InputJsonValue | undefined {
  if (!Array.isArray(snapshot)) return undefined;
  return snapshot.map((entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry) ? { ...entry, rawKey: null } : entry,
  ) as Prisma.InputJsonValue;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

async function writeAudit(
  client: Pick<typeof prisma, "deletionAuditLog">,
  sessionId: string | null,
  options: DeleteSessionAssetsOptions,
  fileCount: number,
  outcome: "succeeded" | "failed",
  error: string | null = null,
) {
  await client.deletionAuditLog.create({
    data: {
      trigger: options.trigger,
      scope: options.scope,
      sessionId,
      fileCount,
      actor: options.actor,
      dryRun: options.dryRun,
      force: options.force ?? false,
      outcome,
      error,
    },
  });
}

export async function deleteSessionAssets(
  sessionId: string,
  options: DeleteSessionAssetsOptions,
): Promise<DeleteSessionAssetsResult> {
  const { scope, dryRun } = options;

  if (!SAFE_ID.test(sessionId)) {
    await writeAudit(prisma, null, options, 0, "failed", "invalid session id");
    throw new GdprDeletionError(`Refusing to delete: invalid session id.`, 0);
  }

  let deletedCount = 0;
  try {
    const session = await prisma.session.findUnique({ where: { id: sessionId }, include: { characters: true } });
    const items = await prisma.orderItem.findMany({
      where: { sessionId },
      select: { id: true, orderId: true, configSnapshot: true, printPageKeys: true, printPdfKey: true },
    });
    for (const item of items) {
      if (!SAFE_ID.test(item.orderId) || !SAFE_ID.test(item.id)) {
        throw new GdprDeletionError(`Refusing to delete: order item ${item.id} has an unsafe id.`, 0);
      }
    }

    // Everything this session owns lives under one of these. Nothing else may
    // be deleted, whatever a DB column says.
    const sessionPrefix = `sessions/${sessionId}/`;
    const itemPrefixes = items.map((item) => `orders/${item.orderId}/items/${item.id}/`);
    const ownPrefixes = [sessionPrefix, ...itemPrefixes];

    const listPrefixes =
      scope === "all"
        ? ownPrefixes
        : [
            ...(includesRaw(scope) ? [`${sessionPrefix}characters/`] : []),
            ...(includesProcessed(scope) ? [`${sessionPrefix}pages/`, ...itemPrefixes] : []),
          ];

    const dbKeys = new Set<string>();
    if (includesRaw(scope)) {
      for (const c of session?.characters ?? []) if (c.rawKey) dbKeys.add(c.rawKey);
      for (const item of items) snapshotRawKeys(item.configSnapshot).forEach((k) => dbKeys.add(k));
    }
    if (includesProcessed(scope)) {
      if (session?.previewKey) dbKeys.add(session.previewKey);
      for (const item of items) {
        stringKeys(item.printPageKeys).forEach((k) => dbKeys.add(k));
        if (item.printPdfKey) dbKeys.add(item.printPdfKey);
      }
    }
    const outside = [...dbKeys].filter((key) => !ownPrefixes.some((prefix) => key.startsWith(prefix)));
    if (outside.length > 0) {
      throw new GdprDeletionError(
        `Refusing to delete: ${outside.length} stored key(s) point outside session ${sessionId}'s own prefixes.`,
        0,
      );
    }

    const listed = new Set((await Promise.all(listPrefixes.map(listObjectKeys))).flat());
    // A stored key that the listing didn't return is either already gone or
    // outside the listed sub-prefix (e.g. an old layout). Count it only if it
    // still exists.
    const dbOnly = [...dbKeys].filter((key) => !listed.has(key));
    const dbOnlyExisting = (
      await Promise.all(dbOnly.map(async (key) => ((await objectExists(key)) ? key : null)))
    ).filter((key): key is string => key !== null);
    const toDelete = [...listed, ...dbOnlyExisting];

    if (dryRun) {
      await writeAudit(prisma, sessionId, options, toDelete.length, "succeeded");
      return { sessionId, scope, fileCount: toDelete.length, dryRun };
    }

    if (toDelete.length > 0) {
      const result = await deleteObjects(toDelete);
      deletedCount = result.deleted.length;
      if (result.errors.length > 0) {
        throw new GdprDeletionError(
          `R2 refused to delete ${result.errors.length} of ${toDelete.length} object(s): ${result.errors[0]!.message}`,
          deletedCount,
        );
      }
    }

    // Trust but verify: anything still there (a concurrent upload, an R2
    // hiccup) means the session is NOT clean, so no marker gets set.
    const remaining = [
      ...(await Promise.all(listPrefixes.map(listObjectKeys))).flat(),
      ...(await Promise.all(dbOnlyExisting.map(async (key) => ((await objectExists(key)) ? key : null)))).filter(
        (key): key is string => key !== null,
      ),
    ];
    if (remaining.length > 0) {
      throw new GdprDeletionError(
        `${remaining.length} object(s) still present in R2 after deletion; markers left unset for retry.`,
        deletedCount,
      );
    }

    const now = new Date();
    // Explicit timeout: one write per order item, and Prisma's 5s default is
    // too tight against a remote database (see accountDeletion.ts).
    await prisma.$transaction(async (tx) => {
      if (includesRaw(scope) && session) {
        await tx.character.updateMany({ where: { sessionId }, data: { rawKey: null } });
      }
      for (const item of items) {
        const data: Prisma.OrderItemUpdateInput = {};
        if (includesRaw(scope)) {
          const nulled = withRawKeysNulled(item.configSnapshot);
          if (nulled !== undefined) data.configSnapshot = nulled;
        }
        if (includesProcessed(scope)) data.printPdfKey = null;
        if (Object.keys(data).length > 0) await tx.orderItem.update({ where: { id: item.id }, data });
      }
      if (session) {
        const data: Prisma.SessionUpdateInput = {};
        if (includesRaw(scope)) data.rawDeletedAt = session.rawDeletedAt ?? now;
        if (includesProcessed(scope)) {
          data.processedDeletedAt = session.processedDeletedAt ?? now;
          data.previewKey = null;
        }
        await tx.session.update({ where: { id: sessionId }, data });
      }
      await writeAudit(tx, sessionId, options, deletedCount, "succeeded");
    }, { maxWait: 10_000, timeout: 30_000 });

    return { sessionId, scope, fileCount: deletedCount, dryRun };
  } catch (error) {
    const deleted = error instanceof GdprDeletionError ? error.deletedCount : deletedCount;
    try {
      await writeAudit(prisma, sessionId, options, deleted, "failed", errorMessage(error));
    } catch (auditError) {
      // Don't let an audit-write failure mask the real error.
      console.error(`[gdpr] session ${sessionId}: failed to write the failure audit row:`, errorMessage(auditError));
    }
    throw error;
  }
}
