"use client";
import { useCallback, useEffect, useId, useState } from "react";
import Link from "next/link";
import { adminGet, adminPost, qs, type AdminOrderDetail } from "@/lib/admin";
import { formatMoney } from "@/lib/pricing";
import { ConfirmModal } from "@/components/ConfirmModal";
import { errorMessage, formatDateTime, Notice, prettyStatus } from "@/components/admin/ui";

const SOURCE_LABELS: Record<string, string> = {
  system: "fulfilment",
  stripe_webhook: "Stripe",
  gelato_webhook: "Gelato webhook",
  gelato_sync: "Gelato sync",
  admin: "admin",
  gdpr_account_deletion: "account deletion",
};

// Fetched client-side (see app/track/[orderId]/page.tsx for why).
export default function AdminOrderPage({ params }: { params: { id: string } }) {
  const [order, setOrder] = useState<AdminOrderDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const [nextStatus, setNextStatus] = useState("");
  const [note, setNote] = useState("");
  const [statusOpen, setStatusOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const formId = useId();

  const load = useCallback(async () => {
    try {
      const detail = await adminGet<AdminOrderDetail>(`/api/admin/orders/${encodeURIComponent(params.id)}`);
      setOrder(detail);
      setNextStatus((current) => (detail.allowedTransitions.includes(current) ? current : (detail.allowedTransitions[0] ?? "")));
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, [params.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<string>, close: () => void) {
    setBusy(true);
    setActionError(null);
    try {
      const message = await action();
      close();
      setFlash(message);
      await load();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const changeStatus = () =>
    run(async () => {
      const result = await adminPost<{ status: string }>(`/api/admin/orders/${params.id}/status`, {
        status: nextStatus,
        note: note.trim(),
      });
      setNote("");
      return `Status changed to "${prettyStatus(result.status)}".`;
    }, () => setStatusOpen(false));

  const syncFromGelato = () =>
    run(async () => {
      const result = await adminPost<{ gelatoStatus: string; applied: boolean; status: string }>(
        `/api/admin/orders/${params.id}/gelato-sync`,
      );
      return result.applied
        ? `Gelato reports "${result.gelatoStatus}"; the order is now "${prettyStatus(result.status)}".`
        : `Gelato reports "${result.gelatoStatus}", which isn't a status we recognise. It was recorded in the timeline; the order's status is unchanged.`;
    }, () => setSyncOpen(false));

  if (loadError) {
    return (
      <>
        <p className="eyebrow">
          <Link href="/admin/orders">← Orders</Link>
        </p>
        <Notice kind="error">{loadError}</Notice>
      </>
    );
  }
  if (!order) return <p className="admin-muted" aria-live="polite">Loading order…</p>;

  const job = order.fulfillmentJob;

  return (
    <>
      <p className="eyebrow">
        <Link href="/admin/orders">← Orders</Link>
      </p>
      <div className="admin-header">
        <div>
          <h1 className="page-title">
            Order <span className="mono-id">{order.id}</span>
          </h1>
          <p className="admin-muted">
            Created {formatDateTime(order.createdAt)} ·{" "}
            <span className={`status-pill status-pill--${order.status}`}>{prettyStatus(order.status)}</span>
          </p>
        </div>
      </div>

      {flash && <Notice kind="success">{flash}</Notice>}
      {order.gelatoUnknownOutcome && (
        <Notice kind="error">
          A Gelato submission started {formatDateTime(order.gelatoSubmitStartedAt)} has an unknown outcome. Open the{" "}
          <Link href={`/admin/queues${qs({ queue: "fulfillment", state: "failed", job: order.id })}`} className="account-order__link">
            failed fulfilment job
          </Link>{" "}
          to reconcile it.
        </Notice>
      )}

      <div className="admin-grid-2">
        <section className="admin-panel" aria-labelledby="order-customer">
          <h2 id="order-customer" className="admin-panel__title">
            Customer and shipping
          </h2>
          <dl className="admin-dl">
            <dt>Email</dt>
            <dd>{order.anonymisedAt ? <em>anonymised {formatDateTime(order.anonymisedAt)}</em> : order.email}</dd>
            <dt>Ship to</dt>
            <dd>
              {order.anonymisedAt ? (
                <em>removed</em>
              ) : (
                <>
                  {order.shipping.name}
                  <br />
                  {order.shipping.line1}
                  {order.shipping.line2 && (
                    <>
                      <br />
                      {order.shipping.line2}
                    </>
                  )}
                  <br />
                  {order.shipping.postalCode} {order.shipping.city}
                </>
              )}
              <br />
              {order.shipping.country}
            </dd>
            <dt>Total</dt>
            <dd>{formatMoney(order.totalCents, order.currency)}</dd>
            <dt>Stripe</dt>
            <dd className="mono-id">{order.stripePaymentIntentId ?? "—"}</dd>
          </dl>
        </section>

        <section className="admin-panel" aria-labelledby="order-fulfilment">
          <h2 id="order-fulfilment" className="admin-panel__title">
            Fulfilment
          </h2>
          <dl className="admin-dl">
            <dt>Gelato order</dt>
            <dd className="mono-id">{order.gelatoOrderId ?? "—"}</dd>
            <dt>Submit started</dt>
            <dd>{formatDateTime(order.gelatoSubmitStartedAt)}</dd>
            <dt>Delivered</dt>
            <dd>{formatDateTime(order.deliveredAt)}</dd>
            <dt>Fulfilment job</dt>
            <dd>
              {job ? (
                <>
                  <span className={`job-state job-state--${job.state}`}>{job.state}</span> · {job.attemptsMade} attempt
                  {job.attemptsMade === 1 ? "" : "s"} ·{" "}
                  <Link
                    href={`/admin/queues${qs({ queue: "fulfillment", state: job.state, job: order.id })}`}
                    className="account-order__link"
                  >
                    open job
                  </Link>
                  {job.failedReason && <p className="admin-note">{job.failedReason}</p>}
                </>
              ) : (
                "none in the queue"
              )}
            </dd>
          </dl>
          <button
            type="button"
            className="btn btn-ghost btn-small"
            disabled={!order.gelatoOrderId}
            title={order.gelatoOrderId ? undefined : "Not submitted to Gelato yet"}
            onClick={() => {
              setActionError(null);
              setSyncOpen(true);
            }}
          >
            Sync from Gelato…
          </button>
        </section>
      </div>

      <section className="admin-section" aria-labelledby="order-items">
        <h2 id="order-items" className="admin-section__title">
          Items
        </h2>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">Book</th>
                <th scope="col">Session</th>
                <th scope="col">Print PDF</th>
                <th scope="col" className="admin-table__num">
                  Price
                </th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((item) => (
                <tr key={item.id}>
                  <td>{item.bookTitle}</td>
                  <td>
                    <Link href={`/admin/storage${qs({ session: item.sessionId })}`} className="admin-link mono-id">
                      {item.sessionId}
                    </Link>
                  </td>
                  <td>{item.hasPrintPdf ? "stored" : "—"}</td>
                  <td className="admin-table__num">{formatMoney(item.priceCents, order.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="admin-grid-2 admin-section">
        <section aria-labelledby="order-timeline">
          <h2 id="order-timeline" className="admin-section__title">
            Status timeline
          </h2>
          {order.statusEvents.length === 0 ? (
            <p className="admin-muted">No status events.</p>
          ) : (
            <ol className="track-timeline">
              {order.statusEvents.map((e, i) => (
                <li key={i} className="track-timeline__item">
                  <p className="track-timeline__status">{prettyStatus(e.status)}</p>
                  <p className="track-timeline__time">
                    {formatDateTime(e.createdAt)} · {SOURCE_LABELS[e.source] ?? e.source}
                  </p>
                  {e.note && <p className="admin-note">&ldquo;{e.note}&rdquo;</p>}
                </li>
              ))}
            </ol>
          )}
        </section>

        <section aria-labelledby={`${formId}-title`}>
          <h2 id={`${formId}-title`} className="admin-section__title">
            Change status
          </h2>
          {order.allowedTransitions.length === 0 ? (
            <p className="admin-muted">
              &ldquo;{prettyStatus(order.status)}&rdquo; is final: it can&apos;t be changed by hand.
            </p>
          ) : (
            <form
              className="admin-form"
              onSubmit={(e) => {
                e.preventDefault();
                setActionError(null);
                setStatusOpen(true);
              }}
            >
              <p className="admin-muted">
                Only the changes allowed from &ldquo;{prettyStatus(order.status)}&rdquo; are offered. Use this when a
                Gelato update never arrived.
              </p>
              <div className="field">
                <label htmlFor={`${formId}-status`}>New status</label>
                <select id={`${formId}-status`} value={nextStatus} onChange={(e) => setNextStatus(e.target.value)}>
                  {order.allowedTransitions.map((s) => (
                    <option key={s} value={s}>
                      {prettyStatus(s)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor={`${formId}-note`}>Note (kept in the timeline and audit log)</label>
                <textarea id={`${formId}-note`} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
              </div>
              <button type="submit" className="btn btn-primary btn-small" disabled={!nextStatus}>
                Change status…
              </button>
            </form>
          )}
        </section>
      </div>

      <ConfirmModal
        open={statusOpen}
        title={`Change status to "${prettyStatus(nextStatus)}"?`}
        confirmLabel="Change status"
        danger={nextStatus === "cancelled" || nextStatus === "failed"}
        busy={busy}
        error={actionError}
        onConfirm={changeStatus}
        onCancel={() => setStatusOpen(false)}
      >
        <p>
          From &ldquo;{prettyStatus(order.status)}&rdquo; to &ldquo;{prettyStatus(nextStatus)}&rdquo;. Recorded in the
          timeline and the admin audit log{note.trim() ? " with your note" : ""}.
        </p>
        {nextStatus === "delivered" && (
          <p>
            <strong>This starts the photo-deletion clock:</strong> raw photos are deleted 24 hours after delivery, book
            files after 30 days.
          </p>
        )}
        {nextStatus === "cancelled" && order.status !== "awaiting_payment" && (
          <p>
            <strong>This doesn&apos;t refund the customer</strong> (do that in Stripe) or cancel anything at Gelato.
          </p>
        )}
      </ConfirmModal>

      <ConfirmModal
        open={syncOpen}
        title="Sync status from Gelato?"
        confirmLabel="Sync now"
        busy={busy}
        error={actionError}
        onConfirm={syncFromGelato}
        onCancel={() => setSyncOpen(false)}
      >
        <p>
          Reads order <span className="mono-id">{order.gelatoOrderId}</span> from Gelato and applies its status exactly
          as the Gelato webhook would, adding an event to the timeline.
        </p>
      </ConfirmModal>
    </>
  );
}
