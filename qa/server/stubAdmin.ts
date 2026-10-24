// Test double for ../../firebaseAdmin.ts: local file-backed "Firestore" and a
// fake token verifier, so the real Express app can be exercised end to end
// without Firebase credentials. Token format: "uid|email|verified(0/1)".
import { HybridFirestore, setForceLocalFallback } from "../../dbFallback";

setForceLocalFallback(true);
export const adminConfigured = true;
export const db: any = new HybridFirestore(null);
export const authAdmin: any = {
  verifyIdToken: async (t: string) => {
    const [uid, email, v] = t.split("|");
    if (!uid) throw new Error("bad token");
    return { uid, email, email_verified: v === "1" };
  }
};
