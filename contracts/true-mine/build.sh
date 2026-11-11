#!/usr/bin/env bash
# Builds contracts/true-mine/res/true_mine.wasm in a form NEAR's VM accepts.
#
# Preferred path: `cargo near build non-reproducible-wasm` if installed. Fallback path (what this script does itself):
#   1. build with the pinned toolchain and the baseline WASM CPU
#   2. re-encode canonically (wasm-opt if present, otherwise a wasm-tools print/parse round trip)
#   3. validate against baseline WASM + sign-extension with wasm-tools, and refuse to ship if it fails
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p res

if command -v cargo-near >/dev/null 2>&1; then
  cargo near build non-reproducible-wasm
  cp target/near/true_mine.wasm res/true_mine.wasm 2>/dev/null || cp target/near/*/true_mine.wasm res/true_mine.wasm
  ls -la res/true_mine.wasm
  shasum -a 256 res/true_mine.wasm 2>/dev/null || sha256sum res/true_mine.wasm
  exit 0
fi

RUSTFLAGS="-C target-cpu=mvp" cargo build --target wasm32-unknown-unknown --release
RAW=target/wasm32-unknown-unknown/release/true_mine.wasm

if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -Oz --signext-lowering "$RAW" -o res/true_mine.wasm
else
  command -v wasm-tools >/dev/null 2>&1 || { echo "Need binaryen (wasm-opt), wasm-tools, or cargo-near to normalise the WASM." >&2; exit 1; }
  TMP="$(mktemp -d)"
  wasm-tools strip -a "$RAW" -o "$TMP/stripped.wasm"
  wasm-tools print "$TMP/stripped.wasm" -o "$TMP/m.wat"
  wasm-tools parse "$TMP/m.wat" -o res/true_mine.wasm
  rm -rf "$TMP"
fi

if command -v wasm-tools >/dev/null 2>&1; then
  wasm-tools validate --features mvp,sign-extension res/true_mine.wasm
  echo "validated: baseline WASM + sign-extension only"
fi
ls -la res/true_mine.wasm
shasum -a 256 res/true_mine.wasm 2>/dev/null || sha256sum res/true_mine.wasm
