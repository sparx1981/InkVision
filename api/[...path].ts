// Vercel serverless entry point. Any request to /api/* (this file's dynamic
// catch-all route) is handed straight to the same Express app used
// everywhere else (AI Studio, local `tsx server.ts`) — every route defined
// in ../server.ts (analyze, generate, composite, admin, billing, etc.) keeps
// working unchanged. See the `export default app` / `VERCEL` guard at the
// bottom of server.ts for the other half of this wiring.
import app from "../server";

export default app;
