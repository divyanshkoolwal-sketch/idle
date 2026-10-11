#!/usr/bin/env bash
# Local stack helper: start/stop the exchange, facilitator and fake providers with logs + pid files.
#   scripts/stack.sh up            # facilitator (if PAYMENTS!=off) + exchange
#   scripts/stack.sh fake N        # N fake providers (Ollama-backed) with different floors
#   scripts/stack.sh provider      # the real provider daemon
#   scripts/stack.sh down          # stop everything
#   scripts/stack.sh logs [name]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$ROOT/data/logs"; PIDS="$ROOT/data/pids"; mkdir -p "$LOGS" "$PIDS"
cd "$ROOT"
start() { # name cmd...
  local name=$1; shift
  if [ -f "$PIDS/$name.pid" ] && kill -0 "$(cat "$PIDS/$name.pid")" 2>/dev/null; then echo "$name already running"; return; fi
  nohup "$@" >"$LOGS/$name.log" 2>&1 &
  echo $! >"$PIDS/$name.pid"; echo "started $name (pid $!) → data/logs/$name.log"
}
case "${1:-}" in
  up)
    if [ "${PAYMENTS:-on}" != "off" ]; then start facilitator pnpm -s dev:facilitator; fi
    start exchange pnpm -s dev:exchange ;;
  fake)
    n=${2:-2}; names=(DC-Oakland-2 DC-SF-3 DC-Davis-4); floors=(11 13 18); regions=("us-west · Oakland" "us-west · San Francisco" "us-west · Davis")
    for i in $(seq 0 $((n-1))); do start "fake-${names[$i]}" pnpm -s tsx apps/exchange/test/fake-provider.ts --name "${names[$i]}" --floor "${floors[$i]}" --slots 2 --region "${regions[$i]}" --fund; done ;;
  provider) start provider pnpm -s provider ;;
  down)
    for f in "$PIDS"/*.pid; do [ -f "$f" ] || continue; p=$(cat "$f"); n=$(basename "$f" .pid)
      if kill -0 "$p" 2>/dev/null; then pkill -TERM -P "$p" 2>/dev/null || true; kill -TERM "$p" 2>/dev/null || true; echo "stopped $n"; fi; rm -f "$f"; done ;;
  logs) tail -n 40 "$LOGS/${2:-exchange}.log" ;;
  reset) "$0" down; rm -f "$ROOT/data/idle.db" "$ROOT/data/idle.db-wal" "$ROOT/data/idle.db-shm" "$ROOT/data/golden-"*.json; rm -f "$ROOT/data/events-"*.jsonl; echo "data reset (db, golden cache, recordings)" ;;
  *) echo "usage: $0 up|fake N|provider|down|reset|logs [name]"; exit 1 ;;
esac
