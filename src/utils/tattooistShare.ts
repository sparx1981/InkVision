import QRCode from "qrcode";
import JSZip from "jszip";
import { SavedProject } from "../types";
import { generateTattooStencil } from "./stencil";

/** Generate a scannable QR code (as a data URL image) encoding the given URL. */
export async function generateShareQrCode(url: string): Promise<string> {
  return QRCode.toDataURL(url, {
    width: 240,
    margin: 1,
    color: { dark: "#0f0e0d", light: "#ffffff" }
  });
}

/** Build the shareable tattooist link for a saved project code. */
export function buildTattooistShareUrl(code: string): string {
  const base = `${window.location.origin}${window.location.pathname}`;
  return `${base}?share=${encodeURIComponent(code)}`;
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return res.blob();
}

/** Bundle a handful of named images into one ZIP download — used by Artist Template's "Download All". */
export async function downloadImagesZip(files: { name: string; dataUrl: string }[], zipName: string) {
  const zip = new JSZip();
  for (const f of files) {
    try {
      const blob = await dataUrlToBlob(f.dataUrl);
      zip.file(f.name, blob);
    } catch {
      /* skip any file that fails to fetch rather than aborting the whole export */
    }
  }
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = zipName;
  link.click();
  URL.revokeObjectURL(url);
}

const safeName = (name: string) => name.replace(/[^a-z0-9\-]+/gi, "-");

/**
 * Bundle everything a tattooist needs — original photos, the isolated design
 * + printable stencil, and every finalized angle preview — into one ZIP.
 */
export async function downloadProjectZip(project: SavedProject) {
  const zip = new JSZip();

  const photosFolder = zip.folder("original-photos");
  for (const photo of project.basePhotos) {
    try {
      const blob = await dataUrlToBlob(photo.src);
      photosFolder?.file(`${safeName(photo.name)}.png`, blob);
    } catch {
      // skip any photo that fails to fetch rather than aborting the whole export
    }
  }

  const templatesFolder = zip.folder("templates");
  const stencilSource = project.isolatedDesignSrc || project.design?.src || null;
  if (project.isolatedDesignSrc) {
    try {
      const blob = await dataUrlToBlob(project.isolatedDesignSrc);
      templatesFolder?.file("isolated-design.png", blob);
    } catch {
      /* skip */
    }
  }
  if (project.design?.src) {
    try {
      const blob = await dataUrlToBlob(project.design.src);
      templatesFolder?.file("reference-design.png", blob);
    } catch {
      /* skip */
    }
  }
  if (stencilSource) {
    try {
      const stencilDataUrl = await generateTattooStencil(stencilSource, 25);
      const blob = await dataUrlToBlob(stencilDataUrl);
      templatesFolder?.file("stencil.png", blob);
    } catch {
      /* stencil generation is best-effort — skip if it fails */
    }
  }

  const previewsFolder = zip.folder("final-previews");
  if (project.angleResults) {
    for (const [photoId, result] of Object.entries(project.angleResults)) {
      const photo = project.basePhotos.find((p) => p.id === photoId);
      try {
        const blob = await dataUrlToBlob(result.src);
        previewsFolder?.file(`${safeName(photo?.name || photoId)}-final.png`, blob);
      } catch {
        /* skip */
      }
    }
  }
  if (project.design?.src && (!project.angleResults || Object.keys(project.angleResults).length === 0)) {
    // Upload/Portfolio-mode projects don't have angleResults — include the design as the final preview reference.
    try {
      const blob = await dataUrlToBlob(project.design.src);
      previewsFolder?.file("final-design.png", blob);
    } catch {
      /* skip */
    }
  }

  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `inkvision-project-${project.code || "export"}.zip`;
  link.click();
  URL.revokeObjectURL(url);
}
