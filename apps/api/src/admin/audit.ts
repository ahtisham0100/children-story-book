import type { Prisma } from "@prisma/client";
import { prisma } from "../db";

export type AdminAction = "job.retry" | "order.status" | "order.gelato_sync" | "order.gelato_reconcile" | "gdpr.sweep";

export interface AdminActionEntry {
  adminId: string;
  action: AdminAction;
  targetType: "job" | "order" | "queue";
  targetId: string;
  /** Only the fields the action changed. Never emails or addresses. */
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  note?: string;
}

/**
 * Records one state-changing admin action (AdminActionLog). Deletions are
 * audited separately, in DeletionAuditLog with trigger "admin", by
 * deleteSessionAssets itself.
 */
export async function logAdminAction(entry: AdminActionEntry): Promise<void> {
  await prisma.adminActionLog.create({
    data: {
      adminId: entry.adminId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      before: entry.before,
      after: entry.after,
      note: entry.note || null,
    },
  });
}
