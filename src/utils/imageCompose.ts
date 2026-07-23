import { FilesetResolver, ImageSegmenter } from "@mediapipe/tasks-vision";

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
const SEG_CATEGORY_BODY_SKIN = 2;
const SEG_CATEGORY_FACE_SKIN = 3;

let segmenterPromise: Promise<ImageSegmenter> | null = null;

/** Lazily creates and caches a single ImageSegmenter instance for the whole
 * session — the WASM runtime + model download only ever happens once. */
function getSegmenter(): Promise<ImageSegmenter> {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
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
  }
  return segmenterPromise;
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
export async function getSkinSegmentationMask(baseSrc: string): Promise<HTMLCanvasElement> {
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

  const smallCanvas = document.createElement("canvas");
  smallCanvas.width = mw;
  smallCanvas.height = mh;
  const smallCtx = smallCanvas.getContext("2d");
  if (!smallCtx) throw new Error("Could not get 2D canvas context.");
  const imageData = smallCtx.createImageData(mw, mh);
  for (let i = 0; i < maskData.length; i++) {
    const category = maskData[i];
    const isSkin = category === SEG_CATEGORY_BODY_SKIN || category === SEG_CATEGORY_FACE_SKIN;
    // RGB is irrelevant (destination-in only reads alpha) — always white so
    // this is trivially inspectable/debuggable if ever drawn directly.
    imageData.data[i * 4] = 255;
    imageData.data[i * 4 + 1] = 255;
    imageData.data[i * 4 + 2] = 255;
    imageData.data[i * 4 + 3] = isSkin ? 255 : 0;
  }
  smallCtx.putImageData(imageData, 0, 0);

  // ImageSegmenterResult.close() frees BOTH the category mask and any
  // confidence masks in one call — calling categoryMask.close() separately
  // as well would double-free the same underlying resource.
  result.close();

  return blurToSize(smallCanvas, mw, mh, width, height);
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
export async function extractMaskedPatch(baseSrc: string, resultSrc: string, box: Box, skinMask?: HTMLCanvasElement): Promise<string> {
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
  if (skinMask) {
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
    const retention = measureSkinRetention(baseCanvas, resultCanvas, skinMask, boxPx);
    useSkin = retention >= SKIN_CLIP_MIN_RETENTION;
    console.log(
      `[QA-CLIP] full-photo skin retention of painted design: ${(retention * 100).toFixed(1)}% -> ${useSkin ? "APPLY skin clip" : "DROP skin clip (box-feather only)"}`
    );
  }

  resultCtx.globalCompositeOperation = "destination-in";
  resultCtx.drawImage(buildFeatherMask(width, height, box), 0, 0);
  if (useSkin && skinMask) {
    resultCtx.drawImage(skinMask, 0, 0, skinMask.width, skinMask.height, 0, 0, width, height);
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
 */
export function computeCropRegion(box: Box, marginFrac = 0.5): Box {
  const padX = box.width * marginFrac;
  const padY = box.height * marginFrac;
  const x = Math.max(0, box.x - padX);
  const y = Math.max(0, box.y - padY);
  const right = Math.min(100, box.x + box.width + padX);
  const bottom = Math.min(100, box.y + box.height + padY);
  return { x, y, width: right - x, height: bottom - y };
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
export async function extractCropPatch(baseSrc: string, resultSrc: string, cropRegion: Box, skinMask: HTMLCanvasElement, localBox: Box): Promise<string> {
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

  patchCtx.globalCompositeOperation = "destination-in";
  patchCtx.drawImage(buildFeatherMask(pw, ph, localBox), 0, 0);
  if (useSkin) {
    patchCtx.drawImage(skinMask, 0, 0, skinMask.width, skinMask.height, 0, 0, pw, ph);
  }

  const outCanvas = document.createElement("canvas");
  outCanvas.width = baseWidth;
  outCanvas.height = baseHeight;
  const outCtx = outCanvas.getContext("2d");
  if (!outCtx) throw new Error("Could not get 2D canvas context.");
  outCtx.drawImage(patchCanvas, cropX, cropY, cropW, cropH);

  return outCanvas.toDataURL("image/png");
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
      const brightness = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
      if (brightness >= 235) continue; // near-white — treated as padding, not content
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
 * Burns a subtle translucent tint directly onto a copy of the base photo's
 * pixels, covering cells of a row-major `rows` x `cols` grid over `box` that
 * were classified by the detection pass as either "skin" or "background" (see
 * /api/detect-skin-regions, which now classifies four labels: skin, ink,
 * mixed, background) — which cells get tinted, and what the tint means,
 * depends on Cover-Up mode:
 *
 * - Cover-Up OFF: GREEN marks cells classified "skin" — confirmed open,
 *   untattooed skin, the only safe placement area. "ink", "mixed", and
 *   "background" cells are all left untinted/off-limits.
 * - Cover-Up ON: RED marks cells classified "background" — confirmed to NOT
 *   be part of the person's body at all (wall, furniture, clothing, etc).
 *   Painting over existing ink is the whole point of Cover-Up mode, so "skin"
 *   and "ink" cells are both fair game and stay untinted; only true
 *   background is excluded.
 *
 * This is the visual-grounding counterpart to burnPlacementMarker's corner
 * brackets: instead of asking the blend model to infer skin-vs-ink-vs-
 * background from the photo through text alone, it gets an actual measured,
 * burned-in signal. Previously this only ran for Cover-Up-off, which left
 * Cover-Up-on generations with no grounding at all about where the body
 * actually ends — a likely cause of designs rendering "floating" over
 * background near the edge of a placement box drawn close to the limb's
 * silhouette.
 */
export async function burnSkinMask(baseSrc: string, box: Box, cells: string[], rows: number, cols: number, coverUp: boolean): Promise<string> {
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
  const cellW = boxW / cols;
  const cellH = boxH / rows;

  const targetLabel = coverUp ? "background" : "skin";
  ctx.fillStyle = coverUp ? "rgba(230, 45, 45, 0.35)" : "rgba(40, 220, 90, 0.35)";
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (cells[r * cols + c] !== targetLabel) continue;
      ctx.fillRect(boxX + c * cellW, boxY + r * cellH, cellW, cellH);
    }
  }

  return canvas.toDataURL("image/jpeg", 0.92);
}

/**
 * Pixel-precise replacement for `burnSkinMask` above (kept, but no longer
 * called — see getSkinSegmentationMask's comment for why). Burns the same
 * kind of translucent tint, but sourced directly from the real per-pixel
 * segmentation mask instead of a coarse Gemini-graded grid, and clipped to
 * that mask's own boundary rather than filling whole grid cells:
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
export async function burnSkinMaskFromSegmentation(baseSrc: string, box: Box, skinMask: HTMLCanvasElement, coverUp: boolean): Promise<string> {
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
  octx.drawImage(coverUp ? invertMaskAlpha(skinMask) : skinMask, 0, 0);

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
  const candidates: { label: string; value: number }[] = [
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
