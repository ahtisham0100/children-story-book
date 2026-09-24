"use client";
import { Suspense, useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { adminGet, ORDER_STATUSES, qs, type AdminOrderRow, type Paged } from "@/lib/admin";
import { formatMoney } from "@/lib/pricing";
import { errorMessage, formatDateTime, Pager, prettyStatus, TableState } from "@/components/admin/ui";

const LIMIT = 25;

function OrdersView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const filters = {
    status: params.get("status") ?? "",
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
    q: params.get("q") ?? "",
  };
  const page = Math.max(1, Number(params.get("page")) || 1);

  // The form edits a draft; the URL (and so the fetch) changes on submit.
  const [draft, setDraft] = useState(filters);
  const [data, setData] = useState<Paged<AdminOrderRow> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const query = params.toString();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const search = new URLSearchParams(query);
      setData(
        await adminGet<Paged<AdminOrderRow>>(
          `/api/admin/orders${qs({
            status: search.get("status"),
            from: search.get("from"),
            to: search.get("to"),
            q: search.get("q"),
            page: search.get("page"),
            limit: LIMIT,
          })}`,
        ),
      );
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  const go = (next: Record<string, string | number | undefined>) =>
    router.replace(`${pathname}${qs({ ...filters, page: page > 1 ? page : undefined, ...next })}`, { scroll: false });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    go({ ...draft, page: undefined });
  }

  const rows = data?.items ?? [];

  return (
    <>
      <div className="admin-header">
        <div>
          <p className="eyebrow">Admin</p>
          <h1 className="page-title">Orders</h1>
        </div>
      </div>

      <form className="admin-filters" onSubmit={onSubmit} role="search" aria-label="Filter orders">
        <div className="field">
          <label htmlFor="order-q">Order id or email</label>
          <input
            id="order-q"
            type="search"
            value={draft.q}
            onChange={(e) => setDraft({ ...draft, q: e.target.value })}
            placeholder="e.g. 3f2a… or jane@"
          />
        </div>
        <div className="field">
          <label htmlFor="order-status">Status</label>
          <select id="order-status" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
            <option value="">Any</option>
            {ORDER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {prettyStatus(s)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="order-from">From</label>
          <input id="order-from" type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="order-to">To</label>
          <input id="order-to" type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
        </div>
        <button type="submit" className="btn btn-primary btn-small">
          Apply
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-small"
          onClick={() => {
            const empty = { status: "", from: "", to: "", q: "" };
            setDraft(empty);
            router.replace(pathname, { scroll: false });
          }}
        >
          Clear
        </button>
      </form>

      <div className="admin-table-wrap">
        <table className="admin-table">
          <caption className="visually-hidden">Orders, newest first</caption>
          <thead>
            <tr>
              <th scope="col">Order</th>
              <th scope="col">Created</th>
              <th scope="col">Email</th>
              <th scope="col">Status</th>
              <th scope="col" className="admin-table__num">
                Items
              </th>
              <th scope="col" className="admin-table__num">
                Total
              </th>
              <th scope="col">Gelato</th>
            </tr>
          </thead>
          <tbody>
            <TableState
              columns={7}
              loading={loading}
              error={error}
              empty={rows.length === 0}
              emptyText="No orders match these filters."
            />
            {!error &&
              rows.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link href={`/admin/orders/${o.id}`} className="admin-link mono-id">
                      {o.id}
                    </Link>
                  </td>
                  <td>{formatDateTime(o.createdAt)}</td>
                  <td>{o.anonymisedAt ? <em className="admin-muted">anonymised</em> : o.email}</td>
                  <td>
                    <span className={`status-pill status-pill--${o.status}`}>{prettyStatus(o.status)}</span>
                  </td>
                  <td className="admin-table__num">{o.itemCount}</td>
                  <td className="admin-table__num">{formatMoney(o.totalCents, o.currency)}</td>
                  <td className="mono-id">{o.gelatoOrderId ?? "—"}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {data && <Pager page={data.page} limit={data.limit} total={data.total} onPage={(p) => go({ page: p })} />}
    </>
  );
}

export default function AdminOrdersPage() {
  return (
    <Suspense fallback={<p className="admin-muted">Loading…</p>}>
      <OrdersView />
    </Suspense>
  );
}
