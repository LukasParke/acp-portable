#!/bin/sh
# Drive `acp-portable serve` from acpx, an independent ACP client, across agents.
#   sh test/acpx.sh            (needs network + Ori credentials)
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIR=$(mktemp -d)
cd "$DIR"
A="node $ROOT/src/cli.ts serve --agent claude"
X="npx -y acpx@0.20.0 --agent"
CODE="OCELOT-$$"
$X "$A" sessions new >/dev/null
$X "$A" --approve-all --format quiet prompt "Remember: the vault code is $CODE. Reply with just OK."
for agent in codex pi; do
  $X "$A" set acp_portable_agent $agent
  out=$($X "$A" --approve-all --format quiet prompt "What is the vault code? Reply with just the code.")
  echo "[$agent] $out"
  case "$out" in *"$CODE"*) echo "PASS $agent recalls the code (via acpx)";; *) echo "FAIL $agent"; exit 1;; esac
done
