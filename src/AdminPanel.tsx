import React, { useEffect, useState } from "react";
import { Loader2, ChevronLeft } from "lucide-react";
import { getIdToken } from "./firebase";

interface AdminUserRow {
  uid: string;
  email: string | null;
  displayName: string | null;
  role: string;
  tier: string;
  subscriptionStatus: string;
  generationsThisPeriod: number;
  bonusGenerations: number;
  createdAt: string;
}

const ROLES = ["consumer", "artist", "studio_admin", "admin"];
const TIERS = ["free", "design_pass", "artist_starter", "studio"];

export default function AdminPanel({ onBack, onGoHome }: { onBack: () => void; onGoHome: () => void }) {
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actioningUid, setActioningUid] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [grantModalUid, setGrantModalUid] = useState<string | null>(null);
  const [grantAmount, setGrantAmount] = useState("");
  const [refundModalUid, setRefundModalUid] = useState<string | null>(null);

  const authedFetch = async (url: string, init: RequestInit = {}) => {
    const token = await getIdToken();
    return fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
  };

  const loadUsers = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authedFetch("/api/admin/users");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load accounts.");
      setUsers(data.users);
    } catch (err: any) {
      setError(err.message || "Failed to load accounts.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showToast = (text: string) => {
    setToast(text);
    setTimeout(() => setToast(null), 3000);
  };

  const updateField = async (uid: string, patch: Record<string, string>) => {
    setActioningUid(uid);
    try {
      const res = await authedFetch(`/api/admin/users/${uid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Update failed.");
      setUsers((prev) => prev.map((u) => (u.uid === uid ? { ...u, ...patch } : u)));
      showToast("Updated.");
    } catch (err: any) {
      showToast(err.message || "Update failed.");
    } finally {
      setActioningUid(null);
    }
  };

  const openGrantModal = (uid: string) => {
    setGrantAmount("");
    setGrantModalUid(uid);
  };

  const submitGrantGenerations = async () => {
    const uid = grantModalUid;
    if (!uid) return;
    const amount = Number(grantAmount);
    if (!grantAmount.trim() || Number.isNaN(amount)) {
      showToast("Enter a valid number.");
      return;
    }
    setGrantModalUid(null);
    setActioningUid(uid);
    try {
      const res = await authedFetch(`/api/admin/users/${uid}/grant-generations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to grant generations.");
      setUsers((prev) => prev.map((u) => (u.uid === uid ? { ...u, bonusGenerations: data.user.bonusGenerations } : u)));
      showToast(`Granted ${amount} generation${amount === 1 ? "" : "s"}.`);
    } catch (err: any) {
      showToast(err.message || "Failed to grant generations.");
    } finally {
      setActioningUid(null);
    }
  };

  const resetUsage = async (uid: string) => {
    setActioningUid(uid);
    try {
      const res = await authedFetch(`/api/admin/users/${uid}/reset-usage`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to reset usage.");
      setUsers((prev) => prev.map((u) => (u.uid === uid ? { ...u, generationsThisPeriod: 0 } : u)));
      showToast("Usage reset for this period.");
    } catch (err: any) {
      showToast(err.message || "Failed to reset usage.");
    } finally {
      setActioningUid(null);
    }
  };

  const openRefundModal = (uid: string) => setRefundModalUid(uid);

  const submitRefund = async () => {
    const uid = refundModalUid;
    if (!uid) return;
    setRefundModalUid(null);
    setActioningUid(uid);
    try {
      const res = await authedFetch(`/api/admin/users/${uid}/refund`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Refund failed.");
      showToast(`Refunded $${((data.amount || 0) / 100).toFixed(2)}.`);
    } catch (err: any) {
      showToast(err.message || "Refund failed.");
    } finally {
      setActioningUid(null);
    }
  };

  return (
    <div className="min-h-screen flex flex-col font-body" style={{ background: "var(--iv-bg)", color: "var(--iv-ink)" }}>
      <div className="iv-grain-overlay" />
      <header className="flex-none flex items-center gap-4 px-7 border-b" style={{ height: 64, borderColor: "var(--iv-border)" }}>
        <button
          onClick={onGoHome}
          className="flex flex-col items-center justify-center px-3.5 py-1.5 cursor-pointer transition-colors"
          style={{ minWidth: 150, height: 58, background: "none" }}
          title="Return to Home screen"
        >
          <span className="font-display leading-tight font-semibold uppercase" style={{ fontSize: 8, letterSpacing: "0.2em", color: "rgb(245, 158, 11)" }}>
            Tattoo Studio
          </span>
          <span className="font-display leading-tight font-bold tracking-[0.15em] text-[#d9d2c6] mt-0.5" style={{ fontSize: 24 }}>
            InkVision
          </span>
        </button>
        <button
          onClick={onBack}
          className="flex items-center gap-1 font-display text-[11px] uppercase cursor-pointer bg-transparent border-none"
          style={{ color: "var(--iv-ink)", letterSpacing: "0.06em" }}
        >
          <ChevronLeft className="w-3.5 h-3.5" /> Back to Studio
        </button>
        <div className="font-display text-sm uppercase" style={{ letterSpacing: "0.1em", color: "rgb(245, 158, 11)" }}>
          Admin — Accounts
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-8 max-w-6xl w-full mx-auto">
        {loading ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="w-6 h-6 animate-spin" style={{ color: "rgba(217,210,198,0.4)" }} />
          </div>
        ) : error ? (
          <div className="text-sm text-center py-24" style={{ color: "#e8899a" }}>
            {error}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid rgba(217,210,198,0.15)" }}>
                  {["User", "Role", "Tier", "Status", "Used", "Bonus", "Actions"].map((h) => (
                    <th key={h} className="text-left py-2 px-2 font-display uppercase" style={{ color: "rgba(217,210,198,0.5)", letterSpacing: "0.06em" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.uid} style={{ borderBottom: "1px solid rgba(217,210,198,0.08)", opacity: actioningUid === u.uid ? 0.5 : 1 }}>
                    <td className="py-2 px-2">
                      <div style={{ color: "var(--iv-ink)" }}>{u.displayName || "—"}</div>
                      <div style={{ color: "rgba(217,210,198,0.4)" }}>{u.email}</div>
                    </td>
                    <td className="py-2 px-2">
                      <select
                        value={u.role}
                        onChange={(e) => updateField(u.uid, { role: e.target.value })}
                        className="text-xs rounded p-1"
                        style={{ background: "var(--iv-bg-deep)", border: "1px solid rgba(217,210,198,0.15)", color: "var(--iv-ink)" }}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-2 px-2">
                      <select
                        value={u.tier}
                        onChange={(e) => updateField(u.uid, { tier: e.target.value })}
                        className="text-xs rounded p-1"
                        style={{ background: "var(--iv-bg-deep)", border: "1px solid rgba(217,210,198,0.15)", color: "var(--iv-ink)" }}
                      >
                        {TIERS.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-2 px-2" style={{ color: "rgba(217,210,198,0.6)" }}>
                      {u.subscriptionStatus}
                    </td>
                    <td className="py-2 px-2" style={{ color: "rgba(217,210,198,0.6)" }}>
                      {u.generationsThisPeriod}
                    </td>
                    <td className="py-2 px-2" style={{ color: "rgba(217,210,198,0.6)" }}>
                      {u.bonusGenerations || 0}
                    </td>
                    <td className="py-2 px-2">
                      <div className="flex gap-1.5 flex-wrap">
                        <button
                          onClick={() => openGrantModal(u.uid)}
                          className="font-display text-[10px] uppercase py-1 px-2 rounded cursor-pointer"
                          style={{ background: "none", border: "1px solid rgba(217,210,198,0.18)", color: "var(--iv-ink)" }}
                        >
                          + Generations
                        </button>
                        <button
                          onClick={() => resetUsage(u.uid)}
                          className="font-display text-[10px] uppercase py-1 px-2 rounded cursor-pointer"
                          style={{ background: "none", border: "1px solid rgba(217,210,198,0.18)", color: "var(--iv-ink)" }}
                        >
                          Reset Usage
                        </button>
                        <button
                          onClick={() => openRefundModal(u.uid)}
                          className="font-display text-[10px] uppercase py-1 px-2 rounded cursor-pointer"
                          style={{ background: "none", border: "1px solid rgba(200,32,63,0.4)", color: "#e8899a" }}
                        >
                          Refund
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {toast && (
        <div
          className="fixed bottom-6 right-6 z-50 px-5 py-3 rounded-xl shadow-2xl border font-display text-xs"
          style={{ background: "var(--iv-panel)", borderColor: "rgba(217,210,198,0.25)", color: "var(--iv-ink)" }}
        >
          {toast}
        </div>
      )}

      {grantModalUid && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          style={{ background: "rgba(10,8,6,0.7)" }}
          onClick={() => setGrantModalUid(null)}
        >
          <div
            className="w-full max-w-sm rounded-xl border p-6 shadow-2xl"
            style={{ background: "var(--iv-panel)", borderColor: "rgba(217,210,198,0.2)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-display text-sm uppercase mb-1" style={{ color: "rgb(245,158,11)", letterSpacing: "0.08em" }}>
              Grant Generations
            </h3>
            <p className="text-xs mb-4" style={{ color: "rgba(217,210,198,0.5)" }}>
              Enter the number of bonus generations to grant this user. Use a negative number to revoke.
            </p>
            <input
              type="number"
              autoFocus
              value={grantAmount}
              onChange={(e) => setGrantAmount(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitGrantGenerations();
                if (e.key === "Escape") setGrantModalUid(null);
              }}
              placeholder="e.g. 5 or -2"
              className="w-full text-sm rounded p-2 mb-5"
              style={{ background: "var(--iv-bg-deep)", border: "1px solid rgba(217,210,198,0.2)", color: "var(--iv-ink)" }}
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setGrantModalUid(null)}
                className="font-display text-[10px] uppercase py-2 px-3 rounded cursor-pointer"
                style={{ background: "none", border: "1px solid rgba(217,210,198,0.18)", color: "var(--iv-ink)" }}
              >
                Cancel
              </button>
              <button
                onClick={submitGrantGenerations}
                className="font-display text-[10px] uppercase py-2 px-3 rounded cursor-pointer"
                style={{ background: "rgb(245,158,11)", border: "1px solid rgb(245,158,11)", color: "#1a1410" }}
              >
                Grant
              </button>
            </div>
          </div>
        </div>
      )}

      {refundModalUid && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          style={{ background: "rgba(10,8,6,0.7)" }}
          onClick={() => setRefundModalUid(null)}
        >
          <div
            className="w-full max-w-sm rounded-xl border p-6 shadow-2xl"
            style={{ background: "var(--iv-panel)", borderColor: "rgba(217,210,198,0.2)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-display text-sm uppercase mb-1" style={{ color: "#e8899a", letterSpacing: "0.08em" }}>
              Confirm Refund
            </h3>
            <p className="text-xs mb-5" style={{ color: "rgba(217,210,198,0.5)" }}>
              Issue a refund for this user's most recent payment? This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setRefundModalUid(null)}
                className="font-display text-[10px] uppercase py-2 px-3 rounded cursor-pointer"
                style={{ background: "none", border: "1px solid rgba(217,210,198,0.18)", color: "var(--iv-ink)" }}
              >
                Cancel
              </button>
              <button
                onClick={submitRefund}
                className="font-display text-[10px] uppercase py-2 px-3 rounded cursor-pointer"
                style={{ background: "none", border: "1px solid rgba(200,32,63,0.4)", color: "#e8899a" }}
              >
                Confirm Refund
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
