import Stripe from "stripe";
import { env } from "./env";

// Unlike this codebase's other credential fallbacks (db.ts's placeholder URL,
// storage.ts's empty-string R2 keys), the Stripe SDK THROWS at construction
// time if given an empty string — an empty-string fallback here would crash
// the entire server at boot, not just Stripe calls, whenever
// STRIPE_SECRET_KEY is unset. Confirmed live: `new Stripe("")` threw
// "Neither apiKey nor config.authenticator provided" straight out of
// src/index.ts's import chain. A placeholder string satisfies the
// constructor's "something was provided" check without making any network
// call — real calls still fail clearly, just at call time instead of import time.
export const stripe = new Stripe(env.STRIPE_SECRET_KEY ?? "sk_test_unconfigured");
