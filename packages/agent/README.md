# @canary/agent

In-process SDK for TypeScript agents (agent-sdk.md §3.4). It hands the gateway what a proxy can't see: HTTPS bodies, and prompts, which it pseudonymizes before they leave. Policy stays in the gateway (one place, from the manifest).

```ts
import { createCanary } from "@canary/agent";

const canary = await createCanary({ gateway: "http://127.0.0.1:18545", wallets: [account.address] });
// or: createCanary({ embedded: gatewayConfig, wallets })  — runs the gateway in this process

const client = createPublicClient({ chain: sepolia, transport: canary.viemTransport() }); // viem
const provider = await canary.ethersProvider(11155111);                                  // ethers v6
globalThis.fetch = canary.fetch;                       // or pass canary.fetch to SDKs that accept one
const openai = new OpenAI({ fetch: canary.llmFetch }); // or canary.wrapLLM(existingClient)
const tools = canary.wrapTools(myTools);               // restores real addresses in tool-call arguments

canary.on("egress", (e) => console.log(e));            // every decision, live
const { signed, coarse } = await canary.report();      // coverage + signed report
```

| API | What |
|---|---|
| `viemTransport()` | every JSON-RPC call to `gateway/<chainId>` |
| `ethersProvider(chainId)` | `JsonRpcProvider` on the gateway (`ethers` is an optional peer dependency) |
| `fetch` | checked against the manifest by the gateway, with the body visible: `anon` hosts via anon-rpc, others direct or refused (403 with `x-canary-decision`) |
| `llmFetch` / `wrapLLM(client)` | pseudonymizes the request body; restores aliases in non-streamed responses; counts per request |
| `wrapTools(tools)` | restores aliases in arguments before each tool runs; an alias Canary never issued fails the call (`UnknownAliasError`) |
| `restore(text)`, `restoreTextStream()` | for streamed text: restore the accumulated text, or pipe text deltas through the stream (holds back a partial alias split across chunks) |
| `pseudonymizer` | the `Pseudonymizer` instance (aliases are stable for the session, in memory only) |
| `on("egress")`, `report()`, `close()` | live events, report, shutdown (also stops an embedded gateway) |

## Pseudonymizer

| In the prompt | Becomes |
|---|---|
| the agent's wallets (`0x…`, or bare 40-hex) | `WALLET_1`, `WALLET_2` (bound up front, so they always restore) |
| other addresses | `ADDR_1`, `ADDR_2` |
| 32-byte hashes (mostly the agent's own tx hashes) | `HASH_1` |
| the agent's ENS name(s) | `AGENT_NAME` |
| allow-listed contracts (manifest `llm.allow` + `allow` option) | unchanged |

Not replaced, and declared: amounts and balances (an exact balance can identify a wallet), and addresses inside longer hex blobs such as calldata. Raw SSE/JSON streams are passed through unchanged, because an alias can be split across events. For streamed responses, restore tool arguments with `wrapTools` and final text with `restore`.

## Test

`npm test`: viem and ethers reads through a real gateway + headless Chrome (passthrough worker), fetch policy, the LLM round trip, tools, events, report, embedded mode, and the pseudonymizer's edge cases.
