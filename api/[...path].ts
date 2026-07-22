// Vercel serverless entry point. Any request to /api/* (this file's dynamic
// catch-all route) is handed straight to the same Express app used
// everywhere else (AI Studio, local `tsx server.ts`) — every route defined
// in ../server.ts (analyze, generate, composite, admin, billing, etc.) keeps
// working unchanged. See the `export default app` / `VERCEL` guard at the
// bottom of server.ts for the other half of this wiring.
// NOTE: the ".js" extension here is required, not optional — this project
// runs as native ESM ("type": "module" in package.json), and Vercel does not
// bundle this import into a single file the way esbuild does locally. At
// runtime Node's own strict ESM resolver looks up this exact specifier, and
// Node's ESM resolution requires explicit extensions on relative imports
// (unlike CommonJS/bundler resolution, which happily infers ".ts"/".js").
// Omitting it causes every single request to crash with
// `ERR_MODULE_NOT_FOUND: Cannot find module '/var/task/server'` before any
// route code runs — which is exactly the 500 on every /api/* call we just
// saw live (including the trivial /api/health route).
import app from "../server.js";

export default app;
