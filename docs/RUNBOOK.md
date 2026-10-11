# Idle — demo runbook (3 laptops)

## Before going on stage (Laptop A, the projector)

```bash
cd ~/Desktop/idle
scripts/stack.sh reset                 # fresh DB, fresh golden cache, no stale providers
pnpm setup:fund                        # XRPL faucet + AUSD faucet; prints balances
RECORD_EVENTS=1 PAYMENTS=on scripts/stack.sh up    # facilitator :4022 + exchange :8080 (serves the dashboard)
scripts/stack.sh provider              # this laptop = DC-Berkeley-1 (benchmarks, challenge, XRPL credential)
cloudflared tunnel --url http://localhost:8080      # copy the https://….trycloudflare.com URL
```

Open `http://localhost:8080/` on the projector (1920×1080). Press `D` for the admin drawer (paste `ADMIN_TOKEN` from `.env` once).

Pre-warm: the provider warms both Ollama models at startup. Pre-open a channel: `pnpm agent --persona analyst --stream "warm up" --max-tokens 32 --stop-after 16`.

## Laptops B and C (data centers)

```bash
git clone https://github.com/divyanshkoolwal-sketch/idle && cd idle && pnpm install
ollama pull nomic-embed-text && ollama pull llama3.2:3b
EXCHANGE_URL=https://<tunnel>.trycloudflare.com PROVIDER_NAME=DC-Oakland-2 PROVIDER_REGION="us-west · Oakland" FLOOR_EMBED_AUSD_PER_TEXT=11 pnpm provider
# laptop C:
EXCHANGE_URL=https://<tunnel>.trycloudflare.com PROVIDER_NAME=DC-SF-3 PROVIDER_REGION="us-west · San Francisco" FLOOR_EMBED_AUSD_PER_TEXT=13 pnpm provider
```

The daemon generates its own wallets into `apps/provider/.env.local`, funds its XRPL account, benchmarks, answers the challenge, accepts its credential and starts bidding. Judges can join the same way.

## Agents (run on Laptop A, which holds the agent keys in `.env`)

```bash
pnpm agent --persona indexer --index https://ollama.com/blog          # cheap batch work, patient
pnpm agent --persona analyst "What are the fastest open models on Apple Silicon right now?"   # urgent, streams its answer
pnpm agent --persona analyst --stream "Explain second-price auctions in plain English" --stop-after 150   # streaming-only demo
pnpm agent --persona indexer --jobs 20                                 # 20 paid embed jobs, no Context.dev needed
```

Without `ANTHROPIC_API_KEY` the agent runs the scripted buyer (same pipeline, fixed decisions).

## Live sequence (~90 s)

1. Data centers are online with Tier badges. Click a badge → XRPL explorer shows the credential.
2. Start `indexer` (fills the market with cheap work), then `analyst` (outbids it; the clearing price rises on the strip).
3. Click a settlement in the feed → Basescan shows AUSD moving agent → laptop B's wallet.
4. Admin drawer → toggle **cheat** on DC-SF-3. It undercuts, wins, fails the spot check (cosine ≈ 0), is **not paid**, gets a strike, and on the second strike its credential is deleted on-ledger: the rack card stamps REVOKED with the CredentialDelete link. (A bid under the provider's own floor is always spot-checked, so this happens on the first cheating job.)
5. Close laptop B's lid → within 5 s it goes offline, supply drops, the next auctions clear higher.
6. `analyst` streams its final answer over the XRPL channel, signing a claim every 16 tokens, and stops early; the feed shows the on-ledger claim equal to delivered × price.

## Fallbacks

- Venue Wi-Fi blocks the tunnel → phone hotspot, restart `cloudflared`.
- Base Sepolia RPC flaky → set `BASE_SEPOLIA_RPC_FALLBACK` in `.env` (Alchemy/Infura URL).
- Everything fails → the dashboard replays a recorded run: `http://localhost:8080/?replay=/replay/demo.jsonl` or open `data/events-<ts>.jsonl` from the admin drawer.
- A provider's GPU path is broken (gibberish / non-discriminating embeddings): the provider detects this and uses CPU automatically; force with `EMBED_DEVICE=cpu GEN_DEVICE=cpu`.
