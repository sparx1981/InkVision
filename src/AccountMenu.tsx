import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { signOutUser, getIdToken } from "./firebase";

interface UserProfile {
  tier: string;
  role: string;
  generationsThisPeriod: number;
  generationLimit: number | null;
}

interface AccountMenuProps {
  displayName: string;
  profile: UserProfile | null;
  onSaveProject: () => void;
  saving: boolean;
  canSave: boolean;
  onLoadProjectClick: () => void;
  onDownload: () => void;
  canDownload: boolean;
  onExportTemplate: () => void;
  canExportTemplate: boolean;
  onUpgrade: () => void;
  onOpenAdmin: () => void;
  toastError: (msg: string) => void;
}

export default function AccountMenu({
  displayName,
  profile,
  onSaveProject,
  saving,
  canSave,
  onLoadProjectClick,
  onDownload,
  canDownload,
  onExportTemplate,
  canExportTemplate,
  onUpgrade,
  onOpenAdmin,
  toastError
}: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleManageBilling = async () => {
    try {
      const token = await getIdToken();
      const res = await fetch("/api/create-billing-portal-session", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      window.location.href = data.url;
    } catch (err: any) {
      toastError(err.message || "Failed to open billing portal.");
    }
  };

  const creditsLabel = !profile
    ? ""
    : profile.role === "admin"
    ? "Unlimited (Admin)"
    : profile.generationLimit === null
    ? `Unlimited (${profile.tier})`
    : `${Math.max(0, profile.generationLimit - profile.generationsThisPeriod)} of ${profile.generationLimit} left`;

  const item = (label: string, onClick: () => void, disabled?: boolean, accent?: boolean) => (
    <button
      onClick={() => {
        setOpen(false);
        onClick();
      }}
      disabled={disabled}
      className="w-full text-left font-display text-[11px] uppercase py-2.5 px-4 cursor-pointer bg-transparent border-none"
      style={{
        color: disabled ? "rgba(217,210,198,0.25)" : accent ? "#f59e0b" : "var(--iv-ink)",
        letterSpacing: "0.06em",
        cursor: disabled ? "not-allowed" : "pointer"
      }}
    >
      {label}
    </button>
  );

  return (
    <div ref={ref} className="relative pl-2.5 ml-1" style={{ borderLeft: "1px solid rgba(217,210,198,0.15)" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 cursor-pointer bg-transparent border-none py-1"
      >
        <div className="flex flex-col items-end leading-tight">
          <span className="text-[11px]" style={{ color: "var(--iv-ink)" }}>
            {displayName}
          </span>
          {profile && (
            <span className="text-[9px] font-mono uppercase" style={{ color: "rgba(217,210,198,0.4)" }}>
              {creditsLabel}
            </span>
          )}
        </div>
        <ChevronDown className="w-3.5 h-3.5 transition-transform" style={{ color: "rgba(217,210,198,0.5)", transform: open ? "rotate(180deg)" : "none" }} />
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-2 rounded-lg overflow-hidden z-40"
          style={{ width: 220, background: "var(--iv-panel)", border: "1px solid rgba(217,210,198,0.14)", boxShadow: "0 12px 32px rgba(0,0,0,0.4)" }}
        >
          {profile && (
            <div className="px-4 py-2.5 text-[10px] font-mono uppercase" style={{ color: "rgba(217,210,198,0.4)", borderBottom: "1px solid rgba(217,210,198,0.1)" }}>
              {creditsLabel}
            </div>
          )}
          {profile?.role === "admin" && (
            <>
              {item("Admin Panel", onOpenAdmin, false, true)}
              <div style={{ borderTop: "1px solid rgba(217,210,198,0.1)" }} />
            </>
          )}
          {item("Load Project", onLoadProjectClick)}
          {item("Save Project", onSaveProject, !canSave || saving)}
          <div style={{ borderTop: "1px solid rgba(217,210,198,0.1)" }} />
          {item("Download", onDownload, !canDownload)}
          {item("Export Artist Template", onExportTemplate, !canExportTemplate)}
          <div style={{ borderTop: "1px solid rgba(217,210,198,0.1)" }} />
          {profile && profile.tier === "free" && profile.role !== "admin" && item("Upgrade", onUpgrade, false, true)}
          {profile && profile.tier !== "free" && item("Manage Billing", handleManageBilling)}
          <div style={{ borderTop: "1px solid rgba(217,210,198,0.1)" }}>{item("Sign Out", () => signOutUser())}</div>
        </div>
      )}
    </div>
  );
}
