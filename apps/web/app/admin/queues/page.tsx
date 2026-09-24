"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { adminGet, JOB_STATES, qs, type JobState, type JobSummary, type Paged, type QueueCounts } from "@/lib/admin";
import { JobDrawer } from "@/components/admin/JobDrawer";
import { errorMessage, formatDateTime, Pager, TableState, usePolling } from "@/components/admin/ui";

const LIMIT = 25;
const REFRESH_MS = 5000;

function QueuesView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const queue = params.get("queue") ?? "fulfillment";
  const state = (JOB_STATES as string[]).includes(params.get("state") ?? "") ? (params.get("state") as JobState) : "failed";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const openJob = params.get("job");

  const [queues, setQueues] = useState<QueueCounts[] | null>(null);
  const [queuesError, setQueuesError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Paged<JobSummary> | null>(null);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [loadingJobs, setLoadingJobs] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  // The URL holds the selection, so a job can be linked to (e.g. from an order page).
  const navigate = useCallback(
    (next: { queue?: string; state?: string; page?: number; job?: string | null }) => {
      const merged = { queue, state, page, job: openJob, ...next };
      router.replace(`${pathname}${qs({ queue: merged.queue, state: merged.state, page: merged.page > 1 ? merged.page : undefined, job: merged.job })}`, {
        scroll: false,
      });
    },
    [router, pathname, queue, state, page, openJob],
  );

  const refresh = useCallback(async () => {
    const [countsResult, jobsResult] = await Promise.allSettled([
      adminGet<{ queues: QueueCounts[] }>("/api/admin/queues"),
      adminGet<Paged<JobSummary>>(`/api/admin/queues/${encodeURIComponent(queue)}/jobs${qs({ state, page, limit: LIMIT })}`),
    ]);
    if (countsResult.status === "fulfilled") {
      setQueues(countsResult.value.queues);
      setQueuesError(null);
    } else {
      setQueuesError(errorMessage(countsResult.reason));
    }
    if (jobsResult.status === "fulfilled") {
      setJobs(jobsResult.value);
      setJobsError(null);
    } else {
      setJobsError(errorMessage(jobsResult.reason));
    }
    setLoadingJobs(false);
    setUpdatedAt(new Date());
  }, [queue, state, page]);

  useEffect(() => {
    setLoadingJobs(true);
    setJobs(null);
    void refresh();
  }, [refresh]);

  usePolling(() => void refresh(), REFRESH_MS);

  const rows = jobs?.items ?? [];

  return (
    <>
      <div className="admin-header">
        <div>
          <p className="eyebrow">Admin</p>
          <h1 className="page-title">Queues</h1>
        </div>
        <p className="admin-muted" aria-live="off">
          Refreshes every 5s while this tab is visible{updatedAt ? ` · updated ${updatedAt.toLocaleTimeString()}` : ""}
        </p>
      </div>

      {queuesError && (
        <div className="notice notice--error" role="alert">
          {queuesError}
        </div>
      )}

      <div className="admin-cards" role="group" aria-label="Queues">
        {(queues ?? []).map((q) => (
          <button
            key={q.name}
            type="button"
            className={`admin-card${q.name === queue ? " admin-card--active" : ""}`}
            aria-pressed={q.name === queue}
            onClick={() => navigate({ queue: q.name, page: 1, job: null })}
          >
            <span className="admin-card__title">{q.name}</span>
            <span className="admin-card__counts">
              {JOB_STATES.map((s) => (
                <span key={s} className={`admin-count${s === "failed" && q.counts.failed > 0 ? " admin-count--alert" : ""}`}>
                  <strong>{q.counts[s]}</strong> {s}
                </span>
              ))}
            </span>
          </button>
        ))}
        {!queues && !queuesError && <p className="admin-muted">Loading queues…</p>}
      </div>

      <div className="admin-filters">
        <div className="field">
          <label htmlFor="job-state">State</label>
          <select id="job-state" value={state} onChange={(e) => navigate({ state: e.target.value, page: 1 })}>
            {JOB_STATES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <p className="admin-muted admin-filters__note">
          Showing <strong>{state}</strong> jobs in <strong>{queue}</strong>
          {state === "failed" ? ". Open one to see the error, the stack trace and retry options." : "."}
        </p>
      </div>

      <div className="admin-table-wrap">
        <table className="admin-table">
          <caption className="visually-hidden">
            {state} jobs in the {queue} queue
          </caption>
          <thead>
            <tr>
              <th scope="col">Job id</th>
              <th scope="col">Name</th>
              <th scope="col">Created</th>
              <th scope="col">Finished</th>
              <th scope="col">Attempts</th>
              <th scope="col">Data</th>
            </tr>
          </thead>
          <tbody>
            <TableState
              columns={6}
              loading={loadingJobs}
              error={jobsError}
              empty={rows.length === 0}
              emptyText={`No ${state} jobs in ${queue}.`}
            />
            {!jobsError &&
              rows.map((job) => (
                <tr key={job.id}>
                  <td>
                    <button type="button" className="admin-link mono-id" onClick={() => navigate({ job: job.id })}>
                      {job.id}
                    </button>
                  </td>
                  <td>{job.name}</td>
                  <td>{formatDateTime(job.timestamp)}</td>
                  <td>{formatDateTime(job.finishedOn)}</td>
                  <td>
                    {job.attemptsMade}/{job.maxAttempts}
                  </td>
                  <td className="admin-table__data">
                    <code>{job.dataSummary}</code>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {jobs && <Pager page={jobs.page} limit={jobs.limit} total={jobs.total} onPage={(p) => navigate({ page: p })} />}

      {openJob && (
        <JobDrawer
          key={`${queue}:${openJob}`}
          queue={queue}
          jobId={openJob}
          onClose={() => navigate({ job: null })}
          onChanged={() => void refresh()}
        />
      )}
    </>
  );
}

export default function AdminQueuesPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={<p className="admin-muted">Loading…</p>}>
      <QueuesView />
    </Suspense>
  );
}
