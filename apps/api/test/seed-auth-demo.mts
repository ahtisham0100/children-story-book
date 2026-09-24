// One-off: seed a demo customer (with password) and an order, for a live
// browser test of the logged-in /account page. Prints the credentials.
// Delete with:  npx tsx test/seed-auth-demo.mts --clean
import { prisma } from "../src/db";
import { findOrCreateCustomerByEmail, setCustomerPassword } from "../src/auth/service";

// Email can be overridden by passing it as an arg, e.g.
//   npx tsx test/seed-auth-demo.mts imagitale88@gmail.com
const EMAIL = process.argv.find((a) => a.includes("@")) ?? "demo-account@example.com";
const PASSWORD = "Sunflower-22!";

async function clean() {
  const c = await prisma.customer.findUnique({ where: { email: EMAIL } });
  if (c) {
    const orders = await prisma.order.findMany({ where: { customerId: c.id } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orders.map((o) => o.id) } } });
    await prisma.order.deleteMany({ where: { customerId: c.id } });
    await prisma.customer.delete({ where: { id: c.id } });
    console.log("cleaned demo customer + orders");
  } else {
    console.log("nothing to clean");
  }
}

async function seed() {
  const cust = await findOrCreateCustomerByEmail(EMAIL);
  await setCustomerPassword(cust.id, PASSWORD);
  // Two orders at different statuses, to show status pills + history.
  for (const [i, status] of [["dispatched"], ["delivered"]].entries()) {
    await prisma.order.create({
      data: {
        customerId: cust.id,
        email: EMAIL,
        shippingName: "Demo Parent",
        shippingLine1: `${i + 1} Rue de Test`,
        shippingCity: "Paris",
        shippingPostalCode: "75001",
        shippingCountry: "FR",
        status: status[0]!,
        totalCents: 3490,
        currency: "eur",
        gdprConsentAt: new Date(),
        items: {
          create: [
            {
              sessionId: `demo-sess-${i}`,
              storyId: "demo-book",
              bookTitle: i === 0 ? "Demo book - one child" : "Demo book - two children",
              priceCents: 3490,
              configSnapshot: {},
              printPageKeys: [],
            },
          ],
        },
      },
    });
  }
  console.log(`seeded ${EMAIL} / ${PASSWORD} with 2 orders`);
}

(async () => {
  if (process.argv.includes("--clean")) await clean();
  else await seed();
  await prisma.$disconnect();
})();
