#!/usr/bin/env bash
# Content-addressed worker image prebuild (build before merge, promote after).
#
#   prebuild-agents-image.sh build  --sha SHA   build + push registry.fly.io/$APP:prebuilt-<agents tree>
#   prebuild-agents-image.sh lookup --sha SHA   print the digest-pinned ref if that image exists
#
# The worker image is a pure function of the committed `agents/` tree (the
# cutover builds `git archive $BUILD_ID:agents` with agents/Dockerfile and no
# build args), so the tree hash is a sound cache key: the merge commit reuses
# the PR's prebuilt image only when its agents tree is byte-identical, and
# otherwise the cutover builds exactly as before. Build-only + push creates no
# Fly Machine and changes no release; only the deployment queue promotes it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-}"
shift || true
SHA=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --sha) SHA="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$MODE" in build|lookup) ;; *)
  echo "usage: prebuild-agents-image.sh build|lookup --sha SHA" >&2; exit 2 ;;
esac
[[ "$SHA" =~ ^[a-f0-9]{40}$ ]] || { echo "--sha must be a full commit SHA" >&2; exit 2; }

APP="${APP:-${FLY_APP_NAME:-}}"
if [ -z "$APP" ]; then
  APP=$(git -C "$ROOT" show "$SHA:agents/fly.toml" | sed -nE 's/^app = "([a-z0-9-]+)"/\1/p')
fi
[[ "$APP" =~ ^[a-z0-9-]+$ ]] || { echo "could not resolve the Fly app" >&2; exit 2; }
AGENTS_TREE=$(git -C "$ROOT" rev-parse "$SHA:agents")
[[ "$AGENTS_TREE" =~ ^[a-f0-9]{40}$ ]] || { echo "commit has no agents tree" >&2; exit 2; }
# Key = hash of exactly the Docker build context (agents/ minus benchmarks and
# tests, the same exclusion the archive below applies). Top-level entries carry
# their subtree hashes, so any byte change inside the context changes the key,
# while benchmark/test-only commits keep it and still reuse the image.
CONTEXT_ENTRIES=$(git -C "$ROOT" ls-tree "$SHA:agents" | awk -F'\t' '$2 != "benchmarks" && $2 != "tests"')
TREE=$(printf '%s\n' "$CONTEXT_ENTRIES" | git -C "$ROOT" hash-object --stdin)
[[ "$TREE" =~ ^[a-f0-9]{40}$ ]] || { echo "could not hash the build context" >&2; exit 2; }
LABEL="prebuilt-${TREE}"
TAG_REF="registry.fly.io/${APP}:${LABEL}"

lookup() {
  flyctl auth docker >/dev/null 2>&1 || return 1
  local digest
  digest=$(docker buildx imagetools inspect "$TAG_REF" --format '{{json .Manifest.Digest}}' 2>/dev/null) || return 1
  digest="${digest//\"/}"
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  printf 'registry.fly.io/%s@%s\n' "$APP" "$digest"
}

if [ "$MODE" = lookup ]; then
  lookup
  exit $?
fi

if lookup; then
  echo "prebuilt worker image already exists for agents tree $TREE" >&2
  exit 0
fi
CONTEXT=$(mktemp -d)
trap 'rm -rf "$CONTEXT"' EXIT
# Identical context to deploy-agents-cooperative-cutover.sh.
git -C "$ROOT" archive "$SHA:agents" -- . ':(exclude)benchmarks' ':(exclude)tests' |
  tar -x -C "$CONTEXT" --exclude=benchmarks --exclude=tests
cd "$CONTEXT"
started=$(date +%s)
flyctl deploy --local-only --build-only --push --image-label "$LABEL" -a "$APP"
echo "prebuilt worker image for agents tree $TREE in $(( $(date +%s) - started ))s" >&2
lookup
