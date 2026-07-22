import { Request, Response, NextFunction } from "express";
import { authAdmin, adminConfigured } from "./firebaseAdmin.js";

// Augment Express's Request type so req.uid/req.userEmail are typed everywhere.
declare global {
  namespace Express {
    interface Request {
      uid?: string;
      userEmail?: string;
    }
  }
}

/** Requires a valid Firebase ID token (Authorization: Bearer <token>). Rejects with 401 if missing/invalid. */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!adminConfigured || !authAdmin) {
    return res.status(500).json({ error: "Server auth is not configured. Set FIREBASE_SERVICE_ACCOUNT_JSON." });
  }
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Sign in required." });
  }
  try {
    const decoded = await authAdmin.verifyIdToken(token);
    req.uid = decoded.uid;
    req.userEmail = decoded.email;
    next();
  } catch (err) {
    console.error("Token verification failed:", err);
    return res.status(401).json({ error: "Your session has expired — please sign in again." });
  }
}

/** Same as requireAuth, but doesn't reject if there's no token — just leaves req.uid unset.
 * Useful for routes that behave differently for signed-in vs anonymous users without hard-requiring login. */
export async function optionalAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token || !adminConfigured || !authAdmin) {
    return next();
  }
  try {
    const decoded = await authAdmin.verifyIdToken(token);
    req.uid = decoded.uid;
    req.userEmail = decoded.email;
  } catch {
    // invalid/expired token on an optional route — just proceed unauthenticated
  }
  next();
}

/** Chain AFTER requireAuth. Rejects with 403 unless the authenticated user has the "admin" role. */
export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.uid) {
    return res.status(401).json({ error: "Sign in required." });
  }
  try {
    const { getUserDoc } = await import("./userStore.js");
    const user = await getUserDoc(req.uid);
    if (!user || user.role !== "admin") {
      return res.status(403).json({ error: "Admin access required." });
    }
    next();
  } catch (err) {
    console.error("Admin check failed:", err);
    return res.status(500).json({ error: "Couldn't verify admin access." });
  }
}
