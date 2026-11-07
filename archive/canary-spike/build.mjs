// Assemble the Canary spike into an unpacked MV3 extension.
//
//   node build.mjs <config.json> <outDir>
//
// config.json: { specifier, bootstrapRpc, workerConfig?, readEndpoints: {chainId: url},
//                matches: [...content-script match patterns], hostPermissions: [...] }

import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = import.meta.dirname;

export async function buildCanary(cfg, out) {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const assets = resolve(dirname(require.resolve("@anon-rpc/browser-extension-harness/package.json")), "dist/static/anon-rpc");
  await cp(assets, resolve(out, "anon-rpc"), { recursive: true });

  const runtimeCfg = { specifier: cfg.specifier, bootstrapRpc: cfg.bootstrapRpc, workerConfig: cfg.workerConfig, readEndpoints: cfg.readEndpoints };
  const common = { bundle: true, platform: "browser", target: "es2022", logLevel: "warning", nodePaths: [resolve(HERE, "../node_modules")] };
  await build({ ...common, format: "esm", entryPoints: [resolve(HERE, "src/background.ts")], outfile: resolve(out, "background.js"), define: { __CANARY_CONFIG__: JSON.stringify(runtimeCfg) } });
  await build({ ...common, format: "iife", entryPoints: [resolve(HERE, "src/shim.ts")], outfile: resolve(out, "shim.js") });
  await build({ ...common, format: "iife", entryPoints: [resolve(HERE, "src/bridge.ts")], outfile: resolve(out, "bridge.js") });

  const manifest = {
    manifest_version: 3,
    name: "Canary spike",
    version: "0.0.1",
    description: "Answers a dapp's JSON-RPC reads through anon-rpc instead of the dapp's provider.",
    background: { service_worker: "background.js", type: "module" },
    permissions: ["offscreen", "storage"],
    host_permissions: cfg.hostPermissions,
    content_scripts: [
      { matches: cfg.matches, js: ["shim.js"], run_at: "document_start", world: "MAIN", all_frames: true },
      { matches: cfg.matches, js: ["bridge.js"], run_at: "document_start", all_frames: true },
    ],
    sandbox: { pages: ["anon-rpc/*/sandbox.html"] },
    content_security_policy: {
      sandbox: "sandbox allow-scripts; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; child-src 'self' blob:; worker-src 'self' blob:; connect-src *;",
    },
  };
  await writeFile(resolve(out, "manifest.json"), JSON.stringify(manifest, null, 2));
  return out;
}

if (process.argv[1] === import.meta.filename) {
  const [cfgPath, out] = process.argv.slice(2);
  await buildCanary(JSON.parse(await readFile(cfgPath, "utf8")), resolve(out));
  console.log("built", out);
}
