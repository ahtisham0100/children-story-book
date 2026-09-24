"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { apiGet } from "@/lib/api";
import { formatMoney } from "@/lib/pricing";
import { clearCart } from "@/lib/cart";
import { GDPR_DELETION_NOTICE } from "@/lib/gdprNotice";

interface OrderView {
  id: string;
  status: string;
  totalCents: number;
  currency: string;
  items: { id: string; bookTitle: string; priceCents: number }[];
}

function ConfirmationInner() {
  const searchParams = useSearchParams();
  const orderId = searchParams.get("order");
  const [order, setOrder] = useState<OrderView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!orderId) return;
    clearCart();
    apiGet<OrderView>(`/api/orders/${orderId}`)
      .then(setOrder)
      .catch(() => setError("We couldn't find that order."));
  }, [orderId]);

  if (!orderId) return <main className="page page--narrow"><p className="page-lede">No order specified.</p></main>;
  if (error) return <main className="page page--narrow"><p className="page-lede">{error}</p></main>;
  if (!order) return <main className="page page--narrow"><p className="page-lede">Loading your order…</p></main>;

  return (
    <main className="page page--narrow">
      <p className="eyebrow">Order confirmed</p>
      <h1 className="page-title">Thank you — it's on its way to the printer</h1>
      <p className="page-lede">Order <span className="mono-id">{order.id}</span></p>

      <div className="card checkout-panel">
        <ul className="checkout-summary__list">
          {order.items.map((item) => (
            <li key={item.id}>
              <span>{item.bookTitle}</span>
              <span>{formatMoney(item.priceCents, order.currency)}</span>
            </li>
          ))}
        </ul>
        <hr className="stitch" style={{ margin: "16px 0" }} />
        <div className="checkout-summary__total">
          <span>Total</span>
          <span>{formatMoney(order.totalCents, order.currency)}</span>
        </div>
      </div>

      <div className="trust-note">
        <p className="trust-note__title">Your data, protected by design</p>
        <p className="trust-note__body">{GDPR_DELETION_NOTICE}</p>
      </div>

      <Link href={`/track/${order.id}`} className="btn btn-primary">
        Track your order <span className="arrow">→</span>
      </Link>
    </main>
  );
}

export default function ConfirmationPage() {
  return (
    <Suspense fallback={<main className="page page--narrow"><p className="page-lede">Loading…</p></main>}>
      <ConfirmationInner />
    </Suspense>
  );
}
