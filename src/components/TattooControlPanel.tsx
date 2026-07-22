import React, { useEffect, useRef, useState } from "react";
import { Loader2, Sparkles, RefreshCw, ChevronDown, X, Heart, Check } from "lucide-react";
import { BasePhoto, DesignAdjust, DesignSourceMode, PortfolioItem } from "../types";

interface ClarifyingQuestion {
  question: string;
  options: string[];
}

interface TattooControlPanelProps {
  basePhotos: BasePhoto[];
  activePhotoId: string | null;
  onSelectBasePhoto: (id: string) => void;
  onAddBasePhoto: (file: File) => void;
  onRemoveBasePhoto: (id: string) => void;
  maxAngles: number;
  helperText: string;
  placedPhotoIds: Record<string, boolean>;
  confirmedPhotoIds: Record<string, boolean>;
  generationProgress: { current: number; total: number } | null;

  activeTab: DesignSourceMode;
  onSetActiveTab: (tab: DesignSourceMode) => void;

  prompt: string;
  onSetPrompt: (p: string) => void;
  style: string;
  onSetStyle: (s: string) => void;
  colorPreference: string;
  onSetColorPreference: (c: string) => void;

  uploadedPreviewSrc: string | null;
  onUploadDesignFile: (file: File) => void;

  portfolioItems: PortfolioItem[];
  portfolioLoading: boolean;
  selectedPortfolioId: string | null;
  onSelectPortfolioItem: (item: PortfolioItem) => void;
  onLikePortfolioItem: (id: string) => void;

  coverUp: boolean;
  onToggleCoverUp: () => void;

  adjust: DesignAdjust;
  onSetAdjust: (patch: Partial<DesignAdjust>) => void;
  draftAdjust: DesignAdjust;
  onSetDraftAdjust: (patch: Partial<DesignAdjust>) => void;
  adjustEnabled: boolean;
  boxScalePercent: number;
  onSetBoxScale: (scalePercent: number) => void;

  generating: boolean;
  onGenerate: () => void;
  ctaLabel: string;
  ctaDisabled: boolean;
  error: string | null;

  // Analysis status — runs silently in the background now (no manual trigger,
  // no gate); this just displays the result once it's available.
  analyzing: boolean;
  analysisConfirmed: boolean;
  analysisSummary: string | null;
  anglesWarning: string | null;
  onReanalyze: () => void;
  locked: boolean;

  // Context-aware "Inspire me"
  ideas: string[] | null;
  ideasLoading: boolean;
  clarifyingQuestion: ClarifyingQuestion | null;
  selectedClarifyingOption: string | null;
  onFetchIdeas: () => void;
  onSelectClarifyingOption: (option: string) => void;

  // Drives the one-time accordion auto-advance (01 -> 02 -> 03)
  hasResult: boolean;
}

const rowLabel = "flex justify-between text-xs font-medium mb-1.5";
const STEP_NUMBER_COLOR = "rgb(245, 158, 11)";
const INSPIRE_COLOR = "rgb(245, 158, 11)";

const REQUIREMENTS_NOTE =
  "For best results: white or transparent background, high-contrast line work, design cropped tightly to its own edges (no extra padding).";

function StepHeader({
  number,
  label,
  expanded,
  onToggle
}: {
  number: string;
  label: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center justify-between font-display text-xs uppercase cursor-pointer bg-transparent border-none p-0"
      style={{ letterSpacing: "0.12em", color: "var(--iv-ink)", marginBottom: expanded ? 10 : 0 }}
    >
      <span>
        <span style={{ color: STEP_NUMBER_COLOR }}>{number}</span> &mdash; {label}
      </span>
      <ChevronDown
        className="w-3.5 h-3.5 flex-none transition-transform"
        style={{ transform: expanded ? "rotate(180deg)" : "rotate(0deg)" }}
      />
    </button>
  );
}

export default function TattooControlPanel({
  basePhotos,
  activePhotoId,
  onSelectBasePhoto,
  onAddBasePhoto,
  onRemoveBasePhoto,
  maxAngles,
  helperText,
  placedPhotoIds,
  confirmedPhotoIds,
  generationProgress,
  activeTab,
  onSetActiveTab,
  prompt,
  onSetPrompt,
  style,
  onSetStyle,
  colorPreference,
  onSetColorPreference,
  uploadedPreviewSrc,
  onUploadDesignFile,
  portfolioItems,
  portfolioLoading,
  selectedPortfolioId,
  onSelectPortfolioItem,
  onLikePortfolioItem,
  coverUp,
  onToggleCoverUp,
  adjust,
  onSetAdjust,
  draftAdjust,
  onSetDraftAdjust,
  adjustEnabled,
  boxScalePercent,
  onSetBoxScale,
  generating,
  onGenerate,
  ctaLabel,
  ctaDisabled,
  error,
  analyzing,
  analysisConfirmed,
  analysisSummary,
  anglesWarning,
  onReanalyze,
  locked,
  ideas,
  ideasLoading,
  clarifyingQuestion,
  selectedClarifyingOption,
  onFetchIdeas,
  onSelectClarifyingOption,
  hasResult
}: TattooControlPanelProps) {
  const anglesInputRef = useRef<HTMLInputElement>(null);
  const designInputRef = useRef<HTMLInputElement>(null);

  // Only the current active step starts open. Manual clicks are always
  // respected afterward — the auto-advance below is a one-time tidy-up
  // nudge, not a persistent re-sync.
  const [expanded, setExpanded] = useState({ step1: true, step2: false, step3: false });
  const toggleStep = (key: keyof typeof expanded) => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

  const advancedToStep2 = useRef(false);
  const advancedToStep3 = useRef(false);

  useEffect(() => {
    if (!locked && !advancedToStep2.current) {
      advancedToStep2.current = true;
      setExpanded((prev) => ({ ...prev, step1: false, step2: true }));
    }
  }, [locked]);

  useEffect(() => {
    if (hasResult && !advancedToStep3.current) {
      advancedToStep3.current = true;
      setExpanded((prev) => ({ ...prev, step2: false, step3: true }));
    }
  }, [hasResult]);

  const handleAnglesFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onAddBasePhoto(file);
    e.target.value = "";
  };

  const handleDesignFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onUploadDesignFile(file);
    e.target.value = "";
  };

  // Rotate/Opacity/Saturation pre-transform the flat design graphic BEFORE
  // it's sent to the AI for the real per-angle blend — this now applies the
  // same way for every source tab (Generate / Upload / Portfolio all go
  // through the same real compositing pipeline), so it always reads/writes
  // the per-photo draftAdjust map, never the old standalone `adjust` state.
  // Scale/position always resize/drag the same visible box, for every tab.
  const effectiveAdjust = draftAdjust;
  const effectiveDisabled = !adjustEnabled;
  const handleAdjustChange = (patch: Partial<DesignAdjust>) => {
    onSetDraftAdjust(patch);
  };
  void adjust;
  void onSetAdjust;

  const tabBase =
    "flex-1 border-none font-display text-[11px] font-medium uppercase py-2.5 px-1 rounded-md cursor-pointer transition";

  return (
    <div
      className="rounded-2xl border flex flex-col h-full overflow-hidden"
      style={{ background: "var(--iv-panel)", borderColor: "var(--iv-border)" }}
      id="inkvision-control-panel"
    >
      <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6">
        {/* Step 01 — Base Photo */}
        <div>
          <StepHeader number="01" label="Base Photo" expanded={expanded.step1} onToggle={() => toggleStep("step1")} />
          {expanded.step1 && (
            <>
              <div className="grid grid-cols-2 gap-2">
                {basePhotos.map((photo) => (
                  <div
                    key={photo.id}
                    className="relative rounded-lg overflow-hidden"
                    style={{
                      height: 96,
                      border: `1px solid ${photo.id === activePhotoId ? "var(--iv-accent)" : "rgba(217,210,198,0.12)"}`
                    }}
                  >
                    <button
                      onClick={() => onSelectBasePhoto(photo.id)}
                      className="absolute inset-0 w-full h-full cursor-pointer border-none p-0"
                    >
                      <img src={photo.src} alt={photo.name} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                      <div
                        className="absolute bottom-0 left-0 right-0 px-1.5 py-1 font-mono text-[10px] truncate"
                        style={{ background: "rgba(10,10,9,0.7)", color: "rgba(236,231,224,0.85)" }}
                      >
                        {photo.name}
                      </div>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemoveBasePhoto(photo.id);
                      }}
                      title="Remove this photo"
                      className="absolute top-1 right-1 flex items-center justify-center rounded-full cursor-pointer border-none"
                      style={{ width: 20, height: 20, background: "rgba(10,10,9,0.75)", color: "rgba(236,231,224,0.9)" }}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
                {basePhotos.length < maxAngles && (
                  <button
                    onClick={() => anglesInputRef.current?.click()}
                    className={`${basePhotos.length === 0 ? "col-span-2 py-6 h-auto" : "h-24"} rounded-lg cursor-pointer font-display text-[11px] uppercase flex flex-col items-center justify-center gap-2`}
                    style={{
                      minHeight: 96,
                      border: "1px dashed rgba(217,210,198,0.25)",
                      color: "rgba(217,210,198,0.5)",
                      letterSpacing: "0.04em",
                      background: "rgba(236,231,224,0.02)"
                    }}
                  >
                    <span className="text-base">+</span>
                    <span>{basePhotos.length === 0 ? "Upload Skin Photo" : "Add Angle"}</span>
                  </button>
                )}
                <input ref={anglesInputRef} type="file" accept="image/*" className="hidden" onChange={handleAnglesFile} />
              </div>
              <div className="text-xs mt-2 leading-relaxed" style={{ color: "rgba(217,210,198,0.45)" }}>
                {helperText}
              </div>
            </>
          )}
        </div>

        {/* Analysis status — runs silently in the background when first needed (Generate/Inspire Me/Multi-Pose); never blocks */}
        {(analyzing || analysisConfirmed) && (
          <div>
            {analysisConfirmed ? (
              <div
                className="flex items-center justify-between rounded-lg px-3.5 py-2.5"
                style={{ background: "var(--iv-accent-soft)", border: "1px solid rgba(217,210,198,0.35)" }}
              >
                <span className="text-xs truncate pr-2" style={{ color: "var(--iv-accent)" }}>
                  &#10003; {analysisSummary}
                </span>
                <button
                  onClick={onReanalyze}
                  title="Re-analyze"
                  className="flex-none bg-transparent border-none cursor-pointer p-1"
                  style={{ color: "var(--iv-accent)" }}
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-xs" style={{ color: "rgba(217,210,198,0.4)" }}>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Reading your photo…
              </div>
            )}
          </div>
        )}

        {anglesWarning && (
          <div
            className="rounded-lg px-3.5 py-2.5 text-xs leading-relaxed"
            style={{ background: "rgba(200,32,63,0.1)", border: "1px solid rgba(200,32,63,0.4)", color: "#e8899a" }}
          >
            ⚠ {anglesWarning} Consider removing the mismatched photo(s) from Step 01 — the same design gets applied to every angle as-is.
          </div>
        )}

        {/* Steps 02-03 — locked only until a base photo is uploaded */}
        <div
          className="flex flex-col gap-6"
          style={{
            opacity: locked ? 0.35 : 1,
            pointerEvents: locked ? "none" : "auto",
            transition: "opacity 0.15s",
            filter: locked ? "grayscale(0.4)" : "none"
          }}
        >
          {/* Step 02 — Tattoo Design */}
          <div>
            <StepHeader number="02" label="Tattoo Design" expanded={expanded.step2} onToggle={() => toggleStep("step2")} />
            {expanded.step2 && (
              <>
                <div className="flex gap-0.5 rounded-lg p-0.5 mb-3" style={{ background: "rgba(236,231,224,0.06)" }}>
                  <button
                    onClick={() => onSetActiveTab("portfolio")}
                    className={tabBase}
                    style={{
                      background: activeTab === "portfolio" ? "var(--iv-accent)" : "transparent",
                      color: activeTab === "portfolio" ? "#0f0e0d" : "rgba(236,231,224,0.55)"
                    }}
                  >
                    Portfolio
                  </button>
                  <button
                    onClick={() => onSetActiveTab("upload")}
                    className={tabBase}
                    style={{
                      background: activeTab === "upload" ? "var(--iv-accent)" : "transparent",
                      color: activeTab === "upload" ? "#0f0e0d" : "rgba(236,231,224,0.55)"
                    }}
                  >
                    Upload
                  </button>
                  <button
                    onClick={() => onSetActiveTab("prompt")}
                    className={tabBase}
                    style={{
                      background: activeTab === "prompt" ? "var(--iv-accent)" : "transparent",
                      color: activeTab === "prompt" ? "#0f0e0d" : "rgba(236,231,224,0.55)"
                    }}
                  >
                    Generate
                  </button>
                </div>

                {activeTab === "upload" ? (
                  <>
                    <button
                      onClick={() => designInputRef.current?.click()}
                      className="w-full rounded-lg overflow-hidden cursor-pointer relative"
                      style={{ height: 120, border: "1px dashed rgba(236,231,224,0.18)" }}
                    >
                      {uploadedPreviewSrc ? (
                        <img src={uploadedPreviewSrc} alt="Reference tattoo" className="w-full h-full object-contain bg-white" />
                      ) : (
                        <span className="text-xs" style={{ color: "rgba(217,210,198,0.4)" }}>
                          Drop reference tattoo image
                        </span>
                      )}
                      <input ref={designInputRef} type="file" accept="image/*" className="hidden" onChange={handleDesignFile} />
                    </button>
                    <div className="text-[11px] mt-2 leading-relaxed" style={{ color: "rgba(217,210,198,0.4)" }}>
                      {REQUIREMENTS_NOTE}
                    </div>
                  </>
                ) : activeTab === "portfolio" ? (
                  <>
                    {portfolioLoading ? (
                      <div className="flex items-center justify-center py-8">
                        <Loader2 className="w-5 h-5 animate-spin" style={{ color: "rgba(217,210,198,0.4)" }} />
                      </div>
                    ) : portfolioItems.length === 0 ? (
                      <div className="text-xs text-center py-8" style={{ color: "rgba(217,210,198,0.4)" }}>
                        No community designs yet — designs generated with "Generate" are added here automatically.
                      </div>
                    ) : (
                      <div className="grid grid-cols-3 gap-2 max-h-56 overflow-y-auto pr-0.5">
                        {portfolioItems.map((item) => (
                          <button
                            key={item.id}
                            onClick={() => onSelectPortfolioItem(item)}
                            className="relative rounded-lg overflow-hidden cursor-pointer"
                            style={{
                              height: 76,
                              background: "#fff",
                              border: `1.5px solid ${selectedPortfolioId === item.id ? "var(--iv-accent)" : "rgba(217,210,198,0.12)"}`
                            }}
                            title={item.name}
                          >
                            <img src={item.imageUrl} alt={item.name} className="w-full h-full object-contain" referrerPolicy="no-referrer" />
                            {selectedPortfolioId === item.id && (
                              <div
                                className="absolute top-0.5 left-0.5 flex items-center justify-center rounded-full"
                                style={{ width: 16, height: 16, background: "rgb(34,197,94)" }}
                                title="Selected"
                              >
                                <Check className="w-2.5 h-2.5" style={{ color: "#0f0e0d" }} strokeWidth={3} />
                              </div>
                            )}
                            <div
                              onClick={(e) => {
                                e.stopPropagation();
                                onLikePortfolioItem(item.id);
                              }}
                              className="absolute bottom-0.5 right-0.5 flex items-center gap-0.5 rounded-full px-1.5 py-0.5 cursor-pointer"
                              style={{ background: "rgba(10,10,9,0.75)" }}
                            >
                              <Heart className="w-2.5 h-2.5" style={{ color: "rgba(236,231,224,0.85)" }} />
                              <span className="text-[9px] font-mono" style={{ color: "rgba(236,231,224,0.85)" }}>
                                {item.likes}
                              </span>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="text-[11px] mt-2 leading-relaxed" style={{ color: "rgba(217,210,198,0.4)" }}>
                      {REQUIREMENTS_NOTE}
                    </div>
                  </>
                ) : (
                  <div className="flex flex-col gap-2">
                    <textarea
                      value={prompt}
                      onChange={(e) => onSetPrompt(e.target.value)}
                      rows={4}
                      placeholder="Describe the tattoo you want to visualize..."
                      className="w-full box-border rounded-lg p-3 text-[13px] resize-y font-body"
                      style={{
                        background: "var(--iv-bg-deep)",
                        border: "1px solid rgba(217,210,198,0.15)",
                        color: "var(--iv-ink)"
                      }}
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <select
                        value={style}
                        onChange={(e) => onSetStyle(e.target.value)}
                        className="text-xs rounded-md p-2 font-body"
                        style={{ background: "var(--iv-bg-deep)", border: "1px solid rgba(217,210,198,0.15)", color: "var(--iv-ink)" }}
                      >
                        <option value="fineline blackwork">Fine-Line Blackwork</option>
                        <option value="traditional americana">Traditional Americana</option>
                        <option value="watercolor art">Vibrant Watercolor</option>
                        <option value="japanese irezumi">Japanese Irezumi</option>
                        <option value="micro-realism">Micro-Realism</option>
                        <option value="tribal abstract">Tribal Abstract</option>
                      </select>
                      <select
                        value={colorPreference}
                        onChange={(e) => onSetColorPreference(e.target.value)}
                        className="text-xs rounded-md p-2 font-body"
                        style={{ background: "var(--iv-bg-deep)", border: "1px solid rgba(217,210,198,0.15)", color: "var(--iv-ink)" }}
                      >
                        <option value="monochrome">Black &amp; Grey</option>
                        <option value="colorful">Vibrant Color</option>
                        <option value="pastel">Soft Pastel</option>
                        <option value="sepia">Sepia / Vintage</option>
                        <option value="blackwork">Bold Blackwork</option>
                        <option value="whitework">Whitework</option>
                        <option value="single-accent">Black + One Accent Color</option>
                      </select>
                    </div>
                    <div className="flex justify-end">
                      <button
                        onClick={onFetchIdeas}
                        disabled={ideasLoading}
                        className="bg-transparent border-none cursor-pointer font-display text-[11px] uppercase p-0 flex items-center gap-1.5"
                        style={{ color: INSPIRE_COLOR, letterSpacing: "0.06em" }}
                      >
                        {ideasLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                        {ideasLoading ? "Thinking of ideas…" : "Inspire me"}
                      </button>
                    </div>

                    {ideas && ideas.length > 0 && (
                      <div className="rounded-lg p-3 mt-1" style={{ background: "rgba(236,231,224,0.04)", border: "1px solid rgba(236,231,224,0.08)" }}>
                        <div className="text-[10px] font-mono uppercase mb-2" style={{ color: "rgba(217,210,198,0.4)", letterSpacing: "0.06em" }}>
                          Tailored to your existing ink
                        </div>
                        <div className="flex flex-col gap-1.5 mb-3">
                          {ideas.map((idea, i) => (
                            <button
                              key={i}
                              onClick={() => onSetPrompt(idea)}
                              className="text-left font-display text-xs rounded-md px-2.5 py-1.5 cursor-pointer"
                              style={{
                                background: prompt === idea ? "var(--iv-accent-soft)" : "transparent",
                                color: prompt === idea ? "var(--iv-accent)" : "rgba(217,210,198,0.7)"
                              }}
                            >
                              {idea}
                            </button>
                          ))}
                        </div>

                        {clarifyingQuestion && (
                          <>
                            <div className="text-xs font-medium mb-1.5" style={{ color: "rgba(236,231,224,0.7)" }}>
                              {clarifyingQuestion.question}
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {clarifyingQuestion.options.map((opt) => (
                                <button
                                  key={opt}
                                  onClick={() => onSelectClarifyingOption(opt)}
                                  className="font-display text-[11px] rounded-full px-2.5 py-1 cursor-pointer"
                                  style={{
                                    border: `1px solid ${selectedClarifyingOption === opt ? "var(--iv-accent)" : "rgba(217,210,198,0.2)"}`,
                                    color: selectedClarifyingOption === opt ? "var(--iv-accent)" : "rgba(217,210,198,0.6)"
                                  }}
                                >
                                  {opt}
                                </button>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {error && (
                  <div
                    className="rounded-lg p-3 mt-3 text-xs font-mono"
                    style={{ background: "rgba(200,32,63,0.1)", border: "1px solid rgba(200,32,63,0.4)", color: "#e8899a" }}
                  >
                    {error}
                  </div>
                )}

                {basePhotos.length > 0 && (
                  <div className="rounded-lg p-3 mt-4" style={{ background: "rgba(236,231,224,0.04)", border: "1px solid rgba(236,231,224,0.1)" }}>
                    <div className="text-[10px] font-mono uppercase mb-2" style={{ color: "rgba(217,210,198,0.4)", letterSpacing: "0.06em" }}>
                      Every angle needs a confirmed placement before generating
                    </div>
                    <div className="flex flex-col gap-1">
                      {basePhotos.map((photo) => {
                        const ready = !!placedPhotoIds[photo.id] || !!confirmedPhotoIds[photo.id];
                        return (
                          <button
                            key={photo.id}
                            onClick={() => onSelectBasePhoto(photo.id)}
                            className="flex items-center justify-between text-xs py-1 px-1.5 rounded cursor-pointer bg-transparent border-none"
                            style={{ color: photo.id === activePhotoId ? "var(--iv-ink)" : "rgba(217,210,198,0.6)" }}
                          >
                            <span className="truncate">{photo.name}</span>
                            <span style={{ color: ready ? "rgb(52,199,89)" : "rgb(245, 158, 11)" }}>{ready ? "✓ Ready" : "⚠ Needs placement"}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div
                  className="flex items-center justify-between rounded-lg px-3.5 py-3 mt-4"
                  style={{ background: "rgba(236,231,224,0.04)", border: "1px solid rgba(236,231,224,0.1)" }}
                >
                  <div className="text-sm font-medium" style={{ color: "var(--iv-ink)" }}>
                    Cover existing ink
                  </div>
                  <div
                    onClick={onToggleCoverUp}
                    className="cursor-pointer relative"
                    style={{
                      width: 42,
                      height: 24,
                      borderRadius: 12,
                      background: coverUp ? "var(--iv-accent)" : "rgba(236,231,224,0.18)",
                      transition: "background 0.15s"
                    }}
                  >
                    <div
                      className="absolute"
                      style={{
                        width: 18,
                        height: 18,
                        top: 3,
                        left: coverUp ? 21 : 3,
                        borderRadius: "50%",
                        background: "#0f0e0d",
                        transition: "left 0.15s"
                      }}
                    />
                  </div>
                </div>
                <div
                  className="text-xs mt-2 mb-4 leading-relaxed"
                  style={{ color: coverUp ? "rgba(217,210,198,0.85)" : "rgba(236,231,224,0.45)" }}
                >
                  {coverUp
                    ? "Cover-Up Mode is ON — the new design may be placed directly over existing ink."
                    : "Cover-Up Mode is OFF — existing tattoos are strictly preserved; the new design fills empty skin only."}
                </div>

                <button
                  onClick={onGenerate}
                  disabled={ctaDisabled}
                  className="w-full font-display text-[13px] uppercase py-3.5 rounded-lg flex items-center justify-center gap-2"
                  style={{
                    background: "var(--iv-accent)",
                    color: "#0f0e0d",
                    letterSpacing: "0.1em",
                    border: "none",
                    opacity: ctaDisabled ? 0.6 : 1,
                    cursor: ctaDisabled ? "not-allowed" : "pointer"
                  }}
                >
                  {generating && <Loader2 className="w-4 h-4 animate-spin" />}
                  {generating && generationProgress ? `Rendering angle ${generationProgress.current} of ${generationProgress.total}…` : ctaLabel}
                </button>
              </>
            )}
          </div>

          {/* Step 03 — Adjustments */}
          <div>
            <div className="flex items-center justify-between" style={{ marginBottom: expanded.step3 ? 10 : 0 }}>
              <button
                onClick={() => toggleStep("step3")}
                className="flex-1 flex items-center justify-between font-display text-xs uppercase cursor-pointer bg-transparent border-none p-0"
                style={{ letterSpacing: "0.12em", color: "var(--iv-ink)" }}
              >
                <span>
                  <span style={{ color: STEP_NUMBER_COLOR }}>03</span> &mdash; Adjustments
                </span>
                <ChevronDown
                  className="w-3.5 h-3.5 flex-none transition-transform"
                  style={{ transform: expanded.step3 ? "rotate(180deg)" : "rotate(0deg)" }}
                />
              </button>
              {expanded.step3 && !effectiveDisabled && (
                <button
                  onClick={() => {
                    onSetBoxScale(100);
                    handleAdjustChange({ rotate: 0, opacity: 100, saturation: 100 });
                  }}
                  className="flex-none font-display text-[10px] uppercase cursor-pointer bg-transparent border-none ml-3"
                  style={{ color: "rgba(217,210,198,0.45)", letterSpacing: "0.06em" }}
                  title="Reset Scale, Rotate, Opacity and Saturation to their defaults"
                >
                  Reset
                </button>
              )}
            </div>
            {expanded.step3 && (
              <>
                <div className="text-xs mb-3 leading-relaxed" style={{ color: "rgba(217,210,198,0.45)" }}>
                  {adjustEnabled
                    ? "Fine-tune before generating — Scale resizes the placement box (drag it to reposition), Rotate/Opacity/Saturation apply to the design itself."
                    : "Draw a placement box on the stage to enable these — they lock once generated. Use Reposition to adjust again."}
                </div>
                <div style={{ opacity: effectiveDisabled ? 0.4 : 1, transition: "opacity 0.15s" }}>
                  <div className="flex flex-col gap-3.5">
                    <div>
                      <div className={rowLabel} style={{ color: "rgba(236,231,224,0.6)" }}>
                        <span>Scale</span>
                        <span>{boxScalePercent}%</span>
                      </div>
                      <input
                        type="range"
                        className="iv-slider"
                        min={50}
                        max={150}
                        value={boxScalePercent}
                        disabled={effectiveDisabled}
                        onChange={(e) => onSetBoxScale(Number(e.target.value))}
                      />
                    </div>
                    <div>
                      <div className={rowLabel} style={{ color: "rgba(236,231,224,0.6)" }}>
                        <span>Rotate</span>
                        <span>{effectiveAdjust.rotate}&deg;</span>
                      </div>
                      <input
                        type="range"
                        className="iv-slider"
                        min={-45}
                        max={45}
                        value={effectiveAdjust.rotate}
                        disabled={effectiveDisabled}
                        onChange={(e) => handleAdjustChange({ rotate: Number(e.target.value) })}
                      />
                    </div>
                    <div>
                      <div className={rowLabel} style={{ color: "rgba(236,231,224,0.6)" }}>
                        <span>Ink Opacity</span>
                        <span>{effectiveAdjust.opacity}%</span>
                      </div>
                      <input
                        type="range"
                        className="iv-slider"
                        min={20}
                        max={100}
                        value={effectiveAdjust.opacity}
                        disabled={effectiveDisabled}
                        onChange={(e) => handleAdjustChange({ opacity: Number(e.target.value) })}
                      />
                    </div>
                    <div>
                      <div className={rowLabel} style={{ color: "rgba(217,210,198,0.6)" }}>
                        <span>Saturation</span>
                        <span>{effectiveAdjust.saturation}%</span>
                      </div>
                      <input
                        type="range"
                        className="iv-slider"
                        min={0}
                        max={100}
                        value={effectiveAdjust.saturation}
                        disabled={effectiveDisabled}
                        onChange={(e) => handleAdjustChange({ saturation: Number(e.target.value) })}
                      />
                      <div
                        className="flex justify-between font-mono uppercase mt-1"
                        style={{ fontSize: 10, letterSpacing: "0.06em", color: "rgba(217,210,198,0.3)" }}
                      >
                        <span>Grayscale</span>
                        <span>Vibrant</span>
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
