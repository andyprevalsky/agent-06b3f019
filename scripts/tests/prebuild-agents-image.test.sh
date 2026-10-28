#!/usr/bin/env bash
# Prebuilt worker images are keyed by the exact committed agents tree, built
# build-only (no Fly Machine, no release) from the same context as the cutover,
# skipped when that tree already exists, and found by digest for promotion.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

REPO="$TMP/repo"
mkdir -p "$REPO/scripts" "$REPO/agents/tests" "$REPO/agents/benchmarks" "$TMP/bin"
cp "$ROOT/scripts/prebuild-agents-image.sh" "$REPO/scripts/"
printf 'app = "test-prod"\n' > "$REPO/agents/fly.toml"
printf 'FROM scratch\n' > "$REPO/agents/Dockerfile"
printf 'print(1)\n' > "$REPO/agents/worker.py"
printf 'big\n' > "$REPO/agents/tests/t.py"
printf 'big\n' > "$REPO/agents/benchmarks/b.json"
git -C "$REPO" init -q -b main
git -C "$REPO" -c user.email=t@e -c user.name=t add -A
git -C "$REPO" -c user.email=t@e -c user.name=t commit -qm base
SHA=$(git -C "$REPO" rev-parse HEAD)
ENTRIES=$(git -C "$REPO" ls-tree "$SHA:agents" | awk -F'\t' '$2 != "benchmarks" && $2 != "tests"')
TREE=$(printf '%s\n' "$ENTRIES" | git -C "$REPO" hash-object --stdin)

export JOURNAL="$TMP/journal" REGISTRY="$TMP/registry"
mkdir -p "$REGISTRY"
cat > "$TMP/bin/flyctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == 'auth docker' ]]; then printf 'auth\n' >> "$JOURNAL"; exit 0; fi
[[ "$1" == deploy ]] || exit 90
[[ "$*" == 'deploy --local-only --build-only --push --image-label prebuilt-'*' -a test-prod' ]] || exit 91
args="$*"; label=${args#*--image-label }; label=${label%% *}
printf 'build %s\n' "$label" >> "$JOURNAL"
ls -A . | sort > "$JOURNAL.context"
touch "$REGISTRY/$label"
SH
cat > "$TMP/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1 $2 $3" == 'buildx imagetools inspect' ]] || exit 92
tag=${4#registry.fly.io/test-prod:}
printf 'inspect %s\n' "$tag" >> "$JOURNAL"
[[ -e "$REGISTRY/$tag" ]] || exit 1
printf '"sha256:%064d"\n' 0 | tr 0 a
SH
chmod 755 "$TMP/bin/"*
export PATH="$TMP/bin:$PATH"
unset APP FLY_APP_NAME
DIGEST_REF="registry.fly.io/test-prod@sha256:$(printf '%064d' 0 | tr 0 a)"

# Lookup misses before any prebuild.
: > "$JOURNAL"
if bash "$REPO/scripts/prebuild-agents-image.sh" lookup --sha "$SHA" > "$TMP/miss.out"; then
  fail "lookup reported an image that was never built"
fi
[ ! -s "$TMP/miss.out" ] || fail "a miss must print no image reference"

# Build pushes exactly prebuilt-<agents tree>, build-only, from the cutover's context.
: > "$JOURNAL"
out=$(bash "$REPO/scripts/prebuild-agents-image.sh" build --sha "$SHA")
[ "$out" = "$DIGEST_REF" ] || fail "build did not print the digest-pinned ref: $out"
grep -qx "build prebuilt-$TREE" "$JOURNAL" || fail "image label is not the agents tree hash"
[ "$(cat "$JOURNAL.context")" = $'Dockerfile\nfly.toml\nworker.py' ] ||
  fail "context differs from the cutover's (tests/benchmarks must be excluded)"

# A second prebuild of the same tree is a no-op.
: > "$JOURNAL"
bash "$REPO/scripts/prebuild-agents-image.sh" build --sha "$SHA" > /dev/null
if grep -q '^build ' "$JOURNAL"; then fail "rebuilt an already prebuilt tree"; fi

# A commit outside agents/ keeps the same tree and reuses the image; an agents edit does not.
printf 'docs\n' > "$REPO/README"
git -C "$REPO" -c user.email=t@e -c user.name=t add -A
git -C "$REPO" -c user.email=t@e -c user.name=t commit -qm docs
[ "$(bash "$REPO/scripts/prebuild-agents-image.sh" lookup --sha "$(git -C "$REPO" rev-parse HEAD)")" = "$DIGEST_REF" ] ||
  fail "identical agents tree did not reuse the prebuilt image"
printf 'print(2)\n' > "$REPO/agents/worker.py"
git -C "$REPO" -c user.email=t@e -c user.name=t commit -qam agents
if bash "$REPO/scripts/prebuild-agents-image.sh" lookup --sha "$(git -C "$REPO" rev-parse HEAD)" > /dev/null; then
  fail "a changed agents tree reused a stale image"
fi

# A benchmark/test-only change is outside the image context: same key, image reused.
CTX_HEAD=$(git -C "$REPO" rev-parse HEAD)
bash "$REPO/scripts/prebuild-agents-image.sh" build --sha "$CTX_HEAD" > /dev/null
mkdir -p "$REPO/agents/tests" "$REPO/agents/benchmarks"
printf 'x\n' > "$REPO/agents/tests/t.py"
printf 'y\n' > "$REPO/agents/benchmarks/b.json"
git -C "$REPO" -c user.email=t@e -c user.name=t add -A
git -C "$REPO" -c user.email=t@e -c user.name=t commit -qm tests-only
[ "$(bash "$REPO/scripts/prebuild-agents-image.sh" lookup --sha "$(git -C "$REPO" rev-parse HEAD)")" = "$DIGEST_REF" ] ||
  fail "a tests/benchmarks-only change must reuse the image of the same build context"

# Invalid input never reaches flyctl.
: > "$JOURNAL"
if bash "$REPO/scripts/prebuild-agents-image.sh" build --sha main 2>/dev/null; then fail "accepted a symbolic ref"; fi
[ ! -s "$JOURNAL" ] || fail "invalid input reached the registry"

# The cutover promotes through this lookup and keeps the original build path.
CUTOVER="$ROOT/scripts/deploy-agents-cooperative-cutover.sh"
grep -Fq 'prebuild-agents-image.sh" lookup --sha "$BUILD_ID"' "$CUTOVER" || fail "cutover does not look up the prebuilt image"
grep -Fq 'flyctl deploy --local-only --build-only --push --image-label "$IMAGE_LABEL"' "$CUTOVER" ||
  fail "cutover lost its fallback build"
WORKFLOW="$ROOT/.github/workflows/prebuild-agents-image.yml"
grep -Fq 'bash scripts/prebuild-agents-image.sh build --sha "$HEAD_SHA"' "$WORKFLOW" || fail "PR prebuild workflow is not wired"
grep -Fq "github.event.pull_request.head.repo.full_name == github.repository" "$WORKFLOW" ||
  fail "fork PRs must never receive the Fly token"
echo "prebuild-agents-image: PASS"
