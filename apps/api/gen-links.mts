// TEMP helper: mint real single-use auth links for local verification without
// depending on email delivery. Prints the exact URLs the Resend emails would carry.
import { findOrCreateCustomerByEmail, issueToken } from "./src/auth/service";
import { setPasswordUrl, magicLinkUrl } from "./src/email/authEmails";

const email = process.argv[2] ?? "demo-account@example.com";

const customer = await findOrCreateCustomerByEmail(email);

const magic = await issueToken(customer.id, "magic_link");
const reset = await issueToken(customer.id, "password_reset");
const activation = await issueToken(customer.id, "activation");

console.log(`\nAuth links for ${email} (customer ${customer.id})\n`);
console.log(`MAGIC-LINK LOGIN (15 min, one-time) — click to sign straight in:`);
console.log(`  ${magicLinkUrl(magic)}\n`);
console.log(`PASSWORD RESET (30 min, one-time) — opens set-password:`);
console.log(`  ${setPasswordUrl(reset)}\n`);
console.log(`ACCOUNT ACTIVATION (7 days, one-time) — opens set-password:`);
console.log(`  ${setPasswordUrl(activation)}\n`);

process.exit(0);
