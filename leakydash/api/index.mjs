// Vercel entry. vercel.json sends every path on every hostname here, and the
// handler tells the parties apart by Host, as `node server.mjs` does locally.
import { readFileSync } from "node:fs";
import { createHandler } from "../server.mjs";

export default createHandler(readFileSync(new URL("../dist/app.js", import.meta.url), "utf8"));
