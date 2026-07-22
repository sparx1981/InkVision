import React, { createContext, useContext, useEffect, useState } from "react";
import { watchAuthState, getIdToken, firebaseConfigured, type User } from "./firebase";

interface UserProfile {
  tier: string;
  role: string;
  generationsThisPeriod: number;
  generationLimit: number | null;
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  profile: UserProfile | null;
  refreshProfile: () => Promise<void>;
  firebaseConfigured: boolean;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  profile: null,
  refreshProfile: async () => {},
  firebaseConfigured
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<UserProfile | null>(null);

  // IMPORTANT: this goes through the server (/api/me), not direct client
  // Firestore access. Two reasons: (1) only the server checks ADMIN_EMAILS
  // and applies the admin-promotion logic — a client-side "create the doc
  // myself" approach silently skips that entirely, which is exactly why an
  // admin email wasn't showing as admin before; (2) the client should never
  // be able to write its own tier/role/usage fields directly, since that's
  // trivially exploitable for free unlimited access. All writes to those
  // fields happen server-side via the Admin SDK.
  const refreshProfile = async () => {
    const token = await getIdToken();
    if (!token) {
      setProfile(null);
      return;
    }
    try {
      const res = await fetch("/api/me", { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        const data = await res.json();
        setProfile(data.profile);
      }
    } catch (err) {
      console.error("Error refreshing profile:", err);
    }
  };

  useEffect(() => {
    const unsubscribe = watchAuthState(async (nextUser) => {
      setUser(nextUser);
      setLoading(false);
      if (nextUser) {
        try {
          const token = await nextUser.getIdToken();
          // Idempotent — creates the Firestore doc on first sign-in (applying
          // ADMIN_EMAILS promotion if applicable), no-ops otherwise.
          await fetch("/api/ensure-user", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
        } catch (err) {
          console.error("Error ensuring user doc:", err);
        }
        await refreshProfile();
      } else {
        setProfile(null);
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, profile, refreshProfile, firebaseConfigured }}>{children}</AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
