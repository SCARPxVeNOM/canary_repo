// Bundles the page that runs inside the gateway's headless Chromium
// (src/backend/page.ts + @anon-rpc/browser-harness) into dist/backend/page.js.
import { build } from "esbuild";
import { resolve } from "node:path";

const HERE = import.meta.dirname;
await build({
  entryPoints: [resolve(HERE, "src/backend/page.ts")],
  outfile: resolve(HERE, "dist/backend/page.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  logLevel: "warning",
});
