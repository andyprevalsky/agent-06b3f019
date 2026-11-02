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
cp "$ROOT/scripts/agents-image-context.sh" "$REPO/scripts/"
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

# The per-entry context equals the whole-tree archive minus benchmarks/tests,
# byte for byte and mode for mode (including an executable and nested dirs).
mkdir -p "$REPO/agents/pkg/tests" "$REPO/agents/pkg/sub"
printf 'x\n' > "$REPO/agents/pkg/sub/m.py"; printf 'y\n' > "$REPO/agents/pkg/tests/t.py"
printf '#!/bin/sh\n' > "$REPO/agents/run.sh"; chmod 755 "$REPO/agents/run.sh"
git -C "$REPO" -c user.email=t@e -c user.name=t add -A
git -C "$REPO" -c user.email=t@e -c user.name=t commit -qm context
CTX_SHA=$(git -C "$REPO" rev-parse HEAD)
mkdir -p "$TMP/ctx-old" "$TMP/ctx-new"
git -C "$REPO" archive "$CTX_SHA:agents" | tar -x -C "$TMP/ctx-old" --exclude=benchmarks --exclude=tests
bash "$REPO/scripts/agents-image-context.sh" "$CTX_SHA" "$TMP/ctx-new"
diff -r "$TMP/ctx-old" "$TMP/ctx-new" > /dev/null || fail "context helper content differs from the whole-tree archive"
[ "$(cd "$TMP/ctx-old" && find . -printf '%m %y %p\n' | sort)" = "$(cd "$TMP/ctx-new" && find . -printf '%m %y %p\n' | sort)" ] ||
  fail "context helper modes differ from the whole-tree archive"
[ ! -e "$TMP/ctx-new/benchmarks" ] && [ ! -e "$TMP/ctx-new/tests" ] && [ ! -e "$TMP/ctx-new/pkg/tests" ] ||
  fail "context helper kept excluded benchmarks/tests"

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
python3 - "$WORKFLOW" "$REPO" "$TMP" <<'PYTEST'
import os
from pathlib import Path
import re
import subprocess
import sys

workflow, repo, temporary = map(Path, sys.argv[1:])
text = workflow.read_text()
assert "\n  build:\n" in text and "\n  publish:\n" in text, "build and credentialed publish must use separate runners"
build, publish = text.split("\n  build:\n", 1)[1].split("\n  publish:\n", 1)
assert "secrets." not in build and "FLY_API_TOKEN" not in build, "PR build must have no deployment credential"
assert "needs: build" in publish
assert "actions/upload-artifact@" in build and "actions/download-artifact@" in publish
for action in re.findall(r"uses: ([^\s]+)", text):
    assert re.fullmatch(r"[^@]+@[a-f0-9]{40}", action), f"mutable action reference: {action}"
assert text.count("persist-credentials: false") == 2
assert text.count("ref: ${{ github.event.repository.default_branch }}") == 2
assert "prebuild-agents-image.sh build" not in text, "never run a PR script with the deployment token"
# Under `pull_request` a same-repository PR runs ITS copy of this YAML, so it
# could move secrets.FLY_API_TOKEN into any step. `pull_request_target` runs the
# base branch's YAML; the PR commit is only ever read as git objects.
assert text.startswith("name:") and "\non:\n  pull_request_target:\n" in text, "prebuild must run the base branch's workflow YAML"
assert "\n  pull_request:\n" not in text, "a pull_request trigger would hand the PR branch control of this YAML"
assert "ref: ${{ github.event.pull_request.head.sha }}" not in text and "ref: ${{ env.HEAD_SHA }}" not in text, \
    "never check out the PR head; read its objects"
assert "bash scripts/" not in text, "new PR helpers need not exist on the trusted default branch"
assert "docker run" not in publish and "docker build" not in publish
assert publish.count("${{ secrets.FLY_API_TOKEN }}") == 1

# Execute the workflow's real shell on the same git fixture, with a Docker
# boundary double. This proves the build context and tag match promotion.
def script(name):
    section = text.split(f"- name: {name}\n", 1)[1]
    body = section.split("        run: |\n", 1)[1]
    lines = []
    for line in body.splitlines():
        if line and not line.startswith("          "):
            break
        lines.append(line[10:])
    return "\n".join(lines)

head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
env = dict(os.environ, HEAD_SHA=head, RUNNER_TEMP=str(temporary), GITHUB_WORKSPACE=str(repo), GH_TOKEN="fixture-read-token")
env.pop("FLY_API_TOKEN", None)
# Context preparation fetches an exact SHA in Actions; the fixture already has it.
prepare = script("Prepare build context")
prepare = prepare.replace('git fetch --no-tags --filter=blob:none --depth=1 origin "$HEAD_SHA"', 'git cat-file -e "$HEAD_SHA"')
subprocess.run(["bash", "-euc", prepare], cwd=repo, env=env, check=True)
assert (temporary / "agents-context/worker.py").read_bytes() == (repo / "agents/worker.py").read_bytes()
assert not (temporary / "agents-context/tests").exists()
assert subprocess.run(["diff", "-r", str(temporary / "ctx-new"), str(temporary / "agents-context")],
                      capture_output=True).returncode == 0, "workflow and cutover contexts must match"
assert (temporary / "agents-context/run.sh").stat().st_mode == (temporary / "ctx-new/run.sh").stat().st_mode

fake_bin = temporary / "workflow-bin"
fake_bin.mkdir()
(fake_bin / "docker").write_text('#!/usr/bin/env bash\nset -euo pipefail\n[[ -z "${FLY_API_TOKEN:-}" ]] || exit 98\nprintf \'%s\\n\' "$*" >> "$RUNNER_TEMP/workflow-docker.log"\ncase "$1" in\n  build) [[ "$*" == "build --tag agents-prebuild:$HEAD_SHA $RUNNER_TEMP/agents-context" ]] ;;\n  save) [[ "$*" == "save --output $RUNNER_TEMP/agents-image.tar agents-prebuild:$HEAD_SHA" ]]; touch "$RUNNER_TEMP/agents-image.tar" ;;\n  *) exit 99 ;;\nesac\n')
(fake_bin / "docker").chmod(0o755)
env["PATH"] = str(fake_bin) + os.pathsep + env["PATH"]
subprocess.run(["bash", "-euc", script("Build image without credentials")], cwd=repo, env=env, check=True)
assert (temporary / "agents-image.tar").exists()
# A malicious PR helper is never invoked by the publisher. Only docker load,
# tag and push handle the image on the new runner; nothing runs that image.
(repo / "scripts/prebuild-agents-image.sh").write_text("exit 97\n")
(temporary / "prebuild").mkdir()
(temporary / "prebuild/agents-image.tar").write_bytes((temporary / "agents-image.tar").read_bytes())
env["GITHUB_ENV"] = str(temporary / "publish.env")
(fake_bin / "docker").write_text("#!/usr/bin/env bash\nset -euo pipefail\n"
    '[[ -z "${FLY_API_TOKEN:-}" ]] || exit 98\n'
    'case "$1" in load|tag|push) ;; *) exit 99 ;; esac\n'
    'printf "%s\\n" "$*" >> "$RUNNER_TEMP/publish-docker.log"\n')
resolve = script("Resolve trusted destination and content key").replace(
    'git fetch --no-tags --filter=blob:none --depth=1 origin "$HEAD_SHA"', 'git cat-file -e "$HEAD_SHA"')
subprocess.run(["bash", "-euc", resolve], cwd=repo, env=env, check=True)
reference = (temporary / "publish.env").read_text().strip().split("=", 1)[1]
entries = subprocess.check_output(["git", "ls-tree", f"{head}:agents"], cwd=repo)
entries = b"\n".join(line for line in entries.splitlines() if line.split(b"\t")[1] not in (b"benchmarks", b"tests")) + b"\n"
key = subprocess.check_output(["git", "hash-object", "--stdin"], cwd=repo, input=entries).decode().strip()
assert reference == f"registry.fly.io/test-prod:prebuilt-{key}", reference
(fake_bin / "flyctl").write_text("#!/usr/bin/env bash\nset -euo pipefail\n"
    '[[ "$*" == "auth docker" && "$FLY_API_TOKEN" == "fixture-publish-token" ]]\n')
(fake_bin / "flyctl").chmod(0o755)
subprocess.run(["bash", "-euc", "flyctl auth docker"], cwd=repo,
               env={**env, "FLY_API_TOKEN": "fixture-publish-token"}, check=True)
subprocess.run(["bash", "-euc", 'docker push "$PREBUILD_REF"'], cwd=repo,
               env={**env, "PREBUILD_REF": reference}, check=True)
assert (temporary / "publish-docker.log").read_text().splitlines() == [
    f"load --input {temporary}/prebuild/agents-image.tar",
    f"tag agents-prebuild:{head} {reference}", f"push {reference}"]
print("PASS trusted publisher preserves the promotion key without executing PR code")
print("PASS isolated credential-free build and pinned workflow actions")
PYTEST
grep -Fq "github.event.pull_request.head.repo.full_name == github.repository" "$WORKFLOW" ||
  fail "fork PRs must never receive the Fly token"
echo "prebuild-agents-image: PASS"

# Deployment and recovery also execute dependency code. Neither may retain the checkout token.
python3 - "$ROOT/.github/workflows/deploy-agents.yml" <<'PY_DEPLOY_CHECKOUT'
from pathlib import Path
import sys
import re
text = Path(sys.argv[1]).read_text()
blocks = re.findall(r"(?ms)^      - uses: actions/checkout@[^\n]+\n(.*?)(?=^      - |\Z)", text)
assert len(blocks) == 2
for block in blocks:
    assert re.search(r"^          persist-credentials: false$", block, re.M), block
PY_DEPLOY_CHECKOUT
