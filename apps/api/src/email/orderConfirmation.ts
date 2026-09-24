import { Resend } from "resend";
import { env } from "../env";
// Same wording as /confirmation and /set-password (see src/gdpr/notice.ts).
import { GDPR_DELETION_NOTICE } from "../gdpr/notice";

// Same construction-time-throw issue as stripeClient.ts: Resend's constructor
// throws on an empty/missing key rather than deferring to call time, so an
// empty-string fallback would crash the whole server at boot.
const resend = new Resend(env.RESEND_API_KEY ?? "re_unconfigured");


interface OrderForEmail {
  id: string;
  email: string;
  totalCents: number;
  currency: string;
  items: { bookTitle: string }[];
}

function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("en", { style: "currency", currency }).format(cents / 100);
}

/** Absolute, since a relative link in an email has nothing to resolve against. */
export function trackOrderUrl(orderId: string): string {
  return `${env.APP_BASE_URL.replace(/\/+$/, "")}/track/${encodeURIComponent(orderId)}`;
}

export async function sendOrderConfirmationEmail(order: OrderForEmail): Promise<void> {
  const bookList = order.items.map((item) => `- ${item.bookTitle}`).join("\n");
  const total = formatMoney(order.totalCents, order.currency);

  // Resend reports failures in the result instead of throwing. Throw here so
  // fulfilment retries the send and never records an unsent email as sent.
  const { error } = await resend.emails.send({
    from: env.RESEND_FROM_ADDRESS,
    to: order.email,
    subject: `Your order ${order.id} is confirmed`,
    text:
      `Thank you for your order!\n\n` +
      `Order ID: ${order.id}\n` +
      `Books:\n${bookList}\n` +
      `Total: ${total}\n\n` +
      `Estimated delivery: 7-10 business days after printing.\n\n` +
      `${GDPR_DELETION_NOTICE}\n\n` +
      `Track your order any time at ${trackOrderUrl(order.id)} — no login required.`,
  });
  if (error) {
    throw new Error(`Order confirmation email failed: ${error.name}: ${error.message}`);
  }
}
