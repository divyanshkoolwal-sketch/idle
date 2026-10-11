# Idle

**Idle is a real-time spot market where AI agents bid for GPU time from data centers.**
Every job is auctioned in milliseconds. Agents pay per job in **AUSD over x402** and per token over **XRPL Payment Channels**. Data centers are verified with **XRPL Credentials**, which are revoked on-ledger when a data center cheats.

For the demo, our laptops are the data centers. Each one runs real inference with Ollama.

Built at B@BHacks 2.0 (October 11, 2026).

## Why

Agents need compute per job, right now, without accounts or credit cards. Data centers have spare minutes they can't sell because GPUs are rented by the hour or by the month. Idle connects the two:

- A **buyer agent** posts a job (embed these texts, generate this answer) with a max price and a deadline.
- The **exchange** runs a sealed-bid **second-price auction** across every verified data center with free capacity. It clears in about 250 ms.
- Each **data center agent** (one per laptop) bids from its live load, measured speed and price floor, so prices rise when the market is busy and fall when it is idle.
- The winner runs the job on its own hardware with Ollama.
- **Batch jobs** are paid in AUSD via x402, straight to the winning data center's wallet, and settled **only after the work passes verification**.
- **Streaming generations** are paid in XRP over a payment channel. The agent signs a claim every few tokens and can stop at any time, so it pays for exactly the tokens it received.
- A data center may bid only after passing a benchmark challenge and receiving an **XRPL Credential**. Spot checks re-run a sample of its work elsewhere. Two strikes and the credential is deleted on the ledger, live.

## Architecture

```
                         ┌──────────────────────── Base Sepolia ───────────────────────┐
                         │  AUSD (ERC-3009)  ◄── transferWithAuthorization (relayer tx)  │
                         └──────────────▲──────────────────────────────────────────────┘
                                        │ settle (only after verify)
 ┌─────────────┐  x402 (402 → signed   ┌┴────────────┐  /verify /settle  ┌──────────────┐
 │ Buyer agent │  ERC-3009 → 200)      │  EXCHANGE   │◄─────────────────►│ FACILITATOR  │
 │ (Claude +   ├──────────────────────►│ auctions    │                   │ :4022        │
 │ Context.dev)│◄── result + receipt ──┤ x402 gate   │                   └──────────────┘
 │             │                        │ verifier    │  ws: rfq/award/   ┌──────────────┐
 │  XRPL payer ├── ws stream + signed ─►│ credentials ├──job/result/────►│ PROVIDER ×N  │
 │             │   paychan claims       │ event bus   │   claims relay    │ (laptop DC)  │
 └──────┬──────┘                        │ sqlite      │                   │ bid agent    │
        │ PaymentChannelCreate          └──────┬──────┘                   │ Ollama       │
        ▼                                      │ ws /v1/events            │ XRPL payee   │
 ┌────────────────────── XRPL Testnet ─────────┼──────────────────────┐   └──────┬───────┘
 │ Credentials (issue/accept/delete)           │                      │◄─────────┘ PaymentChannelClaim,
 │ Payment Channels (create/claim)             ▼                      │            CredentialAccept
 └─────────────────────────────────   DASHBOARD (projector)  ─────────┘
```

| Directory | What it is |
|---|---|
| `apps/exchange` | Express + ws: auctions, x402 gate, verification, credentials, event bus, serves the dashboard |
| `apps/facilitator` | Self-hosted x402 facilitator for AUSD on Base Sepolia (`/verify`, `/settle`, `/supported`) |
| `apps/provider` | Data-center daemon, one per laptop: benchmark, bidding agent, Ollama runner, XRPL stream payee |
| `apps/agent` | Buyer agents (Claude tool-use loop + Context.dev research) with x402 and XRPL payment clients |
| `apps/dashboard` | Vite + React big-screen live market, with replay mode |
| `apps/mcp` | MCP server (`idle_market`, `idle_embed`, `idle_generate`, `idle_budget`) so any MCP agent can buy compute with one tool call |
| `packages/shared` | zod wire protocol, bigint money math, constants |
| `packages/pay-evm` | AUSD helpers, EIP-712 domain loader, x402 client with spending policy, dynamic-price x402 gate |
| `packages/pay-xrpl` | XRPL client, per-account tx queue, Credentials, Payment Channels |
| `scripts` | setup (wallets, funding, AUSD domain) and the six sponsor smoke tests |

## Sponsor integrations

### Agora — AUSD over x402

- x402 v2 `exact` scheme with ERC-3009 `transferWithAuthorization`: gasless for the agent, on Base Sepolia (`eip155:84532`).
- AUSD token `0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC`. Its EIP-712 domain is read on-chain at setup (`name = "Agora Dollar"`, `version = "1"`, 6 decimals) and proven against `DOMAIN_SEPARATOR()` before any signature is made (`pnpm setup:ausd-domain`).
- **Our own facilitator** (`apps/facilitator`) verifies and settles, so AUSD support does not depend on anyone else. Settlements are serialized through one relayer with viem's nonce manager.
- **Dynamic `payTo`**: every 402 names the auction winner's wallet, so money goes agent → data center directly.
- **Settle after verify**: the exchange verifies the signed authorization before dispatching the job, runs the work, spot-checks it, and only then calls `settle`. A provider that fails verification is simply not paid.
- Buyer-side spending policy: per-payment cap, cumulative budget, and the payee must be the quoted winner **and** hold a valid XRPL credential, checked on the ledger before signing.

Explorer links from a live run are listed in [What's real](#whats-real) below.

### Ripple — XRPL Credentials and Payment Channels

- **Credentials** are the trust layer. The exchange issues `IDLE_DC_TIER_A` / `IDLE_DC_TIER_B` with `CredentialCreate` after a data center passes a benchmark challenge; the data center accepts with `CredentialAccept`; the exchange marks it verified only once `ledger_entry` shows `lsfAccepted`. Two failed spot checks → `CredentialDelete`, live, and the data center is ineligible everywhere.
- **Payment Channels** pay per token. The agent opens a channel to the winner, signs a cumulative claim every 16 tokens (`authorizeChannel`, drops-exact), the provider verifies each claim and pauses if more than 32 tokens are unpaid, and the agent can stop at any time. The provider redeems the highest claim with `PaymentChannelClaim`.
- Buyers verify the winner's credential directly on the ledger before paying, so they never have to take the exchange's word for it.

Smoke-test transactions on XRPL testnet (issuer `rM6wXjEPCMByRWfrb61WEcWmzkCTwLkiZ`):

| Step | Transaction |
|---|---|
| CredentialCreate | https://testnet.xrpl.org/transactions/5B48FDA73D62B4DD3EE8429198FA48CDE766335B041328DFF13D2020B5717EB8 |
| CredentialAccept | https://testnet.xrpl.org/transactions/92B9CEA0C3C76A60663D57F0A39E0531E9EC4E8F5543AC1468A5E1C234A10EF9 |
| CredentialDelete | https://testnet.xrpl.org/transactions/61F77A061179C709F29EA68DF79BF53230F721F527523A3906194653B3D10EE2 |
| PaymentChannelCreate (5 XRP) | https://testnet.xrpl.org/transactions/BCBA8F5722B568FA5FF0B1A2DC32EABB8273206DFB45778A5F04898A0E15FED2 |
| PaymentChannelClaim (250,000 drops, exact) | https://testnet.xrpl.org/transactions/16B9E2BD30533BB06EAE23F53D896E28EFEBB617717FAE85F43754AC052B02DA |

Live-market transactions (real provider daemon + buyer agent, same testnet):

| Step | Transaction |
|---|---|
| Streamed generation: 150 tokens × 40 drops, claimed on-ledger after an early stop (cumulative 6,640 drops incl. 640 from a prior stream on the same channel) | https://testnet.xrpl.org/transactions/FCB4C035591C4F5C60DC9E63ACAA30DE233E09208BDA9958838895FCD02DD7A4 |
| A cheating data center (random vectors) caught by spot checks and revoked: CredentialDelete | https://testnet.xrpl.org/transactions/F640B912E1569147DAC3973FBE59C706CA6A3D4B7D7CEACC2C90C0BB21F927CD |

### Context.dev

The buyer research agent's `web_search` and `scrape` tools are Context.dev (`client.web.search`, `client.web.scrape` to markdown, main content only). The pages it keeps are what it buys compute for, and the final answer cites them.

## How to run

Prerequisites: Node 20+, pnpm 9+, [Ollama](https://ollama.com) with `ollama pull nomic-embed-text && ollama pull llama3.2:3b`, and `cloudflared` on the exchange laptop for the public tunnel.

```bash
pnpm install
pnpm setup:wallets        # generates keys/seeds into gitignored .env files; never overwrites
pnpm setup:ausd-domain    # reads and proves AUSD's EIP-712 domain on-chain
pnpm setup:fund           # XRPL faucet + AUSD faucet; prints the two addresses that need dust Base Sepolia ETH

# sponsor smoke tests
pnpm smoke:ausd-domain && pnpm smoke:xrpl-cred && pnpm smoke:paychan && pnpm smoke:ollama
pnpm smoke:x402           # needs the relayer funded
pnpm smoke:context        # needs CONTEXT_DEV_API_KEY

# run the market
pnpm dev:facilitator
pnpm dev:exchange         # http://localhost:8080 (serves the dashboard build)
pnpm provider             # this laptop becomes a data center
pnpm agent --persona analyst "What are the fastest open models on Apple Silicon right now?"
pnpm agent --persona indexer --index https://ollama.com/blog
```

### Join as a data center (judges welcome)

```bash
EXCHANGE_URL=<tunnel url> pnpm provider
```

The daemon generates its own wallets, funds its XRPL account from the testnet faucet, benchmarks the laptop, passes the onboarding challenge, accepts its XRPL credential, and starts bidding.

### Three-laptop demo

See [docs/RUNBOOK.md](docs/RUNBOOK.md) for the exact commands, the 90-second live sequence and the fallbacks. In short: Laptop A runs the facilitator, exchange, a provider and a `cloudflared` tunnel; laptops B and C run `EXCHANGE_URL=<tunnel> pnpm provider`; the agents run on A. `scripts/stack.sh` starts and stops everything with logs under `data/logs/`.

### Use it from Claude Code (MCP)

```bash
claude mcp add idle -- $(pwd)/node_modules/.bin/tsx $(pwd)/apps/mcp/src/index.ts
```

Then any Claude Code session can call `idle_embed`, `idle_generate` (x402 or XRPL stream) and `idle_budget`; spending is capped by `AGENT_BUDGET_AUSD` / `AGENT_BUDGET_XRP`.

## What's real

- Real inference (Ollama on each laptop), real auctions (every bid comes from a provider's live load, surge × shade × jitter), real verification (cosine against reference vectors re-embedded on another provider or the exchange's own model), real payments on testnets. Only configuration is seeded: provider names, regions and price floors.
- The exchange's auction engine has unit tests (ties, single bidder, no valid bid, deadline filter, second-price math); the provider's bidder has unit tests; both apps have end-to-end harnesses (`apps/exchange/test/fake-provider.ts`, `apps/provider/test/fake-exchange.ts`) that run against real Ollama and the real XRPL testnet.
- Testnets only. Secrets live only in gitignored `.env` files.

_Live-run explorer links (Basescan settlements, credential revocation) are added here after the demo run._

## License

MIT
