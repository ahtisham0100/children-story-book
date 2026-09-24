"use client";
import { useState } from "react";
import Link from "next/link";
import { requestPasswordReset } from "@/lib/auth";

export default function ResetPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await requestPasswordReset(email);
      setSent(true);
    } catch {
      setError("Something went wrong. Please try again in a moment.");
      setSubmitting(false);
    }
  };

  return (
    <main className="page page--narrow">
      <p className="eyebrow">Account</p>
      <h1 className="page-title">Reset your password</h1>

      {sent ? (
        <div className="notice notice--success">
          <p className="notice__title">Check your inbox</p>
          <p>
            If an account exists for <strong>{email}</strong>, we've sent a link to choose a new
            password. It expires in 30 minutes.
          </p>
          <p style={{ marginTop: 12 }}>
            <Link href="/login">Back to sign in</Link>
          </p>
        </div>
      ) : (
        <div className="card checkout-panel">
          <p className="page-lede" style={{ marginTop: 0 }}>
            Enter your email and we'll send you a link to set a new password.
          </p>
          <div className="field">
            <label htmlFor="reset-email">Email</label>
            <input
              id="reset-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </div>
          {error && <p className="error-text">{error}</p>}
          <button
            onClick={handleSubmit}
            disabled={submitting || !email}
            className="btn btn-primary btn-block"
          >
            {submitting ? "Sending…" : "Send reset link"}
          </button>
          <p className="auth-footnote">
            <Link href="/login">Remembered it? Sign in</Link>
          </p>
        </div>
      )}
    </main>
  );
}
