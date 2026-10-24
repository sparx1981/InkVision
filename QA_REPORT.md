# InkVision QA report

Date: 2026-10-24 · Branch: `ccr-59ea2167-skkbdl`

## What was and wasn't tested

| Area | Status |
|---|---|
| `npm run lint`, `npm run build` | Pass |
| `npm test` (new) | 7 geometry unit tests and 40 server checks pass. The server checks run the real Express app with Firebase stubbed and Gemini never called. |
| Compositing pipeline in headless Chromium | Run against **synthetic** photos (a drawn "arm" with a dark ink blob, shadows, freckles, light and dark skin tones) with a **mocked** model output. The real MediaPipe segmenter ran. |
| Photo upload helpers | Run in the browser with a 9.5 MB JPEG, a transparent PNG, an EXIF-rotated JPEG, a text file and a corrupt file |
| Landing page at 375, 820 and 1280 px | No JS errors, no horizontal overflow |
| Real Gemini output quality | **Not tested** (no key in this session) |
| Real photographs of tattooed skin | **Not tested.** Ink detection in particular is a heuristic, checked only on synthetic images. |
| Signed-in studio screens, Stripe, admin panel | **Not exercised in a browser.** Reviewed from code only, and the server routes were tested with a stubbed login. |

## Fixed

### Security and cost
- **Admin takeover.** `ADMIN_EMAILS` promotion now requires a verified email.
- **Saved projects are no longer open to the public.**
  - Load and save now go through `/api/projects`. The browser no longer reads or writes Firestore directly for projects.
  - A project owned by an account can't be overwritten by anyone else. A signed-in user who loads someone else's project saves a copy of their own. A project saved while signed out stays editable by whoever holds its code. The first signed-in save over one claims it.
  - Codes are validated and rate limited per IP (30 lookups a minute). The server issues all codes with `crypto.randomInt`, and the owner's account id is never returned.
  - `firestore.rules` now denies all client access to `projects` and all client writes to `portfolio`. **This file isn't deployed by a git push. See "Deploying" below.**
- **AI endpoints need sign-in and are rate limited.** Analyze, composite, verify, ideas and reference-sheet now require a signed-in user and are limited to 20 requests a minute each (per user). The client sends the ID token and shows "Sign in…" when there isn't one. Generation still enforces the free allowance as before.
- **Request limits.** Request bodies are capped at 25 MB, except `/api/projects` at 80 MB. Data URLs must be PNG, JPEG or WebP (a bad one is a 400, not a 500). Bad JSON returns a generic message. Error `details` are no longer sent in production.
- **Portfolio likes** need sign-in, count once per account (stored as hashes, never exposed) and are rate limited. The portfolio list is read through the API.
- **Smaller fixes.**
  - Admin PATCH validates `role`, `tier` and `subscriptionStatus`.
  - Stripe return URLs only honour an `Origin` that matches the site's own host.
  - Ideas and reference-sheet calls now retry on overload like the others.
  - The dead `/api/detect-skin-regions` route, `burnSkinMask` and unused constants and files are gone.
  - `db_fallback_*.json` is gitignored.

### Placement, existing tattoos and cover-ups
- **Design vanishing.** The person-silhouette clip is skipped when it would erase more than half the design, which is what happens when segmentation misses the body. Reproduced and fixed.
- **Existing ink is now protected in the pixels (Cover-Up off).**
  - The photo is analysed for existing ink. After generation the original pixels are restored wherever old ink was.
  - On the synthetic test the old ink changed 98.5% of its pixels without protection and 0% with it.
  - The "open skin" tint shown to the model now excludes ink.
  - The detector declines to answer when its result looks implausible: too dark an image, more than 70% of the box flagged, blobs with soft edges, or restoration that would erase more than 85% of the design.
- **Cover-Up helper.** In Cover-Up mode the UI warns when the placement box doesn't enclose the existing tattoo, and offers "Enlarge the box to cover it", which keeps the design's aspect ratio.
- **Cover-Up design generation** now asks for a dense, dark, high-coverage design.
- **Exact-ratio crops.** The region sent to the model is adjusted so its pixel aspect ratio is exactly one the model can return. This removes the crop-and-shift drift. Before, a deliberately mismatched ratio shifted a design by 2.8 points of the frame; with the exact-ratio crop and a mocked model output the design landed with 0 drift. Crops grow by up to 11% to get there.
- **Pale designs.** `trimToContent` now judges content against the image's own border colour, so white-on-white and pastel designs trim properly. Dark backgrounds work too.
- **Segmentation failure is no longer silent.** A toast says edge protection is off. Segmentation preloads when a photo is added (the first load took about 10 s in testing) and the MediaPipe bundle is split out of the main chunk (main bundle 1.30 MB to 1.00 MB).

### Uploads and payloads
- Photos and designs are validated (type, size under 30 MB), rotated by EXIF, and downscaled to 2560 px (photos) or 2048 px (designs). A 9.5 MB worst-case noise JPEG came out at 2.7 MB. Reference photos and analysis inputs are downscaled before sending (1024 and 1536 px), and the blend input to 2048 px.

### UI
- The navigation (Studio / Portfolio / Pricing) now shows on phones. The title and footer no longer touch the screen edges at 375 px.

## Deploying
1. Deploy the app first.
2. Then deploy `firestore.rules` (for example `firebase deploy --only firestore:rules`, with your named database configured). Deploying the rules before the new client is live would break project load and save and portfolio likes for anyone on the old version.
3. Behaviour changes to expect: analysis, ideas and blending need sign-in; likes need sign-in; projects owned by another account save as a copy.

## Still open

**Needs a Gemini key and real photos to verify**
- Whether restoring ink over the old tattoo looks seamless at its edges. The mask is dilated and feathered, but I couldn't judge it on real output.
- Whether the exact-ratio crop and the ink-free tint change the model's output for the better.
- Whether the Cover-Up prompt produces designs that hide old ink in practice.
- Ink detection on real photos: heavily tanned or very dark skin, ink under strong shadow, scars, hair and clothing. The guards decline when unsure, but they were tuned on synthetic images.
- Output sharpness: the model's output is stretched back to the photo or crop size.
- Whitework: the prompt still asks for white ink on a pure white background. Trimming copes now, but whether the model produces something usable is untested. The placement preview also uses multiply blending, which hides white.

**Not done**
- Rate limits are in memory, so on Vercel they apply per warm instance. For real abuse protection add an edge or WAF rule. The composite, verify and retry calls aren't counted against the generation allowance, only rate limited.
- The segmentation model and WASM still load from jsDelivr and Google storage. Self-hosting them would remove that dependency.
- The post-generation Adjustments panel no longer rescales the patch (`compositePatchWithAdjust` is only called with defaults), so my earlier finding that scaling could push ink off the body can't happen in the current flow. It would matter again if live scaling returns.
- `ENABLE_MULTI_ANGLE = false`, but the multi-angle and off-frame prompt logic is still maintained.
- Stripe checkout and webhooks, the admin panel UI and email/password sign-up weren't exercised.

## RepoShelf: listings that could help

I searched RepoShelf's catalog (about 80,000 entries, `dist/catalog.part-*.json`) by keyword.

- **Nothing tattoo-specific exists.** All 70 "tattoo/ink/stencil" hits were false positives (UI libraries, "Ink" the language, printers).
- The listings below are chosen from their titles and descriptions only. I haven't run them, checked licences or judged their quality.

| Need | Listing | Why it could help |
|---|---|---|
| A stronger existing-ink mask (replacing the darkness heuristic) | `IDEA-Research/Grounded-Segment-Anything` | Text-prompted segmentation ("tattoo") would give a pixel mask and bounding box of old ink |
| Body landmarks for placement and curvature | `vladmandic/human`, `open-mmlab/mmpose`, `CMU-Perceptual-Computing-Lab/openpose`, `LingDong-/handpose-facemesh-demos` | Limb axis and orientation to align and warp designs. `human` runs in the browser and has a demo |
| Wrapping onto the body in 3D | `markomih/VolumetricSMPL`, `sha2nkt/deco` | Body-mesh work. This is heavy, so treat it as research rather than a quick win |
| Clean design isolation / alpha | `yossdotpro/removerized` (browser background removal), `ZHKKKe/MODNet`, `pymatting/pymatting` | Alpha cut-outs for uploaded reference designs instead of prompt-based "ignore the background" |
| Deterministic lighting match | `Erkaman/poisson_blend` | Seamless-clone reference for a post-pass that matches tone and edges |
| Architecture analogues | `tryonlabs/opentryon`, `Miragic-AI/VirtualTryOn` (IDM-VTON), `DenRakEiw/scumble` | Virtual try-on is the same "warp onto a body and keep identity" problem. `scumble` is colour-matched layer inpainting |
| Stencil export | `goku-open/goku-image-to-svg-tool` | Raster-to-SVG tracing to compare against `stencil.ts` |

Most of these are Python and server-side. Only `human`, `removerized` and the MediaPipe demos run in the browser.
