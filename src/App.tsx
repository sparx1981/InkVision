import React, { useEffect, useRef, useState } from "react";
import {
  AngleResult,
  BasePhoto,
  ConfirmChoice,
  DesignAdjust,
  DesignSourceMode,
  HistoryEntry,
  PlacementBox,
  PortfolioItem,
  TattooAnalysis,
  TattooDesign,
  SavedProject
} from "./types";
import { PROMPT_SUGGESTIONS } from "./data/defaultAssets";
import { generateTattooStencil } from "./utils/stencil";
import { getImageOrientation, extractMaskedPatch, compositePatchWithAdjust, transformDesignGraphic, burnPlacementMarker, trimToContent, loadImage, cropToBox, burnSkinMask } from "./utils/imageCompose";
import { generateShareQrCode, buildTattooistShareUrl, downloadProjectZip, downloadImagesZip } from "./utils/tattooistShare";
import TattooStage from "./components/TattooStage";
import TattooControlPanel from "./components/TattooControlPanel";
import { CheckCircle, AlertTriangle, Loader2, Share2, Copy, ChevronLeft, ChevronRight, Heart } from "lucide-react";
import landingBackground from "./assets/background.jpg";
import { useAuth } from "./AuthContext";
import AuthScreen from "./AuthScreen";
import AdminPanel from "./AdminPanel";
import PricingModal from "./PricingModal";
import AccountMenu from "./AccountMenu";
import LoadProjectModal from "./LoadProjectModal";
import { signOutUser, getIdToken, db } from "./firebase";
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, increment } from "firebase/firestore";

const MAX_ANGLES = 4;
const DEFAULT_PLACEMENT_BOX: PlacementBox = { x: 29, y: 20, width: 42, height: 56 };
const DEFAULT_ADJUST: DesignAdjust = { scale: 100, rotate: 0, opacity: 100, saturation: 100, offsetX: 0, offsetY: 0 };

const readFileAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

/**
 * Parses a fetch Response as JSON, but fails with a clear message instead of
 * a cryptic "Unexpected token '<'" parse error if the server ever returns
 * something else (e.g. an HTML error page for an oversized request).
 */
const safeJson = async (res: Response): Promise<any> => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      res.status === 413
        ? "This project is too large to save/load. Try removing some history entries or unused angle photos."
        : `The server returned an unexpected response (status ${res.status}). Please try again.`
    );
  }
};

export default function App() {
  const { user, loading: authLoading, profile: userProfile, refreshProfile } = useAuth();
  const [showAuthScreen, setShowAuthScreen] = useState(false);
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [showPricingModal, setShowPricingModal] = useState(false);
  const [showLoadProjectModal, setShowLoadProjectModal] = useState(false);

  // Tattooist share view — a read-only page for anyone opening a ?share=CODE link/QR.
  const [tattooistShareCode] = useState<string | null>(() => new URLSearchParams(window.location.search).get("share"));
  const [tattooistProject, setTattooistProject] = useState<SavedProject | null>(null);
  const [tattooistLoading, setTattooistLoading] = useState(false);
  const [tattooistError, setTattooistError] = useState<string | null>(null);
  const [tattooistZipping, setTattooistZipping] = useState(false);

  // Navigation & Landing Page States
  const [isLanding, setIsLanding] = useState(true);

  // Once the user signs in from the auth screen, automatically proceed into the studio.
  useEffect(() => {
    if (user && showAuthScreen) {
      setShowAuthScreen(false);
      goToStudio();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // If the session ends (sign out, expired token) while inside the app,
  // return to the landing page rather than leaving them on a broken/empty
  // authenticated view. Skip this while auth is still resolving on first load.
  useEffect(() => {
    if (!authLoading && !user && !isLanding) {
      setIsLanding(true);
      setShowAdminPanel(false);
      setShowPortfolioPage(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, authLoading]);

  // The ONE way into the Studio, used everywhere (landing page, Portfolio's
  // "Studio" link, etc.) — always enforces sign-in first. Do not navigate to
  // the studio (setIsLanding(false)) any other way, or this check gets
  // bypassed, which is exactly the gap that let signed-out users reach the
  // Studio via Portfolio before.
  const goToStudio = () => {
    if (!user) {
      setShowAuthScreen(true);
      return;
    }
    setShowPortfolioPage(false);
    setBasePhotos([]);
    setActivePhotoId(null);
    setDesign({ src: null, name: "", sourceMode: "prompt", renderMode: "overlay" });
    resetGenerationState();
    resetAnalysisOnly();
    setProjectCode(null);
    setIsLanding(false);
  };

  const [projectCode, setProjectCode] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("My Tattoo Studio");
  const [loadCode, setLoadCode] = useState("");
  const [recentProjects, setRecentProjects] = useState<{ code: string; name: string }[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("iv_recent_projects") || "[]");
    } catch {
      return [];
    }
  });

  const handleClearRecents = () => {
    setRecentProjects([]);
    localStorage.removeItem("iv_recent_projects");
  };

  // Sharing with a tattooist — QR code + link for the currently saved project
  const [shareQrCode, setShareQrCode] = useState<string | null>(null);

  // Clean-slate Initial Workspace States (zero placeholder images)
  const [basePhotos, setBasePhotos] = useState<BasePhoto[]>([]);
  const [activePhotoId, setActivePhotoId] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<DesignSourceMode>("prompt");
  const [prompt, setPrompt] = useState("");
  const [style, setStyle] = useState("fineline blackwork");
  const [colorPreference, setColorPreference] = useState("monochrome");
  const [uploadedDesignSrc, setUploadedDesignSrc] = useState<string | null>(null);

  // --- Portfolio: shared community gallery, browsable from Step 02 or the full page ---
  const [showPortfolioPage, setShowPortfolioPage] = useState(false);
  const [portfolioItems, setPortfolioItems] = useState<PortfolioItem[]>([]);
  const [portfolioLoading, setPortfolioLoading] = useState(false);
  const [selectedPortfolioId, setSelectedPortfolioId] = useState<string | null>(null);
  const [portfolioDesignSrc, setPortfolioDesignSrc] = useState<string | null>(null);
  const [portfolioSort, setPortfolioSort] = useState<"likes" | "newest">("likes");
  const [portfolioSearch, setPortfolioSearch] = useState("");
  const [portfolioModalItem, setPortfolioModalItem] = useState<PortfolioItem | null>(null);

  const [coverUp, setCoverUp] = useState(false);
  const [adjust, setAdjust] = useState<DesignAdjust>({ scale: 100, rotate: 0, opacity: 85, saturation: 100, offsetX: 0, offsetY: 0 });

  // "Upload Image" tab result (manual overlay, unchanged mechanic)
  const [design, setDesign] = useState<TattooDesign>({ src: null, name: "", sourceMode: "prompt", renderMode: "overlay" });

  const [sliderX, setSliderX] = useState(48);
  const [generating, setGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState<{ current: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // --- "Generate from Prompt" — isolated design + per-angle manual placement ---
  const [isolatedDesignSrc, setIsolatedDesignSrc] = useState<string | null>(null);
  // Each photo's own in-progress placement box, keyed by photo id, so switching
  // angles never loses the box you drew for another angle.
  const [draftPlacementBoxes, setDraftPlacementBoxes] = useState<Record<string, PlacementBox>>({});
  const [draftAdjust, setDraftAdjustState] = useState<Record<string, DesignAdjust>>({});
  const [angleResults, setAngleResults] = useState<Record<string, AngleResult>>({});
  // Which photos have been placed+composited for the CURRENT design round —
  // every angle needs its own manual placement, so this resets each new round.
  const [placedThisRound, setPlacedThisRound] = useState<Record<string, boolean>>({});
  // A lightweight "yes, this box is right" signal the user can give without
  // paying for a full generation — clears the warning icon on that angle.
  const [confirmedPlacementIds, setConfirmedPlacementIds] = useState<Record<string, boolean>>({});
  // Set when the user explicitly asks to reposition an already-completed angle.
  const [repositioningPhotoId, setRepositioningPhotoId] = useState<string | null>(null);

  // --- Phase 1 analysis + confirmation ---
  const [analysisState, setAnalysisState] = useState<TattooAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisConfirmed, setAnalysisConfirmed] = useState(false);
  const [confirmChoice, setConfirmChoice] = useState<ConfirmChoice>("A");
  const [correctionText, setCorrectionText] = useState("");

  // "Inspire me" — tailored ideas + a clarifying question, fetched once per confirmed analysis.
  const [ideas, setIdeas] = useState<string[] | null>(null);
  const [ideasIdx, setIdeasIdx] = useState(0);
  const [ideasLoading, setIdeasLoading] = useState(false);
  const [clarifyingQuestion, setClarifyingQuestion] = useState<{ question: string; options: string[] } | null>(null);
  const [selectedClarifyingOption, setSelectedClarifyingOption] = useState<string | null>(null);

  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [currentEntryId, setCurrentEntryId] = useState<string>("");
  const [showHistory, setShowHistory] = useState(true);

  // Modals & Exporters
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [stencilSrc, setStencilSrc] = useState<string | null>(null);
  const [stencilLoading, setStencilLoading] = useState(false);
  const [templateShadedSrc, setTemplateShadedSrc] = useState<string | null>(null);
  const [enlargedTemplateImage, setEnlargedTemplateImage] = useState<{ src: string; label: string } | null>(null);

  const [showReferenceSheetModal, setShowReferenceSheetModal] = useState(false);
  const [referenceSheetSrc, setReferenceSheetSrc] = useState<string | null>(null);
  const [referenceSheetLoading, setReferenceSheetLoading] = useState(false);

  const [toastMsg, setToastMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (toastMsg) {
      const timer = setTimeout(() => setToastMsg(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [toastMsg]);

  useEffect(() => {
    if (!tattooistShareCode) return;
    setTattooistLoading(true);
    setTattooistError(null);
    if (!db) {
      setTattooistError("Database is not configured.");
      setTattooistLoading(false);
      return;
    }
    getDoc(doc(db, "projects", tattooistShareCode.toUpperCase().trim()))
      .then((snap) => {
        if (!snap.exists()) {
          throw new Error("That project code wasn't found.");
        }
        setTattooistProject(snap.data() as SavedProject);
      })
      .catch((err) => setTattooistError(err.message || "That project code wasn't found."))
      .finally(() => setTattooistLoading(false));
  }, [tattooistShareCode]);

  const handleDownloadTattooistZip = async () => {
    if (!tattooistProject) return;
    setTattooistZipping(true);
    try {
      await downloadProjectZip(tattooistProject);
    } catch {
      setTattooistError("Failed to build the ZIP download. You can still download files individually below.");
    } finally {
      setTattooistZipping(false);
    }
  };

  const activePhoto = basePhotos.find((p) => p.id === activePhotoId) || null;
  const currentAngleResult = activePhotoId ? angleResults[activePhotoId] || null : null;
  // Upload/Portfolio designs now go through the same real AI compositing
  // pipeline as Generate ("prompt"), so a result always lands in angleResults
  // regardless of source tab — no more special-casing "upload" here.
  const hasResult = !!currentAngleResult;
  const placementBox = (activePhotoId && draftPlacementBoxes[activePhotoId]) || DEFAULT_PLACEMENT_BOX;
  const setPlacementBox = (box: PlacementBox) => {
    if (!activePhotoId) return;
    setDraftPlacementBoxes((prev) => ({ ...prev, [activePhotoId]: box }));
    setConfirmedPlacementIds((prev) => {
      if (!prev[activePhotoId]) return prev;
      const copy = { ...prev };
      delete copy[activePhotoId];
      return copy;
    });
  };
  const activePhotoDraftAdjust = (activePhotoId && draftAdjust[activePhotoId]) || DEFAULT_ADJUST;
  const setActiveDraftAdjust = (patch: Partial<DesignAdjust>) => {
    if (!activePhotoId) return;
    setDraftAdjustState((prev) => ({ ...prev, [activePhotoId]: { ...(prev[activePhotoId] || DEFAULT_ADJUST), ...patch } }));
  };
  // Scale resizes the REAL placement box directly (same one you can drag) —
  // single source of truth, so the live preview and the actual generation call
  // can never disagree. Rotate/Opacity/Saturation pre-transform the flat
  // design graphic itself, unrelated to box coordinates.
  const DEFAULT_BOX_REFERENCE_WIDTH = 42; // matches DEFAULT_PLACEMENT_BOX.width — the "100%" scale reference
  const activeBoxScalePercent = Math.round((placementBox.width / DEFAULT_BOX_REFERENCE_WIDTH) * 100);
  const setActiveBoxScale = (scalePercent: number) => {
    const cx = placementBox.x + placementBox.width / 2;
    const cy = placementBox.y + placementBox.height / 2;
    const aspect = placementBox.height / placementBox.width || 1;
    // Cap at 100 so the box itself never exceeds the frame's own dimensions —
    // a design can still be scaled up a lot, but not literally larger than
    // the photo it's being drawn on.
    const newWidth = Math.min(100, Math.max(5, (scalePercent / 100) * DEFAULT_BOX_REFERENCE_WIDTH));
    const newHeight = Math.min(100, Math.max(5, newWidth * aspect));
    // Keep the box fully on-canvas when the Scale slider is what's driving the
    // resize — growing around the box's own center is fine, but if that would
    // push an edge past the frame, shift the box back in bounds instead of
    // letting it spill off-frame by accident. This was a real bug: scaling a
    // box up while it sat near an edge could silently push it past 100%,
    // which the off-frame "show only a partial/cropped view" prompt logic
    // then treated as a deliberate anatomical partial-view request, producing
    // broken/ghosted results instead of "just a bigger tattoo." Deliberate
    // off-frame placement is still possible by dragging the box directly on
    // the stage (that path is intentionally left unclamped).
    let x = cx - newWidth / 2;
    let y = cy - newHeight / 2;
    x = Math.max(0, Math.min(x, 100 - newWidth));
    y = Math.max(0, Math.min(y, 100 - newHeight));
    setPlacementBox({ x, y, width: newWidth, height: newHeight });
  };

  // The selected (not yet applied) design for Upload/Portfolio tabs — used
  // both to gate placement and to preview inside the draggable box.
  const legacyDesignSrc = activeTab === "portfolio" ? portfolioDesignSrc : activeTab === "upload" ? uploadedDesignSrc : null;

  // Every angle needs its own manual placement before it shows a result — no
  // more auto-suggestion. This now applies uniformly across all three source
  // tabs: Upload/Portfolio designs go through the exact same real AI
  // compositing pass (Stage B) as Generate does, just skipping the Stage A
  // isolated-design-generation step since the design image already exists.
  const needsPlacement =
    !!activePhotoId &&
    (activeTab === "prompt" || !!legacyDesignSrc) &&
    (!placedThisRound[activePhotoId] || repositioningPhotoId === activePhotoId);

  // The placement box is now the design's own layer, not an independent shape
  // the design merely previews inside of — so whenever a (now-trimmed) design
  // is freshly selected for an angle that doesn't already have its own box
  // (a brand new angle, or one mid-Reposition that already restored its prior
  // box — see handleRepositionAngle), size a fresh box to match that design's
  // real aspect ratio instead of leaving it at a generic default shape.
  // PlacementBoxEditor's resize handles then preserve this aspect through any
  // drag/resize the user does afterward, so the box can never drift out of
  // sync with the design again the way an independently-shaped box could.
  useEffect(() => {
    const currentDesignSrc = activeTab === "prompt" ? isolatedDesignSrc : legacyDesignSrc;
    if (!currentDesignSrc || !activePhotoId || !activePhoto || !needsPlacement) return;
    let cancelled = false;
    (async () => {
      try {
        const [photoImg, designImg] = await Promise.all([loadImage(activePhoto.src), loadImage(currentDesignSrc)]);
        if (cancelled) return;
        const photoW = photoImg.naturalWidth || photoImg.width;
        const photoH = photoImg.naturalHeight || photoImg.height;
        const designW = designImg.naturalWidth || designImg.width;
        const designH = designImg.naturalHeight || designImg.height;

        const widthPct = DEFAULT_BOX_REFERENCE_WIDTH;
        const widthPx = (widthPct / 100) * photoW;
        const heightPx = widthPx * (designH / designW);
        const heightPct = (heightPx / photoH) * 100;
        const x = Math.max(0, Math.min(50 - widthPct / 2, 100 - widthPct));
        const y = Math.max(0, Math.min(50 - heightPct / 2, 100 - heightPct));

        setDraftPlacementBoxes((prev) => {
          if (prev[activePhotoId]) return prev; // already has a box (user-drawn, or restored by Reposition) — don't clobber it
          return { ...prev, [activePhotoId]: { x, y, width: widthPct, height: heightPct } };
        });
      } catch {
        // Not worth surfacing an error for this — worst case the box just
        // keeps its generic default shape and the user resizes it by hand.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab === "prompt" ? isolatedDesignSrc : legacyDesignSrc, activePhotoId, needsPlacement]);

  // ---------------------------------------------------------------------
  // Resets
  // ---------------------------------------------------------------------
  const resetAnalysisOnly = () => {
    setAnalysisState(null);
    setAnalyzing(false);
    setAnalysisConfirmed(false);
    setConfirmChoice("A");
    setCorrectionText("");
    setIdeas(null);
    setIdeasIdx(0);
    setClarifyingQuestion(null);
    setSelectedClarifyingOption(null);
  };

  const resetGenerationState = () => {
    setIsolatedDesignSrc(null);
    setDraftPlacementBoxes({});
    setDraftAdjustState({});
    setAngleResults({});
    setPlacedThisRound({});
    setConfirmedPlacementIds({});
    setRepositioningPhotoId(null);
    setReferenceSheetSrc(null);
  };

  const handleSelectBasePhoto = (id: string) => {
    setActivePhotoId(id);
    setRepositioningPhotoId(null);
    // Note: intentionally not resetting the placement box here — each photo
    // keeps its own draft box in `draftPlacementBoxes`, so switching angles
    // never loses a box you've already drawn.
  };

  const handleRemoveBasePhoto = (id: string) => {
    const remaining = basePhotos.filter((p) => p.id !== id);
    setBasePhotos(remaining);
    setAngleResults((prev) => {
      if (!(id in prev)) return prev;
      const copy = { ...prev };
      delete copy[id];
      return copy;
    });
    setPlacedThisRound((prev) => {
      if (!(id in prev)) return prev;
      const copy = { ...prev };
      delete copy[id];
      return copy;
    });
    if (activePhotoId === id) {
      setActivePhotoId(remaining.length > 0 ? remaining[0].id : null);
    }
    setToastMsg({ type: "success", text: "Photo removed." });
  };

  const handleAddBasePhoto = async (file: File) => {
    if (basePhotos.length >= MAX_ANGLES) return;
    // The very first photo of a brand-new project (as opposed to adding
    // another angle to one already in progress) should start with a clean
    // slate — otherwise per-project toggles like Cover-Up can silently carry
    // over from whatever project was open earlier in the session.
    const isFirstPhotoOfProject = basePhotos.length === 0;
    try {
      const src = await readFileAsDataUrl(file);
      const angleNames = ["Primary Angle", "Angle 2", "Angle 3", "Angle 4"];
      const newPhoto: BasePhoto = {
        id: "angle-" + Date.now(),
        name: angleNames[basePhotos.length] || "New perspective",
        src
      };
      if (isFirstPhotoOfProject) {
        setCoverUp(false);
        // Same category of bug as Cover-Up: these all silently carried over
        // from whatever project was open earlier in the session, since
        // goToStudio's reset doesn't touch them. A brand-new project should
        // start with no design pre-selected and no history from a prior,
        // unrelated project.
        setUploadedDesignSrc(null);
        setPortfolioDesignSrc(null);
        setSelectedPortfolioId(null);
        setActiveTab("prompt");
        setHistory([]);
        setCurrentEntryId("");
      }
      setBasePhotos((prev) => [...prev, newPhoto]);
      setActivePhotoId(newPhoto.id);
      setToastMsg({ type: "success", text: "Added new perspective photo — draw its placement when you're ready." });
    } catch {
      setToastMsg({ type: "error", text: "Couldn't read that image file." });
    }
  };

  const handleUploadDesignFile = async (file: File) => {
    try {
      const src = await readFileAsDataUrl(file);
      // Trim to the design's actual visible content before it becomes the
      // placement layer — uploaded files frequently have extra white margin
      // or a non-tight crop around the artwork (see trimToContent's comment
      // for why this matters for placement accuracy).
      const trimmed = await trimToContent(src);
      setUploadedDesignSrc(trimmed);
      setToastMsg({ type: "success", text: "Reference tattoo design uploaded." });
    } catch {
      setToastMsg({ type: "error", text: "Couldn't read that design file." });
    }
  };

  // ---------------------------------------------------------------------
  // Portfolio — shared community gallery
  // ---------------------------------------------------------------------
  const fetchPortfolio = async () => {
    setPortfolioLoading(true);
    try {
      if (!db) throw new Error("Firestore is not configured.");
      const snap = await getDocs(collection(db, "portfolio"));
      const items = snap.docs.map(doc => doc.data() as PortfolioItem);
      
      const sorted = [...items].sort((a, b) => {
        if (b.likes !== a.likes) return b.likes - a.likes;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
      setPortfolioItems(sorted);
    } catch (err) {
      console.error("Error fetching portfolio client-side:", err);
    } finally {
      setPortfolioLoading(false);
    }
  };

  useEffect(() => {
    fetchPortfolio();
  }, []);

  const handleSetActiveTab = (tab: DesignSourceMode) => {
    setActiveTab(tab);
    if (tab === "portfolio") fetchPortfolio();
  };

  const handleOpenPortfolioPage = () => {
    setShowPortfolioPage(true);
    fetchPortfolio();
  };

  const handleSelectPortfolioItem = async (item: PortfolioItem) => {
    setSelectedPortfolioId(item.id);
    try {
      // Same content-trim as uploads — Portfolio designs are community
      // submissions and the tab's own UI already warns these aren't always
      // cropped tightly to their own artwork.
      const trimmed = await trimToContent(item.imageUrl);
      setPortfolioDesignSrc(trimmed);
    } catch {
      // If trimming fails for any reason (e.g. a transient load error), fall
      // back to the original image rather than blocking selection entirely.
      setPortfolioDesignSrc(item.imageUrl);
    }
    setToastMsg({ type: "success", text: `Using "${item.name}" from the portfolio.` });
  };

  const handleLikePortfolioItem = async (id: string) => {
    setPortfolioItems((prev) => prev.map((i) => (i.id === id ? { ...i, likes: i.likes + 1 } : i)));
    try {
      if (!db) return;
      await updateDoc(doc(db, "portfolio", id), {
        likes: increment(1)
      });
    } catch {
      // optimistic update already applied; a failed like isn't worth bothering the user about
    }
  };

  const helperText = `${basePhotos.length} angle${basePhotos.length === 1 ? "" : "s"} loaded · add more perspective angles for deeper simulation`;

  // ---------------------------------------------------------------------
  // Phase 1 — Analyze / Confirm
  // ---------------------------------------------------------------------
  // Fired automatically in the background the moment a photo becomes active
  // (see the useEffect below), instead of being awaited synchronously the
  // first time Generate/Inspire Me/Multi-Pose Reference needs it. That used
  // to put a live Gemini call directly in the critical path of every single
  // "Generate Preview" click — if the analysis call is what happened to hit
  // Google's occasional transient instability, the whole generation attempt
  // felt like it failed even though nothing about generation itself was
  // broken. Now it's already cached in `analysisState` (or has already
  // failed quietly) well before the user gets there. Still safe to call
  // on-demand too (Inspire Me, Re-analyze, Multi-Pose Reference) — it
  // short-circuits instantly on a cache hit, and only actually re-fetches if
  // the background attempt hasn't finished or hasn't started yet (e.g. this
  // is the very first photo and the effect hasn't run yet on this render).
  const ensureAnalysis = async (opts: { silent?: boolean } = {}): Promise<TattooAnalysis | null> => {
    if (analysisState) return analysisState;
    if (!activePhoto) return null;
    setAnalyzing(true);
    if (!opts.silent) setError(null);
    try {
      const otherAngles = basePhotos.filter((p) => p.id !== activePhotoId).map((p) => p.src);
      const images = [activePhoto.src, ...otherAngles].slice(0, 4);
      const res = await fetch("/api/analyze-tattoo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images })
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data.error || "Failed to analyze the photo.");
      const result: TattooAnalysis = {
        bodyPart: data.bodyPart,
        theme: data.theme,
        description: data.description || "",
        anglesConsistent: data.anglesConsistent,
        anglesNote: data.anglesNote || ""
      };
      setAnalysisState(result);
      setAnalysisConfirmed(true);
      setConfirmChoice("A");
      setCorrectionText("");
      return result;
    } catch (err: any) {
      const message = err.message || "Couldn't read your photo automatically — you can still describe your tattoo and generate.";
      if (opts.silent) {
        // A background-triggered attempt shouldn't surface a persistent error
        // banner before the user has even tried to do anything — the server
        // already retries transient errors a couple of times on its own
        // (see generateContentWithRetry), so a failure here means it's
        // genuinely down. A quiet toast is enough; Generate still has its
        // own fallback + notice if analysis never lands in time.
        setToastMsg({ type: "error", text: "Couldn't analyze your photo automatically in the background — it'll use general context when you generate." });
      } else {
        setError(message);
      }
      return null;
    } finally {
      setAnalyzing(false);
    }
  };

  // Kicks analysis off the moment a photo becomes the active one (typically
  // right after upload) rather than waiting for the user to click Generate —
  // see the comment on ensureAnalysis above for why this moved out of the
  // generate critical path.
  useEffect(() => {
    if (activePhotoId && !analysisState && !analyzing) {
      ensureAnalysis({ silent: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePhotoId, basePhotos.length]);

  const handleReanalyze = async () => {
    setAnalysisState(null);
    setAnalysisConfirmed(false);
    setIdeas(null);
    setClarifyingQuestion(null);
    setSelectedClarifyingOption(null);
    await ensureAnalysis();
  };

  // ---------------------------------------------------------------------
  // Stage A (isolated design, once per round) + Stage B (photorealistic
  // blend, once per angle). Every angle must be manually confirmed first —
  // no AI-guessed placement — but one click here generates all of them.
  // ---------------------------------------------------------------------
  const generateOneAngle = async (photo: BasePhoto, designSrc: string, box: PlacementBox, analysis: TattooAnalysis) => {
    const existingEntry = angleResults[photo.id];
    const isRepositioningCurrentRound = repositioningPhotoId === photo.id && !!existingEntry && !!placedThisRound[photo.id];
    const baseForBlend = isRepositioningCurrentRound
      ? existingEntry.baseSrcForThisRound // redo this round's blend on the same pre-round base, don't double-apply
      : existingEntry?.src || photo.src; // continue from a previous round's result, or start fresh
    const orientation = await getImageOrientation(baseForBlend);

    // Rotate/Opacity/Saturation pre-transform the flat design graphic itself
    // BEFORE it's ever sent to the AI — rotation never touches a photo this
    // way, so there's nothing for it to drag or warp. Scale/position are
    // already baked into `box` directly (it's the same box you can drag).
    const angleAdjust = draftAdjust[photo.id] || DEFAULT_ADJUST;
    const transformedDesignSrc = await transformDesignGraphic(designSrc, {
      rotate: angleAdjust.rotate,
      opacity: angleAdjust.opacity,
      saturation: angleAdjust.saturation
    });

    // `box` IS the design's own placement layer now (not an independent shape
    // it merely previews inside of) — the design is trimmed to its real
    // content bounds the moment it's selected, and PlacementBoxEditor's
    // resize handles keep the box locked to that same aspect ratio through
    // any drag/resize. So `box` can be used directly everywhere downstream
    // that needs to know where the design sits: the burned-in marker, the
    // prompt's region description, and the feather mask/final crop. No
    // separate contain-fit derivation needed — what the user saw and placed
    // is exactly what's sent.
    const containBox = box;

    // Get a real measured skin/ink/background signal for the marked region
    // instead of leaving the blend model to infer it from the photo through
    // text alone, and burn it in as a visible tint — the same "pixels beat
    // prose" principle as the corner-bracket placement marker. Runs
    // regardless of Cover-Up mode now: Cover-Up-off gets a GREEN "safe to
    // place" tint over confirmed open skin (as before), Cover-Up-on gets a
    // RED "never place here" tint over confirmed non-body background —
    // previously Cover-Up-on generations had no grounding at all about where
    // the body actually ends, the likely cause of designs rendering
    // "floating" over background near the edge of a box drawn close to the
    // limb's own silhouette. Best-effort: if this fails for any reason
    // (transient Gemini issue, malformed response), fall back silently to
    // the existing text-only instructions rather than blocking generation on
    // a non-critical enhancement.
    let regionMaskApplied = false;
    let baseForMarking = baseForBlend;
    try {
      const croppedRegion = await cropToBox(baseForBlend, containBox);
      const resSkin = await fetch("/api/detect-skin-regions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ croppedImage: croppedRegion })
      });
      const dataSkin = await safeJson(resSkin);
      if (resSkin.ok && Array.isArray(dataSkin.cells) && dataSkin.rows && dataSkin.cols) {
        baseForMarking = await burnSkinMask(baseForBlend, containBox, dataSkin.cells, dataSkin.rows, dataSkin.cols, coverUp);
        regionMaskApplied = true;
      }
    } catch {
      // Silent fallback — see comment above.
    }

    // Burn the placement marker onto a COPY of the base photo's pixels (on
    // top of the region mask tint, if one was applied) before it goes to the
    // AI — a visual marker the model can actually see, instead of relying
    // only on a text description of the region (see burnPlacementMarker's own
    // comment for why). The untouched `baseForBlend` is still what every later
    // step (masked patch extraction, Adjustments, history) is built from —
    // only this one outgoing request uses the marked copy.
    const markedBaseSrc = await burnPlacementMarker(baseForMarking, containBox);

    // One full generation attempt: call the blend API, then hard-mask the
    // result back onto baseForBlend so anything outside containBox is
    // guaranteed pixel-identical to the original (not just a prompt request,
    // an actual client-side guarantee — see extractMaskedPatch).
    const runOneAttempt = async (): Promise<string> => {
      const res2 = await fetch("/api/composite-photorealistic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseImage: markedBaseSrc,
          designImage: transformedDesignSrc,
          placementBox: containBox,
          bodyPart: analysis.bodyPart,
          theme: analysis.theme,
          description: analysis.description,
          confirmChoice,
          correction: correctionText,
          coverUp,
          skinMaskApplied: regionMaskApplied,
          aspectRatio: orientation.aspectRatio,
          // Only Stage-A generated designs are guaranteed to already be isolated
          // on a clean white background. Uploaded reference images can have any
          // backdrop, so flag those explicitly and let the blend prompt strip
          // the background out instead of pasting it in as a flat sticker.
          designIsPreIsolated: activeTab !== "upload"
        })
      });
      const data2 = await safeJson(res2);
      if (!res2.ok) throw new Error(data2.error || `Failed to generate the composite for ${photo.name}.`);
      const patchSrc = await extractMaskedPatch(baseForBlend, data2.imageUrl, containBox);
      return compositePatchWithAdjust(baseForBlend, patchSrc, containBox, DEFAULT_ADJUST);
    };

    let flattenedSrc = await runOneAttempt();

    // Post-generation sanity check (see /api/verify-tattoo-result). QA found
    // several distinct failure modes — a design rendering partially off-skin
    // over the background, a whole design silently missing from the final
    // result, a design landing somewhere other than the drawn box — that all
    // share one root cause: nothing ever actually confirmed the AI's output
    // landed a visible design on real skin inside the marked region before
    // accepting it. One retry on a "fail" verdict before giving up and
    // surfacing a warning; best-effort overall — if the verify call itself
    // errors, just trust the generation as before rather than blocking on a
    // non-critical check.
    let warning: string | undefined;
    try {
      const verify = async (afterSrc: string): Promise<{ verdict: "pass" | "fail"; reason: string }> => {
        const [beforeCrop, afterCrop] = await Promise.all([cropToBox(baseForBlend, containBox), cropToBox(afterSrc, containBox)]);
        const resVerify = await fetch("/api/verify-tattoo-result", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ beforeCrop, afterCrop, coverUp })
        });
        const dataVerify = await safeJson(resVerify);
        if (!resVerify.ok) throw new Error(dataVerify.error || "Verification failed.");
        return dataVerify;
      };

      let result = await verify(flattenedSrc);
      if (result.verdict === "fail") {
        flattenedSrc = await runOneAttempt();
        result = await verify(flattenedSrc);
        if (result.verdict === "fail") {
          warning = `This generation may not have applied cleanly${result.reason ? ` (${result.reason})` : ""} — try Reposition to regenerate this angle.`;
        }
      }
    } catch {
      // Best-effort — see comment above. Keep whatever flattenedSrc we already have.
    }

    const entry: AngleResult = {
      // Stored as the raw user-drawn box, not containBox — re-opening this
      // angle (Reposition) must show the box exactly as the user left it,
      // not the shrunk contain-fit rect computed from it.
      placementBox: box,
      src: flattenedSrc,
      baseSrcForThisRound: baseForBlend,
      ...(warning ? { warning } : {})
    };
    return entry;
  };

  const handleGenerateComposite = async () => {
    if (!activePhoto || !activePhotoId) return;
    if (activeTab === "prompt" && !prompt.trim()) {
      setError("Describe the new tattoo you want before generating.");
      return;
    }
    if (activeTab !== "prompt" && !legacyDesignSrc) {
      setError(
        activeTab === "portfolio"
          ? "Select a design from the portfolio before generating a preview."
          : "Upload a reference tattoo image before generating a preview."
      );
      return;
    }
    setGenerating(true);
    setError(null);
    try {
      // Analysis already runs automatically in the background as soon as a
      // photo is uploaded (see the useEffect above ensureAnalysis) — this just
      // reads whatever's ready right now rather than awaiting it here, so a
      // slow or flaky analysis call is never in the critical path of clicking
      // Generate. If it hasn't finished (or never landed), fall back to
      // generic context and let the model infer body part/style from the
      // photo it already receives directly, same as before analysis existed.
      const analysis = analysisState || {
        bodyPart: "the marked body part shown in the reference photo",
        theme: "unspecified — infer style and any existing ink directly from the reference photo",
        description: ""
      };
      if (!analysisState) {
        setToastMsg({
          type: "error",
          text: analyzing
            ? "Still analyzing your photo in the background — generating with general context for now."
            : "Couldn't analyze your photo automatically — continuing without it."
        });
      }

      // Stage A — generate the isolated design once per round (skip if already
      // made this round). Upload/Portfolio designs are already a finished
      // image chosen by the person — they skip Stage A entirely and go
      // straight into Stage B (the real photorealistic blend) using that
      // image directly, rather than the old flat client-side overlay.
      let designSrc: string | null = activeTab === "prompt" ? isolatedDesignSrc : legacyDesignSrc;
      if (activeTab === "prompt" && !designSrc) {
        // Client-side allowance gate (the server enforces this too — this just
        // avoids an unnecessary round-trip). Admins and anyone with a
        // non-null limit (paid tiers) always bypass this.
        if (userProfile && userProfile.role !== "admin" && userProfile.tier === "free" && userProfile.generationLimit !== null) {
          if (userProfile.generationsThisPeriod >= userProfile.generationLimit) {
            setError("You've used your free generation(s) for this period. Upgrade to keep generating designs.");
            setToastMsg({ type: "error", text: "Free generation limit reached — upgrade to continue." });
            setShowPricingModal(true);
            return;
          }
        }

        const idToken = await getIdToken();
        if (!idToken) {
          setError("Please sign in to generate a design.");
          return;
        }
        const res = await fetch("/api/generate-tattoo-design", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
          body: JSON.stringify({
            bodyPart: analysis.bodyPart,
            theme: analysis.theme,
            description: analysis.description,
            correction: correctionText,
            prompt,
            style,
            colorPreference,
            referenceImage: activePhoto.src
          })
        });
        const data = await safeJson(res);
        if (!res.ok) {
          if (data.upgradeRequired) {
            setToastMsg({ type: "error", text: data.error });
            setShowPricingModal(true);
          }
          throw new Error(data.error || "Failed to generate the tattoo design.");
        }
        // Trim any margin Gemini left around the isolated design before it
        // becomes the placement layer — same reasoning as Upload/Portfolio,
        // Stage A's forced 1:1 square output isn't guaranteed to have the
        // artwork touch every edge.
        designSrc = await trimToContent(data.imageUrl);
        setIsolatedDesignSrc(designSrc);

        // Usage + portfolio publishing already happened server-side (in the
        // /api/generate-tattoo-design handler) — just refresh our local view
        // of both rather than writing to Firestore again from the client.
        await refreshProfile();
        fetchPortfolio(); // this generation just auto-published a new design — refresh the list
      }

      // Keep the legacy `design` field populated for every tab (not just
      // "prompt") purely as metadata for downstream consumers that still
      // read it — export/download fallbacks and the tattooist share view's
      // "Reference Design" file. It's no longer used to render the on-screen
      // preview (that always comes from angleResults now).
      setDesign({
        src: designSrc,
        name: activeTab === "portfolio" ? "Portfolio design" : activeTab === "upload" ? "Uploaded design" : "Generated design",
        sourceMode: activeTab,
        renderMode: "overlay"
      });

      // Repositioning a single already-generated angle only regenerates that one.
      // Otherwise, generate every angle that's confirmed but not yet placed —
      // this is the "one click, every angle" batch.
      const targets = repositioningPhotoId
        ? basePhotos.filter((p) => p.id === repositioningPhotoId)
        : basePhotos.filter((p) => !placedThisRound[p.id]);

      let updatedResults = { ...angleResults };
      for (let i = 0; i < targets.length; i++) {
        const photo = targets[i];
        if (targets.length > 1) setGenerationProgress({ current: i + 1, total: targets.length });
        const box = draftPlacementBoxes[photo.id] || DEFAULT_PLACEMENT_BOX;
        const entry = await generateOneAngle(photo, designSrc as string, box, analysis);
        updatedResults[photo.id] = entry;
      }
      setGenerationProgress(null);
      setAngleResults(updatedResults);
      setPlacedThisRound((prev) => {
        const next = { ...prev };
        for (const photo of targets) next[photo.id] = true;
        return next;
      });
      setRepositioningPhotoId(null);
      setSliderX(45);

      // Surface the post-generation verification warning (see generateOneAngle
      // / /api/verify-tattoo-result) as a non-blocking heads-up rather than
      // silently accepting a result that couldn't be confirmed clean — this is
      // what actually would have caught the "Add Another Tattoo" round
      // silently dropping the second design in QA, instead of the user only
      // noticing later.
      const flaggedAngle = targets.find((p) => updatedResults[p.id]?.warning);
      if (flaggedAngle) {
        setToastMsg({ type: "error", text: updatedResults[flaggedAngle.id]!.warning! });
      }

      pushHistoryEntry({
        thumbnailSrc: updatedResults[activePhotoId]?.src || null,
        kind: activeTab,
        coverUp,
        sliderX: 45,
        basePhotoId: activePhotoId,
        isolatedDesignSrc: designSrc as string,
        angleResults: updatedResults
      });
    } catch (err: any) {
      setError(err.message || "Failed to generate the composite.");
    } finally {
      setGenerating(false);
      setGenerationProgress(null);
    }
  };

  const handleRepositionAngle = (photoId: string) => {
    const entry = angleResults[photoId];
    setDraftPlacementBoxes((prev) => ({ ...prev, [photoId]: entry ? entry.placementBox : DEFAULT_PLACEMENT_BOX }));
    // Start each reposition session with a clean slate — the box carries over
    // from last time, but rotate/opacity/saturation reset since they'll be
    // freshly re-applied to the design graphic on the next commit.
    setDraftAdjustState((prev) => ({ ...prev, [photoId]: DEFAULT_ADJUST }));
    setRepositioningPhotoId(photoId);
  };

  const handleCancelReposition = () => {
    setRepositioningPhotoId(null);
  };

  // Pre-commit nudge — purely local state, no API call and no canvas work.
  // The live preview (CSS transform on the flat design graphic) reads this
  // directly; it only gets baked into an actual image at Generate time.
  const handleSetDraftAdjust = (photoId: string, patch: Partial<DesignAdjust>) => {
    setDraftAdjustState((prev) => ({ ...prev, [photoId]: { ...(prev[photoId] || DEFAULT_ADJUST), ...patch } }));
  };

  const handleConfirmPlacement = (photoId: string) => {
    setConfirmedPlacementIds((prev) => ({ ...prev, [photoId]: true }));
    setToastMsg({ type: "success", text: "Placement confirmed for this angle." });
  };

  const handleAddAnotherTattoo = () => {
    setPrompt("");
    setIsolatedDesignSrc(null);
    setDraftPlacementBoxes({});
    setDraftAdjustState({});
    setPlacedThisRound({});
    setConfirmedPlacementIds({});
    setRepositioningPhotoId(null);
    setReferenceSheetSrc(null);
    setToastMsg({
      type: "success",
      text:
        activeTab === "prompt"
          ? "Describe the next tattoo, then draw its placement on each angle you want it to appear on."
          : "Pick or upload the next design, then draw its placement on each angle you want it to appear on."
    });
  };

  const handleResetChain = () => {
    resetGenerationState();
    resetAnalysisOnly();
    setToastMsg({ type: "success", text: "Reset — starting fresh from the original photos." });
  };

  // ---------------------------------------------------------------------
  // "Inspire me" — tailored ideas
  // ---------------------------------------------------------------------
  const handleFetchIdeas = async () => {
    if (ideas && ideas.length > 0) {
      const next = (ideasIdx + 1) % ideas.length;
      setIdeasIdx(next);
      setPrompt(ideas[next]);
      return;
    }

    setIdeasLoading(true);
    try {
      const analysis = await ensureAnalysis();
      if (!analysis) throw new Error("Couldn't analyze your photo to tailor ideas.");
      const res = await fetch("/api/suggest-tattoo-ideas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bodyPart: analysis.bodyPart,
          theme: analysis.theme,
          description: analysis.description,
          correction: correctionText
        })
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data.error || "Failed to fetch tattoo ideas.");

      const fetchedIdeas: string[] = data.ideas && data.ideas.length > 0 ? data.ideas : PROMPT_SUGGESTIONS;
      setIdeas(fetchedIdeas);
      setIdeasIdx(0);
      setClarifyingQuestion(data.clarifyingQuestion || null);
      setSelectedClarifyingOption(null);
      setPrompt(fetchedIdeas[0]);
    } catch (err: any) {
      setIdeas(PROMPT_SUGGESTIONS);
      setIdeasIdx(0);
      setPrompt(PROMPT_SUGGESTIONS[0]);
      setToastMsg({ type: "error", text: err.message || "Couldn't fetch tailored ideas — showing general suggestions instead." });
    } finally {
      setIdeasLoading(false);
    }
  };

  const handleSelectClarifyingOption = (option: string) => {
    setSelectedClarifyingOption(option);
    setPrompt((prev) => (prev.trim() ? `${prev.trim()} (leaning toward: ${option})` : `Leaning toward: ${option}`));
  };

  // ---------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------
  const pushHistoryEntry = (partial: Omit<HistoryEntry, "id" | "label">) => {
    const entry: HistoryEntry = { id: "h-" + Date.now(), label: "v" + (history.length + 1), ...partial };
    setHistory((prev) => [...prev, entry].slice(-4));
    setCurrentEntryId(entry.id);
  };

  // Every source tab (Generate / Upload / Portfolio) now runs through the
  // same real AI compositing pipeline (handleGenerateComposite ->
  // generateOneAngle -> /api/composite-photorealistic) rather than Upload
  // and Portfolio taking a separate flat client-side CSS overlay shortcut.
  // That old "overlay" path never called Gemini at all, which is why
  // background removal / photorealistic blending / contour-wrap never
  // actually happened for uploaded reference designs — it wasn't a prompt
  // problem, the AI was simply never being invoked for that tab.
  const handleGenerate = async () => {
    if (generating || analyzing) return;
    setError(null);
    await handleGenerateComposite();
  };

  const handleSelectHistory = (entry: HistoryEntry) => {
    setCoverUp(entry.coverUp);
    setSliderX(entry.sliderX);
    setCurrentEntryId(entry.id);
    setAnalysisState(null);
    setAnalysisConfirmed(true); // this entry already went through analysis once

    if (entry.angleResults) {
      // Current-format entry — used by all three tabs now (Generate,
      // Upload, Portfolio all go through the same real AI pipeline).
      setActiveTab(entry.kind);
      setIsolatedDesignSrc(entry.isolatedDesignSrc || null);
      setAngleResults(entry.angleResults);
      setPlacedThisRound(
        Object.keys(entry.angleResults).reduce((acc, id) => ({ ...acc, [id]: true }), {} as Record<string, boolean>)
      );
      setDraftPlacementBoxes(
        Object.entries(entry.angleResults).reduce(
          (acc, [id, result]) => ({ ...acc, [id]: result.placementBox }),
          {} as Record<string, PlacementBox>
        )
      );
      setDraftAdjustState({});
      setRepositioningPhotoId(null);
    } else if ((entry.kind === "upload" || entry.kind === "portfolio") && entry.design && entry.adjust) {
      // Legacy-format entry from before Upload/Portfolio used the real AI
      // pipeline (flat client-side overlay) — kept only so old saved
      // projects/history from before this fix still restore correctly.
      setActiveTab(entry.kind);
      setDesign(entry.design);
      setAdjust(entry.adjust);
    }

    if (entry.basePhotoId && basePhotos.some((p) => p.id === entry.basePhotoId)) {
      setActivePhotoId(entry.basePhotoId);
    }
  };

  // ---------------------------------------------------------------------
  // Cloud save/load
  // ---------------------------------------------------------------------
  const handleLoadProject = async (codeToLoad: string) => {
    const trimmed = codeToLoad.toUpperCase().trim();
    if (!trimmed) {
      setToastMsg({ type: "error", text: "Please enter a valid 6-digit access code." });
      return;
    }
    setToastMsg({ type: "success", text: `Retrieving project ${trimmed}...` });
    try {
      if (!db) throw new Error("Firestore is not configured.");
      const snap = await getDoc(doc(db, "projects", trimmed));
      if (!snap.exists()) {
        throw new Error("Project not found.");
      }

      const loaded: SavedProject = snap.data() as SavedProject;
      setBasePhotos(loaded.basePhotos || []);
      setActivePhotoId(loaded.activePhotoId || null);
      setDesign(loaded.design || { src: null, name: "", sourceMode: "prompt", renderMode: "overlay" });
      setAdjust(loaded.adjust || { scale: 100, rotate: 0, opacity: 85, saturation: 100, offsetX: 0, offsetY: 0 });
      setCoverUp(loaded.coverUp || false);
      setSliderX(loaded.sliderX || 48);
      setHistory(loaded.history || []);
      setProjectCode(loaded.code || trimmed);
      setProjectName(loaded.name || "My Saved Studio");

      setIsolatedDesignSrc(loaded.isolatedDesignSrc || null);
      setAngleResults(loaded.angleResults || {});
      setPlacedThisRound(
        Object.keys(loaded.angleResults || {}).reduce((acc, id) => ({ ...acc, [id]: true }), {} as Record<string, boolean>)
      );
      setDraftPlacementBoxes(
        Object.entries(loaded.angleResults || {}).reduce(
          (acc, [id, result]) => ({ ...acc, [id]: (result as AngleResult).placementBox }),
          {} as Record<string, PlacementBox>
        )
      );
      setDraftAdjustState({});
      setRepositioningPhotoId(null);
      setActiveTab(loaded.design?.src ? "upload" : "prompt");
      resetAnalysisOnly();
      setAnalysisConfirmed(!!(loaded.design?.src) || !!(loaded.angleResults && Object.keys(loaded.angleResults).length > 0));
      setIsLanding(false); // jump straight to active studio

      setRecentProjects((prev) => {
        const filtered = prev.filter((p) => p.code !== trimmed);
        const updated = [{ code: trimmed, name: loaded.name || "My Saved Studio" }, ...filtered].slice(0, 5);
        localStorage.setItem("iv_recent_projects", JSON.stringify(updated));
        return updated;
      });
      setToastMsg({ type: "success", text: "Session retrieved successfully!" });
    } catch (err: any) {
      setToastMsg({ type: "error", text: err.message || "Project code invalid." });
    }
  };

  const handleSaveProject = async () => {
    setSaving(true);
    try {
      if (!db) throw new Error("Firestore is not configured.");
      let code = projectCode;

      let isNewCode = false;
      if (!code) {
        isNewCode = true;
      } else {
        const snap = await getDoc(doc(db, "projects", code));
        if (!snap.exists()) {
          isNewCode = true;
        }
      }

      if (isNewCode) {
        const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        let attempt = 0;
        let exists = true;
        do {
          code = "";
          for (let i = 0; i < 6; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
          }
          const snap = await getDoc(doc(db, "projects", code));
          exists = snap.exists();
          attempt++;
        } while (exists && attempt < 100);
      }

      if (!code) throw new Error("Could not generate a unique project code.");

      const timestamp = new Date().toISOString();
      const projectRef = doc(db, "projects", code);
      const existingSnap = await getDoc(projectRef);
      const existingData = existingSnap.exists() ? existingSnap.data() : null;

      const payload: SavedProject & { ownerUid: string | null } = {
        code,
        name: projectName,
        basePhotos,
        activePhotoId,
        design,
        adjust,
        coverUp,
        sliderX,
        history,
        isolatedDesignSrc,
        angleResults,
        createdAt: existingData?.createdAt || timestamp,
        updatedAt: timestamp,
        // Needed for "Load Project" to find this user's own saves — without
        // this, every save was untagged and Load Project would always be empty.
        ownerUid: user?.uid || (existingData as any)?.ownerUid || null
      };

      await setDoc(projectRef, payload);

      setProjectCode(code);
      setShowSaveModal(true);
      setToastMsg({ type: "success", text: `Project saved! Share code: ${code}` });

      try {
        const qr = await generateShareQrCode(buildTattooistShareUrl(code));
        setShareQrCode(qr);
      } catch {
        setShareQrCode(null);
      }

      setRecentProjects((prev) => {
        const filtered = prev.filter((p) => p.code !== code);
        const updated = [{ code: code as string, name: projectName }, ...filtered].slice(0, 5);
        localStorage.setItem("iv_recent_projects", JSON.stringify(updated));
        return updated;
      });
    } catch (err: any) {
      setToastMsg({ type: "error", text: err.message || "Failed to save project." });
    } finally {
      setSaving(false);
    }
  };

  // ---------------------------------------------------------------------
  // Download / Export
  // ---------------------------------------------------------------------
  const handleDownloadMockup = () => {
    // Every tab now goes through the same real AI compositing pipeline, so
    // the modern path is always "download the real generated angle result."
    // The manual canvas re-composite below only remains as a fallback for
    // old-format history entries (design.src + adjust) saved before this fix.
    if (currentAngleResult) {
      const link = document.createElement("a");
      link.download = `inkvision-mockup-${Date.now()}.png`;
      link.href = currentAngleResult.src;
      link.click();
      return;
    }

    if (!activePhoto || !design.src) {
      setToastMsg({ type: "error", text: "Generate a preview before downloading." });
      return;
    }
    setToastMsg({ type: "success", text: "Compositing high-res mockup…" });

    const baseImg = new Image();
    baseImg.crossOrigin = "anonymous";
    baseImg.referrerPolicy = "no-referrer";
    baseImg.onload = () => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      canvas.width = baseImg.width;
      canvas.height = baseImg.height;
      ctx.drawImage(baseImg, 0, 0);

      const designImg = new Image();
      designImg.crossOrigin = "anonymous";
      designImg.referrerPolicy = "no-referrer";
      designImg.onload = () => {
        const boxX = (placementBox.x / 100) * canvas.width;
        const boxY = (placementBox.y / 100) * canvas.height;
        const boxW = (placementBox.width / 100) * canvas.width;
        const boxH = (placementBox.height / 100) * canvas.height;
        const cx = boxX + boxW / 2;
        const cy = boxY + boxH / 2;

        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate((adjust.rotate * Math.PI) / 180);
        ctx.globalAlpha = adjust.opacity / 100;
        ctx.filter = `saturate(${adjust.saturation}%)`;
        // Matches the on-screen CSS mix-blend-mode:multiply — without this,
        // the design's white background pastes as an opaque white box instead
        // of blending away against the skin underneath.
        ctx.globalCompositeOperation = "multiply";

        const ratio = designImg.width / designImg.height;
        let w = boxW;
        let h = w / ratio;
        if (h > boxH) {
          h = boxH;
          w = h * ratio;
        }
        ctx.drawImage(designImg, -w / 2, -h / 2, w, h);
        ctx.restore();

        const link = document.createElement("a");
        link.download = `inkvision-mockup-${Date.now()}.png`;
        link.href = canvas.toDataURL("image/png");
        link.click();
      };
      designImg.src = design.src as string;
    };
    baseImg.src = activePhoto.src;
  };

  const openTemplateModal = async () => {
    // Upload/Portfolio no longer populate the legacy `design.src` field for
    // new generations (they use the same real per-angle pipeline as
    // Generate) — fall back to it only for old-format history restores.
    const sourceForStencil = activeTab === "prompt" ? isolatedDesignSrc : legacyDesignSrc || design.src;
    if (!sourceForStencil) return;
    setShowTemplateModal(true);
    setTemplateShadedSrc(sourceForStencil);
    setStencilLoading(true);
    try {
      const src = await generateTattooStencil(sourceForStencil, 25);
      setStencilSrc(src);
    } catch {
      setStencilSrc(null);
    } finally {
      setStencilLoading(false);
    }
    // Also prepare the Multi-Pose Reference sheet inline, reusing a cached one if we already made it.
    if (!referenceSheetSrc) {
      openReferenceSheetModal({ silent: true });
    }
  };

  const openReferenceSheetModal = async (opts: { silent?: boolean; force?: boolean } = {}) => {
    if (!isolatedDesignSrc) return;

    // Already have one for this design — just show it (or do nothing if silent),
    // don't regenerate unless explicitly forced (e.g. the Regenerate button).
    if (referenceSheetSrc && !opts.force) {
      if (!opts.silent) setShowReferenceSheetModal(true);
      return;
    }

    const referencePhoto = activePhoto || basePhotos[0];
    if (!referencePhoto) return;

    if (!opts.silent) setShowReferenceSheetModal(true);
    setReferenceSheetLoading(true);
    setReferenceSheetSrc(null);
    try {
      const analysis =
        (await ensureAnalysis()) || {
          bodyPart: "the marked body part shown in the reference photo",
          theme: "unspecified — infer style and any existing ink directly from the reference photo",
          description: ""
        };
      const res = await fetch("/api/generate-reference-sheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bodyPart: analysis.bodyPart,
          theme: analysis.theme,
          description: analysis.description,
          correction: correctionText,
          designImage: isolatedDesignSrc,
          referenceImage: referencePhoto.src
        })
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data.error || "Failed to generate the reference sheet.");
      setReferenceSheetSrc(data.imageUrl);
    } catch (err: any) {
      if (!opts.silent) {
        setToastMsg({ type: "error", text: err.message || "Failed to generate the reference sheet." });
        setShowReferenceSheetModal(false);
      }
    } finally {
      setReferenceSheetLoading(false);
    }
  };

  const handleDownloadReferenceSheet = () => {
    if (!referenceSheetSrc) return;
    const link = document.createElement("a");
    link.download = `inkvision-reference-sheet-${Date.now()}.png`;
    link.href = referenceSheetSrc;
    link.click();
  };

  const handleDownloadTemplateAll = async () => {
    const files: { name: string; dataUrl: string }[] = [];
    if (stencilSrc) files.push({ name: "wireframe-stencil.png", dataUrl: stencilSrc });
    if (templateShadedSrc) files.push({ name: "shaded-design.png", dataUrl: templateShadedSrc });
    if (referenceSheetSrc) files.push({ name: "multi-pose-reference.png", dataUrl: referenceSheetSrc });
    if (files.length === 0) return;
    try {
      await downloadImagesZip(files, `inkvision-artist-template-${Date.now()}.zip`);
    } catch {
      setToastMsg({ type: "error", text: "Failed to build the download bundle." });
    }
  };

  // RENDER AUTH SCREEN — shown when signing in is required to proceed (e.g. entering the Studio)
  if (showAuthScreen && !user) {
    return <AuthScreen />;
  }

  // RENDER ADMIN PANEL — gated on actual role, not just the toggle, so this can never be reached by non-admins
  if (showAdminPanel && userProfile?.role === "admin") {
    return (
      <AdminPanel
        onBack={() => setShowAdminPanel(false)}
        onGoHome={() => {
          setShowAdminPanel(false);
          setIsLanding(true);
        }}
      />
    );
  }

  // RENDER TATTOOIST SHARE VIEW (?share=CODE) — read-only, standalone
  if (tattooistShareCode) {
    const project = tattooistProject;
    const finalPreviews = project
      ? project.angleResults && Object.keys(project.angleResults).length > 0
        ? (Object.entries(project.angleResults) as [string, AngleResult][]).map(([id, r]) => ({
            name: project.basePhotos.find((p) => p.id === id)?.name || id,
            src: r.src
          }))
        : project.design?.src
        ? [{ name: "Final Design", src: project.design.src }]
        : []
      : [];

    return (
      <div className="min-h-screen flex flex-col font-body" style={{ background: "var(--iv-bg)", color: "var(--iv-ink)" }}>
        <div className="iv-grain-overlay" />
        <header className="flex-none flex items-center px-7 border-b" style={{ height: 64, borderColor: "var(--iv-border)" }}>
          <div
            className="flex flex-col items-center justify-center px-3.5 py-1.5"
            style={{ minWidth: 150, height: 58 }}
          >
            <span className="font-display leading-tight font-semibold uppercase" style={{ fontSize: 8, letterSpacing: "0.2em", color: "rgb(245, 158, 11)" }}>
              Tattoo Studio
            </span>
            <span className="font-display leading-tight font-bold tracking-[0.15em] text-[#d9d2c6] mt-0.5" style={{ fontSize: 24 }}>
              InkVision
            </span>
          </div>
          <div className="ml-4 font-display text-sm uppercase" style={{ letterSpacing: "0.1em", color: "var(--iv-ink)" }}>
            Project Files — {tattooistShareCode.toUpperCase()}
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-8 max-w-4xl w-full mx-auto">
          {tattooistLoading ? (
            <div className="flex items-center justify-center py-24">
              <Loader2 className="w-6 h-6 animate-spin" style={{ color: "rgba(217,210,198,0.4)" }} />
            </div>
          ) : tattooistError ? (
            <div className="text-sm text-center py-24" style={{ color: "#e8899a" }}>
              {tattooistError}
            </div>
          ) : project ? (
            <>
              <div className="flex items-center justify-between mb-8">
                <p className="text-sm max-w-lg" style={{ color: "rgba(217,210,198,0.55)" }}>
                  Shared for review ahead of a tattoo session — original reference photos, the isolated design/stencil
                  templates, and finalized preview(s) below.
                </p>
                <button
                  onClick={handleDownloadTattooistZip}
                  disabled={tattooistZipping}
                  className="flex-none font-display text-[11px] uppercase py-2.5 px-4.5 rounded-md cursor-pointer flex items-center gap-2"
                  style={{ background: "var(--iv-accent)", border: "none", color: "#0f0e0d", letterSpacing: "0.08em" }}
                >
                  {tattooistZipping && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {tattooistZipping ? "Building ZIP…" : "Download All (ZIP)"}
                </button>
              </div>

              <div className="mb-8">
                <div className="font-display text-xs uppercase mb-3" style={{ letterSpacing: "0.1em", color: "rgb(245, 158, 11)" }}>
                  Original Photos
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {project.basePhotos.map((photo) => (
                    <a
                      key={photo.id}
                      href={photo.src}
                      download={`${photo.name}.png`}
                      className="rounded-lg overflow-hidden border block"
                      style={{ borderColor: "var(--iv-border)" }}
                    >
                      <img src={photo.src} alt={photo.name} className="w-full object-cover" style={{ height: 140 }} referrerPolicy="no-referrer" />
                      <div className="px-2 py-1.5 text-xs text-center" style={{ background: "var(--iv-panel)", color: "var(--iv-ink)" }}>
                        {photo.name}
                      </div>
                    </a>
                  ))}
                </div>
              </div>

              {(project.isolatedDesignSrc || project.design?.src) && (
                <div className="mb-8">
                  <div className="font-display text-xs uppercase mb-3" style={{ letterSpacing: "0.1em", color: "rgb(245, 158, 11)" }}>
                    Template Files
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {project.isolatedDesignSrc && (
                      <a
                        href={project.isolatedDesignSrc}
                        download="isolated-design.png"
                        className="rounded-lg overflow-hidden border block"
                        style={{ borderColor: "var(--iv-border)", background: "#fff" }}
                      >
                        <img src={project.isolatedDesignSrc} alt="Isolated design" className="w-full object-contain" style={{ height: 140 }} />
                        <div className="px-2 py-1.5 text-xs text-center" style={{ background: "var(--iv-panel)", color: "var(--iv-ink)" }}>
                          Isolated Design
                        </div>
                      </a>
                    )}
                    {project.design?.src && (
                      <a
                        href={project.design.src}
                        download="reference-design.png"
                        className="rounded-lg overflow-hidden border block"
                        style={{ borderColor: "var(--iv-border)", background: "#fff" }}
                      >
                        <img src={project.design.src} alt="Reference design" className="w-full object-contain" style={{ height: 140 }} />
                        <div className="px-2 py-1.5 text-xs text-center" style={{ background: "var(--iv-panel)", color: "var(--iv-ink)" }}>
                          Reference Design
                        </div>
                      </a>
                    )}
                  </div>
                </div>
              )}

              {finalPreviews.length > 0 && (
                <div className="mb-8">
                  <div className="font-display text-xs uppercase mb-3" style={{ letterSpacing: "0.1em", color: "rgb(245, 158, 11)" }}>
                    Finalized Previews
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {finalPreviews.map((p, i) => (
                      <a
                        key={i}
                        href={p.src}
                        download={`${p.name}-final.png`}
                        className="rounded-lg overflow-hidden border block"
                        style={{ borderColor: "var(--iv-border)" }}
                      >
                        <img src={p.src} alt={p.name} className="w-full object-cover" style={{ height: 140 }} referrerPolicy="no-referrer" />
                        <div className="px-2 py-1.5 text-xs text-center" style={{ background: "var(--iv-panel)", color: "var(--iv-ink)" }}>
                          {p.name}
                        </div>
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : null}
        </div>

        <footer
          className="flex-none py-4 px-6 text-center text-xs border-t"
          style={{ borderColor: "var(--iv-border)", color: "rgba(217,210,198,0.4)" }}
        >
          InkVision Studio — visual previews only, not a substitute for consulting a tattoo artist.
        </footer>
      </div>
    );
  }

  // RENDER PORTFOLIO PAGE
  if (showPortfolioPage) {
    return (
      <div className="min-h-screen flex flex-col font-body" style={{ background: "var(--iv-bg)", color: "var(--iv-ink)" }}>
        <div className="iv-grain-overlay" />
        <header
          className="flex-none flex items-center px-7 border-b"
          style={{ height: 64, borderColor: "var(--iv-border)" }}
        >
          <div className="flex items-center gap-4">
            <button
              onClick={() => {
                setShowPortfolioPage(false);
                setIsLanding(true);
              }}
              className="flex flex-col items-center justify-center px-3.5 py-1.5 cursor-pointer transition-colors"
              style={{ minWidth: 150, height: 58, background: "none" }}
              title="Return to Home screen"
            >
              <span
                className="font-display leading-tight font-semibold uppercase"
                style={{ fontSize: 8, letterSpacing: "0.2em", color: "rgb(245, 158, 11)" }}
              >
                Tattoo Studio
              </span>
              <span className="font-display leading-tight font-bold tracking-[0.15em] text-[#d9d2c6] mt-0.5" style={{ fontSize: 24 }}>
                InkVision
              </span>
            </button>
            <button
              onClick={goToStudio}
              className="font-display text-sm uppercase cursor-pointer bg-transparent border-none hover:text-amber-500 transition-colors"
              style={{ letterSpacing: "0.1em", color: "var(--iv-ink)" }}
            >
              Studio
            </button>
            <span className="opacity-20" style={{ color: "var(--iv-ink)" }}>
              /
            </span>
            <div className="font-display text-sm uppercase" style={{ letterSpacing: "0.1em", color: "var(--iv-ink)" }}>
              Portfolio
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-8 max-w-6xl w-full mx-auto">
          <p className="text-sm mb-6" style={{ color: "rgba(217,210,198,0.55)" }}>
            Designs generated by every InkVision user, shared here for inspiration. Like the ones you love — the most-liked
            designs float to the top.
          </p>

          <div className="flex flex-wrap items-center gap-3 mb-6">
            <input
              type="text"
              value={portfolioSearch}
              onChange={(e) => setPortfolioSearch(e.target.value)}
              placeholder="Filter by name/prompt…"
              className="text-xs rounded-md px-3 py-2 flex-1 min-w-[180px]"
              style={{ background: "var(--iv-panel)", border: "1px solid rgba(217,210,198,0.15)", color: "var(--iv-ink)" }}
            />
            <select
              value={portfolioSort}
              onChange={(e) => setPortfolioSort(e.target.value as "likes" | "newest")}
              className="text-xs rounded-md px-3 py-2"
              style={{ background: "var(--iv-panel)", border: "1px solid rgba(217,210,198,0.15)", color: "var(--iv-ink)" }}
            >
              <option value="likes">Sort: Most Liked</option>
              <option value="newest">Sort: Newest</option>
            </select>
          </div>

          {portfolioLoading ? (
            <div className="flex items-center justify-center py-24">
              <Loader2 className="w-6 h-6 animate-spin" style={{ color: "rgba(217,210,198,0.4)" }} />
            </div>
          ) : portfolioItems.length === 0 ? (
            <div className="text-sm text-center py-24" style={{ color: "rgba(217,210,198,0.4)" }}>
              No designs yet — generate a tattoo design in the Studio and it'll show up here automatically.
            </div>
          ) : (
            (() => {
              const filtered = portfolioItems.filter((item) =>
                item.name.toLowerCase().includes(portfolioSearch.trim().toLowerCase())
              );
              const sorted = [...filtered].sort((a, b) =>
                portfolioSort === "likes" ? b.likes - a.likes : new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
              );
              if (sorted.length === 0) {
                return (
                  <div className="text-sm text-center py-24" style={{ color: "rgba(217,210,198,0.4)" }}>
                    No designs match "{portfolioSearch}".
                  </div>
                );
              }
              return (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                  {sorted.map((item) => (
                    <div
                      key={item.id}
                      className="rounded-xl overflow-hidden border cursor-pointer"
                      style={{ background: "var(--iv-panel)", borderColor: "var(--iv-border)" }}
                      onClick={() => setPortfolioModalItem(item)}
                    >
                      <div className="relative" style={{ height: 160, background: "#fff" }}>
                        <img src={item.imageUrl} alt={item.name} className="w-full h-full object-contain" referrerPolicy="no-referrer" />
                      </div>
                      <div className="p-3 flex items-center justify-between gap-2">
                        <span className="text-xs truncate" style={{ color: "var(--iv-ink)" }} title={item.name}>
                          {item.name}
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleLikePortfolioItem(item.id);
                          }}
                          className="flex-none flex items-center gap-1 rounded-full px-2 py-1 cursor-pointer"
                          style={{ background: "rgba(236,231,224,0.06)", border: "1px solid rgba(236,231,224,0.14)" }}
                        >
                          <Heart className="w-3 h-3" style={{ color: "rgba(236,231,224,0.7)" }} />
                          <span className="text-[11px] font-mono" style={{ color: "rgba(236,231,224,0.7)" }}>
                            {item.likes}
                          </span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()
          )}
        </div>

        {portfolioModalItem && (
          <div
            className="fixed inset-0 flex items-center justify-center z-40"
            style={{ background: "rgba(10,10,9,0.85)" }}
            onClick={() => setPortfolioModalItem(null)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="rounded-xl p-6"
              style={{ width: 560, maxWidth: "92vw", maxHeight: "88vh", overflowY: "auto", background: "var(--iv-panel)", border: "1px solid rgba(217,210,198,0.14)" }}
            >
              <div className="flex justify-between items-baseline mb-4">
                <div className="font-display text-base uppercase" style={{ letterSpacing: "0.06em", color: "var(--iv-ink)" }}>
                  {portfolioModalItem.name}
                </div>
                <button
                  onClick={() => setPortfolioModalItem(null)}
                  className="bg-transparent border-none cursor-pointer text-xl leading-none"
                  style={{ color: "rgba(217,210,198,0.5)" }}
                >
                  &times;
                </button>
              </div>
              <div className="rounded-lg overflow-hidden flex items-center justify-center mb-4" style={{ background: "#fff", minHeight: 320 }}>
                <img src={portfolioModalItem.imageUrl} alt={portfolioModalItem.name} className="max-w-full max-h-full object-contain" />
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs" style={{ color: "rgba(217,210,198,0.4)" }}>
                  Added {new Date(portfolioModalItem.createdAt).toLocaleDateString()}
                </span>
                <button
                  onClick={() => handleLikePortfolioItem(portfolioModalItem.id)}
                  className="flex-none flex items-center gap-1.5 rounded-full px-3 py-1.5 cursor-pointer"
                  style={{ background: "rgba(236,231,224,0.06)", border: "1px solid rgba(236,231,224,0.14)" }}
                >
                  <Heart className="w-3.5 h-3.5" style={{ color: "rgb(245, 158, 11)" }} />
                  <span className="text-xs font-mono" style={{ color: "var(--iv-ink)" }}>
                    {portfolioModalItem.likes}
                  </span>
                </button>
              </div>
            </div>
          </div>
        )}

        <footer
          className="flex-none py-4 px-6 text-center text-xs border-t"
          style={{ borderColor: "var(--iv-border)", color: "rgba(217,210,198,0.4)" }}
        >
          InkVision Studio — visual previews only, not a substitute for consulting a tattoo artist.
        </footer>
      </div>
    );
  }

  // RENDER LANDING PAGE
  if (isLanding) {
    return (
      <div
        className="min-h-screen flex flex-col font-body relative overflow-hidden select-none"
        style={{
          backgroundImage: `linear-gradient(rgba(0, 0, 0, 0.45), rgba(0, 0, 0, 0.75)), url(${landingBackground})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundColor: "#080807",
          color: "var(--iv-ink)"
        }}
      >
        <div className="iv-grain-overlay" />

        {toastMsg && (
          <div
            className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-5 py-3 rounded-xl shadow-2xl border animate-slideUp font-display"
            style={{
              background: "var(--iv-panel)",
              borderColor: toastMsg.type === "success" ? "rgba(217,210,198,0.25)" : "rgba(200,32,63,0.5)",
              color: toastMsg.type === "success" ? "rgb(245, 158, 11)" : "#e8899a"
            }}
          >
            {toastMsg.type === "success" ? <CheckCircle className="w-5 h-5" /> : <AlertTriangle className="w-5 h-5" />}
            <span className="text-xs font-medium" style={{ color: "var(--iv-ink)" }}>{toastMsg.text}</span>
          </div>
        )}

        {/* Minimal Navigation Topbar */}
        <header className="flex-none flex items-center justify-center px-12 border-b border-white/5" style={{ height: 90 }}>
          <div className="hidden md:flex items-center gap-8 text-[10px] tracking-[0.25em] font-medium text-[#d9d2c6]/60">
            <button onClick={goToStudio} className="hover:text-amber-500 transition-colors duration-300 uppercase cursor-pointer">
              Studio
            </button>
            <span className="opacity-10 text-[8px]">•</span>
            <button
              onClick={() => handleOpenPortfolioPage()}
              className="hover:text-amber-500 transition-colors duration-300 uppercase cursor-pointer"
            >
              Portfolio
            </button>
            <span className="opacity-10 text-[8px]">•</span>
            <button
              onClick={() => setShowPricingModal(true)}
              className="hover:text-amber-500 transition-colors duration-300 uppercase cursor-pointer"
            >
              Pricing
            </button>
          </div>
        </header>

        {showPricingModal && <PricingModal onClose={() => setShowPricingModal(false)} />}

        <button
          className="absolute left-6 top-1/2 -translate-y-1/2 p-2 rounded-full border border-white/5 bg-black/20 hover:bg-black/50 text-[#d9d2c6]/30 hover:text-amber-500 transition-all duration-300 cursor-pointer hidden sm:block"
          onClick={goToStudio}
          title="Enter Studio"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>

        <button
          className="absolute right-6 top-1/2 -translate-y-1/2 p-2 rounded-full border border-white/5 bg-black/20 hover:bg-black/50 text-[#d9d2c6]/30 hover:text-amber-500 transition-all duration-300 cursor-pointer hidden sm:block"
          onClick={goToStudio}
          title="Enter Studio"
        >
          <ChevronRight className="w-5 h-5" />
        </button>

        <div className="flex-1 flex flex-col items-center justify-center px-6 text-center z-10">
          <div className="font-display text-[10px] md:text-[11px] tracking-[0.45em] uppercase text-amber-500/90 mb-4 font-semibold select-none">
            Tattoo Studio
          </div>

          <h1 className="font-display text-5xl md:text-8xl tracking-[0.22em] font-bold text-[#d9d2c6] mb-6 leading-none select-none uppercase">
            INKVISION
          </h1>

          <p className="font-body text-[10px] md:text-xs tracking-[0.2em] text-[#d9d2c6]/50 max-w-lg mx-auto leading-relaxed uppercase mb-12 select-none">
            The art of tattooing, professional design, precision and attention to details.
          </p>

          <div className="flex flex-col items-center gap-6">
            <button
              onClick={goToStudio}
              className="font-display text-[11px] tracking-[0.25em] uppercase border border-[#d9d2c6]/30 px-12 py-4 text-[#d9d2c6] hover:bg-[#d9d2c6] hover:text-[#0f0e0d] transition-all duration-500 font-semibold cursor-pointer shadow-lg hover:shadow-2xl"
              style={{ letterSpacing: "0.25em" }}
            >
              Enter Studio
            </button>

            <div className="mt-4 flex flex-col items-center gap-4">
              {recentProjects.length > 0 && (
                <div className="flex flex-wrap justify-center items-center gap-2 mb-1 animate-fadeIn max-w-sm">
                  <span className="text-sm font-mono uppercase tracking-[0.15em] text-white self-center" style={{ fontSize: 14 }}>
                    Recents:
                  </span>
                  {recentProjects.slice(0, 3).map((proj) => (
                    <button
                      key={proj.code}
                      onClick={() => handleLoadProject(proj.code)}
                      className="px-2 py-0.5 rounded bg-black/60 border border-[#d9d2c6]/10 hover:border-amber-500/40 text-[9px] font-mono text-[#d9d2c6]/75 transition cursor-pointer"
                    >
                      <span className="font-bold text-amber-500">{proj.code}</span>
                      <span className="text-[#d9d2c6]/30 ml-1 font-sans">{proj.name}</span>
                    </button>
                  ))}
                  <button
                    onClick={handleClearRecents}
                    className="text-[9px] font-mono uppercase tracking-[0.1em] text-[#d9d2c6]/40 hover:text-amber-500 transition cursor-pointer underline"
                  >
                    Clear
                  </button>
                </div>
              )}

              <div className="flex items-center gap-3.5 tracking-[0.22em] text-white uppercase" style={{ fontSize: 14 }}>
                <span>Or</span>
                <div className="flex items-center gap-2 border-b border-white/40 focus-within:border-amber-500/50 pb-0.5">
                  <input
                    type="text"
                    maxLength={6}
                    placeholder="ENTER ACCESS CODE"
                    value={loadCode}
                    onChange={(e) => setLoadCode(e.target.value.toUpperCase())}
                    className="bg-transparent text-center font-mono text-[10px] uppercase focus:outline-none tracking-[0.18em] placeholder-white/70 py-0.5"
                    style={{ width: 130, color: "var(--iv-ink)" }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleLoadProject(loadCode);
                    }}
                  />
                  <button
                    onClick={() => handleLoadProject(loadCode)}
                    className="hover:text-amber-500 transition cursor-pointer text-[9px] font-bold text-amber-500"
                  >
                    LOAD
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <footer className="flex-none py-6 text-center text-[9px] tracking-[0.15em] uppercase text-white/20 select-none border-t border-white/5">
          InkVision Studio &copy; 2026 &mdash; Professional Pre-Visualization
        </footer>
      </div>
    );
  }

  // RENDER MAIN STUDIO WORKSPACE
  const analysisSummary = analysisState ? `${analysisState.bodyPart} · ${analysisState.theme}` : null;
  // Only meaningful once more than one angle photo has actually been analyzed
  // together — flags photos that don't look like the same body part (e.g. an
  // arm, a leg, and a chest uploaded as if they were "angles" of one area),
  // since the same design otherwise gets pasted onto all of them regardless.
  const anglesWarning =
    basePhotos.length > 1 && analysisState && analysisState.anglesConsistent === false
      ? analysisState.anglesNote || "These photos don't all appear to show the same body part — the same design will still be applied to each one as uploaded."
      : null;
  // Every uploaded angle must have its box either confirmed or already
  // generated before Generate Preview unlocks — no AI-guessed placement,
  // just a hard requirement that you've set every angle yourself. One click
  // then generates all of them at once. This applies the same way regardless
  // of source tab now (Generate / Upload / Portfolio all use real per-angle
  // placement + real AI generation).
  const allAnglesReady =
    basePhotos.length === 0 || basePhotos.every((p) => placedThisRound[p.id] || confirmedPlacementIds[p.id]);
  const ctaLabel = generating
    ? "Generating…"
    : !allAnglesReady
    ? "Confirm placement on every angle"
    : "Generate Preview";
  const ctaDisabled = generating || analyzing || !allAnglesReady;
  const canAddAnother = !!currentAngleResult && !analyzing && !generating && !needsPlacement;

  return (
    <div className="h-screen flex flex-col font-body overflow-hidden" style={{ background: "var(--iv-bg)", color: "var(--iv-ink)" }}>
      <div className="iv-grain-overlay" />

      {toastMsg && (
        <div
          className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-5 py-3 rounded-xl shadow-2xl border animate-slideUp font-display"
          style={{
            background: "var(--iv-panel)",
            borderColor: toastMsg.type === "success" ? "rgba(217,210,198,0.25)" : "rgba(200,32,63,0.5)",
            color: toastMsg.type === "success" ? "rgb(245, 158, 11)" : "#e8899a"
          }}
        >
          {toastMsg.type === "success" ? <CheckCircle className="w-5 h-5" /> : <AlertTriangle className="w-5 h-5" />}
          <span className="text-xs font-medium" style={{ color: "var(--iv-ink)" }}>{toastMsg.text}</span>
        </div>
      )}

      {/* Workspace Header */}
      <header
        className="flex-none flex items-center justify-between px-7 border-b"
        style={{ height: 64, borderColor: "var(--iv-border)" }}
      >
        <div className="flex items-center gap-4">
          <button
            onClick={() => setIsLanding(true)}
            className="flex flex-col items-center justify-center px-3.5 py-1.5 cursor-pointer transition-colors"
            style={{ minWidth: 150, height: 58, background: "none" }}
            title="Return to Home screen"
          >
            <span
              className="font-display leading-tight font-semibold uppercase"
              style={{ fontSize: 8, letterSpacing: "0.2em", color: "rgb(245, 158, 11)" }}
            >
              Tattoo Studio
            </span>
            <span className="font-display leading-tight font-bold tracking-[0.15em] text-[#d9d2c6] mt-0.5" style={{ fontSize: 24 }}>
              InkVision
            </span>
          </button>
          <button
            onClick={() => handleOpenPortfolioPage()}
            className="font-display text-sm uppercase cursor-pointer bg-transparent border-none hover:text-amber-500 transition-colors"
            style={{ letterSpacing: "0.1em", color: "var(--iv-ink)" }}
          >
            Portfolio
          </button>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={() => setShowHistory((v) => !v)}
            disabled={history.length === 0}
            title={
              history.length === 0
                ? "No versions yet — generate a preview to start building history"
                : showHistory
                ? "Hide the version thumbnails below — your history is kept either way"
                : `Show ${history.length} previous version${history.length === 1 ? "" : "s"} of this design as thumbnails you can click to restore`
            }
            className="font-display text-[11px] uppercase py-2 px-3.5 rounded-md"
            style={{
              background: showHistory && history.length > 0 ? "var(--iv-accent-soft)" : "none",
              border: `1px solid ${history.length === 0 ? "rgba(217,210,198,0.08)" : "rgba(217,210,198,0.18)"}`,
              color: history.length === 0 ? "rgba(217,210,198,0.25)" : showHistory ? "var(--iv-accent)" : "var(--iv-ink)",
              letterSpacing: "0.08em",
              cursor: history.length === 0 ? "not-allowed" : "pointer"
            }}
          >
            History{history.length > 0 ? ` (${history.length})` : ""}
          </button>

          <button
            onClick={() => openReferenceSheetModal()}
            disabled={!isolatedDesignSrc}
            title={isolatedDesignSrc ? "" : "Generate a tattoo design first"}
            className="font-display text-[11px] uppercase py-2 px-3.5 rounded-md"
            style={{
              background: "none",
              border: `1px solid ${isolatedDesignSrc ? "rgba(245,158,11,0.5)" : "rgba(217,210,198,0.1)"}`,
              color: isolatedDesignSrc ? "#f59e0b" : "rgba(217,210,198,0.3)",
              letterSpacing: "0.08em",
              cursor: isolatedDesignSrc ? "pointer" : "not-allowed"
            }}
          >
            Multi-Pose Reference
          </button>

          {user && (
            <AccountMenu
              displayName={user.displayName || user.email || "Account"}
              profile={userProfile}
              onSaveProject={handleSaveProject}
              saving={saving}
              canSave={basePhotos.length > 0}
              onLoadProjectClick={() => setShowLoadProjectModal(true)}
              onDownload={handleDownloadMockup}
              canDownload={hasResult}
              onExportTemplate={openTemplateModal}
              canExportTemplate={hasResult}
              onUpgrade={() => setShowPricingModal(true)}
              onOpenAdmin={() => setShowAdminPanel(true)}
              toastError={(msg) => setToastMsg({ type: "error", text: msg })}
            />
          )}
        </div>

        {showPricingModal && <PricingModal onClose={() => setShowPricingModal(false)} />}
        {showLoadProjectModal && (
          <LoadProjectModal
            onClose={() => setShowLoadProjectModal(false)}
            onLoad={(code) => handleLoadProject(code)}
          />
        )}
      </header>

      {/* Main Grid */}
      <main className="flex-1 min-h-0 grid gap-6 p-6 max-w-7xl w-full mx-auto" style={{ gridTemplateColumns: "380px 1fr", gridTemplateRows: "1fr" }}>
        <div style={{ minHeight: 0 }}>
          <TattooControlPanel
            basePhotos={basePhotos}
            activePhotoId={activePhotoId}
            onSelectBasePhoto={handleSelectBasePhoto}
            onAddBasePhoto={handleAddBasePhoto}
            onRemoveBasePhoto={handleRemoveBasePhoto}
            maxAngles={MAX_ANGLES}
            helperText={helperText}
            placedPhotoIds={placedThisRound}
            confirmedPhotoIds={confirmedPlacementIds}
            generationProgress={generationProgress}
            activeTab={activeTab}
            onSetActiveTab={handleSetActiveTab}
            prompt={prompt}
            onSetPrompt={setPrompt}
            style={style}
            onSetStyle={setStyle}
            colorPreference={colorPreference}
            onSetColorPreference={setColorPreference}
            uploadedPreviewSrc={uploadedDesignSrc}
            onUploadDesignFile={handleUploadDesignFile}
            portfolioItems={portfolioItems}
            portfolioLoading={portfolioLoading}
            selectedPortfolioId={selectedPortfolioId}
            onSelectPortfolioItem={handleSelectPortfolioItem}
            onLikePortfolioItem={handleLikePortfolioItem}
            coverUp={coverUp}
            onToggleCoverUp={() => setCoverUp((v) => !v)}
            adjust={adjust}
            onSetAdjust={(patch) => setAdjust((prev) => ({ ...prev, ...patch }))}
            draftAdjust={activePhotoDraftAdjust}
            onSetDraftAdjust={(patch) => activePhotoId && handleSetDraftAdjust(activePhotoId, patch)}
            adjustEnabled={needsPlacement}
            boxScalePercent={activeBoxScalePercent}
            onSetBoxScale={setActiveBoxScale}
            generating={generating}
            onGenerate={handleGenerate}
            ctaLabel={ctaLabel}
            ctaDisabled={ctaDisabled}
            error={error}
            analyzing={analyzing}
            analysisConfirmed={analysisConfirmed}
            analysisSummary={analysisSummary}
            anglesWarning={anglesWarning}
            onReanalyze={handleReanalyze}
            locked={basePhotos.length === 0}
            ideas={ideas}
            ideasLoading={ideasLoading}
            clarifyingQuestion={clarifyingQuestion}
            selectedClarifyingOption={selectedClarifyingOption}
            onFetchIdeas={handleFetchIdeas}
            onSelectClarifyingOption={handleSelectClarifyingOption}
            hasResult={hasResult}
          />
        </div>

        <div style={{ minHeight: 0 }}>
          <TattooStage
            basePhoto={activePhoto}
            basePhotos={basePhotos}
            onSelectBasePhoto={handleSelectBasePhoto}
            placedPhotoIds={placedThisRound}
            confirmedPhotoIds={confirmedPlacementIds}
            onConfirmPlacement={handleConfirmPlacement}
            onGenerate={handleGenerate}
            ctaLabel={ctaLabel}
            ctaDisabled={ctaDisabled}
            generationProgress={generationProgress}
            design={design}
            adjust={adjust}
            coverUp={coverUp}
            sliderX={sliderX}
            onSliderChange={setSliderX}
            generating={generating}
            hasResult={hasResult}
            activeTab={activeTab}
            historyEntries={history}
            showHistory={showHistory}
            currentEntryId={currentEntryId}
            onSelectHistory={handleSelectHistory}
            canAddAnother={canAddAnother}
            onAddAnotherTattoo={handleAddAnotherTattoo}
            onResetChain={handleResetChain}
            isChained={Object.keys(angleResults).length > 0}
            onSaveProject={handleSaveProject}
            saving={saving}
            canSave={basePhotos.length > 0}
            onDownload={handleDownloadMockup}
            canDownload={hasResult}
            placementBox={placementBox}
            onSetPlacementBox={setPlacementBox}
            isolatedDesignSrc={activeTab === "prompt" ? isolatedDesignSrc : legacyDesignSrc}
            draftAdjust={activePhotoDraftAdjust}
            onSetDraftAdjust={(patch) => activePhotoId && handleSetDraftAdjust(activePhotoId, patch)}
            needsPlacement={needsPlacement}
            angleResult={currentAngleResult}
            isRepositioning={repositioningPhotoId === activePhotoId}
            onRepositionAngle={handleRepositionAngle}
            onCancelReposition={handleCancelReposition}
          />
        </div>
      </main>

      {/* Share Modal */}
      {showSaveModal && (
        <div
          className="fixed inset-0 flex items-center justify-center z-40"
          style={{ background: "rgba(10,10,9,0.85)" }}
          onClick={() => setShowSaveModal(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="rounded-xl p-7 text-center max-w-md w-full animate-fadeIn"
            style={{
              background: "var(--iv-panel)",
              border: "1px solid rgba(217,210,198,0.14)",
              color: "var(--iv-ink)"
            }}
          >
            <div className="flex justify-between items-baseline mb-4">
              <div className="font-display text-base uppercase tracking-wider" style={{ color: "var(--iv-accent)" }}>
                Cloud Project Saved
              </div>
              <button
                onClick={() => setShowSaveModal(false)}
                className="bg-transparent border-none cursor-pointer text-lg leading-none"
                style={{ color: "rgba(217,210,198,0.5)" }}
              >
                &times;
              </button>
            </div>

            <p className="text-xs mb-6 leading-relaxed" style={{ color: "rgba(217,210,198,0.6)" }}>
              Your session is securely synced to the cloud. Share or retrieve this exact workspace state from any device using the code below.
            </p>

            <div
              className="font-mono text-3xl font-bold tracking-widest py-3 px-4 rounded-lg mb-6 flex items-center justify-center gap-3 cursor-pointer select-all"
              style={{ background: "var(--iv-bg-deep)", border: "1px solid rgba(217,210,198,0.12)" }}
              onClick={() => {
                if (projectCode) {
                  navigator.clipboard.writeText(projectCode);
                  setToastMsg({ type: "success", text: "Project code copied to clipboard!" });
                }
              }}
              title="Click to copy project code"
            >
              <span>{projectCode}</span>
              <Copy className="w-4 h-4" style={{ color: "var(--iv-accent)" }} />
            </div>

            <div className="text-[11px] mb-6" style={{ color: "rgba(217,210,198,0.4)" }}>
              Tip: Click the code block above to copy the access code instantly.
            </div>

            {projectCode && (
              <div className="rounded-lg p-4 mb-2" style={{ background: "var(--iv-bg-deep)", border: "1px solid rgba(217,210,198,0.12)" }}>
                <div className="font-display text-xs uppercase mb-3" style={{ letterSpacing: "0.1em", color: "rgb(245, 158, 11)" }}>
                  Share With Your Tattooist
                </div>
                <p className="text-[11px] mb-3 leading-relaxed" style={{ color: "rgba(217,210,198,0.5)" }}>
                  Scan the code or send the link below — it opens a read-only page with the original photos, design/stencil
                  templates, and finalized preview(s), plus a one-click ZIP download.
                </p>
                {shareQrCode && (
                  <div className="flex justify-center mb-3">
                    <img src={shareQrCode} alt="Share QR code" style={{ width: 140, height: 140, borderRadius: 8 }} />
                  </div>
                )}
                <div
                  className="flex items-center gap-2 rounded-md px-3 py-2 cursor-pointer"
                  style={{ background: "rgba(236,231,224,0.06)", border: "1px solid rgba(236,231,224,0.14)" }}
                  onClick={() => {
                    navigator.clipboard.writeText(buildTattooistShareUrl(projectCode));
                    setToastMsg({ type: "success", text: "Share link copied to clipboard!" });
                  }}
                  title="Click to copy the share link"
                >
                  <span className="text-[11px] font-mono truncate flex-1 text-left" style={{ color: "var(--iv-ink)" }}>
                    {buildTattooistShareUrl(projectCode)}
                  </span>
                  <Copy className="w-3.5 h-3.5 flex-none" style={{ color: "var(--iv-accent)" }} />
                </div>
              </div>
            )}

            <div className="flex justify-center mt-6">
              <button
                onClick={() => setShowSaveModal(false)}
                className="font-display text-[11px] uppercase py-2 px-6 rounded-md cursor-pointer"
                style={{ background: "var(--iv-accent)", color: "#0f0e0d", border: "none" }}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Artist Template Modal */}
      {showTemplateModal && (
        <div
          className="fixed inset-0 flex items-center justify-center z-40"
          style={{ background: "rgba(10,10,9,0.78)" }}
          onClick={() => setShowTemplateModal(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="rounded-xl p-7"
            style={{
              width: 760,
              maxWidth: "92vw",
              maxHeight: "88vh",
              overflowY: "auto",
              background: "var(--iv-panel)",
              border: "1px solid rgba(217,210,198,0.14)"
            }}
          >
            <div className="flex justify-between items-baseline mb-5">
              <div className="font-display text-xl uppercase" style={{ letterSpacing: "0.06em", color: "var(--iv-ink)" }}>
                Artist Template
              </div>
              <button
                onClick={() => setShowTemplateModal(false)}
                className="bg-transparent border-none cursor-pointer text-xl leading-none"
                style={{ color: "rgba(217,210,198,0.5)" }}
              >
                &times;
              </button>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-5">
              <div>
                <div
                  className="w-full rounded-lg overflow-hidden flex items-center justify-center"
                  style={{ height: 200, background: "#e8e5df", cursor: stencilSrc ? "zoom-in" : "default" }}
                  onClick={() => stencilSrc && setEnlargedTemplateImage({ src: stencilSrc, label: "Wireframe Stencil" })}
                >
                  {stencilLoading ? (
                    <Loader2 className="w-6 h-6 animate-spin" style={{ color: "#0f0e0d" }} />
                  ) : stencilSrc ? (
                    <img src={stencilSrc} alt="Wireframe stencil" className="max-w-full max-h-full object-contain" />
                  ) : (
                    <span className="text-xs font-mono uppercase" style={{ color: "#0f0e0d" }}>
                      Stencil unavailable
                    </span>
                  )}
                </div>
                <div className="text-xs mt-2" style={{ color: "rgba(217,210,198,0.4)" }}>
                  Wireframe — pure outline, ready for tracing onto transfer paper
                </div>
              </div>
              <div>
                <div
                  className="w-full rounded-lg overflow-hidden flex items-center justify-center"
                  style={{ height: 200, background: "#e8e5df", cursor: templateShadedSrc ? "zoom-in" : "default" }}
                  onClick={() => templateShadedSrc && setEnlargedTemplateImage({ src: templateShadedSrc, label: "Shaded Design" })}
                >
                  {templateShadedSrc ? (
                    <img src={templateShadedSrc} alt="Shaded design" className="max-w-full max-h-full object-contain" />
                  ) : (
                    <span className="text-xs font-mono uppercase" style={{ color: "#0f0e0d" }}>
                      Shaded design unavailable
                    </span>
                  )}
                </div>
                <div className="text-xs mt-2" style={{ color: "rgba(217,210,198,0.4)" }}>
                  Shaded — the full original design, for reference on shading/color
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-6 mb-5">
              <div className="flex flex-col gap-2.5">
                {/* Every tab now goes through the same real per-angle
                    compositing pipeline, so this summary reads the same
                    fields (box position/size, angles generated) regardless
                    of source — the old separate Scale/Rotation/Opacity/
                    Saturation-from-global-`adjust` branch no longer reflects
                    reality since those sliders write to the per-photo
                    draftAdjust map now, same as the Generate tab. */}
                {[
                  ["Placement", `${activePhoto?.name || "—"}, ${coverUp ? "cover-up" : "open skin"}`],
                  ["Box position", `${placementBox.x.toFixed(0)}%, ${placementBox.y.toFixed(0)}%`],
                  ["Box size", `${placementBox.width.toFixed(0)}% × ${placementBox.height.toFixed(0)}%`],
                  ["Cover-Up Mode", coverUp ? "Cover-Up Active" : "Existing Ink Preserved"],
                  ["Reference angles", `${basePhotos.length} photo(s)`],
                  ["Angles generated", `${Object.keys(angleResults).length} of ${basePhotos.length}`]
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between text-xs" style={{ color: "rgba(217,210,198,0.5)" }}>
                    <span>{label}</span>
                    <span style={{ color: "var(--iv-ink)" }}>{value}</span>
                  </div>
                ))}
              </div>
              <div>
                <div className="font-display text-[11px] uppercase mb-2" style={{ letterSpacing: "0.1em", color: "var(--iv-accent)" }}>
                  Reference Angles
                </div>
                <div className="flex flex-wrap gap-2">
                  {basePhotos.map((p) => (
                    <div key={p.id} className="rounded-md overflow-hidden" style={{ width: 56, height: 56, border: "1px solid rgba(217,210,198,0.15)" }}>
                      <img src={p.src} alt={p.name} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="mb-2">
              <div className="font-display text-[11px] uppercase mb-2" style={{ letterSpacing: "0.1em", color: "var(--iv-accent)" }}>
                Multi-Pose Reference
              </div>
              <div
                className="w-full rounded-lg overflow-hidden flex items-center justify-center"
                style={{ minHeight: 200, background: "#e8e5df", cursor: referenceSheetSrc ? "zoom-in" : "default" }}
                onClick={() => referenceSheetSrc && setEnlargedTemplateImage({ src: referenceSheetSrc, label: "Multi-Pose Reference" })}
              >
                {referenceSheetLoading ? (
                  <div className="flex flex-col items-center gap-2 py-8">
                    <Loader2 className="w-5 h-5 animate-spin" style={{ color: "#0f0e0d" }} />
                    <span className="text-[11px] font-mono uppercase" style={{ color: "#0f0e0d" }}>
                      Generating reference sheet…
                    </span>
                  </div>
                ) : referenceSheetSrc ? (
                  <img src={referenceSheetSrc} alt="Multi-pose reference" className="max-w-full max-h-full object-contain" />
                ) : (
                  <span className="text-xs font-mono uppercase py-8" style={{ color: "#0f0e0d" }}>
                    Reference sheet unavailable
                  </span>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2.5 mt-6">
              <button
                onClick={() => setShowTemplateModal(false)}
                className="font-display text-[11px] uppercase py-2.5 px-4.5 rounded-md cursor-pointer"
                style={{ background: "none", border: "1px solid rgba(217,210,198,0.18)", color: "var(--iv-ink)", letterSpacing: "0.06em" }}
              >
                Close
              </button>
              <button
                onClick={handleDownloadTemplateAll}
                className="font-display text-[11px] uppercase py-2.5 px-4.5 rounded-md cursor-pointer"
                style={{ background: "none", border: "1px solid rgba(217,210,198,0.18)", color: "var(--iv-ink)", letterSpacing: "0.06em" }}
              >
                Download
              </button>
              <button
                onClick={() => window.print()}
                className="font-display text-[11px] uppercase py-2.5 px-4.5 rounded-md cursor-pointer"
                style={{ background: "var(--iv-accent)", border: "none", color: "#0f0e0d", letterSpacing: "0.08em" }}
              >
                Print Template
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Enlarge lightbox for Artist Template images */}
      {enlargedTemplateImage && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50"
          style={{ background: "rgba(10,10,9,0.9)" }}
          onClick={() => setEnlargedTemplateImage(null)}
        >
          <div className="flex flex-col items-center gap-4" style={{ maxWidth: "90vw", maxHeight: "90vh" }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between w-full">
              <span className="font-display text-sm uppercase" style={{ letterSpacing: "0.08em", color: "var(--iv-ink)" }}>
                {enlargedTemplateImage.label}
              </span>
              <button
                onClick={() => setEnlargedTemplateImage(null)}
                className="bg-transparent border-none cursor-pointer text-2xl leading-none"
                style={{ color: "rgba(217,210,198,0.6)" }}
              >
                &times;
              </button>
            </div>
            <img
              src={enlargedTemplateImage.src}
              alt={enlargedTemplateImage.label}
              className="rounded-lg"
              style={{ maxWidth: "90vw", maxHeight: "80vh", objectFit: "contain", background: "#e8e5df" }}
            />
          </div>
        </div>
      )}

      {/* Multi-Pose Reference Sheet Modal */}
      {showReferenceSheetModal && (
        <div
          className="fixed inset-0 flex items-center justify-center z-40"
          style={{ background: "rgba(10,10,9,0.78)" }}
          onClick={() => setShowReferenceSheetModal(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="rounded-xl p-7"
            style={{
              width: 720,
              maxWidth: "92vw",
              maxHeight: "88vh",
              overflowY: "auto",
              background: "var(--iv-panel)",
              border: "1px solid rgba(217,210,198,0.14)"
            }}
          >
            <div className="flex justify-between items-baseline mb-5">
              <div className="font-display text-xl uppercase" style={{ letterSpacing: "0.06em", color: "var(--iv-ink)" }}>
                Multi-Pose Reference
              </div>
              <button
                onClick={() => setShowReferenceSheetModal(false)}
                className="bg-transparent border-none cursor-pointer text-xl leading-none"
                style={{ color: "rgba(217,210,198,0.5)" }}
              >
                &times;
              </button>
            </div>

            <p className="text-xs mb-4 leading-relaxed" style={{ color: "rgba(217,210,198,0.5)" }}>
              A generic reference figure showing the existing tattoo work and the new design together from four standard
              poses — useful for reviewing the full design before a session. This is a generated reference, not a photo of
              you specifically.
            </p>

            <div
              className="w-full rounded-lg overflow-hidden flex items-center justify-center"
              style={{ minHeight: 320, background: "#e8e5df", cursor: referenceSheetSrc ? "zoom-in" : "default" }}
              onClick={() => referenceSheetSrc && setEnlargedTemplateImage({ src: referenceSheetSrc, label: "Multi-Pose Reference" })}
              title={referenceSheetSrc ? "Click to zoom in" : undefined}
            >
              {referenceSheetLoading ? (
                <div className="flex flex-col items-center gap-3 py-10">
                  <Loader2 className="w-6 h-6 animate-spin" style={{ color: "#0f0e0d" }} />
                  <span className="text-xs font-mono uppercase" style={{ color: "#0f0e0d" }}>
                    Generating four-pose reference sheet…
                  </span>
                </div>
              ) : referenceSheetSrc ? (
                <img src={referenceSheetSrc} alt="Multi-pose reference sheet" className="max-w-full max-h-full object-contain" />
              ) : (
                <span className="text-xs font-mono uppercase py-10" style={{ color: "#0f0e0d" }}>
                  Reference sheet unavailable
                </span>
              )}
            </div>
            {referenceSheetSrc && !referenceSheetLoading && (
              <div className="text-[11px] text-center mt-2" style={{ color: "rgba(217,210,198,0.35)" }}>
                Click the image to zoom in
              </div>
            )}

            <div className="flex justify-end gap-2.5 mt-6">
              <button
                onClick={() => setShowReferenceSheetModal(false)}
                className="font-display text-[11px] uppercase py-2.5 px-4.5 rounded-md cursor-pointer"
                style={{ background: "none", border: "1px solid rgba(217,210,198,0.18)", color: "var(--iv-ink)", letterSpacing: "0.06em" }}
              >
                Close
              </button>
              <button
                onClick={() => openReferenceSheetModal({ force: true })}
                disabled={referenceSheetLoading}
                className="font-display text-[11px] uppercase py-2.5 px-4.5 rounded-md cursor-pointer"
                style={{
                  background: "none",
                  border: "1px solid rgba(217,210,198,0.18)",
                  color: "var(--iv-ink)",
                  letterSpacing: "0.06em",
                  opacity: referenceSheetLoading ? 0.5 : 1,
                  cursor: referenceSheetLoading ? "not-allowed" : "pointer"
                }}
              >
                Regenerate
              </button>
              <button
                onClick={handleDownloadReferenceSheet}
                disabled={!referenceSheetSrc}
                className="font-display text-[11px] uppercase py-2.5 px-4.5 rounded-md cursor-pointer"
                style={{
                  background: "var(--iv-accent)",
                  border: "none",
                  color: "#0f0e0d",
                  letterSpacing: "0.08em",
                  opacity: referenceSheetSrc ? 1 : 0.5,
                  cursor: referenceSheetSrc ? "pointer" : "not-allowed"
                }}
              >
                Download
              </button>
            </div>
          </div>
        </div>
      )}

      <footer
        className="flex-none py-4 px-6 text-center text-xs border-t"
        style={{ borderColor: "var(--iv-border)", color: "rgba(217,210,198,0.4)" }}
      >
        InkVision Studio — visual previews only, not a substitute for consulting a tattoo artist.
      </footer>
    </div>
  );
}
