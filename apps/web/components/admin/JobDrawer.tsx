"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { ApiError } from "@/lib/api";
import { adminGet, adminPost, type JobDetail } from "@/lib/admin";
import { useDialog } from "@/components/useDialog";
import { ConfirmModal } from "@/components/ConfirmModal";
import { errorMessage, formatDateTime, Notice } from "./ui";

function orderIdOf(job: JobDetail): string | null {
  const data = job.data as { orderId?: unknown } | null;
  return job.queue === "fulfillment" && typeof data?.orderId === "string" ? data.orderId : null;
}

/**
 * "Gelato submission has an unknown outcome": a job retry alone would stop
 * again, so the admin first says whether Gelato has the order
 * (POST /api/admin/orders/:id/gelato-reconcile), which then retries.
 */
function ReconcileForm({ orderId, onDone }: { orderId: string; onDone: (message: string) => void }) {
  const [mode, setMode] = useState<"exists" | "missing">("exists");
  const [gelatoOrderId, setGelatoOrderId] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const validId = /^[A-Za-z0-9_-]{1,100}$/.test(gelatoOrderId.trim());

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const body = mode === "exists" ? { gelatoOrderId: gelatoOrderId.trim() } : { clearSubmitMarker: true };
      const result = await adminPost<{ fulfillment: string; order: { status: string } }>(
        `/api/admin/orders/${orderId}/gelato-reconcile`,
        body,
      );
      setConfirming(false);
      onDone(`Reconciled. Order is now "${result.order.status}"; fulfilment ${result.fulfillment.replace(/_/g, " ")}.`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-panel admin-panel--warn" aria-labelledby={`${inputId}-title`}>
      <h3 id={`${inputId}-title`} className="admin-panel__title">
        Reconcile with Gelato first
      </h3>
      <p className="admin-muted">
        A previous attempt called Gelato and the outcome is unknown, so retrying alone would stop again. Search
        Gelato&apos;s dashboard for order reference <span className="mono-id">{orderId}</span>, then:
      </p>
      <fieldset className="admin-radio-group">
        <legend className="visually-hidden">Does Gelato have this order?</legend>
        <label className="admin-radio">
          <input type="radio" name={`${inputId}-mode`} checked={mode === "exists"} onChange={() => setMode("exists")} />
          It exists at Gelato: record its Gelato order id
        </label>
        {mode === "exists" && (
          <div className="field admin-field-inline">
            <label htmlFor={inputId}>Gelato order id</label>
            <input
              id={inputId}
              value={gelatoOrderId}
              onChange={(e) => setGelatoOrderId(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        )}
        <label className="admin-radio">
          <input type="radio" name={`${inputId}-mode`} checked={mode === "missing"} onChange={() => setMode("missing")} />
          It doesn&apos;t exist at Gelato: clear the marker so fulfilment submits again
        </label>
      </fieldset>
      <button
        type="button"
        className="btn btn-primary btn-small"
        disabled={mode === "exists" && !validId}
        onClick={() => setConfirming(true)}
      >
        Reconcile and retry…
      </button>
      <ConfirmModal
        open={confirming}
        title={mode === "exists" ? "Record the Gelato order and retry?" : "Clear the marker and resubmit?"}
        confirmLabel={mode === "exists" ? "Record and retry" : "Clear and resubmit"}
        danger={mode === "missing"}
        busy={busy}
        error={error}
        onConfirm={submit}
        onCancel={() => setConfirming(false)}
      >
        {mode === "exists" ? (
          <p>
            Records Gelato order <span className="mono-id">{gelatoOrderId.trim()}</span>, moves the order to
            &ldquo;submitted to print&rdquo; and retries fulfilment, which then skips the Gelato step and sends the
            confirmation email if it hasn&apos;t gone yet.
          </p>
        ) : (
          <p>
            <strong>Only do this if you&apos;ve checked Gelato has no order for this reference.</strong> Fulfilment
            will submit the order to Gelato again. If Gelato does have it, the customer gets two books.
          </p>
        )}
      </ConfirmModal>
    </section>
  );
}

export function JobDrawer({
  queue,
  jobId,
  onClose,
  onChanged,
}: {
  queue: string;
  jobId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [job, setJob] = useState<JobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryOpen, setRetryOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useDialog(dialogRef, true, onClose);

  const load = useCallback(async () => {
    try {
      setJob(await adminGet<JobDetail>(`/api/admin/queues/${encodeURIComponent(queue)}/jobs/${encodeURIComponent(jobId)}`));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [queue, jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function retry() {
    setBusy(true);
    setRetryError(null);
    try {
      await adminPost(`/api/admin/queues/${encodeURIComponent(queue)}/jobs/${encodeURIComponent(jobId)}/retry`);
      setRetryOpen(false);
      setDone("Retry queued. The job is back in the waiting list.");
      onChanged();
      await load();
    } catch (e) {
      const unknownOutcome = e instanceof ApiError && (e.body as { code?: string } | null)?.code === "gelato_unknown_outcome";
      setRetryError(unknownOutcome ? `${errorMessage(e)} Use the reconcile form below.` : errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const orderId = job ? orderIdOf(job) : null;

  return (
    <div
      className="admin-drawer__backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={dialogRef} className="admin-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="admin-drawer__header">
          <div>
            <p className="eyebrow">{queue} job</p>
            <h2 id={titleId} className="admin-drawer__title mono-id">
              {jobId}
            </h2>
          </div>
          <button type="button" className="preview-modal__close" onClick={onClose} aria-label="Close job details">
            ×
          </button>
        </div>

        {error && <Notice kind="error">{error}</Notice>}
        {!job && !error && <p className="admin-muted">Loading…</p>}

        {job && (
          <>
            {done && <Notice kind="success">{done}</Notice>}
            <dl className="admin-dl">
              <dt>State</dt>
              <dd>
                <span className={`job-state job-state--${job.state}`}>{job.state}</span>
              </dd>
              <dt>Name</dt>
              <dd>{job.name}</dd>
              <dt>Attempts</dt>
              <dd>
                {job.attemptsMade} of {job.maxAttempts}
              </dd>
              <dt>Created</dt>
              <dd>{formatDateTime(job.timestamp)}</dd>
              <dt>Started</dt>
              <dd>{formatDateTime(job.processedOn)}</dd>
              <dt>Finished</dt>
              <dd>{formatDateTime(job.finishedOn)}</dd>
              {orderId && (
                <>
                  <dt>Order</dt>
                  <dd>
                    <Link href={`/admin/orders/${orderId}`} className="account-order__link">
                      {orderId}
                    </Link>
                  </dd>
                </>
              )}
            </dl>

            {job.failedReason && (
              <section className="admin-panel admin-panel--error" aria-label="Error">
                <h3 className="admin-panel__title">Error</h3>
                <p className="admin-error-message">{job.failedReason}</p>
              </section>
            )}

            {job.stacktrace.length > 0 && (
              <section aria-label="Stack trace">
                <h3 className="admin-panel__title">Stack trace ({job.stacktrace.length})</h3>
                <pre className="admin-pre" tabIndex={0}>
                  {job.stacktrace.join("\n\n")}
                </pre>
              </section>
            )}

            <section aria-label="Job data">
              <h3 className="admin-panel__title">Data</h3>
              <pre className="admin-pre admin-pre--short" tabIndex={0}>
                {JSON.stringify(job.data, null, 2)}
              </pre>
            </section>

            {job.returnvalue !== null && job.returnvalue !== undefined && (
              <section aria-label="Return value">
                <h3 className="admin-panel__title">Return value</h3>
                <pre className="admin-pre admin-pre--short" tabIndex={0}>
                  {JSON.stringify(job.returnvalue, null, 2)}
                </pre>
              </section>
            )}

            {job.state === "failed" && (
              <div className="admin-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-small"
                  onClick={() => {
                    setRetryError(null);
                    setRetryOpen(true);
                  }}
                >
                  Retry job…
                </button>
              </div>
            )}

            {job.state === "failed" && job.gelatoUnknownOutcome && orderId && (
              <ReconcileForm
                orderId={orderId}
                onDone={(message) => {
                  setDone(message);
                  onChanged();
                  void load();
                }}
              />
            )}

            <ConfirmModal
              open={retryOpen}
              title="Retry this job?"
              confirmLabel="Retry"
              busy={busy}
              error={retryError}
              onConfirm={retry}
              onCancel={() => setRetryOpen(false)}
            >
              <p>
                Moves <span className="mono-id">{jobId}</span> back to the waiting list with a fresh set of attempts.
                {job.queue === "fulfillment" &&
                  " Every fulfilment step skips work that's already done. A failed order goes back to \"paid\" so it can move on when the retry succeeds."}
              </p>
            </ConfirmModal>
          </>
        )}
      </div>
    </div>
  );
}
