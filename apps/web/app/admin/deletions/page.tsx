"use client";
import { Suspense, useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  adminGet,
  adminPost,
  qs,
  SAFE_ID,
  type DeletionAuditRow,
  type DeletionKind,
  type ManualDeletionResult,
  type Paged,
  type ScheduledDeletion,
} from "@/lib/admin";
import { ConfirmModal } from "@/components/ConfirmModal";
import { errorMessage, formatDateTime, Notice, Pager, prettyStatus, TableState } from "@/components/admin/ui";

const KINDS: { value: DeletionKind; label: string }[] = [
  { value: "p1", label: "P1: raw photos, no order (24h after preview expiry)" },
  { value: "p2_raw", label: "P2: raw photos, delivered (24h after delivery)" },
  { value: "p2_processed", label: "P2: book files, delivered (30 days after delivery)" },
];

const TRIGGERS = ["auto_p1", "auto_p2_raw", "auto_p2_processed", "user", "admin"];
const SCOPES = [
  { value: "raw", label: "Raw photos only" },
  { value: "processed", label: "Book files only (pages, preview, print PDFs)" },
  { value: "all", label: "Everything for this session" },
] as const;
type Scope = (typeof SCOPES)[number]["value"];

// --- Scheduled -----------------------------------------------------------

function ScheduledDeletions() {
  const [kind, setKind] = useState<DeletionKind>("p1");
  const [withinDays, setWithinDays] = useState(7);
  const [items, setItems] = useState<ScheduledDeletion[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (after: string | null, append: boolean) => {
      setLoading(true);
      try {
        const page = await adminGet<{ items: ScheduledDeletion[]; nextCursor: string | null }>(
          `/api/admin/deletions/scheduled${qs({ kind, withinDays, cursor: after, limit: 25 })}`,
        );
        setItems((current) => (append ? [...current, ...page.items] : page.items));
        setCursor(page.nextCursor);
        setError(null);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [kind, withinDays],
  );

  useEffect(() => {
    setItems([]);
    void fetchPage(null, false);
  }, [fetchPage]);

  return (
    <section aria-labelledby="deletions-scheduled">
      <h2 id="deletions-scheduled" className="admin-section__title">
        Scheduled deletions
      </h2>
      <p className="admin-muted">
        From the same rules the sweeper uses. Overdue rows are deleted on the next sweep (or only logged, while
        GDPR_DELETION_DRY_RUN is on).
      </p>
      <div className="admin-filters">
        <div className="field">
          <label htmlFor="sched-kind">Pathway</label>
          <select id="sched-kind" value={kind} onChange={(e) => setKind(e.target.value as DeletionKind)}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="sched-days">Due within (days)</label>
          <select id="sched-days" value={withinDays} onChange={(e) => setWithinDays(Number(e.target.value))}>
            {[0, 1, 7, 14, 30, 60].map((d) => (
              <option key={d} value={d}>
                {d === 0 ? "overdue only" : d}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <caption className="visually-hidden">Scheduled deletions</caption>
          <thead>
            <tr>
              <th scope="col">Session</th>
              <th scope="col">Deletes</th>
              <th scope="col">Due</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            <TableState
              columns={4}
              loading={loading}
              error={error}
              empty={items.length === 0}
              emptyText="Nothing due in this window."
            />
            {!error &&
              items.map((item) => (
                <tr key={`${item.sessionId}:${item.scope}`}>
                  <td>
                    <Link href={`/admin/storage${qs({ session: item.sessionId })}`} className="admin-link mono-id">
                      {item.sessionId}
                    </Link>
                  </td>
                  <td>{item.scope === "raw" ? "raw photos" : "book files"}</td>
                  <td>{formatDateTime(item.dueAt)}</td>
                  <td>{item.overdue ? <span className="job-state job-state--failed">overdue</span> : "upcoming"}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {cursor && !error && (
        <div className="admin-actions">
          <button type="button" className="btn btn-ghost btn-small" disabled={loading} onClick={() => void fetchPage(cursor, true)}>
            {loading ? "Loading…" : "Load more"}
          </button>
          <span className="admin-muted" style={{ margin: 0 }}>
            {items.length} shown
          </span>
        </div>
      )}
    </section>
  );
}

// --- Audit log -----------------------------------------------------------

function AuditLog({ reloadKey }: { reloadKey: number }) {
  const empty = { trigger: "", outcome: "", sessionId: "", from: "", to: "" };
  const [draft, setDraft] = useState(empty);
  const [filters, setFilters] = useState(empty);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paged<DeletionAuditRow> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    adminGet<Paged<DeletionAuditRow>>(`/api/admin/deletions/audit${qs({ ...filters, page, limit: 25 })}`)
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setData(null);
          setError(errorMessage(e));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filters, page, reloadKey]);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setFilters({ ...draft, sessionId: draft.sessionId.trim() });
  }

  const rows = data?.items ?? [];
  const sessionInvalid = draft.sessionId.trim() !== "" && !SAFE_ID.test(draft.sessionId.trim());

  return (
    <section className="admin-section" aria-labelledby="deletions-audit">
      <h2 id="deletions-audit" className="admin-section__title">
        Deletion audit log
      </h2>
      <form className="admin-filters" onSubmit={onSubmit} aria-label="Filter the audit log">
        <div className="field">
          <label htmlFor="audit-trigger">Trigger</label>
          <select id="audit-trigger" value={draft.trigger} onChange={(e) => setDraft({ ...draft, trigger: e.target.value })}>
            <option value="">Any</option>
            {TRIGGERS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="audit-outcome">Outcome</label>
          <select id="audit-outcome" value={draft.outcome} onChange={(e) => setDraft({ ...draft, outcome: e.target.value })}>
            <option value="">Any</option>
            <option value="succeeded">succeeded</option>
            <option value="failed">failed</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="audit-session">Session id</label>
          <input
            id="audit-session"
            value={draft.sessionId}
            onChange={(e) => setDraft({ ...draft, sessionId: e.target.value })}
            aria-invalid={sessionInvalid}
            spellCheck={false}
          />
        </div>
        <div className="field">
          <label htmlFor="audit-from">From</label>
          <input id="audit-from" type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="audit-to">To</label>
          <input id="audit-to" type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
        </div>
        <button type="submit" className="btn btn-primary btn-small" disabled={sessionInvalid}>
          Apply
        </button>
      </form>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <caption className="visually-hidden">Deletion audit log, newest first</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Trigger</th>
              <th scope="col">Scope</th>
              <th scope="col">Session</th>
              <th scope="col" className="admin-table__num">
                Files
              </th>
              <th scope="col">Actor</th>
              <th scope="col">Outcome</th>
            </tr>
          </thead>
          <tbody>
            <TableState columns={7} loading={loading} error={error} empty={rows.length === 0} emptyText="No audit entries match." />
            {!error &&
              rows.map((r) => (
                <tr key={r.id}>
                  <td>{formatDateTime(r.createdAt)}</td>
                  <td>
                    {r.trigger}
                    {r.dryRun && <span className="admin-muted"> · dry run</span>}
                    {r.force && <span className="admin-count--alert"> · forced</span>}
                  </td>
                  <td>{r.scope}</td>
                  <td className="mono-id">{r.sessionId ?? "—"}</td>
                  <td className="admin-table__num">{r.fileCount}</td>
                  <td className="mono-id">{r.actor}</td>
                  <td>
                    <span className={`job-state job-state--${r.outcome === "failed" ? "failed" : "completed"}`}>{r.outcome}</span>
                    {r.error && <p className="admin-note">{r.error}</p>}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {data && <Pager page={data.page} limit={data.limit} total={data.total} onPage={setPage} />}
    </section>
  );
}

// --- Manual override ------------------------------------------------------

function ManualDeletion({ onDone }: { onDone: () => void }) {
  const params = useSearchParams();
  const [sessionId, setSessionId] = useState(params.get("session") ?? "");
  const [scope, setScope] = useState<Scope>("all");
  const [preview, setPreview] = useState<ManualDeletionResult | null>(null);
  const [force, setForce] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const id = sessionId.trim();
  const valid = SAFE_ID.test(id);
  // Any change to what would be deleted invalidates the preview.
  useEffect(() => {
    setPreview(null);
    setForce(false);
  }, [id, scope]);

  const url = `/api/admin/deletions/sessions/${encodeURIComponent(id)}`;

  async function dryRun(event: FormEvent) {
    event.preventDefault();
    setPreviewing(true);
    setError(null);
    setResult(null);
    try {
      setPreview(await adminPost<ManualDeletionResult>(url, { scope, confirm: "DELETE", dryRun: true }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPreviewing(false);
    }
  }

  async function deleteNow() {
    setBusy(true);
    setError(null);
    try {
      const done = await adminPost<ManualDeletionResult>(url, { scope, confirm: "DELETE", force });
      setConfirmOpen(false);
      setPreview(null);
      setResult(`Deleted ${done.fileCount} file(s) for session ${done.sessionId}${done.force ? " (forced)" : ""}. It's in the audit log below.`);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const holding = preview?.holdingOrders ?? [];
  const canDelete = !!preview && (holding.length === 0 || force);

  return (
    <section className="admin-section" aria-labelledby="deletions-manual">
      <h2 id="deletions-manual" className="admin-section__title">
        Delete a session&apos;s files now
      </h2>
      <p className="admin-muted">
        Manual override. It runs for real regardless of GDPR_DELETION_DRY_RUN, so preview first.
      </p>
      {result && <Notice kind="success">{result}</Notice>}
      <form className="admin-form" onSubmit={dryRun}>
        <div className="field">
          <label htmlFor="manual-session">Session id</label>
          <input
            id="manual-session"
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={id !== "" && !valid}
          />
        </div>
        <div className="field">
          <label htmlFor="manual-scope">What to delete</label>
          <select id="manual-scope" value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
            {SCOPES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-actions">
          <button type="submit" className="btn btn-ghost btn-small" disabled={!valid || previewing}>
            {previewing ? "Counting…" : "Preview (dry run)"}
          </button>
          <button
            type="button"
            className="btn btn-danger btn-small"
            disabled={!canDelete}
            onClick={() => {
              setError(null);
              setConfirmOpen(true);
            }}
          >
            Delete…
          </button>
        </div>
      </form>

      {error && !confirmOpen && <Notice kind="error">{error}</Notice>}

      {preview && (
        <div className={`admin-panel ${holding.length > 0 ? "admin-panel--warn" : ""}`} aria-live="polite">
          <p style={{ margin: 0 }}>
            Dry run: <strong>{preview.fileCount}</strong> file{preview.fileCount === 1 ? "" : "s"} would be deleted (
            {SCOPES.find((s) => s.value === scope)?.label.toLowerCase()}). The dry run is in the audit log.
          </p>
          {holding.length > 0 && (
            <>
              <p style={{ margin: "10px 0 6px" }}>
                <strong>This session is on an order still in progress:</strong>
              </p>
              <ul style={{ margin: "0 0 10px", paddingLeft: 18 }}>
                {holding.map((o) => (
                  <li key={o.id}>
                    <Link href={`/admin/orders/${o.id}`} className="admin-link mono-id">
                      {o.id}
                    </Link>{" "}
                    ({prettyStatus(o.status)})
                  </li>
                ))}
              </ul>
              <label className="admin-checkbox">
                <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
                Delete anyway (force). That book can&apos;t be re-rendered or reprinted afterwards.
              </label>
            </>
          )}
        </div>
      )}

      <ConfirmModal
        open={confirmOpen}
        title="Permanently delete these files?"
        confirmLabel="Delete files"
        danger
        requireText="DELETE"
        busy={busy}
        error={error}
        onConfirm={deleteNow}
        onCancel={() => setConfirmOpen(false)}
      >
        <p>
          Deletes about <strong>{preview?.fileCount ?? 0}</strong> file(s) from R2 for session{" "}
          <span className="mono-id">{id}</span> ({SCOPES.find((s) => s.value === scope)?.label.toLowerCase()}). This
          can&apos;t be undone.
        </p>
        {force && (
          <p>
            <strong>Forced:</strong> an order in progress uses this session. The override is recorded in the audit
            log.
          </p>
        )}
      </ConfirmModal>
    </section>
  );
}

// --- Sweep now -----------------------------------------------------------

function SweepNow({ onDone }: { onDone: () => void }) {
  const [dryRun, setDryRun] = useState(true);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const r = await adminPost<{ jobId: string | null; dryRun: boolean; effectiveDryRun: boolean }>(
        "/api/admin/deletions/sweep",
        { dryRun },
      );
      setOpen(false);
      setResult(
        `Sweep queued (job ${r.jobId ?? "?"}), ${r.effectiveDryRun ? "as a dry run" : "for real"}` +
          (r.effectiveDryRun && !r.dryRun ? " because GDPR_DELETION_DRY_RUN is on" : "") +
          ". It runs on the worker; results appear in the audit log and in the gdpr queue.",
      );
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-section" aria-labelledby="deletions-sweep">
      <h2 id="deletions-sweep" className="admin-section__title">
        Run the sweep now
      </h2>
      <p className="admin-muted">Runs Pathways 1 and 2 once, now, instead of waiting for the hourly schedule.</p>
      {result && <Notice kind="success">{result}</Notice>}
      <div className="admin-actions">
        <label className="admin-checkbox">
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          Dry run (log what would be deleted, delete nothing)
        </label>
        <button
          type="button"
          className={`btn btn-small ${dryRun ? "btn-primary" : "btn-danger"}`}
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
        >
          Run sweep now…
        </button>
      </div>
      <ConfirmModal
        open={open}
        title={dryRun ? "Run a dry-run sweep?" : "Run a real sweep?"}
        confirmLabel={dryRun ? "Run dry run" : "Run and delete"}
        danger={!dryRun}
        requireText={dryRun ? undefined : "DELETE"}
        busy={busy}
        error={error}
        onConfirm={run}
        onCancel={() => setOpen(false)}
      >
        {dryRun ? (
          <p>Queues one sweep that only records what it would delete. Nothing is deleted.</p>
        ) : (
          <p>
            Queues one sweep that <strong>permanently deletes</strong> every file that is due, unless
            GDPR_DELETION_DRY_RUN is on on the server (then it's still a dry run).
          </p>
        )}
      </ConfirmModal>
    </section>
  );
}

function DeletionsView() {
  // Bumped after a manual deletion or sweep so the audit log refetches.
  const [auditKey, setAuditKey] = useState(0);
  const bump = () => setAuditKey((k) => k + 1);
  return (
    <>
      <div className="admin-header">
        <div>
          <p className="eyebrow">Admin</p>
          <h1 className="page-title">Photo deletion</h1>
        </div>
      </div>
      <ManualDeletion onDone={bump} />
      <SweepNow onDone={bump} />
      <div className="admin-section">
        <ScheduledDeletions />
      </div>
      <AuditLog reloadKey={auditKey} />
    </>
  );
}

export default function AdminDeletionsPage() {
  return (
    <Suspense fallback={<p className="admin-muted">Loading…</p>}>
      <DeletionsView />
    </Suspense>
  );
}
