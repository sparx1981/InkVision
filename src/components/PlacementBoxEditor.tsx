import React, { useEffect, useRef, useState } from "react";
import { DesignAdjust, PlacementBox } from "../types";

interface PlacementBoxEditorProps {
  imageSrc: string;
  box: PlacementBox;
  onChange: (box: PlacementBox) => void;
  maxHeight?: number;
  fillHeight?: boolean;
  designSrc?: string | null;
  designAdjust?: DesignAdjust;
}

type DragMode = "move" | "nw" | "ne" | "sw" | "se" | null;

const MIN_SIZE = 8; // percent

export default function PlacementBoxEditor({
  imageSrc,
  box,
  onChange,
  maxHeight = 500,
  fillHeight = false,
  designSrc,
  designAdjust
}: PlacementBoxEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragMode = useRef<DragMode>(null);
  const dragStart = useRef({ clientX: 0, clientY: 0, box });
  const [naturalAspect, setNaturalAspect] = useState(4 / 3);
  const [photoPx, setPhotoPx] = useState<{ w: number; h: number } | null>(null);
  const [designAspectPx, setDesignAspectPx] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled && img.naturalWidth && img.naturalHeight) {
        setNaturalAspect(img.naturalWidth / img.naturalHeight);
        setPhotoPx({ w: img.naturalWidth, h: img.naturalHeight });
      }
    };
    img.src = imageSrc;
    return () => {
      cancelled = true;
    };
  }, [imageSrc]);

  // The box IS the design's own placement layer — this tracks the design's
  // real (already content-trimmed, see trimToContent) pixel aspect ratio so
  // resizing can preserve it instead of letting the box drift into some other
  // shape than the design actually is.
  useEffect(() => {
    if (!designSrc) {
      setDesignAspectPx(null);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled && img.naturalWidth && img.naturalHeight) {
        setDesignAspectPx(img.naturalWidth / img.naturalHeight);
      }
    };
    img.src = designSrc;
    return () => {
      cancelled = true;
    };
  }, [designSrc]);

  const toPct = (clientX: number, clientY: number) => {
    const el = containerRef.current;
    if (!el) return { dx: 0, dy: 0 };
    const rect = el.getBoundingClientRect();
    return {
      dx: ((clientX - dragStart.current.clientX) / rect.width) * 100,
      dy: ((clientY - dragStart.current.clientY) / rect.height) * 100
    };
  };

  // Aspect-locked, uniform resize around whichever corner is opposite the one
  // being dragged. Box x/y/width/height are percentages of DIFFERENT axes
  // (width% of the photo's width, height% of its height), so a single "scale
  // factor" only preserves the box's true on-screen aspect ratio if it's
  // computed in real pixels first — not by comparing the percentage numbers
  // directly.
  const resizeAspectLocked = (
    corner: "se" | "sw" | "ne" | "nw",
    start: PlacementBox,
    dx: number,
    dy: number,
    photoW: number,
    photoH: number
  ): PlacementBox => {
    const startWpx = (start.width / 100) * photoW;
    const startHpx = (start.height / 100) * photoH;
    const dxPx = (dx / 100) * photoW;
    const dyPx = (dy / 100) * photoH;

    const signX = corner === "se" || corner === "ne" ? 1 : -1;
    const signY = corner === "se" || corner === "sw" ? 1 : -1;
    const deltaWpx = signX * dxPx;
    const deltaHpx = signY * dyPx;

    const scaleFromW = (startWpx + deltaWpx) / startWpx;
    const scaleFromH = (startHpx + deltaHpx) / startHpx;
    let scale = Math.abs(deltaWpx) >= Math.abs(deltaHpx) ? scaleFromW : scaleFromH;
    if (!isFinite(scale) || scale <= 0) scale = 1;

    const minScale = Math.max((MIN_SIZE / 100) * photoW / startWpx, (MIN_SIZE / 100) * photoH / startHpx);
    scale = Math.max(scale, minScale);

    const newWpx = startWpx * scale;
    const newHpx = startHpx * scale;
    const width = (newWpx / photoW) * 100;
    const height = (newHpx / photoH) * 100;

    let x = start.x;
    let y = start.y;
    if (corner === "sw" || corner === "nw") x = start.x + start.width - width;
    if (corner === "ne" || corner === "nw") y = start.y + start.height - height;

    return { x, y, width, height };
  };

  const startDrag = (mode: DragMode) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    dragMode.current = mode;
    dragStart.current = { clientX: e.clientX, clientY: e.clientY, box: { ...box } };

    const move = (ev: PointerEvent) => {
      if (!dragMode.current) return;
      const { dx, dy } = toPct(ev.clientX, ev.clientY);
      const start = dragStart.current.box;
      let next: PlacementBox = { ...start };

      // Position and size are intentionally NOT clamped to 0-100 here — the
      // design may need to extend beyond what this particular angle's photo
      // captures (e.g. wrapping around the arm), so the box can be dragged or
      // resized partially off-canvas. Only a sane minimum size is enforced.
      if (dragMode.current === "move") {
        next.x = start.x + dx;
        next.y = start.y + dy;
      } else if (designAspectPx && photoPx) {
        // A design is selected — resize keeps the box locked to its real
        // shape so the box can never drift into a different aspect ratio
        // than the design actually is.
        next = resizeAspectLocked(dragMode.current, start, dx, dy, photoPx.w, photoPx.h);
      } else {
        // No design yet (or dimensions not loaded) — fall back to free
        // per-axis resize, keeping the opposite corner fixed.
        const right = start.x + start.width;
        const bottom = start.y + start.height;
        if (dragMode.current === "se") {
          next.width = Math.max(MIN_SIZE, start.width + dx);
          next.height = Math.max(MIN_SIZE, start.height + dy);
        } else if (dragMode.current === "sw") {
          const newX = Math.min(start.x + dx, right - MIN_SIZE);
          next.x = newX;
          next.width = right - newX;
          next.height = Math.max(MIN_SIZE, start.height + dy);
        } else if (dragMode.current === "ne") {
          next.width = Math.max(MIN_SIZE, start.width + dx);
          const newY = Math.min(start.y + dy, bottom - MIN_SIZE);
          next.y = newY;
          next.height = bottom - newY;
        } else if (dragMode.current === "nw") {
          const newX = Math.min(start.x + dx, right - MIN_SIZE);
          const newY = Math.min(start.y + dy, bottom - MIN_SIZE);
          next.x = newX;
          next.width = right - newX;
          next.y = newY;
          next.height = bottom - newY;
        }
      }
      onChange(next);
    };

    const up = () => {
      dragMode.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const handleStyle = (cursor: string): React.CSSProperties => ({
    position: "absolute",
    width: 16,
    height: 16,
    borderRadius: 4,
    background: "var(--iv-accent)",
    border: "2px solid #0f0e0d",
    cursor,
    zIndex: 10
  });

  const boxStyle: React.CSSProperties = fillHeight
    ? { height: "100%", width: "auto", maxWidth: "100%", aspectRatio: String(naturalAspect) }
    : { width: naturalAspect >= 1 ? "100%" : "auto", maxWidth: "100%", maxHeight, aspectRatio: String(naturalAspect) };

  const editor = (
    <div
      ref={containerRef}
      className="relative select-none"
      style={{
        ...boxStyle,
        borderRadius: 14
      }}
    >
      {/* Clipped to rounded corners — only the photo (and its dim overlay) live in here */}
      <div className="absolute inset-0" style={{ borderRadius: 14, overflow: "hidden", background: "var(--iv-bg-deep)" }}>
        <img
          src={imageSrc}
          alt="Draw tattoo placement"
          className="absolute inset-0 w-full h-full object-cover pointer-events-none"
          referrerPolicy="no-referrer"
        />
        <div className="absolute inset-0 pointer-events-none" style={{ background: "rgba(10,10,9,0.45)" }} />
      </div>

      {/* NOT clipped — so the box and its resize handles stay visible/draggable
          even when the box extends beyond what this photo captures. */}
      <div
        onPointerDown={startDrag("move")}
        className="absolute"
        style={{
          left: `${box.x}%`,
          top: `${box.y}%`,
          width: `${box.width}%`,
          height: `${box.height}%`,
          border: "2px dashed var(--iv-accent)",
          background: "rgba(217,210,198,0.12)",
          cursor: "move"
        }}
      >
        <div
          className="absolute inset-0 flex items-center justify-center overflow-visible pointer-events-none"
          style={{ background: "transparent" }}
        >
          {designSrc ? (
            // Deliberately NOT mix-blend-mode:multiply — that hides any white
            // margin still left around the design (multiply with white is a
            // no-op), which made this preview look like an honest "what you
            // place is what you get" layer even when the design wasn't
            // actually filling the box. Designs are trimmed to their real
            // content bounds before they ever reach here (see trimToContent
            // in imageCompose.ts) and the box is aspect-locked to match, so
            // plain alpha compositing at full box size is now the accurate
            // picture — object-contain stays only as a defensive fallback for
            // the brief window before the design's real dimensions load.
            <img
              src={designSrc}
              alt="New tattoo design preview"
              className="w-full h-full object-contain"
              style={{
                opacity: (designAdjust?.opacity ?? 100) / 100,
                filter: `saturate(${designAdjust?.saturation ?? 100}%)`,
                transform: `rotate(${designAdjust?.rotate ?? 0}deg)`,
                transformOrigin: "center"
              }}
            />
          ) : (
            <span
              className="font-mono uppercase text-center px-2"
              style={{ fontSize: 10, letterSpacing: "0.06em", color: "rgba(236,231,224,.85)", textShadow: "0 1px 3px rgba(0,0,0,.8)" }}
            >
              New tattoo goes here
            </span>
          )}
        </div>

        <div onPointerDown={startDrag("nw")} style={{ ...handleStyle("nwse-resize"), left: -8, top: -8 }} />
        <div onPointerDown={startDrag("ne")} style={{ ...handleStyle("nesw-resize"), right: -8, top: -8 }} />
        <div onPointerDown={startDrag("sw")} style={{ ...handleStyle("nesw-resize"), left: -8, bottom: -8 }} />
        <div onPointerDown={startDrag("se")} style={{ ...handleStyle("nwse-resize"), right: -8, bottom: -8 }} />
      </div>
    </div>
  );

  if (fillHeight) {
    return <div className="h-full flex items-center justify-center">{editor}</div>;
  }
  return <div className="mx-auto" style={{ maxWidth: "100%" }}>{editor}</div>;
}
