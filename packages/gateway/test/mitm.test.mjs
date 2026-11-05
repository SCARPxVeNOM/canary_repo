// HTTPS proxy with the opt-in MITM CA: `anon` HTTPS hosts go through anon-rpc,
// declared-direct hosts are inspected, blocked/undeclared hosts are refused at
// CONNECT, and passthrough hosts are tunnelled untouched.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { mkdtemp, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import forge from "node-forge";
import { createGateway, startChromiumBackend, loadOrCreateCa } from "../dist/index.js";
import { startFixtures, mapTestHosts, CHROME_OPTS } from "./fixtures.mjs";

// The fixture's own certificate is self-signed: the gateway's direct leg must accept it in this test.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
mapTestHosts();
const A = "0x5ca1ab1e00000000000000000000000000c0ffee";
let fx, backend, gw, upstream, caDir, upstreamPort;
const seen = [];

function selfSigned(hosts) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 60000);
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  const subj = [{ name: "commonName", value: "fixture upstream" }];
  cert.setSubject(subj);
  cert.setIssuer(subj);
  cert.setExtensions([{ name: "subjectAltName", altNames: hosts.map((value) => ({ type: 2, value })) }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) };
}

before(async () => {
  const c = selfSigned(["secure-anon.test", "secure-direct.test", "pinned.test"]);
  upstream = https.createServer(c, (req, res) => {
    // The passthrough worker uses the page's fetch, so CORS applies (tor-js doesn't); answer preflights.
    if (req.method === "OPTIONS") return res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST" }).end();
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ host: req.headers.host.split(":")[0], url: req.url, body, origin: req.headers.origin ?? "(none)" });
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" }).end(JSON.stringify({ ok: true, host: req.headers.host }));
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = upstream.address().port;
  fx = await startFixtures();
  backend = await startChromiumBackend({ network: fx.network, ...CHROME_OPTS, args: [...fx.chromiumArgs, "--ignore-certificate-errors"] });
  await backend.ready;
  caDir = await mkdtemp(join(tmpdir(), "canary-ca-"));
  gw = await createGateway({
    backend,
    port: 0,
    proxyPort: 0,
    wallets: [A],
    chains: { 1: { read: fx.url("read.test") } },
    timeoutMs: 8000,
    mitm: { dir: caDir, passthrough: ["pinned.test"] },
    manifest: { v: 1, hosts: { "secure-anon.test": "anon", "secure-direct.test": "direct", "pinned.test": "direct", "nope.test": "block" }, undeclared: "block" },
  });
});
after(async () => {
  await gw?.close();
  await backend?.close();
  await fx?.close();
  upstream.closeAllConnections();
  await new Promise((r) => upstream.close(r));
});

/** HTTPS through the proxy: CONNECT, then TLS verified against `ca` for `host`. */
function viaProxy(host, path, { method = "GET", body, ca, rejectUnauthorized = true } = {}) {
  return new Promise((ok, fail) => {
    const p = new URL(gw.proxyUrl);
    const req = http.request({ host: p.hostname, port: p.port, method: "CONNECT", path: `${host}:${upstreamPort}` });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) return ok({ connect: res.statusCode, reason: res.headers["x-canary-reason"] });
      const s = tls.connect({ socket, servername: host, ca, rejectUnauthorized }, () => {
        const issuer = s.getPeerCertificate().issuer?.CN;
        const payload = body ?? "";
        s.write(`${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`);
        let raw = "";
        s.on("data", (x) => (raw += x));
        s.on("end", () => {
          const [head, ...rest] = raw.split("\r\n\r\n");
          const lines = head.split("\r\n");
          const headers = Object.fromEntries(lines.slice(1).map((l) => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]));
          ok({ connect: 200, status: Number(lines[0].split(" ")[1]), decision: headers["x-canary-decision"], body: rest.join("\r\n\r\n"), issuer });
        });
      });
      s.on("error", fail);
    });
    req.on("error", fail);
    req.end();
  });
}

test("the CA is created once, key private, with a bundle for Python/curl", async () => {
  if (process.platform !== "win32") assert.equal((await stat(gw.ca.key)).mode & 0o777, 0o600, "key readable by the owner only");
  const bundle = await readFile(gw.ca.bundle, "utf8");
  assert.ok(bundle.includes((await readFile(gw.ca.cert, "utf8")).trim()));
  assert.ok(bundle.split("BEGIN CERTIFICATE").length > 50, "public roots included");
  const again = await loadOrCreateCa(caDir);
  assert.equal(again.created, false);
  const s = await (await fetch(gw.url + "/canary/status")).json();
  assert.equal(s.mitm.enabled, true);
});

test("anon HTTPS host: decrypted, then sent through anon-rpc", async () => {
  const ca = await readFile(gw.ca.cert, "utf8");
  const r = await viaProxy("secure-anon.test", "/price", { ca });
  assert.equal(r.status, 200, r.body);
  assert.equal(r.decision, "anon");
  assert.match(r.issuer, /Canary local CA/, "the client verified Canary's certificate for this host");
  assert.equal(seen.at(-1).origin, "null", "left from the anon-rpc worker");
});

test("direct HTTPS host: inspected, bodies visible, sent directly", async () => {
  const ca = await readFile(gw.ca.cert, "utf8");
  const before = gw.ledger.counts.http.notInspected;
  const r = await viaProxy("secure-direct.test", "/q", { method: "POST", body: JSON.stringify({ wallet: A }), ca });
  assert.equal(r.decision, "direct");
  assert.equal(seen.at(-1).origin, "(none)");
  assert.ok(seen.at(-1).body.includes(A));
  assert.equal(gw.ledger.counts.http.notInspected, before, "nothing uninspected");
  const last = [...gw.ledger.hosts.keys()].find((h) => h.startsWith("secure-direct.test"));
  assert.ok(last);
});

test("blocked and undeclared hosts are refused at CONNECT, before any TLS", async () => {
  assert.equal((await viaProxy("nope.test", "/")).connect, 403);
  assert.equal((await viaProxy("undeclared.test", "/")).connect, 403);
});

test("passthrough hosts are tunnelled untouched (the client sees the real certificate)", async () => {
  const r = await viaProxy("pinned.test", "/pin", { ca: undefined, rejectUnauthorized: false });
  assert.equal(r.issuer, "fixture upstream");
  assert.equal(r.decision, undefined, "no Canary headers inside the tunnel");
  assert.ok(gw.ledger.counts.http.notInspected >= 1, "counted as not inspected");
});

test("a client that doesn't trust Canary's CA gets a TLS error, not silent interception", async () => {
  await assert.rejects(viaProxy("secure-direct.test", "/x", { ca: undefined }));
});
