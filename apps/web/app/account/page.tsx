"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { API_BASE_URL, apiGet } from "@/lib/api";
import { formatMoney } from "@/lib/pricing";
import { getMe, logout, type Me } from "@/lib/auth";

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

export default function AccountPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined = still loading
  const [orders, setOrders] = useState<AccountOrder[]>([]);
  const [loadingOrders, setLoadingOrders] = useState(true);

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
          <h1 className="page-title">Orders</h1>
          <p className="page-lede">Signed in as {me.email}</p>
        </div>
        <button onClick={handleLogout} className="btn btn-ghost">Sign out</button>
      </div>

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
    </main>
  );
}
