#!/usr/bin/env bash
# Regenerate the compilation evidence in docs/verification/compile.txt.
#
# Deletes the generated artifacts and recompiles from the Compact source, then
# shows that the result is byte-identical to what is committed. Everything this
# prints is real compiler output.
#
#   bash scripts/evidence.sh            # print to stdout
#   bash scripts/evidence.sh > out.txt  # capture
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPILER_DIR="$HOME/.compact"
COMPACT="${COMPACT:-$(command -v compact || true)}"

if [ -z "$COMPACT" ]; then
  if [ -x "$HOME/.local/bin/compact" ]; then
    COMPACT="$HOME/.local/bin/compact"
  else
    echo "compact not found. Install it first:" >&2
    echo "  curl --proto '=https' --tlsv1.2 -LsSf https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh" >&2
    exit 1
  fi
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "This script formats compiler output with jq. Install it first." >&2
  exit 1
fi

# Resolve the binary belonging to the *default* toolchain version, not whichever
# version `find` happens to return first — the project pins 0.31.1, and older or
# newer toolchains are also installed on a development machine.
COMPACT_VERSION="$("$COMPACT" compile --version)"
CC_BIN="$(find "$COMPILER_DIR/versions/$COMPACT_VERSION" -name compactc.bin 2>/dev/null | head -1)"
if [ -z "$CC_BIN" ]; then
  echo "Could not locate compactc.bin for toolchain $COMPACT_VERSION under $COMPILER_DIR/versions" >&2
  exit 1
fi

hr() { printf '%s\n' "──────────────────────────────────────────────────────────────────────────────"; }

hr
echo "\$ compact compile --version"
"$COMPACT" compile --version
echo
echo "\$ \"\$COMPACT_TOOLCHAIN/compactc.bin\" --language-version"
"$CC_BIN" --language-version
echo
echo "\$ \"\$COMPACT_TOOLCHAIN/compactc.bin\" --ledger-version"
"$CC_BIN" --ledger-version
echo
echo "\$ \"\$COMPACT_TOOLCHAIN/compactc.bin\" --runtime-version"
"$CC_BIN" --runtime-version
echo

hr
echo "\$ rm -rf contract/src/managed"
rm -rf contract/src/managed
echo
echo "\$ npm run compile"
npm run compile --silent
echo
echo "# The six exported circuits the compiler just produced:"
for f in contract/src/managed/sealed-bid-auction/keys/*.prover; do
  printf '  %s\n' "$(basename "$f" .prover)"
done
echo

hr
echo "\$ ls contract/src/managed/sealed-bid-auction"
ls contract/src/managed/sealed-bid-auction
echo
echo "\$ git status --short contract/src/managed"
if [ -z "$(git status --short contract/src/managed)" ]; then
  echo "(no output — regenerated artifacts are byte-identical to the committed ones)"
else
  git status --short contract/src/managed
fi
echo

hr
INFO="contract/src/managed/sealed-bid-auction/compiler/contract-info.json"
echo "\$ INFO=$INFO"
echo
echo "\$ jq -c '{compiler:.\"compiler-version\", language:.\"language-version\", runtime:.\"runtime-version\"}' \"\$INFO\""
jq -c '{compiler:."compiler-version", language:."language-version", runtime:."runtime-version"}' "$INFO"
echo
echo "\$ jq -r '.circuits[].name' \"\$INFO\""
jq -r '.circuits[].name' "$INFO"
echo

hr
echo "\$ wc -l contract/src/sealed-bid-auction.compact"
wc -l contract/src/sealed-bid-auction.compact
echo
echo "\$ du -sh contract/src/managed/sealed-bid-auction/keys"
du -sh contract/src/managed/sealed-bid-auction/keys
