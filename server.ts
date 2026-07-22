import express from "express";
import path from "path";
import fs from "fs";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import { requireAuth, optionalAuth, requireAdmin } from "./authMiddleware.js";
import { ensureUserDoc, getUserDoc, checkGenerationAllowance, recordGeneration, listAllUsers, adminUpdateUser, adminGrantGenerations, adminResetUsage } from "./userStore.js";
import { db as firestoreDb } from "./firebaseAdmin.js";
import { stripe, stripeConfigured, createCheckoutSession, createBillingPortalSession, refundLatestPayment, applyStripeEvent } from "./stripeHelpers.js";

dotenv.config();

const app = express();
const PORT = 3000;

// Exported so a Vercel serverless function (api/[...path].ts) can forward
// requests into this same Express app without needing its own copy of every
// route. Vercel's Node runtime accepts an Express app directly as a request
// handler. Locally / on other Node hosts, this export is simply unused —
// `startServer()` below still runs the app the original way (Vite dev
// middleware, static `dist` serving, and a real listening port).
export default app;

// Stripe webhook MUST be registered before express.json() below — Stripe's
// signature verification needs the raw, unparsed request body, not JSON.
app.post("/api/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripeConfigured || !stripe) {
    return res.status(500).send("Stripe is not configured.");
  }
  const signature = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!signature || !webhookSecret) {
    return res.status(400).send("Missing Stripe signature or webhook secret.");
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (err: any) {
    console.error("Stripe webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }
  try {
    await applyStripeEvent(event);
    res.json({ received: true });
  } catch (err: any) {
    console.error("Failed to apply Stripe event:", err);
    // Still 200 so Stripe doesn't endlessly retry a permanently-failing event;
    // the error is logged for investigation instead.
    res.status(200).json({ received: true, applied: false });
  }
});

// Set up body parsers with generous limits to support base64 image uploads —
// a multi-angle project (several photos + generated composites + history
// snapshots) can genuinely reach tens of MB.
app.use(express.json({ limit: "80mb" }));
app.use(express.urlencoded({ limit: "80mb", extended: true }));

// Path for project persistence
const DB_PATH = path.join(process.cwd(), "projects-db.json");

// --- Helpers for the two-phase "analyze then generate" tattoo flow ---

function parseDataUrl(dataUrl: string): { mimeType: string; data: string } {
  const match = /^data:(.+?);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    throw new Error("Expected a base64 data URL for an uploaded image.");
  }
  return { mimeType: match[1], data: match[2] };
}

function extractJson(text: string): any {
  // Model may wrap JSON in markdown fences despite instructions — strip if present.
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  return JSON.parse(cleaned);
}

// The Gemini SDK sometimes throws with the raw HTTP error body (a JSON blob
// like {"error":{"code":503,"message":"...","status":"UNAVAILABLE"}}) sitting
// directly in error.message instead of a plain string. Passing that straight
// through to res.json({ error: ... }) means the client renders literal JSON
// text to the person using the app. This unwraps that case and always
// returns a clean, human-readable string — falling back to a friendly
// message for known transient statuses, and to the caller-provided default
// for anything else unparseable.
function friendlyGeminiError(error: any, fallback: string): string {
  const raw = (error?.message || error?.toString?.() || "").toString().trim();
  if (!raw) return fallback;
  if (!raw.startsWith("{")) return raw;

  try {
    const parsed = JSON.parse(raw);
    const status = parsed?.error?.status || parsed?.status;
    const inner = parsed?.error?.message || parsed?.message || "";
    if (status === "UNAVAILABLE" || /high demand|overloaded/i.test(inner)) {
      return "The image model is currently experiencing high demand. Please wait a moment and try again.";
    }
    if (status === "RESOURCE_EXHAUSTED" || /quota/i.test(inner)) {
      return "The image generation quota has been reached. Please try again shortly.";
    }
    if (typeof inner === "string" && inner.trim()) {
      return inner.trim();
    }
    return fallback;
  } catch {
    // Not actually parseable JSON after all (e.g. just started with a brace
    // coincidentally) — fall back rather than ever showing the raw text.
    return fallback;
  }
}

const CONFIRM_CHOICE_NOTE: Record<string, string> = {
  A: "The user confirmed the detected body part and theme are both correct as described.",
  B: "The user confirmed the body part is correct, but asked to adjust the theme/subject matter — see corrections below.",
  C: "The user confirmed the theme is correct, but asked to adjust the identified body part — see corrections below.",
  D: "The user asked to adjust both the body part and the theme — see corrections below."
};

function buildIsolatedDesignPrompt(opts: {
  bodyPart: string;
  theme: string;
  description: string;
  correction?: string;
  newTattooPrompt: string;
  style: string;
  colorPreference: string;
  hasReferenceImage: boolean;
}): string {
  const { bodyPart, theme, description, correction, newTattooPrompt, style, colorPreference, hasReferenceImage } = opts;
  const correctionLine = correction && correction.trim() ? ` Additional context from the person: "${correction.trim()}".` : "";

  const COLOR_INSTRUCTIONS: Record<string, string> = {
    monochrome: "Use solid black and gray lines and shading only — no color.",
    colorful: "Use vibrant, clean, saturated colors with sharp outlines.",
    pastel: "Use soft, muted pastel tones with gentle, airy shading — no harsh saturated color.",
    sepia: "Use warm sepia and vintage brown tones only, evoking an aged, hand-inked photograph look.",
    blackwork: "Use bold, solid black fill work with high contrast and crisp edges — no shading gradients, no color.",
    whitework: "Use white ink linework only, designed to sit subtly and delicately on skin tone.",
    "single-accent": "Use primarily black linework and shading, with exactly one vivid accent color used sparingly for emphasis on a key detail."
  };
  const colorInstruction = COLOR_INSTRUCTIONS[colorPreference] || COLOR_INSTRUCTIONS.monochrome;

  const colorMatchLine = hasReferenceImage
    ? `\n- CRITICAL COLOR MATCH: the attached reference photo shows the person's actual existing tattoo ink. Study its exact black/gray tone, saturation, and any signs of aging or fading, and match your new design's black/dark tones to that SAME ink tone — do not use a fresh, pure, jet-black. If the requested color preference calls for additional colors (e.g. red, blue) alongside black, only the non-black colors should be fully saturated/new; any black or gray portions of the new design must still match the existing ink's tone exactly, so the final result looks like one continuous, realistically aged piece by the same artist rather than two different tattoos of different ages.`
    : "";

  return `Create a single, isolated tattoo design graphic: ${newTattooPrompt}.

This design is intended to be added next to an existing tattoo on a person's ${bodyPart}. The existing tattoo work is themed as: ${theme}. ${description}${correctionLine}

Style requirements:
- Render in a ${style} tattoo style.
- ${colorInstruction}
- Match the line weight and shading technique that would be consistent with the existing theme described above, so it reads as the same artist's work once applied.
- Thematic cohesion: even though this is a new, separate design, choose motifs, framing elements, and linework that would sit comfortably alongside the existing theme (${theme}) as part of one unified larger piece — e.g. complementary background elements (clouds, water, botanical filler) or subject matter from the same broad tradition — rather than a visually unrelated design that merely happens to be nearby.${colorMatchLine}
- Output the design ISOLATED on a clean, solid, pure white background — no skin, no body parts, no framing, no shadows cast on a surface. This is a flat graphic, not a photo.
- Highly detailed, clean vector-quality line work suitable for both a photorealistic skin composite and a printable stencil outline.`;
}

function buildBlendPrompt(opts: {
  bodyPart: string;
  theme: string;
  description: string;
  confirmChoice: string;
  correction?: string;
  placementBox: { x: number; y: number; width: number; height: number };
  coverUp: boolean;
  designIsPreIsolated?: boolean;
}): string {
  const { bodyPart, theme, description, confirmChoice, correction, placementBox, coverUp, designIsPreIsolated = true } = opts;
  const confirmNote = CONFIRM_CHOICE_NOTE[confirmChoice] || CONFIRM_CHOICE_NOTE.A;
  const correctionLine = correction && correction.trim()
    ? `User-provided corrections/additions to factor in: "${correction.trim()}".`
    : "";
  const extendsOffFrame = placementBox.x < 0 || placementBox.y < 0 || placementBox.x + placementBox.width > 100 || placementBox.y + placementBox.height > 100;
  const boxDescription = `approximately ${placementBox.width.toFixed(0)}% wide by ${placementBox.height.toFixed(0)}% tall of the frame, positioned with its top-left corner at roughly ${placementBox.x.toFixed(0)}% from the left and ${placementBox.y.toFixed(0)}% from the top`;
  const offFrameNote = extendsOffFrame
    ? " IMPORTANT — this marked region extends beyond the edge of this particular photo (the person placed it that way on purpose): this angle is meant to show only a PARTIAL, edge-on slice of a design that is fully visible from another angle/photo of the same body part. Render ONLY the portion of the design that falls within the actual visible photo frame, and let the rest run off the edge naturally, cropped by the photo boundary exactly like a real photograph crops anything near its edge. A partial, cut-off result IS the correct and required output for this generation — it is not a failure, and it is not something to avoid."
    : "";
  // When the box deliberately extends off-frame, a partial/cropped result is the goal, not a failure —
  // several rules below (aspect ratio, cover-up) are written for the normal fully-in-frame case and would
  // otherwise push the model toward shrinking/re-centering the whole design to avoid cropping it. This note
  // is inserted right after the rules list to explicitly resolve that conflict in favor of correct cropping.
  const offFrameOverride = extendsOffFrame
    ? `\n- Partial/edge visibility OVERRIDE (read this last and let it win over any conflicting rule above): the marked region for this specific angle was deliberately drawn so it runs off the edge of the photo. That means only part of the design belongs in this image — the rest is off-camera from this angle. Do NOT shrink, re-center, reposition, or otherwise force the complete design to fit entirely inside the visible photo just to avoid cropping it, even if another rule above (aspect ratio, cover-up, "visible design is mandatory") seems to say the whole design must show — none of those rules apply here. Simply render the slice of the design that falls within the visible frame, cropped naturally at the frame edge, and leave the rest off-camera. A photo where only part of the design is visible, cut off by the edge of the frame, is the correct and expected result.`
    : "";

  const backgroundHandlingNote = designIsPreIsolated
    ? "IMAGE 2 is already isolated on a clean white background — everything except its own linework and color fill is background and must be discarded."
    : "IMAGE 2 is a reference image supplied by the person and may NOT be cleanly isolated — it can include a photographed backdrop, paper texture, skin, fabric, drop shadow, or colored background behind the design rather than a plain white/transparent field. Before doing anything else, mentally segment out ONLY the tattoo design's own linework and color fill from IMAGE 2, and completely discard everything else in IMAGE 2 — its backdrop, paper edges, lighting, and any surface it was photographed on must NEVER appear anywhere in the final output.";

  return `You are given two images: IMAGE 1 is a real photograph of a person's ${bodyPart}. IMAGE 2 is a reference tattoo design graphic.

The existing tattoo work already on IMAGE 1 is themed as: ${theme}. ${description}
${confirmNote}
${correctionLine}

Task: seamlessly tattoo the EXACT design shown in IMAGE 2 onto IMAGE 1, placed in the region marked by the person (${boxDescription} of IMAGE 1).${offFrameNote} Do not change, reinterpret, or redesign the artwork from IMAGE 2 — reproduce its exact linework and content, only adapting perspective, scale, and shading so it wraps naturally onto the skin at that location.

Follow these rules strictly:
- Background handling (crucial): ${backgroundHandlingNote}
- Flat-paste guard (crucial): the final output must never contain a visible rectangular patch, sticker edge, drop shadow, or otherwise-unmodified copy of IMAGE 2 sitting on top of the skin. If any trace of IMAGE 2's own frame, edges, or background is visible in your output, that is an automatic failure — the design must look hand-inked into the skin at the correct scale and perspective, never overlaid as a flat image.
- Aspect ratio (crucial): preserve IMAGE 2's own natural proportions exactly — never stretch, squash, or distort it. ${
    extendsOffFrame
      ? "Because this marked region intentionally runs off the edge of the photo, do NOT shrink or re-center the design to force the whole thing to fit inside the visible frame — instead scale it as if the full region (including the off-frame part) were visible, and simply let the portion outside the photo's own edge go uncropped/off-camera, showing only the in-frame slice."
      : "Scale it up or down uniformly to fit within the marked region. If the region's shape doesn't perfectly match the design's shape, center the correctly-proportioned design within the region and leave any leftover space as plain skin, rather than warping the artwork."
  }
- Body accuracy (crucial): reproduce the exact same body shape, outline, proportions, and silhouette against the background as IMAGE 1 — the width, contour, and edge of the ${bodyPart} against its surroundings must match IMAGE 1 pixel-for-pixel in appearance, especially near the edges of the marked region. Do not slim, widen, reshape, or otherwise redraw the limb/body outline; only the ink on its surface changes, never the body's own geometry.
- Placement and Depth Hierarchy (crucial): the existing tattoo work on IMAGE 1 must always read as in front of / integrated with the new design — never obscured or bled over by it. Where space is tight, tuck the new design spatially behind existing figures rather than on top of them — for example, let a flower or cloud/water background element run behind an existing figure's limb, tail, or armor edge, the way a real tattoo artist works new background pieces in behind an established centerpiece. Any lighter shading in the new design must sit spatially behind or below the darker existing ink.
- Cover-up (CRITICAL REQUIREMENT): ${
    coverUp
      ? "Cover-Up Mode is ENABLED. The new design must be applied at full visible strength throughout the entire marked region, including directly on top of any existing tattoo ink found there — do not preserve, fade around, tuck behind, or route around the old ink the way you would with Cover-Up disabled. Wherever the new design overlaps existing ink, the new design's linework and shading must dominate and read as the top layer, substantially obscuring the old tattoo's own shapes underneath (a faint ghost of the old ink's darkest lines showing through subtly is acceptable and realistic, but the old design's distinct imagery must no longer be clearly readable through the new one). Leaving the existing tattoo essentially unchanged, still fully recognizable, or only lightly touched at the edges within the marked region is NOT an acceptable result even if it feels like the safest way to avoid disturbing the old ink — visibly transforming the marked region, old ink and all, is mandatory."
      : `Cover-Up Mode is DISABLED. Every pixel of existing tattoo ink visible on IMAGE 1 — anywhere in the frame, including inside the marked region — must remain completely untouched: same linework, same shading, same color, same position. Treat all existing ink as a protected, immutable layer. The new design must be drawn ONLY on bare/open skin within the marked region, routing around any existing ink rather than covering, dimming, blending over, or redrawing any part of it. ${
          extendsOffFrame
            ? "Note: because this marked region deliberately runs off the edge of this photo, only the in-frame slice of the design needs to be placed on open skin here — do not scale up, reposition, or force the entire design to appear within the visible frame just to satisfy this rule; a partial/cropped design confined to the visible, open-skin portion of the region is the correct and expected result for this angle."
            : "If the marked region does not contain enough open skin for the full design at its original size, do NOT skip or omit the design — instead scale it down and/or reposition it within the marked region so the largest version that fits entirely on open skin is still clearly, visibly applied. A visible new tattoo somewhere in the marked region is mandatory; returning IMAGE 1 essentially unchanged, or with only a barely-visible/cropped fragment of the design, is not an acceptable result even if it feels like the safest way to avoid touching existing ink."
        }`
  }
- Style consistency: blend the design's shading and saturation to match the lighting and skin tone of IMAGE 1 exactly, so the result reads as one cohesive, finished piece by the same artist.
- Ink color match (important): look closely at the actual black/gray tone of the EXISTING tattoo ink visible in IMAGE 1 — its darkness, any fading or aging, and overall saturation — and adjust the new design's black/dark tones in the final blend to match that exact ink tone, not a fresh pure black. Any additional colors in the new design (if requested) can be fully saturated, but blacks/grays must visually match the existing ink so the whole piece looks like it was done by the same artist in a consistent style, not two different tattoos of different ages.
- Flow: follow the natural muscle and skin contours of the ${bodyPart} for a seamless, anatomically correct wrap.
- Detail preservation (crucial): render the tattooed region at full sharpness — do not soften, blur, simplify, or smooth away the design's fine linework and shading detail while blending it onto the skin. The marked region should look like a high-resolution close-up photograph of real, crisp tattoo linework, not a hazy or simplified approximation of it.
- Output (crucial): a single photorealistic photograph of the same body part, same lighting, same skin tone, and same framing as IMAGE 1, with the design from IMAGE 2 seamlessly and permanently added as if freshly tattooed. The marked region must look visibly different from IMAGE 1 — pixel-identical or near-identical output to IMAGE 1 is always a failed result, never an acceptable one. Do not alter the person's identity or any unrelated background elements. This is a professional, realistic tattoo-session proposal image.${offFrameOverride}`;
}

const ANALYSIS_INSTRUCTION_SINGLE = `Look carefully at the attached photo of a tattooed body part.
Respond with ONLY a raw JSON object — no markdown fences, no commentary — in exactly this shape:
{"bodyPart": "...", "theme": "...", "description": "..."}

- "bodyPart": the specific body part shown, as a short phrase (e.g. "left forearm", "right shoulder blade").
- "theme": a short label for the subject matter and artistic style of the EXISTING tattoo work already on the skin (e.g. "Japanese Irezumi with dragon and koi", "fine-line botanical blackwork"). If there is no existing tattoo work visible (bare skin), say "none — bare skin".
- "description": 1-2 sentences describing the composition, color/style (black & grey vs. color, line weight) of the existing work, and roughly where the open/empty skin areas are located so new elements could be planned around them.`;

// Used whenever more than one base photo is uploaded — these are supposed to be
// different camera angles of the SAME body part (e.g. an arm from the front and
// the side), since the app applies one single design across all of them. If the
// photos are actually of different body parts entirely (an arm, a leg, a chest),
// that design would get pasted onto all of them as if they matched, which never
// looks right — so this asks the model to explicitly flag that mismatch upfront.
const ANALYSIS_INSTRUCTION_MULTI = `Look carefully at the attached photos. They are meant to be different camera angles of the SAME body part on the SAME person (e.g. a forearm photographed from the front, side, and top) — one tattoo design will be applied identically across all of them.
Respond with ONLY a raw JSON object — no markdown fences, no commentary — in exactly this shape:
{"bodyPart": "...", "theme": "...", "description": "...", "anglesConsistent": true, "anglesNote": "..."}

- "bodyPart": the specific body part shown, as a short phrase (e.g. "left forearm", "right shoulder blade"), based on whichever photo appears to be the primary/clearest one.
- "theme": a short label for the subject matter and artistic style of the EXISTING tattoo work already on the skin across these photos (e.g. "Japanese Irezumi with dragon and koi", "fine-line botanical blackwork"). If there is no existing tattoo work visible (bare skin), say "none — bare skin".
- "description": 1-2 sentences describing the composition, color/style (black & grey vs. color, line weight) of the existing work, and roughly where the open/empty skin areas are located so new elements could be planned around them.
- "anglesConsistent": true if all the photos plausibly show the SAME body part on the SAME person from different angles; false if any of them clearly appear to be a genuinely different body part (e.g. one is an arm and another is a leg or chest/torso), a different person, or otherwise not a matching angle of the same area.
- "anglesNote": if anglesConsistent is false, a short, specific, user-facing sentence naming which photo(s) look mismatched and why (e.g. "Photo 2 looks like a lower leg, not the forearm shown in your other photos."). If anglesConsistent is true, use an empty string.`;

async function addToPortfolio(imageUrl: string, name: string) {
  try {
    if (!firestoreDb) return;
    const id = "pf-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
    const item = {
      id,
      imageUrl,
      name: name?.slice(0, 60) || "Untitled design",
      likes: 0,
      createdAt: new Date().toISOString()
    };
    await firestoreDb.collection("portfolio").doc(id).set(item);
  } catch (error) {
    console.error("Error adding to portfolio:", error);
  }
}

// API: Check server health
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// API: creates the Firestore user doc on first sign-in (idempotent — safe to call every login)
app.post("/api/ensure-user", requireAuth, async (req, res) => {
  try {
    const user = await ensureUserDoc(req.uid!, req.userEmail || null, null);
    res.json({ success: true, user });
  } catch (error: any) {
    console.error("ensure-user error:", error);
    res.status(500).json({ error: error.message || "Failed to set up your account." });
  }
});

// API: current user's profile — tier, role, usage this billing period (for header/usage display)
app.get("/api/me", requireAuth, async (req, res) => {
  try {
    const user = await getUserDoc(req.uid!);
    if (!user) return res.status(404).json({ error: "Account not found." });
    const allowance = await checkGenerationAllowance(req.uid!);
    res.json({
      success: true,
      profile: {
        tier: user.tier,
        role: user.role,
        generationsThisPeriod: allowance.used,
        generationLimit: allowance.limit
      }
    });
  } catch (error: any) {
    console.error("me endpoint error:", error);
    res.status(500).json({ error: error.message || "Failed to load your account." });
  }
});

// --- Admin account management (requireAuth + requireAdmin on every route below) ---

// API: list all accounts, for the admin panel
app.get("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = await listAllUsers();
    res.json({ success: true, users });
  } catch (error: any) {
    console.error("admin list users error:", error);
    res.status(500).json({ error: error.message || "Failed to load accounts." });
  }
});

// API: change a user's role or tier
app.patch("/api/admin/users/:uid", requireAuth, requireAdmin, async (req, res) => {
  const { uid } = req.params;
  const { role, tier, subscriptionStatus } = req.body as { role?: string; tier?: string; subscriptionStatus?: string };
  try {
    const patch: Record<string, string> = {};
    if (role) patch.role = role;
    if (tier) patch.tier = tier;
    if (subscriptionStatus) patch.subscriptionStatus = subscriptionStatus;
    const updated = await adminUpdateUser(uid, patch as any);
    res.json({ success: true, user: updated });
  } catch (error: any) {
    console.error("admin update user error:", error);
    res.status(500).json({ error: error.message || "Failed to update this account." });
  }
});

// API: grant (or revoke, with a negative amount) bonus generations
app.post("/api/admin/users/:uid/grant-generations", requireAuth, requireAdmin, async (req, res) => {
  const { uid } = req.params;
  const { amount } = req.body as { amount?: number };
  if (typeof amount !== "number" || Number.isNaN(amount)) {
    return res.status(400).json({ error: "amount must be a number." });
  }
  try {
    const updated = await adminGrantGenerations(uid, amount);
    res.json({ success: true, user: updated });
  } catch (error: any) {
    console.error("admin grant generations error:", error);
    res.status(500).json({ error: error.message || "Failed to grant generations." });
  }
});

// API: reset a user's usage counter for the current period (goodwill gesture, e.g. alongside a refund)
app.post("/api/admin/users/:uid/reset-usage", requireAuth, requireAdmin, async (req, res) => {
  const { uid } = req.params;
  try {
    const updated = await adminResetUsage(uid);
    res.json({ success: true, user: updated });
  } catch (error: any) {
    console.error("admin reset usage error:", error);
    res.status(500).json({ error: error.message || "Failed to reset usage." });
  }
});

// API: refund a user's most recent payment (admin action)
app.post("/api/admin/users/:uid/refund", requireAuth, requireAdmin, async (req, res) => {
  const { uid } = req.params;
  try {
    const result = await refundLatestPayment(uid);
    res.json({ success: true, ...result });
  } catch (error: any) {
    console.error("admin refund error:", error);
    res.status(500).json({ error: error.message || "Failed to issue refund." });
  }
});

// --- Billing (Stripe) ---

// API: start a checkout flow for a plan (one-time Design Pass, or Artist/Studio subscription)
app.post("/api/create-checkout-session", requireAuth, async (req, res) => {
  const { plan } = req.body as { plan?: "design_pass" | "artist_starter" | "studio" };
  if (!plan) return res.status(400).json({ error: "A plan is required." });
  if (!stripeConfigured) {
    return res.status(500).json({ error: "Payments are not configured yet. Set STRIPE_SECRET_KEY and the STRIPE_PRICE_* env vars." });
  }
  try {
    const origin = req.headers.origin || `${req.protocol}://${req.get("host")}`;
    const url = await createCheckoutSession({
      uid: req.uid!,
      email: req.userEmail || null,
      plan,
      successUrl: `${origin}/?checkout=success`,
      cancelUrl: `${origin}/?checkout=cancelled`
    });
    res.json({ success: true, url });
  } catch (error: any) {
    console.error("create-checkout-session error:", error);
    res.status(500).json({ error: error.message || "Failed to start checkout." });
  }
});

// API: open the Stripe-hosted billing portal so a user can manage/cancel their own subscription
app.post("/api/create-billing-portal-session", requireAuth, async (req, res) => {
  if (!stripeConfigured) {
    return res.status(500).json({ error: "Payments are not configured yet." });
  }
  try {
    const origin = req.headers.origin || `${req.protocol}://${req.get("host")}`;
    const url = await createBillingPortalSession(req.uid!, `${origin}/`);
    res.json({ success: true, url });
  } catch (error: any) {
    console.error("create-billing-portal-session error:", error);
    res.status(500).json({ error: error.message || "Failed to open billing portal." });
  }
});

// API: Phase 1 — analyze uploaded photo(s) of existing tattoo work
app.post("/api/analyze-tattoo", async (req, res) => {
  const { images } = req.body as { images?: string[] };

  if (!images || !Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: "At least one base photo is required to analyze." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY" || apiKey.trim() === "") {
    return res.status(400).json({
      error: "Gemini API key is not configured. Please add your GEMINI_API_KEY in Settings > Secrets."
    });
  }

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { "User-Agent": "aistudio-build" } }
    });

    const imageParts = images.slice(0, 4).map((dataUrl) => {
      const { mimeType, data } = parseDataUrl(dataUrl);
      return { inlineData: { mimeType, data } };
    });

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: {
        parts: [{ text: imageParts.length > 1 ? ANALYSIS_INSTRUCTION_MULTI : ANALYSIS_INSTRUCTION_SINGLE }, ...imageParts]
      }
    });

    const text = response?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || "";
    if (!text.trim()) {
      throw new Error("No analysis was returned. Please try again.");
    }

    const parsed = extractJson(text);
    if (!parsed.bodyPart || !parsed.theme) {
      throw new Error("Analysis response was incomplete. Please try again.");
    }

    res.json({
      success: true,
      bodyPart: parsed.bodyPart,
      theme: parsed.theme,
      description: parsed.description || "",
      // Only present (and only meaningful) when multiple photos were analyzed together.
      anglesConsistent: imageParts.length > 1 ? parsed.anglesConsistent !== false : undefined,
      anglesNote: imageParts.length > 1 ? parsed.anglesNote || "" : undefined
    });
  } catch (error: any) {
    console.error("Tattoo Analysis Error:", error);
    res.status(500).json({
      error: friendlyGeminiError(error, "Failed to analyze the uploaded photo."),
      details: error.toString()
    });
  }
});

// API: Stage A — generate ONE isolated tattoo design (the single source of truth
// that gets composited onto every angle, so the artwork itself never varies).
app.post("/api/generate-tattoo-design", requireAuth, async (req, res) => {
  const {
    bodyPart,
    theme,
    description = "",
    correction = "",
    prompt,
    style = "fineline blackwork",
    colorPreference = "monochrome",
    referenceImage
  } = req.body as {
    bodyPart?: string;
    theme?: string;
    description?: string;
    correction?: string;
    prompt?: string;
    style?: string;
    colorPreference?: string;
    referenceImage?: string;
  };

  if (!bodyPart || !theme) {
    return res.status(400).json({ error: "Missing confirmed body part / theme. Run analysis first." });
  }
  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: "Describe the new tattoo you want added." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY" || apiKey.trim() === "") {
    return res.status(400).json({
      error: "Gemini API key is not configured. Please add your GEMINI_API_KEY in Settings > Secrets."
    });
  }

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { "User-Agent": "aistudio-build" } }
    });

    const fullPrompt = buildIsolatedDesignPrompt({
      bodyPart,
      theme,
      description,
      correction,
      newTattooPrompt: prompt,
      style,
      colorPreference,
      hasReferenceImage: !!referenceImage
    });

    console.log("Generating isolated tattoo design with prompt:", fullPrompt);

    const parts: any[] = [];
    if (referenceImage) {
      const ref = parseDataUrl(referenceImage);
      parts.push({ inlineData: { mimeType: ref.mimeType, data: ref.data } });
    }
    parts.push({ text: fullPrompt });

    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-lite-image",
      contents: { parts },
      config: { imageConfig: { aspectRatio: "1:1" } }
    });

    let base64Image: string | null = null;
    if (response?.candidates?.[0]?.content?.parts) {
      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData?.data) {
          base64Image = part.inlineData.data;
          break;
        }
      }
    }
    if (!base64Image) {
      throw new Error("No image was returned from the Gemini API model response. Please check your prompt and try again.");
    }

    const imageUrl = `data:image/png;base64,${base64Image}`;
    res.json({ success: true, imageUrl });
  } catch (error: any) {
    console.error("Isolated Design Generation Error:", error);
    res.status(500).json({
      error: friendlyGeminiError(error, "Failed to generate the tattoo design."),
      details: error.toString()
    });
  }
});

// API: Stage B — blend the (already-generated) design photorealistically onto a
// specific base photo at a user-drawn placement box.
app.post("/api/composite-photorealistic", async (req, res) => {
  const {
    baseImage,
    designImage,
    placementBox,
    bodyPart,
    theme,
    description = "",
    confirmChoice = "A",
    correction = "",
    coverUp = false,
    aspectRatio = "1:1",
    designIsPreIsolated = true
  } = req.body as {
    baseImage?: string;
    designImage?: string;
    placementBox?: { x: number; y: number; width: number; height: number };
    bodyPart?: string;
    theme?: string;
    description?: string;
    confirmChoice?: string;
    correction?: string;
    coverUp?: boolean;
    aspectRatio?: string;
    designIsPreIsolated?: boolean;
  };

  if (!baseImage || !designImage) {
    return res.status(400).json({ error: "A base photo and a generated design are both required." });
  }
  if (!placementBox) {
    return res.status(400).json({ error: "A placement box is required. Draw where the tattoo should go first." });
  }
  if (!bodyPart || !theme) {
    return res.status(400).json({ error: "Missing confirmed body part / theme. Run analysis first." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY" || apiKey.trim() === "") {
    return res.status(400).json({
      error: "Gemini API key is not configured. Please add your GEMINI_API_KEY in Settings > Secrets."
    });
  }

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { "User-Agent": "aistudio-build" } }
    });

    const base = parseDataUrl(baseImage);
    const design = parseDataUrl(designImage);

    const fullPrompt = buildBlendPrompt({
      bodyPart,
      theme,
      description,
      confirmChoice,
      correction,
      placementBox,
      coverUp: !!coverUp,
      designIsPreIsolated: designIsPreIsolated !== false
    });

    console.log("Generating photorealistic blend with prompt:", fullPrompt);

    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-lite-image",
      contents: {
        parts: [
          { inlineData: { mimeType: base.mimeType, data: base.data } },
          { inlineData: { mimeType: design.mimeType, data: design.data } },
          { text: fullPrompt }
        ]
      },
      config: {
        imageConfig: {
          aspectRatio: ["1:1", "3:4", "4:3", "9:16", "16:9"].includes(aspectRatio) ? aspectRatio : "1:1"
        }
      }
    });

    let base64Image: string | null = null;
    if (response?.candidates?.[0]?.content?.parts) {
      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData?.data) {
          base64Image = part.inlineData.data;
          break;
        }
      }
    }
    if (!base64Image) {
      throw new Error("No image was returned from the Gemini API model response. Please try again.");
    }

    res.json({ success: true, imageUrl: `data:image/png;base64,${base64Image}` });
  } catch (error: any) {
    console.error("Photorealistic Composite Error:", error);
    res.status(500).json({
      error: friendlyGeminiError(error, "Failed to generate the photorealistic composite."),
      details: error.toString()
    });
  }
});

// API: Suggest tattoo ideas tailored to the confirmed analysis ("Inspire me")
app.post("/api/suggest-tattoo-ideas", async (req, res) => {
  const { bodyPart, theme, description = "", correction = "" } = req.body as {
    bodyPart?: string;
    theme?: string;
    description?: string;
    correction?: string;
  };

  if (!bodyPart || !theme) {
    return res.status(400).json({ error: "Missing confirmed body part / theme. Run analysis first." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY" || apiKey.trim() === "") {
    return res.status(400).json({
      error: "Gemini API key is not configured. Please add your GEMINI_API_KEY in Settings > Secrets."
    });
  }

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { "User-Agent": "aistudio-build" } }
    });

    const instruction = `A person has an existing tattoo on their ${bodyPart}, themed as: ${theme}. ${description}
${correction ? `Additional context from the person: "${correction}".` : ""}

Suggest 4 short, specific NEW tattoo ideas (each a single sentence, no preamble, no numbering) that would complement this existing work stylistically and thematically, and could realistically fit into the empty skin around it.

Also propose ONE simple multiple-choice question that would help narrow down what this person actually wants next — e.g. about scale/boldness, whether it should be a standalone focal piece vs. supporting filler, color vs. black-and-grey, or similar — with 3 to 4 short answer options.

Respond with ONLY a raw JSON object, no markdown fences, in exactly this shape:
{"ideas": ["...", "...", "...", "..."], "clarifyingQuestion": {"question": "...", "options": ["...", "...", "..."]}}`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: { parts: [{ text: instruction }] }
    });

    const text = response?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || "";
    if (!text.trim()) {
      throw new Error("No suggestions were returned. Please try again.");
    }

    const parsed = extractJson(text);
    res.json({
      success: true,
      ideas: Array.isArray(parsed.ideas) ? parsed.ideas.slice(0, 4) : [],
      clarifyingQuestion: parsed.clarifyingQuestion || null
    });
  } catch (error: any) {
    console.error("Tattoo Idea Suggestion Error:", error);
    res.status(500).json({
      error: friendlyGeminiError(error, "Failed to suggest tattoo ideas."),
      details: error.toString()
    });
  }
});

// API: list the shared community portfolio (most-liked first, then most recent)
// API: generate a 4-pose generic-figure reference sheet (front/back/left/right)
// showing existing + new tattoo work together — for artist reference, not a
// literal photo of the user.
function getPoseSet(bodyPart: string): { poses: string[]; layout: "single" | "grid1x2" | "grid2x2" } {
  const bp = bodyPart.toLowerCase();
  const sideMatch = /\b(left|right)\b/.exec(bp);
  const side = sideMatch ? sideMatch[1] : null;

  if (/(chest|pec|sternum)/.test(bp)) {
    return { poses: ["Front-on view of the chest, facing the camera directly"], layout: "single" };
  }
  if (/(back|shoulder blade|scapula|spine)/.test(bp)) {
    return { poses: ["Front-on view of the back, viewed directly from behind"], layout: "single" };
  }
  if (/(arm|forearm|bicep|tricep|sleeve|elbow|wrist)/.test(bp)) {
    if (side) {
      // A specific side was confirmed — only show that one arm, not both, and
      // only the described surface of it (not the opposite/inner side).
      return {
        poses: [
          `${side} arm raised/bent upward — camera angle showing specifically the surface described (${bodyPart}), not the opposite side of the same arm`,
          `${side} arm lowered/relaxed at the side — same described surface again, consistent with the pose above`
        ],
        layout: "grid1x2"
      };
    }
    // No side confirmed — show both arms generically as a fallback.
    return {
      poses: [
        "Arm raised/bent upward, left side profile",
        "Arm lowered/relaxed at the side, left side profile",
        "Arm raised/bent upward, right side profile",
        "Arm lowered/relaxed at the side, right side profile"
      ],
      layout: "grid2x2"
    };
  }
  if (/(leg|thigh|calf|shin|ankle|knee)/.test(bp)) {
    if (side) {
      return {
        poses: [`Front-on view of the ${side} leg`, `Side profile of the ${side} leg, showing the surface described (${bodyPart})`],
        layout: "grid1x2"
      };
    }
    return {
      poses: ["Front-on view of the legs", "Left side profile of the legs", "Right side profile of the legs", "Back view of the legs"],
      layout: "grid2x2"
    };
  }
  // Unrecognized body part — fall back to the generic 4-pose set.
  return {
    poses: ["Facing forward (front-on)", "Facing away (back view)", "Left side profile", "Right side profile"],
    layout: "grid2x2"
  };
}

app.post("/api/generate-reference-sheet", async (req, res) => {
  const {
    bodyPart,
    theme,
    description = "",
    correction = "",
    designImage,
    referenceImage
  } = req.body as {
    bodyPart?: string;
    theme?: string;
    description?: string;
    correction?: string;
    designImage?: string;
    referenceImage?: string;
  };

  if (!designImage || !referenceImage) {
    return res.status(400).json({ error: "Both the new design and a reference photo are required." });
  }
  if (!bodyPart || !theme) {
    return res.status(400).json({ error: "Missing confirmed body part / theme. Run analysis first." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY" || apiKey.trim() === "") {
    return res.status(400).json({
      error: "Gemini API key is not configured. Please add your GEMINI_API_KEY in Settings > Secrets."
    });
  }

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { "User-Agent": "aistudio-build" } }
    });

    const design = parseDataUrl(designImage);
    const reference = parseDataUrl(referenceImage);
    const correctionLine = correction && correction.trim() ? `Additional context: "${correction.trim()}".` : "";
    const { poses, layout } = getPoseSet(bodyPart);
    const isMultiPanel = layout !== "single";

    const layoutInstruction =
      layout === "single"
        ? `Create a single professional tattoo reference image showing ONE pose only: ${poses[0]}. This body part only needs one viewing angle, so do not add extra panels or poses that don't make sense for it.`
        : layout === "grid1x2"
        ? `Create a single professional tattoo reference image, divided into exactly 2 clearly separated panels arranged side by side. Each panel shows the SAME generic reference figure's ${bodyPart}, in a pose specific to this body part:\n${poses
            .map((p, i) => `- Panel ${i + 1}: ${p}`)
            .join("\n")}`
        : `Create a single professional tattoo reference sheet image, divided into ${poses.length} clearly separated panels arranged in a 2x2 grid. Each panel shows the SAME generic reference figure's ${bodyPart}, in a pose specific to this body part:\n${poses
            .map((p, i) => `- Panel ${i + 1}: ${p}`)
            .join("\n")}`;

    const captionNote = isMultiPanel ? `Add a small, subtle caption under each panel naming its pose.` : "";

    const containmentNote = `CRITICAL — containment (this is the single most important rule): the confirmed location for this ink is specifically "${bodyPart}", and nowhere else. Both the existing tattoo work and the new design must appear ONLY on that exact body part and that exact side/surface as described — do NOT let any ink appear on the opposite arm, the opposite leg, the opposite side of the same limb, the back, the chest, or any other body part not explicitly named in "${bodyPart}". Every other visible part of the body in every panel must show plain, undecorated skin matching the person's natural tone — no ink, no faded suggestion of ink, nothing. If a pose's camera angle would naturally reveal a surface other than the one described, keep that surface bare rather than inventing tattoo content for it.`;

    const consistencyNote = isMultiPanel
      ? `CRITICAL — cross-panel consistency: every panel shows the exact same fixed, permanent tattoo on the exact same body — only the camera angle changes between panels, never the ink itself. Before finalizing, check each panel against the others: if "${bodyPart}" (or the specific surface of it named, e.g. its back/side) would still be visible from a given pose's viewpoint given normal anatomy, that panel MUST show the same tattoo work in the same amount of visible detail as the other panels — do not let the ink fade out, shrink, soften, or disappear in a panel just because the camera angle changed (for example, a calf tattoo that wraps toward the back of the leg must still be at least partially visible in a rear/back view, not omitted entirely). Likewise, never let the tattoo appear on the wrong side, wrong limb, or wrong leg/arm in any single panel even if it was correct in the others — if you find yourself about to render a panel with no ink where the other panels show ink on a surface that this pose would also reveal, that panel is wrong and must be corrected before finishing. When genuinely uncertain whether a surface is visible in a given pose, err on the side of showing the tattoo rather than omitting it, since the entire purpose of this sheet is confirming how one single design reads consistently from multiple angles.`
      : "";

    const instruction = `${layoutInstruction}

IMAGE 2 is a reference photo — loosely match this person's skin tone and body build for the generic figure. This is a reference figure for a tattoo artist, not a portrait, so exact facial likeness is not required or wanted.

${containmentNote}
${consistencyNote}

On ${layout === "single" ? "the image" : "every one of the panels, where the confirmed location is actually visible in that pose"}, show:
1. The existing tattoo work already at this location, themed as: ${theme}. ${description}
2. The new tattoo design shown in IMAGE 1, applied in the same anatomically consistent spot relative to the existing work${isMultiPanel ? ", consistently across panels" : ""}.
${correctionLine}

Style: clean, evenly lit studio photography look, consistent lighting and neutral background${isMultiPanel ? " across all panels so they read as one cohesive reference sheet" : ""}. ${captionNote} This is a professional tool for a tattoo artist to review the confirmed design and placement from the angle(s) that actually matter for it before a session — not a showcase of imaginary ink elsewhere on the body.`;

    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-lite-image",
      contents: {
        parts: [
          { inlineData: { mimeType: design.mimeType, data: design.data } },
          { inlineData: { mimeType: reference.mimeType, data: reference.data } },
          { text: instruction }
        ]
      },
      config: { imageConfig: { aspectRatio: layout === "single" ? "3:4" : layout === "grid1x2" ? "16:9" : "4:3" } }
    });

    let base64Image: string | null = null;
    if (response?.candidates?.[0]?.content?.parts) {
      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData?.data) {
          base64Image = part.inlineData.data;
          break;
        }
      }
    }
    if (!base64Image) {
      throw new Error("No image was returned from the Gemini API model response. Please try again.");
    }

    res.json({ success: true, imageUrl: `data:image/png;base64,${base64Image}` });
  } catch (error: any) {
    console.error("Reference Sheet Generation Error:", error);
    res.status(500).json({
      error: friendlyGeminiError(error, "Failed to generate the reference sheet."),
      details: error.toString()
    });
  }
});

app.get("/api/portfolio", async (req, res) => {
  try {
    if (!firestoreDb) throw new Error("Firestore is not configured.");
    const snap = await firestoreDb.collection("portfolio").limit(200).get();
    const items = snap.docs.map(doc => doc.data());
    
    const sorted = [...items].sort((a, b) => {
      if (b.likes !== a.likes) return b.likes - a.likes;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    res.json({ success: true, items: sorted });
  } catch (error: any) {
    console.error("Portfolio List Error:", error);
    res.status(500).json({ error: "Failed to load the portfolio." });
  }
});

// API: like a portfolio design
app.post("/api/portfolio/:id/like", async (req, res) => {
  try {
    const { id } = req.params;
    if (!firestoreDb) throw new Error("Firestore is not configured.");
    
    const docRef = firestoreDb.collection("portfolio").doc(id);
    const snap = await docRef.get();
    if (!snap.exists) {
      return res.status(404).json({ error: "Design not found." });
    }
    
    await docRef.update({
      likes: (snap.data()?.likes || 0) + 1
    });
    
    const updatedSnap = await docRef.get();
    res.json({ success: true, item: updatedSnap.data() });
  } catch (error: any) {
    console.error("Portfolio Like Error:", error);
    res.status(500).json({ error: "Failed to like this design." });
  }
});

// API: Save Project (Cross-Device persistence)
app.post("/api/projects", optionalAuth, async (req, res) => {
  try {
    const projectData = req.body;
    let code = projectData.code;

    if (!firestoreDb) throw new Error("Firestore is not configured.");
    const projectsColl = firestoreDb.collection("projects");

    // If no code, or code not exists, generate a new 6-char UPPERCASE alphanumeric code
    let isNewCode = false;
    if (!code) {
      isNewCode = true;
    } else {
      const snap = await projectsColl.doc(code).get();
      if (!snap.exists) {
        isNewCode = true;
      }
    }

    if (isNewCode) {
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // clear readable chars
      let attempt = 0;
      let exists = true;
      do {
        code = "";
        for (let i = 0; i < 6; i++) {
          code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        const snap = await projectsColl.doc(code).get();
        exists = snap.exists;
        attempt++;
      } while (exists && attempt < 100);
    }

    const timestamp = new Date().toISOString();
    
    const existingSnap = await projectsColl.doc(code).get();
    const existingData = existingSnap.exists ? existingSnap.data() : null;

    const savedProject = {
      ...projectData,
      code,
      createdAt: existingData?.createdAt || timestamp,
      updatedAt: timestamp,
      // Tags the project as belonging to the signed-in user, if any — this is
      // what powers "Load Project" (listing your own saves) without requiring
      // ownership for the existing code-based sharing flow to keep working.
      ownerUid: req.uid || existingData?.ownerUid || null
    };

    await projectsColl.doc(code).set(savedProject);

    res.json({
      success: true,
      code,
      message: `Project saved successfully with access code: ${code}`,
      project: savedProject,
    });
  } catch (error: any) {
    console.error("Save Project Error:", error);
    res.status(500).json({ error: "Failed to save project." });
  }
});

// API: list the signed-in user's own saved projects (for "Load Project")
app.get("/api/my-projects", requireAuth, async (req, res) => {
  try {
    if (!firestoreDb) throw new Error("Firestore is not configured.");
    // Sorting here (rather than via .orderBy in the query) avoids needing a
    // Firestore composite index for this where+orderBy combination.
    const snap = await firestoreDb.collection("projects").where("ownerUid", "==", req.uid).limit(100).get();
    const projects = snap.docs
      .map((d) => {
        const data = d.data();
        return {
          code: data.code,
          name: data.name || "Untitled Project",
          updatedAt: data.updatedAt,
          thumbnail:
            (data.angleResults && Object.values(data.angleResults)[0] && (Object.values(data.angleResults)[0] as any).src) ||
            data.design?.src ||
            data.basePhotos?.[0]?.src ||
            null
        };
      })
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 50);
    res.json({ success: true, projects });
  } catch (error: any) {
    console.error("my-projects error:", error);
    res.status(500).json({ error: error.message || "Failed to load your saved projects." });
  }
});

// API: Load Project
app.get("/api/projects/:code", async (req, res) => {
  try {
    const code = req.params.code.toUpperCase().trim();
    if (!firestoreDb) throw new Error("Firestore is not configured.");

    const snap = await firestoreDb.collection("projects").doc(code).get();

    if (!snap.exists) {
      return res.status(404).json({ error: `Project not found for access code: ${code}` });
    }

    res.json({
      success: true,
      code,
      project: snap.data(),
    });
  } catch (error: any) {
    console.error("Load Project Error:", error);
    res.status(500).json({ error: "Failed to retrieve project." });
  }
});

// Catch-all JSON error handler — without this, errors thrown before a route
// runs (e.g. a request body over the size limit) fall through to Express's
// default HTML error page, which breaks any client doing res.json() on the
// response (surfaces as a confusing "Unexpected token '<'" parse error).
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(err);
  console.error("Unhandled server error:", err?.message || err);
  if (err?.type === "entity.too.large" || err?.status === 413) {
    return res.status(413).json({
      error: "This project is too large to save. Try removing some history entries or unused angle photos, then save again."
    });
  }
  res.status(err?.status || err?.statusCode || 500).json({
    error: err?.message || "Something went wrong on the server."
  });
});

// Integrate Vite Middleware
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    // Loaded dynamically (not a top-level import) so Vercel's serverless
    // function bundler never has to trace/bundle Vite itself — this whole
    // branch only ever runs on a real persistent Node host (AI Studio, local
    // `tsx server.ts`), never on Vercel (see the VERCEL guard below), but a
    // static `import ... from "vite"` at the top of the file would still get
    // pulled into the serverless bundle and could crash the function at cold
    // start even though this code never executes there.
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    // Serve index.html for SPA routing
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`InkVision Server listening on http://0.0.0.0:${PORT}`);
  });
}

// Vercel deploys this app as a serverless function (see api/[...path].ts) —
// it invokes the exported `app` directly per-request and never wants a real
// listening port or Vite's dev/static middleware wired up here. Vercel sets
// the VERCEL env var automatically on every build and at runtime, so this
// only skips startServer() there; every other host (AI Studio, `tsx
// server.ts` locally, a plain Node deploy) behaves exactly as before.
if (process.env.VERCEL !== "1") {
  startServer();
}
