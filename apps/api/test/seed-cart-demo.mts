// Seed personalized "book" sessions straight into a demo-able state so the
// storefront cart/checkout flow can be recorded without running the paid
// personalization pipeline. Creates Session + Character rows (with a rawKey so
// the checkout guard passes). Pages won't be rendered in R2, so the cart shows
// placeholder covers — the flow (cart -> checkout form -> Stripe) still works.
//
//   npx tsx test/seed-cart-demo.mts          # seed
//   npx tsx test/seed-cart-demo.mts --clean  # remove the demo sessions
import { prisma } from "../src/db";
import { newSessionExpiry } from "../src/sessionExpiry";

const MARKER = "Demo Child"; // childName marker so --clean only removes our seeds

const BOOKS = [
  { storyId: "demo-book", chars: [{ slot: "child_1", name: `${MARKER} A` }] },
  { storyId: "demo-book-duo", chars: [
    { slot: "child_1", name: `${MARKER} B` },
    { slot: "child_2", name: `${MARKER} C` },
  ] },
];

async function clean() {
  const chars = await prisma.character.findMany({
    where: { childName: { startsWith: MARKER } },
    select: { sessionId: true },
  });
  const sessionIds = [...new Set(chars.map((c) => c.sessionId))];
  if (sessionIds.length === 0) return console.log("nothing to clean");
  await prisma.character.deleteMany({ where: { sessionId: { in: sessionIds } } });
  await prisma.session.deleteMany({ where: { id: { in: sessionIds } } });
  console.log(`cleaned ${sessionIds.length} demo cart session(s)`);
}

async function seed() {
  const out: string[] = [];
  for (const book of BOOKS) {
    const session = await prisma.session.create({
      data: { storyId: book.storyId, locale: "fr", status: "done", ...newSessionExpiry() },
    });
    for (const c of book.chars) {
      await prisma.character.create({
        data: {
          sessionId: session.id,
          slot: c.slot,
          childName: c.name,
          // A dummy but present rawKey — checkout only checks it's non-null.
          rawKey: `sessions/${session.id}/raw/${c.slot}.jpg`,
        },
      });
    }
    out.push(`  ${book.storyId.padEnd(14)} -> http://localhost:3000/cart?add=${session.id}`);
  }
  console.log(`\nSeeded ${BOOKS.length} demo books. Visit each link (adds to the cart):\n`);
  console.log(out.join("\n"));
  console.log(`\nThen open http://localhost:3000/cart to see both, or /checkout to buy.\n`);
}

(async () => {
  if (process.argv.includes("--clean")) await clean();
  else await seed();
  await prisma.$disconnect();
})();
