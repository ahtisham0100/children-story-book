// Grants (or with --revoke, removes) the admin role for an EXISTING customer.
// This CLI is the only way to change a role. No API route can, by design: an
// endpoint that grants admin is exactly what an attacker would look for.
//
//   npm run make-admin -- someone@example.com
//   npm run make-admin -- someone@example.com --revoke
//
// Uses DATABASE_URL from apps/api/.env, so it acts on whichever database that
// points at. The customer must already exist (checkout or seed creates
// accounts), which stops a typo from creating a new admin account.
import { prisma } from "../src/db";
import { normalizeEmail } from "../src/auth/service";
import { CUSTOMER_ROLE } from "../src/auth/guard";

const args = process.argv.slice(2);
const revoke = args.includes("--revoke");
const emailArg = args.find((a) => !a.startsWith("--"));

async function main(): Promise<number> {
  if (!emailArg || !emailArg.includes("@")) {
    console.error("Usage: npm run make-admin -- <email> [--revoke]");
    return 1;
  }
  const email = normalizeEmail(emailArg);
  const customer = await prisma.customer.findUnique({ where: { email } });
  if (!customer) {
    console.error(`No customer with email ${email}. They need an account first (e.g. from checkout).`);
    return 1;
  }

  const role = revoke ? CUSTOMER_ROLE.customer : CUSTOMER_ROLE.admin;
  if (customer.role === role) {
    console.log(`${email} already has role "${role}". Nothing to do.`);
    return 0;
  }
  await prisma.customer.update({ where: { id: customer.id }, data: { role } });
  console.log(`${email}: role "${customer.role}" → "${role}".`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
