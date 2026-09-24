"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { addSessionToCart, getCartSessionIds, removeSessionFromCart } from "@/lib/cart";
import { apiGet } from "@/lib/api";
import { BOOK_PRICES_CENTS, formatMoney } from "@/lib/pricing";
import { BookPreviewModal } from "@/components/BookPreviewModal";

interface SessionPagesResponse {
  sessionId: string;
  storyId: string;
  title: string;
  pages: { id: string; url: string | null; ready: boolean }[];
}

function BookThumb({ url }: { url: string | null }) {
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" className="cart-thumb" />;
  }
  return (
    <div className="cart-thumb cart-thumb--placeholder" aria-hidden="true">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path d="M12 6.5C10.5 5 8 4.5 4 4.8V18c4-.3 6.5.2 8 1.7 1.5-1.5 4-2 8-1.7V4.8c-4-.3-6.5.2-8 1.7Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M12 6.5V19.7" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    </div>
  );
}

function CartPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [items, setItems] = useState<SessionPagesResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewSessionId, setPreviewSessionId] = useState<string | null>(null);

  useEffect(() => {
    const addId = searchParams.get("add");
    if (addId) {
      addSessionToCart(addId);
      router.replace("/cart");
    }
  }, [searchParams, router]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const ids = getCartSessionIds();
      const results = await Promise.all(
        ids.map((id) => apiGet<SessionPagesResponse>(`/api/sessions/${id}/pages`).catch(() => null)),
      );
      if (!cancelled) {
        setItems(results.filter((r): r is SessionPagesResponse => r !== null));
        setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [searchParams]);

  const handleRemove = (sessionId: string) => {
    removeSessionFromCart(sessionId);
    setItems((prev) => prev.filter((i) => i.sessionId !== sessionId));
  };

  const totalCents = items.reduce((sum, item) => sum + (BOOK_PRICES_CENTS[item.storyId] ?? 0), 0);

  if (loading) {
    return (
      <main className="page">
        <p className="page-lede">Loading your cart…</p>
      </main>
    );
  }

  if (items.length === 0) {
    return (
      <main className="page">
        <div className="empty-state">
          <p className="eyebrow">Your cart</p>
          <h1 className="page-title">Nothing here yet</h1>
          <p className="page-lede">Personalise a story and it will land here, ready for checkout.</p>
          <Link href="/" className="btn btn-primary">
            Browse the stories <span className="arrow">→</span>
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="page">
      <p className="eyebrow">Your cart</p>
      <h1 className="page-title">
        {items.length} {items.length === 1 ? "book" : "books"} ready for print
      </h1>

      <ul className="cart-list">
        {items.map((item) => {
          const cover = item.pages.find((p) => p.ready && p.url)?.url ?? null;
          return (
            <li key={item.sessionId} className="card cart-item">
              <div className="cart-item__main">
                <BookThumb url={cover} />
                <div className="cart-item__body">
                  <p className="cart-item__title">{item.title}</p>
                  <p className="cart-item__price">{formatMoney(BOOK_PRICES_CENTS[item.storyId] ?? 0)}</p>
                </div>
              </div>
              <div className="cart-item__actions">
                <button
                  onClick={() => setPreviewSessionId(item.sessionId)}
                  className="cart-item__preview"
                  aria-label={`Preview ${item.title}`}
                >
                  Preview book
                </button>
                <button onClick={() => handleRemove(item.sessionId)} className="cart-item__remove" aria-label={`Remove ${item.title}`}>
                  Remove
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="cart-summary">
        <div>
          <p className="cart-summary__label">Total</p>
          <p className="cart-summary__value">{formatMoney(totalCents)}</p>
        </div>
        <Link href="/checkout" className="btn btn-primary">
          Proceed to checkout <span className="arrow">→</span>
        </Link>
      </div>

      {previewSessionId && (
        <BookPreviewModal sessionId={previewSessionId} onClose={() => setPreviewSessionId(null)} />
      )}
    </main>
  );
}

export default function CartPage() {
  return (
    <Suspense fallback={<main className="page"><p className="page-lede">Loading…</p></main>}>
      <CartPageInner />
    </Suspense>
  );
}
