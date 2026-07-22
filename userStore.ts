import { db } from "./firebaseAdmin";

export type PlanTier = "free" | "design_pass" | "artist_starter" | "studio";
export type AccountRole = "consumer" | "artist" | "studio_admin" | "admin";

// Emails in this list are automatically promoted to the platform "admin" role
// (unlimited generations, access to the admin panel) the moment they sign in —
// no manual Firestore edit needed. Add more by comma-separating the
// ADMIN_EMAILS env var, or just editing this default list.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "craigtrickett@gmail.com")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export interface UserDoc {
  uid: string;
  email: string | null;
  displayName: string | null;
  role: AccountRole;
  tier: PlanTier;
  createdAt: string;
  // Stripe fields — populated once billing is wired up.
  stripeCustomerId: string | null;
  subscriptionId: string | null;
  subscriptionStatus: "none" | "active" | "past_due" | "canceled";
  // Usage metering — enforced server-side on every generation call.
  generationsThisPeriod: number;
  periodStart: string;
  // Admin-grantable bonus generations, on top of whatever the tier allows —
  // consumed before the tier limit kicks in. Also how "free extra credit" works.
  bonusGenerations: number;
}

// Free-tier limits per rolling 30-day period. Paid tiers get effectively
// unlimited generations, enforced by subscriptionStatus instead.
export const FREE_TIER_GENERATION_LIMIT = 1;

function newPeriodStart(): string {
  return new Date().toISOString();
}

function isPeriodExpired(periodStart: string): boolean {
  const started = new Date(periodStart).getTime();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  return Date.now() - started > THIRTY_DAYS_MS;
}

/** Fetches a user's doc, creating it with sensible defaults on their very first authenticated request. */
export async function ensureUserDoc(uid: string, email: string | null, displayName: string | null): Promise<UserDoc> {
  if (!db) throw new Error("Firestore is not configured.");
  const ref = db.collection("users").doc(uid);
  const snap = await ref.get();
  const isAdminEmail = !!email && ADMIN_EMAILS.includes(email.toLowerCase());

  if (snap.exists) {
    const existing = snap.data() as UserDoc;
    // If this email is on the admin list but the doc predates it (or was
    // demoted by mistake), re-promote automatically on sign-in.
    if (isAdminEmail && existing.role !== "admin") {
      await ref.update({ role: "admin" });
      return { ...existing, role: "admin" };
    }
    return existing;
  }

  const doc: UserDoc = {
    uid,
    email,
    displayName,
    role: isAdminEmail ? "admin" : "consumer",
    tier: "free",
    createdAt: newPeriodStart(),
    stripeCustomerId: null,
    subscriptionId: null,
    subscriptionStatus: "none",
    generationsThisPeriod: 0,
    periodStart: newPeriodStart(),
    bonusGenerations: 0
  };
  await ref.set(doc);
  return doc;
}

export async function getUserDoc(uid: string): Promise<UserDoc | null> {
  if (!db) throw new Error("Firestore is not configured.");
  const snap = await db.collection("users").doc(uid).get();
  return snap.exists ? (snap.data() as UserDoc) : null;
}

/** Returns whether this user is allowed to generate right now, and their current usage/limit for display. */
export async function checkGenerationAllowance(
  uid: string
): Promise<{ allowed: boolean; used: number; limit: number | null; tier: PlanTier; role: AccountRole }> {
  if (!db) throw new Error("Firestore is not configured.");
  const ref = db.collection("users").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("User not found.");
  let user = snap.data() as UserDoc;

  // Admins always have unlimited access — this is what makes an admin
  // account genuinely unlimited, not just "a very high limit".
  if (user.role === "admin") {
    return { allowed: true, used: user.generationsThisPeriod, limit: null, tier: user.tier, role: user.role };
  }

  // Paid, active subscriptions (Artist/Studio) get unlimited generations.
  const isPaidActive = user.tier !== "free" && user.subscriptionStatus === "active";
  if (isPaidActive) {
    return { allowed: true, used: user.generationsThisPeriod, limit: null, tier: user.tier, role: user.role };
  }

  // Free tier (and lapsed paid tiers) — roll the usage window if expired.
  if (isPeriodExpired(user.periodStart)) {
    await ref.update({ generationsThisPeriod: 0, periodStart: newPeriodStart() });
    user = { ...user, generationsThisPeriod: 0, periodStart: newPeriodStart() };
  }

  // Bonus generations (admin-granted) are consumed before the tier limit applies.
  const bonus = user.bonusGenerations || 0;
  const effectiveLimit = FREE_TIER_GENERATION_LIMIT + bonus;
  return { allowed: user.generationsThisPeriod < effectiveLimit, used: user.generationsThisPeriod, limit: effectiveLimit, tier: user.tier, role: user.role };
}

/** Call this once a generation actually succeeds — increments the usage counter. */
export async function recordGeneration(uid: string): Promise<void> {
  if (!db) throw new Error("Firestore is not configured.");
  const ref = db.collection("users").doc(uid);
  const snap = await ref.get();
  await ref.update({ generationsThisPeriod: (snap.data()?.generationsThisPeriod || 0) + 1 });
}

// ---------------------------------------------------------------------
// Admin account management
// ---------------------------------------------------------------------

/** Lists all user accounts for the admin panel, newest first. */
export async function listAllUsers(): Promise<UserDoc[]> {
  if (!db) throw new Error("Firestore is not configured.");
  const snap = await db.collection("users").orderBy("createdAt", "desc").limit(500).get();
  return snap.docs.map((d) => d.data() as UserDoc);
}

/** Admin action: change a user's role or tier directly. */
export async function adminUpdateUser(
  uid: string,
  patch: Partial<Pick<UserDoc, "role" | "tier" | "subscriptionStatus">>
): Promise<UserDoc> {
  if (!db) throw new Error("Firestore is not configured.");
  const ref = db.collection("users").doc(uid);
  await ref.update(patch);
  const snap = await ref.get();
  return snap.data() as UserDoc;
}

/** Admin action: grant bonus generations (on top of whatever their tier allows), or reset usage this period. */
export async function adminGrantGenerations(uid: string, amount: number): Promise<UserDoc> {
  if (!db) throw new Error("Firestore is not configured.");
  const ref = db.collection("users").doc(uid);
  const snap = await ref.get();
  const current = (snap.data()?.bonusGenerations as number) || 0;
  await ref.update({ bonusGenerations: current + amount });
  const updated = await ref.get();
  return updated.data() as UserDoc;
}

/** Admin action: reset a user's usage counter for the current period (e.g. as a goodwill gesture alongside a refund). */
export async function adminResetUsage(uid: string): Promise<UserDoc> {
  if (!db) throw new Error("Firestore is not configured.");
  const ref = db.collection("users").doc(uid);
  await ref.update({ generationsThisPeriod: 0, periodStart: newPeriodStart() });
  const snap = await ref.get();
  return snap.data() as UserDoc;
}
