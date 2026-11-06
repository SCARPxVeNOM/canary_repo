// Build the unpacked extension into dist/.
//
//   node build.mjs                       # config/live.json → dist/
//   node build.mjs --config x.json --out somewhere/
//
// The harness's four packaged assets are copied from node_modules on every
// build (see the harness README: a stale copy fails silently otherwise).

import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ensureTorBootstrap } from "./scripts/fetch-tor-bootstrap.mjs";

const require = createRequire(import.meta.url);
const HERE = import.meta.dirname;

export async function buildExtension(cfg, out) {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const harness = dirname(require.resolve("@anon-rpc/browser-extension-harness/package.json"));
  await cp(resolve(harness, "dist/static/anon-rpc"), resolve(out, "anon-rpc"), { recursive: true });

  const runtime = { network: cfg.network, readEndpoints: cfg.readEndpoints, timeoutMs: cfg.timeoutMs ?? 30000 };

  // tor-js fast-bootstrap snapshot (config "torBootstrap": true). Refreshed when
  // the packaged one is over 3 h old; skipped with a warning if no gateway
  // answers, since the worker can always fetch it from a gateway itself.
  if (cfg.torBootstrap) {
    const gateways = cfg.network.workerConfig?.gateways ?? [];
    try {
      const meta = await ensureTorBootstrap(gateways, resolve(HERE, ".tor-bootstrap"));
      await cp(resolve(HERE, ".tor-bootstrap/bootstrap.zip.zst"), resolve(out, "tor-bootstrap.zip.zst"));
      // Arti accepts a consensus up to 3 days past valid-until; stay inside that.
      runtime.torBootstrap = { file: "tor-bootstrap.zip.zst", fetchedAt: meta.validAfter, maxAgeHours: 72 };
      console.log(`packaged tor-js snapshot: ${(meta.bytes / 1e6).toFixed(2)} MB, consensus valid-after ${new Date(meta.validAfter).toISOString()}`);
    } catch (e) {
      console.warn(`warning: no tor-js snapshot packaged (${e.message}); the worker will fetch it from a gateway on first boot`);
    }
  }
  // Dev only (config "network.devWorker": { "bundle": path, "url": served-at }):
  // run a worker build that isn't pinned on chain, e.g. tor-js with the patches
  // in ../tor-js-patches/. Its keccak256 is pinned here at build time and the
  // harness still verifies the bytes it loads against it, but the pin is ours,
  // not the specifier owner's. Never set in config/live.json.
  if (cfg.network.devWorker) {
    const { keccak_256 } = await import("@noble/hashes/sha3");
    const bytes = await readFile(resolve(HERE, cfg.network.devWorker.bundle));
    const hash = "0x" + Buffer.from(keccak_256(bytes)).toString("hex");
    runtime.network = { ...cfg.network, devWorker: { hash, url: cfg.network.devWorker.url } };
    console.warn(`warning: dev worker ${hash.slice(0, 12)}… from ${cfg.network.devWorker.url}, not the on-chain pin`);
  }
  const common = { bundle: true, platform: "browser", target: "es2022", logLevel: "warning", sourcemap: "linked", plugins: [sharedPackages] };
  await build({ ...common, format: "esm", entryPoints: [resolve(HERE, "src/background.ts")], outfile: resolve(out, "background.js"), define: { __CANARY_CONFIG__: JSON.stringify(runtime) } });
  for (const name of ["shim", "bridge", "popup"]) {
    await build({ ...common, format: "iife", entryPoints: [resolve(HERE, `src/${name}.ts`)], outfile: resolve(out, `${name}.js`) });
  }
  for (const f of ["popup.html", "popup.css"]) await cp(resolve(HERE, "static", f), resolve(out, f));

  const manifest = {
    manifest_version: 3,
    name: "Canary",
    version: JSON.parse(await readFile(resolve(HERE, "package.json"), "utf8")).version,
    description: "Answers a dapp's RPC reads through anon-rpc, blocks third-party requests carrying your address, and shows what it covered.",
    minimum_chrome_version: "111",
    background: { service_worker: "background.js", type: "module" },
    action: { default_popup: "popup.html", default_title: "Canary" },
    permissions: ["offscreen", "storage", "declarativeNetRequest", "declarativeNetRequestFeedback"],
    host_permissions: cfg.hostPermissions,
    content_scripts: [
      // Order matters: the bridge must be listening before the shim says hello.
      { matches: cfg.matches, js: ["bridge.js"], run_at: "document_start", all_frames: true, match_about_blank: true },
      { matches: cfg.matches, js: ["shim.js"], run_at: "document_start", all_frames: true, match_about_blank: true, world: "MAIN" },
    ],
    sandbox: { pages: ["anon-rpc/*/sandbox.html"] },
    content_security_policy: {
      sandbox: "sandbox allow-scripts; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; child-src 'self' blob:; worker-src 'self' blob:; connect-src *;",
    },
  };
  await writeFile(resolve(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return out;
}

/**
 * Code shared with ../packages (the verdict format in packages/ens) imports
 * viem and @canary/core by name. Resolve both from here: one viem in the
 * bundle, the core source, and nothing needed outside extension/.
 */
export const sharedPackages = {
  name: "shared-packages",
  setup(b) {
    b.onResolve({ filter: /^@canary\/core$/ }, () => ({ path: resolve(HERE, "../packages/core/src/index.ts") }));
    b.onResolve({ filter: /^viem(\/.*)?$/ }, (a) =>
      a.pluginData === "shared" || a.resolveDir.startsWith(HERE) ? undefined : b.resolve(a.path, { resolveDir: HERE, kind: a.kind, pluginData: "shared" }),
    );
  },
};

if (process.argv[1] === import.meta.filename) {
  const { values } = parseArgs({ options: { config: { type: "string", default: "config/live.json" }, out: { type: "string", default: "dist" } } });
  const cfg = JSON.parse(await readFile(resolve(HERE, values.config), "utf8"));
  await buildExtension(cfg, resolve(HERE, values.out));
  console.log(`built ${values.out}/ from ${values.config}`);
}
