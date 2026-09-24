import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { UNORDERED_STATUSES, type ScheduleOrder, type ScheduleSession } from "./schedule";

/**
 * The sweeper's indexed candidate queries. These are a COARSE pre-filter: the
 * sweeper re-checks every id against schedule.ts on freshly read rows before
 * deleting anything, so an over-broad query can never cause a wrong deletion.
 * An over-NARROW one would silently skip sessions, which is why each query
 * mirrors a schedule.ts rule closely.
 *
 * OrderItem.sessionId has no foreign key to Session, so these are raw SQL
 * (Prisma relations can't express the join). Indexes used: Session.expiresAt,
 * OrderItem.sessionId, Order.deliveredAt.
 */

export type CandidateKind = "p1" | "p2_raw" | "p2_processed";

export interface CandidateQuery {
  /** Rows due before this instant (now - delay). */
  cutoff: Date;
  /** Keyset pagination: only ids greater than this ("" for the first page). */
  afterId: string;
  limit: number;
  /** Restrict to these sessions (the manual gdpr:sweep --sessions flag). */
  onlySessionIds?: string[];
}

export async function findCandidates(kind: CandidateKind, q: CandidateQuery): Promise<string[]> {
  const only = q.onlySessionIds ? Prisma.sql`AND s.id = ANY(${q.onlySessionIds}::text[])` : Prisma.empty;

  let rows: { id: string }[];
  if (kind === "p1") {
    // Raw not yet deleted, expired more than 24h ago, and on no order that
    // counts as "ordered" (anything but awaiting_payment / cancelled).
    rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT s.id FROM "Session" s
      WHERE s."rawDeletedAt" IS NULL
        AND s."expiresAt" < ${q.cutoff}
        AND NOT EXISTS (
          SELECT 1 FROM "OrderItem" oi JOIN "Order" o ON o.id = oi."orderId"
          WHERE oi."sessionId" = s.id AND o.status NOT IN (${Prisma.join([...UNORDERED_STATUSES])})
        )
        AND s.id > ${q.afterId}
        ${only}
      ORDER BY s.id
      LIMIT ${q.limit}`;
  } else {
    // On at least one order delivered before the cutoff, with the relevant
    // marker unset. Holding orders (a reorder in production) are excluded by
    // the schedule.ts re-check, not here.
    const marker = kind === "p2_raw" ? Prisma.sql`s."rawDeletedAt"` : Prisma.sql`s."processedDeletedAt"`;
    rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT s.id FROM "Session" s
      JOIN "OrderItem" oi ON oi."sessionId" = s.id
      JOIN "Order" o ON o.id = oi."orderId"
      WHERE ${marker} IS NULL
        AND o."deliveredAt" < ${q.cutoff}
        AND s.id > ${q.afterId}
        ${only}
      ORDER BY s.id
      LIMIT ${q.limit}`;
  }
  return rows.map((r) => r.id);
}

/** Fresh read of everything schedule.ts needs for one session, or null if the row is gone. */
export async function loadScheduleInput(
  sessionId: string,
): Promise<{ session: ScheduleSession; orders: ScheduleOrder[] } | null> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { expiresAt: true, rawDeletedAt: true, processedDeletedAt: true },
  });
  if (!session) return null;
  const orders = await prisma.order.findMany({
    where: { items: { some: { sessionId } } },
    select: { status: true, deliveredAt: true },
  });
  return { session, orders };
}

/**
 * loadScheduleInput for many sessions in three queries instead of two per
 * session, for read-only views (the admin "scheduled deletions" table). Same
 * fields, so deletionSchedule() sees exactly what the sweeper would. The
 * sweeper itself keeps the per-session read: re-reading each session right
 * before deleting it is its safety check.
 */
export async function loadScheduleInputs(
  sessionIds: string[],
): Promise<Map<string, { session: ScheduleSession; orders: ScheduleOrder[] }>> {
  const result = new Map<string, { session: ScheduleSession; orders: ScheduleOrder[] }>();
  if (sessionIds.length === 0) return result;
  const sessions = await prisma.session.findMany({
    where: { id: { in: sessionIds } },
    select: { id: true, expiresAt: true, rawDeletedAt: true, processedDeletedAt: true },
  });
  const items = await prisma.orderItem.findMany({
    where: { sessionId: { in: sessionIds } },
    select: { sessionId: true, orderId: true },
  });
  const orders = await prisma.order.findMany({
    where: { id: { in: [...new Set(items.map((item) => item.orderId))] } },
    select: { id: true, status: true, deliveredAt: true },
  });
  const orderById = new Map(orders.map((o) => [o.id, { status: o.status, deliveredAt: o.deliveredAt }]));
  for (const { id, ...session } of sessions) {
    const orderIds = new Set(items.filter((item) => item.sessionId === id).map((item) => item.orderId));
    result.set(id, {
      session,
      orders: [...orderIds].map((orderId) => orderById.get(orderId)).filter((o): o is ScheduleOrder => o !== undefined),
    });
  }
  return result;
}
