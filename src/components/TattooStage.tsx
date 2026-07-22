import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle, Sparkles } from "lucide-react";
import { AngleResult, BasePhoto, DesignAdjust, DesignSourceMode, HistoryEntry, PlacementBox, TattooDesign } from "../types";
import PlacementBoxEditor from "./PlacementBoxEditor";

interface TattooStageProps {
  basePhoto: BasePhoto | null;
  basePhotos: BasePhoto[];
  onSelectBasePhoto: (id: string) => void;
  placedPhotoIds: Record<string, boolean>;
  confirmedPhotoIds: Record<string, boolean>;
  onGenerate: () => void;
  ctaLabel: string;
  ctaDisabled: boolean;
  generationProgress: { current: number; total: number } | null;
  onConfirmPlacement: (photoId: string) => void;
  design: TattooDesign;
  adjust: DesignAdjust;
  coverUp: boolean;
  sliderX: number;
  onSliderChange: (val: number) => void;
  generating: boolean;
  hasResult: boolean;
  activeTab: DesignSourceMode;
  historyEntries: HistoryEntry[];
  showHistory: boolean;
  currentEntryId: string;
  onSelectHistory: (entry: HistoryEntry) => void;

  // Chained "add another tattoo" flow
  canAddAnother: boolean;
  onAddAnotherTattoo: () => void;
  onResetChain: () => void;
  isChained: boolean;

  // Save/Share + Download, surfaced directly at the point of completion
  // instead of being buried in the account menu.
  onSaveProject: () => void;
  saving: boolean;
  canSave: boolean;
  onDownload: () => void;
  canDownload: boolean;

  // Placement box + per-angle results ("Generate from Prompt" tab) — every
  // angle is placed manually, no auto-suggestion.
  placementBox: PlacementBox;
  onSetPlacementBox: (box: PlacementBox) => void;
  isolatedDesignSrc: string | null;
  draftAdjust: DesignAdjust;
  onSetDraftAdjust: (patch: Partial<DesignAdjust>) => void;
  needsPlacement: boolean;
  angleResult: AngleResult | null;
  isRepositioning: boolean;
  onRepositionAngle: (photoId: string) => void;
  onCancelReposition: () => void;
}

/** A row of equally-sized, equally-spaced angle thumbnails. Used both in the
 * placement-drawing screen (to switch which angle you're positioning) and in
 * the normal preview header (to switch which angle you're viewing). */
function AngleThumbnailRow({
  basePhotos,
  activePhotoId,
  onSelect,
  placedPhotoIds,
  confirmedPhotoIds,
  showWarnings
}: {
  basePhotos: BasePhoto[];
  activePhotoId: string | null;
  onSelect: (id: string) => void;
  placedPhotoIds?: Record<string, boolean>;
  confirmedPhotoIds?: Record<string, boolean>;
  showWarnings?: boolean;
}) {
  if (basePhotos.length < 2) return null;
  return (
    <div className="grid gap-2 w-full" style={{ gridTemplateColumns: `repeat(${basePhotos.length}, 1fr)` }}>
      {basePhotos.map((photo) => {
        const isActive = photo.id === activePhotoId;
        const needsWarning =
          showWarnings && !(placedPhotoIds && placedPhotoIds[photo.id]) && !(confirmedPhotoIds && confirmedPhotoIds[photo.id]);
        return (
          <button
            key={photo.id}
            onClick={() => onSelect(photo.id)}
            className="relative rounded-md overflow-hidden cursor-pointer"
            style={{
              height: 52,
              border: `1.5px solid ${isActive ? "var(--iv-accent)" : "rgba(236,231,224,0.15)"}`
            }}
            title={photo.name}
          >
            <img src={photo.src} alt={photo.name} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
            {needsWarning && (
              <div
                className="absolute top-0.5 right-0.5 flex items-center justify-center rounded-full"
                style={{ width: 16, height: 16, background: "rgba(10,10,9,0.85)" }}
                title="Placement not confirmed yet for this angle"
              >
                <AlertTriangle className="w-2.5 h-2.5" style={{ color: "rgb(245, 158, 11)" }} />
              </div>
            )}
            <div
              className="absolute bottom-0 left-0 right-0 px-1 py-0.5 font-mono truncate"
              style={{ fontSize: 8, background: "rgba(10,10,9,0.7)", color: "rgba(236,231,224,0.85)" }}
            >
              {photo.name}
            </div>
          </button>
        );
      })}
    </div>
  );
}

export default function TattooStage({
  basePhoto,
  basePhotos,
  onSelectBasePhoto,
  placedPhotoIds,
  confirmedPhotoIds,
  onConfirmPlacement,
  onGenerate,
  ctaLabel,
  ctaDisabled,
  generationProgress,
  design,
  adjust,
  coverUp,
  sliderX,
  onSliderChange,
  generating,
  hasResult,
  activeTab,
  historyEntries,
  showHistory,
  currentEntryId,
  onSelectHistory,
  canAddAnother,
  onAddAnotherTattoo,
  onResetChain,
  isChained,
  onSaveProject,
  saving,
  canSave,
  onDownload,
  canDownload,
  placementBox,
  onSetPlacementBox,
  isolatedDesignSrc,
  draftAdjust,
  onSetDraftAdjust,
  needsPlacement,
  angleResult,
  isRepositioning,
  onRepositionAngle,
  onCancelReposition
}: TattooStageProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [naturalAspect, setNaturalAspect] = useState(4 / 3);

  useEffect(() => {
    if (!basePhoto) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled && img.naturalWidth && img.naturalHeight) {
        setNaturalAspect(img.naturalWidth / img.naturalHeight);
      }
    };
    img.src = basePhoto.src;
    return () => {
      cancelled = true;
    };
  }, [basePhoto?.src]);

  const updateSlider = (clientX: number) => {
    const el = canvasRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let pct = ((clientX - rect.left) / rect.width) * 100;
    pct = Math.max(0, Math.min(100, pct));
    onSliderChange(pct);
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    draggingRef.current = true;
    updateSlider(e.clientX);

    const move = (ev: PointerEvent) => {
      if (draggingRef.current) updateSlider(ev.clientX);
    };
    const up = () => {
      draggingRef.current = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (!basePhoto) {
    return (
      <div
        className="flex flex-col items-center justify-center h-full rounded-2xl border font-body"
        style={{ background: "var(--iv-bg-deep)", borderColor: "var(--iv-border)" }}
        id="empty-stage-state"
      >
        <Sparkles className="w-12 h-12 mb-4" style={{ color: "var(--iv-accent)" }} />
        <h3 className="text-lg mb-2 font-display" style={{ color: "var(--iv-ink)" }}>
          No Canvas Uploaded
        </h3>
        <p className="max-w-sm text-sm text-center" style={{ color: "var(--iv-ink-dim)" }}>
          Upload a clear photo of your skin to start previewing tattoos.
        </p>
      </div>
    );
  }

  // Generate / Upload / Portfolio all now go through the same real AI
  // compositing pipeline (per-angle placement box -> Stage B blend), so the
  // "composite" rendering path (real generated result, real Confirm
  // Placement flow) always applies regardless of source tab. `activeTab` is
  // kept as a prop for callers that still branch on it elsewhere.
  const isComposite = true;
  void activeTab;

  if ((needsPlacement || isRepositioning) && !generating) {
    // A fresh new round (Add Another Tattoo) should show the latest accumulated
    // result so you can see your existing designs while placing the new one —
    // only when actually repositioning THIS round's own just-generated design
    // do we want the pre-this-round base instead (to avoid a visible duplicate).
    const editorBackground = isRepositioning
      ? angleResult?.baseSrcForThisRound || basePhoto.src
      : angleResult?.src || basePhoto.src;
    return (
      <div className="flex flex-col gap-4 font-body h-full" id="inkvision-interactive-stage">
        <div
          className="relative rounded-2xl overflow-hidden border flex-1 flex flex-col"
          style={{ background: "var(--iv-bg-deep)", borderColor: "var(--iv-border)" }}
        >
          <div className="flex-none px-6 pt-5 pb-3 flex flex-col gap-3">
            <div>
              <div className="font-display text-[13px] uppercase" style={{ letterSpacing: "0.12em", color: "rgba(217,210,198,0.9)" }}>
                {isRepositioning ? "Reposition" : "Draw Placement"}
              </div>
              <div className="text-xs mt-1" style={{ color: "rgba(236,231,224,0.45)" }}>
                {basePhoto.name} — drag the box to reposition, or the corner handles to resize.
              </div>
            </div>
            <AngleThumbnailRow
              basePhotos={basePhotos}
              activePhotoId={basePhoto.id}
              onSelect={onSelectBasePhoto}
              placedPhotoIds={placedPhotoIds}
              confirmedPhotoIds={confirmedPhotoIds}
              showWarnings
            />
          </div>
          <div className="flex-1 min-h-0 px-6 pb-4">
            <PlacementBoxEditor
              imageSrc={editorBackground}
              box={placementBox}
              onChange={onSetPlacementBox}
              fillHeight
              designSrc={isolatedDesignSrc}
              designAdjust={draftAdjust}
            />
          </div>
          <div className="flex-none flex items-center justify-between gap-2.5 px-6 pb-4">
            <span className="text-xs" style={{ color: "rgba(217,210,198,0.45)" }}>
              {isComposite
                ? "Confirm this box when you're happy with it — you can switch angles first to set up more before generating."
                : "Drag the box to reposition, or the corner handles to resize — then Generate Preview below when you're happy with it."}
            </span>
            {isComposite && (
              <div className="flex items-center gap-2.5 flex-none">
                {isRepositioning && (
                  <button
                    onClick={onCancelReposition}
                    className="font-display text-[11px] uppercase py-2.5 px-4.5 rounded-md cursor-pointer"
                    style={{ background: "none", border: "1px solid rgba(217,210,198,0.18)", color: "var(--iv-ink)", letterSpacing: "0.06em" }}
                  >
                    Cancel
                  </button>
                )}
                <button
                  onClick={() => onConfirmPlacement(basePhoto.id)}
                  disabled={!!confirmedPhotoIds[basePhoto.id]}
                  className="font-display text-[11px] uppercase py-2.5 px-4.5 rounded-md cursor-pointer"
                  style={{
                    background: confirmedPhotoIds[basePhoto.id] ? "rgba(236,231,224,0.06)" : "var(--iv-accent)",
                    border: "none",
                    color: confirmedPhotoIds[basePhoto.id] ? "rgba(236,231,224,0.5)" : "#0f0e0d",
                    letterSpacing: "0.08em",
                    cursor: confirmedPhotoIds[basePhoto.id] ? "default" : "pointer"
                  }}
                >
                  {confirmedPhotoIds[basePhoto.id] ? "✓ Confirmed" : "Confirm Placement"}
                </button>
              </div>
            )}
          </div>
          <div className="flex-none px-6 pb-5">
            <button
              onClick={onGenerate}
              disabled={ctaDisabled}
              className="w-full font-display text-[13px] uppercase py-3 rounded-lg cursor-pointer"
              style={{
                background: "var(--iv-accent)",
                color: "#0f0e0d",
                letterSpacing: "0.1em",
                border: "none",
                opacity: ctaDisabled ? 0.6 : 1,
                cursor: ctaDisabled ? "not-allowed" : "pointer"
              }}
            >
              {generationProgress ? `Rendering angle ${generationProgress.current} of ${generationProgress.total}…` : ctaLabel}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const overlayTransform = `rotate(${adjust.rotate}deg)`;
  const overlayOpacity = adjust.opacity / 100;
  const overlaySaturate = adjust.saturation;
  const afterSrc = isComposite ? angleResult?.src : null;

  return (
    <div className="flex flex-col gap-4 font-body h-full" id="inkvision-interactive-stage">
      <div
        className="relative rounded-2xl overflow-hidden border flex-1 flex flex-col min-h-0"
        style={{ background: "var(--iv-bg-deep)", borderColor: "var(--iv-border)" }}
      >
        {/* Header: title + angle thumbnails + subtitle + badges (real layout, not overlay) */}
        <div className="flex-none px-6 pt-5 pb-3 flex flex-col gap-3">
          <div className="flex justify-between items-start">
            <div className="font-display text-[13px] uppercase" style={{ letterSpacing: "0.12em", color: "rgba(217,210,198,0.9)" }}>
              Preview
            </div>
            <div className="flex items-center gap-2">
              <div
                className="rounded-md px-3 py-1.5 text-[11px] font-medium"
                style={{
                  background: coverUp ? "var(--iv-accent-soft)" : "rgba(236,231,224,0.06)",
                  border: `1px solid ${coverUp ? "rgba(217,210,198,0.4)" : "rgba(236,231,224,0.14)"}`,
                  color: coverUp ? "var(--iv-accent)" : "rgba(236,231,224,0.65)",
                  letterSpacing: "0.04em"
                }}
              >
                {coverUp ? "Cover-Up Active" : "Existing Ink Preserved"}
              </div>
            </div>
          </div>

          <AngleThumbnailRow
            basePhotos={basePhotos}
            activePhotoId={basePhoto.id}
            onSelect={onSelectBasePhoto}
            placedPhotoIds={placedPhotoIds}
            confirmedPhotoIds={confirmedPhotoIds}
            showWarnings={isComposite}
          />
        </div>

        <div className="relative select-none flex-1 min-h-0 mb-6 flex items-center justify-center">
          <div
            ref={canvasRef}
            onPointerDown={handlePointerDown}
            className="relative"
            style={{
              height: "100%",
              width: "auto",
              maxWidth: "100%",
              aspectRatio: String(naturalAspect),
              cursor: "ew-resize",
              borderRadius: 14,
              overflow: "hidden",
              margin: "0 24px"
            }}
          >
          {/* BEFORE view — always the true original photo, real orientation preserved (no cropping) */}
          <img
            src={basePhoto.src}
            alt="Base photo before"
            className="absolute inset-0 w-full h-full object-cover pointer-events-none"
            referrerPolicy="no-referrer"
          />

          {/* AFTER view, clipped to the right of the divider */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{ clipPath: `inset(0px 0px 0px ${sliderX}%)`, zIndex: 2 }}
          >
            {isComposite ? (
              <img
                src={afterSrc || basePhoto.src}
                alt="Generated tattoo composite"
                className="absolute inset-0 w-full h-full object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              <>
                <img
                  src={basePhoto.src}
                  alt="Base photo after"
                  className="absolute inset-0 w-full h-full object-cover"
                  referrerPolicy="no-referrer"
                />
                <div
                  className="absolute flex items-center justify-center overflow-hidden"
                  style={{
                    left: `${placementBox.x}%`,
                    top: `${placementBox.y}%`,
                    width: `${placementBox.width}%`,
                    height: `${placementBox.height}%`,
                    borderRadius: 8,
                    border: hasResult ? "none" : "1.5px dashed rgba(217,210,198,0.53)",
                    opacity: overlayOpacity,
                    filter: `saturate(${overlaySaturate}%)`,
                    transform: overlayTransform,
                    transformOrigin: "center"
                  }}
                >
                  {hasResult && design.src ? (
                    <img
                      src={design.src}
                      alt={design.name}
                      className="w-full h-full object-contain"
                      style={{ mixBlendMode: "multiply" }}
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <>
                      <div
                        className="absolute inset-0"
                        style={{
                          backgroundImage:
                            "repeating-linear-gradient(45deg, rgba(236,231,224,.09) 0, rgba(236,231,224,.09) 2px, transparent 2px, transparent 10px)"
                        }}
                      />
                      <div
                        className="relative text-center font-mono uppercase px-2"
                        style={{ fontSize: 10, letterSpacing: "0.06em", color: "rgba(236,231,224,.8)" }}
                      >
                        Generated
                        <br />
                        Tattoo Design
                      </div>
                    </>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Divider line + drag handle */}
          <div
            className="absolute top-0 bottom-0 pointer-events-none"
            style={{ left: `${sliderX}%`, width: 2, background: "rgb(245, 158, 11)", zIndex: 4 }}
          />
          <div
            className="absolute flex items-center justify-center shadow-xl"
            style={{
              top: "50%",
              left: `${sliderX}%`,
              width: 30,
              height: 30,
              margin: "-15px 0 0 -15px",
              borderRadius: "50%",
              background: "rgb(245, 158, 11)",
              color: "#0f0e0d",
              fontSize: 14,
              zIndex: 4,
              cursor: "ew-resize"
            }}
          >
            &#8596;
          </div>

          <div
            className="absolute bottom-3.5 left-4 font-mono uppercase pointer-events-none"
            style={{ fontSize: 10, letterSpacing: "0.1em", color: "rgba(236,231,224,.4)" }}
          >
            Before
          </div>
          <div
            className="absolute bottom-3.5 right-4 font-mono uppercase pointer-events-none"
            style={{ fontSize: 10, letterSpacing: "0.1em", color: "rgba(236,231,224,.4)" }}
          >
            After
          </div>

          {generating && (
            <div
              className="absolute inset-0 flex flex-col items-center justify-center gap-4"
              style={{ background: "rgba(10,10,9,.72)", zIndex: 5 }}
            >
              <div
                className="w-9 h-9 rounded-full iv-spin"
                style={{ border: "3px solid rgba(236,231,224,.15)", borderTopColor: "rgb(245, 158, 11)" }}
              />
              <div className="text-xs iv-pulse" style={{ letterSpacing: "0.04em", color: "rgba(236,231,224,.75)" }}>
                {generationProgress
                  ? `Rendering angle ${generationProgress.current} of ${generationProgress.total}…`
                  : "Rendering photorealistic composite…"}
              </div>
            </div>
          )}
          </div>
        </div>
      </div>

      {canAddAnother && (
        <div
          className="flex-none flex items-center justify-between gap-3 rounded-xl px-4 py-3 flex-wrap"
          style={{ background: "var(--iv-panel)", border: "1px solid rgba(217,210,198,0.12)" }}
        >
          <span className="text-xs" style={{ color: "rgba(217,210,198,0.55)" }}>
            Happy with this piece? You can keep building on it.
          </span>
          <div className="flex items-center gap-2 flex-wrap">
            {isComposite && angleResult && (
              <button
                onClick={() => onRepositionAngle(basePhoto.id)}
                className="font-display text-[11px] uppercase rounded-md px-2.5 py-1.5 cursor-pointer"
                style={{ background: "rgba(236,231,224,0.06)", border: "1px solid rgba(236,231,224,0.14)", color: "rgba(236,231,224,0.6)" }}
              >
                Reposition
              </button>
            )}
            {isChained && (
              <button
                onClick={onResetChain}
                className="text-[11px] uppercase cursor-pointer bg-transparent border-none p-0 font-display"
                style={{ color: "rgba(217,210,198,0.4)", letterSpacing: "0.06em" }}
              >
                Reset to original
              </button>
            )}
            <button
              onClick={onDownload}
              disabled={!canDownload}
              title={canDownload ? "Download this image to your device" : "Generate a preview first"}
              className="font-display text-[11px] uppercase rounded-md px-2.5 py-1.5 cursor-pointer"
              style={{
                background: "rgba(236,231,224,0.06)",
                border: "1px solid rgba(236,231,224,0.14)",
                color: canDownload ? "rgba(236,231,224,0.85)" : "rgba(236,231,224,0.3)",
                letterSpacing: "0.06em",
                cursor: canDownload ? "pointer" : "not-allowed"
              }}
            >
              Download
            </button>
            <button
              onClick={onSaveProject}
              disabled={!canSave || saving}
              title={canSave ? "Save this project to the cloud and get a shareable link/code" : "Add a photo first"}
              className="font-display text-[11px] uppercase rounded-md px-2.5 py-1.5 cursor-pointer"
              style={{
                background: "rgba(236,231,224,0.06)",
                border: "1px solid rgba(217,210,198,0.4)",
                color: !canSave || saving ? "rgba(217,210,198,0.35)" : "var(--iv-accent)",
                letterSpacing: "0.06em",
                cursor: !canSave || saving ? "not-allowed" : "pointer"
              }}
            >
              {saving ? "Saving…" : "Save & Share"}
            </button>
            <button
              onClick={onAddAnotherTattoo}
              className="font-display text-[11px] uppercase py-2 px-3.5 rounded-md cursor-pointer"
              style={{ background: "var(--iv-accent)", border: "none", color: "#0f0e0d", letterSpacing: "0.08em" }}
            >
              + Add Another Tattoo
            </button>
          </div>
        </div>
      )}

      {showHistory && historyEntries.length > 0 && (
        <div className="flex-none flex gap-2.5">
          {historyEntries.map((entry) => {
            const isCurrent = entry.id === currentEntryId;
            return (
              <button
                key={entry.id}
                onClick={() => onSelectHistory(entry)}
                className="relative flex-none rounded-md overflow-hidden cursor-pointer"
                style={{
                  width: 74,
                  height: 56,
                  border: `1.5px solid ${isCurrent ? "var(--iv-accent)" : "rgba(236,231,224,.15)"}`
                }}
              >
                {entry.thumbnailSrc ? (
                  <img src={entry.thumbnailSrc} alt={entry.label} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                ) : (
                  <div
                    className="absolute inset-0"
                    style={{
                      backgroundImage:
                        "repeating-linear-gradient(45deg, rgba(236,231,224,.05) 0, rgba(236,231,224,.05) 2px, transparent 2px, transparent 9px)"
                    }}
                  />
                )}
                <div
                  className="absolute bottom-0.5 left-1 font-mono"
                  style={{ fontSize: 9, color: "rgba(236,231,224,.75)", textShadow: "0 1px 2px rgba(0,0,0,.8)" }}
                >
                  {isCurrent ? "current" : entry.label}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
