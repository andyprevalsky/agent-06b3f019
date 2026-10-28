#!/usr/bin/env bash
# Build independently, then enqueue the immutable release. The shared database
# serializes bank ownership and resumes an interrupted predecessor before us.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${APP:-${FLY_APP_NAME:-}}"
if [ -z "$APP" ]; then
  APP=$(sed -nE 's/^app = "([a-z0-9-]+)"/\1/p' "$ROOT/agents/fly.toml")
fi
: "${FLY_API_TOKEN:?FLY_API_TOKEN is required}"
: "${APP:?APP is required}"
: "${SURFACE_HASH:?SURFACE_HASH is required}"
: "${BUILD_ID:?BUILD_ID is required}"
: "${DEPLOYMENT_TOKEN:?DEPLOYMENT_TOKEN is required}"
: "${DATABASE_URL:?DATABASE_URL is required}"
export FLY_API_TOKEN APP SURFACE_HASH BUILD_ID DEPLOYMENT_TOKEN
if [[ ! "$BUILD_ID" =~ ^[a-f0-9]{40}$ ]] ||
   [[ ! "$SURFACE_HASH" =~ ^[a-f0-9]{12}$ ]] ||
   [[ ! "$DEPLOYMENT_TOKEN" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$ ]]; then
  echo "Invalid immutable source, replay hash, or deployment attempt" >&2
  exit 2
fi
if [ "${DEPLOY_REUSE_ONLY:-1}" != 1 ]; then
  echo "Routine deployments only reuse enrolled Machines; provision the pool separately" >&2
  exit 2
fi
if [ "$(git -C "$ROOT" rev-parse HEAD)" != "$BUILD_ID" ] ||
   ! git -C "$ROOT" diff --quiet HEAD ||
   [ -n "$(git -C "$ROOT" ls-files --others --exclude-standard)" ]; then
  echo "Build requires the exact clean committed source named by BUILD_ID" >&2
  exit 2
fi

cd "$ROOT/back-end"
npm ci --workspaces=false --ignore-scripts
npx prisma generate

ARTIFACT_DIR=$(mktemp -d)
chmod 700 "$ARTIFACT_DIR"
trap 'rm -rf "$ARTIFACT_DIR"' EXIT
IMAGE_LABEL="cutover-${SURFACE_HASH}-${DEPLOYMENT_TOKEN}"
IMAGE_REF="registry.fly.io/${APP}:${IMAGE_LABEL}"
export IMAGE_REF

# Promote the image prebuilt before merge when this commit's agents tree is
# byte-identical to the prebuilt one (scripts/prebuild-agents-image.sh). A miss
# or any lookup failure builds exactly as before.
PREBUILT_REF=""
if [ "${AGENTS_PREBUILT_REUSE:-1}" = 1 ]; then
  PREBUILT_REF=$(APP="$APP" bash "$ROOT/scripts/prebuild-agents-image.sh" lookup --sha "$BUILD_ID") ||
    PREBUILT_REF=""
fi
if [[ "$PREBUILT_REF" =~ ^registry\.fly\.io/[a-z0-9-]+@sha256:[a-f0-9]{64}$ ]]; then
  echo "Promoting prebuilt worker image $PREBUILT_REF (agents tree $(git -C "$ROOT" rev-parse "$BUILD_ID:agents"))"
  IMAGE_REF="$PREBUILT_REF"
else
mkdir -p "$ARTIFACT_DIR/worker"
# Build from the immutable Git tree, never from files another local process can
# change while Docker reads its context. These directories are also excluded by
# the committed Docker ignore file; do not materialize their large test history.
git -C "$ROOT" archive "$BUILD_ID:agents" |
  tar -x -C "$ARTIFACT_DIR/worker" --exclude=benchmarks --exclude=tests
cd "$ARTIFACT_DIR/worker"
# Local build: neither the builder nor the rollout creates a Fly Machine.
flyctl deploy --local-only --build-only --push --image-label "$IMAGE_LABEL" -a "$APP"
flyctl auth docker
IMAGE_DIGEST=$(docker buildx imagetools inspect "$IMAGE_REF" --format '{{json .Manifest.Digest}}')
IMAGE_DIGEST=$(node -p 'JSON.parse(process.argv[1])' "$IMAGE_DIGEST")
if [[ ! "$IMAGE_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  echo "The pushed worker image has no immutable registry digest" >&2
  exit 1
fi
IMAGE_REF="registry.fly.io/${APP}@${IMAGE_DIGEST}"
fi
export IMAGE_REF
if [ "$(git -C "$ROOT" rev-parse HEAD)" != "$BUILD_ID" ] ||
   ! git -C "$ROOT" diff --quiet HEAD ||
   [ -n "$(git -C "$ROOT" ls-files --others --exclude-standard)" ]; then
  echo "Source changed while building; no deployment was enqueued" >&2
  exit 2
fi
cd "$ROOT/back-end"
node --input-type=module - "$ARTIFACT_DIR/request.json" <<'NODE'
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], JSON.stringify({
  app: process.env.APP,
  sourceCommit: process.env.BUILD_ID,
  buildId: process.env.BUILD_ID,
  surfaceHash: process.env.SURFACE_HASH,
  attempt: process.env.DEPLOYMENT_TOKEN,
  imageRef: process.env.IMAGE_REF,
}), { mode: 0o600, flag: 'wx' });
NODE
node --import tsx scripts/worker-deployment-queue.ts enqueue \
  --plan "$ARTIFACT_DIR/request.json" > "$ARTIFACT_DIR/enqueued.json"
JOB_ID=$(node --input-type=module - "$ARTIFACT_DIR/enqueued.json" <<'NODE'
import { readFileSync } from 'node:fs';
const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (typeof request.jobId !== 'string' || !request.jobId) throw new Error('Missing durable deployment job');
process.stdout.write(request.jobId);
NODE
)
echo "Queued production worker deployment $JOB_ID"
node --import tsx scripts/worker-deployment-queue.ts run --job-id "$JOB_ID" -- \
  python3 "$ROOT/scripts/worker_pool_cutover.py"
