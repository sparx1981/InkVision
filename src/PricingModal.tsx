import React, { useState } from "react";
import { Loader2 } from "lucide-react";
import { getIdToken } from "./firebase";

interface Plan {
  key: "design_pass" | "artist_starter" | "studio";
  name: string;
  price: string;
  period: string;
  blurb: string;
  features: string[];
}

const PLANS: Plan[] = [
  {
    key: "design_pass",
    name: "Design Pass",
    price: "$15",
    period: "one-time",
    blurb: "Planning one tattoo? Get unlimited iterations on a single project.",
    features: ["Unlimited regenerations for one design", "Up to 4 angles", "HD download, no watermark", "20 bonus generations"]
  },
  {
    key: "artist_starter",
    name: "Artist Starter",
    price: "$59",
    period: "/month",
    blurb: "For solo artists running client consultations.",
    features: ["Unlimited client projects", "Artist Template + stencil export", "Multi-Pose Reference", "Client share links"]
  },
  {
    key: "studio",
    name: "Studio",
    price: "$249",
    period: "/month",
    blurb: "For multi-artist shops.",
    features: ["Everything in Artist Starter", "Multiple artist seats", "Studio branding on shared links", "Priority generation"]
  }
];

export default function PricingModal({ onClose }: { onClose: () => void }) {
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleChoose = async (plan: Plan["key"]) => {
    setLoadingPlan(plan);
    setError(null);
    try {
      const token = await getIdToken();
      if (!token) {
        setError("Please sign in first, then come back here to choose a plan.");
        setLoadingPlan(null);
        return;
      }
      const res = await fetch("/api/create-checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ plan })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start checkout.");
      window.location.href = data.url;
    } catch (err: any) {
      setError(err.message || "Failed to start checkout.");
      setLoadingPlan(null);
    }
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50" style={{ background: "rgba(10,10,9,0.85)" }} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="rounded-2xl p-8"
        style={{ width: 880, maxWidth: "94vw", maxHeight: "88vh", overflowY: "auto", background: "var(--iv-panel)", border: "1px solid rgba(217,210,198,0.14)" }}
      >
        <div className="flex justify-between items-baseline mb-6">
          <div className="font-display text-xl uppercase" style={{ letterSpacing: "0.06em", color: "var(--iv-ink)" }}>
            Upgrade
          </div>
          <button onClick={onClose} className="bg-transparent border-none cursor-pointer text-xl leading-none" style={{ color: "rgba(217,210,198,0.5)" }}>
            &times;
          </button>
        </div>

        {error && (
          <div className="rounded-lg p-3 mb-4 text-xs font-mono" style={{ background: "rgba(200,32,63,0.1)", border: "1px solid rgba(200,32,63,0.4)", color: "#e8899a" }}>
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {PLANS.map((plan) => (
            <div key={plan.key} className="rounded-xl p-5 flex flex-col" style={{ background: "var(--iv-bg-deep)", border: "1px solid rgba(217,210,198,0.12)" }}>
              <div className="font-display text-sm uppercase mb-1" style={{ color: "var(--iv-accent)", letterSpacing: "0.06em" }}>
                {plan.name}
              </div>
              <div className="flex items-baseline gap-1 mb-3">
                <span className="font-display text-2xl" style={{ color: "var(--iv-ink)" }}>
                  {plan.price}
                </span>
                <span className="text-xs" style={{ color: "rgba(217,210,198,0.4)" }}>
                  {plan.period}
                </span>
              </div>
              <p className="text-xs mb-4 leading-relaxed" style={{ color: "rgba(217,210,198,0.55)" }}>
                {plan.blurb}
              </p>
              <ul className="flex flex-col gap-1.5 mb-5 flex-1">
                {plan.features.map((f) => (
                  <li key={f} className="text-[11px] leading-relaxed" style={{ color: "rgba(217,210,198,0.6)" }}>
                    · {f}
                  </li>
                ))}
              </ul>
              <button
                onClick={() => handleChoose(plan.key)}
                disabled={loadingPlan !== null}
                className="font-display text-[11px] uppercase py-2.5 rounded-lg flex items-center justify-center gap-2 cursor-pointer"
                style={{ background: "var(--iv-accent)", border: "none", color: "#0f0e0d", letterSpacing: "0.08em", opacity: loadingPlan !== null ? 0.6 : 1 }}
              >
                {loadingPlan === plan.key && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Choose {plan.name}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
