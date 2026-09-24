// TEMP: register an email as a customer and send a REAL magic-link email,
// printing Resend's raw response so we can confirm deliverability.
import { Resend } from "resend";
import { env } from "./src/env";
import { findOrCreateCustomerByEmail, issueToken } from "./src/auth/service";
import { magicLinkUrl } from "./src/email/authEmails";

const to = process.argv[2] ?? "ahtisham0100@gmail.com";

const customer = await findOrCreateCustomerByEmail(to);
const raw = await issueToken(customer.id, "magic_link");
const link = magicLinkUrl(raw);

const resend = new Resend(env.RESEND_API_KEY ?? "re_unconfigured");
const res = await resend.emails.send({
  from: env.RESEND_FROM_ADDRESS,
  to,
  subject: "Your Storybook sign-in link",
  text: `Click to sign in — no password needed:\n${link}\n\nExpires in 15 minutes, one-time use.`,
});

console.log(`\nfrom:      ${env.RESEND_FROM_ADDRESS}`);
console.log(`to:        ${to}  (customer ${customer.id})`);
console.log(`link:      ${link}`);
console.log(`\nResend response:`);
console.log(JSON.stringify(res, null, 2));
process.exit(0);
