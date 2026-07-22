import { initializeApp, cert, getApps, type ServiceAccount } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getAuth, type Auth } from "firebase-admin/auth";
import fs from "fs";
import path from "path";
import { HybridFirestore, setForceLocalFallback } from "./dbFallback";

// Load configuration from firebase-applet-config.json if it exists
let firebaseConfig: any = null;
try {
  const configPath = path.join(process.cwd(), "firebase-applet-config.json");
  if (fs.existsSync(configPath)) {
    firebaseConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  }
} catch (e) {
  console.error("Failed to load firebase-applet-config.json:", e);
}

// Server-side Firebase Admin — verifies ID tokens from the client and reads/
// writes Firestore directly (bypassing security rules, since this runs on
// our trusted server). Needs a service account key — see .env.example for
// how to provide it (FIREBASE_SERVICE_ACCOUNT_JSON, base64 or raw JSON).
function loadServiceAccount(): ServiceAccount | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw || !raw.trim()) return null;
  try {
    // Accept either raw JSON or base64-encoded JSON (base64 is handy for
    // pasting a multi-line key into a single-line env var).
    const jsonStr = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    return JSON.parse(jsonStr);
  } catch (err) {
    console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:", err);
    return null;
  }
}

export let adminConfigured = false;
export let db: any = null;
export let authAdmin: Auth | null = null;

const serviceAccount = loadServiceAccount();
const projectId = firebaseConfig?.projectId || process.env.VITE_FIREBASE_PROJECT_ID;
const databaseId = firebaseConfig?.firestoreDatabaseId;

try {
  let app;
  if (serviceAccount) {
    app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(serviceAccount), projectId });
  } else {
    // Fallback to Application Default Credentials with explicit projectId from config
    app = getApps().length ? getApps()[0] : initializeApp({ projectId });
  }
  
  const realDb = databaseId ? getFirestore(app, databaseId) : getFirestore(app);
  db = new HybridFirestore(realDb);
  
  if (!serviceAccount) {
    // Since the sandbox service account lacks cross-project IAM permissions,
    // we pre-emptively force local fallback to prevent PERMISSION_DENIED errors.
    setForceLocalFallback(true);
    console.log("Firebase Admin: Initialized with local fallback database (no service account JSON provided).");
  } else {
    console.log(`Firebase Admin: Initialized with live Firestore (Project: ${projectId}, Database: ${databaseId || "default"})`);
  }
  
  authAdmin = getAuth(app);
  adminConfigured = true;
} catch (error) {
  console.error("Error initializing Firebase Admin:", error);
}
