"use client";
import { Suspense, useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  adminGet,
  qs,
  SAFE_ID,
  type SessionStorage,
  type StorageCategory,
  type StorageSummary,
} from "@/lib/admin";
import { errorMessage, formatBytes, formatDateTime, Notice, prettyStatus, TableState } from "@/components/admin/ui";

const CATEGORY_LABELS: Record<StorageCategory, { label: string; hint: string }> = {
  raw: { label: "Raw uploads", hint: "children's photos" },
  processed: { label: "Processed pages", hint: "rendered pages and previews" },
  printPdf: { label: "Print PDFs", hint: "one per ordered book" },
  other: { label: "Other", hint: "stage scratch files and anything else" },
};

function SummaryCards() {
  const [summary, setSummary] = useState<StorageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    try {
      setSummary(await adminGet<StorageSummary>(`/api/admin/storage/summary${refresh ? "?refresh=1" : ""}`));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  return (
    <section aria-labelledby="storage-summary">
      <div className="admin-actions">
        <h2 id="storage-summary" className="admin-section__title" style={{ margin: 0 }}>
          Usage by category
        </h2>
        <button type="button" className="btn btn-ghost btn-small" onClick={() => void load(true)} disabled={loading}>
          {loading ? "Counting…" : "Refresh"}
        </button>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {summary && (
        <>
          <p className="admin-muted" aria-live="polite">
            Computed {formatDateTime(summary.computedAt)}
            {summary.cached ? " (cached; results are kept for 10 minutes, Refresh recounts)" : ""} ·{" "}
            {summary.total.count} objects, {formatBytes(summary.total.bytes)} in total
          </p>
          <div className="admin-cards">
            {(Object.keys(CATEGORY_LABELS) as StorageCategory[]).map((category) => (
              <div key={category} className="admin-card">
                <span className="admin-card__title">{CATEGORY_LABELS[category].label}</span>
                <span className="admin-card__value">{formatBytes(summary.categories[category].bytes)}</span>
                <span className="admin-muted">
                  {summary.categories[category].count} objects · {CATEGORY_LABELS[category].hint}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
      {!summary && !error && <p className="admin-muted">Counting objects in R2… (this lists the whole bucket)</p>}
    </section>
  );
}

function SessionLookup() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const sessionId = params.get("session") ?? "";
  const [draft, setDraft] = useState(sessionId);
  const [data, setData] = useState<SessionStorage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setDraft(sessionId);
    if (!sessionId) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    adminGet<SessionStorage>(`/api/admin/storage/sessions/${encodeURIComponent(sessionId)}`)
      .then((result) => {
        if (!cancelled) setData(result);
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
  }, [sessionId]);

  const valid = SAFE_ID.test(draft.trim());

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (valid) router.replace(`${pathname}${qs({ session: draft.trim() })}`, { scroll: false });
  }

  const files = data?.files ?? [];

  return (
    <section className="admin-section" aria-labelledby="storage-session">
      <h2 id="storage-session" className="admin-section__title">
        Files for one session
      </h2>
      <p className="admin-muted">File names, sizes and dates only. Files can&apos;t be opened or downloaded from here.</p>
      <form className="admin-filters" onSubmit={onSubmit} role="search" aria-label="Look up a session">
        <div className="field">
          <label htmlFor="session-id">Session id</label>
          <input
            id="session-id"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            size={44}
            aria-invalid={draft !== "" && !valid}
            aria-describedby="session-id-hint"
          />
        </div>
        <button type="submit" className="btn btn-primary btn-small" disabled={!valid}>
          Look up
        </button>
        <p id="session-id-hint" className="admin-muted admin-filters__note">
          {draft !== "" && !valid ? "Letters, digits and hyphens only." : ""}
        </p>
      </form>

      {data && (
        <div className="admin-grid-2" style={{ marginBottom: 18 }}>
          <div className="admin-panel">
            <h3 className="admin-panel__title">Deletion markers</h3>
            {data.session ? (
              <dl className="admin-dl">
                <dt>Preview expires</dt>
                <dd>{formatDateTime(data.session.expiresAt)}</dd>
                <dt>Raw photos deleted</dt>
                <dd>{data.session.rawDeletedAt ? formatDateTime(data.session.rawDeletedAt) : "not yet"}</dd>
                <dt>Book files deleted</dt>
                <dd>{data.session.processedDeletedAt ? formatDateTime(data.session.processedDeletedAt) : "not yet"}</dd>
              </dl>
            ) : (
              <p className="admin-muted">No session row (deleted with an account, or never existed). Files listed below, if any, are orphans.</p>
            )}
          </div>
          <div className="admin-panel">
            <h3 className="admin-panel__title">Orders and schedule</h3>
            <dl className="admin-dl">
              <dt>Orders</dt>
              <dd>
                {data.orders.length === 0
                  ? "none"
                  : data.orders.map((o) => (
                      <span key={o.id} style={{ display: "block" }}>
                        <Link href={`/admin/orders/${o.id}`} className="admin-link mono-id">
                          {o.id}
                        </Link>{" "}
                        ({prettyStatus(o.status)})
                      </span>
                    ))}
              </dd>
              {data.schedule && (
                <>
                  <dt>Pathway</dt>
                  <dd>{data.schedule.pathway === "held" ? "held (an order still needs the files)" : data.schedule.pathway.toUpperCase()}</dd>
                  <dt>Raw photos due</dt>
                  <dd>{formatDateTime(data.schedule.rawDueAt)}</dd>
                  <dt>Book files due</dt>
                  <dd>{formatDateTime(data.schedule.processedDueAt)}</dd>
                </>
              )}
            </dl>
            <Link href={`/admin/deletions${qs({ session: data.sessionId })}`} className="account-order__link">
              Delete this session&apos;s files…
            </Link>
          </div>
        </div>
      )}

      {(sessionId || loading) && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <caption className="visually-hidden">Files stored for session {sessionId}</caption>
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">Category</th>
                <th scope="col" className="admin-table__num">
                  Size
                </th>
                <th scope="col">Last modified</th>
              </tr>
            </thead>
            <tbody>
              <TableState
                columns={4}
                loading={loading}
                error={error}
                empty={files.length === 0}
                emptyText="No files stored for this session."
              />
              {!error &&
                files.map((f) => (
                  <tr key={f.key}>
                    <td className="mono-id">{f.key}</td>
                    <td>{CATEGORY_LABELS[f.category].label}</td>
                    <td className="admin-table__num">{formatBytes(f.size)}</td>
                    <td>{formatDateTime(f.lastModified)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function AdminStoragePage() {
  return (
    <>
      <div className="admin-header">
        <div>
          <p className="eyebrow">Admin</p>
          <h1 className="page-title">Storage</h1>
        </div>
      </div>
      <SummaryCards />
      <Suspense fallback={null}>
        <SessionLookup />
      </Suspense>
    </>
  );
}
