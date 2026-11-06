// Build the page into public/ (vercel.json's buildCommand): app.js, the static
// files, and /.well-known/canary.json, which names this origin's ENS name.
import { build } from "esbuild";
import { cp, mkdir, writeFile } from "node:fs/promises";

const out = new URL("public/", import.meta.url);
await mkdir(new URL(".well-known/", out), { recursive: true });
await cp(new URL("static/", import.meta.url), out, { recursive: true });
await build({
  entryPoints: [new URL("src/app.ts", import.meta.url).pathname],
  outfile: new URL("app.js", out).pathname,
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  logLevel: "warning",
});
await writeFile(new URL(".well-known/canary.json", out), JSON.stringify({ ens: process.env.CANARY_SWAP_ENS ?? "swap.canary.eth" }) + "\n");
