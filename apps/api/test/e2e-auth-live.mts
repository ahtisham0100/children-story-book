// Live end-to-end auth check against the REAL running API + Postgres.
// Seeds directly through Prisma (so no real Stripe/Resend calls), then drives
// the HTTP endpoints with manual cookie handling. Run the API first:
//   npm run server           (in one shell)
//   npx tsx test/e2e-auth-live.mts
import { prisma } from "../src/db";
import {
  findOrCreateCustomerByEmail,
  issueToken,
  setCustomerPassword,
} from "../src/auth/service";

const BASE = process.env.API_BASE ?? "http://localhost:3001";
const stamp = Date.now();
const emailA = `e2e+a-${stamp}@example.com`;
const emailB = `e2e+b-${stamp}@example.com`;
const PASSWORD = "Sunflower-22!";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ✓" : "  ✗ FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? (pass += 1) : (fail += 1);
}

/** Pulls the cbp_session cookie value out of a response's Set-Cookie. */
function cookieFrom(res: Response): string | null {
  const raw = res.headers.get("set-cookie");
  if (!raw) return null;
  const m = raw.match(/cbp_session=([^;]*)/);
  return m?.[1] ?? null;
}

async function seedOrder(customerId: string, email: string) {
  return prisma.order.create({
    data: {
      customerId,
      email,
      shippingName: "E2E Tester",
      shippingLine1: "1 Test St",
      shippingCity: "Paris",
      shippingPostalCode: "75001",
      shippingCountry: "FR",
      status: "delivered",
      totalCents: 3490,
      currency: "eur",
      gdprConsentAt: new Date(),
      items: {
        create: [
          {
            sessionId: `sess-${stamp}`,
            storyId: "demo-book",
            bookTitle: "Demo book — one child",
            priceCents: 3490,
            configSnapshot: {},
            printPageKeys: [],
          },
        ],
      },
    },
  });
}

async function main() {
  console.log(`\nLive auth E2E against ${BASE}\n`);

  // --- Seed two customers with orders (simulating silent checkout accounts) ---
  const custA = await findOrCreateCustomerByEmail(emailA);
  await setCustomerPassword(custA.id, PASSWORD);
  const orderA = await seedOrder(custA.id, emailA);

  const custB = await findOrCreateCustomerByEmail(emailB);
  const orderB = await seedOrder(custB.id, emailB);

  // === 1. Password login issues a session cookie ===
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: emailA.toUpperCase(), password: PASSWORD }), // case-insensitive
  });
  const cookie = cookieFrom(loginRes);
  check("password login → 200 + session cookie", loginRes.status === 200 && !!cookie, `status ${loginRes.status}`);
  const auth = { cookie: `cbp_session=${cookie}` };

  // === 2. /me reflects the logged-in customer ===
  const meRes = await fetch(`${BASE}/api/auth/me`, { headers: auth });
  const me = (await meRes.json()) as { email?: string; hasPassword?: boolean };
  check("/me → 200 with correct email + hasPassword", meRes.status === 200 && me.email === emailA && me.hasPassword === true, JSON.stringify(me));

  // === 3. Account order history is scoped to this customer (RLS) ===
  const ordersRes = await fetch(`${BASE}/api/account/orders`, { headers: auth });
  const orders = await ordersRes.json();
  const ids = Array.isArray(orders) ? orders.map((o: any) => o.id) : [];
  check("account orders → only own order returned", ordersRes.status === 200 && ids.includes(orderA.id) && !ids.includes(orderB.id), `got ${ids.length} order(s)`);

  // === 4. Receipt PDF for own order ===
  const receiptRes = await fetch(`${BASE}/api/account/orders/${orderA.id}/receipt`, { headers: auth });
  const receiptBuf = Buffer.from(await receiptRes.arrayBuffer());
  const isPdf = receiptBuf.subarray(0, 4).toString("latin1") === "%PDF";
  check("own receipt → 200 application/pdf", receiptRes.status === 200 && receiptRes.headers.get("content-type") === "application/pdf" && isPdf, `${receiptBuf.length} bytes`);

  // === 5. RLS: customer A cannot download customer B's receipt ===
  const crossRes = await fetch(`${BASE}/api/account/orders/${orderB.id}/receipt`, { headers: auth });
  check("cross-customer receipt → 404 (RLS blocks)", crossRes.status === 404, `status ${crossRes.status}`);

  // === 6. Logout destroys the session ===
  const logoutRes = await fetch(`${BASE}/api/auth/logout`, { method: "POST", headers: auth });
  check("logout → 200", logoutRes.status === 200);
  const meAfter = await fetch(`${BASE}/api/auth/me`, { headers: auth });
  check("/me after logout → 401 (session revoked)", meAfter.status === 401, `status ${meAfter.status}`);

  // === 7. Activation/reset token → set-password (single-use) ===
  const activation = await issueToken(custA.id, "activation");
  const setRes = await fetch(`${BASE}/api/auth/set-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: activation, password: "BrandNew-99!" }),
  });
  const setCookie = cookieFrom(setRes);
  check("set-password with activation token → 200 + auto-login cookie", setRes.status === 200 && !!setCookie, `status ${setRes.status}`);

  const reuseRes = await fetch(`${BASE}/api/auth/set-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: activation, password: "Another-99!" }),
  });
  check("reusing the same token → 400 (single-use)", reuseRes.status === 400, `status ${reuseRes.status}`);

  // === 8. Magic-link verify sets a working session and redirects ===
  const magic = await issueToken(custA.id, "magic_link");
  const verifyRes = await fetch(`${BASE}/api/auth/magic-link/verify?token=${encodeURIComponent(magic)}`, { redirect: "manual" });
  const magicCookie = cookieFrom(verifyRes);
  const loc = verifyRes.headers.get("location") ?? "";
  check("magic-link verify → 302 to /account + cookie", (verifyRes.status === 302 || verifyRes.status === 303) && loc.includes("/account") && !!magicCookie, `status ${verifyRes.status} loc ${loc}`);
  const meMagic = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: `cbp_session=${magicCookie}` } });
  check("magic-link session works on /me → 200", meMagic.status === 200);

  const expiredMagic = await fetch(`${BASE}/api/auth/magic-link/verify?token=bogus`, { redirect: "manual" });
  const eloc = expiredMagic.headers.get("location") ?? "";
  check("bad magic-link token → 302 to /login?error=link_expired", eloc.includes("/login?error=link_expired"), `loc ${eloc}`);

  // --- Cleanup ---
  await prisma.orderItem.deleteMany({ where: { orderId: { in: [orderA.id, orderB.id] } } });
  await prisma.order.deleteMany({ where: { id: { in: [orderA.id, orderB.id] } } });
  await prisma.customer.deleteMany({ where: { id: { in: [custA.id, custB.id] } } });

  console.log(`\n${fail === 0 ? "ALL PASSED" : "SOME FAILED"}: ${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("E2E crashed:", e);
  await prisma.$disconnect();
  process.exit(1);
});
