import React, { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { getIdToken } from "./firebase";

interface SavedProjectSummary {
  code: string;
  name: string;
  updatedAt: string;
  thumbnail: string | null;
}

export default function LoadProjectModal({
  onClose,
  onLoad
}: {
  onClose: () => void;
  onLoad: (code: string) => void;
}) {
  const [projects, setProjects] = useState<SavedProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const token = await getIdToken();
        const res = await fetch("/api/my-projects", { headers: { Authorization: `Bearer ${token}` } });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load your saved projects.");
        setProjects(data.projects);
      } catch (err: any) {
        setError(err.message || "Failed to load your saved projects.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50" style={{ background: "rgba(10,10,9,0.85)" }} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="rounded-2xl p-7"
        style={{ width: 640, maxWidth: "92vw", maxHeight: "82vh", overflowY: "auto", background: "var(--iv-panel)", border: "1px solid rgba(217,210,198,0.14)" }}
      >
        <div className="flex justify-between items-baseline mb-5">
          <div className="font-display text-xl uppercase" style={{ letterSpacing: "0.06em", color: "var(--iv-ink)" }}>
            Load Project
          </div>
          <button onClick={onClose} className="bg-transparent border-none cursor-pointer text-xl leading-none" style={{ color: "rgba(217,210,198,0.5)" }}>
            &times;
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin" style={{ color: "rgba(217,210,198,0.4)" }} />
          </div>
        ) : error ? (
          <div className="text-sm text-center py-16" style={{ color: "#e8899a" }}>
            {error}
          </div>
        ) : projects.length === 0 ? (
          <div className="text-sm text-center py-16" style={{ color: "rgba(217,210,198,0.4)" }}>
            No saved projects yet — use "Save Project" from the account menu once you've got something worth keeping.
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {projects.map((p) => (
              <button
                key={p.code}
                onClick={() => {
                  onLoad(p.code);
                  onClose();
                }}
                className="rounded-lg overflow-hidden border cursor-pointer text-left bg-transparent"
                style={{ borderColor: "rgba(217,210,198,0.14)" }}
              >
                <div className="flex items-center justify-center" style={{ height: 110, background: "var(--iv-bg-deep)" }}>
                  {p.thumbnail ? (
                    <img src={p.thumbnail} alt={p.name} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                  ) : (
                    <span className="text-xs font-mono" style={{ color: "rgba(217,210,198,0.3)" }}>
                      No preview
                    </span>
                  )}
                </div>
                <div className="p-2.5">
                  <div className="text-xs truncate" style={{ color: "var(--iv-ink)" }}>
                    {p.name}
                  </div>
                  <div className="text-[10px] font-mono mt-0.5" style={{ color: "rgba(217,210,198,0.4)" }}>
                    {new Date(p.updatedAt).toLocaleDateString()} · {p.code}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
