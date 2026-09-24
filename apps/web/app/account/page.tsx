"use client";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { API_BASE_URL, apiGet } from "@/lib/api";
import { formatMoney } from "@/lib/pricing";
import { getMe, logout, type Me } from "@/lib/auth";
import { MyDataPanel, type DeletionResult } from "@/components/account/MyDataPanel";

interface AccountOrder {
  id: string;
  status: string;
  totalCents: number;
  currency: string;
  createdAt: string;
  items: { id: string; bookTitle: string; priceCents: number }[];
}

function prettyStatus(status: string): string {
  return status.replace(/_/g, " ");
}

const TABS = [
  { id: "orders", label: "Orders" },
  { id: "my-data", label: "My Data" },
] as const;
type TabId = (typeof TABS)[number]["id"];

/**
 * WAI-ARIA tabs with automatic activation: arrow keys move focus AND select,
 * Home/End jump to the ends, only the selected tab is in the Tab order
 * (roving tabIndex), and each tab controls its own panel.
 */
function AccountTabs({ active, onChange }: { active: TabId; onChange: (tab: TabId) => void }) {
  const refs = useRef<Record<TabId, HTMLButtonElement | null>>({ orders: null, "my-data": null });

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = TABS.findIndex((t) => t.id === active);
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    if (next === null) return;
    event.preventDefault();
    const tab = TABS[next]!.id;
    onChange(tab);
    refs.current[tab]?.focus();
  }

  return (
    <div className="tabs" role="tablist" aria-label="Account sections" onKeyDown={onKeyDown}>
      {TABS.map((tab) => (
        <button
          key={tab.id}
          ref={(el) => {
            refs.current[tab.id] = el;
          }}
          type="button"
          role="tab"
          id={`account-tab-${tab.id}`}
          aria-selected={active === tab.id}
          aria-controls={`account-panel-${tab.id}`}
          tabIndex={active === tab.id ? 0 : -1}
          className={`tabs__tab${active === tab.id ? " tabs__tab--active" : ""}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export default function AccountPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined = still loading
  const [orders, setOrders] = useState<AccountOrder[]>([]);
  const [loadingOrders, setLoadingOrders] = useState(true);
  const [tab, setTab] = useState<TabId>("orders");
  // My Data mounts (and fetches) the first time its tab is opened, then stays mounted.
  const [myDataOpened, setMyDataOpened] = useState(false);
  const [deleted, setDeleted] = useState<DeletionResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const who = await getMe().catch(() => null);
      if (cancelled) return;
      setMe(who);
      if (who) {
        const list = await apiGet<AccountOrder[]>("/api/account/orders").catch(() => []);
        if (!cancelled) {
          setOrders(list);
          setLoadingOrders(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogout = async () => {
    await logout().catch(() => {});
    router.push("/login");
  };

  const selectTab = (next: TabId) => {
    setTab(next);
    if (next === "my-data") setMyDataOpened(true);
  };

  // The account no longer exists and the API has cleared the login cookie, so
  // this is the signed-out state: nothing account-related is rendered again.
  const handleDeleted = (result: DeletionResult) => {
    setDeleted(result);
    setMe(null);
    setOrders([]);
  };

  if (deleted) {
    return (
      <main className="page page--narrow">
        <p className="eyebrow">Your data</p>
        <h1 className="page-title">Your data has been deleted</h1>
        <p className="page-lede">
          We deleted {deleted.fileCount} file{deleted.fileCount === 1 ? "" : "s"} and your account. Your{" "}
          {deleted.ordersAnonymised} order record{deleted.ordersAnonymised === 1 ? " has" : "s have"} been anonymised
          and kept for accounting only. You have been signed out.
        </p>
        {deleted.sessionsKeptShared > 0 && (
          <p className="page-lede">
            {deleted.sessionsKeptShared} book{deleted.sessionsKeptShared === 1 ? " was" : "s were"} also part of
            someone else&apos;s order, so its files were kept for them.
          </p>
        )}
        <Link href="/" className="btn btn-primary">
          Back to the homepage <span className="arrow">→</span>
        </Link>
      </main>
    );
  }

  if (me === undefined) {
    return <main className="page page--narrow"><p className="page-lede">Loading your account…</p></main>;
  }

  // Not signed in — row-level security means there's nothing to show without a session.
  if (me === null) {
    return (
      <main className="page page--narrow">
        <p className="eyebrow">Your account</p>
        <h1 className="page-title">Please sign in</h1>
        <p className="page-lede">Sign in to see your order history, tracking, and receipts.</p>
        <Link href="/login" className="btn btn-primary">
          Sign in <span className="arrow">→</span>
        </Link>
      </main>
    );
  }

  return (
    <main className="page">
      <div className="account-header">
        <div>
          <p className="eyebrow">Your account</p>
          <h1 className="page-title">Orders &amp; data</h1>
          <p className="page-lede">Signed in as {me.email}</p>
        </div>
        <button onClick={handleLogout} className="btn btn-ghost">Sign out</button>
      </div>

      <AccountTabs active={tab} onChange={selectTab} />

      <div
        role="tabpanel"
        id="account-panel-orders"
        aria-labelledby="account-tab-orders"
        hidden={tab !== "orders"}
        tabIndex={0}
        className="tabs__panel"
      >
        {loadingOrders ? (
          <p className="page-lede">Loading your orders…</p>
        ) : orders.length === 0 ? (
          <div className="empty-state">
            <p className="page-lede">No orders yet.</p>
            <Link href="/" className="btn btn-primary">Browse the stories <span className="arrow">→</span></Link>
          </div>
        ) : (
          <ul className="account-orders">
            {orders.map((order) => (
              <li key={order.id} className="card account-order">
                <div className="account-order__top">
                  <div>
                    <p className="account-order__date">
                      {new Date(order.createdAt).toLocaleDateString()}
                    </p>
                    <p className="account-order__id mono-id">{order.id}</p>
                  </div>
                  <span className={`status-pill status-pill--${order.status}`}>
                    {prettyStatus(order.status)}
                  </span>
                </div>

                <ul className="account-order__items">
                  {order.items.map((item) => (
                    <li key={item.id}>
                      <span>{item.bookTitle}</span>
                      <span>{formatMoney(item.priceCents, order.currency)}</span>
                    </li>
                  ))}
                </ul>

                <div className="account-order__footer">
                  <span className="account-order__total">
                    Total {formatMoney(order.totalCents, order.currency)}
                  </span>
                  <div className="account-order__actions">
                    <Link href={`/track/${order.id}`} className="account-order__link">Track order</Link>
                    <a
                      href={`${API_BASE_URL}/api/account/orders/${order.id}/receipt`}
                      className="account-order__link"
                    >
                      Download receipt
                    </a>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div
        role="tabpanel"
        id="account-panel-my-data"
        aria-labelledby="account-tab-my-data"
        hidden={tab !== "my-data"}
        tabIndex={0}
        className="tabs__panel"
      >
        {myDataOpened && <MyDataPanel onDeleted={handleDeleted} />}
      </div>
    </main>
  );
}
