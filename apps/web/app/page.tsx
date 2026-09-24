import Link from "next/link";

export default function Home() {
  return (
    <main className="page page--narrow">
      <p className="eyebrow">Your storybook</p>
      <h1 className="page-title">The book, ready to hold</h1>
      <p className="page-lede">
        Personalise a story on the homepage — once it's rendered, bring it here to review, checkout, and have it printed and delivered.
      </p>
      <Link href="/cart" className="btn btn-primary">
        View your cart <span className="arrow">→</span>
      </Link>
    </main>
  );
}
