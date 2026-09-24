"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { loginWithPassword, requestMagicLink } from "@/lib/auth";

type Tab = "magic" | "password";

function MagicLinkTab() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSend = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await requestMagicLink(email);
      setSent(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (sent) {
    return (
      <div className="notice notice--success">
        <p className="notice__title">Check your inbox</p>
        <p>
          If an account exists for <strong>{email}</strong>, a one-click sign-in link is on its way.
          It expires in 15 minutes.
        </p>
      </div>
    );
  }

  return (
    <>
      <p className="page-lede" style={{ marginTop: 0 }}>
        We'll email you a link that signs you in instantly — no password to remember.
      </p>
      <div className="field">
        <label htmlFor="magic-email">Email</label>
        <input
          id="magic-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />
      </div>
      {error && <p className="error-text">{error}</p>}
      <button
        onClick={handleSend}
        disabled={submitting || !email}
        className="btn btn-primary btn-block"
      >
        {submitting ? "Sending…" : "Email me a sign-in link"}
      </button>
    </>
  );
}

function PasswordTab() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLogin = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await loginWithPassword(email, password);
      router.push("/account");
    } catch {
      // The API returns a single generic 401 for any failure (no user enumeration).
      setError("Invalid email or password.");
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="field">
        <label htmlFor="pw-email">Email</label>
        <input
          id="pw-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />
      </div>
      <div className="field">
        <label htmlFor="pw-password">Password</label>
        <div className="password-field">
          <input
            id="pw-password"
            type={show ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Your password"
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
      </div>
      {error && <p className="error-text">{error}</p>}
      <button
        onClick={handleLogin}
        disabled={submitting || !email || !password}
        className="btn btn-primary btn-block"
      >
        {submitting ? "Signing in…" : "Sign in"}
      </button>
      <p className="auth-footnote">
        <Link href="/reset-password">Forgot your password?</Link>
      </p>
    </>
  );
}

function LoginInner() {
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<Tab>("magic"); // magic link is the default
  const linkExpired = searchParams.get("error") === "link_expired";

  return (
    <main className="page page--narrow">
      <p className="eyebrow">Welcome back</p>
      <h1 className="page-title">Sign in</h1>

      {linkExpired && (
        <div className="notice notice--error">
          That sign-in link has expired or already been used. Request a fresh one below.
        </div>
      )}

      <div className="card checkout-panel">
        <div className="auth-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === "magic"}
            className={`auth-tab ${tab === "magic" ? "auth-tab--active" : ""}`}
            onClick={() => setTab("magic")}
          >
            Magic link
          </button>
          <button
            role="tab"
            aria-selected={tab === "password"}
            className={`auth-tab ${tab === "password" ? "auth-tab--active" : ""}`}
            onClick={() => setTab("password")}
          >
            Password
          </button>
        </div>

        {tab === "magic" ? <MagicLinkTab /> : <PasswordTab />}
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="page page--narrow"><p className="page-lede">Loading…</p></main>}>
      <LoginInner />
    </Suspense>
  );
}
