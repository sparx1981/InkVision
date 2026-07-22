import React, { useState } from "react";
import { Loader2 } from "lucide-react";
import { signInWithEmail, signUpWithEmail, signInWithGoogle, firebaseConfigured } from "./firebase";

export default function AuthScreen() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === "signup") {
        await signUpWithEmail(email, password, displayName);
      } else {
        await signInWithEmail(email, password);
      }
      // AuthContext's onAuthStateChanged listener picks up the new session automatically.
    } catch (err: any) {
      setError(err?.message?.replace("Firebase: ", "") || "Something went wrong — please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = async () => {
    setError(null);
    setLoading(true);
    try {
      await signInWithGoogle();
    } catch (err: any) {
      setError(err?.message?.replace("Firebase: ", "") || "Google sign-in failed — please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center font-body" style={{ background: "var(--iv-bg)", color: "var(--iv-ink)" }}>
      <div className="iv-grain-overlay" />

      <div className="flex flex-col items-center mb-8">
        <span className="font-display uppercase" style={{ fontSize: 10, letterSpacing: "0.2em", color: "rgb(245, 158, 11)" }}>
          Tattoo Studio
        </span>
        <span className="font-display font-bold tracking-[0.15em]" style={{ fontSize: 28, color: "var(--iv-ink)" }}>
          InkVision
        </span>
      </div>

      {!firebaseConfigured && (
        <div
          className="mb-6 rounded-lg p-4 text-xs max-w-sm text-center leading-relaxed"
          style={{ background: "rgba(200,32,63,0.1)", border: "1px solid rgba(200,32,63,0.4)", color: "#e8899a" }}
        >
          Firebase isn't configured yet — add your project credentials to a <code>.env</code> file (see{" "}
          <code>.env.example</code>) to enable accounts.
        </div>
      )}

      <div
        className="rounded-2xl p-8"
        style={{ width: 360, maxWidth: "90vw", background: "var(--iv-panel)", border: "1px solid rgba(217,210,198,0.14)" }}
      >
        <div className="flex gap-0.5 rounded-lg p-0.5 mb-6" style={{ background: "rgba(236,231,224,0.06)" }}>
          <button
            onClick={() => setMode("signin")}
            className="flex-1 border-none font-display text-[11px] font-medium uppercase py-2.5 rounded-md cursor-pointer transition"
            style={{
              background: mode === "signin" ? "var(--iv-accent)" : "transparent",
              color: mode === "signin" ? "#0f0e0d" : "rgba(236,231,224,0.55)"
            }}
          >
            Sign In
          </button>
          <button
            onClick={() => setMode("signup")}
            className="flex-1 border-none font-display text-[11px] font-medium uppercase py-2.5 rounded-md cursor-pointer transition"
            style={{
              background: mode === "signup" ? "var(--iv-accent)" : "transparent",
              color: mode === "signup" ? "#0f0e0d" : "rgba(236,231,224,0.55)"
            }}
          >
            Create Account
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          {mode === "signup" && (
            <input
              type="text"
              placeholder="Name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="rounded-lg p-3 text-sm font-body"
              style={{ background: "var(--iv-bg-deep)", border: "1px solid rgba(217,210,198,0.15)", color: "var(--iv-ink)" }}
            />
          )}
          <input
            type="email"
            placeholder="Email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-lg p-3 text-sm font-body"
            style={{ background: "var(--iv-bg-deep)", border: "1px solid rgba(217,210,198,0.15)", color: "var(--iv-ink)" }}
          />
          <input
            type="password"
            placeholder="Password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-lg p-3 text-sm font-body"
            style={{ background: "var(--iv-bg-deep)", border: "1px solid rgba(217,210,198,0.15)", color: "var(--iv-ink)" }}
          />

          {error && (
            <div className="rounded-lg p-3 text-xs font-mono" style={{ background: "rgba(200,32,63,0.1)", border: "1px solid rgba(200,32,63,0.4)", color: "#e8899a" }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !firebaseConfigured}
            className="font-display text-[13px] uppercase py-3 rounded-lg flex items-center justify-center gap-2 mt-1"
            style={{
              background: "var(--iv-accent)",
              color: "#0f0e0d",
              letterSpacing: "0.1em",
              border: "none",
              opacity: loading || !firebaseConfigured ? 0.6 : 1,
              cursor: loading || !firebaseConfigured ? "not-allowed" : "pointer"
            }}
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            {mode === "signup" ? "Create Account" : "Sign In"}
          </button>
        </form>

        <div className="flex items-center gap-3 my-5">
          <div className="flex-1 h-px" style={{ background: "rgba(217,210,198,0.15)" }} />
          <span className="text-[10px] font-mono uppercase" style={{ color: "rgba(217,210,198,0.35)" }}>
            Or
          </span>
          <div className="flex-1 h-px" style={{ background: "rgba(217,210,198,0.15)" }} />
        </div>

        <button
          onClick={handleGoogle}
          disabled={loading || !firebaseConfigured}
          className="w-full font-display text-[12px] uppercase py-2.5 rounded-lg cursor-pointer"
          style={{
            background: "none",
            border: "1px solid rgba(217,210,198,0.18)",
            color: "var(--iv-ink)",
            letterSpacing: "0.06em",
            opacity: loading || !firebaseConfigured ? 0.6 : 1
          }}
        >
          Continue with Google
        </button>
      </div>

      <p className="text-xs mt-6 max-w-xs text-center" style={{ color: "rgba(217,210,198,0.35)" }}>
        By continuing you agree to our Terms of Service and Privacy Policy.
      </p>
    </div>
  );
}
