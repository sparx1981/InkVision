// Client-side handling of user-supplied images: validate, decode, normalise
// orientation, and downscale. Phone photos are routinely 12MP+ (5-10MB as
// JPEG, 15MB+ as a base64 data URL) — sending those untouched to the server
// blows through request-size limits on serverless hosts and gains nothing,
// since the image model downsamples its input anyway.

/** Longest edge kept for an uploaded body photo. Plenty for placement + display. */
export const MAX_PHOTO_EDGE = 2560;
/** Longest edge kept for an uploaded reference design. */
export const MAX_DESIGN_EDGE = 2048;
/** Reject absurdly large source files before even trying to decode them. */
export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

export class ImageUploadError extends Error {}

function decode(blobUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new ImageUploadError("That file couldn't be opened as an image. Please use a JPG, PNG or WebP photo."));
    img.src = blobUrl;
  });
}

/** Pure sizing helper: scale (w,h) down so the longest edge is at most `maxEdge`; never upscales. */
export function fitWithin(w: number, h: number, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(w, h);
  if (longest <= maxEdge) return { width: w, height: h };
  const k = maxEdge / longest;
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/**
 * Validates and decodes `file`, bakes in its EXIF orientation (by drawing it
 * through a canvas), downsizes to `maxEdge`, and returns a data URL.
 * Photos become JPEG; designs keep PNG so transparency survives.
 */
export async function readImageFile(file: File, opts: { maxEdge: number; keepAlpha?: boolean }): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new ImageUploadError("That file isn't an image. Please choose a JPG, PNG or WebP photo.");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new ImageUploadError(`That image is ${(file.size / 1024 / 1024).toFixed(0)}MB — please choose one under ${MAX_UPLOAD_BYTES / 1024 / 1024}MB.`);
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await decode(url);
    const sw = img.naturalWidth || img.width;
    const sh = img.naturalHeight || img.height;
    if (!sw || !sh) throw new ImageUploadError("That image appears to be empty.");
    const { width, height } = fitWithin(sw, sh, opts.maxEdge);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new ImageUploadError("Your browser couldn't process that image.");
    const asPng = !!opts.keepAlpha && (file.type === "image/png" || file.type === "image/webp" || file.type === "image/gif");
    if (!asPng) {
      ctx.fillStyle = "#ffffff"; // JPEG has no alpha — flatten onto white
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(img, 0, 0, width, height);
    return asPng ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.92);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Re-encodes an existing image data URL at a smaller size for sending to the
 * AI (analysis, reference photo, blend input). Keeps aspect ratio; returns the
 * source untouched when it is already small enough. Output is JPEG.
 */
export async function downscaleForUpload(src: string, maxEdge: number, quality = 0.9): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = src;
  });
  const sw = img.naturalWidth || img.width;
  const sh = img.naturalHeight || img.height;
  const { width, height } = fitWithin(sw, sh, maxEdge);
  if (width === sw && height === sh && src.startsWith("data:image/jpeg")) return src;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return src;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", quality);
}
