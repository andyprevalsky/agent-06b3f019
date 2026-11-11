#!/usr/bin/env bash
# Optional raw-data storage for disk-constrained runners. Always own a fresh directory.
coverage_raw_directory() {
  local backend_dir="$1" shard_suffix="$2" raw_root="${BACKEND_COVERAGE_TMP_ROOT:-}"
  if [[ -z "$raw_root" ]]; then
    printf '%s\n' "$backend_dir/coverage/tmp$shard_suffix"
    return 0
  fi
  if [[ "$raw_root" != /* || ! -d "$raw_root" ]]; then
    echo 'BACKEND_COVERAGE_TMP_ROOT must name an existing absolute directory.' >&2
    return 2
  fi
  mktemp -d "$raw_root/rose-backend-coverage$shard_suffix.XXXXXX"
}
