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

  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled && img.naturalWidth && img.naturalHeight) {
        setNaturalAspect(img.naturalWidth / img.naturalHeight);
      }
    };
    img.src = imageSrc;
    return () => {
      cancelled = true;
    };
  }, [imageSrc]);

  const toPct = (clientX: number, clientY: number) => {
    const el = containerRef.current;
    if (!el) return { dx: 0, dy: 0 };
    const rect = el.getBoundingClientRect();
    return {
      dx: ((clientX - dragStart.current.clientX) / rect.width) * 100,
      dy: ((clientY - dragStart.current.clientY) / rect.height) * 100
    };
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
      } else {
        // Resize from whichever corner is being dragged, keeping the opposite corner fixed.
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
            <img
              src={designSrc}
              alt="New tattoo design preview"
              className="w-full h-full object-contain"
              style={{
                mixBlendMode: "multiply",
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
