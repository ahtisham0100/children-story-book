import type { Metadata } from "next";
import { Playfair_Display, Work_Sans } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const display = Playfair_Display({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["500", "600", "700"],
  style: ["normal", "italic"],
});

const body = Work_Sans({
  subsets: ["latin"],
  variable: "--font-body",
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Your Storybook — Cart & Checkout",
};

function BookMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 6.5C10.5 5 8 4.5 4 4.8V18c4-.3 6.5.2 8 1.7 1.5-1.5 4-2 8-1.7V4.8c-4-.3-6.5.2-8 1.7Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M12 6.5V19.7" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>
        <header className="site-header">
          <div className="site-header__inner">
            <Link href="/" className="site-header__mark">
              <BookMark />
              <span>
                Your Storybook
                <small>Personalised, printed, delivered</small>
              </span>
            </Link>
            <nav className="site-header__nav">
              <Link href="/account">Account</Link>
              <Link href="/cart">Cart</Link>
            </nav>
          </div>
        </header>
        <div className="site-body">{children}</div>
      </body>
    </html>
  );
}
