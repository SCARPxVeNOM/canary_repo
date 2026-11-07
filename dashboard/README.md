# Canary dashboard

The web dashboard for Canary for agents. **Frontend only for now:** every screen shows placeholder content, and nothing talks to a gateway, Tor or ENS yet.

Two tabs:

- **Live:** the operator's view of their own Canary gateway.
  - Health: is Tor actually serving.
  - Coverage: share of chain reads via anon-rpc, and every category counted.
  - Live feed of decisions, with filters.
  - Destinations per host.
  - LLM pseudonymization, with a before/after example.
  - The signed report and its ENS publication.
- **Agent lookup:** type an agent's ENS name and see:
  - its privacy rules (`privacy.manifest`);
  - its signed report (`privacy.report`);
  - the trust checks (signature, signer is the declared reporter, policy matches, reporter can still write, never revoked);
  - the reporter's role history.

## Run

```sh
cd dashboard
npm install
npm run dev        # http://localhost:5180
npm run build      # static files in dist/, servable from any host
```

In development, a **Preview states** panel (bottom right) switches between every screen state:
- Live: serving, warming, failed, no gateway.
- Lookup: empty, connecting to Tor, reading, verified, failing checks, not found, error.

In a production build, add `?preview` to the URL to show it.

## Wiring it up (next step)

Every component takes its content as props. All placeholder content is in [`src/placeholder.ts`](src/placeholder.ts), and [`src/types.ts`](src/types.ts) mirrors the real shapes from the packages, so the swap is one place.

| Placeholder | Real source |
|---|---|
| `STATUS` | `GET /canary/status` on the local gateway |
| `REPORT` | `GET /canary/report` |
| `EVENTS` | `GET /canary/events` (server-sent events, newest first) |
| `LOOKUP_RESULT` | `readAgentPrivacy(client, name)` from `@ayush_saklani/canary-ens` |
| `connection` (App) | from `status.backend.state` and whether calls get through |
| `onSearch` (App) | runs the lookup and moves `lookup` through `reading` → `found` / `notFound` / `error` |
| `onPublish`, `onRotate` (ReportCard) | `POST /canary/publish`, `GET /canary/report?rotate=1` |
| `onTogglePause` (Feed) | pause applying new events |

Two things to know when wiring:

- **Lookups should go over Tor.** When a local gateway is connected, send the ENS reads through its RPC endpoint (`http://127.0.0.1:18545/11155111`), which already uses Tor. On the public site, without a gateway, run anon-rpc in the browser. Never use a plain RPC: that would leak the viewer's IP, which is exactly what Canary is for.
- **The gateway refuses requests from web pages** (`Origin` header → 403; it guards against DNS rebinding). The dashboard's own origin(s) need to be allowed in the gateway, with CORS headers, before the Live tab can connect.

## Layout

```
src/
  App.tsx            tabs, state, dev preview switcher
  Header.tsx         brand, tabs, connection pill
  live/              Live tab: HealthStrip, CoverageCard, Feed, Destinations, LlmCard, ReportCard, NotConnected
  lookup/            Agent lookup: SearchHero, Reading, AgentResult, TrustChecks, PrivacyRules, PublishedReport, RoleHistory
  ui.tsx, format.ts  shared pieces, category labels and colours (same as the extension popup)
  placeholder.ts     all placeholder content
  types.ts           data shapes, mirrored from packages/
  styles.css         palette from the extension UI (extension/src/ui/app.css)
```
