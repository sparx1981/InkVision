export interface BasePhoto {
  id: string;
  src: string;
  name: string;
}

export type DesignSourceMode = "upload" | "prompt" | "portfolio";

/** A shared, community-visible generated design that any user can browse and reuse. */
export interface PortfolioItem {
  id: string;
  imageUrl: string;
  name: string;
  likes: number;
  createdAt: string;
}

/**
 * "overlay": a cutout/reference design placed in a fixed box on the base photo
 * (manual Scale/Rotate/Opacity/Saturation adjustments apply). Used by both the
 * "Upload Image" and "Portfolio" tabs — "Generate from Prompt" uses AngleResult instead.
 */
export type DesignRenderMode = "overlay";

/** The active manually-placed reference design ("Upload Image" / "Portfolio" tabs). */
export interface TattooDesign {
  src: string | null;
  name: string;
  sourceMode: DesignSourceMode;
  renderMode: DesignRenderMode;
}

/** Result of the Phase 1 "analyze my tattoo" step. */
export interface TattooAnalysis {
  bodyPart: string;
  theme: string;
  description: string;
  // Only meaningful when more than one base photo was analyzed together —
  // flags when the uploaded photos don't actually look like different angles
  // of the same body part (e.g. an arm, a leg, and a chest), since the same
  // design gets applied to every angle as-is.
  anglesConsistent?: boolean;
  anglesNote?: string;
}

export type ConfirmChoice = "A" | "B" | "C" | "D";

/** Placement/rendering adjustments for the active design (Step 04). Only used in "overlay" mode. */
export interface DesignAdjust {
  scale: number; // 50-150 (%)
  rotate: number; // -45 to 45 (deg)
  opacity: number; // 20-100 (%)
  saturation: number; // 0-100 (%)
  offsetX: number; // -30 to 30 (percentage points, horizontal position nudge)
  offsetY: number; // -30 to 30 (percentage points, vertical position nudge)
}

/** A user-drawn (or AI-suggested, user-corrected) rectangle marking where a tattoo goes. */
export interface PlacementBox {
  x: number; // left %, 0-100
  y: number; // top %, 0-100
  width: number; // %
  height: number; // %
}

/**
 * The final baked "after" state for one base photo/angle in the
 * Generate-from-Prompt flow. Adjustments (scale/rotate/position/opacity/
 * saturation) happen BEFORE this is generated, on a separate flat design
 * layer — see `draftAdjust` in App.tsx — so this is just the flattened,
 * masked result of that commit. To change it, use Reposition (which goes
 * back to the adjustable pre-commit layer) rather than nudging this directly.
 */
export interface AngleResult {
  placementBox: PlacementBox;
  src: string;
  /** The accumulated image this round's design was applied on top of — used to redo the blend if the box changes (reposition). */
  baseSrcForThisRound: string;
  /** Set when the post-generation verification pass (see /api/verify-tattoo-result) still couldn't confirm a clean, fully-on-skin result after a retry — surfaced to the user as a non-blocking heads-up rather than silently accepted. */
  warning?: string;
}

/** A snapshot pushed to History each time a generation completes. */
export interface HistoryEntry {
  id: string;
  label: string;
  thumbnailSrc: string | null;
  kind: DesignSourceMode;
  coverUp: boolean;
  sliderX: number;
  basePhotoId: string | null;

  // "upload" tab payload
  design?: TattooDesign;
  adjust?: DesignAdjust;

  // "prompt" tab payload
  isolatedDesignSrc?: string;
  angleResults?: Record<string, AngleResult>;
}

export interface SavedProject {
  code?: string;
  name: string;
  basePhotos: BasePhoto[];
  activePhotoId: string | null;
  coverUp: boolean;
  sliderX: number;
  history: HistoryEntry[];

  // "upload" tab state
  design: TattooDesign;
  adjust: DesignAdjust;

  // "prompt" tab state
  isolatedDesignSrc?: string | null;
  angleResults?: Record<string, AngleResult>;

  createdAt?: string;
  updatedAt?: string;
}
