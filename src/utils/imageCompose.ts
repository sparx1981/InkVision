import type { ImageSegmenter } from "@mediapipe/tasks-vision";

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

type Box = { x: number; y: number; width: number; height: number };

// ---------------------------------------------------------------------
// Pixel-level body/skin segmentation (MediaPipe Multiclass Selfie
// Segmentation), replacing the earlier coarse-grid, Gemini-graded approach
// (see the removed /api/detect-skin-regions call and the old cell-based
// burnSkinMask). QA on the grid approach found ink repeatedly bleeding onto
// walls, doorways, and clothing whenever a placement box spanned both skin
// and non-skin: the grid tint was only ever a hint to the blend model, and
// the final composite was still hard-clipped to a plain rectangle, so any
// background pixels the model painted inside that rectangle got kept
// regardless. This section produces a REAL per-pixel skin mask instead, and
// that same mask is used twice downstream: once to burn a precise tint the
// blend model can see (visual grounding, in burnSkinMaskFromSegmentation),
// and again as an actual hard clip in extractMaskedPatch — so generated ink
// physically cannot end up outside real skin no matter what the model does.
// ---------------------------------------------------------------------

// Multiclass Selfie Segmentation category indices (fixed by the model).
const SEG_CATEGORY_BACKGROUND = 0;
const SEG_CATEGORY_BODY_SKIN = 2;
const SEG_CATEGORY_FACE_SKIN = 3;

let segmenterPromise: Promise<ImageSegmenter> | null = null;

/** Lazily creates and caches a single ImageSegmenter instance for the whole
 * session — the WASM runtime + model download only ever happens once. */
function getSegmenter(): Promise<ImageSegmenter> {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      // Loaded on demand so the (large) MediaPipe bundle stays out of the main chunk.
      const { FilesetResolver, ImageSegmenter } = await import("@mediapipe/tasks-vision");
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/wasm"
      );
      return ImageSegmenter.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite",
          delegate: "GPU"
        },
        runningMode: "IMAGE",
        outputCategoryMask: true,
        outputConfidenceMasks: false
      });
    })();
    // A failed load (CDN outage, no WebGL) must not be cached forever — let the next call retry.
    segmenterPromise.catch(() => {
      segmenterPromise = null;
    });
  }
  return segmenterPromise;
}

/**
 * Starts downloading the segmentation runtime + model in the background (the
 * first load takes several seconds). Called when a photo is added so the cost
 * is paid while the person is still choosing a design, not on first Generate.
 * Never throws — failures surface later, at generation time, as a warning.
 */
export function preloadSegmenter(): void {
  getSegmenter().catch(() => {});
}

/** Draws `src` onto a canvas at `width`x`height` with a light blur — used both
 * to upscale the segmenter's own output resolution back to the base photo's
 * real dimensions, and as a small amount of edge anti-aliasing. Kept tight
 * (a few pixels only) since this mask is later used as a HARD clip: too much
 * blur would let it bleed past the model's real skin/non-skin boundary. */
function blurToSize(src: CanvasImageSource, srcW: number, srcH: number, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D canvas context.");
  const blurPx = Math.max(2, Math.round(Math.min(width, height) * 0.003));
  ctx.filter = `blur(${blurPx}px)`;
  ctx.drawImage(src, 0, 0, srcW, srcH, 0, 0, width, height);
  return canvas;
}

/**
 * Runs MediaPipe's on-device Multiclass Selfie Segmentation model on the base
 * photo and returns a full-resolution mask canvas whose ALPHA channel (not
 * color — this matches buildFeatherMask's own convention so the two can be
 * combined directly via destination-in) is opaque wherever the model
 * classified that pixel as the person's own skin (body-skin or face-skin
 * categories) and fully transparent everywhere else — background, hair,
 * clothing, jewelry/accessories.
 *
 * Runs entirely client-side (WASM + GPU delegate where available), so there's
 * no added server round-trip and no per-call Gemini cost, unlike the grid
 * classification this replaces.
 */
/**
 * Runs segmentation ONCE and returns two different alpha-encoded masks:
 *
 * - `skin`: bare skin only (body-skin + face-skin categories). Precise when it
 *   works, but QA found this classification unreliable on chests and legs —
 *   it routinely marks obvious bare skin as non-skin. It is therefore only ever
 *   used as a HINT (the burned tint) and as a retention-gated conditional clip.
 *
 * - `person`: the whole person silhouette — every category except background
 *   (skin, hair, clothes, accessories). This is the person-vs-background
 *   boundary, which is the thing this model is genuinely reliable at, on every
 *   body part. It is safe to use as a HARD clip because it can never erase ink
 *   that landed on the body: anything on the person passes through it. It
 *   prevents both ink bleeding onto walls/floors AND the model widening the
 *   limb to fill a placement box that overhangs the body's edge.
 */
export async function getSegmentationMasks(
  baseSrc: string
): Promise<{ skin: HTMLCanvasElement; person: HTMLCanvasElement }> {
  const img = await loadImage(baseSrc);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;

  const segmenter = await getSegmenter();
  const result = segmenter.segment(img);
  const categoryMask = result.categoryMask;
  if (!categoryMask) {
    result.close();
    throw new Error("Segmentation returned no category mask.");
  }

  const maskData = categoryMask.getAsUint8Array();
  const mw = categoryMask.width;
  const mh = categoryMask.height;

  const skinCanvas = document.createElement("canvas");
  skinCanvas.width = mw;
  skinCanvas.height = mh;
  const skinCtx = skinCanvas.getContext("2d");
  const personCanvas = document.createElement("canvas");
  personCanvas.width = mw;
  personCanvas.height = mh;
  const personCtx = personCanvas.getContext("2d");
  if (!skinCtx || !personCtx) throw new Error("Could not get 2D canvas context.");

  const skinData = skinCtx.createImageData(mw, mh);
  const personData = personCtx.createImageData(mw, mh);
  for (let i = 0; i < maskData.length; i++) {
    const category = maskData[i];
    const isSkin = category === SEG_CATEGORY_BODY_SKIN || category === SEG_CATEGORY_FACE_SKIN;
    const isPerson = category !== SEG_CATEGORY_BACKGROUND;
    const o = i * 4;
    // RGB is irrelevant (destination-in only reads alpha) — always white so
    // these are trivially inspectable/debuggable if ever drawn directly.
    skinData.data[o] = 255;
    skinData.data[o + 1] = 255;
    skinData.data[o + 2] = 255;
    skinData.data[o + 3] = isSkin ? 255 : 0;
    personData.data[o] = 255;
    personData.data[o + 1] = 255;
    personData.data[o + 2] = 255;
    personData.data[o + 3] = isPerson ? 255 : 0;
  }
  skinCtx.putImageData(skinData, 0, 0);
  personCtx.putImageData(personData, 0, 0);

  // ImageSegmenterResult.close() frees BOTH the category mask and any
  // confidence masks in one call — calling categoryMask.close() separately
  // as well would double-free the same underlying resource.
  result.close();

  return {
    skin: blurToSize(skinCanvas, mw, mh, width, height),
    person: blurToSize(personCanvas, mw, mh, width, height)
  };
}

/** Bare-skin mask only — see getSegmentationMasks. */
export async function getSkinSegmentationMask(baseSrc: string): Promise<HTMLCanvasElement> {
  return (await getSegmentationMasks(baseSrc)).skin;
}

/** Returns a copy of `maskCanvas` with its alpha channel inverted — used to
 * turn a "this is skin" mask into a "this is NOT skin" mask (background,
 * hair, clothing, accessories combined) for Cover-Up mode's red tint. */
function invertMaskAlpha(maskCanvas: HTMLCanvasElement): HTMLCanvasElement {
  const w = maskCanvas.width;
  const h = maskCanvas.height;
  const ctx = maskCanvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D canvas context.");
  const imgData = ctx.getImageData(0, 0, w, h);

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const octx = out.getContext("2d");
  if (!octx) throw new Error("Could not get 2D canvas context.");
  const outData = octx.createImageData(w, h);
  for (let i = 0; i < imgData.data.length; i += 4) {
    outData.data[i] = 255;
    outData.data[i + 1] = 255;
    outData.data[i + 2] = 255;
    outData.data[i + 3] = 255 - imgData.data[i + 3];
  }
  octx.putImageData(outData, 0, 0);
  return out;
}

// The skin mask is only trusted as a clip when it would KEEP at least this
// fraction of the design Gemini actually painted inside the box. Below it, the
// segmentation is treated as unreliable for this body part (QA found MediaPipe's
// selfie model mis-segmenting chests/legs, marking real bare skin as non-skin
// and thereby erasing valid on-skin ink) and dropped in favour of the
// box-feather clip alone. See measureSkinRetention.
const SKIN_CLIP_MIN_RETENTION = 0.5;

// Same safety net for the person-silhouette clip. The silhouette is far more
// reliable than the bare-skin class, but it is still a segmentation model: on
// a tight close-up of a limb with no head/torso in frame it can classify the
// whole photo as background, and an unconditional clip would then erase the
// entire design (the user sees the design "vanish" with no explanation).
const PERSON_CLIP_MIN_RETENTION = 0.5;

/**
 * Estimates what fraction of the newly-painted design (inside `boxPx`, in the
 * result canvas's own pixels) the `skinMask` would KEEP if applied as a
 * destination-in clip. "Painted design" = pixels where the AI result differs
 * meaningfully from the base at the same spot (i.e. the ink the model actually
 * added), so this measures erasure of the DESIGN itself — not mere overlap
 * with the box rectangle, which is what the old coverage % measured and why it
 * was misleading. `baseCanvas` and `resultCanvas` must be the same size and
 * spatially aligned; `skinMask` is scaled to that size for sampling.
 * Returns 1 when nothing was painted (nothing to erase → mask is harmless).
 */
function measureSkinRetention(
  baseCanvas: HTMLCanvasElement,
  resultCanvas: HTMLCanvasElement,
  skinMask: HTMLCanvasElement,
  boxPx: { x: number; y: number; w: number; h: number }
): number {
  const w = resultCanvas.width;
  const h = resultCanvas.height;
  const bctx = baseCanvas.getContext("2d");
  const rctx = resultCanvas.getContext("2d");
  if (!bctx || !rctx) return 1;

  // Sample the skin mask's alpha aligned to the result's pixel grid.
  const mtmp = document.createElement("canvas");
  mtmp.width = w;
  mtmp.height = h;
  const mctx = mtmp.getContext("2d");
  if (!mctx) return 1;
  mctx.drawImage(skinMask, 0, 0, skinMask.width, skinMask.height, 0, 0, w, h);

  const x0 = Math.max(0, Math.floor(boxPx.x));
  const y0 = Math.max(0, Math.floor(boxPx.y));
  const x1 = Math.min(w, Math.ceil(boxPx.x + boxPx.w));
  const y1 = Math.min(h, Math.ceil(boxPx.y + boxPx.h));
  const bw = x1 - x0;
  const bh = y1 - y0;
  if (bw <= 0 || bh <= 0) return 1;

  const bd = bctx.getImageData(x0, y0, bw, bh).data;
  const rd = rctx.getImageData(x0, y0, bw, bh).data;
  const md = mctx.getImageData(x0, y0, bw, bh).data;

  let painted = 0;
  let kept = 0;
  for (let i = 0; i < bd.length; i += 4) {
    const diff =
      Math.abs(bd[i] - rd[i]) + Math.abs(bd[i + 1] - rd[i + 1]) + Math.abs(bd[i + 2] - rd[i + 2]);
    if (diff > 90) {
      painted++;
      if (md[i + 3] > 128) kept++;
    }
  }
  return painted ? kept / painted : 1;
}

/** Build a soft-edged (blurred) white mask over the box, expanded slightly so the
 * feather doesn't eat into the design itself. Wider/softer than a hard box edge to
 * avoid visible seams where the AI's content meets the original photo. */
function buildFeatherMask(width: number, height: number, box: Box): HTMLCanvasElement {
  // The main remaining artifact isn't seam smoothness — it's that the AI's
  // reconstruction of the body's own silhouette (skin against background)
  // can differ very slightly from the original right where the box boundary
  // crosses that edge. A narrower feather shrinks the zone where that
  // mismatch is visible; the Stage B prompt now also explicitly asks the
  // model to preserve the exact body contour, which matters more here than
  // blur width alone.
  const padX = width * 0.015;
  const padY = height * 0.015;
  const boxX = (box.x / 100) * width - padX;
  const boxY = (box.y / 100) * height - padY;
  const boxW = (box.width / 100) * width + padX * 2;
  const boxH = (box.height / 100) * height + padY * 2;
  const blurPx = Math.max(6, Math.round(Math.min(width, height) * 0.012));

  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = width;
  maskCanvas.height = height;
  const maskCtx = maskCanvas.getContext("2d");
  if (!maskCtx) throw new Error("Could not get 2D canvas context.");
  maskCtx.filter = `blur(${blurPx}px)`;
  maskCtx.fillStyle = "#fff";
  maskCtx.fillRect(boxX, boxY, boxW, boxH);
  return maskCanvas;
}

/**
 * Draws `img` into a `width`x`height` canvas region using "cover" scaling —
 * uniformly scaled so it fills the target box completely, cropping whatever
 * overflows on one axis, centered. This is the same idea as CSS
 * `object-fit: cover`, and is deliberately NOT a non-uniform stretch: it never
 * changes the image's own aspect ratio, so nothing in it gets warped.
 */
function drawImageCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, width: number, height: number) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const scale = Math.max(width / iw, height / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  const dx = (width - dw) / 2;
  const dy = (height - dh) / 2;
  ctx.drawImage(img, dx, dy, dw, dh);
}

/**
 * Extracts just the AI-generated content into a full-canvas-size PNG that's
 * transparent everywhere outside the (feathered) placement box. This patch can
 * then be nudged/rotated/rescaled independently of the base photo via
 * `compositePatchWithAdjust`, without needing to call the AI again.
 *
 * `resultSrc` is Gemini's own output image, which is only ever generated at
 * one of a handful of fixed aspect ratios (1:1, 3:4, 4:3, 9:16, 16:9) — almost
 * never an exact match for an arbitrary phone photo's real dimensions. Forcing
 * it to fill this canvas with a non-uniform stretch (drawImage's simple
 * width/height form) would distort every proportion in it — the exact wrong
 * move right before cropping out the patch that has to sit convincingly on
 * real, undistorted skin. `drawImageCover` scales it uniformly instead, so
 * whatever gets cropped out keeps its true proportions.
 */
export async function extractMaskedPatch(baseSrc: string, resultSrc: string, box: Box, skinMask?: HTMLCanvasElement, personMask?: HTMLCanvasElement, inkMask?: HTMLCanvasElement): Promise<string> {
  const [baseImg, resultImg] = await Promise.all([loadImage(baseSrc), loadImage(resultSrc)]);
  const width = baseImg.naturalWidth || baseImg.width;
  const height = baseImg.naturalHeight || baseImg.height;

  const resultCanvas = document.createElement("canvas");
  resultCanvas.width = width;
  resultCanvas.height = height;
  const resultCtx = resultCanvas.getContext("2d");
  if (!resultCtx) throw new Error("Could not get 2D canvas context.");
  drawImageCover(resultCtx, resultImg, width, height);

  // The box-feather mask is ALWAYS the clip — it structurally guarantees that
  // nothing outside the user's drawn region ever changes. The MediaPipe skin
  // mask is now applied ON TOP only conditionally (see measureSkinRetention /
  // SKIN_CLIP_MIN_RETENTION): it's a best-effort trim of background/clothing
  // bleed inside the box, but it is dropped whenever it would erase more than
  // half of the design the model actually painted — because that segmenter is
  // unreliable on non-arm body parts and was silently deleting valid on-skin
  // ink. Demoted from a guillotine to a hint with a safety net.
  let useSkin = false;
  let usePerson = !!personMask;
  let useInk = !!inkMask;
  if (skinMask || personMask || inkMask) {
    const baseCanvas = document.createElement("canvas");
    baseCanvas.width = width;
    baseCanvas.height = height;
    baseCanvas.getContext("2d")!.drawImage(baseImg, 0, 0, width, height);
    const boxPx = {
      x: (box.x / 100) * width,
      y: (box.y / 100) * height,
      w: (box.width / 100) * width,
      h: (box.height / 100) * height
    };
    if (skinMask) {
      const retention = measureSkinRetention(baseCanvas, resultCanvas, skinMask, boxPx);
      useSkin = retention >= SKIN_CLIP_MIN_RETENTION;
      console.log(
        `[QA-CLIP] full-photo skin retention of painted design: ${(retention * 100).toFixed(1)}% -> ${useSkin ? "APPLY skin clip" : "DROP skin clip (box-feather only)"}`
      );
    }
    if (inkMask) {
      useInk = measureSkinRetention(baseCanvas, resultCanvas, invertMaskAlpha(inkMask), boxPx) >= 1 - INK_CLIP_MAX_REMOVAL;
      console.log(`[QA-CLIP] existing-ink restore: ${useInk ? "APPLY" : "DROP (mask would erase nearly the whole design)"}`);
    }
    if (personMask) {
      const retention = measureSkinRetention(baseCanvas, resultCanvas, personMask, boxPx);
      usePerson = retention >= PERSON_CLIP_MIN_RETENTION;
      console.log(
        `[QA-CLIP] full-photo person retention of painted design: ${(retention * 100).toFixed(1)}% -> ${usePerson ? "APPLY person clip" : "DROP person clip (segmentation missed the body)"}`
      );
    }
  }

  resultCtx.globalCompositeOperation = "destination-in";
  resultCtx.drawImage(buildFeatherMask(width, height, box), 0, 0);
  // Person silhouette: applied as a hard clip whenever segmentation actually
  // found the body (see getSegmentationMasks / PERSON_CLIP_MIN_RETENTION). It
  // only removes pixels outside the body, so on a good segmentation it can
  // never erase a design that landed on the person — it just stops ink on the
  // background and stops the limb being widened to fill an overhanging box.
  if (personMask && usePerson) {
    resultCtx.drawImage(personMask, 0, 0, personMask.width, personMask.height, 0, 0, width, height);
  }
  if (useSkin && skinMask) {
    resultCtx.drawImage(skinMask, 0, 0, skinMask.width, skinMask.height, 0, 0, width, height);
  }
  // Cover-Up OFF: cut the existing ink out of the patch so the untouched
  // original shows through there — a pixel-level guarantee, not a request.
  if (inkMask && useInk) {
    resultCtx.globalCompositeOperation = "destination-out";
    resultCtx.drawImage(inkMask, 0, 0, inkMask.width, inkMask.height, 0, 0, width, height);
    resultCtx.globalCompositeOperation = "source-over";
  }

  return resultCanvas.toDataURL("image/png");
}

// ---------------------------------------------------------------------
// Crop-region generation (replaces sending the WHOLE base photo to Gemini
// for the common in-frame case). QA found two failure modes the skin-mask
// hard clip above doesn't touch: a design landing somewhere on the body
// entirely different from the drawn box ("drift"), and a design vanishing
// from the result altogether — both traced to the same root cause, that
// Gemini is handed the full photo and asked to return a full photo, with no
// guarantee its output stays framed/aligned the way the input was. A full
// body photo gives it a lot of room to reframe. Cropping tightly to just a
// padded region around the placement box before generation shrinks that
// room dramatically, so there's much less for its output to drift within —
// and it also fixes a THIRD issue: hard-clipping to the literal drawn box
// was chopping off parts of a design (e.g. a koi's tail) whenever Gemini's
// own rendering came out slightly larger than the box, for no good reason —
// the padding margin here gives that overscale somewhere legitimate to land
// (still confined to real skin by the mask, just not by an arbitrary
// rectangle edge). Only used for boxes that are fully in-frame — a box
// deliberately drawn off the edge of the photo (see extendsOffFrame in
// server.ts) needs the whole photo for that off-frame cropping behavior to
// keep working, so that case still uses the original full-photo flow.
// ---------------------------------------------------------------------

/** True when `box` was deliberately drawn (or dragged) so it runs off the
 * edge of the photo — see the matching check and comment in server.ts's
 * buildBlendPrompt, which this must stay consistent with. */
export function isBoxOffFrame(box: Box): boolean {
  return box.x < 0 || box.y < 0 || box.x + box.width > 100 || box.y + box.height > 100;
}

/**
 * Expands `box` by `marginFrac` of its own width/height on every side and
 * clamps to the photo's real 0-100% bounds — this padded region, not the
 * box itself, is what actually gets cropped out and sent to Gemini. Callers
 * must only use this for boxes where `isBoxOffFrame` is false.
 *
 * The per-side padding is ALSO capped at `maxMarginPct` percentage-points of
 * the photo. Without the cap, a large placement box got a proportionally huge
 * margin (50% of a 42%-wide box = 21pt per side), and for a chest box next to
 * an existing sleeve that margin swallowed the whole arm into the crop —
 * whereupon Gemini anchored the new design onto the existing arm ink instead
 * of the bare chest the box marked (QA measured this as a ~7pt placement
 * drift, design landing on the arm). Capping the margin keeps the crop tight
 * around the drawn region so Gemini's attention stays there, while still
 * leaving enough room for the small-design overscale case the margin exists
 * for. Small boxes are unaffected (their proportional margin is already below
 * the cap).
 */
export function computeCropRegion(box: Box, marginFrac = 0.5, maxMarginPct = 12): Box {
  const padX = Math.min(box.width * marginFrac, maxMarginPct);
  const padY = Math.min(box.height * marginFrac, maxMarginPct);
  const x = Math.max(0, box.x - padX);
  const y = Math.max(0, box.y - padY);
  const right = Math.min(100, box.x + box.width + padX);
  const bottom = Math.min(100, box.y + box.height + padY);
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Adjusts a crop region (percent coordinates) so its PIXEL aspect ratio is
 * exactly one of the ratios the image model can return, while still containing
 * `box` and staying inside the photo.
 *
 * Why: the model only returns a fixed set of aspect ratios, and the result is
 * later cover-fitted back onto the crop. When the crop's own ratio sits between
 * two supported ones, cover-fitting trims a slice off one axis — shifting and
 * rescaling the design relative to the box by a few percent of the frame. Sending
 * a crop that already has an exact supported ratio removes that mismatch at the
 * source, using real surrounding photo rather than padding bars.
 *
 * Tries the nearest ratios in order and returns the first that can be satisfied;
 * falls back to the unchanged region if none can (e.g. an extreme box).
 */
export function fitRegionToAspect(
  region: Box,
  box: Box,
  photoW: number,
  photoH: number
): { region: Box; aspectRatio: string } {
  const toPx = (b: Box) => ({ x: (b.x / 100) * photoW, y: (b.y / 100) * photoH, w: (b.width / 100) * photoW, h: (b.height / 100) * photoH });
  const R = toPx(region);
  const B = toPx(box);
  const cur = R.w / R.h;
  const ordered = [...ASPECT_CANDIDATES].sort((a, b) => Math.abs(Math.log(cur / a.value)) - Math.abs(Math.log(cur / b.value)));

  for (const cand of ordered.slice(0, 4)) {
    const r = cand.value;
    let w = R.w;
    let h = R.h;
    if (w / h < r) w = h * r; // too tall: widen
    else h = w / r; // too wide: heighten
    // Too big for the photo? Shrink (never below the box itself).
    if (w > photoW) { w = photoW; h = w / r; }
    if (h > photoH) { h = photoH; w = h * r; }
    if (w < B.w - 0.5 || h < B.h - 0.5) continue;
    // Centre on the original region, then slide just enough to keep the box inside and the crop on the photo.
    let x = R.x + R.w / 2 - w / 2;
    let y = R.y + R.h / 2 - h / 2;
    x = Math.min(Math.max(x, B.x + B.w - w), B.x);
    y = Math.min(Math.max(y, B.y + B.h - h), B.y);
    x = Math.min(Math.max(x, 0), photoW - w);
    y = Math.min(Math.max(y, 0), photoH - h);
    if (x > B.x + 0.5 || y > B.y + 0.5 || x + w < B.x + B.w - 0.5 || y + h < B.y + B.h - 0.5) continue;
    return {
      region: { x: (x / photoW) * 100, y: (y / photoH) * 100, width: (w / photoW) * 100, height: (h / photoH) * 100 },
      aspectRatio: cand.label
    };
  }
  return { region, aspectRatio: ordered[0].label };
}

/** Re-expresses `box` (in full-photo percentage coordinates) as percentage
 * coordinates relative to `cropRegion` instead — used once the base photo
 * has actually been cropped down to just cropRegion, so the corner-bracket
 * marker, the region tint, and the prompt's own box description all land in
 * the right place on the smaller cropped image rather than the original. */
export function boxRelativeTo(box: Box, cropRegion: Box): Box {
  return {
    x: ((box.x - cropRegion.x) / cropRegion.width) * 100,
    y: ((box.y - cropRegion.y) / cropRegion.height) * 100,
    width: (box.width / cropRegion.width) * 100,
    height: (box.height / cropRegion.height) * 100
  };
}

/**
 * The crop-region equivalent of `extractMaskedPatch` above: takes Gemini's
 * output for the CROPPED region (not the whole photo), cover-fits it onto a
 * canvas matching that crop's own real pixel size, hard-clips it to
 * `skinMask` alone (see the section comment above for why there's no
 * rectangular box edge in this clip), and pastes the result onto an
 * otherwise fully-transparent full-photo-sized canvas at the crop's own
 * location — same transparent-except-the-relevant-area contract as
 * extractMaskedPatch, so the result plugs into compositePatchWithAdjust
 * exactly the same way.
 */
export async function extractCropPatch(baseSrc: string, resultSrc: string, cropRegion: Box, skinMask: HTMLCanvasElement, localBox: Box, personMask?: HTMLCanvasElement, inkMask?: HTMLCanvasElement): Promise<string> {
  const [baseImg, resultImg] = await Promise.all([loadImage(baseSrc), loadImage(resultSrc)]);
  const baseWidth = baseImg.naturalWidth || baseImg.width;
  const baseHeight = baseImg.naturalHeight || baseImg.height;

  const cropX = (cropRegion.x / 100) * baseWidth;
  const cropY = (cropRegion.y / 100) * baseHeight;
  const cropW = (cropRegion.width / 100) * baseWidth;
  const cropH = (cropRegion.height / 100) * baseHeight;

  const pw = Math.max(1, Math.round(cropW));
  const ph = Math.max(1, Math.round(cropH));

  const patchCanvas = document.createElement("canvas");
  patchCanvas.width = pw;
  patchCanvas.height = ph;
  const patchCtx = patchCanvas.getContext("2d");
  if (!patchCtx) throw new Error("Could not get 2D canvas context.");
  drawImageCover(patchCtx, resultImg, pw, ph);

  // Same crop region of the untouched base, for the design-diff safety check.
  const baseCropCanvas = document.createElement("canvas");
  baseCropCanvas.width = pw;
  baseCropCanvas.height = ph;
  baseCropCanvas.getContext("2d")!.drawImage(baseImg, cropX, cropY, cropW, cropH, 0, 0, pw, ph);

  // Box-feather is the guaranteed clip; the skin mask is applied on top only
  // when it wouldn't erase the painted design (see measureSkinRetention). This
  // replaces the earlier skin-mask-ALONE clip, which had no box edge and could
  // be wiped entirely by a bad segmentation.
  const boxPx = {
    x: (localBox.x / 100) * pw,
    y: (localBox.y / 100) * ph,
    w: (localBox.width / 100) * pw,
    h: (localBox.height / 100) * ph
  };
  const retention = measureSkinRetention(baseCropCanvas, patchCanvas, skinMask, boxPx);
  const useSkin = retention >= SKIN_CLIP_MIN_RETENTION;
  console.log(
    `[QA-CLIP] crop skin retention of painted design: ${(retention * 100).toFixed(1)}% -> ${useSkin ? "APPLY skin clip" : "DROP skin clip (box-feather only)"}`
  );
  let usePerson = false;
  if (personMask) {
    const personRetention = measureSkinRetention(baseCropCanvas, patchCanvas, personMask, boxPx);
    usePerson = personRetention >= PERSON_CLIP_MIN_RETENTION;
    console.log(
      `[QA-CLIP] crop person retention of painted design: ${(personRetention * 100).toFixed(1)}% -> ${usePerson ? "APPLY person clip" : "DROP person clip (segmentation missed the body)"}`
    );
  }

  let useInk = false;
  if (inkMask) {
    useInk = measureSkinRetention(baseCropCanvas, patchCanvas, invertMaskAlpha(inkMask), boxPx) >= 1 - INK_CLIP_MAX_REMOVAL;
    console.log(`[QA-CLIP] existing-ink restore: ${useInk ? "APPLY" : "DROP (mask would erase nearly the whole design)"}`);
  }

  patchCtx.globalCompositeOperation = "destination-in";
  patchCtx.drawImage(buildFeatherMask(pw, ph, localBox), 0, 0);
  // Person silhouette hard clip — see the matching comment in extractMaskedPatch.
  if (personMask && usePerson) {
    patchCtx.drawImage(personMask, 0, 0, personMask.width, personMask.height, 0, 0, pw, ph);
  }
  if (useSkin) {
    patchCtx.drawImage(skinMask, 0, 0, skinMask.width, skinMask.height, 0, 0, pw, ph);
  }
  // Cover-Up OFF: restore the original wherever existing ink was (see extractMaskedPatch).
  if (inkMask && useInk) {
    patchCtx.globalCompositeOperation = "destination-out";
    patchCtx.drawImage(inkMask, 0, 0, inkMask.width, inkMask.height, 0, 0, pw, ph);
    patchCtx.globalCompositeOperation = "source-over";
  }

  const outCanvas = document.createElement("canvas");
  outCanvas.width = baseWidth;
  outCanvas.height = baseHeight;
  const outCtx = outCanvas.getContext("2d");
  if (!outCtx) throw new Error("Could not get 2D canvas context.");
  outCtx.drawImage(patchCanvas, cropX, cropY, cropW, cropH);

  return outCanvas.toDataURL("image/png");
}


// ---------------------------------------------------------------------
// Existing-ink detection.
//
// The generation model is TOLD (in prose) to leave existing tattoos untouched
// and to cover them in Cover-Up mode, and a before/after check asks another
// model whether it did. Nothing in the pixels enforced it, and the segmentation
// model can't help: it labels tattooed skin as skin. This finds the existing ink
// from the photo itself — pixels clearly darker than the surrounding skin (or
// distinctly blue/green, as aged ink goes), grouped into blobs so pores, hair
// and noise don't count — and is used two ways:
//   * Cover-Up OFF: the original pixels are restored wherever old ink was, so
//     it is guaranteed untouched whatever the model painted, and the "open
//     skin" tint shown to the model excludes it.
//   * Cover-Up ON: the ink's extent is compared with the placement box, so the
//     person can be told when the new design wouldn't fully cover the old one.
// It is a heuristic (it keys on darkness against the local skin tone), so every
// use is guarded: it declines to answer when the result looks implausible.
// ---------------------------------------------------------------------

export interface ExistingInk {
  /** Full-size canvas whose alpha marks existing ink (slightly dilated and feathered), or null when detection isn't trustworthy. */
  mask: HTMLCanvasElement | null;
  /** Bounds of the ink blobs that touch the placement box (percent of the photo), or null when there are none. */
  bbox: Box | null;
  /** True when a touching blob runs to the edge of the analysed neighbourhood, i.e. the tattoo continues beyond `bbox`. */
  extendsBeyondBbox: boolean;
  /** Fraction (0-1) of the placement box that is existing ink. */
  coverage: number;
  /** Why `mask` is null: nothing found, or the result looked implausible. */
  reason?: "none" | "unreliable";
}

// A pixel is ink when it is this much darker than the skin around it. Ink is
// typically well under half the skin's brightness; ordinary shadow and limb
// shading stay above ~0.65, so this sits between the two.
const INK_DARKNESS_RATIO = 0.62;
// Above this share of the placement box the "ink" is more likely a lighting
// problem, dark clothing/hair or very dark skin than a tattoo — don't trust it.
const INK_MAX_BOX_COVERAGE = 0.7;
// Blobs smaller than this fraction of the analysed area are noise (pores, hairs, specks).
const INK_MIN_BLOB_FRACTION = 0.0015;
// Mean luminance step across a blob's boundary (on the ~384px analysis image).
// Crisp ink edges are tens of levels; shadow gradients are a few.
const INK_MIN_EDGE_CONTRAST = 12;
// If restoring the old ink would erase more than this share of the newly
// painted design, the ink mask is almost certainly wrong — drop it.
const INK_CLIP_MAX_REMOVAL = 0.85;

export async function detectExistingInk(baseSrc: string, box: Box, skinMask?: HTMLCanvasElement): Promise<ExistingInk> {
  const img = await loadImage(baseSrc);
  const W = img.naturalWidth || img.width;
  const H = img.naturalHeight || img.height;
  const none = (reason: "none" | "unreliable", coverage = 0, bbox: Box | null = null, extendsBeyondBbox = false): ExistingInk => ({
    mask: null, bbox, extendsBeyondBbox, coverage, reason
  });

  // Neighbourhood: the box plus a margin, so skin tone has something to be judged against and blobs that run past the box are seen.
  const bx = (box.x / 100) * W, by = (box.y / 100) * H, bw = (box.width / 100) * W, bh = (box.height / 100) * H;
  const zx0 = Math.max(0, Math.floor(bx - bw * 0.25)), zy0 = Math.max(0, Math.floor(by - bh * 0.25));
  const zx1 = Math.min(W, Math.ceil(bx + bw * 1.25)), zy1 = Math.min(H, Math.ceil(by + bh * 1.25));
  const zw = zx1 - zx0, zh = zy1 - zy0;
  if (zw < 8 || zh < 8) return none("none");

  const k = Math.min(1, 384 / Math.max(zw, zh));
  const aw = Math.max(1, Math.round(zw * k)), ah = Math.max(1, Math.round(zh * k));
  const work = document.createElement("canvas");
  work.width = aw;
  work.height = ah;
  const wctx = work.getContext("2d", { willReadFrequently: true });
  if (!wctx) return none("none");
  wctx.drawImage(img, zx0, zy0, zw, zh, 0, 0, aw, ah);
  const px = wctx.getImageData(0, 0, aw, ah).data;
  const n = aw * ah;

  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];

  // Reference skin brightness: a high percentile (skin is lighter than ink) of
  // the pixels the segmenter calls skin, or of the whole neighbourhood when
  // that mask is missing or covers too little to rely on.
  let candidates: number[] = [];
  let maskSkin: Uint8Array | null = null;
  if (skinMask) {
    const mc = document.createElement("canvas");
    mc.width = aw;
    mc.height = ah;
    const mctx = mc.getContext("2d", { willReadFrequently: true });
    if (mctx) {
      mctx.drawImage(skinMask, (zx0 / W) * skinMask.width, (zy0 / H) * skinMask.height, (zw / W) * skinMask.width, (zh / H) * skinMask.height, 0, 0, aw, ah);
      const md = mctx.getImageData(0, 0, aw, ah).data;
      maskSkin = new Uint8Array(n);
      for (let i = 0; i < n; i++) if (md[i * 4 + 3] > 128) { candidates.push(lum[i]); maskSkin[i] = 1; }
    }
    if (candidates.length < n * 0.05) { candidates = []; maskSkin = null; }
  }
  if (!candidates.length) {
    // No usable skin mask: take the warm-toned pixels (skin of any depth is
    // red-dominant; a wall, floor or black ink is neutral or cool). Without
    // this, a bright background in the neighbourhood sets the "skin" level far
    // too high and the whole body reads as ink.
    for (let i = 0; i < n; i++) {
      const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
      if (r - b >= 25 && r >= g) candidates.push(lum[i]);
    }
    if (candidates.length < n * 0.08) candidates = Array.from(lum);
  }
  candidates.sort((a, b) => a - b);
  const refLum = candidates[Math.floor(candidates.length * 0.7)];
  if (refLum < 50) return none("unreliable"); // too dark to tell ink from skin

  let ink = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = px[i * 4], b = px[i * 4 + 2];
    const dark = lum[i] < refLum * INK_DARKNESS_RATIO;
    const bluish = b - r > 20 && lum[i] < refLum * 0.85; // faded black ink drifts blue/green
    if (dark || bluish) ink[i] = 1;
  }

  const dilate = (src: Uint8Array, rad: number): Uint8Array => {
    if (rad <= 0) return src;
    const tmp = new Uint8Array(n), out = new Uint8Array(n);
    for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) {
      let v = 0;
      for (let dx = -rad; dx <= rad && !v; dx++) { const xx = x + dx; if (xx >= 0 && xx < aw && src[y * aw + xx]) v = 1; }
      tmp[y * aw + x] = v;
    }
    for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) {
      let v = 0;
      for (let dy = -rad; dy <= rad && !v; dy++) { const yy = y + dy; if (yy >= 0 && yy < ah && tmp[yy * aw + x]) v = 1; }
      out[y * aw + x] = v;
    }
    return out;
  };
  // Bridge the gaps between linework (so a hatched/outlined tattoo reads as one blob), then drop small blobs.
  const joined = dilate(ink, Math.max(1, Math.round(aw * 0.012)));

  const label = new Int32Array(n);
  const blobs: { id: number; area: number; minX: number; minY: number; maxX: number; maxY: number; touchesEdge: boolean; inBox: boolean }[] = [];
  const bax0 = ((bx - zx0) / zw) * aw, bay0 = ((by - zy0) / zh) * ah;
  const bax1 = bax0 + (bw / zw) * aw, bay1 = bay0 + (bh / zh) * ah;
  const stack: number[] = [];
  for (let start = 0; start < n; start++) {
    if (!joined[start] || label[start]) continue;
    const id = blobs.length + 1;
    const blob = { id, area: 0, minX: aw, minY: ah, maxX: -1, maxY: -1, touchesEdge: false, inBox: false };
    stack.push(start);
    label[start] = id;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % aw, y = (i - x) / aw;
      blob.area++;
      if (x < blob.minX) blob.minX = x;
      if (x > blob.maxX) blob.maxX = x;
      if (y < blob.minY) blob.minY = y;
      if (y > blob.maxY) blob.maxY = y;
      if (x === 0 || y === 0 || x === aw - 1 || y === ah - 1) blob.touchesEdge = true;
      if (ink[i] && x >= bax0 && x < bax1 && y >= bay0 && y < bay1) blob.inBox = true;
      if (x > 0 && joined[i - 1] && !label[i - 1]) { label[i - 1] = id; stack.push(i - 1); }
      if (x < aw - 1 && joined[i + 1] && !label[i + 1]) { label[i + 1] = id; stack.push(i + 1); }
      if (y > 0 && joined[i - aw] && !label[i - aw]) { label[i - aw] = id; stack.push(i - aw); }
      if (y < ah - 1 && joined[i + aw] && !label[i + aw]) { label[i + aw] = id; stack.push(i + aw); }
    }
    blobs.push(blob);
  }
  // Judge blobs on their real ink pixels (the bridging dilation inflates a
  // handful of freckles into something blob-sized), and on edge sharpness: a
  // tattoo has crisp boundaries, whereas a shadow or lighting gradient crosses
  // the darkness threshold smoothly, so its "edge" is only a few levels per pixel.
  const inkArea = new Float32Array(blobs.length + 1);
  const edgeSum = new Float32Array(blobs.length + 1);
  const edgeCount = new Float32Array(blobs.length + 1);
  for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) {
    const i = y * aw + x;
    if (!ink[i]) continue;
    const id = label[i];
    inkArea[id]++;
    const nbrs = [x > 0 ? i - 1 : -1, x < aw - 1 ? i + 1 : -1, y > 0 ? i - aw : -1, y < ah - 1 ? i + aw : -1];
    for (const j of nbrs) {
      if (j < 0 || ink[j]) continue;
      // Only count a boundary against neighbouring SKIN. A limb's shadowed rim
      // against a bright wall is a sharp dark/light step too, but it isn't a
      // tattoo; against skin, only real ink makes a crisp edge.
      const skinLike = maskSkin ? maskSkin[j] === 1 : px[j * 4] - px[j * 4 + 2] >= 25 && px[j * 4] >= px[j * 4 + 1];
      if (!skinLike) continue;
      edgeSum[id] += Math.abs(lum[j] - lum[i]);
      edgeCount[id]++;
    }
  }
  const minArea = Math.max(4, n * INK_MIN_BLOB_FRACTION);
  const keep = new Set(
    blobs
      .filter((b) => inkArea[b.id] >= minArea && edgeCount[b.id] > 0 && edgeSum[b.id] / edgeCount[b.id] >= INK_MIN_EDGE_CONTRAST)
      .map((b) => b.id)
  );
  if (!keep.size) return none("none");

  // Final ink = the actually-dark pixels of the kept blobs (not the bridging dilation).
  const finalInk = new Uint8Array(n);
  let inBoxInk = 0, boxPixels = 0;
  for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) {
    const i = y * aw + x;
    const inside = x >= bax0 && x < bax1 && y >= bay0 && y < bay1;
    if (inside) boxPixels++;
    if (ink[i] && keep.has(label[i])) {
      finalInk[i] = 1;
      if (inside) inBoxInk++;
    }
  }
  const coverage = boxPixels ? inBoxInk / boxPixels : 0;

  const touching = blobs.filter((b) => keep.has(b.id) && b.inBox);
  let bbox: Box | null = null;
  let extendsBeyondBbox = false;
  if (touching.length) {
    const minX = Math.min(...touching.map((b) => b.minX)), maxX = Math.max(...touching.map((b) => b.maxX));
    const minY = Math.min(...touching.map((b) => b.minY)), maxY = Math.max(...touching.map((b) => b.maxY));
    const toPctX = (v: number) => ((zx0 + (v / aw) * zw) / W) * 100;
    const toPctY = (v: number) => ((zy0 + (v / ah) * zh) / H) * 100;
    bbox = { x: toPctX(minX), y: toPctY(minY), width: toPctX(maxX + 1) - toPctX(minX), height: toPctY(maxY + 1) - toPctY(minY) };
    extendsBeyondBbox = touching.some((b) => b.touchesEdge);
  }

  if (coverage > INK_MAX_BOX_COVERAGE) return none("unreliable", coverage, bbox, extendsBeyondBbox);
  if (!inBoxInk && !touching.length) return none("none", coverage, bbox, extendsBeyondBbox);

  // Mask for restoring the original: ink plus a small safety margin, feathered so no hard halo shows.
  const grown = dilate(finalInk, Math.max(1, Math.round(aw * 0.006)));
  const small = document.createElement("canvas");
  small.width = aw;
  small.height = ah;
  const sctx = small.getContext("2d");
  if (!sctx) return none("none", coverage, bbox, extendsBeyondBbox);
  const sd = sctx.createImageData(aw, ah);
  for (let i = 0; i < n; i++) {
    sd.data[i * 4] = sd.data[i * 4 + 1] = sd.data[i * 4 + 2] = 255;
    sd.data[i * 4 + 3] = grown[i] ? 255 : 0;
  }
  sctx.putImageData(sd, 0, 0);
  const mask = document.createElement("canvas");
  mask.width = W;
  mask.height = H;
  const mctx2 = mask.getContext("2d");
  if (!mctx2) return none("none", coverage, bbox, extendsBeyondBbox);
  mctx2.imageSmoothingEnabled = true;
  mctx2.filter = `blur(${Math.max(1, Math.round(Math.min(W, H) * 0.0015))}px)`;
  mctx2.drawImage(small, 0, 0, aw, ah, zx0, zy0, zw, zh);
  return { mask, bbox, extendsBeyondBbox, coverage };
}

/**
 * Smallest box with the same aspect ratio as `box` that contains `target` plus
 * `margin` percentage points on every side, kept inside the photo. Returns null
 * if it can't fit within the photo (the tattoo is too big for this box shape).
 * Used by the Cover-Up helper to offer "fit the box to the existing tattoo".
 */
export function boxToCover(box: Box, target: Box, margin = 3): Box | null {
  const tx0 = target.x - margin, ty0 = target.y - margin;
  const tx1 = target.x + target.width + margin, ty1 = target.y + target.height + margin;
  const aspect = box.width / box.height;
  let w = Math.max(tx1 - tx0, (ty1 - ty0) * aspect);
  let h = w / aspect;
  if (w > 100 || h > 100) return null;
  let x = (tx0 + tx1) / 2 - w / 2;
  let y = (ty0 + ty1) / 2 - h / 2;
  x = Math.min(Math.max(x, 0), 100 - w);
  y = Math.min(Math.max(y, 0), 100 - h);
  return { x, y, width: w, height: h };
}

/** True when `outer` fully contains `inner` (percent boxes), with `tolerance` points of slack. */
export function boxContains(outer: Box, inner: Box, tolerance = 0.5): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance &&
    inner.y + inner.height <= outer.y + outer.height + tolerance
  );
}

/**
 * Trims a design image down to its actual visible-artwork bounding box —
 * scanning out any near-white or fully-transparent margin baked into the
 * source file — and returns a tightly-cropped PNG.
 *
 * This replaces the old computeContainBox() approach. That function tried to
 * reconcile the user's drawn box with the design's own aspect ratio at
 * generation time, but it worked off the design file's raw pixel dimensions —
 * so a design that wasn't cropped tightly to its own artwork (the Portfolio
 * tab's own UI warns about this: "design cropped tightly to its own edges, no
 * extra padding") threw off every downstream calculation, since the "shape"
 * being reasoned about included dead space nothing was ever placed in. Worse,
 * the on-screen preview rendered that padding with mix-blend-mode:multiply,
 * which makes white pixels invisible — so the padding wasn't just mismeasured
 * server-side, it was actually invisible to the person placing the design,
 * making the resulting scale/position mismatch impossible to spot before
 * generating.
 *
 * Trimming once, right when a design is selected (see App.tsx), means the
 * placement box IS the design's real shape from then on — no separate
 * contain-fit derivation needed. Everything downstream (the burned-in marker,
 * the prompt's region description, the feather mask/final crop) can just use
 * the box directly.
 */
export async function trimToContent(src: string): Promise<string> {
  const img = await loadImage(src);
  const W = img.naturalWidth || img.width;
  const H = img.naturalHeight || img.height;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D canvas context.");
  ctx.drawImage(img, 0, 0, W, H);

  const { data } = ctx.getImageData(0, 0, W, H);

  // The "padding" colour is whatever the image's border is, not assumed white:
  // pale designs (whitework, pastels) sit very close to a white background, so
  // an absolute "near-white = padding" test discards the design itself and
  // leaves the placement box as the whole untrimmed square. Take the median
  // opaque border pixel as the background and keep anything that differs from
  // it by more than a small tolerance.
  const borderSamples: number[][] = [];
  const stepB = Math.max(1, Math.floor(Math.max(W, H) / 200));
  const pushBorder = (x: number, y: number) => {
    const idx = (y * W + x) * 4;
    if (data[idx + 3] >= 20) borderSamples.push([data[idx], data[idx + 1], data[idx + 2]]);
  };
  for (let x = 0; x < W; x += stepB) { pushBorder(x, 0); pushBorder(x, H - 1); }
  for (let y = 0; y < H; y += stepB) { pushBorder(0, y); pushBorder(W - 1, y); }
  const median = (vals: number[]) => vals.slice().sort((a, b) => a - b)[Math.floor(vals.length / 2)] ?? 255;
  const bg = borderSamples.length
    ? [median(borderSamples.map((v) => v[0])), median(borderSamples.map((v) => v[1])), median(borderSamples.map((v) => v[2]))]
    : [255, 255, 255];
  const CONTENT_TOLERANCE = 14; // summed per-channel difference from the background

  let minX = W;
  let maxX = -1;
  let minY = H;
  let maxY = -1;
  const step = 2; // a sampling grid is plenty for a bounding box and much faster than scanning every pixel
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      const idx = (y * W + x) * 4;
      const a = data[idx + 3];
      if (a < 20) continue; // fully transparent — not content
      const diff = Math.abs(data[idx] - bg[0]) + Math.abs(data[idx + 1] - bg[1]) + Math.abs(data[idx + 2] - bg[2]);
      if (diff <= CONTENT_TOLERANCE) continue; // matches the background — padding, not content
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  // Nothing found (blank/all-white/all-transparent file) — return the source
  // untouched rather than producing a zero-size crop.
  if (maxX < 0 || maxY < 0) return src;

  // Small margin so fine linework right at the detected edge doesn't get
  // clipped — the sampling grid above can miss the true edge by up to `step`
  // pixels.
  const pad = Math.max(4, Math.round(Math.min(W, H) * 0.01));
  const cropX = Math.max(0, minX - pad);
  const cropY = Math.max(0, minY - pad);
  const cropW = Math.min(W, maxX + pad) - cropX;
  const cropH = Math.min(H, maxY + pad) - cropY;

  // If the detected content already spans effectively the whole file (within
  // 2% per edge), skip the crop — this is the common case for designs that
  // are already tightly cropped, and avoids a pointless re-encode.
  const marginFrac = 0.02;
  const alreadyTight =
    cropX <= W * marginFrac &&
    cropY <= H * marginFrac &&
    cropX + cropW >= W * (1 - marginFrac) &&
    cropY + cropH >= H * (1 - marginFrac);
  if (alreadyTight) return src;

  const outCanvas = document.createElement("canvas");
  outCanvas.width = cropW;
  outCanvas.height = cropH;
  const outCtx = outCanvas.getContext("2d");
  if (!outCtx) throw new Error("Could not get 2D canvas context.");
  outCtx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
  return outCanvas.toDataURL("image/png");
}

/**
 * Burns a visible marker for the placement box directly onto the actual pixels
 * of a copy of the base photo, so the AI can SEE the target region instead of
 * only reading a text description of it (percentages parsed from prose are a
 * much weaker spatial signal than pixels the model can look at directly).
 *
 * Drawn as small corner brackets rather than a full continuous rectangle —
 * enough to unambiguously define the region, but not blanketing the target
 * area itself, which keeps the amount of marker-colored pixels the model has
 * to fully paint over/remove to a minimum. Uses a color (bright magenta) that
 * essentially never occurs naturally on skin or in tattoo ink, so it can't be
 * confused with real content.
 *
 * This is ONLY for what gets sent to the AI as a reference image — the
 * original, unmarked base photo is still what everything else (the final
 * masked composite, the Adjustments panel, etc.) is built from.
 */
export async function burnPlacementMarker(baseSrc: string, box: Box): Promise<string> {
  const baseImg = await loadImage(baseSrc);
  const width = baseImg.naturalWidth || baseImg.width;
  const height = baseImg.naturalHeight || baseImg.height;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D canvas context.");
  ctx.drawImage(baseImg, 0, 0, width, height);

  const boxX = (box.x / 100) * width;
  const boxY = (box.y / 100) * height;
  const boxW = (box.width / 100) * width;
  const boxH = (box.height / 100) * height;

  const armLen = Math.max(14, Math.min(boxW, boxH) * 0.22);
  const lineWidth = Math.max(3, Math.min(width, height) * 0.004);
  const color = "#ff00ea";

  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";

  const corners: Array<[number, number, number, number]> = [
    [boxX, boxY, 1, 1], // top-left: arms go right and down
    [boxX + boxW, boxY, -1, 1], // top-right: arms go left and down
    [boxX, boxY + boxH, 1, -1], // bottom-left: arms go right and up
    [boxX + boxW, boxY + boxH, -1, -1] // bottom-right: arms go left and up
  ];
  for (const [cx, cy, dx, dy] of corners) {
    ctx.beginPath();
    ctx.moveTo(cx, cy + dy * armLen);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + dx * armLen, cy);
    ctx.stroke();
  }

  // JPEG, not PNG — this only ever travels to the AI as a reference image,
  // never gets displayed or stored, so there's no reason to pay PNG's size
  // cost on a full-resolution photo.
  return canvas.toDataURL("image/jpeg", 0.92);
}

/**
 * Crops just the placement box out of a photo into its own standalone image,
 * converting the box's percentage coordinates to real pixels using the source
 * photo's actual dimensions (same conversion burnPlacementMarker uses).
 *
 * Used to hand the skin/ink detection pass (see /api/detect-skin-regions)
 * EXACTLY the region it needs to classify, instead of the full photo plus a
 * text description of where the region is — visual grounding for the
 * detection call itself, the same principle behind everything else here.
 */
export async function cropToBox(baseSrc: string, box: Box): Promise<string> {
  const img = await loadImage(baseSrc);
  const W = img.naturalWidth || img.width;
  const H = img.naturalHeight || img.height;
  const x = (box.x / 100) * W;
  const y = (box.y / 100) * H;
  const w = (box.width / 100) * W;
  const h = (box.height / 100) * H;

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D canvas context.");
  ctx.drawImage(img, x, y, w, h, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.9);
}

/**
 * Measures where the design ACTUALLY landed in the final composite, by diffing
 * it against the pre-generation base and returning the bounding box of every
 * pixel that changed, in the same 0-100% coordinate space as the placement box.
 * Because the composite only ever alters pixels inside the (clipped) placement
 * patch, the changed-pixel bounds are the design's real footprint — so callers
 * can log intended-box vs measured-footprint and see any preview→final drift or
 * scale mismatch directly, rather than inferring it from screenshots. Returns
 * null when nothing changed (a full vanish), which is itself diagnostic.
 */
export async function measureDesignBBox(baseSrc: string, finalSrc: string): Promise<Box | null> {
  const [baseImg, finalImg] = await Promise.all([loadImage(baseSrc), loadImage(finalSrc)]);
  const width = baseImg.naturalWidth || baseImg.width;
  const height = baseImg.naturalHeight || baseImg.height;

  const bc = document.createElement("canvas");
  bc.width = width;
  bc.height = height;
  const bctx = bc.getContext("2d");
  const fc = document.createElement("canvas");
  fc.width = width;
  fc.height = height;
  const fctx = fc.getContext("2d");
  if (!bctx || !fctx) return null;
  bctx.drawImage(baseImg, 0, 0, width, height);
  fctx.drawImage(finalImg, 0, 0, width, height);

  const bd = bctx.getImageData(0, 0, width, height).data;
  const fd = fctx.getImageData(0, 0, width, height).data;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let changed = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const diff = Math.abs(bd[i] - fd[i]) + Math.abs(bd[i + 1] - fd[i + 1]) + Math.abs(bd[i + 2] - fd[i + 2]);
      if (diff > 90) {
        changed++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return {
    x: (minX / width) * 100,
    y: (minY / height) * 100,
    width: ((maxX - minX + 1) / width) * 100,
    height: ((maxY - minY + 1) / height) * 100
  };
}

/**
 * Burns a translucent tint, sourced directly from the real per-pixel
 * segmentation mask and clipped to that mask's own boundary:
 *
 * - Cover-Up OFF: GREEN over confirmed skin (body-skin/face-skin) inside the
 *   placement box — the only area the new design may be placed.
 * - Cover-Up ON: RED over confirmed NON-skin (background, hair, clothing,
 *   accessories) inside the placement box — the only area that stays
 *   off-limits when painting over existing ink is otherwise allowed.
 *
 * Using the SAME mask here and in extractMaskedPatch's hard clip means what
 * the blend model is shown as the safe/unsafe area is exactly what gets
 * physically enforced afterward — no mismatch between the hint and the
 * guarantee.
 */
export async function burnSkinMaskFromSegmentation(baseSrc: string, box: Box, skinMask: HTMLCanvasElement, coverUp: boolean, inkMask?: HTMLCanvasElement): Promise<string> {
  const baseImg = await loadImage(baseSrc);
  const width = baseImg.naturalWidth || baseImg.width;
  const height = baseImg.naturalHeight || baseImg.height;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D canvas context.");
  ctx.drawImage(baseImg, 0, 0, width, height);

  const boxX = (box.x / 100) * width;
  const boxY = (box.y / 100) * height;
  const boxW = (box.width / 100) * width;
  const boxH = (box.height / 100) * height;

  const overlay = document.createElement("canvas");
  overlay.width = width;
  overlay.height = height;
  const octx = overlay.getContext("2d");
  if (!octx) throw new Error("Could not get 2D canvas context.");
  octx.fillStyle = coverUp ? "rgba(230, 45, 45, 0.35)" : "rgba(40, 220, 90, 0.35)";
  octx.fillRect(boxX, boxY, boxW, boxH);

  octx.globalCompositeOperation = "destination-in";
  octx.drawImage(coverUp ? invertMaskAlpha(skinMask) : skinMask, 0, 0, skinMask.width, skinMask.height, 0, 0, width, height);
  // "Open skin" must not include existing ink, which the segmenter calls skin.
  if (!coverUp && inkMask) {
    octx.globalCompositeOperation = "destination-out";
    octx.drawImage(inkMask, 0, 0, inkMask.width, inkMask.height, 0, 0, width, height);
  }

  ctx.drawImage(overlay, 0, 0);
  return canvas.toDataURL("image/jpeg", 0.92);
}

/**
 * Composites a masked patch (from `extractMaskedPatch`) onto its base photo,
 * with a live, purely client-side transform — scale/rotate/position/opacity/
 * saturation — pivoted around the placement box's own center so nudging feels
 * natural. This is what powers the post-generation Adjustments panel: no API
 * call, instant re-render on every slider move.
 */
export async function compositePatchWithAdjust(
  baseSrc: string,
  patchSrc: string,
  box: Box,
  adjust: { scale: number; rotate: number; opacity: number; saturation: number; offsetX: number; offsetY: number }
): Promise<string> {
  const [baseImg, patchImg] = await Promise.all([loadImage(baseSrc), loadImage(patchSrc)]);
  const width = baseImg.naturalWidth || baseImg.width;
  const height = baseImg.naturalHeight || baseImg.height;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D canvas context.");
  ctx.drawImage(baseImg, 0, 0, width, height);

  const cx = ((box.x + box.width / 2) / 100) * width;
  const cy = ((box.y + box.height / 2) / 100) * height;

  ctx.save();
  ctx.translate(cx + (adjust.offsetX / 100) * width, cy + (adjust.offsetY / 100) * height);
  ctx.rotate((adjust.rotate * Math.PI) / 180);
  ctx.scale(adjust.scale / 100, adjust.scale / 100);
  ctx.translate(-cx, -cy);
  ctx.globalAlpha = Math.max(0, Math.min(1, adjust.opacity / 100));
  ctx.filter = `saturate(${adjust.saturation}%)`;
  ctx.drawImage(patchImg, 0, 0, width, height);
  ctx.restore();

  // JPEG, not PNG: this is a flattened photograph with no transparency need.
  // PNG (lossless) on a full-resolution photo can be 5-10x larger than JPEG —
  // that bloat was the real cause of "project too large to save" even with
  // just one photo, since this src is stored per-angle and duplicated across
  // history snapshots.
  return canvas.toDataURL("image/jpeg", 0.88);
}

/**
 * Pre-transforms the isolated (flat, white-background) design graphic itself —
 * rotation, opacity, saturation — BEFORE it's sent to the AI for blending.
 * This is the key move that avoids the "rotating a photo patch" bug: rotation
 * only ever touches a clean flat graphic with no photo content, so there's
 * nothing to drag or warp. Canvas expands to fit the rotated bounds so
 * nothing gets clipped, and re-fills white to match Stage A's convention.
 */
export async function transformDesignGraphic(
  designSrc: string,
  opts: { rotate: number; opacity: number; saturation: number }
): Promise<string> {
  const img = await loadImage(designSrc);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const rad = (opts.rotate * Math.PI) / 180;
  const newW = Math.max(1, Math.ceil(Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad))));
  const newH = Math.max(1, Math.ceil(Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad))));

  const canvas = document.createElement("canvas");
  canvas.width = newW;
  canvas.height = newH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D canvas context.");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, newW, newH);

  ctx.save();
  ctx.translate(newW / 2, newH / 2);
  ctx.rotate(rad);
  ctx.globalAlpha = Math.max(0, Math.min(1, opts.opacity / 100));
  ctx.filter = `saturate(${opts.saturation}%)`;
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  ctx.restore();

  return canvas.toDataURL("image/png");
}

/** Output aspect ratios the image model supports (server.ts's allowlist mirrors this). */
export const ASPECT_CANDIDATES: { label: string; value: number }[] = [
  { label: "1:1", value: 1 },
  { label: "1:4", value: 1 / 4 },
  { label: "1:8", value: 1 / 8 },
  { label: "2:3", value: 2 / 3 },
  { label: "3:2", value: 3 / 2 },
  { label: "3:4", value: 3 / 4 },
  { label: "4:1", value: 4 / 1 },
  { label: "4:3", value: 4 / 3 },
  { label: "4:5", value: 4 / 5 },
  { label: "5:4", value: 5 / 4 },
  { label: "8:1", value: 8 / 1 },
  { label: "9:16", value: 9 / 16 },
  { label: "16:9", value: 16 / 9 },
  { label: "21:9", value: 21 / 9 }
];

/** Get an image's real pixel dimensions and closest supported Gemini aspect-ratio label. */
export async function getImageOrientation(src: string): Promise<{ width: number; height: number; aspectRatio: string }> {
  const img = await loadImage(src);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  const ratio = width / height;

  // Matches the full 14-ratio set Gemini 3.1 Flash (Lite) Image supports as of
  // the July 2026 release (server.ts's /api/composite-photorealistic allowlist
  // mirrors this same list) — wider than the original 5, so an arbitrary phone
  // photo's real proportions land closer to one of these before drawImageCover()
  // has to crop the rest away.
  const candidates = ASPECT_CANDIDATES;
  let best = candidates[0];
  let bestDiff = Infinity;
  for (const c of candidates) {
    const diff = Math.abs(Math.log(ratio) - Math.log(c.value));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = c;
    }
  }
  return { width, height, aspectRatio: best.label };
}
