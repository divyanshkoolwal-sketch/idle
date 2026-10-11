# IDLE — Build Plan for Claude Code

> **Idle is a real-time spot market where AI agents bid for GPU time from data centers.**
> Every job is auctioned in milliseconds. Agents pay per job in **AUSD over x402** and per token over **XRPL Payment Channels**. Data centers are verified with **XRPL Credentials**, which are revoked automatically when a data center cheats.
> For the demo, our laptops are the data centers. Each laptop runs real inference with Ollama.

Hackathon: B@BHacks 2.0. Tracks: **Most Technically Impressive** (general), **Best Use of AUSD (Agora)**, **Best Use of Ripple (XRPL)**, **BONUS: Context.dev**, optional **YZi Labs** (compute markets are on their idea list).

---

## 0. Read this first, Claude

1. You are building this end to end. Work phase by phase (Section 7). Every phase ends with an acceptance check. **Run it for real.** Do not move on while a check is red.
2. Use **TaskCreate/TaskUpdate** to track phases. Use the **Agent tool** to run the parallel workstreams marked ∥ in Section 7, giving each subagent its section of this file as context.
3. Load skills with the **Skill tool** wherever this plan says `Skill:`. If a skill name isn't found, list the available skills and use the closest match. **Never block on a missing skill.**
4. **Do not guess SDK APIs.** Before writing code against x402, xrpl.js, Context.dev, the AUSD contract or Ollama, read the installed package's types or source in `node_modules`, or the docs MCP servers (Section 4). Wherever this plan says **VERIFY**, check before coding.
5. **No hard-coded core functionality.** Auctions, bids, inference, verification and payments must all be real. Only configuration may be seeded: provider names, regions and price floors. The judges will check.
6. Testnets only. Secrets live only in `.env` / `.env.local` (gitignored). Keep the repo public with real history: commit at the end of every phase (Skill: `ecc:git-workflow`). All code must be written during the hackathon.
7. If something external fails (faucet, RPC, facilitator), use the fallbacks in Section 11 instead of stopping.

---

## 1. What we are building

Agents need compute per job, right now, without accounts or credit cards. Data centers have spare minutes they can't sell because GPUs are rented by the hour or month. Idle connects the two:

- A **buyer agent** posts a job: embed these texts, or generate this answer. It sets a max price and a deadline.
- The **exchange** runs a sealed-bid **second-price auction** across all verified data centers that have free capacity. It clears in about 250 ms.
- Each **data center agent** (one per laptop) bids from its live load, measured speed and price floor, so prices rise when the market is busy and fall when it's idle.
- The winner runs the job on its own hardware with **Ollama**.
- Payment:
  - **Batch jobs (embeddings, short generations):** AUSD on Base Sepolia via **x402**, paid **directly to the winning data center's wallet**. Settlement happens **only after the work passes verification**.
  - **Streaming generations:** XRP over an **XRPL Payment Channel**. The agent signs a claim every few tokens and can stop at any time, so it pays for exactly the tokens it received.
- **Trust:** a data center becomes eligible to bid only after passing a benchmark challenge and receiving an **XRPL Credential**. Spot checks re-run a sample of work on another data center. Two strikes and the credential is deleted on-ledger, live.

The demo moment: two agents compete for compute, prices move on the big screen, a cheating data center gets caught and revoked on XRPL, and when a laptop's lid closes, supply drops and the price jumps.

---

## 2. Sponsor integration (what judges see)

| Sponsor | What we use | Where | What judges see |
|---|---|---|---|
| **Agora (AUSD)** | x402 `exact` scheme with ERC-3009 `transferWithAuthorization`, gasless for the agent, on Base Sepolia. Our own facilitator settles AUSD. Dynamic `payTo` sends money straight to the winning data center. Settle-after-verify. | `apps/facilitator`, `apps/exchange/src/x402gate.ts`, `packages/pay-evm`, `apps/agent` | A Basescan tx link for every job, buyer → data center, in AUSD |
| **Ripple (XRPL)** | **Credentials** (CredentialCreate / Accept / Delete) as the data-center trust layer. **Payment Channels** (PaymentChannelCreate, off-ledger signed claims, PaymentChannelClaim) for per-token streaming. Buyer-side on-ledger credential check before paying. | `packages/pay-xrpl`, `apps/exchange/src/credentials.ts`, `apps/provider/src/stream.ts` | XRPL testnet explorer links for credential issue, accept and revoke, plus channel claims |
| **Context.dev** | The buyer research agent's web search and scrape (`/web/search`, `web.scrape` to markdown) feed the jobs it buys compute for | `apps/agent/src/tools/context.ts` | The agent's cited sources |
| **YZi Labs** (stretch) | Job-receipt log contract on BSC testnet: tamper-evident records of agents buying compute | `contracts/` | BscScan testnet tx per receipt |

---

## 3. Verified constants (checked against official docs on Oct 11, 2026)

**Base Sepolia / AUSD**
- Chain ID `84532`, CAIP-2 `eip155:84532`, RPC `https://sepolia.base.org`, explorer `https://sepolia.basescan.org`
- **AUSD token (Base Sepolia):** `0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC`
- **AUSD faucet (Base Sepolia):** `0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C`. Call `requestFunds(address)` to mint 10,000 AUSD. The **caller needs a little Base Sepolia ETH for gas**. VERIFY the faucet ABI from the verified contract on Basescan.
- AUSD implements EIP-712, ERC-1271, ERC-2612 and ERC-3009. **The EIP-712 domain `name`/`version` are not documented.** Read them on-chain (Phase 0 script). **Read `decimals()` on-chain** too; expect 6. Skill: `ecc:evm-token-decimals`.
- Base Sepolia ETH comes from the CDP faucet (portal.cdp.coinbase.com → Faucet) or Alchemy's Base Sepolia faucet. This is the one manual step.

**x402 (v2)**
- Packages: `@x402/core`, `@x402/evm`, `@x402/express`, `@x402/fetch` (plus `viem`).
- Network ID: `"eip155:84532"`.
- Custom EIP-3009 tokens: pass `asset` (token address) and `extra: { name, version }`, which must match the token's EIP-712 domain.
- Self-hosted facilitator: `x402Facilitator` from `@x402/core/facilitator`, `registerExactEvmScheme` from `@x402/evm/exact/facilitator`, `toFacilitatorEvmSigner` from `@x402/evm`. Its relayer wallet pays the gas for each settlement.
- Hosted `https://x402.org/facilitator` supports Base Sepolia, but **we self-host** so AUSD support doesn't depend on anyone else.
- Skill: `ecc:agent-payment-x402`.

**XRPL**
- Testnet WebSocket `wss://s.altnet.rippletest.net:51233`. Fund accounts with `client.fundWallet()`. Explorer `https://testnet.xrpl.org` (`/transactions/<hash>`, `/accounts/<address>`).
- Credentials: `CredentialCreate` (issuer → subject, hex `CredentialType`), `CredentialAccept` (subject), `CredentialDelete` (issuer or subject).
  - Look one up with `ledger_entry` `{ credential: { subject, issuer, credential_type } }`.
  - It's accepted when flag `lsfAccepted = 0x00010000` is set.
  - Hex-encode with `convertStringToHex(...)`.
- **Payment Channels carry XRP only.**
  - `PaymentChannelCreate { Amount, Destination, SettleDelay, PublicKey }`.
  - Off-ledger claims via `signPaymentChannelClaim` / `verifyPaymentChannelClaim` from xrpl.js. **VERIFY the parameter units: these take an XRP string, not drops.**
  - `PaymentChannelClaim { Channel, Balance, Amount, Signature, PublicKey }` is submitted by the destination.

**Context.dev**
- npm package `context.dev`: `new ContextDev({ apiKey: process.env.CONTEXT_DEV_API_KEY })`.
- Scrape: `client.web.scrape({ url, formats: { markdown: true }, sharedParams: { mainContentOnly: true } })` returns `page.markdown.data`. Check `success` before reading `data`.
- Search: `POST https://api.context.dev/v1/web/search` with `{ query }` and header `Authorization: Bearer <key>`. VERIFY the SDK method name for search.

**Ollama (on every laptop)**
- Embed: `POST http://localhost:11434/api/embed { model, input: string[] }` returns `{ embeddings: number[][] }`.
- Generate: `POST /api/generate { model, prompt, stream: true, options: { num_predict, temperature, seed } }` streams NDJSON. The final chunk has `eval_count` and `eval_duration`.
- **Every laptop must pull the same model tags:** `nomic-embed-text` and `llama3.2:3b`. Use `qwen2.5:1.5b` if a laptop is slow.

---

## 4. Phase 0 — Setup (lead agent, sequential)

### 4.1 Tooling (run once)
```bash
claude mcp add --transport http agora https://docs.agora.finance/_mcp/server
claude mcp add --transport http xrpl https://xrpl.org/mcp
npx skills add https://docs.context.dev --skill context-dev --yes
```
Machine prerequisites:
- Node 20+, pnpm 9+
- Ollama on every laptop, then `ollama pull nomic-embed-text && ollama pull llama3.2:3b`
- `cloudflared` on the exchange laptop for the public tunnel

Skills for this phase: `ecc:search-first`, `ecc:documentation-lookup`, `ecc:contract-first`, `ecc:agent-payment-x402`, `ecc:evm-token-decimals`, `ecc:llm-trading-agent-security` (agent wallet hygiene).

### 4.2 Repo scaffold
```
idle/
  apps/
    exchange/      # Express + ws: auctions, x402 gate, verification, credentials, events, serves dashboard build
    facilitator/   # x402 facilitator (verify/settle/supported) for AUSD on Base Sepolia, port 4022
    provider/      # data-center daemon (one per laptop): benchmark, bidding agent, Ollama runner, XRPL stream payee
    agent/         # buyer agents (Claude tool-use loop) + Context.dev tools + x402 client + XRPL channel payer
    mcp/           # (stretch) MCP server so any Claude/Cursor agent can buy compute
    dashboard/     # Vite + React + TS + Tailwind + framer-motion + recharts — big-screen live market
  packages/
    shared/        # zod schemas, WS message types, constants, money math (bigint), event names
    pay-evm/       # AUSD helpers, EIP-712 domain loader, x402 client factory, spending policy
    pay-xrpl/      # xrpl client, wallet mgmt, credentials, payment channels, tx queue
  contracts/       # (stretch) BSC testnet receipts contract
  scripts/         # setup + smoke tests
  data/            # sqlite db (gitignored)
  .env.example  README.md  IDLE_BUILD_PLAN.md
```
- pnpm workspaces, TypeScript strict, `tsx` for running, `vitest` for tests, a shared `tsconfig.base.json`.
- All money is **bigint in atomic units**: AUSD atomic (10^-decimals) and XRP drops. Never use floats for money.

### 4.3 `.env.example`
```bash
# ---- shared ----
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
BASE_SEPOLIA_RPC_FALLBACK=            # optional Alchemy/Infura URL
AUSD_ADDRESS=0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC
AUSD_FAUCET=0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C
AUSD_EIP712_NAME=                     # written by pnpm setup:ausd-domain
AUSD_EIP712_VERSION=
AUSD_DECIMALS=
XRPL_WSS=wss://s.altnet.rippletest.net:51233
EXCHANGE_URL=http://localhost:8080    # providers on other laptops use the tunnel URL
FACILITATOR_URL=http://localhost:4022

# ---- exchange ----
EXCHANGE_XRPL_SEED=                   # credential issuer
ADMIN_TOKEN=
RFQ_WINDOW_MS=250
QUOTE_TTL_MS=15000
SPOTCHECK_RATE=0.2
STRIKES_TO_REVOKE=2
PAYMENTS=on                           # "off" only for Phase 1 dev

# ---- facilitator ----
FACILITATOR_PRIVATE_KEY=              # relayer, needs Base Sepolia ETH

# ---- provider (per laptop, in apps/provider/.env.local) ----
PROVIDER_NAME=DC-Berkeley-1
PROVIDER_REGION=us-west · Berkeley
PROVIDER_SLOTS=2
PROVIDER_EVM_PRIVATE_KEY=             # receive-only; no ETH needed
PROVIDER_XRPL_SEED=
OLLAMA_URL=http://localhost:11434
EMBED_MODEL=nomic-embed-text
GEN_MODEL=llama3.2:3b
FLOOR_EMBED_AUSD_PER_TEXT=15          # atomic AUSD units
FLOOR_GEN_AUSD_PER_TOKEN=25
FLOOR_GEN_DROPS_PER_TOKEN=40
CHEAT=false

# ---- buyer agent ----
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-5-5     # use claude-haiku-5-5 for speed
AGENT_EVM_PRIVATE_KEY=                # holds AUSD; needs a little ETH only to call the faucet
AGENT_XRPL_SEED=
AGENT_BUDGET_AUSD=5
AGENT_BUDGET_XRP=20
CONTEXT_DEV_API_KEY=
```

### 4.4 Setup scripts (`scripts/`)
- `setup:wallets`: generates any missing keys and seeds into the right `.env.local` files and prints all addresses. **It never overwrites existing keys.**
- `setup:fund`:
  - XRPL: `fundWallet` for the exchange issuer, every agent and the local provider.
  - EVM: prints the addresses that need Base Sepolia ETH (facilitator relayer about 0.05 ETH; each agent wallet about 0.002 ETH, used only for the faucet call). Waits and polls until they're funded.
  - Then calls the AUSD faucet `requestFunds(agentAddress)` for each agent and prints balances.
- `setup:ausd-domain`:
  - Calls `eip712Domain()` (EIP-5267) on AUSD. If that reverts, it falls back to `name()` plus `version()`, and if `version()` is missing it tries `"1"`.
  - **Proves the domain is correct** by computing the domain separator and comparing it to on-chain `DOMAIN_SEPARATOR()`.
  - Reads `decimals()`. Writes `AUSD_EIP712_NAME`, `AUSD_EIP712_VERSION` and `AUSD_DECIMALS` to `.env`.
  - Also records which `transferWithAuthorization` overload AUSD exposes (`bytes signature` or `v,r,s`), from the verified ABI on Basescan or by `eth_call` simulation.

### 4.5 Smoke tests — these must pass before Phase 1 (they cover the riskiest parts)
1. `pnpm smoke:ausd-domain`: domain separator matches on-chain.
2. `pnpm smoke:x402`: start `apps/facilitator`. Start a throwaway Express route priced at **0.01 AUSD** with `asset=AUSD`, `extra={name,version}` and `payTo=<a provider address>`. Call it using `@x402/fetch` with the agent wallet. **It passes when the response is 200 and the Basescan tx shows AUSD moving agent → provider.** If the stock facilitator `settle` fails on AUSD, see Section 11 (custom settle).
3. `pnpm smoke:xrpl-cred`: issuer creates credential `IDLE_DC_TIER_A` for a subject → subject accepts → verify `ledger_entry` + `lsfAccepted` → delete. Print three explorer links.
4. `pnpm smoke:paychan`: buyer opens a 5 XRP channel to a provider → signs a cumulative claim for 0.25 XRP → provider verifies → provider submits `PaymentChannelClaim` → check the provider's balance increased. Print links.
5. `pnpm smoke:ollama`: embed 4 texts (vector dims are consistent) and generate 32 tokens (tokens/sec printed).
6. `pnpm smoke:context`: search "Apple Silicon local LLM inference benchmarks", then scrape the top result to markdown.

Commit: `chore: scaffold, wallets, sponsor smoke tests passing`.

---

## 5. Architecture

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

---

## 6. Detailed specs

### 6.1 Data model (SQLite, `better-sqlite3`, plain SQL migrations)
- `providers(id, name, region, hardware, evm_address, xrpl_address, models_json, slots, bench_embed_tps, bench_gen_tps, tier, status[pending|verified|suspended|offline], strikes, created_at)`
- `credentials(id, provider_id, credential_type, issue_tx, accept_tx, delete_tx, status, updated_at)`
- `auctions(id, job_id, job_type, model, units, currency[AUSD|XRP], max_unit_price, deadline_ms, opened_at, closed_at, winner_provider_id, clearing_unit_price, status)`
- `bids(id, auction_id, provider_id, unit_price, eta_ms, received_at, valid, reason)`
- `jobs(id, buyer_id, persona, job_type, model, units, rail[x402|xrpl], status[quoted|paid_pending|running|verifying|done|failed], provider_id, result_ref, latency_ms, created_at)`
- `payments(id, job_id, rail, amount_atomic, payer, payee, tx_hash, status[verified|settled|not_settled], reason, created_at)`
- `streams(id, job_id, channel_id, buyer_pubkey, drops_per_token, tokens_delivered, claimed_drops, claim_tx)`
- `agent_logs(id, agent_id, persona, kind[thought|action|spend|result], text, created_at)`

### 6.2 Job types, units, pricing
| Job | Unit | Rail | Currency | Default floors (per provider, configurable) |
|---|---|---|---|---|
| `embed` (≤ 64 texts) | 1 text | x402 | AUSD atomic | 10–25 per text |
| `generate` (≤ 256 tokens) | 1 output token, charged on `maxTokens` | x402 | AUSD atomic | 20–40 per token |
| `stream` (long generation) | 1 **delivered** token | XRPL channel | drops | 30–60 per token |

The contrast is a demo point: the x402 rail prices a fixed job up front, while the XRPL stream rail charges only for tokens actually delivered and the agent can stop at any time.

### 6.3 Auction engine (`apps/exchange/src/auction.ts`)
Skills: `ecc:latency-critical-systems`, `ecc:backend-patterns`.
```
openAuction(job):
  eligible = providers where status=verified AND credential accepted
             AND job.model in models AND freeSlots>0 AND tier>=job.minTier
  if eligible empty → 503 NO_CAPACITY {retryAfterMs}
  broadcast RFQ {auctionId, jobType, model, units, currency, maxUnitPrice, deadlineMs, closeAt=now+RFQ_WINDOW_MS}
  collect bids until closeAt OR every eligible provider has bid
  valid = bids where unitPrice<=maxUnitPrice AND etaMs<=deadlineMs
  if valid empty → 409 NO_ACCEPTABLE_BID {bestBid, suggestedMaxUnitPrice}   // agent can raise its bid
  sort valid by (unitPrice asc, etaMs asc, reputation desc)
  winner = valid[0]
  clearing = valid.length>=2 ? min(valid[1].unitPrice, maxUnitPrice) : winner.unitPrice   // second price
  reserve one winner slot for QUOTE_TTL_MS (release on expiry)
  persist auction + all bids; emit auction.opened / auction.bid / auction.cleared
  return Quote {quoteId, auctionId, providerId, payTo (evm or xrpl), unitPrice=clearing, units,
                amount=clearing*units (bigint), currency, expiresAt}
```
- Losers receive `lose {auctionId, clearingUnitPrice}` so their pricing agents can learn.
- Unit-test the auction with vitest: ties, a single bidder, no valid bids, the deadline filter and second-price math.

### 6.4 Data-center daemon (`apps/provider`)
Skills: `ecc:benchmark-methodology`, `ecc:error-handling`.

**Startup**
1. Load config, create wallets if missing, and fund the XRPL account if new.
2. Detect hardware: `os.cpus()[0].model` and total RAM. On macOS add `system_profiler SPHardwareDataType` (chip name) for the rack card.
3. **Benchmark:** embed 64 sample texts ×3, giving texts/sec. Generate 128 tokens ×2, giving tokens/sec from `eval_count / eval_duration`.
4. Connect WS `EXCHANGE_URL/v1/providers/ws` and send `hello {name, region, hardware, evmAddress, xrplAddress, xrplPublicKey, models, slots, benchmark}`.
5. Answer the onboarding challenge (6.5).
6. On `credential.offered`, auto-submit `CredentialAccept`, then send `credential.accepted {txHash}`.
7. Send `heartbeat {busySlots, queueDepth}` every second.

**Bidding agent (real, adaptive)**
```
u = busySlots/slots
surge = 1 + 1.5*u^2
price = floor[jobType][currency] * surge * shade
shade starts 1.0. After each auction it learns from the last 10:
  winRate < 0.3 → shade *= 0.95 (never below floor)
  winRate > 0.6 → shade *= 1.05
jitter ±3%
etaMs = queueDepth*avgJobMs + units/throughput(jobType)*1000 + 150ms network
skip the bid if freeSlots==0, or if etaMs > deadlineMs
```
The dashboard shows each data center's current shade and surge, so the strategy is visible.

**Execution**
- `embed`: call Ollama `/api/embed` and return `{embeddings, ms}`.
- `generate`: run Ollama with `num_predict=maxTokens` and return text plus token count.
- `stream`: see 6.7.

**Cheat mode** (`CHEAT=true` or the admin toggle): bids 40% below floor, so it wins often, and returns random unit vectors for embeddings. It exists so verification can be shown catching it.

**Drain** (admin command, or a closed lid): stop bidding, finish running jobs, go offline. This demonstrates the supply drop and price spike.

### 6.5 Verification and trust (`apps/exchange/src/verify.ts`, `credentials.ts`)

**Reference vectors.** At startup the exchange embeds a fixed **golden set** of 8 texts using its own local Ollama (same model tag) and stores the vectors.

**Onboarding challenge.**
1. Send the golden texts in shuffled order with an extra random nonce text.
2. The provider must return vectors with cosine ≥ 0.995 against the reference for all 8, within 5 seconds.
3. Assign the tier: **A** if `bench_embed_tps ≥ 40` and `bench_gen_tps ≥ 15`, otherwise **B**. Make the thresholds configurable.
4. On a pass: `CredentialCreate { Account: issuer, Subject: provider, CredentialType: hex("IDLE_DC_TIER_A"|"IDLE_DC_TIER_B"), URI: hex("<EXCHANGE_URL>/providers/<id>"), Expiration: now+24h (ripple time) }`, then send `credential.offered`.
5. Mark the provider `verified` only after `ledger_entry` shows the credential with `lsfAccepted`.

**Runtime spot checks** (`SPOTCHECK_RATE`, embeddings).
1. Pick 2 random texts from the job's result.
2. Re-embed them on a **different** verified provider, or the exchange's reference model.
3. Pass if cosine ≥ 0.995.
4. On a fail: **do not settle the payment**, so the provider is unpaid. Add a strike and emit `verify.failed`.
5. When `strikes ≥ STRIKES_TO_REVOKE`: `CredentialDelete { Account: issuer, Subject, CredentialType }`, set status `suspended`, emit `credential.revoked {txHash}`. The provider is now ineligible everywhere, and the ledger shows it.

**Buyer-side trustless check.** `packages/pay-xrpl.hasValidCredential(subject, issuer, type)` reads the ledger directly, with a 60-second cache. The agent calls it on the quoted winner **before paying**, so buyers don't have to take the exchange's word for it.

### 6.6 Rail A: x402 + AUSD per job (`apps/exchange/src/x402gate.ts`, `apps/facilitator`)
Skills: `ecc:agent-payment-x402`, `ecc:security-review`.

**Facilitator** (`apps/facilitator`, port 4022)
- `new x402Facilitator()` with `registerExactEvmScheme(facilitator, { signer: toFacilitatorEvmSigner(walletClient.extend(publicActions)) })` on `baseSepolia`.
- Exposes `POST /verify`, `POST /settle` and `GET /supported` in the spec's JSON shapes. Mirror the SKALE/x402 facilitator examples.
- **Use viem's `nonceManager`** on the relayer account and a **settle queue** with concurrency 1, waiting for each receipt, so parallel settlements never collide on nonces. Target at most about 1 settlement per second; batch job sizes so the demo doesn't need more.

**Gate (dynamic price and payTo per request)**

Endpoint: `POST /v1/jobs` with body `{jobType, model, input, maxUnitPrice, deadlineMs, minTier?, persona}` and header `Idempotency-Key: <uuid>`.

1. **First call, no payment header:**
   - Run the auction, store `quotes[idempotencyKey]`, and respond **402** with standard x402 payment requirements:
     - `scheme: "exact"`, `network: "eip155:84532"`, `asset: AUSD_ADDRESS`
     - amount: the quote amount, in atomic units, as a string
     - `payTo`: the **winner's EVM address**
     - `maxTimeoutSeconds: 60`
     - `extra: { name: AUSD_EIP712_NAME, version: AUSD_EIP712_VERSION }`
     - `resource`: the request URL
   - Also include `quoteId`, `providerId`, `clearingUnitPrice` and the bids summary in the body or extensions so the agent and dashboard can display them.
2. **Retry:** `@x402/fetch` resends the same request with the payment header. Look up the quote by `Idempotency-Key`. Check that the payload's amount, payTo, asset and network exactly match the quote, then call `facilitator.verify`.
3. Dispatch the job to the winner and await the result. Run the spot check if sampled.
4. **Verified:** call `facilitator.settle`, then respond 200 with the result and `receipt {txHash, explorerUrl, amount, payee, auctionId}` plus the standard settlement response header.
   **Failed:** do not settle. Respond `502 {error:"PROVIDER_FAILED_VERIFICATION", charged:false}`. The agent may resubmit, which runs a fresh auction.
5. **Implementation rule:** build the 402 and decode, verify and settle with `@x402/core`'s resource-server utilities and `HTTPFacilitatorClient`. **Read `@x402/express`'s source in node_modules and mirror its header names and base64 encoding exactly**, so the stock `@x402/fetch` client works unmodified. Don't invent header names.

**Agent payment client** (`packages/pay-evm`)
- viem account plus `@x402/fetch` with `registerExactEvmScheme(client, { signer })`. VERIFY the v2 wrapper function names in the installed package.
- **Spending policy** before signing anything:
  - per-payment max (from the job's `maxUnitPrice × units`)
  - cumulative budget (`AGENT_BUDGET_AUSD`)
  - payee must be the quoted winner and must hold a valid XRPL credential (6.5)
- Log every spend to `agent_logs` (`kind=spend`). Skill: `ecc:llm-trading-agent-security`.

### 6.7 Rail B: XRPL Payment Channel streaming (`apps/provider/src/stream.ts`, `packages/pay-xrpl`)

**Quote.** `POST /v1/streams` with `{model, prompt, maxTokens, maxDropsPerToken, deadlineMs}` runs an auction in XRP drops and returns a quote with `{quoteId, providerId, providerXrplAddress, dropsPerToken}`.

**Channel.** The agent reuses an open channel to that provider, or creates one:
- `PaymentChannelCreate { Account: agent, Destination: provider, Amount: xrpToDrops(10), SettleDelay: 60, PublicKey: agent.publicKey }`
- Get the channel ID from the tx metadata `CreatedNode` with `LedgerEntryType: "PayChannel"`, or from `account_channels`.

**Session**
1. The agent opens `WS /v1/streams/:quoteId` and sends `{channelId, publicKey}`. The exchange relays it to the provider.
2. The provider checks the channel on-ledger: destination is itself, enough remaining balance, not expiring.
3. The provider streams tokens through the exchange to the agent.
4. Every **16 tokens**, the agent signs a **cumulative** claim: `amountDrops = priorAuthorizedOnChannel + tokensDelivered*dropsPerToken`, then `signPaymentChannelClaim(channelId, dropsToXrp(amountDrops), agentPrivateKey)`, and sends `claim {amountDrops, signature}`.
5. The provider runs `verifyPaymentChannelClaim(...)` and keeps the highest valid claim.
6. **Credit window:** if unpaid tokens exceed 32, the provider pauses until a newer claim arrives. This bounds the provider's risk.
7. The agent can send `stop` at any time. The provider ends the stream, and the final claim covers exactly the delivered tokens.

**Settle.** The provider submits `PaymentChannelClaim { Account: provider, Channel, Balance: amountDrops, Amount: amountDrops, Signature, PublicKey: agentPubKey }` and emits `paychan.claimed {txHash, drops, tokens}`.

**XRPL transaction hygiene.** Serialize transactions per account through a queue to avoid sequence conflicts. Use `submitAndWait`. Retry `tefPAST_SEQ` and `telINSUF_FEE_P` once.

### 6.8 Buyer agents (`apps/agent`)
Skills: `ecc:agent-harness-construction`, `ecc:cost-aware-llm-pipeline`, `ecc:prompt-caching-strategy`.

**Structure.** A Claude tool-use loop (`@anthropic-ai/sdk`, model from `ANTHROPIC_MODEL`). The agent decides queries, which pages to keep, bid prices and when to stop streaming. The pipeline shape is fixed.

**Tools**
- `market_snapshot()`: `GET /v1/market` returns providers, free capacity, recent clearing prices and the bid-depth curve.
- `web_search(query)`: Context.dev `/web/search`.
- `scrape(url)`: Context.dev `web.scrape` to markdown, main content only.
- `buy_embeddings(texts[], maxUnitPrice, deadlineMs, minTier?)`: x402 rail. Batches of up to 64, with a retry policy on 409 or 503:
  - raise `maxUnitPrice` toward the suggested value, within budget, or
  - wait for cheaper supply if the persona is patient.
- `buy_generation(prompt, maxTokens, rail, maxUnitPrice)`: x402 (short) or XRPL stream (long). Streams tokens back.
- `budget()`: spent and remaining, for both currencies.

**Personas** (run concurrently to create real competition)
- `analyst`: urgent, `deadlineMs=3000`, high `maxUnitPrice`, uses the XRPL stream rail for the final answer.
- `indexer`: patient, `deadlineMs=60000`, low `maxUnitPrice`, backs off when outbid and buys when prices dip.

**Research flow**
1. Search (top 8 results) and scrape.
2. Chunk into roughly 800-character pieces.
3. Buy embeddings for the chunks and the query.
4. Rank chunks by cosine similarity and take the top-k.
5. Buy generation of a cited answer.
6. Print the answer with Context.dev source URLs.

**Logging.** Every thought, action, spend and result is sent to `POST /v1/agents/:id/log` for the dashboard's agent console. Use short, human-readable lines, for example "Outbid at 18 µAUSD/text → raising to 24".

**CLI**
```bash
pnpm agent --persona analyst "What are the fastest open models on Apple Silicon right now?"
pnpm agent --persona indexer --index "https://ollama.com/blog"
```

### 6.9 MCP server (stretch, `apps/mcp`)
Skill: `ecc:mcp-server-patterns`.
- A stdio MCP server built on `@modelcontextprotocol/sdk`.
- Tools: `idle_market`, `idle_embed`, `idle_generate`, `idle_budget`, reusing `packages/pay-evm` and `packages/pay-xrpl` with budget caps from env.
- Register it with `claude mcp add idle -- node apps/mcp/dist/index.js`.
- Demo line: "any agent, including Claude Code, can buy compute with one tool call."

### 6.10 Dashboard (`apps/dashboard`, served by the exchange, 1920×1080 projector-first)
Skills, in this order:
1. `2ca4e30e-2482-4c94-8644-6c26adf27391:frontend-design`
2. `ecc:dashboard-builder`
3. `53d1428c-10eb-46c0-a367-1d4b1e78ce5a:make-interfaces-feel-better`
4. `53d1428c-10eb-46c0-a367-1d4b1e78ce5a:web-animation-design`
5. `53d1428c-10eb-46c0-a367-1d4b1e78ce5a:emil-design-engineering`
6. `ecc:motion-patterns`
7. `ecc:react-patterns`
8. `ecc:vite-patterns`

**Design rules**
- **Light theme.** Off-white background (about `#FAFAF7`), near-black ink, **one** accent colour for "live/winning", red reserved for revoked or failed.
- Premium type: Geist or Inter Tight for UI, a tabular mono for numbers.
- Big numbers, little text. **It must not look AI-generated:** no purple gradients, no glassmorphism, no emoji, no generic hero sections, no stock icons everywhere.
- Motion: numbers tick, bid bars spring in, the winner glows briefly, rows slide. Hold 60 fps. Respect `prefers-reduced-motion`.

**Layout**
- **Top bar:**
  - Wordmark "Idle" and a live dot
  - Jobs cleared
  - AUSD settled
  - XRP streamed
  - Data centers online / verified
  - Current clearing price for each job type
- **Left, about 40%: Data centers.** One rack card per provider:
  - name, region and hardware ("Apple M3 Pro · 18 GB")
  - model chips
  - animated utilization meter
  - current ask, with surge × shade
  - **XRPL credential badge**, Tier A or B, linking to the explorer
  - earnings in AUSD and XRP, and strikes
  - Offline cards fade out. **Revoked cards get a stamped "REVOKED" animation with the CredentialDelete tx link.**
- **Centre, about 35%: Live auctions.** One card per auction, newest on top:
  - job type, units and buyer persona
  - every bid as a horizontal bar (price; ETA as a sub-label) animating in
  - the winner highlighted, with "pays 2nd price: X"
- **Right, about 25%: Settlement feed.**
  - x402 settlements (amount, payee, Basescan link)
  - XRPL channel claims (tokens, drops, link)
  - credential issued, accepted and revoked
- **Bottom strip:** clearing price over the last 10 minutes per job type (recharts), plus a supply-vs-demand bar.
- `/agent`: the agent console, showing both personas side by side with live thoughts and spend.
- **Hidden admin drawer** (press `D`, requires `ADMIN_TOKEN`): burst load, toggle cheat on a provider, drain a provider.

**Data.** `WS /v1/events` streams typed events from `packages/shared`. Keep state in a reducer. Build a **replay mode** (record and replay events from a JSONL file) so the UI can be built before the backend exists, and as a demo fallback.

### 6.11 Events and protocol (`packages/shared`, zod)
- **Provider WS:** `hello`, `challenge`, `challenge.result`, `credential.offered`, `credential.accepted`, `rfq`, `bid`, `award`, `lose`, `job`, `result`, `stream.start`, `stream.token`, `stream.claim`, `stream.stop`, `heartbeat`, `drain`, `cheat`.
- **Dashboard events:** `provider.online|offline|util|verified|suspended`, `auction.opened|bid|cleared|failed`, `job.dispatched|completed|verify.passed|verify.failed`, `payment.verified|settled|not_settled`, `credential.issued|accepted|revoked`, `paychan.opened|claim|claimed`, `price.tick`, `agent.log`.

### 6.12 REST API (exchange, port 8080)
- `GET /v1/market`
- `GET /v1/providers`
- `GET /v1/auctions?limit=`
- `GET /v1/payments?limit=`
- `POST /v1/jobs` (x402)
- `POST /v1/streams` and `WS /v1/streams/:quoteId`
- `POST /v1/agents/:id/log`
- `WS /v1/providers/ws`
- `WS /v1/events`
- `POST /v1/admin/{burst|cheat|drain}` (bearer `ADMIN_TOKEN`)
- `GET /` serves the dashboard build.

Skill: `ecc:api-design`.

---

## 7. Build phases

| Phase | Work | Parallel? | Skills | Acceptance check (run it) |
|---|---|---|---|---|
| **P0** | Section 4: scaffold, wallets, funding, AUSD domain, 6 smoke tests | lead, sequential | `ecc:search-first`, `ecc:documentation-lookup`, `ecc:contract-first`, `ecc:agent-payment-x402`, `ecc:evm-token-decimals` | All 6 smoke tests green with explorer links printed |
| **P1** | Core market with `PAYMENTS=off`. ∥A exchange: auction, DB, WS, events. ∥B provider: benchmark, bidding agent, Ollama. ∥C dashboard with replay mode. | ∥ 3 subagents | 6.3 / 6.4 / 6.10 skills, `ecc:tdd-workflow` | Exchange plus **2 local providers** (2 terminals, different names and floors). A script posts 60 embed jobs; auctions clear; results are correct (cosine against reference); dashboard shows live bids. Auction unit tests pass. |
| **P2** | x402 rail end to end, verification, spot checks, credentials onboarding and revocation, cheat mode | ∥A payments/gate, ∥B verify plus credentials | `ecc:agent-payment-x402`, `ecc:security-review`, `ecc:llm-trading-agent-security` | A buyer script pays **20 real AUSD jobs**, each with a Basescan tx to the winner. A provider with `CHEAT=true` is caught, unpaid (`not_settled`), and revoked on XRPL (explorer link). Its bids are ignored afterwards. |
| **P3** | XRPL streaming rail | ∥ with P4 | — | Generate 300 tokens with claims every 16. The agent stops at about 150 tokens. The provider's on-ledger claim equals delivered × price exactly (assert it). |
| **P4** | Buyer agents (Claude plus Context.dev) and personas; MCP (stretch) | ∥ with P3 | 6.8 skills, `ecc:mcp-server-patterns` | `analyst` and `indexer` run concurrently and the dashboard shows clearing prices moving. `analyst` prints a cited answer and a spend report. |
| **P5** | Multi-laptop and polish: tunnel, other laptops as data centers, dashboard polish | lead plus 1 subagent on UI | `53d1428c-…:make-interfaces-feel-better`, `ecc:browser-qa`, `ecc:e2e-testing`, `ecc:deployment-patterns` | Over the tunnel URL: 3 laptops online and verified. Closing one lid makes the price visibly rise within 10 seconds. A browser-qa screenshot at 1920×1080 looks premium (review it critically). |
| **P6** | Hardening, README, demo assets, submission | lead | `ecc:quality-gate`, `ecc:code-review`, `ecc:verification-loop`, `ecc:update-docs`, `humanizer`; optional `koolwal-deck-style`, `ecc:remotion-video-creation` | Section 10 checklist complete |
| **Stretch** | YZi: `IdleReceipts` contract on BSC testnet (`logReceipt(jobId, provider, amount, rail, paymentTxHash)`) called after each settle; MCP | optional | — | BscScan testnet tx per receipt |

**Cut lines** (protect the demo):
- If P3 is at risk, drop streaming and use x402 for all generation. Ripple still has Credentials. Only do this if necessary, because channels are Ripple's strongest story.
- If P4 is at risk, the agent becomes a scripted buyer and Claude is used only for the final answer.
- Never cut verification and revocation. It's the most memorable moment of the demo.

---

## 8. Demo runbook (3 laptops)

- **Laptop A (projector):**
  - `pnpm dev:facilitator`, `pnpm dev:exchange` (serves the dashboard)
  - `pnpm provider` as DC-Berkeley-1
  - `cloudflared tunnel --url http://localhost:8080`, then share the URL
- **Laptop B:** `EXCHANGE_URL=<tunnel> pnpm provider` as DC-Oakland-2 (cheaper floors).
- **Laptop C:** `EXCHANGE_URL=<tunnel> pnpm provider` as DC-SF-3 (the cheat toggle lives here), and runs both agents.
- **Wi-Fi:** venue Wi-Fi may block peer connections, which is why everything goes through the tunnel. Keep a phone hotspot as backup.
- **Before going on stage:**
  - pre-warm the Ollama models on every laptop
  - pre-open payment channels
  - top up AUSD
  - record a full successful run in replay mode as a fallback

**Live sequence (about 90 seconds)**
1. Data centers are already online with Tier badges. Show one credential on the XRPL explorer.
2. Start `indexer`, which fills the market with cheap batch work. Then start `analyst`, which outbids it and moves the clearing price up.
3. Click a settlement: Basescan shows AUSD going agent → laptop B's wallet.
4. Turn on cheat for DC-SF-3. It undercuts and wins, gets caught by a spot check, isn't paid, and is **revoked** (stamp animation and XRPL tx).
5. Close laptop B's lid: supply drops and the price jumps.
6. `analyst` streams its final answer over the XRPL channel and stops early. The claim shows exactly the tokens delivered.

---

## 9. 2-minute video script
1. **0:00–0:15** "GPUs are sold out, and agents need compute per job with no accounts. Data centers have spare minutes they can't sell."
2. **0:15–0:30** "Idle is a spot market. Every job is auctioned to verified data centers in a quarter of a second, and agents pay per job."
3. **0:30–1:20** The live sequence from Section 8, steps 2 to 6, with cuts.
4. **1:20–1:45** Sponsors in one breath:
   - "AUSD over x402: gasless, paid straight to the data center, settled only after the work is verified."
   - "XRPL Credentials are our trust layer, revoked on-ledger when someone cheats. XRPL payment channels let agents pay per token."
   - "Context.dev feeds the agent's research."
5. **1:45–2:00** Today's numbers (jobs, AUSD settled, XRP streamed), then "Built today. Our laptops were the data center."

---

## 10. Submission checklist
- [ ] Public GitHub repo with real commit history (one commit per phase at least)
- [ ] README, written in plain English (Skill: `humanizer`):
  - [ ] one-line pitch and architecture diagram
  - [ ] **sponsor sections** (AUSD/x402, XRPL Credentials plus Channels, Context.dev) with **real explorer links** to our testnet txs
  - [ ] how to run (setup, smoke tests, 3-laptop runbook)
  - [ ] how judges can join as a data center (`EXCHANGE_URL=<url> pnpm provider`)
  - [ ] a "what's real" section: real inference, real auctions, real payments, nothing hard-coded
- [ ] YouTube demo, 2:00 or less
- [ ] Live link: tunnel URL during judging, plus a deployed static dashboard in replay mode as a permanent link
- [ ] Submit at www.hackathoncompany.com/platform (allow 15 minutes). General track: **Most Technically Impressive**. Sponsor tracks: Agora AUSD, Ripple, Context.dev bonus, and YZi if the stretch shipped.
- [ ] Social proof: post the dashboard link during the event, invite other teams to plug in a laptop as a data center, and screenshot the count

---

## 11. Fallbacks
- **Stock facilitator can't settle AUSD** (domain or overload mismatch): in `apps/facilitator`, implement `settle` yourself with viem `writeContract` on AUSD `transferWithAuthorization`, using whichever overload `setup:ausd-domain` detected. Keep `verify` by recovering the EIP-712 signer with viem `verifyTypedData` against the on-chain domain. The x402 wire format stays the same.
- **Base Sepolia RPC rate-limited:** switch to `BASE_SEPOLIA_RPC_FALLBACK`.
- **AUSD faucet hiccup:** the agent wallets already hold 10,000 AUSD each from setup, which is enough for thousands of jobs.
- **XRPL testnet faucet slow:** pre-fund every account in P0. Payment channels are pre-opened before demo time.
- **Ollama slow on a laptop:** switch that laptop to `qwen2.5:1.5b` for generation. Embeddings stay on `nomic-embed-text` everywhere, because verification needs matching models.
- **Tunnel or Wi-Fi fails:** phone hotspot. If everything fails, the dashboard replay of the recorded successful run.
- **Spot-check false positives** across different hardware: if cosine falls between 0.98 and 0.995 on honest providers, lower the threshold to 0.98. Random vectors score about 0, so the separation is still huge.

---

## 12. Kickoff prompt (paste into Claude Code from the repo root)

```
Read IDLE_BUILD_PLAN.md fully before doing anything. You are building Idle end to end for a hackathon today.

Rules: follow the phases in Section 7 in order; create a task list with TaskCreate for every phase; run every acceptance check for real and do not proceed on red; use the Agent tool to run the ∥ workstreams in parallel, giving each subagent the exact plan sections it needs; load the skills named in each section with the Skill tool (use the closest available if a name differs, never block); never guess SDK APIs — read node_modules types/source or the agora/xrpl MCP docs first; nothing core may be hard-coded; testnets only; secrets only in gitignored env files; commit at the end of each phase.

Start with Phase 0. When you need something only a human can do (Base Sepolia ETH from a faucet, ANTHROPIC_API_KEY, CONTEXT_DEV_API_KEY, installing Ollama/cloudflared), stop, print exactly what is needed with the addresses, and wait. Then continue.
```
