import express from "express";
import path from "path";
import fs from "fs";
import { createHash, randomInt } from "crypto";
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

// Behind Vercel / a reverse proxy req.ip would otherwise be the proxy's address,
// which would make every per-IP rate limit below a single shared bucket.
app.set("trust proxy", 1);

// Saved projects legitimately carry several photos + generated composites +
// history snapshots, so that one route keeps a generous limit. Everything else
// (the AI routes take one or two downscaled images) gets a much smaller cap so
// an unauthenticated or abusive caller can't make the server buffer tens of MB
// per request. Order matters: the first matching parser consumes the body.
//
// Two cheap guards run BEFORE any body is parsed, because parsing a multi-MB
// base64 JSON body is the single most expensive thing this server does and, on
// serverless billing, it is CPU time that is paid for whether or not the caller
// is legitimate:
//   1. a generous per-IP ceiling on all API traffic;
//   2. routes that need a signed-in user are rejected on a missing
//      Authorization header without reading the body at all (the token itself
//      is still verified later, by requireAuth).
const apiFloodLimiter = rateLimit({ windowMs: 60_000, max: 300, by: "ip", label: "API" });
const NEEDS_AUTH_HEADER = [
  /^\/api\/(analyze-tattoo|composite-photorealistic|verify-tattoo-result|suggest-tattoo-ideas|generate-reference-sheet|generate-tattoo-design)$/,
  /^\/api\/portfolio\/[^/]+\/like$/,
  /^\/api\/admin\//,
  /^\/api\/create-(checkout|billing-portal)-session$/
];
app.use("/api", apiFloodLimiter);
app.use("/api", (req, res, next) => {
  if (req.method !== "GET" && !(req.headers.authorization || "").startsWith("Bearer ") && NEEDS_AUTH_HEADER.some((re) => re.test(req.originalUrl.split("?")[0]))) {
    return res.status(401).json({ error: "Sign in required." });
  }
  next();
});
app.use("/api/projects", express.json({ limit: "80mb" }));
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ limit: "1mb", extended: true }));

/**
 * Minimal in-memory sliding-window rate limiter. State is per server instance,
 * so on serverless hosts (Vercel) the effective limit is per warm instance —
 * still enough to stop a single client hammering one endpoint, but not a
 * substitute for an edge/WAF rule if abuse becomes a real concern.
 */
function rateLimit(opts: { windowMs: number; max: number; by?: "uid" | "ip"; label: string }) {
  const hits = new Map<string, number[]>();
  let lastSweep = Date.now();
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const now = Date.now();
    if (now - lastSweep > opts.windowMs) {
      lastSweep = now;
      for (const [k, v] of hits) {
        if (!v.length || now - v[v.length - 1] > opts.windowMs) hits.delete(k);
      }
    }
    const key = (opts.by === "uid" && req.uid) || req.ip || "unknown";
    const recent = (hits.get(key) || []).filter((t) => now - t < opts.windowMs);
    if (recent.length >= opts.max) {
      const retryAfter = Math.max(1, Math.ceil((opts.windowMs - (now - recent[0])) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ error: `Too many ${opts.label} requests. Please wait ${retryAfter}s and try again.` });
    }
    recent.push(now);
    hits.set(key, recent);
    next();
  };
}

// Per-endpoint limits. Generous for normal use (a person placing and re-placing
// a design), tight enough to make scripted abuse expensive. Per-user for
// signed-in routes, per-IP for the public code-based project lookup (which is
// what stops a 6-character access code from being brute-forced).
const aiLimiter = rateLimit({ windowMs: 60_000, max: 20, by: "uid", label: "AI" });
const projectReadLimiter = rateLimit({ windowMs: 60_000, max: 30, by: "ip", label: "project lookup" });
const projectWriteLimiter = rateLimit({ windowMs: 60_000, max: 20, by: "ip", label: "project save" });
const likeLimiter = rateLimit({ windowMs: 60_000, max: 30, by: "uid", label: "like" });

// --- Helpers for the two-phase "analyze then generate" tattoo flow ---

/** A problem with what the caller sent (as opposed to a server/Gemini failure) — surfaces as HTTP 400. */
class BadRequestError extends Error {}

const ALLOWED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

function parseDataUrl(dataUrl: string): { mimeType: string; data: string } {
  const match = typeof dataUrl === "string" ? /^data:(.+?);base64,(.+)$/.exec(dataUrl) : null;
  if (!match) {
    throw new BadRequestError("Expected a base64 data URL for an uploaded image.");
  }
  if (!ALLOWED_IMAGE_MIME.has(match[1].toLowerCase())) {
    throw new BadRequestError("Unsupported image type. Please use a PNG, JPEG or WebP image.");
  }
  return { mimeType: match[1].toLowerCase(), data: match[2] };
}

/** HTTP status for a caught error: 400 for caller mistakes, 500 for everything else. */
function statusFor(error: any): number {
  return error instanceof BadRequestError ? 400 : 500;
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
function friendlyGeminiError(error: any, fallback: string, modelKind: "image" | "text" = "image"): string {
  const raw = (error?.message || error?.toString?.() || "").toString().trim();
  if (!raw) return fallback;
  if (!raw.startsWith("{")) return raw;

  // "image"/"text" only changes the noun in these two messages — analyze-tattoo
  // and suggest-tattoo-ideas call this with "text" so a text-model outage
  // doesn't get misreported as "the image model", which was confusing when it
  // was the analysis step (not image generation) that actually failed.
  const modelNoun = modelKind === "text" ? "analysis model" : "image model";

  try {
    const parsed = JSON.parse(raw);
    const status = parsed?.error?.status || parsed?.status;
    const inner = parsed?.error?.message || parsed?.message || "";
    if (status === "UNAVAILABLE" || /high demand|overloaded/i.test(inner)) {
      return `The ${modelNoun} is currently experiencing high demand. Please wait a moment and try again.`;
    }
    if (status === "RESOURCE_EXHAUSTED" || /quota/i.test(inner)) {
      return "The generation quota has been reached. Please try again shortly.";
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

/**
 * Retries a Gemini `generateContent` call a couple of times, but ONLY for
 * transient server-side overload (HTTP 503 / status "UNAVAILABLE", or a
 * message mentioning "high demand"/"overloaded") — the same class of error
 * we've seen intermittently across both the image and text models during
 * this session, unrelated to our own code. Anything else (bad request,
 * quota exhausted, auth failure, etc.) fails immediately since retrying
 * those would just waste time on an error that will never clear itself.
 */
async function generateContentWithRetry(ai: GoogleGenAI, params: any, maxAttempts = 3): Promise<any> {
  let lastError: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (err: any) {
      lastError = err;
      const raw = (err?.message || err?.toString?.() || "").toString();
      const isTransient = /"status"\s*:\s*"UNAVAILABLE"/i.test(raw) || /high demand|overloaded/i.test(raw);
      if (!isTransient || attempt === maxAttempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000)); // 1s, then 2s
    }
  }
  throw lastError;
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
  coverUp?: boolean;
}): string {
  const { bodyPart, theme, description, correction, newTattooPrompt, style, colorPreference, hasReferenceImage, coverUp = false } = opts;
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

  // Cover-Up mode puts the new piece directly over old ink, which is a
  // different design problem from filling open skin beside it: a real cover-up
  // is dense, dark and larger than what it hides, with no light areas or empty
  // negative space for the old linework to show through. Without this the
  // design is generated as if it were "next to" the old tattoo, and the blend
  // step is left to hide old ink under a design that has no coverage to give.
  const placementIntent = coverUp
    ? `This design is intended to COVER UP an existing tattoo on a person's ${bodyPart}, so the old ink underneath must not show through. The existing tattoo being covered is themed as: ${theme}. ${description}${correctionLine}
Cover-up design requirements (these override any conflicting style or color rule below):
- Dense, high-coverage composition: fill the whole canvas with dark, saturated tones and solid black or deep-color areas. Avoid large empty gaps, thin sparse linework, and delicate light shading — old ink shows through all of those.
- Keep the overall silhouette large and compact, so it can extend beyond the outline of the old tattoo rather than leaving a rim of old ink exposed.
- Use strong tonal contrast and heavy blacks/dark mid-tones. Do NOT use white, pastel, or very light colors as fill areas.`
    : `This design is intended to be added next to an existing tattoo on a person's ${bodyPart}. The existing tattoo work is themed as: ${theme}. ${description}${correctionLine}`;

  return `Create a single, isolated tattoo design graphic: ${newTattooPrompt}.

${placementIntent}

Style requirements:
- Render in a ${style} tattoo style.
- ${colorInstruction}
- Match the line weight and shading technique that would be consistent with the existing theme described above, so it reads as the same artist's work once applied.
- Thematic cohesion: even though this is a new, separate design, choose motifs, framing elements, and linework that would sit comfortably alongside the existing theme (${theme}) as part of one unified larger piece — e.g. complementary background elements (clouds, water, botanical filler) or subject matter from the same broad tradition — rather than a visually unrelated design that merely happens to be nearby.${colorMatchLine}
- Output the design ISOLATED on a clean, solid, pure white background — no skin, no body parts, no framing, no shadows cast on a surface. This is a flat graphic, not a photo.
- Highly detailed, clean vector-quality line work suitable for both a photorealistic skin composite and a printable stencil outline.`;
}

// Both the Cover-Up-off and Cover-Up-on rules inside this prompt are grounded
// two ways now: the text rules below as a baseline, PLUS — when client-side
// segmentation succeeds (see getSkinSegmentationMask and
// burnSkinMaskFromSegmentation in imageCompose.ts, which use MediaPipe's
// on-device Multiclass Selfie Segmentation model, not a Gemini call) — an
// actual burned-in tint marking a real, pixel-precise region: GREEN for
// confirmed open skin when Cover-Up is off, RED for confirmed non-body
// background when Cover-Up is on. Same "pixels beat prose" principle that
// already grounds the placement region itself via the corner brackets. The
// same segmentation mask is also used client-side, in extractMaskedPatch, as
// an actual hard clip on the final composite — so this tint isn't just a
// hint here, it's a preview of what will be enforced regardless of what the
// model paints. Segmentation is best-effort: if it fails for any reason,
// generation still proceeds on the text-only fallback below rather than
// blocking on a non-critical enhancement.
function buildBlendPrompt(opts: {
  bodyPart: string;
  theme: string;
  description: string;
  confirmChoice: string;
  correction?: string;
  placementBox: { x: number; y: number; width: number; height: number };
  coverUp: boolean;
  skinMaskApplied?: boolean;
  designIsPreIsolated?: boolean;
}): string {
  const { bodyPart, theme, description, confirmChoice, correction, placementBox, coverUp, skinMaskApplied: regionMaskApplied = false, designIsPreIsolated = true } = opts;
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

Placement marker (crucial — read this before anything else): IMAGE 1 has four small bright magenta corner brackets burned directly onto it, marking the exact corners of the target placement region. These four brackets ARE the authoritative, ground-truth boundary of where the new design goes — treat them as far more reliable than the approximate percentage description below, which is only a fallback in case the brackets are hard to make out. Use the visible brackets to locate the region, then completely erase/paint over all four corner brackets in your output — none of their magenta coloring may remain anywhere in the final image, on skin or otherwise. They exist purely as a placement guide for you and must never appear in the result.

Task: seamlessly tattoo the EXACT design shown in IMAGE 2 onto IMAGE 1, placed in the region marked by the corner brackets (approximately ${boxDescription} of IMAGE 1, if the brackets are ambiguous).${offFrameNote} Do not change, reinterpret, or redesign the artwork from IMAGE 2 — reproduce its exact linework and content, only adapting perspective, scale, and shading so it wraps naturally onto the skin at that location.

Follow these rules strictly:
- Background handling (crucial): ${backgroundHandlingNote}
- Flat-paste guard (crucial): the final output must never contain a visible rectangular patch, sticker edge, drop shadow, or otherwise-unmodified copy of IMAGE 2 sitting on top of the skin. If any trace of IMAGE 2's own frame, edges, or background is visible in your output, that is an automatic failure — the design must look hand-inked into the skin at the correct scale and perspective, never overlaid as a flat image.
- Aspect ratio (crucial): preserve IMAGE 2's own natural proportions exactly — never stretch, squash, or distort it. ${
    extendsOffFrame
      ? "Because this marked region intentionally runs off the edge of the photo, do NOT shrink or re-center the design to force the whole thing to fit inside the visible frame — instead scale it as if the full region (including the off-frame part) were visible, and simply let the portion outside the photo's own edge go uncropped/off-camera, showing only the in-frame slice."
      : "The marked region's own shape has already been matched to this design's proportions — scale it up or down uniformly so it broadly fills the marked region, using the brackets as the intended size and position. IMPORTANT — this sizing guidance never overrides the body's real outline: if part of the marked region falls outside the body (on background, floor, wall, or empty space beyond the limb's edge), simply leave that part of the region empty and fit the design to the skin that genuinely exists inside it. NEVER widen, thicken, extend, or reshape the limb or body to fill more of the marked region — the body's silhouette in your output must match the original photo exactly, even when that means the design does not reach the bracket edges."
  }
- Body accuracy (crucial): reproduce the exact same body shape, outline, proportions, and silhouette against the background as IMAGE 1 — the width, contour, and edge of the ${bodyPart} against its surroundings must match IMAGE 1 pixel-for-pixel in appearance, especially near the edges of the marked region. Do not slim, widen, reshape, or otherwise redraw the limb/body outline; only the ink on its surface changes, never the body's own geometry.
- Skin-only guard (CRITICAL REQUIREMENT): the new design may ONLY be applied to real, bare human skin. The marked region is a rough guide drawn by a person and may not perfectly align with what's actually skin in the photo — if any part of it falls on clothing, fabric, a strap, a watch or other jewelry, hair, fingernails, or background/surface behind the body (a wall, door, floor, furniture, etc.), do NOT render any tattoo ink onto those non-skin surfaces under any circumstance. Confine the design to whatever actual bare skin is present at/near the marked region instead, shrinking, nudging, or cropping it as needed to keep it entirely on skin — never stretch it across or paint over an object, fabric, or surface that isn't the person's own skin. This includes the eyes: never draw ink on an eyeball, eyelid, or eyelid margin — treat that area as strictly off-limits, full stop, regardless of anything else in this prompt.
- Placement and Depth Hierarchy (crucial): the existing tattoo work on IMAGE 1 must always read as in front of / integrated with the new design — never obscured or bled over by it. Where space is tight, tuck the new design spatially behind existing figures rather than on top of them — for example, let a flower or cloud/water background element run behind an existing figure's limb, tail, or armor edge, the way a real tattoo artist works new background pieces in behind an established centerpiece. Any lighter shading in the new design must sit spatially behind or below the darker existing ink.
- Cover-up (CRITICAL REQUIREMENT): ${
    coverUp
      ? `Cover-Up Mode is ENABLED. The new design must be applied at full visible strength throughout the entire marked region, including directly on top of any existing tattoo ink found there — do not preserve, fade around, tuck behind, or route around the old ink the way you would with Cover-Up disabled. Wherever the new design overlaps existing ink, the new design's linework and shading must dominate and read as the top layer, substantially obscuring the old tattoo's own shapes underneath (a faint ghost of the old ink's darkest lines showing through subtly is acceptable and realistic, but the old design's distinct imagery must no longer be clearly readable through the new one). Leaving the existing tattoo essentially unchanged, still fully recognizable, or only lightly touched at the edges within the marked region is NOT an acceptable result even if it feels like the safest way to avoid disturbing the old ink — visibly transforming the marked region, old ink and all, is mandatory.${
          regionMaskApplied
            ? " IMAGE 1 also has a subtle translucent RED tint burned directly onto it, covering exactly the sub-areas of the marked region that were separately measured to NOT be part of the person's own body at all (background, wall, floor, furniture, clothing, etc) — this tint is a precise, ground-truth guide to where the body actually ends, far more reliable than judging it yourself from the photo. Even though Cover-Up mode allows painting over existing ink everywhere else in the marked region, the red-tinted areas are absolutely off-limits regardless — never place any tattoo ink there under any circumstance, since it is not the person's skin at all. Completely remove/paint over the red tint itself in your output — none of its coloring may remain visible anywhere in the final image."
            : ""
        }`
      : `Cover-Up Mode is DISABLED. Every pixel of existing tattoo ink visible on IMAGE 1 — anywhere in the frame, including inside the marked region — must remain completely untouched: same linework, same shading, same color, same position. Treat all existing ink as a protected, immutable layer. The new design must be drawn ONLY on bare/open skin within the marked region, routing around any existing ink rather than covering, dimming, blending over, or redrawing any part of it. ${
          regionMaskApplied
            ? "IMAGE 1 also has a subtle translucent GREEN tint burned directly onto it, covering exactly the sub-areas of the marked region that were separately measured to be open, bare skin — this tint is a precise, ground-truth guide to where skin actually is, far more reliable than judging it yourself from the photo. The new design may ONLY be placed on the green-tinted areas; treat any area without the tint (whether inside or outside the marked region) as existing ink, background, or otherwise off-limits, and leave it completely untouched. Completely remove/paint over the green tint itself in your output — none of its coloring may remain visible anywhere in the final image, on skin or otherwise. "
            : ""
        }${
          extendsOffFrame
            ? "Note: because this marked region deliberately runs off the edge of this photo, only the in-frame slice of the design needs to be placed on open skin here — do not scale up, reposition, or force the entire design to appear within the visible frame just to satisfy this rule; a partial/cropped design confined to the visible, open-skin portion of the region is the correct and expected result for this angle."
            : "If the marked region does not contain enough open skin for the full design at its original size and shape, do NOT just shrink it and center it as a smaller rigid rectangle — instead let the design's own individual elements (leaves, clouds, wisps, florals, filigree, whatever it's made of) flow into whatever open skin actually exists around the existing ink, the way a real tattoo artist adds background filler that threads and hugs its way around an established centerpiece rather than sitting on top of it. Redistribute, reshape, crop, or nudge parts of the design so they settle naturally into the real gaps and negative space between existing tattoo pieces, following those contours instead of overlapping them. Aim for the most complete, natural-looking result the available open skin genuinely allows — but a smaller, partial, or even fairly minimal result confined entirely to real open skin is a perfectly good outcome, and is always the correct choice over covering any existing ink to force a more prominent result. Never paint over existing ink just to make the new design bigger or more visible."
        }`
  }
- Style consistency: blend the design's shading and saturation to match the lighting and skin tone of IMAGE 1 exactly, so the result reads as one cohesive, finished piece by the same artist.
- Ink color match (important): look closely at the actual black/gray tone of the EXISTING tattoo ink visible in IMAGE 1 — its darkness, any fading or aging, and overall saturation — and adjust the new design's black/dark tones in the final blend to match that exact ink tone, not a fresh pure black. Any additional colors in the new design (if requested) can be fully saturated, but blacks/grays must visually match the existing ink so the whole piece looks like it was done by the same artist in a consistent style, not two different tattoos of different ages.
- Flow: follow the natural muscle and skin contours of the ${bodyPart} for a seamless, anatomically correct wrap.
- Detail preservation (crucial): render the tattooed region at full sharpness — do not soften, blur, simplify, or smooth away the design's fine linework and shading detail while blending it onto the skin. The marked region should look like a high-resolution close-up photograph of real, crisp tattoo linework, not a hazy or simplified approximation of it.
- Output (crucial): a single photorealistic photograph of the same body part, same lighting, same skin tone, and same framing as IMAGE 1, with the design from IMAGE 2 seamlessly and permanently added as if freshly tattooed. The marked region must look visibly different from IMAGE 1 — pixel-identical or near-identical output to IMAGE 1 is always a failed result, never an acceptable one. Do not alter the person's identity or any unrelated background elements. This is a professional, realistic tattoo-session proposal image.${offFrameOverride}`;
}

// How many design variations one prompt produces. One prompt still costs the
// user exactly ONE generation from their allowance — they're choosing between
// samples of the same idea, not spending three goes. Kept at 3 deliberately:
// 2 reads as a coin-flip rather than a choice, and beyond 3 the extra options
// mostly add cost and choice-paralysis to what is meant to be a narrowing
// decision about permanent ink.
const DESIGN_VARIATION_COUNT = 3;

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

// API: Check server health
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// API: creates the Firestore user doc on first sign-in (idempotent — safe to call every login)
// Builds the profile shape the client shows (tier, role, usage this period).
async function profileFor(uid: string, user: any) {
  const allowance = await checkGenerationAllowance(uid);
  return {
    tier: user.tier,
    role: user.role,
    generationsThisPeriod: allowance.used,
    generationLimit: allowance.limit
  };
}

// API: creates the Firestore user doc on first sign-in (idempotent — safe to call every login).
// Also returns the profile, so the client needs ONE request per page load, not two.
app.post("/api/ensure-user", requireAuth, async (req, res) => {
  try {
    const user = await ensureUserDoc(req.uid!, req.userEmail || null, null, req.emailVerified === true);
    res.json({ success: true, user, profile: await profileFor(req.uid!, user) });
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
    res.json({ success: true, profile: await profileFor(req.uid!, user) });
  } catch (error: any) {
    console.error("me endpoint error:", error);
    res.status(500).json({ error: error.message || "Failed to load your account." });
  }
});

// --- Admin account management (requireAuth + requireAdmin on every route below) ---

const ACCOUNT_ROLES = ["consumer", "artist", "studio_admin", "admin"];
const PLAN_TIERS = ["free", "design_pass", "artist_starter", "studio"];
const SUBSCRIPTION_STATUSES = ["none", "active", "past_due", "canceled"];

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
    if (patch.role && !ACCOUNT_ROLES.includes(patch.role)) {
      return res.status(400).json({ error: `role must be one of: ${ACCOUNT_ROLES.join(", ")}.` });
    }
    if (patch.tier && !PLAN_TIERS.includes(patch.tier)) {
      return res.status(400).json({ error: `tier must be one of: ${PLAN_TIERS.join(", ")}.` });
    }
    if (patch.subscriptionStatus && !SUBSCRIPTION_STATUSES.includes(patch.subscriptionStatus)) {
      return res.status(400).json({ error: `subscriptionStatus must be one of: ${SUBSCRIPTION_STATUSES.join(", ")}.` });
    }
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

/**
 * The site's own origin for Stripe return URLs. The Origin header is
 * caller-controlled, so it's only honoured when it points at this same host;
 * otherwise the request's own protocol + host is used. (Stops a crafted
 * request from sending a customer to an attacker's page after paying.)
 */
function ownOrigin(req: express.Request): string {
  const host = req.get("host") || "";
  const fallback = `${req.protocol}://${host}`;
  const origin = req.headers.origin;
  if (!origin) return fallback;
  try {
    return new URL(origin).host === host ? origin : fallback;
  } catch {
    return fallback;
  }
}

// --- Billing (Stripe) ---

// API: start a checkout flow for a plan (one-time Design Pass, or Artist/Studio subscription)
app.post("/api/create-checkout-session", requireAuth, async (req, res) => {
  const { plan } = req.body as { plan?: "design_pass" | "artist_starter" | "studio" };
  if (!plan) return res.status(400).json({ error: "A plan is required." });
  if (!stripeConfigured) {
    return res.status(500).json({ error: "Payments are not configured yet. Set STRIPE_SECRET_KEY and the STRIPE_PRICE_* env vars." });
  }
  try {
    const origin = ownOrigin(req);
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
    const origin = ownOrigin(req);
    const url = await createBillingPortalSession(req.uid!, `${origin}/`);
    res.json({ success: true, url });
  } catch (error: any) {
    console.error("create-billing-portal-session error:", error);
    res.status(500).json({ error: error.message || "Failed to open billing portal." });
  }
});

// API: Phase 1 — analyze uploaded photo(s) of existing tattoo work
app.post("/api/analyze-tattoo", requireAuth, aiLimiter, async (req, res) => {
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

    const response = await generateContentWithRetry(ai, {
      // gemini-3.5-flash-lite (GA July 2026): ~5x cheaper than 3.5-flash on
      // this single-shot vision-classification + JSON-extraction task, which
      // doesn't need 3.5-flash's heavier reasoning. Verified quality
      // side-by-side against 3.5-flash before switching (see PR notes).
      model: "gemini-3.5-flash-lite",
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
    res.status(statusFor(error)).json({
      error: friendlyGeminiError(error, "Failed to analyze the uploaded photo.", "text"),
      details: process.env.NODE_ENV === "production" ? undefined : error.toString()
    });
  }
});

// API: Stage A — generate ONE isolated tattoo design (the single source of truth
// that gets composited onto every angle, so the artwork itself never varies).
app.post("/api/generate-tattoo-design", requireAuth, aiLimiter, async (req, res) => {
  const {
    bodyPart,
    theme,
    description = "",
    correction = "",
    prompt,
    style = "fineline blackwork",
    colorPreference = "monochrome",
    referenceImage,
    coverUp = false
  } = req.body as {
    bodyPart?: string;
    theme?: string;
    description?: string;
    correction?: string;
    prompt?: string;
    style?: string;
    colorPreference?: string;
    referenceImage?: string;
    coverUp?: boolean;
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

  // Real server-side enforcement of the generation allowance. This previously
  // only existed as a client-side check (which could never fire, because usage
  // was never recorded either) — so the free limit was effectively unlimited
  // and every prompt was uncapped spend. Both halves are wired up now: refuse
  // here when out of allowance, and record a generation once one succeeds.
  let allowance;
  try {
    allowance = await checkGenerationAllowance(req.uid!);
  } catch (error: any) {
    console.error("Allowance check failed:", error);
    return res.status(500).json({ error: "Couldn't verify your remaining generations. Please try again." });
  }
  if (!allowance.allowed) {
    return res.status(402).json({
      error: "You've used your free generation(s) for this period. Upgrade to keep generating designs.",
      upgradeRequired: true
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
      hasReferenceImage: !!referenceImage,
      coverUp: coverUp === true
    });

    const parts: any[] = [];
    if (referenceImage) {
      const ref = parseDataUrl(referenceImage);
      parts.push({ inlineData: { mimeType: ref.mimeType, data: ref.data } });
    }
    parts.push({ text: fullPrompt });

    // One prompt = N independent samples, generated in PARALLEL so wall-clock
    // stays roughly the same as a single generation. Independent calls (rather
    // than one call asking for N) give genuinely different designs to choose
    // between, which is the whole point. Counts as ONE generation against the
    // user's allowance — see recordGeneration below.
    const results = await Promise.allSettled(
      Array.from({ length: DESIGN_VARIATION_COUNT }, () =>
        generateContentWithRetry(ai, {
          model: "gemini-3.1-flash-lite-image",
          contents: { parts },
          config: { imageConfig: { aspectRatio: "1:1" } }
        })
      )
    );

    const imageUrls: string[] = [];
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      const responseParts = r.value?.candidates?.[0]?.content?.parts;
      if (!responseParts) continue;
      for (const part of responseParts) {
        if (part.inlineData?.data) {
          imageUrls.push(`data:image/png;base64,${part.inlineData.data}`);
          break;
        }
      }
    }

    // Partial success is fine — the picker just shows fewer options. Only a
    // total wipeout is an error, so one flaky sample never fails the request.
    if (imageUrls.length === 0) {
      const firstRejection = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
      if (firstRejection) throw firstRejection.reason;
      throw new Error("No image was returned from the Gemini API model response. Please check your prompt and try again.");
    }

    try {
      await recordGeneration(req.uid!);
    } catch (error: any) {
      // Never fail a successful generation just because the counter write did.
      console.error("Failed to record generation usage:", error);
    }

    // `imageUrl` (singular) is kept for backward compatibility with any client
    // that hasn't been updated to read the array.
    res.json({ success: true, imageUrls, imageUrl: imageUrls[0] });
  } catch (error: any) {
    console.error("Isolated Design Generation Error:", error);
    res.status(statusFor(error)).json({
      error: friendlyGeminiError(error, "Failed to generate the tattoo design."),
      details: process.env.NODE_ENV === "production" ? undefined : error.toString()
    });
  }
});

// API: Stage B — blend the (already-generated) design photorealistically onto a
// specific base photo at a user-drawn placement box.
app.post("/api/composite-photorealistic", requireAuth, aiLimiter, async (req, res) => {
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
    designIsPreIsolated = true,
    skinMaskApplied = false
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
    skinMaskApplied?: boolean;
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
      skinMaskApplied: !!skinMaskApplied,
      designIsPreIsolated: designIsPreIsolated !== false
    });

    const response = await generateContentWithRetry(ai, {
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
          // Gemini 3.1 Flash (Lite) Image supports 14 output aspect ratios as of
          // the July 2026 release — wider than the 5 this allowlist used to
          // cover. Letting getImageOrientation() (imageCompose.ts) pick from the
          // full set means the requested output ratio lands closer to a real
          // phone photo's actual proportions, so drawImageCover() has less to
          // crop away before compositing the patch back onto the original.
          aspectRatio: [
            "1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"
          ].includes(aspectRatio)
            ? aspectRatio
            : "1:1"
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
    res.status(statusFor(error)).json({
      error: friendlyGeminiError(error, "Failed to generate the photorealistic composite."),
      details: process.env.NODE_ENV === "production" ? undefined : error.toString()
    });
  }
});

// API: post-generation sanity check for the photorealistic composite. Every
// prior "off-skin floating," "design silently missing," and "placement
// drifted from the drawn box" failure found in QA shared the same blind spot:
// the client trusted Gemini's image output was framed/aligned correctly and
// pasted it straight in, with no check that anything actually landed where
// (or that it landed at all). This does a cheap, targeted before/after
// comparison of just the marked region and flags it — the client retries the
// generation once on a "fail" verdict before giving up and surfacing a
// warning, rather than silently accepting a bad result. Best-effort by
// design: if this call itself errors, the client falls back to trusting the
// generation as before, same non-blocking pattern as the skin/ink detection
// pass above.
app.post("/api/verify-tattoo-result", requireAuth, aiLimiter, async (req, res) => {
  const { beforeCrop, afterCrop, coverUp = false } = req.body as {
    beforeCrop?: string;
    afterCrop?: string;
    coverUp?: boolean;
  };
  if (!beforeCrop || !afterCrop) {
    return res.status(400).json({ error: "Both a before and after crop are required." });
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

    const before = parseDataUrl(beforeCrop);
    const after = parseDataUrl(afterCrop);

    const prompt = `IMAGE 1 shows a close-up of a specific region of a photo BEFORE a new tattoo design was supposed to be added there. IMAGE 2 shows that exact same region AFTER.

Look carefully at both and answer honestly:
1. Did a clearly new, distinct tattoo design actually appear somewhere within IMAGE 2 compared to IMAGE 1 — not just a lighting shift, color grading change, or subtle noise?
2. Is that new design fully rendered ON the person's real skin, with no part of it appearing to float, hover, or sit disconnected over background, a wall, furniture, clothing, or empty space outside the body?
3. ${
      coverUp
        ? "Cover-Up mode was ON for this generation, so it's fine and expected if the new design covers or replaces existing tattoo ink that was visible in IMAGE 1."
        : "Cover-Up mode was OFF for this generation, so any existing tattoo ink visible in IMAGE 1 should still look essentially the same in IMAGE 2 — not painted over, faded, or redrawn."
    }

Respond with ONLY raw JSON, no markdown fences, no commentary, in exactly this shape:
{"changed": true|false, "onSkin": true|false, "verdict": "pass"|"fail", "reason": "one short sentence explaining the verdict"}

"verdict" must be "pass" only if a new design clearly appeared AND it is fully on real skin with nothing floating over background. Otherwise it must be "fail".`;

    const response = await generateContentWithRetry(ai, {
      // gemini-3.5-flash-lite: same cheap single-shot vision-classification task
      // as the skin/ink detection pass above, doesn't need heavier reasoning.
      model: "gemini-3.5-flash-lite",
      contents: {
        parts: [
          { inlineData: { mimeType: before.mimeType, data: before.data } },
          { inlineData: { mimeType: after.mimeType, data: after.data } },
          { text: prompt }
        ]
      }
    });

    const text = response?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || "";
    if (!text.trim()) {
      throw new Error("No verification result was returned.");
    }

    const parsed = extractJson(text);
    if (!parsed || typeof parsed.verdict !== "string") {
      throw new Error("Verification response was malformed.");
    }

    res.json({
      success: true,
      verdict: parsed.verdict === "pass" ? "pass" : "fail",
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
      changed: !!parsed.changed,
      onSkin: !!parsed.onSkin
    });
  } catch (error: any) {
    console.error("Verify Tattoo Result Error:", error);
    res.status(statusFor(error)).json({
      error: friendlyGeminiError(error, "Failed to verify the generated result.", "text"),
      details: process.env.NODE_ENV === "production" ? undefined : error.toString()
    });
  }
});

// API: Suggest tattoo ideas tailored to the confirmed analysis ("Inspire me")
app.post("/api/suggest-tattoo-ideas", requireAuth, aiLimiter, async (req, res) => {
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

    const response = await generateContentWithRetry(ai, {
      // Same swap as /api/analyze-tattoo — plain text JSON generation, no
      // heavy reasoning required.
      model: "gemini-3.5-flash-lite",
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
    res.status(statusFor(error)).json({
      error: friendlyGeminiError(error, "Failed to suggest tattoo ideas.", "text"),
      details: process.env.NODE_ENV === "production" ? undefined : error.toString()
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

app.post("/api/generate-reference-sheet", requireAuth, aiLimiter, async (req, res) => {
  const {
    bodyPart,
    theme,
    description = "",
    correction = "",
    designImage,
    referenceImage,
    referenceIsGeneratedResult = false,
    placementBox
  } = req.body as {
    bodyPart?: string;
    theme?: string;
    description?: string;
    correction?: string;
    designImage?: string;
    referenceImage?: string;
    referenceIsGeneratedResult?: boolean;
    placementBox?: { x: number; y: number; width: number; height: number };
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

    // When the client sends the finished composite (the normal case now), IMAGE 2
    // is the approved result and this sheet is a RE-POSE of it — not a new
    // invention. Previously this prompt asked for a "generic figure" that merely
    // matched skin tone, and never received the placement box at all, so the
    // sheet showed an imagined body with a guessed placement. Both are fixed here.
    const boxNote = placementBox
      ? ` The new design sits at approximately ${placementBox.width.toFixed(0)}% wide by ${placementBox.height.toFixed(0)}% tall of that photo, with its top-left corner about ${placementBox.x.toFixed(0)}% from the left and ${placementBox.y.toFixed(0)}% from the top — use this together with what you can see in IMAGE 2 to keep the design in the SAME anatomical position on the body in every panel.`
      : "";

    const sourceNote = referenceIsGeneratedResult
      ? `IMAGE 2 is the APPROVED FINAL RESULT: a real photo of this specific person with the new tattoo already applied. It is the ground truth for this sheet in three ways — the person's actual body (build, proportions, skin tone), the exact appearance of the new design as inked, and its exact position and scale on the body.${boxNote}

CRITICAL — re-pose, do not reinvent: your job is to show THIS SAME body wearing THIS SAME tattoo from ${layout === "single" ? "the specified viewpoint" : "the specified viewpoints"}, as if the same person were photographed again from a different angle. Reproduce the design's linework, size, and anatomical position exactly as they appear in IMAGE 2 — only the camera angle changes. Do NOT substitute a generic model, do NOT redraw or restyle the design, and do NOT move it to a different spot on the body than where IMAGE 2 clearly shows it.`
      : `IMAGE 2 is a reference photo — loosely match this person's skin tone and body build for the generic figure. This is a reference figure for a tattoo artist, not a portrait, so exact facial likeness is not required or wanted.${boxNote}`;

    const instruction = `${layoutInstruction}

${sourceNote}

${containmentNote}
${consistencyNote}

On ${layout === "single" ? "the image" : "every one of the panels, where the confirmed location is actually visible in that pose"}, show:
1. The existing tattoo work already at this location, themed as: ${theme}. ${description}
2. ${referenceIsGeneratedResult ? "The new tattoo design exactly as it already appears applied in IMAGE 2" : "The new tattoo design shown in IMAGE 1"}, in the same anatomically consistent spot relative to the existing work${isMultiPanel ? ", consistently across panels" : ""}.
${correctionLine}

Style: clean, evenly lit studio photography look, consistent lighting and neutral background${isMultiPanel ? " across all panels so they read as one cohesive reference sheet" : ""}. ${captionNote} This is a professional tool for a tattoo artist to review the confirmed design and placement from the angle(s) that actually matter for it before a session — not a showcase of imaginary ink elsewhere on the body.`;

    const response = await generateContentWithRetry(ai, {
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
    res.status(statusFor(error)).json({
      error: friendlyGeminiError(error, "Failed to generate the reference sheet."),
      details: process.env.NODE_ENV === "production" ? undefined : error.toString()
    });
  }
});

// Portfolio items as the public sees them: the liker fingerprints never leave the server.
function publicPortfolioItem(data: any) {
  const { likedBy, ...rest } = data || {};
  return rest;
}

// Stored per item instead of raw uids, so the (publicly readable) portfolio
// documents never reveal which accounts liked what.
function likerFingerprint(itemId: string, uid: string): string {
  return createHash("sha256").update(`${itemId}:${uid}`).digest("hex").slice(0, 24);
}

// The portfolio is the same for everyone and changes rarely, but each read pulls
// up to 200 documents (with their images) out of Firestore. Keep one copy in
// memory briefly, and let the CDN hold it too (s-maxage), so a page full of
// visitors costs a handful of function runs instead of one each.
const PORTFOLIO_CACHE_MS = 60_000;
let portfolioCache: { at: number; items: any[] } | null = null;

app.get("/api/portfolio", async (req, res) => {
  try {
    if (!portfolioCache || Date.now() - portfolioCache.at > PORTFOLIO_CACHE_MS) {
      if (!firestoreDb) throw new Error("Firestore is not configured.");
      const snap = await firestoreDb.collection("portfolio").limit(200).get();
      const items = snap.docs.map((doc: any) => publicPortfolioItem(doc.data()));
      items.sort((a: any, b: any) => {
        if (b.likes !== a.likes) return b.likes - a.likes;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
      portfolioCache = { at: Date.now(), items };
    }
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    res.json({ success: true, items: portfolioCache.items });
  } catch (error: any) {
    console.error("Portfolio List Error:", error);
    res.status(500).json({ error: "Failed to load the portfolio." });
  }
});

// API: like a portfolio design — signed-in only, and one like per account per
// design (repeat requests are no-ops that return the current count).
app.post("/api/portfolio/:id/like", requireAuth, likeLimiter, async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!firestoreDb) throw new Error("Firestore is not configured.");

    const docRef = firestoreDb.collection("portfolio").doc(id);
    const snap = await docRef.get();
    if (!snap.exists) {
      return res.status(404).json({ error: "Design not found." });
    }

    const data = snap.data() || {};
    const fingerprint = likerFingerprint(id, req.uid!);
    const likedBy: string[] = Array.isArray(data.likedBy) ? data.likedBy : [];
    if (likedBy.includes(fingerprint)) {
      return res.json({ success: true, alreadyLiked: true, item: publicPortfolioItem(data) });
    }

    const updated = { ...data, likes: (data.likes || 0) + 1, likedBy: [...likedBy, fingerprint] };
    await docRef.update({ likes: updated.likes, likedBy: updated.likedBy });
    portfolioCache = null; // next list read reflects the new count
    res.json({ success: true, alreadyLiked: false, item: publicPortfolioItem(updated) });
  } catch (error: any) {
    console.error("Portfolio Like Error:", error);
    res.status(500).json({ error: "Failed to like this design." });
  }
});

// Project access codes: 6 characters from an unambiguous alphabet. Anything
// else is rejected up front, so lookups can't be used to probe arbitrary
// document ids in the collection.
const PROJECT_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const PROJECT_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function normalizeProjectCode(raw: unknown): string | null {
  const code = String(raw ?? "").toUpperCase().trim();
  return PROJECT_CODE_RE.test(code) ? code : null;
}

// API: Save Project (Cross-Device persistence).
// Ownership rules: a project that belongs to an account can only be overwritten
// by that account; an anonymous project (saved while signed out) stays editable
// by whoever holds its code, which is what the share-by-code flow relies on —
// and the first signed-in save over it claims it for that account.
app.post("/api/projects", optionalAuth, projectWriteLimiter, async (req, res) => {
  try {
    const projectData = req.body && typeof req.body === "object" ? req.body : {};
    if (!firestoreDb) throw new Error("Firestore is not configured.");
    const projectsColl = firestoreDb.collection("projects");

    let code = normalizeProjectCode(projectData.code);
    let existingData: any = null;
    if (code) {
      const snap = await projectsColl.doc(code).get();
      if (snap.exists) {
        existingData = snap.data();
        if (existingData?.ownerUid && existingData.ownerUid !== req.uid) {
          return res.status(403).json({
            error: "This project belongs to another account, so it can't be overwritten. Save it as a new project instead.",
            code: "PROJECT_OWNED"
          });
        }
      } else {
        code = null; // unknown code: issue a fresh one rather than letting callers pick ids
      }
    }

    if (!code) {
      let attempt = 0;
      let exists = true;
      do {
        code = "";
        for (let i = 0; i < 6; i++) {
          code += PROJECT_CODE_CHARS.charAt(randomInt(PROJECT_CODE_CHARS.length));
        }
        const snap = await projectsColl.doc(code).get();
        exists = snap.exists;
        attempt++;
      } while (exists && attempt < 100);
      if (exists) throw new Error("Could not generate a unique project code.");
    }

    const timestamp = new Date().toISOString();
    const savedProject = {
      ...projectData,
      code,
      createdAt: existingData?.createdAt || timestamp,
      updatedAt: timestamp,
      // Tags the project as belonging to the signed-in user, if any — this is
      // what powers "Load Project" (listing your own saves).
      ownerUid: req.uid || existingData?.ownerUid || null
    };

    await projectsColl.doc(code).set(savedProject);

    const { ownerUid: _omit, ...publicProject } = savedProject;
    res.json({
      success: true,
      code,
      message: `Project saved successfully with access code: ${code}`,
      project: publicProject,
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
    // Only the fields the list shows are fetched (select). Whole project
    // documents carry several base64 photos each, so reading 100 of them just
    // to list names and thumbnails moved tens of MB per open of "Load Project".
    // Sorting here (rather than via .orderBy in the query) avoids needing a
    // Firestore composite index for this where+orderBy combination.
    const snap = await firestoreDb
      .collection("projects")
      .where("ownerUid", "==", req.uid)
      .select("code", "name", "updatedAt", "thumbnail")
      .limit(100)
      .get();
    const projects = snap.docs
      .map((d: any) => {
        const data = d.data();
        return {
          code: data.code,
          name: data.name || "Untitled Project",
          updatedAt: data.updatedAt,
          // Saved projects carry a small thumbnail (added at save time); projects
          // saved before that existed simply show no thumbnail until re-saved.
          thumbnail: data.thumbnail || null
        };
      })
      .sort((a: any, b: any) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 50);
    res.json({ success: true, projects });
  } catch (error: any) {
    console.error("my-projects error:", error);
    res.status(500).json({ error: error.message || "Failed to load your saved projects." });
  }
});

// API: Load Project (by access code — the code is the capability, so lookups are
// rate limited per IP and the owner's account id is never returned).
app.get("/api/projects/:code", projectReadLimiter, async (req, res) => {
  try {
    const code = normalizeProjectCode(req.params.code);
    if (!code) {
      return res.status(404).json({ error: "That isn't a valid project code." });
    }
    if (!firestoreDb) throw new Error("Firestore is not configured.");

    const snap = await firestoreDb.collection("projects").doc(code).get();

    if (!snap.exists) {
      return res.status(404).json({ error: `Project not found for access code: ${code}` });
    }

    const { ownerUid: _omit, ...project } = snap.data() || {};
    res.json({
      success: true,
      code,
      project,
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
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ error: "The request body wasn't valid JSON." });
  }
  if (err?.type === "entity.too.large" || err?.status === 413) {
    return res.status(413).json({
      error: "That request is too large. Try a smaller photo, or remove some history entries or unused angle photos, then try again."
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
