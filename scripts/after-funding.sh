#!/usr/bin/env bash
# Waits for the relayer to be funded, then: AUSD faucet → x402 smoke → restart stack with PAYMENTS=on → 20 paid jobs.
set -o pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
echo "[$(date +%T)] waiting for Base Sepolia ETH on the relayer (polling 10 s, up to 6 h)…"
until pnpm -s setup:fund 2>&1 | tee /dev/stderr | grep -q "funding complete"; do sleep 20; done
echo "[$(date +%T)] funded. running smoke:x402…"
pnpm -s smoke:x402 2>&1 || { echo "smoke:x402 FAILED — stopping here"; exit 1; }
echo "[$(date +%T)] restarting the stack with PAYMENTS=on…"
scripts/stack.sh down; sleep 2
RECORD_EVENTS=1 PAYMENTS=on CREDENTIALS=on scripts/stack.sh up; sleep 10
scripts/stack.sh provider; PAYMENTS=on scripts/stack.sh fake 2
for i in $(seq 1 60); do n=$(curl -s localhost:8080/v1/providers | python3 -I -c 'import sys,json; ps=json.load(sys.stdin); print(sum(1 for p in ps if p.get("status")=="verified" and p.get("online")))' 2>/dev/null || echo 0); [ "$n" = "3" ] && break; sleep 3; done
echo "[$(date +%T)] $n verified providers online. buying 20 jobs with real AUSD…"
pnpm -s agent --persona indexer --jobs 20 2>&1
echo "[$(date +%T)] settled payments:"; curl -s "localhost:8080/v1/payments?limit=25" | python3 -I -c '
import sys,json
rows=json.load(sys.stdin); s=[x for x in rows if x["status"]=="settled" and x["rail"]=="x402"]
print(f"  {len(s)} x402 settlements"); [print("  ", x["amount"], "AUSD-atomic →", x.get("payeeName"), x.get("explorerUrl")) for x in s[:20]]'
echo "[$(date +%T)] done"
