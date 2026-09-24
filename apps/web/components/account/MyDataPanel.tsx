"use client";
import { useEffect, useState } from "react";
import { ApiError, apiDelete, apiGet } from "@/lib/api";
import { ConfirmModal } from "@/components/ConfirmModal";

// Shapes from GET/DELETE /api/account/my-data (apps/api/src/routes/account.ts).
interface MyDataItem {
  id: string;
  sessionId: string;
  bookTitle: string;
  photos: "stored" | "deleted";
  bookFiles: "stored" | "deleted";
  pathway: "p1" | "p2" | "held";
  photosDeletionDueAt: string | null;
  bookFilesDeletionDueAt: string | null;
}
interface MyDataOrder {
  id: string;
  status: string;
  createdAt: string;
  deliveredAt: string | null;
  items: MyDataItem[];
}
export interface DeletionResult {
  sessionsDeleted: number;
  fileCount: number;
  ordersAnonymised: number;
  sessionsKeptShared: number;
}

const BEING_MADE = ["paid", "pdf_ready", "submitted_to_print", "processing"];

function longDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "long" }) : "";
}

function photoStatus(item: MyDataItem): { label: string; modifier: string } {
  if (item.photos === "deleted" && item.bookFiles === "deleted") return { label: "All deleted", modifier: "deleted" };
  if (item.photos === "deleted") return { label: "Photos deleted", modifier: "partial" };
  return { label: "Stored", modifier: "stored" };
}

/**
 * "<what> will be deleted <rule>, on <date>." A date already in the past means
 * the sweep hasn't reached it yet (it runs periodically), so say it's due
 * rather than promising a date that has gone by.
 */
function dueText(what: string, rule: string, iso: string | null): string {
  if (!iso) return `${what} will be deleted ${rule}.`;
  if (new Date(iso).getTime() <= Date.now()) {
    return `${what} are due for deletion (${rule}, ${longDate(iso)}) and will be removed shortly.`;
  }
  return `${what} will be deleted ${rule}, on ${longDate(iso)}.`;
}

/** Which rule applies, in words, with the dates from the API's schedule. */
function pathwayText(item: MyDataItem, orderStatus: string): string {
  if (item.photos === "deleted" && item.bookFiles === "deleted") {
    return "Your photos and book files for this order have been deleted.";
  }
  switch (item.pathway) {
    case "p2": {
      const photos =
        item.photos === "deleted"
          ? "Your photos were deleted 24 hours after delivery."
          : dueText("Your photos", "24 hours after delivery", item.photosDeletionDueAt);
      return `${photos} ${dueText("Your book's preview, page and print files", "30 days after delivery", item.bookFilesDeletionDueAt)}`;
    }
    case "p1":
      return item.photos === "deleted"
        ? "This order wasn't completed, so your photos were deleted 24 hours after your preview expired."
        : `This order wasn't completed. ${dueText("Your photos", "24 hours after your preview expires", item.photosDeletionDueAt)}`;
    case "held":
      if (BEING_MADE.includes(orderStatus)) return "Kept while your book is being made. The deletion dates are set once it's delivered.";
      if (orderStatus === "dispatched") return "Kept until your book is delivered. Deletion is scheduled from the delivery date.";
      if (orderStatus === "failed") return "Kept while we resolve a problem with this order.";
      return "Kept while another order using these photos is in progress.";
  }
}

function deleteErrorMessage(error: unknown): { message: string; orders: { id: string; status: string }[] } {
  if (error instanceof ApiError) {
    const orders = (error.body as { orders?: { id: string; status: string }[] } | null)?.orders ?? [];
    switch (error.status) {
      case 409:
        return { message: error.message, orders };
      case 503:
        return {
          message: "Our payment provider couldn't be reached, so nothing was deleted. Please try again in a few minutes.",
          orders: [],
        };
      case 429: {
        const wait = error.retryAfter ? ` Please wait about ${Math.ceil(error.retryAfter / 60)} minute(s)` : " Please wait a while";
        return { message: `Too many deletion attempts.${wait} and try again.`, orders: [] };
      }
      case 401:
        return { message: "Your session has ended. Please sign in again.", orders: [] };
    }
    // A 5xx body can carry internal error text; never show that to a customer.
    // Deletion is built to be retried: anything already removed stays removed
    // and a second attempt finishes the rest.
    if (error.status >= 500) {
      return {
        message: "Something went wrong on our side and the deletion didn't finish. Please try again; if it keeps failing, contact us.",
        orders: [],
      };
    }
    return { message: error.message, orders: [] };
  }
  return { message: "Something went wrong. Nothing has been deleted; please try again.", orders: [] };
}

export function MyDataPanel({ onDeleted }: { onDeleted: (result: DeletionResult) => void }) {
  const [orders, setOrders] = useState<MyDataOrder[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<{ message: string; orders: { id: string; status: string }[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiGet<{ orders: MyDataOrder[] }>("/api/account/my-data")
      .then((data) => {
        if (!cancelled) setOrders(data.orders);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "Couldn't load your data.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function confirmDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = await apiDelete<DeletionResult>("/api/account/my-data", { confirm: "DELETE" });
      setConfirmOpen(false);
      onDeleted(result);
    } catch (error) {
      setDeleteError(deleteErrorMessage(error));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="my-data">
      <p className="page-lede">
        What we keep from your orders, and when it's deleted. Photos of your children are only used to make your
        books.
      </p>

      {loadError ? (
        <div className="notice notice--error" role="alert">
          <p className="notice__title">Couldn't load your data</p>
          <p style={{ margin: 0 }}>{loadError}</p>
        </div>
      ) : orders === null ? (
        <p className="page-lede" aria-live="polite">Loading your data…</p>
      ) : orders.length === 0 ? (
        <div className="empty-state">
          <p className="page-lede">There are no orders on your account, so we hold no photos linked to it.</p>
        </div>
      ) : (
        <ul className="account-orders">
          {orders.map((order) => (
            <li key={order.id} className="card account-order">
              <div className="account-order__top">
                <div>
                  <p className="account-order__date">Ordered {longDate(order.createdAt)}</p>
                  <p className="account-order__id mono-id">{order.id}</p>
                </div>
                <span className={`status-pill status-pill--${order.status}`}>{order.status.replace(/_/g, " ")}</span>
              </div>
              <ul className="my-data__items">
                {order.items.map((item) => {
                  const status = photoStatus(item);
                  return (
                    <li key={item.id} className="my-data__item">
                      <div className="my-data__item-top">
                        <span className="my-data__title">{item.bookTitle}</span>
                        <span className={`my-data__badge my-data__badge--${status.modifier}`}>{status.label}</span>
                      </div>
                      <p className="my-data__schedule">{pathwayText(item, order.status)}</p>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}

      <section className="my-data__danger card" aria-labelledby="my-data-delete-heading">
        <h2 id="my-data-delete-heading" className="my-data__danger-title">Delete my data now</h2>
        <p className="my-data__danger-body">
          Deletes your photos, book files and account straight away. Anonymised order records are kept for
          accounting.
        </p>
        {deleteError && !confirmOpen && (
          <div className="notice notice--error" role="alert">
            {deleteError.message}
          </div>
        )}
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => {
            setDeleteError(null);
            setConfirmOpen(true);
          }}
        >
          Delete my data now
        </button>
      </section>

      <ConfirmModal
        open={confirmOpen}
        title="Delete all your data?"
        confirmLabel="Delete everything"
        danger
        requireText="DELETE"
        busy={deleting}
        error={
          deleteError && (
            <>
              <p style={{ margin: 0 }}>{deleteError.message}</p>
              {deleteError.orders.length > 0 && (
                <ul className="my-data__blocked" aria-label="Orders still in progress">
                  {deleteError.orders.map((o) => (
                    <li key={o.id}>
                      <span className="mono-id">{o.id}</span> ({o.status.replace(/_/g, " ")})
                    </li>
                  ))}
                </ul>
              )}
            </>
          )
        }
        onConfirm={confirmDelete}
        onCancel={() => setConfirmOpen(false)}
      >
        <p>
          <strong>Deleted now:</strong> every photo you uploaded, your books' preview, page and print files, your
          saved names, your account and your login.
        </p>
        <p>
          <strong>Kept:</strong> anonymised order records (amounts, book titles, dates, status and shipping country)
          that we must keep for accounting. Your name, email and address are removed from them.
        </p>
        <p>
          <strong>This can't be undone.</strong> You won't be able to reorder or reprint these books, and you'll be
          signed out.
        </p>
      </ConfirmModal>
    </div>
  );
}
