"use client";
import { useEffect, useRef, type ReactNode } from "react";

/** Small shared pieces for the /admin pages. Plain tables, the site's own styles. */

export function formatDateTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function prettyStatus(status: string): string {
  return status.replace(/_/g, " ");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Loading / error / empty rows for a table body. Renders nothing once there
 * are rows to show (the caller renders them). The API's error message is shown
 * as-is: admins need the real reason.
 */
export function TableState({
  columns,
  loading,
  error,
  empty,
  emptyText,
}: {
  columns: number;
  loading: boolean;
  error: string | null;
  empty: boolean;
  emptyText: string;
}) {
  if (error) {
    return (
      <tr>
        <td colSpan={columns} className="admin-table__state admin-table__state--error" role="alert">
          {error}
        </td>
      </tr>
    );
  }
  if (loading && empty) {
    return (
      <tr>
        <td colSpan={columns} className="admin-table__state" aria-live="polite">
          Loading…
        </td>
      </tr>
    );
  }
  if (empty) {
    return (
      <tr>
        <td colSpan={columns} className="admin-table__state">
          {emptyText}
        </td>
      </tr>
    );
  }
  return null;
}

export function Pager({
  page,
  limit,
  total,
  onPage,
}: {
  page: number;
  limit: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / limit));
  if (total === 0) return null;
  return (
    <nav className="admin-pager" aria-label="Pagination">
      <button type="button" className="btn btn-ghost btn-small" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ← Previous
      </button>
      <span className="admin-pager__label">
        Page {page} of {pages} · {total} total
      </span>
      <button type="button" className="btn btn-ghost btn-small" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next →
      </button>
    </nav>
  );
}

export function Notice({ kind, children }: { kind: "error" | "success" | "info"; children: ReactNode }) {
  return (
    <div className={`notice ${kind === "info" ? "" : `notice--${kind}`}`} role={kind === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}

/**
 * Calls `tick` every `intervalMs` while the tab is visible. Paused while the
 * tab is hidden (no point hitting the API for nobody), and runs once as soon
 * as it becomes visible again so the page isn't stale.
 */
export function usePolling(tick: () => void, intervalMs: number, enabled = true) {
  const tickRef = useRef(tick);
  tickRef.current = tick;

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (timer === undefined) timer = setInterval(() => tickRef.current(), intervalMs);
    };
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        stop();
      } else {
        tickRef.current();
        start();
      }
    };
    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs, enabled]);
}
