#!/usr/bin/env bash
# Deobfuscates javascript-obfuscator-protected .js file(s) using webcrack.
#
# WOZCODE's distributed plugin runs every .js file (chunks/, scripts/,
# servers/, standalone/) through `javascript-obfuscator` on top of an
# esbuild bundle: hex-named variables (_0x50af), a rotating base64/hex
# string array resolved at runtime, and a self-defending IIFE. webcrack
# is a purpose-built tool for reversing exactly that obfuscator's output
# (string-array decoding + dead-code elimination) and for un-bundling
# esbuild/webpack output back into separate modules.
#
# webcrack recovers real control flow and ALL string literals in plaintext
# (error messages, API endpoints, config keys, tool schemas). It does NOT
# recover local variable/function names that were minified away — those
# stay as meaningless _0x... hex identifiers. Intent has to be inferred
# from string literals, call shape, and cross-referencing imports, the
# same way you'd read a stripped binary.
#
# Usage:
#   npm install                          # one-time setup, installs webcrack/prettier/js-beautify
#   ./deobfuscate.sh <file.js> [out-dir]              # single file
#   ./deobfuscate.sh <directory> [out-dir]            # every *.js directly inside a directory (parallel)
#
# Output: <out-dir>/<basename>/deobfuscated.js per input file.
# Small files (<50KB) take ~1s; multi-MB chunks take 10-90s.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:?Usage: deobfuscate.sh <file-or-directory> [output-dir]}"
OUT_DIR="${2:-$SCRIPT_DIR/out}"
PARALLEL_JOBS="${DEOBFUSCATE_JOBS:-8}"

cd "$SCRIPT_DIR"

if [ ! -d node_modules/webcrack ]; then
  echo "Installing dependencies (webcrack, prettier, js-beautify)..."
  npm install --no-audit --no-fund
fi

mkdir -p "$OUT_DIR"

deobfuscate_one() {
  local f="$1"
  local out_dir="$2"
  local name
  name="$(basename "$f" .js)"
  echo "==> deobfuscating: $f"
  npx --prefix "$(pwd)" webcrack "$f" -o "$out_dir/$name"
}
export -f deobfuscate_one

if [ -f "$TARGET" ]; then
  deobfuscate_one "$TARGET" "$OUT_DIR"
elif [ -d "$TARGET" ]; then
  find "$TARGET" -maxdepth 1 -name '*.js' -print0 \
    | xargs -0 -P "$PARALLEL_JOBS" -I{} bash -c 'deobfuscate_one "$1" "$2"' _ {} "$OUT_DIR"
else
  echo "Not a file or directory: $TARGET" >&2
  exit 1
fi

echo ""
echo "Done. Output written to: $OUT_DIR/<name>/deobfuscated.js"
echo "Note: control flow and string literals are recovered in plaintext;"
echo "local identifiers remain minified hex (_0x...) — infer intent from"
echo "string literals, schema shapes, and call sites, as documented in"
echo "../analysis.md section 0."
