"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { loadStripe, type Appearance } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { getCartSessionIds } from "@/lib/cart";
import { apiGet, apiPost } from "@/lib/api";
import { BOOK_PRICES_CENTS, formatMoney } from "@/lib/pricing";
import { BookPreviewModal } from "@/components/BookPreviewModal";
import { GDPR_DELETION_NOTICE } from "@/lib/gdprNotice";

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "");

const stripeAppearance: Appearance = {
  theme: "stripe",
  variables: {
    colorPrimary: "#3e6a49",
    colorBackground: "#faf7f0",
    colorText: "#35251a",
    colorTextSecondary: "#6e5c4e",
    colorDanger: "#b4453a",
    fontFamily: "Work Sans, sans-serif",
    borderRadius: "9px",
    spacingUnit: "4px",
  },
  rules: {
    ".Input": { border: "1px solid #e6d9c4", boxShadow: "none" },
    ".Input:focus": { border: "1px solid #c69a5c", boxShadow: "0 0 0 3px rgba(198,154,92,0.25)" },
    ".Label": { fontWeight: "600", fontSize: "12.5px", letterSpacing: "0.02em", color: "#6e5c4e" },
    ".Tab": { border: "1px solid #e6d9c4" },
    ".Tab--selected": { border: "1px solid #3e6a49", boxShadow: "0 0 0 1px #3e6a49" },
  },
};

interface CheckoutResponse {
  orderId: string;
  clientSecret: string;
}
interface SessionPagesResponse {
  sessionId: string;
  storyId: string;
  title: string;
}

function PaymentStep({ orderId }: { orderId: string }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePay = async () => {
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);
    const { error: confirmError } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: `${window.location.origin}/confirmation?order=${orderId}` },
    });
    if (confirmError) {
      setError(confirmError.message ?? "Payment failed.");
      setSubmitting(false);
    }
  };

  return (
    <div className="card checkout-panel">
      <p className="eyebrow" style={{ marginBottom: 18 }}>Payment</p>
      <PaymentElement />
      {error && <p className="error-text" style={{ marginTop: 14 }}>{error}</p>}
      <button onClick={handlePay} disabled={submitting} className="btn btn-primary btn-block" style={{ marginTop: 20 }}>
        {submitting ? "Processing…" : "Pay now"}
      </button>
    </div>
  );
}

function OrderSummary({ items, totalCents }: { items: SessionPagesResponse[]; totalCents: number }) {
  const [previewSessionId, setPreviewSessionId] = useState<string | null>(null);

  return (
    <aside className="checkout-summary card">
      <p className="eyebrow">Order summary</p>
      <ul className="checkout-summary__list">
        {items.map((item) => (
          <li key={item.sessionId}>
            <span>
              {item.title}{" "}
              <button
                type="button"
                className="checkout-summary__preview"
                onClick={() => setPreviewSessionId(item.sessionId)}
              >
                Preview
              </button>
            </span>
            <span>{formatMoney(BOOK_PRICES_CENTS[item.storyId] ?? 0)}</span>
          </li>
        ))}
      </ul>
      <hr className="stitch" style={{ margin: "16px 0" }} />
      <div className="checkout-summary__total">
        <span>Total</span>
        <span>{formatMoney(totalCents)}</span>
      </div>

      {previewSessionId && (
        <BookPreviewModal sessionId={previewSessionId} onClose={() => setPreviewSessionId(null)} />
      )}
    </aside>
  );
}

export default function CheckoutPage() {
  const router = useRouter();
  const [checkout, setCheckout] = useState<CheckoutResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [items, setItems] = useState<SessionPagesResponse[]>([]);
  const [form, setForm] = useState({
    email: "",
    name: "",
    line1: "",
    line2: "",
    city: "",
    postalCode: "",
    country: "FR",
  });
  const [gdprConsent, setGdprConsent] = useState(false);

  useEffect(() => {
    const ids = getCartSessionIds();
    if (ids.length === 0) {
      router.push("/cart");
      return;
    }
    Promise.all(ids.map((id) => apiGet<SessionPagesResponse>(`/api/sessions/${id}/pages`).catch(() => null))).then(
      (results) => setItems(results.filter((r): r is SessionPagesResponse => r !== null)),
    );
  }, [router]);

  const totalCents = items.reduce((sum, item) => sum + (BOOK_PRICES_CENTS[item.storyId] ?? 0), 0);

  const handleContinue = async () => {
    const sessionIds = getCartSessionIds();
    if (sessionIds.length === 0) {
      router.push("/cart");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await apiPost<CheckoutResponse>("/api/checkout", {
        sessionIds,
        email: form.email,
        shippingAddress: {
          name: form.name,
          line1: form.line1,
          line2: form.line2 || undefined,
          city: form.city,
          postalCode: form.postalCode,
          country: form.country,
        },
        // The real checkbox state. The API only accepts true, so an unchecked
        // box is rejected server-side, not just by the disabled button.
        gdprConsent,
      });
      setCheckout(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Checkout failed.");
    } finally {
      setSubmitting(false);
    }
  };

  const canContinue =
    gdprConsent && form.email && form.name && form.line1 && form.city && form.postalCode && form.country.length === 2;

  return (
    <main className="page">
      <p className="eyebrow">Checkout</p>
      <h1 className="page-title">{checkout ? "Complete your payment" : "Delivery details"}</h1>
      <p className="page-lede">
        {checkout ? "Your card details are handled securely by Stripe." : "Where should we send the finished book?"}
      </p>

      <div className="checkout-layout">
        {checkout ? (
          <Elements stripe={stripePromise} options={{ clientSecret: checkout.clientSecret, appearance: stripeAppearance }}>
            <PaymentStep orderId={checkout.orderId} />
          </Elements>
        ) : (
          <div className="card checkout-panel">
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="you@example.com" />
            </div>
            <div className="field">
              <label htmlFor="name">Full name</label>
              <input id="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Recipient's name" />
            </div>
            <div className="field">
              <label htmlFor="line1">Address line 1</label>
              <input id="line1" value={form.line1} onChange={(e) => setForm({ ...form, line1: e.target.value })} placeholder="Street and number" />
            </div>
            <div className="field">
              <label htmlFor="line2">Address line 2 <span style={{ fontWeight: 400, textTransform: "none" }}>(optional)</span></label>
              <input id="line2" value={form.line2} onChange={(e) => setForm({ ...form, line2: e.target.value })} placeholder="Apartment, suite, etc." />
            </div>
            <div className="field-row">
              <div className="field">
                <label htmlFor="city">City</label>
                <input id="city" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="postal">Postal code</label>
                <input id="postal" value={form.postalCode} onChange={(e) => setForm({ ...form, postalCode: e.target.value })} />
              </div>
            </div>
            <div className="field" style={{ maxWidth: 140 }}>
              <label htmlFor="country">Country code</label>
              <input id="country" value={form.country} maxLength={2} onChange={(e) => setForm({ ...form, country: e.target.value.toUpperCase() })} placeholder="FR" />
            </div>

            <label className="consent">
              <input type="checkbox" checked={gdprConsent} onChange={(e) => setGdprConsent(e.target.checked)} />
              <span>
                I consent to my photos being used to personalise this book. {GDPR_DELETION_NOTICE}
              </span>
            </label>

            {error && <p className="error-text">{error}</p>}
            <button onClick={handleContinue} disabled={submitting || !canContinue} className="btn btn-primary btn-block">
              {submitting ? "Please wait…" : "Continue to payment"}
            </button>
          </div>
        )}

        <OrderSummary items={items} totalCents={totalCents} />
      </div>
    </main>
  );
}
