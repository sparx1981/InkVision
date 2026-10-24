// Bundles server.ts with firebaseAdmin swapped for the test double.
import { build } from "esbuild";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [path.join(here, "../../server.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  packages: "external",
  outfile: path.join(here, ".out/server.cjs"),
  logLevel: "error",
  plugins: [{ name: "stub-firebase-admin", setup(b) { b.onResolve({ filter: /firebaseAdmin(\.js)?$/ }, () => ({ path: path.join(here, "stubAdmin.ts") })); } }]
});
