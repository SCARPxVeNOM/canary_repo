// The shared code the tests use (verdict signing, declared vs observed), bundled
// from source the way build.mjs bundles it into the extension, so the tests
// need nothing outside extension/ either.
import { build } from "esbuild";
import { sharedPackages } from "../build.mjs";

const out = new URL("out/shared-src.mjs", import.meta.url).pathname;
await build({
  stdin: { contents: 'export * from "../packages/ens/src/verdict.ts"; export { compareDeclared } from "../packages/core/src/index.ts";', resolveDir: new URL("..", import.meta.url).pathname, loader: "ts" },
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "warning", plugins: [sharedPackages],
});
export const { signVerdict, compareDeclared } = await import(out);
