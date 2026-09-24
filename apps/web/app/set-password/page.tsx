"use client";
import { Suspense, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { setPassword } from "@/lib/auth";
import { assessPasswordStrength } from "@/lib/password";
import { GDPR_DELETION_NOTICE } from "@/lib/gdprNotice";

const METER_COLORS = ["#b4453a", "#b4453a", "#c69a5c", "#3e6a49", "#3e6a49"];

function SetPasswordInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [password, setPasswordValue] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const strength = useMemo(() => assessPasswordStrength(password), [password]);
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit = !!token && strength.acceptable && !mismatch && confirm.length > 0;

  const handleSubmit = async () => {
    if (!token) return;
    setSubmitting(true);
    setError(null);
    try {
      await setPassword(token, password);
      router.push("/account");
    } catch (e) {
      setError(e instanceof Error ? e.message : "This link is invalid or has expired.");
      setSubmitting(false);
    }
  };

  if (!token) {
    return (
      <main className="page page--narrow">
        <p className="eyebrow">Account</p>
        <h1 className="page-title">Missing link</h1>
        <p className="page-lede">
          This page needs a valid activation or reset link. Open the most recent email we sent you,
          or <Link href="/reset-password">request a new link</Link>.
        </p>
      </main>
    );
  }

  return (
    <main className="page page--narrow">
      <p className="eyebrow">Account</p>
      <h1 className="page-title">Choose a password</h1>
      <p className="page-lede">Set a password to activate your account and sign in next time.</p>

      <div className="card checkout-panel">
        <div className="field">
          <label htmlFor="password">New password</label>
          <div className="password-field">
            <input
              id="password"
              type={show ? "text" : "password"}
              value={password}
              onChange={(e) => setPasswordValue(e.target.value)}
              placeholder="At least 8 characters"
            />
            <button
              type="button"
              className="password-toggle"
              onClick={() => setShow((s) => !s)}
              aria-label={show ? "Hide password" : "Show password"}
            >
              {show ? "Hide" : "Show"}
            </button>
          </div>

          {password.length > 0 && (
            <div className="strength-meter" aria-live="polite">
              <div className="strength-meter__track">
                <div
                  className="strength-meter__fill"
                  style={{
                    width: `${(strength.score / 4) * 100}%`,
                    background: METER_COLORS[strength.score],
                  }}
                />
              </div>
              <span className="strength-meter__label" style={{ color: METER_COLORS[strength.score] }}>
                {strength.label}
              </span>
            </div>
          )}
        </div>

        <div className="field">
          <label htmlFor="confirm">Confirm password</label>
          <input
            id="confirm"
            type={show ? "text" : "password"}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Re-enter your password"
          />
          {mismatch && <p className="error-text">Passwords don't match.</p>}
        </div>

        {error && <p className="error-text">{error}</p>}
        <button onClick={handleSubmit} disabled={submitting || !canSubmit} className="btn btn-primary btn-block">
          {submitting ? "Saving…" : "Activate account"}
        </button>
      </div>

      {/* Same promise as the activation email that links here (apps/api/src/email/authEmails.ts). */}
      <div className="trust-note">
        <p className="trust-note__title">Your data, protected by design</p>
        <p className="trust-note__body">{GDPR_DELETION_NOTICE}</p>
      </div>
    </main>
  );
}

export default function SetPasswordPage() {
  return (
    <Suspense fallback={<main className="page page--narrow"><p className="page-lede">Loading…</p></main>}>
      <SetPasswordInner />
    </Suspense>
  );
}
