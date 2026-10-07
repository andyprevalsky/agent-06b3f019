#!/usr/bin/env bash
# The existing host seed GET runner, shared by standalone fleets and campaigns.
set -uo pipefail
ROOT_DIR="$1"; _SEED_GUEST_TOKEN="$2"; _SEED_GUEST_PROBE="$3"
if ! command -v npx >/dev/null 2>&1; then
    for _npx_dir in "$HOME/.nvm/versions/node"/*/bin /usr/local/bin "$ROOT_DIR/node_modules/.bin"; do
        if [ -x "$_npx_dir/npx" ]; then export PATH="$_npx_dir:$PATH"; break; fi
    done
fi
command -v npx >/dev/null 2>&1 || exit 1
_seed_dump_get() {
    local token="$1" out="$2"
    # Prefer a runner that can resolve back-end deps. Cloud agents sometimes
    # have an empty/partial back-end/node_modules (npm arborist edgesOut bugs
    # on full installs); fall back to NODE_PATH + a known-good tsx binary so
    # we do not provision N Fly clones and then fail the start barrier because
    # the host falsely reported "missing" for a dump that exists in R2.
    local -a runners=()
    if [ -x "$ROOT_DIR/node_modules/.bin/tsx" ]; then
        runners+=("$ROOT_DIR/node_modules/.bin/tsx")
    fi
    if [ -x "$ROOT_DIR/back-end/node_modules/.bin/tsx" ]; then
        runners+=("$ROOT_DIR/back-end/node_modules/.bin/tsx")
    fi
    if command -v tsx >/dev/null 2>&1; then
        runners+=("$(command -v tsx)")
    fi
    local runner
    for runner in ${runners[@]+"${runners[@]}"}; do
        if (
            cd "$ROOT_DIR/back-end" &&
                NODE_PATH="$ROOT_DIR/back-end/node_modules${NODE_PATH:+:$NODE_PATH}" \
                    "$runner" scripts/seed-dump-cache.ts get "$token" "$out"
        ) && [ -s "$out" ]; then
            return 0
        fi
    done
    if node --experimental-strip-types -e 'export {}' >/dev/null 2>&1; then
        if (
            cd "$ROOT_DIR/back-end" &&
                NODE_PATH="$ROOT_DIR/back-end/node_modules${NODE_PATH:+:$NODE_PATH}" \
                    node --experimental-strip-types scripts/seed-dump-cache.ts get "$token" "$out"
        ) && [ -s "$out" ]; then
            return 0
        fi
    fi
    if (
        cd "$ROOT_DIR/back-end" &&
            NODE_PATH="$ROOT_DIR/back-end/node_modules${NODE_PATH:+:$NODE_PATH}" \
                npx --yes tsx scripts/seed-dump-cache.ts get "$token" "$out"
    ) && [ -s "$out" ]; then
        return 0
    fi
    return 1
}
for _seed_try in 1 2 3 4 5; do
    rm -f "$_SEED_GUEST_PROBE"
    if (cd "$ROOT_DIR/back-end" && _seed_dump_get "$_SEED_GUEST_TOKEN" "$_SEED_GUEST_PROBE") && [ -s "$_SEED_GUEST_PROBE" ]; then
        exit 0
    fi
    sleep "$_seed_try"
done
rm -f "$_SEED_GUEST_PROBE"
exit 1
