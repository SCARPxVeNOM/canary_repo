// The deployed handler (api/index.mjs) as Vercel runs it: one handler, three
// hostnames, client IPs in x-forwarded-for. The provider forwards to a stub.
//   npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { bundleApp } from "../server.mjs";

const A = "0x" + "ab".repeat(20);
let srv, upstream, port, createHandler;

before(async () => {
  upstream = createServer((req, res) => res.writeHead(200, { "content-type": "application/json" }).end('{"jsonrpc":"2.0","id":1,"result":"0xaa36a7"}')).listen(0);
  await new Promise((r) => upstream.once("listening", r));
  Object.assign(process.env, {
    LEAKYDASH_DAPP_HOST: "dapp.example.app",
    LEAKYDASH_PROVIDER_HOST: "rpc.example.app",
    LEAKYDASH_TRACKER_HOST: "tracker.example.app",
    UPSTREAM_RPC: `http://127.0.0.1:${upstream.address().port}/`,
  });
  // hosts are read at import, so import after setting them
  ({ createHandler } = await import(`../server.mjs?deployed`));
  srv = createServer(createHandler(await bundleApp())).listen(0);
  await new Promise((r) => srv.once("listening", r));
  port = srv.address().port;
});
after(() => (srv.close(), upstream.close()));

const go = (host, path, { method = "GET", body, ip = "1.1.1.1" } = {}) =>
  new Promise((resolve, reject) => {
    const q = request({ port, path, method, headers: { "x-forwarded-host": host, "x-forwarded-for": ip, "content-type": "application/json" } }, (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => resolve({ status: r.statusCode, headers: r.headers, body: d }));
    });
    q.on("error", reject);
    if (body) q.write(body);
    q.end();
  });
const logsFor = async (sid) => JSON.parse((await go("dapp.example.app", sid ? `/api/logs?sid=${sid}` : "/api/logs")).body).logs;

test("the dapp names this deployment's provider and tracker", async () => {
  const page = await go("dapp.example.app", "/");
  assert.equal(page.status, 200);
  assert.ok(page.body.includes("rpc.example.app") && !page.body.includes("localhost"));
  const js = await go("dapp.example.app", "/app.js");
  assert.ok(js.body.startsWith('const __PROVIDER__ = "https://rpc.example.app/", __TRACKER__ = "https://tracker.example.app";'));
  assert.equal(JSON.parse((await go("dapp.example.app", "/.well-known/canary.json")).body).ens, "leakydash.eth");
});

test("the provider logs, then forwards", async () => {
  const r = await go("rpc.example.app", "/?sid=p1", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [A, "latest"] }) });
  assert.equal(JSON.parse(r.body).result, "0xaa36a7");
  const [e] = (await logsFor("p1")).provider;
  assert.deepEqual(e.methods, ["eth_getBalance"]);
  assert.deepEqual(e.addresses, [A]);
});

test("each visitor sees exactly their own entries, whatever IP each request left from", async () => {
  await go("tracker.example.app", `/p.gif?uid=${A}&sid=s1`, { ip: "1.1.1.1" });
  await go("tracker.example.app", "/collect", { method: "POST", body: JSON.stringify({ address: A, sid: "s1" }), ip: "9.9.9.9" });
  await go("tracker.example.app", `/p.gif?uid=${A}&sid=s2`, { ip: "1.1.1.1" }); // someone else, same IP
  const mine = await logsFor("s1");
  assert.equal(mine.tracker.length, 2);
  assert.ok(mine.tracker.every((e) => e.sid === undefined), "the id isn't echoed");
  assert.ok(Object.values(await logsFor()).every((v) => v.length === 0), "no id, nothing shown");
  await go("dapp.example.app", "/api/logs/clear?sid=s1");
  assert.equal((await logsFor("s1")).tracker.length, 0);
  assert.equal((await logsFor("s2")).tracker.length, 1, "clearing leaves other visitors' entries");
});

test("other hostnames redirect to the dapp", async () => {
  const r = await go("leakydash-abc123.vercel.app", "/logs");
  assert.equal(r.status, 308);
  assert.equal(r.headers.location, "https://dapp.example.app/logs");
});
