"use client";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { getMe, type Me } from "@/lib/auth";

const NAV = [
  { href: "/admin/queues", label: "Queues" },
  { href: "/admin/orders", label: "Orders" },
  { href: "/admin/storage", label: "Storage" },
  { href: "/admin/deletions", label: "Deletions" },
];

/**
 * The /admin shell. Client-side only (every page here fetches in the browser;
 * a server-side fetch crashes the Next 14 dev worker in this repo).
 *
 * The gate below is cosmetic: it decides what to render. The real boundary is
 * the API, where every /api/admin route checks the session and role itself, so
 * a non-admin who bypasses this still gets 401/403 from every call.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMe()
      .then((who) => {
        if (cancelled) return;
        if (!who) router.replace("/login");
        setMe(who);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (error) {
    return (
      <main className="page page--narrow">
        <p className="eyebrow">Admin</p>
        <h1 className="page-title">Couldn&apos;t check your account</h1>
        <p className="page-lede">{error}</p>
      </main>
    );
  }

  if (me === undefined || me === null) {
    return (
      <main className="page page--narrow">
        <p className="page-lede" aria-live="polite">
          {me === null ? "Redirecting to sign in…" : "Checking your access…"}
        </p>
      </main>
    );
  }

  if (me.role !== "admin") {
    return (
      <main className="page page--narrow">
        <p className="eyebrow">Admin</p>
        <h1 className="page-title">Not authorised</h1>
        <p className="page-lede">
          You&apos;re signed in as {me.email}, which isn&apos;t an admin account.
        </p>
        <Link href="/account" className="btn btn-ghost">
          Back to your account
        </Link>
      </main>
    );
  }

  return (
    <div className="admin">
      <nav className="admin-nav" aria-label="Admin sections">
        <span className="admin-nav__title">Admin</span>
        {NAV.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`admin-nav__link${active ? " admin-nav__link--active" : ""}`}
              aria-current={active ? "page" : undefined}
            >
              {item.label}
            </Link>
          );
        })}
        <span className="admin-nav__who">{me.email}</span>
      </nav>
      <main className="admin__main">{children}</main>
    </div>
  );
}
