// Bundle the dapp for a deployment (vercel.json's buildCommand): dist/app.js
// for the function, and public/ for the one file served as is.
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { bundleApp } from "./server.mjs";

await mkdir(new URL("dist/", import.meta.url), { recursive: true });
await writeFile(new URL("dist/app.js", import.meta.url), await bundleApp());
await mkdir(new URL("public/", import.meta.url), { recursive: true });
await copyFile(new URL("static/style.css", import.meta.url), new URL("public/style.css", import.meta.url));
