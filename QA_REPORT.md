# InkVision QA report

Date: 2026-10-24 · Branch: `ccr-59ea2167-skkbdl`

## What was and wasn't tested

| Area | Status |
|---|---|
| `npm run lint` (tsc) and `npm run build` | Pass, before and after my changes |
| Server routes (auth gating, validation, error handling) | Run locally with `curl` |
| Landing and sign-in screens at 375, 820 and 1280 px | Run in headless Chromium, no JS errors, no horizontal overflow |
| Client compositing pipeline (`imageCompose.ts`) | Run in headless Chromium against a **synthetic** arm photo and a **synthetic** design, including the real MediaPipe model |
| Real Gemini output quality | **Not tested.** There is no `GEMINI_API_KEY` in this session. |
| Studio screens, placement editor, adjustments, Stripe, admin panel | **Not exercised in a browser.** The studio is behind Firebase sign-in, and I did not create accounts in your production Firebase project. These were reviewed from code only. |
| Real tattooed-skin photographs | **Not tested.** Findings about realism come from reading prompts and pipeline code plus the synthetic tests, not from looking at real outputs. |

## Fixed in this branch

1. **Design vanishes when segmentation misses the body.**
   - `extractMaskedPatch` and `extractCropPatch` applied the person-silhouette mask as an unconditional hard clip. Their comments called this "safe unconditionally".
   - When MediaPipe classifies a photo as all background (close-ups of a limb with no head or torso in frame are the likely case), the whole design was erased.
   - Reproduced with the real segmenter: before the fix the design vanished (`measureDesignBBox` returned null). After the fix it lands exactly on the box (30, 55, 35×25).
   - The person mask now has the same retention safety net the skin mask already had (`PERSON_CLIP_MIN_RETENTION`).
2. **Cover-Up mode didn't affect design generation.**
   - Stage A (`/api/generate-tattoo-design`) never received `coverUp`.
   - It always said "added next to an existing tattoo". Cover-Up got a sparse or light design, and the blend step then had to hide old ink under it.
   - The flag is now passed, and the prompt asks for a dense, dark, high-coverage design that extends past the old outline.
   - The non-cover-up prompt is unchanged.
3. **Admin privilege escalation via an unverified email.**
   - `ensureUserDoc` promoted any user whose email was in `ADMIN_EMAILS` (default `craigtrickett@gmail.com`).
   - An email/password sign-up can claim an address without proving ownership.
   - Promotion now requires the Firebase token's `email_verified`. Google sign-in is unaffected. If you use email/password for the admin account, verify that email.
4. `.gitignore` now excludes `db_fallback_*.json`. The server writes these on start, and `push.bat` runs `git add .`.

## Open issues, highest priority first

### Security and cost
- **S1. Anyone can read, list and overwrite every saved project (High).**
  - `firestore.rules` has `projects … allow read, write: if true`, and the client reads and writes `projects` directly (`App.tsx`). Projects contain customers' body photos.
  - I didn't change the rule because it would break the client's load and save flow. The fix is to move load and save fully behind the server API and set the rule to `false`.
- **S2. `/api/projects` has no ownership check (High).**
  - Verified: an anonymous POST with an existing code overwrote that project. A project saved as "t" was renamed to "HIJACKED" and read back.
  - Codes are 6 characters from a 32-character alphabet, and `GET /api/projects/:code` is unauthenticated.
- **S3. Most Gemini endpoints are unauthenticated and unmetered (High).**
  - Only `generate-tattoo-design` checks sign-in and the free allowance.
  - `analyze-tattoo`, `composite-photorealistic`, `verify-tattoo-result`, `suggest-tattoo-ideas` and `generate-reference-sheet` have no auth. Each generation also triggers a composite, a verify and possibly a retry, all uncounted.
  - Verified they reach the Gemini key check without a token (HTTP 400 "key not configured", not 401), and a 6 MB body is accepted (the limit is 80 MB).
  - Fix: add `requireAuth` to these routes and send the ID token from the client. Rate-limit them.
- **S5. Portfolio is spam- and abuse-prone (Medium).** `portfolio create: if true` in the rules. The like endpoint is unauthenticated, so likes are unlimited, and it is a non-atomic read-modify-write.
- **Minor:**
  - Malformed JSON returns the parser's raw message.
  - `parseDataUrl` doesn't check the MIME type.
  - The checkout redirect URL is built from the `Origin` header.
  - `generate-reference-sheet` skips `generateContentWithRetry`.
  - The admin PATCH accepts arbitrary `role` and `tier` strings.

### Output quality: placement, existing tattoos and cover-ups
- **Q1. "Next to existing ink" is enforced by the prompt only.**
  - In Cover-Up-off mode the green tint comes from the selfie model's skin class, which doesn't distinguish ink. No client clip restores old ink.
  - The only check afterwards is an LLM before/after comparison.
  - Recommended: build a pixel ink mask (dark or saturated pixels against the local skin median, or a text-prompted segmenter, see the RepoShelf list). After generation, restore base pixels under the dilated mask. That gives a real guarantee.
- **Q2. No check that a cover-up actually covers the old tattoo.**
  - `analyze-tattoo` returns text only, with no bounding box for existing ink.
  - A placement box that only partly overlaps the old piece leaves a visible rim.
  - Recommended: return `inkBox`, warn when the box doesn't enclose it with margin, and offer "fit to existing tattoo".
- **Q3. Adjustments can push ink off the body.**
  - The patch is clipped to the silhouette when generated, then scaled, rotated or offset in `compositePatchWithAdjust` with no re-clip.
  - Measured on the synthetic test: scale 100% to 140% grew the footprint from 35×25 to 49×36 points of the frame. Silhouette edges move outward with it.
  - Recommended: re-apply the person mask after the transform, or clamp the scale range.
- **Q4. Aspect-ratio drift.**
  - Gemini returns one of 14 fixed ratios and `drawImageCover` crops to fit.
  - Worst case I forced (a squashed 1:1 return for a 3:4 photo) shifted the design 2.8 points left and 4.8 points wider.
  - Real drift is smaller. Recommended: pad the crop to the exact target ratio before sending, then un-pad.
- **Q5. Whitework, pastel and very light designs break trimming.**
  - `trimToContent` treats brightness ≥ 235 as padding. The "whitework" option asks for white ink on a pure white background.
  - Verified: a light design (#f0f0f0) on white is returned untrimmed, so the placement box is the whole square.
  - Recommended: generate light designs on a mid-grey or black matte, or request alpha.
- **Q6. The full body photo is sent to design generation.**
  - `referenceImage: activePhoto.src` is the whole uncompressed photo. It's heavy and unnecessary.
  - Send a downscaled crop of the existing ink for the colour-match instruction.
- **Q7. Uploaded photos aren't resized or validated.**
  - The code reads files straight to a data URL.
  - There is no size cap, no downscale and no HEIC handling.
  - On Vercel, request bodies are capped at about 4.5 MB (documented platform limit, not tested here), so large phone photos will fail against the 80 MB Express limit.
- **Q8. Segmenter cold start is about 10 s and depends on CDNs.**
  - In headless Chromium it took 10.5 s: WASM from jsDelivr plus the model from Google storage.
  - Failure falls back silently to the box-only clip, so a CDN outage removes all background protection without telling the user.
  - Recommended: preload on upload and self-host the assets.
- **Output sharpness is unverified.** Gemini's output is stretched to the full photo or crop size. I couldn't judge sharpness without real output.

### UI
- **U1. Mobile landing has no navigation.** The nav is `hidden md:flex` with no mobile alternative, so Portfolio and Pricing are unreachable below 768 px. The title also touches both screen edges at 375 px.
- **U2.** The landing page never reaches `networkidle` (Firebase keeps a connection open). This only affects automated tests.

### Code health
- `/api/detect-skin-regions` and `burnSkinMask` are dead (no client caller).
- `DB_PATH` is unused.
- `_probe.txt` is an empty stray file.
- The production bundle is one 1.3 MB chunk.
- `ENABLE_MULTI_ANGLE = false`, but the off-frame and multi-angle prompt logic is still maintained.

## RepoShelf: listings that could help

I searched RepoShelf's catalog (about 80,000 entries, `dist/catalog.part-*.json`) by keyword.

- **Nothing tattoo-specific exists.** All 70 "tattoo/ink/stencil" hits were false positives (UI libraries, "Ink" the language, printers).
- The listings below are chosen from their titles and descriptions only. I haven't run them, checked licences or judged their quality.

| Need | Listing | Why it could help |
|---|---|---|
| Real existing-ink mask (Q1, Q2) | `IDEA-Research/Grounded-Segment-Anything` | Text-prompted segmentation ("tattoo") would give a pixel mask and bounding box of old ink |
| Body landmarks for placement and curvature | `vladmandic/human`, `open-mmlab/mmpose`, `CMU-Perceptual-Computing-Lab/openpose`, `LingDong-/handpose-facemesh-demos` | Limb axis and orientation to align and warp designs. `human` runs in the browser and has a demo |
| Wrapping onto the body in 3D | `markomih/VolumetricSMPL`, `sha2nkt/deco` | Body-mesh work. This is heavy, so treat it as research rather than a quick win |
| Clean design isolation / alpha (Q5) | `yossdotpro/removerized` (browser background removal), `ZHKKKe/MODNet`, `pymatting/pymatting` | Alpha cut-outs for uploaded reference designs instead of prompt-based "ignore the background" |
| Deterministic lighting match | `Erkaman/poisson_blend` | Seamless-clone reference for a post-pass that matches tone and edges |
| Architecture analogues | `tryonlabs/opentryon`, `Miragic-AI/VirtualTryOn` (IDM-VTON), `DenRakEiw/scumble` | Virtual try-on is the same "warp onto a body and keep identity" problem. `scumble` is colour-matched layer inpainting |
| Stencil export | `goku-open/goku-image-to-svg-tool` | Raster-to-SVG tracing to compare against `stencil.ts` |

Most of these are Python and server-side. Only `human`, `removerized` and the MediaPipe demos run in the browser.
