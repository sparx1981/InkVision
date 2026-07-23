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
export async function extractMaskedPatch(baseSrc: string, resultSrc: string, box: Box): Promise<string> {
  const [baseImg, resultImg] = await Promise.all([loadImage(baseSrc), loadImage(resultSrc)]);
  const width = baseImg.naturalWidth || baseImg.width;
  const height = baseImg.naturalHeight || baseImg.height;

  const resultCanvas = document.createElement("canvas");
  resultCanvas.width = width;
  resultCanvas.height = height;
  const resultCtx = resultCanvas.getContext("2d");
  if (!resultCtx) throw new Error("Could not get 2D canvas context.");
  drawImageCover(resultCtx, resultImg, width, height);
  resultCtx.globalCompositeOperation = "destination-in";
  resultCtx.drawImage(buildFeatherMask(width, height, box), 0, 0);

  return resultCanvas.toDataURL("image/png");
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
