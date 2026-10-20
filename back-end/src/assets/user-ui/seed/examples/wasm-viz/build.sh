#!/usr/bin/env bash
# Rebuild viz.wasm from src/lib.rs. Needs Rust with the wasm32 target:
#   curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --target wasm32-unknown-unknown
# Build output goes to .target/: dot folders are never published by rose-ui.
set -euo pipefail
cd "$(dirname "$0")"
cargo build --release --target wasm32-unknown-unknown --target-dir .target
cp .target/wasm32-unknown-unknown/release/rose_wasm_viz.wasm viz.wasm
ls -l viz.wasm
