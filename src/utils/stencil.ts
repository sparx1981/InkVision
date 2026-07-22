/**
 * Generates a high-contrast, black-and-white line art tattoo stencil
 * from any image source (PNG, JPG, base64 data URLs).
 * It uses a custom edge-detection and thresholding filter on a 2D canvas.
 */
export function generateTattooStencil(
  imgSrc: string,
  threshold: number = 25,
  invert: boolean = false
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Could not get 2D context"));
        return;
      }

      // Maintain high-resolution stencil sizing (e.g. max 1200px)
      const maxDim = 1200;
      let width = img.width;
      let height = img.height;
      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }

      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(img, 0, 0, width, height);

      try {
        const imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;
        const grayscale = new Uint8ClampedArray(width * height);

        // 1. Convert to grayscale
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          // Standard luma formula
          grayscale[i / 4] = 0.299 * r + 0.587 * g + 0.114 * b;
        }

        // 2. Simple high-pass differential edge detection (compares adjacent pixels)
        const stencilData = ctx.createImageData(width, height);
        const stencilPixels = stencilData.data;

        for (let y = 1; y < height - 1; y++) {
          for (let x = 1; x < width - 1; x++) {
            const idx = y * width + x;

            // Pixel values around current pixel
            const current = grayscale[idx];
            const right = grayscale[idx + 1];
            const bottom = grayscale[idx + width];

            // Edge intensity as absolute difference
            const diffX = Math.abs(current - right);
            const diffY = Math.abs(current - bottom);
            const edgeVal = diffX + diffY;

            // Apply threshold
            const isEdge = edgeVal > threshold;

            const pixelIdx = idx * 4;
            if (isEdge) {
              // Paint stencil line (Pure Black)
              stencilPixels[pixelIdx] = 0;
              stencilPixels[pixelIdx + 1] = 0;
              stencilPixels[pixelIdx + 2] = 0;
              stencilPixels[pixelIdx + 3] = 255; // fully visible line
            } else {
              // Paint background (White or Transparent)
              // We'll make it White for a printable stencil sheet
              stencilPixels[pixelIdx] = 255;
              stencilPixels[pixelIdx + 1] = 255;
              stencilPixels[pixelIdx + 2] = 255;
              stencilPixels[pixelIdx + 3] = 255;
            }
          }
        }

        // Apply edge styling to margins
        for (let x = 0; x < width; x++) {
          const topIdx = x * 4;
          const btmIdx = ((height - 1) * width + x) * 4;
          stencilPixels[topIdx] = stencilPixels[topIdx + 1] = stencilPixels[topIdx + 2] = 255;
          stencilPixels[topIdx + 3] = 255;
          stencilPixels[btmIdx] = stencilPixels[btmIdx + 1] = stencilPixels[btmIdx + 2] = 255;
          stencilPixels[btmIdx + 3] = 255;
        }
        for (let y = 0; y < height; y++) {
          const lftIdx = (y * width) * 4;
          const rgtIdx = (y * width + (width - 1)) * 4;
          stencilPixels[lftIdx] = stencilPixels[lftIdx + 1] = stencilPixels[lftIdx + 2] = 255;
          stencilPixels[lftIdx + 3] = 255;
          stencilPixels[rgtIdx] = stencilPixels[rgtIdx + 1] = stencilPixels[rgtIdx + 2] = 255;
          stencilPixels[rgtIdx + 3] = 255;
        }

        ctx.putImageData(stencilData, 0, 0);
        resolve(canvas.toDataURL("image/png"));
      } catch (err) {
        reject(err);
      }
    };

    img.onerror = (err) => reject(err);
    img.src = imgSrc;
  });
}
