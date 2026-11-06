// public/ on http://localhost:3300 for local runs: npm run build && npm start
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const ROOT = new URL("public/", import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 3300);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" };

createServer(async (req, res) => {
  let path;
  try {
    path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
  } catch {
    return res.writeHead(400).end();
  }
  const file = join(ROOT, path.endsWith("/") ? `${path}index.html` : path);
  if (!file.startsWith(ROOT)) return res.writeHead(403).end();
  const body = await readFile(file).catch(() => null);
  if (!body) return res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
}).listen(PORT, () => console.log(`Canary Swap on http://localhost:${PORT}`));
