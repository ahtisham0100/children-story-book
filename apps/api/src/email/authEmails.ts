import { Resend } from "resend";
import { env } from "../env";
// Same wording as /set-password and /confirmation (see src/gdpr/notice.ts).
import { GDPR_DELETION_NOTICE } from "../gdpr/notice";

// Same construction-time-throw guard as orderConfirmation.ts / stripeClient.ts:
// Resend's constructor throws on an empty key, so a placeholder keeps the server
// bootable with RESEND_API_KEY unset — the send itself fails clearly at call time.
const resend = new Resend(env.RESEND_API_KEY ?? "re_unconfigured");


/** Link into the frontend that completes an activation or reset (the set-password page). */
export function setPasswordUrl(rawToken: string): string {
  return `${env.APP_BASE_URL}/set-password?token=${encodeURIComponent(rawToken)}`;
}

/** Magic-link login lands on the API verify route, which sets the cookie then redirects. */
export function magicLinkUrl(rawToken: string): string {
  return `${env.API_PUBLIC_URL}/api/auth/magic-link/verify?token=${encodeURIComponent(rawToken)}`;
}

/**
 * Post-checkout "your account is ready" email. Sent once, only for a brand-new
 * account with no password yet, so repeat buyers aren't nagged. The account
 * already exists (created silently at checkout) — this just lets them set a
 * password / take control of it.
 */
export async function sendAccountActivationEmail(to: string, rawToken: string): Promise<void> {
  // Throws on a Resend error (reported in the result, not thrown) so fulfilment
  // doesn't record an unsent activation email as sent. The magic-link and
  // reset senders below deliberately DON'T throw: those routes only send for
  // an existing account, so a 500 there would reveal the account exists.
  const { error } = await resend.emails.send({
    from: env.RESEND_FROM_ADDRESS,
    to,
    subject: "Activate your Storybook account",
    text:
      `Thanks for your order — we've created an account for you so you can track it and reorder easily.\n\n` +
      `Set your password to activate it:\n${setPasswordUrl(rawToken)}\n\n` +
      `This link expires in 7 days. If it does, you can request a new one any time from the login page — ` +
      `and you can always sign in without a password using a magic link.\n\n` +
      `${GDPR_DELETION_NOTICE}`,
  });
  if (error) {
    throw new Error(`Activation email failed: ${error.name}: ${error.message}`);
  }
}

export async function sendMagicLinkEmail(to: string, rawToken: string): Promise<void> {
  await resend.emails.send({
    from: env.RESEND_FROM_ADDRESS,
    to,
    subject: "Your Storybook sign-in link",
    text:
      `Click to sign in — no password needed:\n${magicLinkUrl(rawToken)}\n\n` +
      `This link expires in 15 minutes and can only be used once. ` +
      `If you didn't request it, you can safely ignore this email.`,
  });
}

export async function sendPasswordResetEmail(to: string, rawToken: string): Promise<void> {
  await resend.emails.send({
    from: env.RESEND_FROM_ADDRESS,
    to,
    subject: "Reset your Storybook password",
    text:
      `We received a request to reset your password. Choose a new one here:\n${setPasswordUrl(rawToken)}\n\n` +
      `This link expires in 30 minutes and can only be used once. ` +
      `If you didn't request it, you can safely ignore this email — your password won't change.`,
  });
}
