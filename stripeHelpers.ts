import Stripe from "stripe";
import { db } from "./firebaseAdmin.js";

const secretKey = process.env.STRIPE_SECRET_KEY;
export const stripeConfigured = !!secretKey && secretKey.trim() !== "";

export const stripe = stripeConfigured ? new Stripe(secretKey as string) : null;

if (!stripeConfigured) {
  console.warn("Stripe is not configured — missing STRIPE_SECRET_KEY. Payments/billing will not work until this is set up.");
}

// Maps our internal plan keys to real Stripe Price IDs (create these in the
// Stripe Dashboard: Products > Add Product > Add Price, then paste the price
// ID — looks like "price_1AbC..." — into the matching env var).
export type PlanKey = "design_pass" | "artist_starter" | "studio";

const PRICE_IDS: Record<PlanKey, string | undefined> = {
  design_pass: process.env.STRIPE_PRICE_DESIGN_PASS,
  artist_starter: process.env.STRIPE_PRICE_ARTIST_STARTER,
  studio: process.env.STRIPE_PRICE_STUDIO
};

const PLAN_MODE: Record<PlanKey, "payment" | "subscription"> = {
  design_pass: "payment", // one-time purchase
  artist_starter: "subscription",
  studio: "subscription"
};

const PLAN_TIER: Record<PlanKey, string> = {
  design_pass: "design_pass",
  artist_starter: "artist_starter",
  studio: "studio"
};

/** Finds (or creates) the Stripe Customer object tied to this Firebase user, and saves the ID to their user doc. */
async function getOrCreateStripeCustomer(uid: string, email: string | null): Promise<string> {
  if (!stripe || !db) throw new Error("Stripe/Firestore is not configured.");
  const ref = db.collection("users").doc(uid);
  const snap = await ref.get();
  const existing = snap.data()?.stripeCustomerId as string | undefined;
  if (existing) return existing;

  const customer = await stripe.customers.create({ email: email || undefined, metadata: { firebaseUid: uid } });
  await ref.update({ stripeCustomerId: customer.id });
  return customer.id;
}

/** Creates a Stripe Checkout Session for the given plan, redirecting back to our app on success/cancel. */
export async function createCheckoutSession(opts: {
  uid: string;
  email: string | null;
  plan: PlanKey;
  successUrl: string;
  cancelUrl: string;
}): Promise<string> {
  if (!stripe) throw new Error("Stripe is not configured.");
  const priceId = PRICE_IDS[opts.plan];
  if (!priceId) {
    throw new Error(`No Stripe price configured for "${opts.plan}" — set the matching STRIPE_PRICE_* env var.`);
  }
  const customerId = await getOrCreateStripeCustomer(opts.uid, opts.email);

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: PLAN_MODE[opts.plan],
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    metadata: { firebaseUid: opts.uid, plan: opts.plan }
  });
  if (!session.url) throw new Error("Stripe did not return a checkout URL.");
  return session.url;
}

/** Creates a Stripe Billing Portal session so a user can manage/cancel their own subscription. */
export async function createBillingPortalSession(uid: string, returnUrl: string): Promise<string> {
  if (!stripe || !db) throw new Error("Stripe/Firestore is not configured.");
  const snap = await db.collection("users").doc(uid).get();
  const customerId = snap.data()?.stripeCustomerId as string | undefined;
  if (!customerId) throw new Error("No billing account found for this user yet — make a purchase first.");

  const session = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
  return session.url;
}

/** Issues a refund for a user's most recent successful payment (admin action). */
export async function refundLatestPayment(uid: string): Promise<{ refunded: boolean; amount?: number }> {
  if (!stripe || !db) throw new Error("Stripe/Firestore is not configured.");
  const snap = await db.collection("users").doc(uid).get();
  const customerId = snap.data()?.stripeCustomerId as string | undefined;
  if (!customerId) throw new Error("This user has no billing history to refund.");

  const charges = await stripe.charges.list({ customer: customerId, limit: 1 });
  const latest = charges.data[0];
  if (!latest || latest.refunded) {
    throw new Error("No refundable payment found for this user.");
  }
  const refund = await stripe.refunds.create({ charge: latest.id });
  return { refunded: true, amount: refund.amount };
}

/**
 * Applies a Stripe webhook event to our Firestore user doc — this is the
 * single source of truth for keeping subscriptionStatus/tier in sync with
 * what was actually paid for. Call this from the raw-body webhook route.
 */
export async function applyStripeEvent(event: Stripe.Event): Promise<void> {
  if (!db) throw new Error("Firestore is not configured.");

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const uid = session.metadata?.firebaseUid;
      const plan = session.metadata?.plan as PlanKey | undefined;
      if (!uid || !plan) break;
      const ref = db.collection("users").doc(uid);
      if (PLAN_MODE[plan] === "payment") {
        // One-time Design Pass — grant a batch of bonus generations rather than a tier change.
        const doc = await ref.get();
        const currentBonus = (doc.data()?.bonusGenerations as number) || 0;
        await ref.update({ bonusGenerations: currentBonus + 20, tier: "design_pass" });
      } else {
        await ref.update({ tier: PLAN_TIER[plan], subscriptionStatus: "active", subscriptionId: session.subscription as string });
      }
      break;
    }
    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      const uid = await findUidByStripeCustomer(sub.customer as string);
      if (!uid) break;
      const status = sub.status === "active" || sub.status === "trialing" ? "active" : sub.status === "past_due" ? "past_due" : "canceled";
      await db.collection("users").doc(uid).update({ subscriptionStatus: status });
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const uid = await findUidByStripeCustomer(sub.customer as string);
      if (!uid) break;
      await db.collection("users").doc(uid).update({ subscriptionStatus: "canceled", tier: "free" });
      break;
    }
    default:
      break;
  }
}

async function findUidByStripeCustomer(customerId: string): Promise<string | null> {
  if (!db) return null;
  const snap = await db.collection("users").where("stripeCustomerId", "==", customerId).limit(1).get();
  return snap.empty ? null : snap.docs[0].id;
}
