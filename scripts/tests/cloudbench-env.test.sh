#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HELPER_SRC="$ROOT_DIR/scripts/lib/cloudbench-env.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

require_text() {
  local file="$1" text="$2" description="$3"
  grep -Fq -- "$text" "$file" || fail "$description"
}

[ -f "$HELPER_SRC" ] || fail "cloud benchmark env helper is missing"
require_text "$ROOT_DIR/scripts/cloudbench-run.sh" \
  'DATA_DIR="${CLOUDBENCH_DATA_DIR:-/data}"' \
  "cloud benchmark data root must retain its persistent default"
require_text "$ROOT_DIR/scripts/cloudbench-run.sh" \
  'STACK_SEED_DUMP="${CLOUDBENCH_SEED_DUMP_PATH:-$DATA_DIR/cloudbench-cache/victoria-seed.dump}"' \
  "cloud benchmark seed-dump freshness proof must retain its persistent default"
require_text "$ROOT_DIR/scripts/cloudbench-run.sh" \
  "export BENCHMARK_SEED_DUMP='\$STACK_SEED_DUMP'" \
  "cloud benchmark process must receive the configured seed-dump freshness proof"
require_text "$ROOT_DIR/scripts/cloudbench-run.sh" \
  "export BENCHMARK_REQUIRE_SEED_DUMP=1" \
  "cloud benchmarks must fail closed instead of replacing the canonical base"
# shellcheck source=../lib/cloudbench-env.sh
source "$HELPER_SRC"

# Execute the actual controller launch fragments without touching cloud resources.
python3 - "$ROOT_DIR" <<'PY' || fail "world-model cloud launch handoff failed"
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

root = Path(sys.argv[1])
source = (root / "scripts/run-bench-cloud").read_text()
configuration = re.search(
    r"^# World-model launch configuration.*?^# End world-model launch configuration\.\n",
    source, re.M | re.S,
)
configuration = configuration.group(0) if configuration else ""

def run(script, values=None):
    environment = {
        "PATH": os.environ["PATH"], "ROOT_DIR": str(root),
        "WMH_ENGINE": "experiential", "WMH_ROSE_POOL": "rose-1-mini",
        "WMH_CONTEXT_TOKENS": "131072",
        "WMH_NATIVE_PYTHON": "/controller/local/python",
        "WMH_BUILD_DIR": "/controller/local/model",
    }
    environment.update(values or {})
    return subprocess.run(["bash", "-c", configuration + script], env=environment,
                          text=True, capture_output=True)

# Donor free space as `df -PB1` reports it; DF_AVAIL sets the available bytes.
# DF_AVAIL_FREED (optional) is reported once $REMOTE_WMH_NATIVE no longer exists.
DF_FAKE = ("df() { a=\"$DF_AVAIL\"; if [ -n \"${DF_AVAIL_FREED:-}\" ] && [ ! -e \"$REMOTE_WMH_NATIVE\" ]; then a=\"$DF_AVAIL_FREED\"; fi; "
           "printf 'Filesystem 1-blocks Used Available Capacity Mounted\\nfake 0 0 %s 0%% /data\\n' \"$a\"; };\n")

class WorldModelLaunch(unittest.TestCase):
    def assert_handoff(self, values, *, engine="experiential", pool="rose-1-mini",
                       policy="rose-outcome-distribution-v4"):
        self.assertEqual({key: values.get(key) for key in (
            "WMH_ENGINE", "WMH_ROSE_POOL", "WMH_CONTEXT_TOKENS", "WMH_EXECUTION_POLICY",
        )}, {"WMH_ENGINE": engine, "WMH_ROSE_POOL": pool,
            "WMH_CONTEXT_TOKENS": "131072", "WMH_EXECUTION_POLICY": policy})
        self.assertNotIn("WMH_NATIVE_PYTHON", values)
        self.assertNotIn("WMH_BUILD_DIR", values)

    def test_boot_machine_arguments(self):
        fragment = re.search(r"^    _envargs=\(\n.*?^    \)\n", source, re.M | re.S).group(0)
        result = run(fragment + 'printf "%s\\n" "${_envargs[@]}"')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_handoff(dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line))

    def test_ssh_wrapper_exports(self):
        fragment = "\n".join(line for line in source.splitlines()
                             if re.match(r'^    echo "export WMH_', line))
        result = run(fragment)
        self.assertEqual(result.returncode, 0, result.stderr)
        exports = run(result.stdout + '\nprintf "%s\\n" "$WMH_ENGINE" "$WMH_ROSE_POOL" "$WMH_CONTEXT_TOKENS"',
                      {"WMH_ENGINE": "legacy", "WMH_ROSE_POOL": "rose-1-ultra", "WMH_CONTEXT_TOKENS": ""})
        self.assertEqual(exports.returncode, 0, exports.stderr)
        self.assertEqual(exports.stdout.splitlines(), ["experiential", "rose-1-mini", "131072"])
        model = run(result.stdout + '\nprintf "%s\\n" "$WMH_MODEL_NAME" "$WMH_EXECUTION_POLICY"', {})
        self.assertEqual(model.stdout.splitlines(), ["rose-archive", "rose-outcome-distribution-v4"])
        exported_keys = {line.split("=", 1)[0].removeprefix("export ") for line in result.stdout.splitlines()}
        self.assertFalse(exported_keys & {"WMH_NATIVE_PYTHON", "WMH_BUILD_DIR"})

    def test_refresh_build_receives_guest_settings(self):
        fragment = re.search(r'^    BUILD_CMD="set -e\n.*?^    REFRESH_LOG=', source, re.M | re.S).group(0)
        fragment = fragment[:fragment.rfind("    REFRESH_LOG=")]
        with tempfile.TemporaryDirectory(prefix="wmh-refresh-launch-") as temporary:
            scratch = Path(temporary)
            repo = scratch / "repo"
            executable = repo / "agents/venv/bin/python"
            executable.parent.mkdir(parents=True)
            (repo / "back-end").mkdir()
            receipt = scratch / "receipt.json"
            executable.write_text("#!" + sys.executable + "\nimport json,os,sys\n"
                                  "from pathlib import Path\nPath(os.environ['LAUNCH_RECEIPT']).write_text(json.dumps("
                                  "{'env': {k:v for k,v in os.environ.items() if k.startswith('WMH_')}, 'args':sys.argv[1:]}))\n")
            executable.chmod(0o755)
            # The on-box build is the explicit legacy path; native restores a cache.
            result = run(
                "gosu() { shift; \"$@\"; }; chown() { :; };\n" + fragment
                + '\nunset WMH_ENGINE WMH_ROSE_POOL WMH_CONTEXT_TOKENS WMH_NATIVE_PYTHON WMH_BUILD_DIR; eval "$BUILD_CMD"',
                {"WMH_ENGINE": "legacy", "WMH_EXECUTION_POLICY": "upstream",
                 "REMOTE_REPO": str(repo), "REMOTE_WMH": str(scratch / "world-model"),
                 "WMH_MODEL_NAME": "rose-test", "WMH_REFRESH_MAX_BUNDLES": "0",
                 "WMH_REFRESH_MAX_STEPS": "0", "WMH_REFRESH_MAX_STEPS_PER_BUNDLE": "0",
                 "WMH_REFRESH_ROOT_AGENT_IDS": "", "LAUNCH_RECEIPT": str(receipt)},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            captured = json.loads(receipt.read_text())
            settings = captured["env"]
            self.assertEqual(settings.pop("WMH_BUILD_DIR"), str(scratch / "world-model"))
            self.assert_handoff(settings, engine="legacy", policy="upstream")
            self.assertEqual(captured["args"][:2], ["-u", "-c"])
            self.assertIn("update_world_model_for_simulation", captured["args"][2])

    def test_defaults_and_invalid_configuration(self):
        show = 'printf "%s\\n" "$WMH_ENGINE" "$WMH_MODEL_NAME" "$WMH_ROSE_POOL" "$WMH_EXECUTION_POLICY" "$WMH_CONTEXT_TOKENS" "$WMH_CACHE_NAME"'
        unset = {"WMH_ENGINE": "", "WMH_ROSE_POOL": "", "WMH_CONTEXT_TOKENS": ""}
        result = run(show, unset)
        self.assertEqual(result.returncode, 0, result.stderr)
        # Cloud SIM defaults to the native experiential WMH the local runs use.
        self.assertEqual(result.stdout.splitlines(), [
            "experiential", "rose-archive", "rose-wmh-gpt61", "rose-outcome-distribution-v4", "",
            "rose-archive-serving"])
        legacy = run(show, {**unset, "WMH_ENGINE": "legacy"})
        self.assertEqual(legacy.returncode, 0, legacy.stderr)
        self.assertEqual(legacy.stdout.splitlines(), [
            "legacy", "rose-r2-archive-anthropic", "rose-1-ultra", "upstream", "", "rose-archive-serving"])
        overridden = run(show, {**unset, "WMH_MODEL_NAME": "custom-model", "WMH_ROSE_POOL": "rose-1-ultra",
                                "WMH_EXECUTION_POLICY": "upstream", "WMH_CACHE_NAME": "custom-cache"})
        self.assertEqual(overridden.stdout.splitlines(), [
            "experiential", "custom-model", "rose-1-ultra", "upstream", "", "custom-cache"])
        self.assertEqual(run(":", {"WMH_ENGINE": "legacy",
                                   "WMH_EXECUTION_POLICY": "rose-outcome-distribution-v4"}).returncode, 2)
        legacy_names = run('printf "%s\\n" "$WMH_LEGACY_CACHE_NAME" "$WMH_LEGACY_MODEL_NAME"', unset)
        self.assertEqual(legacy_names.stdout.splitlines(), ["rose-r2-archive-legacy", "rose-r2-archive-anthropic"])
        for key in ("WMH_MODEL_NAME", "WMH_CACHE_NAME", "WMH_LEGACY_CACHE_NAME", "WMH_LEGACY_MODEL_NAME"):
            with self.subTest(unsafe=key):
                self.assertEqual(run(":", {key: "x';id'"}).returncode, 2)
        for key, value in (("WMH_ENGINE", "unknown"),
                           ("WMH_ROSE_POOL", "pool;invalid"), ("WMH_CONTEXT_TOKENS", "0"),
                           ("WMH_CONTEXT_TOKENS", "-1"), ("WMH_CONTEXT_TOKENS", "1.5")):
            with self.subTest(key=key, value=value):
                self.assertEqual(run(":", {key: value}).returncode, 2)

    def test_native_refresh_restores_the_serving_cache_without_building(self):
        refresh = source[source.index('if [ "$MODE" = "refresh-wmh" ]; then'):source.index("# MODE: run (default)")]
        # The WMH refresh shares the bench app with concurrent fleets: it holds
        # the maintenance lock and verifies secrets read-only, and never
        # restages them (that reverted other guests' Temporal namespace).
        refresh_mode = refresh[:refresh.index("# MODE: --build-wmh")] if "# MODE: --build-wmh" in refresh else refresh
        self.assertNotIn("inject_secrets", refresh_mode)
        self.assertLess(refresh_mode.index("acquire_app_environment_lock || exit 1"),
                        refresh_mode.index("verify_app_environment || exit 1"))
        self.assertLess(refresh_mode.index("verify_app_environment || exit 1"),
                        refresh_mode.index('prepare_warm_source "$mid"'))
        # Experiential (the default) selects the cache restore; only legacy builds on the donor.
        self.assertRegex(refresh, r'if \[ "\$WMH_ENGINE" = experiential \]; then\n[^\n]*\n\s+BUILD_CMD="\$NATIVE_REFRESH_CMD"')
        fragment = re.search(r'^    NATIVE_REFRESH_CMD="set -e\n.*?^ {4}# Legacy', source, re.M | re.S).group(0)
        fragment = fragment[:fragment.rfind("    # Legacy")]
        self.assertNotIn("update_world_model_for_simulation", fragment)
        # The native restore writes the legacy model directory only through the
        # guarded legacy-cache restore (2026-10-19 a --force restore into
        # $REMOTE_WMH deleted rose-r2-archive-anthropic from the donor).
        legacy_block = re.search(r"^if \[ -f '\$REMOTE_WMH/build\.manifest\.json' \].*?^fi\n", fragment, re.M | re.S).group(0)
        # (the closing read-only listing reports both model directories)
        outside = "\n".join(line for line in fragment.replace(legacy_block, "").splitlines()
                             if not line.startswith("ls -la "))
        self.assertNotIn("$REMOTE_WMH'", outside)
        self.assertNotIn("$REMOTE_WMH/", outside)
        self.assertNotIn("$REMOTE_WMH.", outside)
        self.assertIn("create_volume_snapshot_exact", refresh[refresh.index('BUILD_CMD="$NATIVE_REFRESH_CMD"'):])
        # The restored tree is flushed after the swap and before the donor stops
        # for its snapshot (2026-10-20 an unflushed blob tail was snapshotted
        # truncated and every SIM guest failed the native artifact digest).
        swap = fragment.index("mv '$REMOTE_WMH_NATIVE.incoming' '$REMOTE_WMH_NATIVE'")
        # Separate commands: under set -e a failed `sync -f` in `a && b` would not
        # stop the refresh before the DONE marker (CodeRabbit, PR #1560).
        flush = fragment.index("sync -f '$REMOTE_WMH_NATIVE'\nsync\n")
        self.assertLess(swap, flush)
        self.assertLess(flush, fragment.index("echo '::WMH-REFRESH-DONE::'"))
        # Fleets rehydrate the donor proof from Machine metadata (observed
        # 2026-10-19: a refreshed WMH snapshot was never forked because only the
        # local state file named it). Publication must name the new snapshot
        # and fail the refresh when it cannot be published.
        publication = refresh[refresh.index('create_volume_snapshot_exact "$VOL_ID"'):]
        self.assertRegex(publication, r'if ! cloudbench_publish_warm_deps_state "\$APP" "\$maintenance_mid" "\$VOL_ID" \\\n\s+"\$RECORDED_NODE_FP" "\$RECORDED_PY_FP" "\$SNAP_START_EPOCH" "\$NEW_SNAP"; then\n[^\n]*\n\s+exit 1')
        self.assertIn('printf \'%s %s\\n\' "$EXPECTED_WMH_REF" "$NEW_SNAP"', publication)
        fake_python = (
            "#!" + sys.executable + "\nimport json,os,sys\nfrom pathlib import Path\n"
            "argv=sys.argv[1:]\n"
            "open(os.environ['CALLS'],'a').write(json.dumps({'tool':'python','argv':argv,"
            "'user_home':os.environ.get('HOME')})+'\\n')\n"
            "if argv[:4]==['-m','pip','install','--quiet']:\n"
            "    uv=Path(sys.argv[0]).parent/'uv'; uv.write_text('#!/bin/sh\\n'); uv.chmod(0o755)\n"
            "if argv[:1]==['-c']:\n"
            "    os.execv(sys.executable,[sys.executable]+argv)\n"
            "if 'status' in argv:\n"
            "    print(json.dumps({'name':argv[-1],'plaintext_bytes':int(os.environ['CACHE_BYTES'])})); sys.exit(0)\n"
            "if 'benchmarks.wmh_build_cache' in argv and argv[argv.index('--name')+1]==os.environ.get('LEGACY_CACHE'):\n"
            "    root=Path(argv[argv.index('--build-dir')+1])\n"
            "    (root/'models/rose-r2-archive-anthropic').mkdir(parents=True)\n"
            "    if os.environ.get('LEGACY_PULL')!='no-model':\n"
            "        (root/'models/rose-r2-archive-anthropic/model.json').write_text('restored-legacy')\n"
            "    else:\n"
            "        (root/'models/rose-r2-archive-anthropic').rmdir()\n"
            "    (root/'build.manifest.json').write_text('restored-legacy-manifest')\n"
            "    sys.exit(0)\n"
            "if 'benchmarks.wmh_build_cache' in argv and os.environ.get('PULL_MODE')!='fail':\n"
            "    root=Path(argv[argv.index('--build-dir')+1])\n"
            "    (root/'models/rose-archive').mkdir(parents=True, exist_ok=True)\n"
            "    if os.environ.get('PULL_MODE')!='no-pointer':\n"
            "        (root/'models/rose-archive/experiential.json').write_text('{}')\n"
            "    (root/'build.manifest.json').write_text('{}')\n"
            "sys.exit(3 if os.environ.get('PULL_MODE')=='fail' and 'benchmarks.wmh_build_cache' in argv else 0)\n"
        )
        for mode, ok in (("ok", True), ("no-pointer", False), ("fail", False)):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(prefix="wmh-native-refresh-") as temporary:
                scratch = Path(temporary)
                repo = scratch / "repo"
                python = repo / "agents/venv/bin/python"
                python.parent.mkdir(parents=True)
                (repo / "back-end").mkdir()
                (repo / "scripts").mkdir()
                python.write_text(fake_python)
                python.chmod(0o755)
                calls = scratch / "calls.jsonl"
                (repo / "scripts/setup-world-model.sh").write_text(
                    "printf '{\"tool\":\"setup\",\"uv_python\":\"%s\",\"cwd\":\"%s\"}\\n' "
                    "\"$UV_PYTHON_INSTALL_DIR\" \"$PWD\" >> \"$CALLS\"\n")
                world = scratch / "world-model"
                legacy_model = world / "models/rose-r2-archive-anthropic/model.json"
                legacy_model.parent.mkdir(parents=True)
                legacy_model.write_text("legacy")
                (world / "build.manifest.json").write_text("legacy-manifest")
                native = scratch / "world-model-native"
                (native / "models/rose-archive").mkdir(parents=True)
                (native / "models/rose-archive/experiential.json").write_text("previous")
                result = run(
                    "gosu() { shift; \"$@\"; }; chown() { :; }; rsync() { return 1; };\n" + DF_FAKE + fragment
                    + '\neval "$NATIVE_REFRESH_CMD"',
                    {"REMOTE_REPO": str(repo), "REMOTE_WMH": str(world), "REMOTE_WMH_NATIVE": str(native),
                     "WMH_MODEL_NAME": "rose-archive", "WMH_LEGACY_CACHE_NAME": "rose-r2-archive-legacy",
                     "WMH_LEGACY_MODEL_NAME": "rose-r2-archive-anthropic", "LEGACY_CACHE": "rose-r2-archive-legacy",
                     "WMH_CACHE_NAME": "rose-archive-serving", "REMOTE_UV_PYTHON": str(scratch / "uv-python"),
                     "CALLS": str(calls), "PULL_MODE": mode, "CACHE_BYTES": "1000", "DF_AVAIL": str(2 << 30)},
                )
                self.assertEqual(result.returncode == 0, ok, result.stdout + result.stderr)
                self.assertEqual("::WMH-REFRESH-DONE::" in result.stdout, ok)
                records = [json.loads(line) for line in calls.read_text().splitlines()]
                pythons = [record["argv"] for record in records if record["tool"] == "python" and record["argv"][:1] != ["-c"]]
                self.assertEqual(pythons[0], ["-m", "pip", "install", "--quiet", "uv"])
                # An intact legacy model is left alone: only the native cache is sized and pulled.
                self.assertEqual(pythons[1], ["-u", "-m", "benchmarks.wmh_build_cache", "status", "--name",
                                              "rose-archive-serving"])
                pythons.pop(1)
                self.assertEqual(pythons[1], ["-u", "-m", "benchmarks.wmh_build_cache", "pull", "--build-dir",
                                              str(native) + ".incoming", "--name", "rose-archive-serving", "--force"])
                # Other workspaces' legacy model and manifest survive every outcome.
                self.assertEqual(legacy_model.read_text(), "legacy")
                self.assertEqual((world / "build.manifest.json").read_text(), "legacy-manifest")
                self.assertEqual(sorted(path.name for path in scratch.iterdir() if path.name.startswith("world-model")),
                                 ["world-model", "world-model-native"])
                pointer = (native / "models/rose-archive/experiential.json").read_text()
                self.assertEqual(pointer, "{}" if ok else "previous")
                self.assertEqual(len(pythons), 2)
                setup = [record for record in records if record["tool"] == "setup"]
                self.assertEqual(setup, [{"tool": "setup", "uv_python": str(scratch / "uv-python"),
                                          "cwd": str(repo)}])
                self.assertTrue((scratch / "uv-python").is_dir())

    def test_native_refresh_replaces_a_previous_native_tree_that_leaves_too_little_room(self):
        # 2026-10-20 re-refreshing a donor that already held a ~16 GB native tree
        # failed its headroom check (7.1 GB free, 20.5 GB needed), so a corrupt
        # native model could never be replaced. The previous tree is dropped only
        # when the staged pull would not otherwise fit, and only after proving the
        # drop frees enough: a refresh that cannot fit keeps the previous tree.
        fragment = re.search(r'^    NATIVE_REFRESH_CMD="set -e\n.*?^ {4}# Legacy', source, re.M | re.S).group(0)
        fragment = fragment[:fragment.rfind("    # Legacy")]
        fake_python = (
            "#!" + sys.executable + "\nimport json,os,sys\nfrom pathlib import Path\nargv=sys.argv[1:]\n"
            "if argv[:1]==['-c']:\n    os.execv(sys.executable,[sys.executable]+argv)\n"
            "open(os.environ['CALLS'],'a').write(json.dumps(argv)+'\\n')\n"
            "if argv[:4]==['-m','pip','install','--quiet']:\n"
            "    uv=Path(sys.argv[0]).parent/'uv'; uv.write_text('#!/bin/sh\\n'); uv.chmod(0o755); sys.exit(0)\n"
            "if 'status' in argv:\n"
            "    print(json.dumps({'plaintext_bytes':19*10**9})); sys.exit(0)\n"
            "root=Path(argv[argv.index('--build-dir')+1])\n"
            "(root/'models/rose-archive').mkdir(parents=True)\n"
            "(root/'models/rose-archive/experiential.json').write_text('fresh')\n"
            "(root/'build.manifest.json').write_text('native-manifest')\n"
        )
        gib = 1 << 30
        for case, freed, ok, sync_fails in (("room-after-drop", 30 * gib, True, ""),
                                            ("no-room-even-after-drop", 10 * gib, False, ""),
                                            ("flush-fails", 30 * gib, False, "1")):
            with self.subTest(case=case), tempfile.TemporaryDirectory(prefix="wmh-native-replace-") as temporary:
                scratch = Path(temporary)
                repo = scratch / "repo"
                python = repo / "agents/venv/bin/python"
                python.parent.mkdir(parents=True)
                (repo / "back-end").mkdir()
                (repo / "scripts").mkdir()
                (repo / "scripts/setup-world-model.sh").write_text(":\n")
                python.write_text(fake_python)
                python.chmod(0o755)
                world = scratch / "world-model"
                (world / "models/rose-r2-archive-anthropic").mkdir(parents=True)
                (world / "models/rose-r2-archive-anthropic/model.json").write_text("donor-legacy")
                (world / "build.manifest.json").write_text("donor-legacy-manifest")
                native = scratch / "world-model-native"
                (native / "models/rose-archive").mkdir(parents=True)
                (native / "models/rose-archive/experiential.json").write_text("corrupt-previous")
                calls = scratch / "calls.jsonl"
                result = run(
                    "gosu() { shift; \"$@\"; }; chown() { :; }; rsync() { return 1; };\n"
                    "sync() { [ -z \"$SYNC_FAILS\" ] || [ \"${1:-}\" != -f ]; };\n"
                    # The previous tree occupies exactly what dropping it frees.
                    "du() { printf '%s\\t%s\\n' \"$((DF_AVAIL_FREED - DF_AVAIL))\" \"${@: -1}\"; };\n" + DF_FAKE + fragment
                    + '\neval "$NATIVE_REFRESH_CMD"',
                    {"REMOTE_REPO": str(repo), "REMOTE_WMH": str(world), "REMOTE_WMH_NATIVE": str(native),
                     "WMH_MODEL_NAME": "rose-archive", "WMH_CACHE_NAME": "rose-archive-serving",
                     "WMH_LEGACY_CACHE_NAME": "rose-r2-archive-legacy",
                     "WMH_LEGACY_MODEL_NAME": "rose-r2-archive-anthropic",
                     "REMOTE_UV_PYTHON": str(scratch / "uv-python"), "CALLS": str(calls),
                     "DF_AVAIL": str(7 * gib), "DF_AVAIL_FREED": str(freed), "SYNC_FAILS": sync_fails},
                )
                self.assertEqual(result.returncode == 0, ok, result.stdout + result.stderr)
                self.assertEqual("::WMH-REFRESH-DONE::" in result.stdout, ok)
                pulls = [json.loads(line) for line in calls.read_text().splitlines() if '"pull"' in line]
                pulled = ok or bool(sync_fails)
                self.assertEqual(len(pulls), 1 if pulled else 0)
                self.assertEqual((native / "models/rose-archive/experiential.json").read_text(),
                                 "fresh" if pulled else "corrupt-previous")
                self.assertEqual("dropping the previous native WMH tree" in result.stdout, pulled)
                self.assertEqual((world / "models/rose-r2-archive-anthropic/model.json").read_text(), "donor-legacy")

    def test_native_refresh_restores_a_lost_legacy_model_beside_the_native_one(self):
        # 2026-10-19 a native restore overwrote /data/world-model, so main's
        # legacy engine lost rose-r2-archive-anthropic. One refresh must leave
        # both engines servable: legacy restored from its R2 cache atomically
        # when missing, after a disk-headroom check, before the native pull.
        fragment = re.search(r'^    NATIVE_REFRESH_CMD="set -e\n.*?^ {4}# Legacy', source, re.M | re.S).group(0)
        fragment = fragment[:fragment.rfind("    # Legacy")]
        fake_python = (
            "#!" + sys.executable + "\nimport json,os,sys\nfrom pathlib import Path\nargv=sys.argv[1:]\n"
            "if argv[:1]==['-c']:\n    os.execv(sys.executable,[sys.executable]+argv)\n"
            "open(os.environ['CALLS'],'a').write(json.dumps(argv)+'\\n')\n"
            "if argv[:4]==['-m','pip','install','--quiet']:\n"
            "    uv=Path(sys.argv[0]).parent/'uv'; uv.write_text('#!/bin/sh\\n'); uv.chmod(0o755); sys.exit(0)\n"
            "name=argv[argv.index('--name')+1] if '--name' in argv else ''\n"
            "if 'status' in argv:\n"
            "    print(json.dumps({'name':name,'plaintext_bytes':int(os.environ['BYTES_'+name.replace('-','_')])})); sys.exit(0)\n"
            "root=Path(argv[argv.index('--build-dir')+1])\n"
            "if name=='rose-r2-archive-legacy':\n"
            "    root.mkdir(parents=True)\n"
            "    if os.environ.get('LEGACY_PULL')!='no-model':\n"
            "        (root/'models/rose-r2-archive-anthropic').mkdir(parents=True)\n"
            "        (root/'models/rose-r2-archive-anthropic/model.json').write_text('restored-legacy')\n"
            "    (root/'build.manifest.json').write_text('legacy-manifest')\n"
            "else:\n"
            "    (root/'models/rose-archive').mkdir(parents=True)\n"
            "    (root/'models/rose-archive/experiential.json').write_text('native')\n"
            "    (root/'build.manifest.json').write_text('native-manifest')\n"
        )
        gib = 1 << 30
        legacy_pull = ["-u", "-m", "benchmarks.wmh_build_cache", "pull", "--build-dir", "{world}.incoming",
                       "--name", "rose-r2-archive-legacy", "--force"]
        native_pull = ["-u", "-m", "benchmarks.wmh_build_cache", "pull", "--build-dir", "{native}.incoming",
                       "--name", "rose-archive-serving", "--force"]
        status = lambda name: ["-u", "-m", "benchmarks.wmh_build_cache", "status", "--name", name]
        # (case, donor legacy dir state, legacy pull, free bytes, ok, expected cache calls, legacy after)
        cases = (
            ("native-in-legacy-dir", "native", "ok", 30 * gib, True,
             [status("rose-r2-archive-legacy"), legacy_pull, status("rose-archive-serving"), native_pull], "restored-legacy"),
            ("legacy-dir-absent", "absent", "ok", 30 * gib, True,
             [status("rose-r2-archive-legacy"), legacy_pull, status("rose-archive-serving"), native_pull], "restored-legacy"),
            ("legacy-intact", "legacy", "ok", 30 * gib, True,
             [status("rose-archive-serving"), native_pull], "donor-legacy"),
            ("legacy-cache-lacks-model", "native", "no-model", 30 * gib, False,
             [status("rose-r2-archive-legacy"), legacy_pull], None),
            ("no-room-for-legacy", "native", "ok", 5 * gib, False,
             [status("rose-r2-archive-legacy")], None),
            ("no-room-for-native", "legacy", "ok", 10 * gib, False,
             [status("rose-archive-serving")], "donor-legacy"),
        )
        for case, donor_state, legacy_mode, free, ok, expected, legacy_after in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory(prefix="wmh-dual-refresh-") as temporary:
                scratch = Path(temporary)
                repo = scratch / "repo"
                python = repo / "agents/venv/bin/python"
                python.parent.mkdir(parents=True)
                (repo / "back-end").mkdir()
                (repo / "scripts").mkdir()
                (repo / "scripts/setup-world-model.sh").write_text(":\n")
                python.write_text(fake_python)
                python.chmod(0o755)
                calls = scratch / "calls.jsonl"
                world = scratch / "world-model"
                native = scratch / "world-model-native"
                if donor_state == "native":
                    (world / "models/rose-archive").mkdir(parents=True)
                    (world / "models/rose-archive/experiential.json").write_text("stale-native")
                    (world / "build.manifest.json").write_text("stale-native-manifest")
                elif donor_state == "legacy":
                    (world / "models/rose-r2-archive-anthropic").mkdir(parents=True)
                    (world / "models/rose-r2-archive-anthropic/model.json").write_text("donor-legacy")
                    (world / "build.manifest.json").write_text("donor-legacy-manifest")
                before = sorted(str(path.relative_to(scratch)) for path in scratch.rglob("*") if "world-model" in str(path))
                result = run(
                    "gosu() { shift; \"$@\"; }; chown() { :; }; rsync() { return 1; };\n" + DF_FAKE + fragment
                    + '\neval "$NATIVE_REFRESH_CMD"',
                    {"REMOTE_REPO": str(repo), "REMOTE_WMH": str(world), "REMOTE_WMH_NATIVE": str(native),
                     "WMH_MODEL_NAME": "rose-archive", "WMH_CACHE_NAME": "rose-archive-serving",
                     "WMH_LEGACY_CACHE_NAME": "rose-r2-archive-legacy",
                     "WMH_LEGACY_MODEL_NAME": "rose-r2-archive-anthropic",
                     "REMOTE_UV_PYTHON": str(scratch / "uv-python"), "CALLS": str(calls),
                     "LEGACY_PULL": legacy_mode, "DF_AVAIL": str(free),
                     # Published sizes: legacy ~4.6 GB, native ~19 GB.
                     "BYTES_rose_r2_archive_legacy": str(4600 * 10**6),
                     "BYTES_rose_archive_serving": str(19 * 10**9)},
                )
                self.assertEqual(result.returncode == 0, ok, result.stdout + result.stderr)
                self.assertEqual("::WMH-REFRESH-DONE::" in result.stdout, ok)
                cache_calls = [json.loads(line) for line in calls.read_text().splitlines()]
                cache_calls = [call for call in cache_calls if "benchmarks.wmh_build_cache" in call]
                self.assertEqual(cache_calls, [[arg.format(world=world, native=native) for arg in call]
                                               for call in expected])
                if not ok and "no-room" in case:
                    self.assertIn("insufficient donor disk for WMH cache", result.stderr)
                # No staging residue survives any outcome.
                self.assertEqual(sorted(path.name for path in scratch.iterdir() if path.name.startswith("world-model")),
                                 [name for name in ("world-model", "world-model-native")
                                  if (scratch / name).exists()])
                legacy_model = world / "models/rose-r2-archive-anthropic/model.json"
                if legacy_after is None:
                    # A failed legacy restore leaves the donor's directory exactly as it was.
                    after = sorted(str(path.relative_to(scratch)) for path in scratch.rglob("*") if "world-model" in str(path))
                    self.assertEqual(after, before)
                else:
                    self.assertEqual(legacy_model.read_text(), legacy_after)
                    self.assertFalse((world / "models/rose-archive").exists())
                if ok:
                    self.assertEqual((native / "models/rose-archive/experiential.json").read_text(), "native")

    def test_refresh_republishes_only_the_donors_current_dependency_proof(self):
        # 2026-10-19: --refresh-wmh republished this checkout's local receipt.
        # The donor volume holds whichever trees the newest refresh installed
        # (any devbox; the app env lock is per clone), so the cut snapshot may
        # only be published under the newest donor proof's fingerprints.
        refresh = source[source.index('if [ "$MODE" = "refresh-wmh" ]; then'):source.index("# MODE: --build-wmh")]
        self.assertNotIn("WARM_DEPS_STATE_FILE\" 2>/dev/null", refresh)
        self.assertNotRegex(refresh, r"read -r RECORDED_NODE_FP[^\n]*\n[^\n]*< \"\$WARM_DEPS_STATE_FILE\"")
        self.assertLess(refresh.index("WMH_DONOR_PROOF=\"$(wmh_refresh_donor_proof)\""),
                        refresh.index('prepare_warm_source "$mid"'))
        recheck = refresh.index("WMH_DONOR_PROOF_AFTER=\"$(wmh_refresh_donor_proof)\"")
        self.assertLess(refresh.index('stop_machine_strict "$mid"'), recheck)
        self.assertLess(recheck, refresh.index('create_volume_snapshot_exact "$VOL_ID"'))
        helper = (root / "scripts/lib/cloudbench-env.sh").read_text()
        latest = re.search(r"^cloudbench_warm_deps_latest_proof\(\) \{.*?^\}\n", helper, re.M | re.S).group(0)
        proof_fn = re.search(r"^    # Begin WMH donor dependency proof\.\n.*?^    # End WMH donor dependency proof\.\n",
                             refresh, re.M | re.S).group(0)
        a, b, c = "a" * 64, "b" * 64, "c" * 64
        def donor(metadata, volume="vol_donor"):
            return [{"id": "m1", "name": "cloudbench-warm",
                     "config": {"mounts": [{"volume": volume}], "metadata": metadata}},
                    {"id": "other", "config": {"mounts": [{"volume": "vol_x"}],
                                               "metadata": {"rose_cloudbench_deps_z": f"{c} {c} 9999999999 vs_z vol_x other app"}}}]
        stale = {"rose_cloudbench_deps_1": f"{a} {b} 100 vs_old vol_donor m1 app",
                 "rose_cloudbench_deps_2": f"{c} {b} 200 vs_new vol_donor m1 app",
                 "rose_cloudbench_deps_3": "probe same-session 0 diagnostic vol_donor m1 app",
                 "rose_cloudbench_deps_4": f"{a} {a} 900 vs_foreign vol_elsewhere m1 app",
                 "unrelated": "x"}
        def proof(inventory):
            script = latest + proof_fn + 'FLY() { printf "%s" "$INVENTORY"; }\nmaintenance_mid=m1 APP=app wmh_refresh_donor_proof'
            return subprocess.run(["bash", "-c", script], env={"PATH": os.environ["PATH"],
                                  "INVENTORY": json.dumps(inventory)}, text=True, capture_output=True)
        newest = proof(donor(stale))
        self.assertEqual(newest.returncode, 0, newest.stderr)
        # The newest proof bound to this donor+volume wins over an older local receipt.
        self.assertEqual(newest.stdout.split(), [c, b, "200", "vs_new", "vol_donor"])
        self.assertNotEqual(proof(donor({"rose_cloudbench_deps_3": stale["rose_cloudbench_deps_3"]})).returncode, 0)
        self.assertNotEqual(proof(donor(stale, volume="")).returncode, 0)
        self.assertNotEqual(proof([]).returncode, 0)

    def test_guest_guard_requires_the_native_pointer_and_pre_created_venv(self):
        run_script = (root / "scripts/cloudbench-run.sh").read_text()
        guard = re.search(r"^# Begin cached WMH guard\.\n.*?^# End cached WMH guard\.\n", run_script, re.M | re.S).group(0)
        requirements = (root / "agents/requirements-world-model.txt").read_bytes()
        with tempfile.TemporaryDirectory(prefix="wmh-guest-guard-") as temporary:
            scratch = Path(temporary)
            repo, world, venv = scratch / "repo", scratch / "world-model", scratch / "venv"
            (repo / "agents").mkdir(parents=True)
            (repo / "agents/requirements-world-model.txt").write_bytes(requirements)
            values = {"REPO_DIR": str(repo), "WMH_DIR": str(world), "WMH_NATIVE_VENV": str(venv),
                      "WMH_MODEL_NAME": "rose-archive", "WMH_ENGINE": "experiential"}
            def check():
                outcome = subprocess.run(["bash", "-c", guard + "cloudbench_cached_wmh_problem"],
                                         env={"PATH": os.environ["PATH"], **values}, text=True, capture_output=True)
                return outcome.returncode, outcome.stdout
            self.assertIn("no cached WMH model", check()[1])
            (world / "models/rose-archive").mkdir(parents=True)
            (world / "build.manifest.json").write_text("{}")
            self.assertIn("models/rose-archive/experiential.json", check()[1])
            values["WMH_ENGINE"] = "legacy"
            self.assertEqual(check(), (0, ""))
            values["WMH_ENGINE"] = "experiential"
            (world / "models/rose-archive/experiential.json").write_text("{}")
            self.assertIn("native WMH venv is absent", check()[1])
            (venv / "bin").mkdir(parents=True)
            (venv / "bin/python").symlink_to(sys.executable)
            self.assertIn("does not match", check()[1])
            (venv / "requirements.sha256").write_text(hashlib.sha256(requirements).hexdigest() + "\n")
            self.assertEqual(check(), (0, ""))
            (repo / "agents/requirements-world-model.txt").write_bytes(requirements + b"\nchanged==1\n")
            self.assertIn("does not match", check()[1])
        self.assertNotRegex(guard, r"\buv\b|pip install")

    def test_guest_stack_receives_native_serving_settings(self):
        run_script = (root / "scripts/cloudbench-run.sh").read_text()
        selection = re.search(r"^# Begin WMH selection\.\n.*?^# End WMH selection\.\n", run_script, re.M | re.S).group(0)
        stack = run_script[run_script.index("STACK_ENV=(\n"):run_script.index('if [ -n "$BENCHMARK_FAST_MODE_CACHE" ]; then\n    STACK_ENV')]
        def stack_env(values):
            outcome = subprocess.run(["bash", "-c", selection + stack + 'printf "%s\\n" "${STACK_ENV[@]}"'],
                                     env={"PATH": os.environ["PATH"], "REPO_DIR": "/data/repo", "DATA_DIR": "/data",
                                          "WMH_DIR": "/data/world-model", **values}, text=True, capture_output=True)
            self.assertEqual(outcome.returncode, 0, outcome.stderr)
            return dict(line.split("=", 1) for line in outcome.stdout.splitlines() if "=" in line)
        native = stack_env({})
        self.assertEqual({key: native.get(key) for key in (
            "WMH_ENGINE", "WMH_MODEL_NAME", "WMH_ROSE_POOL", "WMH_EXECUTION_POLICY", "WMH_BUILD_DIR",
            "BENCHMARK_SKIP_WMH_DELTA", "WMH_NATIVE_PYTHON")}, {
            "WMH_ENGINE": "experiential", "WMH_MODEL_NAME": "rose-archive", "WMH_ROSE_POOL": "rose-wmh-gpt61",
            "WMH_EXECUTION_POLICY": "rose-outcome-distribution-v4", "WMH_BUILD_DIR": "/data/world-model-native",
            "BENCHMARK_SKIP_WMH_DELTA": "1", "WMH_NATIVE_PYTHON": "/data/repo/.context/experiential-venv/bin/python"})
        self.assertNotIn("WMH_CONTEXT_TOKENS", native)
        # Native inference matches the validated local instantiate-whm runs.
        self.assertEqual({key: native.get(key) for key in (
            "WMH_INFERENCE_POOL", "WMH_AZURE_FIRST", "WMH_EXCLUDE_FAILED_TOOL_EXAMPLES", "WMH_JSON_MODE")}, {
            "WMH_INFERENCE_POOL": "rose-1-flash", "WMH_AZURE_FIRST": "1",
            "WMH_EXCLUDE_FAILED_TOOL_EXAMPLES": "1", "WMH_JSON_MODE": "1"})
        handed = stack_env({"WMH_ENGINE": "experiential", "WMH_MODEL_NAME": "custom", "WMH_ROSE_POOL": "rose-1-mini",
                            "WMH_EXECUTION_POLICY": "upstream", "WMH_CONTEXT_TOKENS": "131072"})
        self.assertEqual((handed["WMH_MODEL_NAME"], handed["WMH_ROSE_POOL"], handed["WMH_EXECUTION_POLICY"],
                          handed["WMH_CONTEXT_TOKENS"]), ("custom", "rose-1-mini", "upstream", "131072"))
        legacy = stack_env({"WMH_ENGINE": "legacy"})
        self.assertEqual((legacy["WMH_MODEL_NAME"], legacy["WMH_ROSE_POOL"], legacy["WMH_EXECUTION_POLICY"]),
                         ("rose-r2-archive-anthropic", "rose-1-ultra", "upstream"))
        # Engines serve separate donor directories (the legacy one is what
        # other workspaces' guests serve); an explicit directory still wins.
        self.assertEqual(legacy["WMH_BUILD_DIR"], "/data/world-model")
        self.assertEqual(stack_env({"CLOUDBENCH_WMH_DIR": "/data/world-model"})["WMH_BUILD_DIR"], "/data/world-model")
        # The isolated fleet launcher must not pin the legacy directory: it did,
        # so native guests read /data/world-model regardless of engine.
        generation = (root / "scripts/cloudbench-isolated-generation.py").read_text()
        self.assertNotIn('os.environ["CLOUDBENCH_WMH_DIR"] =', generation)
        generation_root = {"DATA_DIR": "/data/gen", "WMH_DIR": "/data/gen/world-model"}
        self.assertEqual(stack_env(generation_root)["WMH_BUILD_DIR"], "/data/gen/world-model-native")
        self.assertEqual(stack_env({**generation_root, "WMH_ENGINE": "legacy"})["WMH_BUILD_DIR"], "/data/gen/world-model")
        self.assertNotIn("WMH_NATIVE_PYTHON", legacy)
        self.assertNotIn("WMH_INFERENCE_POOL", legacy)
        rejected = subprocess.run(["bash", "-c", selection], env={"PATH": os.environ["PATH"], "WMH_MODEL_NAME": "a b"},
                                  text=True, capture_output=True)
        self.assertEqual(rejected.returncode, 2)
        # The benchmark runner records the engine that owns each seeded session.
        self.assertIn("export WMH_ENGINE='$WMH_ENGINE'", run_script)
        self.assertIn('--world-model-name "$WMH_MODEL_NAME"', run_script)

    def test_fleet_resolves_the_same_defaults_for_children_workers_and_provenance(self):
        fleet = (root / "scripts/run-bench-fleet").read_text()
        defaults = re.search(r"^# Begin fleet WMH defaults\.\n.*?^# End fleet WMH defaults\.\n", fleet, re.M | re.S).group(0)
        show = 'printf "%s\\n" "$WMH_ENGINE" "$WMH_MODEL_NAME" "$WMH_ROSE_POOL" "$WMH_EXECUTION_POLICY"'
        for values in ({}, {"WMH_ENGINE": "legacy"}, {"WMH_MODEL_NAME": "custom"}):
            with self.subTest(values=values):
                fleet_values = subprocess.run(["bash", "-c", defaults + "bash -c " + repr(show)],
                                              env={"PATH": os.environ["PATH"], **values}, text=True, capture_output=True)
                cloud_values = run(show, {"WMH_ENGINE": "", "WMH_ROSE_POOL": "", **values})
                self.assertEqual(cloud_values.returncode, 0, cloud_values.stderr)
                self.assertEqual(fleet_values.stdout, cloud_values.stdout)
        self.assertNotIn("rose-r2-archive-anthropic\"", fleet.replace('"${WMH_MODEL_NAME:-rose-r2-archive-anthropic}"', ""))
        keys = set(re.findall(r'--config-value "(wmh_[a-z_]+)=', fleet))
        self.assertEqual(keys, {"wmh_model_name", "wmh_engine", "wmh_rose_pool", "wmh_execution_policy"})
        sys.path.insert(0, str(root / "scripts"))
        try:
            import cloudbench_execution_provenance as provenance
        finally:
            sys.path.remove(str(root / "scripts"))
        self.assertTrue(keys <= provenance._CONFIG_SCALAR_KEYS)
        # Autoscaled worker-only clones need the model name for simulated tool calls.
        self.assertIn('echo "export WMH_MODEL_NAME=$(printf \'%q\' "$WMH_MODEL_NAME")"', fleet)
        worker = (root / "scripts/cloudbench-worker.sh").read_text()
        self.assertIn('${WMH_BASE_URL:+${WMH_MODEL_NAME:+WMH_MODEL_NAME="$WMH_MODEL_NAME"}}', worker)

    def test_rose_pool_is_validated_against_the_benchmark_ref(self):
        # A pool that exists only at the requested ref must pass, and one that
        # exists only in this checkout must not.
        check = 'validate_wmh_rose_pool_at_ref "$BENCH_REF" "$WMH_ROSE_POOL"'
        result = run(check, {"BENCH_REF": "HEAD", "WMH_ROSE_POOL": "rose-1-ultra"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(run(check, {"BENCH_REF": "HEAD", "WMH_ROSE_POOL": "unknown-pool"}).returncode, 2)
        with tempfile.TemporaryDirectory(prefix="wmh-pool-ref-") as temporary:
            repo = Path(temporary)
            registry = repo / "agents/providers/rose/pools.py"
            registry.parent.mkdir(parents=True)
            git = lambda *args: subprocess.run(["git", "-C", str(repo), *args], check=True,
                                               capture_output=True, text=True).stdout.strip()
            git("init", "-q")
            git("config", "user.email", "test@example.invalid")
            git("config", "user.name", "test")
            marker = repo / "executed"
            def commit(pool, registry_text=None):
                # Importing this registry would leave a marker; validation must not run it.
                registry.write_text(registry_text or (
                    f"open({str(marker)!r}, 'w').close()\n"
                    f"POOL_REGISTRY: dict = {{{pool!r}: object()}}\n"
                ))
                git("add", "-A")
                git("commit", "-qm", pool)
                return git("rev-parse", "HEAD")
            older = commit("ref-only-pool")
            commit("checkout-only-pool")
            for ref, pool, code in ((older, "ref-only-pool", 0), (older, "checkout-only-pool", 2),
                                    ("HEAD", "checkout-only-pool", 0)):
                with self.subTest(ref=ref, pool=pool):
                    outcome = run(check, {"ROOT_DIR": str(repo), "BENCH_REF": ref, "WMH_ROSE_POOL": pool})
                    self.assertEqual(outcome.returncode, code, outcome.stderr)
            self.assertFalse(marker.exists(), "the selected ref's registry code must not execute")
            # A registry that is not a literal dict of names cannot be validated as data.
            computed = commit("computed", "POOL_REGISTRY = dict(computed=1)\n")
            self.assertEqual(run(check, {"ROOT_DIR": str(repo), "BENCH_REF": computed,
                                         "WMH_ROSE_POOL": "computed"}).returncode, 2)
            # Only a commit this controller has not fetched skips the check.
            missing = run(check, {"ROOT_DIR": str(repo), "BENCH_REF": "0" * 40,
                                  "WMH_ROSE_POOL": "ref-only-pool"})
            self.assertEqual(missing.returncode, 0, missing.stderr)
            self.assertIn("is not available locally", missing.stderr)
            for ref in ("--output=/dev/null", "HEAD:agents"):
                with self.subTest(unsafe_ref=ref):
                    self.assertEqual(run(check, {"ROOT_DIR": str(repo), "BENCH_REF": ref,
                                                 "WMH_ROSE_POOL": "ref-only-pool"}).returncode, 0)
            # A present commit without the registry fails closed.
            registry.unlink()
            git("add", "-A")
            git("commit", "-qm", "drop registry")
            self.assertEqual(run(check, {"ROOT_DIR": str(repo), "BENCH_REF": "HEAD",
                                         "WMH_ROSE_POOL": "checkout-only-pool"}).returncode, 2)

    def test_execution_policy_allowlist_admits_every_registered_policy(self):
        # The cloud launch must accept each immutable registered policy and
        # nothing else; a stale allowlist rejects a reviewed local policy.
        import runpy
        sys.path.insert(0, str(root / "agents"))
        try:
            policies = runpy.run_path(str(root / "agents/benchmarks/wmh_execution_policy.py"))["_POLICIES"]
        finally:
            sys.path.remove(str(root / "agents"))
        self.assertIn("rose-outcome-distribution-v2", policies)
        for name in policies:
            with self.subTest(policy=name):
                result = run(":", {"WMH_ENGINE": "experiential", "WMH_EXECUTION_POLICY": name})
                self.assertEqual(result.returncode, 0, result.stderr)
        unregistered = "rose-outcome-distribution-v999"
        self.assertNotIn(unregistered, policies)
        for name in (unregistered, "upstream;id"):
            with self.subTest(policy=name):
                self.assertEqual(run(":", {"WMH_ENGINE": "experiential", "WMH_EXECUTION_POLICY": name}).returncode, 2)

    def test_setup_uses_linux_hash_and_keeps_runtime_validation(self):
        with tempfile.TemporaryDirectory(prefix="wmh-linux-checksum-") as temporary:
            scratch = Path(temporary)
            repo = scratch / "repo"
            (repo / "scripts").mkdir(parents=True)
            (repo / "agents").mkdir()
            for path in ("scripts/setup-world-model.sh", "agents/requirements-world-model.txt",
                         "agents/vendor/world-model/SOURCES.txt",
                         "agents/vendor/world-model/experiential-0.7.158+rose.bf75987e.elapsed1-py3-none-any.whl"):
                (repo / path).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(root / path, repo / path)
            native = repo / ".context/experiential-venv/bin"
            native.mkdir(parents=True)
            (native / "python").symlink_to(sys.executable)
            binaries = scratch / "bin"
            binaries.mkdir()
            for command in ("dirname", "cut", "cat"):
                (binaries / command).symlink_to(shutil.which(command))
            digest_tool = binaries / "sha256sum"
            digest_tool.write_text("#!" + sys.executable + "\nimport hashlib,sys\nfrom pathlib import Path\n"
                                   "print(hashlib.sha256(Path(sys.argv[-1]).read_bytes()).hexdigest()+'  '+sys.argv[-1])\n")
            digest_tool.chmod(0o755)
            calls = scratch / "uv-calls"
            uv = binaries / "uv"
            uv.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$UV_CALLS"\n')
            uv.chmod(0o755)
            result = subprocess.run(["/bin/bash", str(repo / "scripts/setup-world-model.sh")],
                                    env={"PATH": str(binaries), "UV_CALLS": str(calls)},
                                    text=True, capture_output=True)
            expected = hashlib.sha256((repo / "agents/requirements-world-model.txt").read_bytes()).hexdigest()
            marker = repo / ".context/experiential-venv/requirements.sha256"
            self.assertFalse(marker.exists(), "failed runtime validation must not mark the environment healthy")
            self.assertEqual(len(calls.read_text().splitlines()), 2)
            self.assertNotEqual(result.returncode, 0, "missing pinned native dependency must still fail closed")
            self.assertTrue("Native world model requires Python" in result.stderr
                            or "PackageNotFoundError" in result.stderr, result.stderr)

FAKE_FLY = r'''
import json, os, sys
state_path = os.environ["FLY_STATE"]
state = json.load(open(state_path))
args = sys.argv[1:]
state["calls"].append(args)
def save():
    json.dump(state, open(state_path, "w"))
def value(flag):
    return args[args.index(flag) + 1]
verb = " ".join(args[:2])
if verb in ("machines list", "machine list"):
    print(json.dumps(state["machines"])); save(); sys.exit(0)
if verb in ("volumes list", "volume list"):
    print(json.dumps(state["volumes"])); save(); sys.exit(0)
if verb == "volumes create":
    if state.get("fail") == "volume_create":
        save(); sys.exit(1)
    row = {"id": "vol_build1", "name": args[2], "state": "created", "size_gb": int(value("--size")),
           "snapshot_id": value("--snapshot-id")}
    state["volumes"].append(row); save(); print(json.dumps(row)); sys.exit(0)
if verb == "machine run":
    if os.path.exists(os.environ["LEDGER_PATH"]):
        state["ledger_at_machine_run"] = open(os.environ["LEDGER_PATH"]).read()
    row = {"id": state.get("new_mid", "b0110000000001"), "name": value("--name"), "state": "started",
           "volume": value("--volume").split(":")[0]}
    state["machines"].append(row); save()
    if state.get("fail") == "machine_run_ambiguous":
        sys.exit(1)
    print("Machine ID: " + row["id"]); sys.exit(0)
if verb == "machine destroy":
    state["machines"] = [m for m in state["machines"] if m["id"] != args[-3]]
    save(); sys.exit(0)
if verb == "volumes destroy":
    vid = args[2]
    if any(m.get("volume") == vid for m in state["machines"]):
        save(); sys.exit(1)
    for v in state["volumes"]:
        if v["id"] == vid and not state.get("stuck_volume"):
            v["state"] = "pending_destroy"
    save(); sys.exit(0)
save(); sys.exit(9)
'''

lifecycle = re.search(r"^# Begin WMH build lifecycle\.\n.*?^# End WMH build lifecycle\.\n", source, re.M | re.S)
lifecycle = lifecycle.group(0) if lifecycle else ""
build_mode = source[source.index('if [ "$MODE" = "build-wmh" ]; then'):source.index("# MODE: run (default)")]
DONOR = "d0e0000000000001"

class NativeWorldModelBuild(unittest.TestCase):
    """--build-wmh: owned ephemeral big machine, native build, cache publication, teardown."""

    def fly(self, scratch, **overrides):
        state = {"calls": [], "machines": [{"id": DONOR, "name": "cloudbench-warm", "state": "stopped",
                 "volume": "vol_donor", "config": {"image": "registry.fly.io/bench:warm",
                 "mounts": [{"volume": "vol_donor", "path": "/data"}]}}],
                 "volumes": [{"id": "vol_donor", "name": "cloudbench_data", "state": "created"}]}
        state.update(overrides)
        (scratch / "fly.json").write_text(json.dumps(state))
        (scratch / "fake_fly.py").write_text(FAKE_FLY)
        return scratch / "fly.json"

    def lifecycle(self, scratch, script, values=None, **state):
        self.assertTrue(lifecycle)
        path = self.fly(scratch, **state)
        ledger = scratch / "owned-resources.env"
        prefix = (f'APP=navi-whisper-lux-bench; REGION=iad; REMOTE_REPO=/data/repo; REMOTE_UV_PYTHON=/data/uv-python\n'
                  f'FLY() {{ python3 {scratch / "fake_fly.py"} "$@"; }}\n')
        suffix = (f'\nWMH_BUILD_LEDGER={ledger}; WMH_BUILD_DONOR_MID={DONOR}; WMH_BUILD_DONOR_VOLUME=vol_donor\n'
                  'WMH_BUILD_RELEASE_SLEEP_SECONDS=0; WMH_BUILD_RELEASE_ATTEMPTS=3\n')
        result = run(prefix + lifecycle + suffix + script,
                     {"FLY_STATE": str(path), "LEDGER_PATH": str(ledger), **(values or {})})
        return result, json.loads(path.read_text()), (ledger.read_text() if ledger.exists() else "")

    def test_owned_machine_is_big_sleeps_forever_and_is_released(self):
        with tempfile.TemporaryDirectory(prefix="wmh-build-owned-") as temporary:
            result, fly, ledger = self.lifecycle(Path(temporary), (
                'wmh_build_validate || exit 2\n'
                'wmh_build_create_resources 20261019000000_abcd snap_proven registry.fly.io/bench:warm || exit 1\n'
                'wmh_build_teardown'))
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            create = next(c for c in fly["calls"] if c[:2] == ["volumes", "create"])
            self.assertEqual(create[create.index("--snapshot-id") + 1], "snap_proven")
            self.assertEqual(create[create.index("--size") + 1], "80")
            machine = next(c for c in fly["calls"] if c[:2] == ["machine", "run"])
            self.assertEqual(machine[2], "registry.fly.io/bench:warm")
            self.assertEqual(machine[machine.index("--vm-size") + 1], "performance-8x")
            self.assertEqual(machine[machine.index("--vm-memory") + 1], "65536")
            self.assertEqual(machine[machine.index("--volume") + 1], "vol_build1:/data")
            self.assertEqual(machine[-2:], ["sleep", "infinity"])
            # Exact IDs are durable before the next allocation uses them.
            self.assertIn("volume_id=vol_build1\nmachine_name=wmhb-20261019000000-abcd\n", fly["ledger_at_machine_run"])
            self.assertIn("machine_id=b0110000000001\nmachine_released=destroyed\nvolume_released=pending_destroy\n", ledger)
            self.assertEqual([m["id"] for m in fly["machines"]], [DONOR])
            self.assertEqual({v["id"]: v["state"] for v in fly["volumes"]},
                             {"vol_donor": "created", "vol_build1": "pending_destroy"})
            touched = [c for c in fly["calls"] if c[:2] not in (["machines", "list"], ["volumes", "list"])]
            self.assertFalse([c for c in touched if DONOR in c or "vol_donor" in c])

    def test_shape_overrides_and_minimum_volume(self):
        with tempfile.TemporaryDirectory(prefix="wmh-build-shape-") as temporary:
            values = {"WMH_BUILD_VM_SIZE": "performance-16x", "WMH_BUILD_VM_MEMORY_MB": "131072",
                      "WMH_BUILD_VOLUME_GB": "120"}
            result, fly, _ = self.lifecycle(Path(temporary), (
                'wmh_build_validate || exit 2\nwmh_build_create_resources 1_a snap registry/img || exit 1'), values)
            self.assertEqual(result.returncode, 0, result.stderr)
            machine = next(c for c in fly["calls"] if c[:2] == ["machine", "run"])
            create = next(c for c in fly["calls"] if c[:2] == ["volumes", "create"])
            self.assertEqual((machine[machine.index("--vm-size") + 1], machine[machine.index("--vm-memory") + 1],
                              create[create.index("--size") + 1]), ("performance-16x", "131072", "120"))
            for key, bad in (("WMH_BUILD_VOLUME_GB", "40"), ("WMH_BUILD_VM_MEMORY_MB", "64g"),
                             ("WMH_FULL_CACHE_NAME", "x;id"), ("WMH_EXPORT_CACHE_NAME", "../x"),
                             ("WMH_ENGINE", "legacy")):
                with self.subTest(key=key):
                    rejected, fly, _ = self.lifecycle(Path(temporary), "wmh_build_validate", {key: bad})
                    self.assertEqual(rejected.returncode, 2, rejected.stderr)

    def test_failed_or_ambiguous_creation_is_torn_down_by_exact_name(self):
        with tempfile.TemporaryDirectory(prefix="wmh-build-ambiguous-") as temporary:
            result, fly, ledger = self.lifecycle(Path(temporary), (
                'wmh_build_create_resources 1_a snap registry/img && exit 9\nwmh_build_teardown'),
                fail="machine_run_ambiguous")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual([m["id"] for m in fly["machines"]], [DONOR])
            self.assertIn("machine_id=b0110000000001\n", ledger)
            self.assertIn("volume_released=pending_destroy", ledger)
        with tempfile.TemporaryDirectory(prefix="wmh-build-stuck-") as temporary:
            result, fly, ledger = self.lifecycle(Path(temporary), (
                'wmh_build_create_resources 1_a snap registry/img\nwmh_build_teardown'), stuck_volume=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("NOT proven released", result.stderr)
            self.assertNotIn("volume_released", ledger)

    def test_donor_identity_is_never_adopted_or_destroyed(self):
        with tempfile.TemporaryDirectory(prefix="wmh-build-donor-") as temporary:
            result, fly, ledger = self.lifecycle(Path(temporary), (
                'wmh_build_create_resources 1_a snap registry/img && exit 9\nwmh_build_teardown'), new_mid=DONOR)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn(f"machine_id={DONOR}", ledger)
            self.assertFalse([c for c in fly["calls"] if c[:2] == ["machine", "destroy"] and DONOR in c])
            self.assertIn("refusing to operate on the shared donor", result.stderr)

    def test_mode_tears_down_owned_resources_on_failure_and_signal(self):
        stubs = ('git() { echo 0123456789abcdef0123456789abcdef01234567; }\n'
                 'validate_wmh_rose_pool_at_ref() { :; }; ensure_app() { :; }; verify_app_environment() { :; }\n'
                 f'resolve_machine_id() {{ echo {DONOR}; }}; _machines_json() {{ FLY machines list --json; }}\n'
                 'warm_source_fetch_ref() { echo "fetch $1" >> "$TRACE"; }; ssh_exec() { echo "exec $1" >> "$TRACE"; return 1; }\n')
        for name, ready in (("failure", "return 1"), ("term", "kill -TERM $$; :")):
            with self.subTest(exit=name), tempfile.TemporaryDirectory(prefix="wmh-build-mode-") as temporary:
                scratch = Path(temporary)
                state = scratch / "warm-deps.fp"
                state.write_text("node py 1 snap_proven\n")
                trace = scratch / "trace"
                result, fly, _ = self.lifecycle(scratch, stubs
                    + f'require_machine_ready() {{ echo "ready $1" >> "$TRACE"; {ready}; }}\n'
                    + f'MODE=build-wmh; BENCH_REF=HEAD; ROOT_DIR={scratch}; WARM_DEPS_STATE_FILE={state}\n'
                    + 'WMH_BUILD_LEDGER=""\n' + build_mode, {"TRACE": str(trace)})
                self.assertEqual(result.returncode, 1 if name == "failure" else 143, result.stdout + result.stderr)
                ledger = next((scratch / ".context/wmh-build").glob("*/owned-resources.env")).read_text()
                self.assertIn("machine_released=destroyed", ledger)
                self.assertIn("volume_released=pending_destroy", ledger)
                self.assertEqual([m["id"] for m in fly["machines"]], [DONOR])
                self.assertEqual(trace.read_text().split(), ["ready", "b0110000000001"])

    def test_mode_only_targets_the_owned_machine(self):
        self.assertIn("trap wmh_build_exit EXIT", build_mode)
        self.assertIn("trap 'exit 143' TERM", build_mode)
        self.assertIn("trap 'exit 130' INT", build_mode)
        for forbidden in ("inject_secrets", "prepare_warm_source", "park_warm_source", "start_machine",
                          "stop_machine", "create_volume_snapshot_exact", "machines exec"):
            self.assertNotIn(forbidden, build_mode)
        targets = re.findall(r'\b(?:ssh_exec|ssh_read|warm_source_fetch_ref|require_machine_ready|wmh_build_poll) "\$([A-Z_]+)"',
                             build_mode)
        targets += re.findall(r'--machine "\$([A-Z_]+)"', build_mode)
        self.assertGreaterEqual(len(targets), 6)
        self.assertEqual(set(targets), {"WMH_BUILD_MID"})
        # The documented publication path is the supported CLI, not a hand-built machine.
        for doc in ("CLAUDE.md", ".claude/skills/instantiate-whm/SKILL.md"):
            self.assertIn("bash scripts/run-bench-cloud --build-wmh", (root / doc).read_text())

    def remote(self, scratch, values, python_mode):
        repo, data = scratch / "data/repo", scratch / "data"
        python = repo / "agents/venv/bin/python"
        python.parent.mkdir(parents=True)
        (repo / "scripts").mkdir()
        (repo / "agents/.env").write_text("R2=1\n")
        calls = scratch / "calls.jsonl"
        python.write_text(
            "#!" + sys.executable + "\nimport json,os,sys\nfrom pathlib import Path\nargv=sys.argv[1:]\n"
            "keys=('WMH_BUILD_DIR','WMH_ENGINE','WMH_ROSE_POOL','WMH_EXECUTION_POLICY','WMH_GEPA_BUDGET',"
            "'WMH_MAX_BUNDLES','WMH_CONFORMANCE_EXAMPLES','WMH_REQUIRE_CONFORMANCE','UV_PYTHON_INSTALL_DIR','HOME')\n"
            "open(os.environ['CALLS'],'a').write(json.dumps({'argv':argv,'env':{k:os.environ.get(k) for k in keys}})+'\\n')\n"
            "mode=os.environ['PY_MODE']\n"
            "if 'status' in argv:\n"
            "    if mode=='absent': print('no cache published for '+argv[-1]); sys.exit(1)\n"
            "    if mode=='unreadable': print('Traceback: R2 403'); sys.exit(1)\n"
            "    sys.exit(0)\n"
            "if '-c' in argv:\n"
            "    if mode=='build-fails': sys.exit(5)\n"
            "    root=Path(os.environ.get('WMH_BUILD_DIR') or argv[3]); (root/'models/rose-archive').mkdir(parents=True,exist_ok=True)\n"
            "    (root/'models/rose-archive/experiential.json').write_text('{}'); (root/'build.manifest.json').write_text('{}')\n"
            "if argv[:4]==['-m','pip','install','--quiet']:\n"
            "    uv=Path(sys.argv[0]).parent/'uv'; uv.write_text('#!/bin/sh\\n'); uv.chmod(0o755)\n")
        python.chmod(0o755)
        (repo / "scripts/setup-world-model.sh").write_text(
            "printf '{\"argv\":[\"setup\"],\"env\":{\"UV_PYTHON_INSTALL_DIR\":\"%s\"}}\\n' \"$UV_PYTHON_INSTALL_DIR\" >> \"$CALLS\"\n")
        script = scratch / "wmh-build.sh"
        generated = run(lifecycle + f'\nREMOTE_REPO={repo}; REMOTE_UV_PYTHON={data}/uv-python\n'
                        f'WMH_BUILD_REMOTE_ROOT={data}/wmhb; WMH_BUILD_REMOTE_DIR={data}/wmhb/native; '
                        f'WMH_BUILD_REMOTE_PID={data}/wmh-build.pid\nwmh_build_remote_script', values)
        self.assertEqual(generated.returncode, 0, generated.stderr)
        script.write_text(generated.stdout)
        result = subprocess.run(["bash", "-c", "gosu() { shift; \"$@\"; }; chown() { :; }; rsync() { return 1; }\n"
                                 "source " + str(script)], env={"PATH": os.environ["PATH"], "CALLS": str(calls),
                                 "PY_MODE": python_mode}, text=True, capture_output=True)
        records = [json.loads(line) for line in calls.read_text().splitlines()]
        return result, records, data

    def test_remote_build_pulls_full_cache_builds_and_publishes_both_caches(self):
        values = {"WMH_CACHE_NAME": "serving-custom", "WMH_FULL_CACHE_NAME": "full-custom"}
        for mode in ("published", "absent", "unreadable", "build-fails"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(prefix="wmh-build-remote-") as temporary:
                result, records, data = self.remote(Path(temporary), values, mode)
                ok = mode in ("published", "absent")
                self.assertEqual(result.returncode == 0, ok, result.stdout + result.stderr)
                self.assertEqual("::WMH-BUILD-DONE::" in result.stdout, ok)
                self.assertEqual("::WMH-BUILD-FAILED::" in result.stdout, not ok)
                built = str(data / "wmhb/native")
                argvs = [r["argv"] for r in records]
                self.assertEqual(argvs[0], ["-m", "pip", "install", "--quiet", "uv"])
                self.assertEqual(records[1], {"argv": ["setup"], "env": {"UV_PYTHON_INSTALL_DIR": str(data / "uv-python")}})
                cache = ["-u", "-m", "benchmarks.wmh_build_cache"]
                self.assertEqual(argvs[2], cache + ["status", "--name", "full-custom"])
                pulled = cache + ["pull", "--build-dir", built, "--name", "full-custom", "--force"]
                self.assertEqual(pulled in argvs, mode in ("published", "build-fails"))
                pushes = [a for a in argvs if a[3:4] == ["push"]]
                if not ok:
                    self.assertEqual(pushes, [])
                    continue
                update = next(r for r in records if "-c" in r["argv"])
                self.assertIn("update_world_model_for_simulation", update["argv"][2])
                self.assertEqual({k: update["env"][k] for k in ("WMH_BUILD_DIR", "WMH_ENGINE", "WMH_GEPA_BUDGET",
                                 "WMH_MAX_BUNDLES", "WMH_CONFORMANCE_EXAMPLES", "WMH_REQUIRE_CONFORMANCE",
                                 "UV_PYTHON_INSTALL_DIR", "HOME")},
                                 {"WMH_BUILD_DIR": built, "WMH_ENGINE": "experiential", "WMH_GEPA_BUDGET": "0",
                                  "WMH_MAX_BUNDLES": "0", "WMH_CONFORMANCE_EXAMPLES": "100",
                                  "WMH_REQUIRE_CONFORMANCE": "1", "UV_PYTHON_INSTALL_DIR": str(data / "uv-python"),
                                  "HOME": "/home/rose"})
                self.assertEqual(pushes, [cache + ["push", "--serving-only", "--build-dir", built, "--name", "serving-custom"],
                                          cache + ["push", "--build-dir", built, "--name", "full-custom"]])

    def test_remote_export_cache_runs_only_the_native_step(self):
        with tempfile.TemporaryDirectory(prefix="wmh-build-export-") as temporary:
            result, records, data = self.remote(Path(temporary), {"WMH_EXPORT_CACHE_NAME": "rose-archive-export",
                                                                  "WMH_ROSE_POOL": ""}, "published")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            built = str(data / "wmhb/native")
            argvs = [r["argv"] for r in records]
            cache = ["-u", "-m", "benchmarks.wmh_build_cache"]
            self.assertEqual(argvs[2], cache + ["pull", "--build-dir", built, "--name", "rose-archive-export", "--force"])
            native = records[3]
            self.assertIn("build_native", native["argv"][2])
            self.assertNotIn("update_world_model_for_simulation", native["argv"][2])
            self.assertEqual(native["argv"][3:], [built, "rose-archive", "rose-wmh-gpt61"])
            self.assertEqual((native["env"]["WMH_ENGINE"], native["env"]["WMH_ROSE_POOL"],
                              native["env"]["WMH_EXECUTION_POLICY"]),
                             ("experiential", "rose-wmh-gpt61", "rose-outcome-distribution-v4"))
            self.assertEqual(argvs[4:], [cache + ["push", "--serving-only", "--build-dir", built, "--name", "rose-archive-serving"],
                                         cache + ["push", "--build-dir", built, "--name", "rose-archive-native"]])

    def test_poll_reports_progress_completion_failure_death_and_timeout(self):
        cases = {
            "done": (["[wmh-build] step one", "::WMH-LOG-END:: 1 alive", "[wmh-build] step one\n[wmh-build] push\n::WMH-BUILD-DONE::\n::WMH-LOG-END:: 3 dead"], 0, "push"),
            "failed": (["boom\n::WMH-BUILD-FAILED:: rc=5\n::WMH-LOG-END:: 2 dead"], 1, "on-box WMH build failed"),
            "died": (["partial\n::WMH-LOG-END:: 1 dead"] * 3, 1, "without a completion marker"),
            "timeout": (["::WMH-LOG-END:: 0 alive"] * 50, 1, "timed out"),
        }
        for name, (responses, rc, text) in cases.items():
            with self.subTest(case=name), tempfile.TemporaryDirectory(prefix="wmh-build-poll-") as temporary:
                scratch = Path(temporary)
                for index, response in enumerate(responses):
                    (scratch / str(index)).write_text(response)
                fake = ('ssh_read() { local n; n=$(cat "$S/n" 2>/dev/null || echo 0); echo $((n + 1)) > "$S/n"; '
                        '[ "$1" = b0110000000001 ] || return 1; cat "$S/$n"; }\nmachine_state() { echo started; }\n')
                values = {"S": str(scratch), "WMH_BUILD_POLL_SECONDS": "0.05" if name == "timeout" else "0",
                          "WMH_BUILD_TIMEOUT_SECONDS": "1" if name == "timeout" else "60"}
                result = run(lifecycle + fake + "wmh_build_poll b0110000000001", values)
                self.assertEqual(result.returncode, rc, result.stdout + result.stderr)
                self.assertIn(text, result.stdout + result.stderr)

unittest.main(argv=[sys.argv[0]], verbosity=1)
PY

agents_env="$TMP_ROOT/agents.env"
backend_env="$TMP_ROOT/backend.env"
printf 'BROWSER_PROVIDER=browserbase\nSECRET=value-one\n' > "$agents_env"
printf 'BROWSER_PROVIDER=browserbase\nSECRET=value-two\n' > "$backend_env"

if cloudbench_validate_browser_provider_contract "$agents_env" "$backend_env" kernel kernel >/dev/null 2>&1; then
  fail "stale browserbase config must not pass a production kernel contract"
fi

sed -i.bak 's/browserbase/kernel/' "$agents_env" "$backend_env"
rm -f "$agents_env.bak" "$backend_env.bak"
cloudbench_validate_browser_provider_contract "$agents_env" "$backend_env" kernel kernel >/dev/null

# Tilion contract: accepted only when the guest backend env carries its key,
# which reaches guests inside BACKEND_ENV_B64 exactly like KERNEL_API_KEY.
sed -i.bak 's/^BROWSER_PROVIDER=kernel$/BROWSER_PROVIDER=tilion/' "$agents_env" "$backend_env"
rm -f "$agents_env.bak" "$backend_env.bak"
if tilion_out="$(cloudbench_validate_browser_provider_contract "$agents_env" "$backend_env" tilion tilion 2>&1)"; then
  fail "a tilion contract without TILION_API_KEY must fail closed"
fi
case "$tilion_out" in *"no TILION_API_KEY"*) ;; *) fail "missing-key failure must name TILION_API_KEY: $tilion_out" ;; esac
printf 'TILION_API_KEY=tl_fake_contract_key\n' >> "$backend_env"
tilion_out="$(cloudbench_validate_browser_provider_contract "$agents_env" "$backend_env" tilion tilion)"
case "$tilion_out" in *tl_fake_contract_key*) fail "contract output printed TILION_API_KEY" ;; esac
if cloudbench_validate_browser_provider_contract "$agents_env" "$backend_env" tilion kernel >/dev/null 2>&1; then
  fail "worker env must match its own production fallback"
fi
sed -i.bak -e 's/^BROWSER_PROVIDER=tilion$/BROWSER_PROVIDER=kernel/' -e '/^TILION_API_KEY=/d' "$agents_env" "$backend_env"
rm -f "$agents_env.bak" "$backend_env.bak"
cloudbench_validate_browser_provider_contract "$agents_env" "$backend_env" kernel kernel >/dev/null

python3 "$ROOT_DIR/scripts/tests/cloudbench-provider-contract.test.py" || fail "per-surface provider contract regression"

agents_digest="$(cloudbench_env_sha256 "$agents_env")"
backend_digest="$(cloudbench_env_sha256 "$backend_env")"
[ "${#agents_digest}" -eq 64 ] || fail "agents env digest must be sha256"
[ "${#backend_digest}" -eq 64 ] || fail "backend env digest must be sha256"
cloudbench_verify_env_file "$agents_env" "$agents_digest" agents >/dev/null
if cloudbench_verify_env_file "$agents_env" "$backend_digest" agents >/dev/null 2>&1; then
  fail "a mismatched injected env digest must fail closed"
fi

# Stale BACKEND_ENV_B64 without AgentCard Organization OAuth must fail closed
# before guests burn a full stack on 502 Missing AGENTCARD_ORG_OAUTH_CLIENT_ID.
if cloudbench_require_agentcard_org_oauth "$backend_env" >/dev/null 2>&1; then
  fail "backend env without AgentCard org OAuth must fail closed"
fi
printf 'AGENTCARD_ORG_OAUTH_CLIENT_ID=01234567890123456789\nAGENTCARD_ORG_OAUTH_CLIENT_SECRET=abcdefghijklmnopqrstuvwxyz012345\n' >> "$backend_env"
cloudbench_require_agentcard_org_oauth "$backend_env" >/dev/null
require_text "$ROOT_DIR/scripts/cloudbench-run.sh" \
  'cloudbench_require_agentcard_org_oauth "$REPO_DIR/back-end/.env"' \
  "cloudbench-run must require AgentCard org OAuth after decoding BACKEND_ENV_B64"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'cloudbench_require_agentcard_org_oauth back-end/.env' \
  "run-bench-cloud must refuse to stage a BACKEND_ENV_B64 without AgentCard org OAuth"

# Guests restore their own DB, so a guest-local lease store gives each copy its
# own semaphore on the same real token (proof 2: ~80 live leases against the
# shared capacity of 16, 429 burst). The decoded guest back-end/.env must point
# compute-token requests at the single production authority.
authority_env="$TMP_ROOT/authority-backend.env"
printf 'BACKEND_API_KEY=guest-internal-key-0123456789\nOTHER=1' > "$authority_env"
cloudbench_apply_compute_token_authority "$authority_env" >/dev/null ||
  fail "a guest backend env with BACKEND_API_KEY must gain the compute-token authority"
[ "$(cloudbench_env_value "$authority_env" COMPUTE_TOKEN_AUTHORITY_URL)" = https://navi-j9a9.onrender.com ] ||
  fail "guests must default to the production compute-token authority"
[ "$(cloudbench_env_value "$authority_env" COMPUTE_TOKEN_AUTHORITY_API_KEY)" = guest-internal-key-0123456789 ] ||
  fail "the authority must be authenticated with the guest's internal BACKEND_API_KEY"
[ "$(cloudbench_env_value "$authority_env" OTHER)" = 1 ] ||
  fail "appending the authority must not corrupt an unterminated last line"
cloudbench_apply_compute_token_authority "$authority_env" >/dev/null
[ "$(grep -c '^COMPUTE_TOKEN_AUTHORITY_URL=' "$authority_env")" = 1 ] ||
  fail "an env file that already names an authority must be left unchanged"
printf 'BACKEND_API_KEY=k\n' > "$authority_env"
CLOUDBENCH_COMPUTE_TOKEN_AUTHORITY_URL=off cloudbench_apply_compute_token_authority "$authority_env" >/dev/null
[ -z "$(cloudbench_env_value "$authority_env" COMPUTE_TOKEN_AUTHORITY_URL)" ] ||
  fail "CLOUDBENCH_COMPUTE_TOKEN_AUTHORITY_URL=off must keep guest-local leases"
if CLOUDBENCH_COMPUTE_TOKEN_AUTHORITY_URL=http://example.test cloudbench_apply_compute_token_authority "$authority_env" >/dev/null 2>&1; then
  fail "a non-https compute-token authority must fail closed"
fi
printf 'OTHER=1\n' > "$authority_env"
if cloudbench_apply_compute_token_authority "$authority_env" >/dev/null 2>&1; then
  fail "a guest backend env without BACKEND_API_KEY must fail closed"
fi
require_text "$ROOT_DIR/scripts/cloudbench-run.sh" \
  'cloudbench_apply_compute_token_authority "$REPO_DIR/back-end/.env"' \
  "cloudbench-run must point the guest backend at the shared compute-token authority"

retry_attempts=0
fail_twice_then_succeed() {
  retry_attempts=$((retry_attempts + 1))
  [ "$retry_attempts" -ge 3 ]
}
cloudbench_retry_command 3 0 fail_twice_then_succeed >/dev/null 2>&1 ||
  fail "a transient command must succeed within its retry budget"
[ "$retry_attempts" -eq 3 ] || fail "a transient command must be retried exactly to success"

retry_attempts=0
always_fail() {
  retry_attempts=$((retry_attempts + 1))
  return 9
}
if cloudbench_retry_command 3 0 always_fail >/dev/null 2>&1; then
  fail "a permanently failing command must fail closed"
fi
[ "$retry_attempts" -eq 3 ] || fail "a permanent failure must exhaust its retry budget"

# A completed child must not leave cleanup waiting on a cancel-resistant timer.
# The old `(sleep 30; kill -KILL ...) &` watchdog blocked for its full duration
# under macOS Bash 3.2 even after the controller tried to cancel it.
termination_ready="$TMP_ROOT/termination-ready"
perl -e '$SIG{TERM}=sub{exit 0}; open my $fh, ">", $ARGV[0] or die $!; close $fh; sleep 30' "$termination_ready" &
terminating_pid=$!
for _ in $(seq 1 100); do
  [ -e "$termination_ready" ] && break
  sleep 0.01
done
[ -e "$termination_ready" ] || fail "the termination test child must become ready"
termination_start="$SECONDS"
cloudbench_terminate_and_wait 5 "$terminating_pid" ""
termination_elapsed=$((SECONDS - termination_start))
[ "$termination_elapsed" -lt 20 ] ||
  fail "a TERM-responsive child waited like the removed 30s watchdog (elapsed=${termination_elapsed}s)"
if kill -0 "$terminating_pid" 2>/dev/null; then
  fail "the terminated child must not survive cleanup"
fi
termination_start="$SECONDS"
cloudbench_terminate_and_wait 5 ""
termination_elapsed=$((SECONDS - termination_start))
[ "$termination_elapsed" -lt 2 ] ||
  fail "an empty PID list must return immediately (elapsed=${termination_elapsed}s)"

# A durable supervisor waits on an identity-fenced detached process rather than
# pulling that process back into its vulnerable launcher session. Preserve exact
# nonzero status (including the poller's typed capacity-busy code), forward
# cooperative cancellation, and fail promptly when a wrapper exits without the
# promised status marker.
tracked_owner="$TMP_ROOT/tracked.owner"
tracked_status="$TMP_ROOT/tracked.status"
tracked_log="$TMP_ROOT/tracked.log"
cloudbench_detach_reexec_tracked "$tracked_owner" "$tracked_log" \
  bash -c 'printf "75\n" > "$1"; exit 75' tracked-exit "$tracked_status"
tracked_rc=0
cloudbench_wait_tracked_detached "$tracked_owner" "$tracked_status" || tracked_rc=$?
[ "$tracked_rc" -eq "$CLOUDBENCH_CAPACITY_BUSY_EXIT_CODE" ] ||
  fail "detached rendezvous changed capacity-busy exit 75 to $tracked_rc"

missing_owner="$TMP_ROOT/missing.owner"
missing_status="$TMP_ROOT/missing.status"
missing_recovered="$TMP_ROOT/missing.recovered"
cloudbench_detach_reexec_tracked "$missing_owner" "$TMP_ROOT/missing.log" \
  bash -c 'exit 0'
missing_started="$SECONDS"
missing_rc=0
cloudbench_wait_tracked_detached "$missing_owner" "$missing_status" \
  bash -c ': > "$1"' tracked-recovery "$missing_recovered" \
  >/dev/null 2>&1 || missing_rc=$?
[ "$missing_rc" -eq 1 ] ||
  fail "a detached wrapper without status must fail closed (exit=$missing_rc)"
[ -e "$missing_recovered" ] ||
  fail "a dead detached wrapper must invoke durable ownership recovery"
[ $((SECONDS - missing_started)) -lt 10 ] ||
  fail "a detached wrapper without status caused an unbounded wait"

cancel_owner="$TMP_ROOT/cancel.owner"
cancel_status="$TMP_ROOT/cancel.status"
cancel_recovered="$TMP_ROOT/cancel.recovered"
cloudbench_detach_reexec_tracked "$cancel_owner" "$TMP_ROOT/cancel.log" \
  bash -c '
    status_file="$1"
    status=1
    trap '"'"'printf "%s\n" "$status" > "$status_file"'"'"' EXIT
    trap '"'"'status=143; exit 143'"'"' TERM
    sleep 30
    status=0
  ' tracked-cancel "$cancel_status"
( sleep 1; kill -TERM "$$" ) &
cancel_signal_pid=$!
cancel_started="$SECONDS"
cancel_rc=0
cloudbench_wait_tracked_detached "$cancel_owner" "$cancel_status" \
  bash -c ': > "$1"' tracked-recovery "$cancel_recovered" \
  >/dev/null 2>&1 || cancel_rc=$?
wait "$cancel_signal_pid" 2>/dev/null || true
[ "$cancel_rc" -eq 143 ] ||
  fail "detached rendezvous did not preserve forwarded TERM status (exit=$cancel_rc)"
[ -e "$cancel_recovered" ] ||
  fail "forwarded detached cancellation must invoke durable ownership recovery"
[ $((SECONDS - cancel_started)) -lt 10 ] ||
  fail "forwarded TERM did not stop the detached process group promptly"

# A wrapper may publish its cooperative 143 while a TERM-resistant descendant
# remains in the owned group. The marker must not let the waiter return early:
# escalation and group drain remain part of the cancellation contract.
lingering_owner="$TMP_ROOT/lingering.owner"
lingering_status="$TMP_ROOT/lingering.status"
lingering_child_pid_file="$TMP_ROOT/lingering-child.pid"
cloudbench_detach_reexec_tracked "$lingering_owner" "$TMP_ROOT/lingering.log" \
  bash -c '
    status_file="$1"
    child_pid_file="$2"
    status=1
    trap '"'"'printf "%s\n" "$status" > "$status_file"'"'"' EXIT
    trap '"'"'status=143; exit 143'"'"' TERM
    (
      trap "" TERM
      printf "%s\n" "${BASHPID:-$$}" > "$child_pid_file"
      sleep 30
    ) &
    wait
  ' tracked-lingering "$lingering_status" "$lingering_child_pid_file"
for _ in $(seq 1 100); do
  [ -s "$lingering_child_pid_file" ] && break
  sleep 0.01
done
[ -s "$lingering_child_pid_file" ] ||
  fail "the TERM-resistant detached descendant must become ready"
lingering_child_pid="$(head -1 "$lingering_child_pid_file")"
( sleep 1; kill -TERM "$$" ) &
lingering_signal_pid=$!
lingering_started="$SECONDS"
lingering_rc=0
CLOUDBENCH_DETACHED_RECOVERY_SECONDS=2 \
  cloudbench_wait_tracked_detached "$lingering_owner" "$lingering_status" \
  bash -c 'exit 0' \
  >/dev/null 2>&1 || lingering_rc=$?
wait "$lingering_signal_pid" 2>/dev/null || true
[ "$lingering_rc" -eq 143 ] ||
  fail "group-drained cancellation changed the wrapper's 143 status (exit=$lingering_rc)"
[ $((SECONDS - lingering_started)) -ge 2 ] ||
  fail "the waiter accepted status 143 before the detached group drained"
[ $((SECONDS - lingering_started)) -lt 10 ] ||
  fail "a lingering TERM-resistant descendant caused an unbounded wait"
if kill -0 "$lingering_child_pid" 2>/dev/null; then
  fail "the TERM-resistant detached descendant survived KILL escalation"
fi

# Cooperative cancellation must also be bounded when every process in the
# detached group ignores TERM. A status marker must not be required for KILL
# escalation, and the waiter must not return until the owned group is drained.
resistant_owner="$TMP_ROOT/resistant.owner"
resistant_status="$TMP_ROOT/resistant.status"
cloudbench_detach_reexec_tracked "$resistant_owner" "$TMP_ROOT/resistant.log" \
  bash -c 'trap "" TERM; sleep 30'
resistant_pgid="$(cloudbench_tracked_owner_value "$resistant_owner" pgid)"
( sleep 1; kill -TERM "$$" ) &
resistant_signal_pid=$!
resistant_started="$SECONDS"
resistant_rc=0
CLOUDBENCH_DETACHED_RECOVERY_SECONDS=2 \
  cloudbench_wait_tracked_detached "$resistant_owner" "$resistant_status" \
  bash -c 'exit 0' \
  >/dev/null 2>&1 || resistant_rc=$?
wait "$resistant_signal_pid" 2>/dev/null || true
[ "$resistant_rc" -eq 1 ] ||
  fail "a TERM-resistant detached group without status must fail closed (exit=$resistant_rc)"
[ $((SECONDS - resistant_started)) -lt 10 ] ||
  fail "a TERM-resistant detached process group caused an unbounded wait"
if cloudbench_process_group_exists "$resistant_pgid"; then
  fail "the TERM-resistant detached process group survived KILL escalation"
fi

# A tracked autoscaler can be blocked inside a nested provider command. Killing
# only its direct shell reparents that descendant, allowing it to mutate durable
# ownership after controller cleanup returns. Tree teardown must kill the full
# captured process forest, including a TERM-resistant leaf.
# Independent assertion helper: zero means the captured descendant is terminal.
cloudbench_test_process_terminal() {  # <pid> <native-birth>
  python3 - "$ROOT_DIR/scripts/process-identity.py" "$1" "$2" <<'PY_TREE_STATE'
import os
import re
import runpy
import subprocess
import sys

identity = runpy.run_path(sys.argv[1])["current_identity"]
pid, expected = int(sys.argv[2]), sys.argv[3]
unknown = object()
def observed_identity():
    try:
        return identity(pid)
    except (OSError, ValueError, IndexError):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return None
        return unknown
try:
    observed = observed_identity()
    if observed is not unknown and observed != expected:
        raise SystemExit(0)
    probe = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True, timeout=5)
    observed = observed_identity()
    if observed is not unknown and observed != expected:
        raise SystemExit(0)
    # Darwin cannot read proc_pidinfo for a zombie. A positive native Z state
    # still proves it cannot execute; live, malformed or unavailable state fails.
    terminal = probe.returncode == 0 and re.fullmatch(r"Z[<NLSsl+]*", probe.stdout.strip())
    raise SystemExit(0 if terminal else 1)
except (OSError, ValueError, IndexError, subprocess.SubprocessError):
    raise SystemExit(1)
PY_TREE_STATE
}

# Keep one exited direct child deliberately unreaped so this predicate control
# does not depend on how quickly the host's PID1 reaps reparented descendants.
# The test parent always joins its exact Popen after checking the native state.
python3 - "$ROOT_DIR" "$(declare -f cloudbench_test_process_terminal)" <<'PY_TREE_TERMINAL' ||
import pathlib
import runpy
import subprocess
import sys
import time

root = pathlib.Path(sys.argv[1])
identity = runpy.run_path(str(root / "scripts/process-identity.py"))["current_identity"]
command = 'ROOT_DIR="$1"\n' + sys.argv[2] + '\ncloudbench_test_process_terminal "$2" "$3"'
child = subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.buffer.read(1)"], stdin=subprocess.PIPE)
try:
    birth = identity(child.pid)
    def verdict():
        return subprocess.run(["bash", "-c", command, "terminal-test", str(root), str(child.pid), birth], timeout=10).returncode
    assert verdict() != 0, "terminal predicate accepted a live exact child"
    child.stdin.write(b"x")
    child.stdin.close()
    deadline = time.monotonic() + 10
    while True:
        state = subprocess.check_output(["ps", "-p", str(child.pid), "-o", "stat="], text=True, timeout=5).strip()
        if state.startswith("Z"):
            break
        assert time.monotonic() < deadline, "owned child never reached native zombie state"
        time.sleep(0.01)
    # This exact Popen is not reaped, so its PID cannot be recycled. Darwin
    # may no longer expose proc_pidinfo once the child reaches native Z.
    assert verdict() == 0, "terminal predicate rejected a non-executing exact zombie"
finally:
    if child.poll() is None:
        child.kill()
    child.wait(timeout=10)
assert verdict() == 0, "terminal predicate rejected its reaped child"
PY_TREE_TERMINAL
  fail "native descendant terminal-state assertion contract failed"

tree_ready="$TMP_ROOT/tree-ready"
tree_leaf_pid="$TMP_ROOT/tree-leaf.pid"
tree_leaked="$TMP_ROOT/tree-leaked"
bash -c '
  trap "exit 0" TERM
  (
    trap "" TERM
    printf "%s\n" "${BASHPID:-$$}" > "$1"
    : > "$2"
    sleep 30
    : > "$3"
  ) &
  wait
' tree-test "$tree_leaf_pid" "$tree_ready" "$tree_leaked" &
tree_root_pid=$!
for _ in $(seq 1 100); do
  [ -e "$tree_ready" ] && break
  sleep 0.01
done
[ -e "$tree_ready" ] || fail "the descendant-tree test child must become ready"
tree_leaf="$(cat "$tree_leaf_pid")"
tree_leaf_birth="$(python3 "$ROOT_DIR/scripts/process-identity.py" "$tree_leaf")" ||
  fail "the descendant-tree test leaf must have a native identity"
if cloudbench_test_process_terminal "$tree_leaf" "$tree_leaf_birth"; then
  cloudbench_terminate_tree_and_wait 1 "$tree_root_pid"
  fail "the terminal assertion accepted an executing exact descendant"
fi
mkdir "$TMP_ROOT/tree-state-probe-fails"
printf '#!/usr/bin/env bash\nexit 2\n' > "$TMP_ROOT/tree-state-probe-fails/ps"
chmod +x "$TMP_ROOT/tree-state-probe-fails/ps"
if PATH="$TMP_ROOT/tree-state-probe-fails:$PATH" \
    cloudbench_test_process_terminal "$tree_leaf" "$tree_leaf_birth"; then
  cloudbench_terminate_tree_and_wait 1 "$tree_root_pid"
  fail "the terminal assertion accepted an unavailable native state probe"
fi
cloudbench_terminate_tree_and_wait 1 "$tree_root_pid"
if kill -0 "$tree_root_pid" 2>/dev/null || \
    ! cloudbench_test_process_terminal "$tree_leaf" "$tree_leaf_birth"; then
  fail "tracked controller descendants must not survive tree cleanup"
fi
[ ! -e "$tree_leaked" ] ||
  fail "an orphaned descendant mutated state after controller cleanup"

# A completed job's numeric PID is stale ownership, even if another process now
# has that PID. The helper must intersect roots with this shell's live job table
# before it ever calls kill.
stale_signal_log="$TMP_ROOT/stale-signals.log"
(
  kill() {
    printf '%s\n' "$*" >> "$stale_signal_log"
  }
  cloudbench_terminate_tree_and_wait 0 999999
)
[ ! -e "$stale_signal_log" ] ||
  fail "tree cleanup signaled a stale root that is not a live shell job"

# A descendant may exit after TERM while a resistant sibling holds the grace
# period open. Deterministically model PID reuse at that boundary: the initial
# snapshot and first identity read name the owned process, then every later read
# reports a different birth identity. Escalation must not SIGKILL the
# replacement. The identity primitives are stubbed (not ps) so the model holds
# on Linux, where births come from /proc, and on macOS, where they come from ps.
identity_signal_log="$TMP_ROOT/identity-signals.log"
identity_ps_count="$TMP_ROOT/identity-ps-count"
printf '0\n' > "$identity_ps_count"
(
  jobs() {
    printf '4242\n'
  }
  cloudbench_process_birth_table() {
    printf '4242 1 birth-test:owned\n'
  }
  identity_read() {
    count="$(cat "$identity_ps_count")"
    count=$((count + 1))
    printf '%s\n' "$count" > "$identity_ps_count"
    if [ "$count" -eq 1 ]; then
      printf 'birth-test:owned\n'
    else
      printf 'birth-test:replacement\n'
    fi
  }
  cloudbench_pid_start_time() { identity_read; }
  cloudbench_pid_start_time_like() { identity_read; }
  cloudbench_pid_observation_like() {
    printf '%s\tS\n' "$(identity_read)"
  }
  kill() {
    printf '%s\n' "$*" >> "$identity_signal_log"
  }
  wait() {
    return 0
  }
  cloudbench_terminate_tree_and_wait 0 4242
)
[ "$(wc -l < "$identity_signal_log" | tr -d ' ')" = "1" ] ||
  fail "tree cleanup signaled a PID after its birth identity changed"
if grep -q -- '-KILL' "$identity_signal_log"; then
  fail "tree cleanup SIGKILLed a reused PID"
fi

# SIGKILL completes asynchronously. With a zero TERM grace, a loaded host can
# still show the exact birth running on the first post-KILL read; teardown must
# re-observe it rather than report a survivor at delivery time.
slow_exit_state="$TMP_ROOT/slow-exit-state"
slow_exit_reads="$TMP_ROOT/slow-exit-reads"
printf 'running\n' > "$slow_exit_state"
printf '0\n' > "$slow_exit_reads"
if ! (
  jobs() {
    printf '4194301\n'
  }
  cloudbench_process_birth_table() {
    printf '4194301 1 birth-test:slow-exit\n'
  }
  cloudbench_pid_start_time() { printf 'birth-test:slow-exit\n'; }
  cloudbench_pid_start_time_like() { printf 'birth-test:slow-exit\n'; }
  cloudbench_pid_observation_like() {
    [ "$(cat "$slow_exit_state")" = killed ] || {
      printf 'birth-test:slow-exit\tS\n'
      return 0
    }
    reads="$(cat "$slow_exit_reads")"
    reads=$((reads + 1))
    printf '%s\n' "$reads" > "$slow_exit_reads"
    [ "$reads" -le 2 ] || return 1
    printf 'birth-test:slow-exit\tR\n'
  }
  kill() {
    case "$1" in
      -KILL) printf 'killed\n' > "$slow_exit_state" ;;
      -0) [ "$(cat "$slow_exit_reads")" -le 2 ] ;;
    esac
  }
  wait() {
    return 0
  }
  cloudbench_terminate_tree_and_wait 0 4194301
) 2> "$TMP_ROOT/slow-exit.err"; then
  cat "$TMP_ROOT/slow-exit.err" >&2
  fail "zero-grace tree cleanup judged a SIGKILLed birth before the kernel finished its exit"
fi
[ "$(cat "$slow_exit_reads")" -gt 2 ] ||
  fail "zero-grace tree cleanup did not re-observe the SIGKILLed birth"

# Exact native zombies must not consume TERM grace; live threads and unknown identities still do.
python3 - "$HELPER_SRC" <<'PY_ZOMBIE_GRACE' || fail "zombie TERM grace controls failed"
import ctypes,json,os,pathlib,signal,subprocess,sys,tempfile,time
HELPER=pathlib.Path(sys.argv[1]).resolve()
if sys.platform!='linux':
 print('SKIP: Linux /proc/subreaper grace control; existing platform teardown tests remain active')
 raise SystemExit(0)
sys.path.insert(0,str(HELPER.parent))
from condition_wait import wait_until
assert ctypes.CDLL(None,use_errno=True).prctl(36,1,0,0,0)==0
ROOT=r'''
import ctypes,json,os,pathlib,platform,signal,sys,threading,time
out=pathlib.Path(sys.argv[1]); mode=sys.argv[2]
sys.path.insert(0,sys.argv[3])
from condition_wait import wait_until
HEARTBEAT_INTERVAL_SECONDS=.02  # Deliberate live-thread writer workload, not synchronization.
if mode in ('thread','globignore'):
 signal.signal(signal.SIGTERM,signal.SIG_IGN)
 def run():
  while True:out.with_suffix('.heartbeat').write_text(str(time.monotonic()));time.sleep(HEARTBEAT_INTERVAL_SECONDS)
 threading.Thread(target=run).start();out.write_text(json.dumps({'root':os.getpid(),'children':[]}))
 number={'x86_64':60,'aarch64':93}.get(platform.machine())
 if number is None:raise RuntimeError('unsupported native thread-exit architecture')
 ctypes.CDLL(None).syscall(number,0)
p=os.fork()
if p==0:os._exit(0)
children=[p]
if mode=='mixed':
 p=os.fork()
 if p==0:
  signal.signal(signal.SIGTERM,signal.SIG_IGN)
  while True:signal.pause()
 children.append(p)
def zombie_ready():
 s=pathlib.Path('/proc',str(children[0]),'stat').read_text();f=s[s.rfind(')')+2:].split()
 return f[0]=='Z'
wait_until(zombie_ready,timeout=5,description='owned child native zombie')
out.write_text(json.dumps({'root':os.getpid(),'children':children}))
while True:signal.pause()
'''
DRIVER=r'''
set -uo pipefail
source "$1"
base="$2"; mode="$3"
python3 "$base/root.py" "$base/ready.json" "$mode" "$(dirname "$1")" &
root=$!
python3 "$base/wait-ready.py" "$base" "$root" "$mode" "$(dirname "$1")" || exit 91
# Fault only the observation API used by the new grace decision and existing
# final verification. Native birth matcher and signal calls are untouched.
if [[ "$mode" = unknown || "$mode" = changed || "$mode" = race ]]; then
 eval "$(declare -f cloudbench_pid_observation_like | sed '1s/cloudbench_pid_observation_like/actual_observation/')"
 printf '0\n' > "$base/reads"
 cloudbench_pid_observation_like() {
  local n value
  n=$(cat "$base/reads");n=$((n+1));printf '%s\n' "$n" > "$base/reads"
  case "$mode" in
   unknown) return 1 ;;
   changed) value="$(actual_observation "$@")"; printf 'proc-start:changed:1\t%s\n' "${value##*$'\t'}" ;;
   race)
    if [ "$n" = 1 ]; then actual_observation "$@"
    elif [ "$n" = 2 ]; then value="$(actual_observation "$@")"; printf '%s\tR\n' "${value%$'\t'*}"
    else actual_observation "$@"; fi ;;
  esac
 }
fi
if [ "$mode" = globignore ]; then
 GLOBIGNORE=""
 for entry in /proc/"$root"/task/*; do
  [ "$entry" = "/proc/$root/task/$root" ] || GLOBIGNORE="${GLOBIGNORE:+$GLOBIGNORE:}$entry"
 done
 export GLOBIGNORE
fi
if [ "$mode" = noglob ]; then set -f; shopt -s failglob; fi
if [ "$mode" = enum_error ]; then
 python3() {
  if [ "$#" = 2 ] && [ "$1" = - ]; then
   printf 'denied\n' >> "$base/enumeration-denied"
   return 1
  fi
  command python3 "$@"
 }
fi
sleep() { if [ "${1:-}" = 1 ]; then printf '1\n' >> "$base/real-grace-sleeps"; fi; command sleep "$@"; }
cloudbench_terminate_tree_and_wait 2 "$root"
'''
READY="import json,pathlib,sys\nsys.path.insert(0,sys.argv[4])\nfrom condition_wait import wait_until\nbase=pathlib.Path(sys.argv[1]);pid=sys.argv[2];mode=sys.argv[3]\ndef ready():\n if not (base/'ready.json').is_file():return False\n if mode not in ('thread','globignore'):return True\n raw=pathlib.Path('/proc',pid,'stat').read_text();f=raw[raw.rfind(')')+2:].split()\n return f[0]=='Z'\nwait_until(ready,timeout=10,description='owned fixture process ready')\n"
results=[]
for mode in ['zombie','mixed','thread','unknown','changed','race','globignore','enum_error','noglob']:
 with tempfile.TemporaryDirectory(prefix='zombie-grace-control-') as temporary:
  base=pathlib.Path(temporary);(base/'root.py').write_text(ROOT);(base/'wait-ready.py').write_text(READY)
  started=time.monotonic();p=subprocess.Popen(['bash','-c',DRIVER,'control',str(HELPER),str(base),mode],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  native=[];identity=None
  try:
   def observe():
    global identity
    ready=base/'ready.json'
    if ready.exists():
     try:identity=json.loads(ready.read_text())
     except ValueError:pass
    if identity:
     for pid in [identity['root'],*identity['children']]:
      try:
       raw=pathlib.Path('/proc',str(pid),'stat').read_text();f=raw[raw.rfind(')')+2:].split()
       row={'pid':pid,'birth':f[19],'state':f[0],'tasks':len(list(pathlib.Path('/proc',str(pid),'task').iterdir()))}
       if row not in native:native.append(row)
      except FileNotFoundError:pass
    return p.poll() is not None
   wait_until(observe,timeout=14,description='owned teardown command returned')
   stdout,stderr=p.communicate(timeout=1);elapsed=time.monotonic()-started
   assert identity
   if mode=='unknown':assert p.returncode==1 and 'unknown after SIGKILL' in stderr,(p.returncode,stderr)
   else:assert p.returncode==0,(mode,p.returncode,stderr)
   sleeps=(base/'real-grace-sleeps').read_text().splitlines() if (base/'real-grace-sleeps').exists() else []
   if mode in ('zombie','noglob'):assert not sleeps,('zombie grace not eliminated',len(sleeps))
   if mode in ('mixed','thread','changed','race','globignore','enum_error'):assert sleeps,('live/changed prematurely accepted',mode)
   if mode in ('thread','globignore'):assert any(r['pid']==identity['root'] and r['state']=='Z' and r['tasks']>1 for r in native),native
   if mode=='enum_error':assert (base/'enumeration-denied').exists()
   # Every descendant belongs to this isolated native subreaper. Join only the
   # exact PIDs published by our own root; never discover/signal foreign work.
   reaped=[]
   for pid in [identity['root'],*identity['children']]:
    try:
     got,status=os.waitpid(pid,os.WNOHANG)
     if got==0:
      os.kill(pid,signal.SIGKILL);got,status=os.waitpid(pid,0)
     reaped.append(got)
    except ChildProcessError:pass
    assert not pathlib.Path('/proc',str(pid)).exists(),('own PID remains',pid)
   results.append({'mode':mode,'exit':p.returncode,'seconds':elapsed,'enumeration_denials':len((base/'enumeration-denied').read_text().splitlines()) if (base/'enumeration-denied').exists() else 0,'real_grace_sleeps':len(sleeps),'native_observations':native,'reaped':reaped,'remaining':[]})
  finally:
   if p.poll() is None:p.kill();p.wait()
   if identity:
    for owned_pid in [identity['root'],*identity['children']]:
     try:
      joined,_=os.waitpid(owned_pid,os.WNOHANG)
      if joined==0:os.kill(owned_pid,signal.SIGKILL);os.waitpid(owned_pid,0)
     except (ChildProcessError,ProcessLookupError):pass
print(json.dumps({'helper':str(HELPER),'controls':results,'all_passed':True},sort_keys=True))
PY_ZOMBIE_GRACE

# A local bind collision is not a remote/DNS readiness failure. The proxy
# launcher must classify it immediately so its caller can abandon the poisoned
# lease and choose another port instead of retrying that port until the barrier
# timeout. Exercise the production function body, not a test-only copy.
proxy_function_source="$(awk '
  /^start_data_plane_proxy\(\)/ { capture = 1 }
  capture { print }
  capture && /^}$/ { exit }
' "$ROOT_DIR/scripts/run-bench-cloud")"
[ -n "$proxy_function_source" ] || fail "could not load the production data-plane proxy function"
proxy_lifecycle_function_source="$(awk '
  /^status_proxy_lifecycle_response_accepted\(\)/ { capture = 1 }
  capture { print }
  capture && /^}$/ { exit }
' "$ROOT_DIR/scripts/run-bench-cloud")"
[ -n "$proxy_lifecycle_function_source" ] ||
  fail "could not load the production status-proxy lifecycle contract"
eval "$proxy_lifecycle_function_source"
eval "$proxy_function_source"
APP="cloudbench-proxy-regression"
CLOUDBENCH_PROXY_POST_PROBE_SETTLE_SECONDS=0
flyctl() {
  echo "Error: listen tcp 127.0.0.1:61944: bind: address already in use" >&2
  return 1
}
curl() { return 1; }
proxy_log="$TMP_ROOT/proxy-bind-collision.log"
proxy_pid=""
proxy_started="$SECONDS"
proxy_status=0
start_data_plane_proxy 61944 3001 occupied.local "$proxy_log" proxy_pid backend 3 \
  || proxy_status=$?
proxy_elapsed=$((SECONDS - proxy_started))
[ "$proxy_status" -eq 98 ] ||
  fail "a bind collision must return the reallocate signal (exit=$proxy_status)"
[ "$proxy_elapsed" -lt 2 ] ||
  fail "a bind collision must fail fast enough to reallocate (elapsed=${proxy_elapsed}s)"
curl() {
  case " $* " in
    *" -w %{http_code} "*) printf 425 ;;
  esac
  return 0
}

production_function() {
  awk -v function_name="$1" '
    $0 ~ "^" function_name "\\(\\)" { capture = 1 }
    capture { print }
    capture && /^}$/ { exit }
  ' "$ROOT_DIR/scripts/run-bench-cloud"
}
PORT_LEASE_HELPER="$ROOT_DIR/scripts/cloudbench-port-lease.py"
[ -f "$PORT_LEASE_HELPER" ] || fail "production port-lease helper is missing"
for function_name in local_port_is_bindable claim_exact_local_port claim_local_port \
    claim_local_archive_ports release_local_port_lease \
    release_local_port_leases publish_status_proxy_port start_leased_data_plane_proxy; do
  function_source="$(production_function "$function_name")"
  [ -n "$function_source" ] || fail "could not load production function $function_name"
  eval "$function_source"
done
PORT_LEASE_ROOT="$TMP_ROOT/proxy-port-leases"
PORT_LEASE_NONCE="proxy-regression-$$"
PORT_LEASES=()
OUT_DIR="$TMP_ROOT/proxy-output"
mkdir -p "$OUT_DIR"
flyctl() {
  case "$2" in
    61944:*)
      echo "Error: listen tcp 127.0.0.1:61944: bind: address already in use" >&2
      return 1
      ;;
    *)
      while :; do command sleep 1; done
      ;;
  esac
}
rotated_port=""
rotated_pid=""
# The replacement tunnel is a background child. On a shared CI host its shell
# can be scheduler-delayed even though the production collision classification
# above remains immediate, so give this observation window enough wall time.
start_leased_data_plane_proxy 61944 rotated_port 3001 occupied.local \
  "$TMP_ROOT/proxy-bind-rotation.log" rotated_pid status 10 ||
  fail "the proxy launcher must recover from a bind collision"
[ "$rotated_port" != "61944" ] || fail "the proxy launcher retried the poisoned port"
[ "$(cat "$OUT_DIR/status-proxy.port" 2>/dev/null || true)" = "$rotated_port" ] ||
  fail "status proxy rotation was not published atomically for the fleet barrier"
[ -n "$rotated_pid" ] && kill -0 "$rotated_pid" 2>/dev/null ||
  fail "the proxy launcher did not preserve the replacement tunnel"
cloudbench_terminate_and_wait 2 "$rotated_pid"
release_local_port_leases
[ ! -d "$PORT_LEASE_ROOT/$rotated_port" ] || fail "replacement proxy lease survived cleanup"

# The dashboard allocator must not impose a hidden 100-port capacity ceiling.
# A real 11-bench ecommerce fleet found every port in 61115..61214 occupied by
# concurrent/archive viewers; the 11th child exited before publishing its boot
# config, so the parent waited five minutes for an impossible 11/11 barrier.
# Drive the production allocator with the same 100-collision boundary and prove
# it leases the immediately following free port.
PORT_LEASE_ROOT="$TMP_ROOT/dashboard-port-leases"
PORT_LEASE_NONCE="dashboard-exhaustion-$$"
PORT_LEASES=()
dashboard_preferred=61115
local_port_is_bindable() {
  [ "$1" -ge $((dashboard_preferred + 100)) ]
}
dashboard_port=""
claim_local_port "$dashboard_preferred" dashboard_port ||
  fail "dashboard allocator stopped after 100 occupied ports instead of continuing"
[ "$dashboard_port" = "$((dashboard_preferred + 100))" ] ||
  fail "dashboard allocator did not select the first free port after 100 collisions"
release_local_port_leases
[ ! -d "$PORT_LEASE_ROOT/$dashboard_port" ] ||
  fail "exhaustion-regression dashboard lease survived cleanup"

# Shell arithmetic normally interprets a leading zero as octal. Port inputs are
# decimal strings, so a valid zero-padded preference must remain valid.
local_port_is_bindable() { return 0; }
decimal_port=""
claim_local_port 08080 decimal_port ||
  fail "dashboard allocator rejected a zero-padded decimal preference"
[ "$decimal_port" = "8080" ] ||
  fail "dashboard allocator did not normalize a zero-padded preference as decimal"
release_local_port_leases

# A stale lease can be replaced between observation and cleanup. Simulate that
# interleaving after the atomic rename and prove cleanup leaves the replacement.
stale_port=61250
stale_path="$PORT_LEASE_ROOT/$stale_port"
mkdir -p "$stale_path"
printf '%s stale\n' 99999999 > "$stale_path/owner"
mv() {
  command mv "$1" "$2" || return
  mkdir -p "$1"
  printf '%s replacement\n' "$$" > "$1/owner"
}
stale_result=""
claim_local_port "$stale_port" stale_result ||
  fail "allocator did not continue after atomically cleaning a stale lease"
unset -f mv
[ "$stale_result" = "$((stale_port + 1))" ] ||
  fail "allocator did not skip the concurrently replaced lease"
[ -d "$stale_path" ] || fail "stale cleanup removed a concurrently replaced lease"
[ "$(cat "$stale_path/owner")" = "$$ replacement" ] ||
  fail "stale cleanup changed the concurrently replaced lease owner"
rm -rf "$stale_path"

# The post-run archive viewer uses two adjacent leased ports. It must use
# the same full-namespace allocator rather than retaining its former 100-port
# inline scan, or a dense fleet can finish successfully but lose its archive UI.
PORT_LEASE_ROOT="$TMP_ROOT/archive-port-leases"
PORT_LEASE_NONCE="archive-exhaustion-$$"
PORT_LEASES=()
local_port_is_bindable() {
  [ "$1" -ge $((dashboard_preferred + 100)) ]
}
archive_api_port=""
archive_fe_port=""
claim_local_archive_ports "$dashboard_preferred" archive_api_port archive_fe_port ||
  fail "archive allocator stopped after 100 occupied ports instead of continuing"
[ "$archive_api_port" = "$((dashboard_preferred + 100))" ] ||
  fail "archive allocator did not select the first free API port after 100 collisions"
[ "$archive_fe_port" = "$((dashboard_preferred + 101))" ] ||
  fail "archive allocator did not lease the exact adjacent frontend port"
release_local_port_leases
[ ! -d "$PORT_LEASE_ROOT/$archive_api_port" ] &&
  [ ! -d "$PORT_LEASE_ROOT/$archive_fe_port" ] ||
  fail "exhaustion-regression archive leases survived cleanup"

# If the preferred API port is free but its exact neighbor is not, release the
# partial lease and continue until a genuinely adjacent pair is available.
PORT_LEASE_ROOT="$TMP_ROOT/archive-adjacency-port-leases"
PORT_LEASE_NONCE="archive-adjacency-$$"
PORT_LEASES=()
archive_preferred=62000
local_port_is_bindable() {
  [ "$1" -ne $((archive_preferred + 1)) ]
}
archive_api_port=""
archive_fe_port=""
claim_local_archive_ports "$archive_preferred" archive_api_port archive_fe_port ||
  fail "archive allocator could not skip a candidate with an occupied neighbor"
[ "$archive_api_port" = "$((archive_preferred + 2))" ] &&
  [ "$archive_fe_port" = "$((archive_preferred + 3))" ] ||
  fail "archive allocator returned non-adjacent ports after an occupied neighbor"
[ ! -d "$PORT_LEASE_ROOT/$archive_preferred" ] ||
  fail "archive allocator retained the partial API lease after adjacency failed"
release_local_port_leases

# Fleet preferred ports advance by 20 per child. At sufficient width that raw
# preference crosses 65535, but the allocator must still wrap through the same
# finite local namespace instead of rejecting an otherwise serviceable fleet.
local_port_is_bindable() { return 0; }
overflow_preferred=$((65535 + 20))
overflow_expected=$((1024 + (overflow_preferred - 1024) % (65535 - 1024 + 1)))
overflow_port=""
claim_local_port "$overflow_preferred" overflow_port ||
  fail "dashboard allocator rejected an overflowed fleet preference instead of wrapping"
[ "$overflow_port" = "$overflow_expected" ] ||
  fail "dashboard allocator normalized an overflowed preference to the wrong port"
release_local_port_leases
[ ! -d "$PORT_LEASE_ROOT/$overflow_port" ] ||
  fail "overflow-regression dashboard lease survived cleanup"
unset -f flyctl curl status_proxy_lifecycle_response_accepted \
  start_data_plane_proxy start_leased_data_plane_proxy \
  local_port_is_bindable claim_exact_local_port claim_local_port \
  claim_local_archive_ports release_local_port_lease \
  release_local_port_leases publish_status_proxy_port production_function
unset CLOUDBENCH_PROXY_POST_PROBE_SETTLE_SECONDS

# Production replay for Fly's cpu_overcommit_exceeded governor response. The
# provider rejected the 37th inherited shared-cpu-4x primary when prod already
# held 16 CPU units: 16 + (37 * 4) = 164, beyond the observed 160-unit ceiling.
# Exercise the real clone command builder and require an explicit capacity-safe
# primary shape rather than inheriting the oversized warm maintenance machine.
primary_default_line="$(grep '^FLEET_PRIMARY_VM_SIZE=' "$ROOT_DIR/scripts/run-bench-fleet")"
primary_memory_line="$(grep '^FLEET_PRIMARY_VM_MEMORY=' "$ROOT_DIR/scripts/run-bench-fleet")"
[[ "$primary_default_line" = *":-shared-cpu-4x}\"" && "$primary_memory_line" = *"4096"* ]] ||
  fail "fleet default must fit both Fly's shared-memory matrix and performance-CPU reservation ceiling"
# descend-full69 proof 2: 3 of 15 shared-cpu-2x primaries were throttled to
# 81-93% steal and expired interactive transactions; 0 of 55 shared-cpu-4x
# primaries exceeded 9%. The default primary must never fall back to 2x.
[ "$(CLOUDBENCH_FLEET_PRIMARY_VM_SIZE='' bash -c "$primary_default_line"'; printf %s "$FLEET_PRIMARY_VM_SIZE"')" = "shared-cpu-4x" ] ||
  fail "default fleet primary must be shared-cpu-4x (shared-cpu-2x guests were throttled to 81-93% steal)"
clone_function_source="$(awk '
  /^clone_machine_target\(\)/ { capture = 1 }
  capture { print }
  capture && /^}$/ { exit }
' "$ROOT_DIR/scripts/run-bench-fleet")"
[ -n "$clone_function_source" ] || fail "could not load production clone command builder"
fleet_production_function() {
  # Subshell-bodied functions (`name() (`) close with a column-zero `)`.
  awk -v function_name="$1" '
    !capture && $0 ~ "^" function_name "\\(\\)" {
      capture = 1
      terminator = ($0 ~ "^" function_name "\\(\\) \\(") ? ")" : "}"
    }
    capture { print }
    capture && $0 == terminator { exit }
  ' "$ROOT_DIR/scripts/run-bench-fleet" "$ROOT_DIR/scripts/lib/cloudbench-inventory.sh"
}
# clone_machine_target verifies every new storage-ready target through the
# production disposable-Volume bridge; outside a disposable lifecycle that
# bridge is an exact no-op, so load it rather than stubbing the call away.
for function_name in machine_creation_admission fleet_clone_with_queue_admission worker_ledger_lock_acquire worker_ledger_lock_release \
  inventory_index_healthy inventory_machine_record_path inventory_machine_field fleet_disable_disposable_volume_snapshots \
  clone_volume_receipt_field clone_attach_failure_prelaunch clone_retire_owned_volume clone_create_owned_volume clone_storage_ready_seconds; do
  function_source="$(fleet_production_function "$function_name")"
  [ -n "$function_source" ] || fail "could not load production function $function_name"
  eval "$function_source"
done
eval "$clone_function_source"
WARM_ID="warm-source"
SNAP_ID="snapshot-1"
REGION="iad"
APP="navi-whisper-lux-bench"
FLEET_PRIMARY_VM_SIZE="shared-cpu-2x"
FLEET_PRIMARY_VM_MEMORY="4096"
clone_args="$TMP_ROOT/primary-clone.args"
INVENTORY_INDEX="$TMP_ROOT/primary-clone-inventory"
INVENTORY_CLOCK_EPOCH="$(date +%s)"
INVENTORY_CLOCK_SECONDS="$SECONDS"
SNAPSHOT_LOOP_PID=$$
SNAPSHOT_LOOP_TOKEN=standalone
printf '%s\n' '[{"id":"warm-source","state":"started","config":{"init":{"cmd":["bash","/cloudbench-boot.sh"]},"mounts":[]}}]' > "$TMP_ROOT/primary-machines.json"
printf '[]\n' > "$TMP_ROOT/primary-volumes.json"
python3 "$ROOT_DIR/scripts/cloudbench-machine-readiness.py" --publish-index \
  "$TMP_ROOT/primary-machines.json" "$TMP_ROOT/primary-volumes.json" "$INVENTORY_INDEX"
fleet_registry_record_name() { return 0; }
fleet_registry_record_id() { return 0; }
fleet_registry_release_name() { return 0; }
machine_volume_id() { printf 'vol_primaryowned'; }
# Fake Machines API for the exact owned Volume created before the clone.
volume_args="$TMP_ROOT/primary-volume.args"
fleet_clone_volume_request() {
  shift
  printf '%s\n' "$*" > "$volume_args"
  printf '{"outcome":"created","id":"vol_primaryowned"}\n'
}
fleet_registry_record_volume() { return 0; }
machine_storage_ready() { return 0; }
machine_storage_failed() { return 1; }
fly_with_timeout() {
  shift
  printf '%s\n' "$*" > "$clone_args"
  echo "Machine abcdef12345678 has been created..."
}
# The real entry point now refuses unmeasured new allocation. Exercise that
# guard before the historical shape replay; it must not reach even our fake
# provider or publish a target ledger.
clone_admission_rc=0
clone_machine_target "$TMP_ROOT/withheld-primary.ids" \
  > "$TMP_ROOT/withheld-primary.stdout" 2> "$TMP_ROOT/withheld-primary.stderr" \
  || clone_admission_rc=$?
[ "$clone_admission_rc" -eq 78 ] || fail "real clone admission must refuse unmeasured allocation"
require_text "$TMP_ROOT/withheld-primary.stderr" "new Machine allocation withheld" \
  "real clone admission must explain its refusal"
[ ! -e "$clone_args" ] && [ ! -e "$TMP_ROOT/withheld-primary.ids" ] || \
  fail "refused clone admission reached transport or published a ledger"
# Mock only admission for this exact fake-provider fixture. Keep the complete
# production command builder and its CPU/memory assertions below unchanged.
machine_creation_admission() {
  [ "$1" = "$TMP_ROOT/primary.ids" ] || return 78
}
primary_id="$(clone_machine_target "$TMP_ROOT/primary.ids")" ||
  fail "production clone command builder failed in the capacity replay"
[ "$primary_id" = "abcdef12345678" ] || fail "capacity replay did not resolve the fake clone"
require_text "$clone_args" "--vm-size shared-cpu-2x" \
  "primary clone must avoid both the running CPU ceiling and performance reservation ceiling"
require_text "$clone_args" "--vm-memory 4096" \
  "primary clone memory must fit Fly's shared-cpu-2x memory ceiling"
require_text "$clone_args" "--attach-volume vol_primaryowned" \
  "primary clone must attach its exact pre-created owned Volume"
require_text "$volume_args" "--vm-size shared-cpu-2x --vm-memory 4096" \
  "owned Volume placement must request the same primary compute shape"
primary_cpus="$(sed -nE 's/.*--vm-size ([^ ]+).*/\1/p' "$clone_args" | sed -nE 's/.*-([0-9]+)x$/\1/p')"
[ -n "$primary_cpus" ] || fail "capacity replay could not parse primary CPU allocation"
[ $((16 + 37 * primary_cpus)) -le 160 ] ||
  fail "daily fleet primary shape exceeds the observed Fly CPU governor ceiling"
unset -f clone_machine_target machine_creation_admission fleet_registry_record_name fleet_registry_record_id \
  fleet_registry_release_name machine_volume_id machine_storage_ready machine_storage_failed fly_with_timeout \
  fleet_clone_with_queue_admission worker_ledger_lock_acquire worker_ledger_lock_release fleet_production_function \
  inventory_index_healthy inventory_machine_record_path inventory_machine_field fleet_disable_disposable_volume_snapshots \
  clone_volume_receipt_field clone_attach_failure_prelaunch clone_retire_owned_volume clone_create_owned_volume \
  clone_storage_ready_seconds fleet_clone_volume_request fleet_registry_record_volume
unset INVENTORY_INDEX INVENTORY_CLOCK_EPOCH INVENTORY_CLOCK_SECONDS SNAPSHOT_LOOP_PID SNAPSHOT_LOOP_TOKEN

resize_function_source="$(awk '
  /^resize_pool_machine\(\)/ { capture = 1 }
  capture { print }
  capture && /^}$/ { exit }
' "$ROOT_DIR/scripts/run-bench-fleet")"
[ -n "$resize_function_source" ] || fail "could not load production pool resizer"
eval "$resize_function_source"
FLEET_DIR="$TMP_ROOT/bridge-resize"
mkdir -p "$FLEET_DIR"
FLEET_PRIMARY_VM_SIZE="shared-cpu-2x"
FLEET_PRIMARY_VM_MEMORY="4096"
APP="navi-whisper-lux-bench"
CLOUDBENCH_POOL_RESIZE_ATTEMPTS=1
resize_calls="$TMP_ROOT/resize.calls"
fly_with_timeout() {
  shift
  printf '%s\n' "$*" >> "$resize_calls"
  return 0
}
sleep() { :; }
resize_pool_machine saturated-shared-machine ||
  fail "pool resizer must execute under nounset and apply the configured target shape"
[ "$(wc -l < "$resize_calls" | tr -d ' ')" = "1" ] ||
  fail "pool resizer must perform one provider update after an immediate success"
require_text "$resize_calls" "--vm-size shared-cpu-2x" \
  "pool resizer must apply the configured capacity-safe target"
unset -f resize_pool_machine fly_with_timeout sleep
unset CLOUDBENCH_POOL_RESIZE_ATTEMPTS

shape_function_source="$(awk '
  /^pool_machine_shape_from_json\(\)/ { capture = 1 }
  capture { print }
  capture && /^}$/ { exit }
' "$ROOT_DIR/scripts/run-bench-fleet")"
normalize_function_source="$(awk '
  /^normalize_current_pool_shape\(\)/ { capture = 1 }
  capture { print }
  capture && /^}$/ { exit }
' "$ROOT_DIR/scripts/run-bench-fleet")"
[ -n "$shape_function_source" ] && [ -n "$normalize_function_source" ] ||
  fail "could not load production pool shape normalizer"
eval "$shape_function_source"
eval "$normalize_function_source"
# The normalizer first honors explicit per-Machine reuse admissions under the
# git-common directory; keep that real guard on an isolated empty root.
GIT_COMMON_DIR="$TMP_ROOT/shape-normalize-common"
mkdir -p "$GIT_COMMON_DIR"
POOL_IDS_FILE="$TMP_ROOT/shape-pool.ids"
printf 'old-shape\ncorrect-shape\n' > "$POOL_IDS_FILE"
FLEET_DIR="$TMP_ROOT/shape-run"
FLEET_PRIMARY_VM_SIZE="shared-cpu-2x"
FLEET_PRIMARY_VM_MEMORY="4096"
POOL_INVENTORY_JSON='[{"id":"old-shape","state":"stopped","config":{"guest":{"cpu_kind":"performance","cpus":1,"memory_mb":8192}}},{"id":"correct-shape","state":"stopped","config":{"guest":{"cpu_kind":"shared","cpus":2,"memory_mb":4096}}}]'
shape_after='[{"id":"old-shape","state":"stopped","config":{"guest":{"cpu_kind":"shared","cpus":2,"memory_mb":4096}}},{"id":"correct-shape","state":"stopped","config":{"guest":{"cpu_kind":"shared","cpus":2,"memory_mb":4096}}}]'
resize_calls="$TMP_ROOT/shape-resizes"
resize_marker="$TMP_ROOT/shape-resized"
resize_pool_machine() { printf '%s\n' "$1" >> "$resize_calls"; touch "$resize_marker"; }
FLY() { [ -f "$resize_marker" ] && printf '%s\n' "$shape_after" || printf '%s\n' "$POOL_INVENTORY_JSON"; }
normalize_current_pool_shape || fail "existing stopped pool shape did not normalize"
[ "$(cat "$resize_calls")" = "old-shape" ] ||
  fail "pool normalizer must mutate only the mismatched stopped machine"
unset -f pool_machine_shape_from_json normalize_current_pool_shape resize_pool_machine FLY

# A second fleet must retain admitted 8GB pool shapes and assign each task a
# matching stopped Machine before attempting a host-local resize.
eval "$shape_function_source"
eval "$normalize_function_source"
shape_hints_source="$(awk '
  /^pool_write_shape_hints\(\)/ { capture = 1 }
  capture { print }
  capture && /^}$/ { exit }
' "$ROOT_DIR/scripts/run-bench-fleet")"
claim_function_source="$(awk '
  /^claim_pool_machine\(\)/ { capture = 1 }
  capture { print }
  capture && /^}$/ { exit }
' "$ROOT_DIR/scripts/run-bench-fleet")"
[ -n "$shape_hints_source" ] && [ -n "$claim_function_source" ] ||
  fail "could not load production shape-aware pool claims"
eval "$shape_hints_source"
eval "$claim_function_source"
# The current claimer checks outgoing handoffs and reuse proofs even in this
# shape-only fixture. Keep those real guards on an isolated empty Gitcommon.
GIT_COMMON_DIR="$TMP_ROOT/mixed-shape-common"
mkdir -p "$GIT_COMMON_DIR"
proof_path_source="$(grep '^pool_reuse_proof_file()' "$ROOT_DIR/scripts/run-bench-fleet")"
proof_verify_source="$(awk '
  /^pool_verify_reuse_proof\(\)/ { capture = 1 }
  capture { print }
  capture && /^}$/ { exit }
' "$ROOT_DIR/scripts/run-bench-fleet")"
[ -n "$proof_path_source" ] && [ -n "$proof_verify_source" ] ||
  fail "could not load production pool reuse proof guards"
eval "$proof_path_source"
eval "$proof_verify_source"
POOL_IDS_FILE="$TMP_ROOT/mixed-shape-pool.ids"
printf 'a1\nb2\n' > "$POOL_IDS_FILE"
FLEET_DIR="$TMP_ROOT/mixed-shape-run"
mkdir -p "$FLEET_DIR"
POOL_INVENTORY_JSON='[{"id":"a1","state":"stopped","config":{"guest":{"cpu_kind":"shared","cpus":2,"memory_mb":4096}}},{"id":"b2","state":"stopped","config":{"guest":{"cpu_kind":"shared","cpus":4,"memory_mb":8192}}}]'
FLEET_BUNDLED_FRONTEND_VM_SIZE="shared-cpu-4x"
FLEET_BUNDLED_FRONTEND_VM_MEMORY="8192"
CLOUDBENCH_POOL_DYNAMIC_VM_SHAPE=1
resize_pool_machine() { fail "admitted large pool shape was needlessly resized"; }
normalize_current_pool_shape || fail "mixed stopped pool shapes were not admitted"
pool_write_shape_hints || fail "mixed pool shape hints were not written"
require_text "$FLEET_DIR/pool-shapes.tsv" "b2 shared 4 8192" \
  "large pool shape hint was lost"
POOL_CLAIMS_DIR="$TMP_ROOT/mixed-shape-claims"
CLAIMED_POOL_FILE="$FLEET_DIR/claimed.ids"
UNAVAILABLE_POOL_IDS=()
: > "$CLAIMED_POOL_FILE"
# Drain stdin like the real reader: under pipefail the inventory printf otherwise
# races this fake's exit into SIGPIPE, and the claim sees no volume.
machine_volume_id_from_json() {
  cat >/dev/null || return
  printf 'vol-mixed-shape'
}
write_pool_claim() { printf 'owned\n' > "$1"; }
cloudbench_env_sha256() { printf '%064d' 0; }
fleet_audit_record_pool_machine() { return 0; }
volume_fixture_input="$TMP_ROOT/mixed-shape-inventory.json"
python3 - "$volume_fixture_input" "$POOL_INVENTORY_JSON" <<'PY'
import sys
from pathlib import Path

# Provider inventories can exceed a pipe buffer. Retain valid JSON while
# proving the fixture consumer drains the stream before returning its volume.
Path(sys.argv[1]).write_text(" " * (1024 * 1024) + sys.argv[2])
PY
fixture_volume="$(cat "$volume_fixture_input" | machine_volume_id_from_json a1)" ||
  fail "pool volume fixture did not consume its complete JSON input"
[ "$fixture_volume" = "vol-mixed-shape" ] || fail "pool volume fixture changed its volume"
large_claim="$(claim_pool_machine shared-cpu-4x 8192)"
[ "$large_claim" = "b2" ] ||
  fail "large benchmark did not prefer the admitted 8GB Machine"
small_claim="$(claim_pool_machine shared-cpu-2x 4096)"
[ "$small_claim" = "a1" ] ||
  fail "small benchmark did not prefer the admitted 4GB Machine"
unset CLOUDBENCH_POOL_DYNAMIC_VM_SHAPE
unset -f pool_machine_shape_from_json normalize_current_pool_shape pool_write_shape_hints \
  claim_pool_machine resize_pool_machine machine_volume_id_from_json write_pool_claim \
  cloudbench_env_sha256 fleet_audit_record_pool_machine pool_reuse_proof_file pool_verify_reuse_proof
unset GIT_COMMON_DIR

boot_update_source="$(awk '
  /^boot_update_with_capacity_recovery\(\)/ { capture = 1 }
  capture { print }
  capture && /^}$/ { exit }
' "$ROOT_DIR/scripts/run-bench-cloud")"
[ -n "$boot_update_source" ] || fail "missing production boot update capacity recovery"
eval "$boot_update_source"
CLOUDBENCH_BOOT_UPDATE_ATTEMPTS=1
CLOUDBENCH_BOOT_UPDATE_CAPACITY_WAIT_SECONDS=10
CLOUDBENCH_BOOT_UPDATE_CAPACITY_RETRY_SECONDS=0
boot_update_calls=0
_with_timeout() {
  boot_update_calls=$((boot_update_calls + 1))
  if [ "$boot_update_calls" = 1 ]; then
    echo 'Error: insufficient CPUs available to fulfill request on the current host'
    return 1
  fi
  return 0
}
sleep() { :; }
boot_update_with_capacity_recovery "$TMP_ROOT/host-capacity-update.log" fake update ||
  fail "host-local CPU shortage was not retried as provider capacity"
[ "$boot_update_calls" = 2 ] ||
  fail "host-local CPU shortage consumed the ordinary boot retry budget"
unset -f boot_update_with_capacity_recovery _with_timeout sleep
unset CLOUDBENCH_BOOT_UPDATE_ATTEMPTS CLOUDBENCH_BOOT_UPDATE_CAPACITY_WAIT_SECONDS \
  CLOUDBENCH_BOOT_UPDATE_CAPACITY_RETRY_SECONDS

# Production replay (original600-1792976687768099299 shard-01): Fly answered
# every same-ID boot-config update for Machine 863745ce73de38 with
# "request returned non-2xx status: 408". The child replayed it ten times on
# the dead host and the update log kept only the last response; the fleet
# barrier then aborted every copy. A fake flyctl returns that exact 408 for
# one Machine only.
(
  boot_timeout_source="$(awk '
    /^_with_timeout\(\)/ { capture = 1 }
    capture { print }
    capture && /^}$/ { exit }
  ' "$ROOT_DIR/scripts/run-bench-cloud")"
  eval "$boot_timeout_source"
  eval "$boot_update_source"
  fake_fly_dir="$TMP_ROOT/fake-fly-408"
  mkdir -p "$fake_fly_dir"
  cat > "$fake_fly_dir/flyctl" <<'FAKEFLY'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${FAKE_FLY_CALLS:?}"
if [ "$1 $2 $3" = "machine update m408dead00000a" ]; then
  echo "Updating machine $3"
  echo "Error: could not update machine $3: failed to update VM $3: request returned non-2xx status: 408:  (Request ID: 01M5TWKRQW2VX1JSXAQHWGVFME-iad)"
  exit 1
fi
if [ "$1 $2 $3" = "machine update m503api00000d" ]; then
  echo "Error: request returned non-2xx status: 503"
  exit 1
fi
echo "Machine $3 updated"
FAKEFLY
  chmod +x "$fake_fly_dir/flyctl"
  PATH="$fake_fly_dir:$PATH"
  BOOT_CONFIG_UPDATE_SLOT_SHARED=0
  CLOUDBENCH_CAMPAIGN_MUTATION_ADMISSION=0
  CLOUDBENCH_BOOT_UPDATE_RETRY_SECONDS=0
  for host_case in m408dead00000a:1 m200live00000b:0 m503api00000d:2; do
    host_mid="${host_case%%:*}"
    host_expect="${host_case#*:}"
    FAKE_FLY_CALLS="$TMP_ROOT/fake-fly-$host_mid.calls"
    export FAKE_FLY_CALLS
    : > "$FAKE_FLY_CALLS"
    host_log="$TMP_ROOT/host-$host_mid-update.log"
    host_marker="$TMP_ROOT/host-$host_mid.unresponsive"
    rm -f "$host_log" "$host_marker"
    host_rc=0
    BOOT_UPDATE_MACHINE_ID="$host_mid" BOOT_UPDATE_HOST_UNRESPONSIVE_MARKER="$host_marker" \
      boot_update_with_capacity_recovery "$host_log" \
      flyctl machine update "$host_mid" -a fixture --skip-start --yes 2>/dev/null || host_rc=$?
    if [ "$host_expect" = 2 ]; then
      # An app-wide API 5xx is not evidence about this Machine's host.
      [ "$host_rc" = 1 ] && [ ! -e "$host_marker" ] && [ "$(wc -l < "$FAKE_FLY_CALLS")" = 10 ] ||
        fail "API-wide 503 was treated as an unresponsive Machine host"
      continue
    fi
    if [ "$host_expect" = 0 ]; then
      [ "$host_rc" = 0 ] && [ ! -e "$host_marker" ] && [ "$(wc -l < "$FAKE_FLY_CALLS")" = 1 ] ||
        fail "healthy-host boot update did not succeed once without a replacement marker"
      continue
    fi
    [ "$host_rc" = 1 ] || fail "unresponsive-host boot update returned $host_rc"
    [ "$(wc -l < "$FAKE_FLY_CALLS")" = 3 ] ||
      fail "unresponsive-host boot update replayed $(wc -l < "$FAKE_FLY_CALLS") same-ID mutations (expected 3 consecutive host timeouts)"
    [ "$(cat "$host_marker" 2>/dev/null)" = "$host_mid" ] ||
      fail "unresponsive-host boot update did not name the exact Machine for replacement"
    [ "$(grep -Ec '^=== boot update attempt [1-3] at [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z rc=1 ===$' "$host_log")" = 3 ] &&
      [ "$(grep -c 'non-2xx status: 408' "$host_log")" = 3 ] ||
      fail "boot update log did not keep every timestamped attempt"
    [ ! -e "$host_log.attempt" ] || fail "boot update left its per-attempt scratch log"
  done
) || fail "unresponsive Fly host boot update checks failed"

# The fleet barrier replaces that one disposable clone once instead of
# aborting the whole fleet; pool claims and a second dead host still abort.
(
  for fleet_fn in boot_config_failed_child fleet_replace_host_unresponsive_child; do
    fleet_fn_source="$(awk -v name="$fleet_fn" '
      $0 ~ "^" name "\\(\\) *\\{" { capture = 1 }
      capture { print }
      capture && /^}$/ { exit }
    ' "$ROOT_DIR/scripts/run-bench-fleet")"
    [ -n "$fleet_fn_source" ] || fail "missing fleet function $fleet_fn"
    eval "$fleet_fn_source"
  done
  awk '/boot_config_failed_slot="\$\(boot_config_failed_child\)"/ { found = 1 } found && /fleet_replace_host_unresponsive_child "\$boot_config_failed_slot"/ { ok = 1; exit } END { exit !ok }' \
    "$ROOT_DIR/scripts/run-bench-fleet" || fail "boot-config barrier does not try a host replacement before aborting"
  fleet_job_running() { return 1; }
  wait_for_mandatory_autoscaler_startup() { printf 'autoscaler-wait %s\n' "$*" >> "$TMP_ROOT/fleet-replace.events"; }
  provision_primary_machine() { fail "host replacement must not claim from the pool"; }
  primary_vm_size_for_bench() { echo shared-cpu-2x; }
  primary_vm_memory_for_bench() { echo 4096; }
  primary_clone_storage_mode() { echo fresh; }
  WARM_ID=warm00000000; SNAP_ID=snap0
  clone_machine_target() {
    printf 'provision %s\n' "${1%/primary.ids}" >> "$TMP_ROOT/fleet-replace.events"
    [ -n "${FAKE_REPLACEMENT_ID:-}" ] || return 1
    printf '%s\n' "$FAKE_REPLACEMENT_ID"
  }
  launch_fleet_bench_child() {
    printf 'launch %s\n' "$*" >> "$TMP_ROOT/fleet-replace.events"
    CHILD_MACHINE[$3]="$FAKE_REPLACEMENT_ID"
    CHILD_PIDS[$3]=""
  }
  BOOT_CONFIG_BARRIER="$TMP_ROOT/fleet-replace-barrier"
  mkdir -p "$BOOT_CONFIG_BARRIER/ready"
  fleet_out="$TMP_ROOT/fleet-replace/browser-auth-saved-password-retry"
  ok_out="$TMP_ROOT/fleet-replace/healthy"
  mkdir -p "$fleet_out" "$ok_out"
  CHILD_OUT=("$ok_out" "$fleet_out")
  CHILD_BENCH=(healthy browser-auth-saved-password-retry)
  CHILD_MACHINE=(m200live00000b m408dead00000a)
  CHILD_BENCH_INDEX=(0 3)
  CHILD_PIDS=("" "")
  AUTOSCALER_PIDS=()
  : > "$BOOT_CONFIG_BARRIER/ready/m200live00000b"
  printf 'clone m408dead00000a\n' > "$fleet_out/.cid"
  printf '125\n' > "$fleet_out/benchmark-child.finished"
  printf 'm408dead00000a\n' > "$fleet_out/boot-config-unapplied"
  printf 'm408dead00000a\n' > "$fleet_out/boot-config-host-unresponsive"
  echo 'non-2xx status: 408' > "$fleet_out/cloudbench-boot-update.log"
  printf '{"machine_id": "m408dead00000a"}\n' > "$fleet_out/runtime-evidence.owner.json"
  : > "$fleet_out/runtime-evidence.pending"
  # A failed replacement clone restores the exact original failure state.
  : > "$TMP_ROOT/fleet-replace.events"
  FAKE_REPLACEMENT_ID=""
  ! fleet_replace_host_unresponsive_child 1 $((SECONDS + 60)) 2>/dev/null &&
    [ "$(cat "$fleet_out/.cid")" = "clone m408dead00000a" ] &&
    [ -e "$fleet_out/runtime-evidence.owner.json" ] && [ -e "$fleet_out/boot-config-unapplied" ] &&
    [ -e "$fleet_out/boot-config-host-unresponsive" ] && [ ! -e "$fleet_out/boot-config-host-replaced" ] &&
    [ ! -e "$fleet_out/host-replaced-m408dead00000a" ] ||
    fail "a failed replacement clone did not restore the original failure state"
  : > "$TMP_ROOT/fleet-replace.events"
  failed_slot="$(boot_config_failed_child)" && [ "$failed_slot" = 1 ] ||
    fail "boot-config barrier did not identify the unapplied child slot"
  FAKE_REPLACEMENT_ID=m200fresh0000c
  fleet_replace_host_unresponsive_child 1 $((SECONDS + 60)) 2>/dev/null ||
    fail "host-unresponsive clone was not replaced before the barrier aborted"
  [ "$(cat "$TMP_ROOT/fleet-replace.events")" = "$(printf 'provision %s\nlaunch 3 browser-auth-saved-password-retry 1' "$fleet_out")" ] ||
    fail "host replacement did not re-provision and relaunch the same bench slot: $(cat "$TMP_ROOT/fleet-replace.events")"
  [ "${CHILD_MACHINE[1]}" = m200fresh0000c ] && [ ! -e "$fleet_out/benchmark-child.finished" ] &&
    grep -q 408 "$fleet_out/host-replaced-m408dead00000a/cloudbench-boot-update.log" &&
    [ "$(cat "$fleet_out/host-replaced-m408dead00000a/.cid")" = "clone m408dead00000a" ] &&
    [ "$(cat "$fleet_out/.cid")" = "clone m200fresh0000c" ] &&
    [ ! -e "$fleet_out/runtime-evidence.owner.json" ] && [ ! -e "$fleet_out/runtime-evidence.pending" ] &&
    [ -e "$fleet_out/host-replaced-m408dead00000a/runtime-evidence.owner.json" ] ||
    fail "host replacement did not preserve the failed attempt's evidence"
  # The replacement's host also dies: strict abort, no second replacement.
  printf '125\n' > "$fleet_out/benchmark-child.finished"
  printf 'm200fresh0000c\n' > "$fleet_out/boot-config-host-unresponsive"
  : > "$TMP_ROOT/fleet-replace.events"
  ! fleet_replace_host_unresponsive_child 1 $((SECONDS + 60)) 2>/dev/null &&
    [ ! -s "$TMP_ROOT/fleet-replace.events" ] || fail "a second unresponsive host was replaced again"
  # Ordinary unapplied failures and pool claims keep the strict abort.
  rm -f "$fleet_out/boot-config-host-replaced" "$fleet_out/boot-config-host-unresponsive"
  ! fleet_replace_host_unresponsive_child 1 $((SECONDS + 60)) 2>/dev/null ||
    fail "a boot failure without host-timeout proof was replaced"
  printf 'pool m200fresh0000c\n' > "$fleet_out/.cid"
  printf 'm200fresh0000c\n' > "$fleet_out/boot-config-host-unresponsive"
  ! fleet_replace_host_unresponsive_child 1 $((SECONDS + 60)) 2>/dev/null &&
    [ ! -s "$TMP_ROOT/fleet-replace.events" ] || fail "a claimed pool Machine was replaced by a clone"
  printf 'clone m200fresh0000c\n' > "$fleet_out/.cid"
  ! fleet_replace_host_unresponsive_child 1 $((SECONDS - 1)) 2>/dev/null &&
    [ ! -s "$TMP_ROOT/fleet-replace.events" ] || fail "host replacement ran past the boot-config deadline"
) || fail "fleet host-unresponsive replacement checks failed"

# A shared mutation lease is joined exactly when _with_timeout wrote its
# join-native receipt for the latest attempt, whatever its exit status: a
# signal-killed child (137) or an interruption after the child exists (143)
# is reaped and joined; an interruption before any child handle is not.
boot_release_source="$(awk '
  /^release_boot_config_update_slot\(\)/ { capture = 1 }
  capture { print }
  capture && /^}$/ { exit }
' "$ROOT_DIR/scripts/run-bench-cloud")"
[ -n "$boot_release_source" ] || fail "missing production boot config slot release"
(
eval "$boot_update_source"
eval "$boot_release_source"
APP=fixture-app
MUTATION_OWNER_PID_START=fixture-start
CLOUDBENCH_RUNTIME_SCRIPT_ROOT=/fixture
CLOUDBENCH_BOOT_UPDATE_ATTEMPTS=1
CLOUDBENCH_BOOT_UPDATE_RETRY_SECONDS=0
sleep() { :; }
cloudbench_mutation_admission() { printf '%s\n' "$2" >> "$TMP_ROOT/boot-lease-events"; }
# _with_timeout fake: <rc>:<receipt> where receipt=1 writes the join-native receipt.
boot_fake_attempts=""
_with_timeout() {
  local attempt
  attempt="${boot_fake_attempts%% *}"
  boot_fake_attempts="${boot_fake_attempts#* }"
  [ "${attempt#*:}" != 1 ] || : > "${CLOUDBENCH_TIMEOUT_NATIVE_JOIN_RECEIPT:?join receipt path not passed}"
  return "${attempt%%:*}"
}
for boot_case in 0:1:0:1:released 1:1:1:1:released 124:1:1:1:released 137:1:1:1:released \
    143:1:1:1:released 143:0:1:0:retained 130:0:1:0:retained 1:0:1:0:retained; do
  IFS=: read -r boot_native_rc boot_receipt boot_expect_rc boot_expect_joined boot_expect_release <<EOF_CASE
$boot_case
EOF_CASE
  : > "$TMP_ROOT/boot-lease-events"
  boot_fake_attempts="$boot_native_rc:$boot_receipt "
  BOOT_CONFIG_UPDATE_SLOT=fixture-lease
  BOOT_CONFIG_UPDATE_SLOT_SHARED=1
  BOOT_CONFIG_UPDATE_SLOT_NATIVE_JOINED=0
  boot_update_rc=0
  boot_update_with_capacity_recovery "$TMP_ROOT/boot-lease-update.log" fake update || boot_update_rc=$?
  [ "$boot_update_rc" = "$boot_expect_rc" ] ||
    fail "boot update wrapper rc $boot_native_rc returned $boot_update_rc"
  [ "$BOOT_CONFIG_UPDATE_SLOT_NATIVE_JOINED" = "$boot_expect_joined" ] ||
    fail "boot update wrapper rc $boot_native_rc marked joined=$BOOT_CONFIG_UPDATE_SLOT_NATIVE_JOINED"
  release_rc=0
  release_boot_config_update_slot || release_rc=$?
  if [ "$boot_expect_release" = released ]; then
    [ "$release_rc" = 0 ] && [ -z "$BOOT_CONFIG_UPDATE_SLOT" ] &&
      grep -qx release "$TMP_ROOT/boot-lease-events" ||
      fail "joined boot update lease (rc $boot_native_rc) was not released"
  else
    [ "$release_rc" != 0 ] && [ "$BOOT_CONFIG_UPDATE_SLOT" = fixture-lease ] &&
      ! grep -qx release "$TMP_ROOT/boot-lease-events" ||
      fail "unjoined boot update lease (rc $boot_native_rc) was released"
  fi
done
# Joined state follows the latest attempt's receipt: an earlier joined failure
# (signal-killed child) is not sticky, and a later receiptless attempt fences.
# The helper refuses start-native after an unjoined owner, so a receipt on a
# later attempt also proves every earlier native owner was joined.
CLOUDBENCH_BOOT_UPDATE_ATTEMPTS=2
for boot_retry in "137:1 0:1 :0:1" "137:1 1:0 :1:0"; do
  boot_fake_attempts="${boot_retry% :*:*} "
  boot_retry_expect="${boot_retry##* :}"
  : > "$TMP_ROOT/boot-lease-events"
  BOOT_CONFIG_UPDATE_SLOT=fixture-lease
  BOOT_CONFIG_UPDATE_SLOT_SHARED=1
  BOOT_CONFIG_UPDATE_SLOT_NATIVE_JOINED=0
  boot_update_rc=0
  boot_update_with_capacity_recovery "$TMP_ROOT/boot-lease-update.log" fake update || boot_update_rc=$?
  [ "$boot_update_rc:$BOOT_CONFIG_UPDATE_SLOT_NATIVE_JOINED" = "$boot_retry_expect" ] ||
    fail "boot update retry ($boot_retry) returned rc:joined $boot_update_rc:$BOOT_CONFIG_UPDATE_SLOT_NATIVE_JOINED"
done
# The actual wrapper writes the join receipt after reaping its child, including
# a signal-killed child, and never without a child handle.
boot_timeout_source="$(awk '
  /^_with_timeout\(\)/ { capture = 1 }
  capture { print }
  capture && /^}$/ { exit }
' "$ROOT_DIR/scripts/run-bench-cloud")"
[ -n "$boot_timeout_source" ] || fail "missing production native timeout wrapper"
(
  eval "$boot_timeout_source"
  BOOT_CONFIG_UPDATE_SLOT_SHARED=0
  for boot_child in "0:true" "137:kill -KILL \$\$" "3:exit 3"; do
    rm -f "$TMP_ROOT/real-join-receipt"
    boot_real_rc=0
    CLOUDBENCH_TIMEOUT_NATIVE_JOIN_RECEIPT="$TMP_ROOT/real-join-receipt" \
      _with_timeout 20 sh -c "${boot_child#*:}" || boot_real_rc=$?
    [ "$boot_real_rc" = "${boot_child%%:*}" ] && [ -f "$TMP_ROOT/real-join-receipt" ] ||
      fail "native timeout wrapper ($boot_child) returned $boot_real_rc without its join receipt"
  done
  rm -f "$TMP_ROOT/real-join-receipt"
  boot_real_rc=0
  CLOUDBENCH_TIMEOUT_NATIVE_JOIN_RECEIPT="$TMP_ROOT/real-join-receipt" \
    _with_timeout 20 "$TMP_ROOT/absent-native-command" 2>/dev/null || boot_real_rc=$?
  [ "$boot_real_rc" != 0 ] && [ ! -e "$TMP_ROOT/real-join-receipt" ] ||
    fail "native timeout wrapper wrote a join receipt without a child handle"
) || fail "native timeout wrapper join receipt checks failed"
# A refusal before any native attempt has nothing in flight: its lease is
# released (invalid contract, then a pacing failure on the first attempt).
for boot_early in contract pace; do
  : > "$TMP_ROOT/boot-lease-events"
  _with_timeout() { fail "early boot update refusal ($boot_early) started a native attempt"; }
  CLOUDBENCH_BOOT_UPDATE_ATTEMPTS=2
  CLOUDBENCH_CAMPAIGN_MUTATION_ADMISSION=0
  if [ "$boot_early" = contract ]; then
    CLOUDBENCH_BOOT_UPDATE_ATTEMPTS=0
  else
    CLOUDBENCH_CAMPAIGN_MUTATION_ADMISSION=1
    cloudbench_mutation_admission() {
      printf '%s\n' "$2" >> "$TMP_ROOT/boot-lease-events"
      [ "$2" != pace ]
    }
  fi
  BOOT_CONFIG_UPDATE_SLOT=fixture-lease
  BOOT_CONFIG_UPDATE_SLOT_SHARED=1
  BOOT_CONFIG_UPDATE_SLOT_NATIVE_JOINED=0
  boot_update_with_capacity_recovery "$TMP_ROOT/boot-lease-update.log" fake update &&
    fail "early boot update refusal ($boot_early) reported success"
  release_boot_config_update_slot && [ -z "$BOOT_CONFIG_UPDATE_SLOT" ] &&
    grep -qx release "$TMP_ROOT/boot-lease-events" ||
    fail "early boot update refusal ($boot_early) retained an unused lease"
done
CLOUDBENCH_CAMPAIGN_MUTATION_ADMISSION=0
# Outside the wrapper's own bookkeeping, no call site may mark the lease joined.
if awk '
  /^boot_update_with_capacity_recovery\(\)/ { inside = 1 }
  !inside { print }
  inside && /^}$/ { inside = 0 }
' "$ROOT_DIR/scripts/run-bench-cloud" | grep -Eq '^[[:space:]]*BOOT_CONFIG_UPDATE_SLOT_NATIVE_JOINED=1[[:space:]]*$'; then
  fail "boot config update call site marks the native lease joined unconditionally"
fi
)

# The resize optimization only changes pool admission. A real large-primary
# task keeps its 8GB request, while the default path still forks a separate
# large Machine when the opt-in is absent.
python3 - "$ROOT_DIR" <<'PY_BROWSER_METADATA' || fail "browser metadata must reach the fleet shape selector"
import sys
from pathlib import Path

root = Path(sys.argv[1])
sys.path.insert(0, str(root / "scripts"))
from cloudbench_catalog import get_task_metadata

rows = get_task_metadata(
    root / "agents/benchmarks/tasks.json", ["polar-bu-065", "image-handling"]
)
assert rows[0]["requires_browser_agent"] is True
assert rows[1]["requires_browser_agent"] is not True
PY_BROWSER_METADATA
for function_name in is_sim_on bench_needs_large_primary bench_declares_fanout primary_vm_size_for_bench \
  primary_vm_memory_for_bench bench_uses_default_pool_shape; do
  function_source="$(awk -v name="$function_name" '
    $0 ~ ("^" name "\\(\\)") { capture = 1 }
    capture { print }
    capture && /^}$/ { exit }
  ' "$ROOT_DIR/scripts/run-bench-fleet")"
  [ -n "$function_source" ] || fail "missing production pool shape selector $function_name"
  eval "$function_source"
done
FLEET_BUNDLED_FRONTEND_VM_SIZE="shared-cpu-4x"
FLEET_BUNDLED_FRONTEND_VM_MEMORY="8192"
INFRA_PROBE=0
SIM_ON_CSV=""
CATALOG_BROWSER_REQUIRED_TASKS=(polar-bu-065)
unset CLOUDBENCH_POOL_DYNAMIC_VM_SHAPE
bench_uses_default_pool_shape parallel-tool-calls ||
  fail "ordinary tasks must retain default pool admission"
if bench_uses_default_pool_shape polar-bu-065; then
  fail "catalog browser tasks must request the large primary shape"
fi
if bench_uses_default_pool_shape agent-payment-abandonment; then
  fail "8GB tasks must not claim a 4GB pool without explicit resize"
fi
CLOUDBENCH_POOL_DYNAMIC_VM_SHAPE=1
bench_uses_default_pool_shape agent-payment-abandonment ||
  fail "opted-in 8GB tasks must be able to claim a stopped pool Machine"
[ "$(primary_vm_memory_for_bench agent-payment-abandonment)" = 8192 ] ||
  fail "pool resize admission must preserve the large task's requested memory"
bench_uses_default_pool_shape polar-bu-065 ||
  fail "opted-in browser tasks must be able to resize a stopped pool Machine"
INFRA_PROBE=1
[ "$(primary_vm_memory_for_bench polar-bu-065)" = "${FLEET_PRIMARY_VM_MEMORY}" ] ||
  fail "task-free infra probes must retain the default primary shape"
INFRA_PROBE=0
unset CLOUDBENCH_POOL_DYNAMIC_VM_SHAPE
# --sim-on guests serve the native WMH themselves and get the measured large
# shape; every task NOT named by --sim-on keeps exactly its previous shape and
# pool eligibility, so other workstreams' REAL runs are unchanged.
FLEET_SIM_VM_SIZE="performance-8x"
FLEET_SIM_VM_MEMORY="65536"
SIM_ON_CSV="raise-5m-rose-labs-brex"
[ "$(primary_vm_size_for_bench raise-5m-rose-labs-brex)/$(primary_vm_memory_for_bench raise-5m-rose-labs-brex)" = "performance-8x/65536" ] ||
  fail "--sim-on tasks must request the native WMH serving shape"
if bench_uses_default_pool_shape raise-5m-rose-labs-brex; then
  fail "--sim-on tasks must not claim a default-shape pool Machine"
fi
[ "$(primary_vm_size_for_bench parallel-tool-calls)/$(primary_vm_memory_for_bench parallel-tool-calls)" = "$FLEET_PRIMARY_VM_SIZE/$FLEET_PRIMARY_VM_MEMORY" ] ||
  fail "tasks outside --sim-on must keep the default primary shape"
[ "$(primary_vm_size_for_bench polar-bu-065)/$(primary_vm_memory_for_bench polar-bu-065)" = "shared-cpu-4x/8192" ] ||
  fail "browser tasks outside --sim-on must keep the large primary shape"
bench_uses_default_pool_shape parallel-tool-calls ||
  fail "tasks outside --sim-on must retain default pool admission"
INFRA_PROBE=1
[ "$(primary_vm_size_for_bench raise-5m-rose-labs-brex)" = "$FLEET_PRIMARY_VM_SIZE" ] ||
  fail "task-free infra probes must never request the SIM shape"
INFRA_PROBE=0
SIM_ON_CSV=""
[ "$(primary_vm_size_for_bench raise-5m-rose-labs-brex)" = "$FLEET_PRIMARY_VM_SIZE" ] ||
  fail "a REAL run of a SIM-capable task must keep the default primary shape"
# A catalog-declared wide tree (min_agent_count >= FLEET_FANOUT_MIN_AGENT_COUNT)
# gets dedicated vCPUs: shared-cpu-2x was throttled under the 51-agent tree
# (descend-full69 P3). Other tasks keep exactly their previous shape.
FLEET_FANOUT_MIN_AGENT_COUNT=20
FLEET_FANOUT_VM_SIZE="performance-2x"
FLEET_FANOUT_VM_MEMORY="4096"
CATALOG_FANOUT_TASKS=(test-mass-agent-run-0)
CATALOG_BROWSER_REQUIRED_TASKS=(polar-bu-065)
[ "$(primary_vm_size_for_bench test-mass-agent-run-0)/$(primary_vm_memory_for_bench test-mass-agent-run-0)" = "performance-2x/4096" ] ||
  fail "a catalog fan-out task must request dedicated vCPUs"
[ "$(primary_vm_size_for_bench parallel-tool-calls)/$(primary_vm_memory_for_bench parallel-tool-calls)" = "$FLEET_PRIMARY_VM_SIZE/$FLEET_PRIMARY_VM_MEMORY" ] ||
  fail "tasks without a fan-out declaration must keep the default primary shape"
[ "$(primary_vm_size_for_bench polar-bu-065)/$(primary_vm_memory_for_bench polar-bu-065)" = "shared-cpu-4x/8192" ] ||
  fail "browser tasks must keep the large shared primary shape beside a fan-out task"
if bench_uses_default_pool_shape test-mass-agent-run-0; then
  fail "a fan-out task must not claim a default shared-cpu pool Machine"
fi
CLOUDBENCH_POOL_DYNAMIC_VM_SHAPE=1
if bench_uses_default_pool_shape test-mass-agent-run-0; then
  fail "dynamic pool resize opt-in must not turn a fan-out task into a shared-cpu claim"
fi
unset CLOUDBENCH_POOL_DYNAMIC_VM_SHAPE
INFRA_PROBE=1
[ "$(primary_vm_size_for_bench test-mass-agent-run-0)" = "$FLEET_PRIMARY_VM_SIZE" ] ||
  fail "task-free infra probes must never request the fan-out shape"
INFRA_PROBE=0
FLEET_SIM_VM_SIZE="performance-8x"; FLEET_SIM_VM_MEMORY="65536"; SIM_ON_CSV="test-mass-agent-run-0"
[ "$(primary_vm_size_for_bench test-mass-agent-run-0)" = "performance-8x" ] ||
  fail "--sim-on serving shape must outrank the fan-out shape"
python3 - "$ROOT_DIR" <<'PY_FANOUT_METADATA' || fail "catalog must declare the fan-out task through min_agent_count"
import sys
from pathlib import Path

sys.path.insert(0, f"{sys.argv[1]}/scripts")
from cloudbench_catalog import get_task_metadata

rows = {
    row["name"]: row
    for row in get_task_metadata(
        Path(sys.argv[1]) / "agents/benchmarks/tasks.json",
        ["test-mass-agent-run-0", "parallel-tool-calls"],
    )
}
assert rows["test-mass-agent-run-0"]["min_agent_count"] >= 20, rows["test-mass-agent-run-0"]
assert (rows["parallel-tool-calls"]["min_agent_count"] or 0) < 20, rows["parallel-tool-calls"]
PY_FANOUT_METADATA
unset SIM_ON_CSV FLEET_SIM_VM_SIZE FLEET_SIM_VM_MEMORY CATALOG_FANOUT_TASKS FLEET_FANOUT_VM_SIZE FLEET_FANOUT_VM_MEMORY FLEET_FANOUT_MIN_AGENT_COUNT
unset CATALOG_BROWSER_REQUIRED_TASKS
unset -f is_sim_on bench_needs_large_primary bench_declares_fanout primary_vm_size_for_bench \
  primary_vm_memory_for_bench bench_uses_default_pool_shape

machine_states="$TMP_ROOT/machine-states"
printf 'created\ncreated\nstopped\n' > "$machine_states"
read_machine_state() {
  local state
  state="$(head -1 "$machine_states")"
  tail -n +2 "$machine_states" > "$machine_states.next"
  mv "$machine_states.next" "$machine_states"
  printf '%s\n' "$state"
}
cloudbench_wait_machine_startable read_machine_state machine-1 3 0 ||
  fail "a provisioning clone must wait until it becomes stopped/startable"
[ ! -s "$machine_states" ] || fail "the startable-state wait must consume the transition sequence"

printf 'created\ndestroyed\n' > "$machine_states"
if cloudbench_wait_machine_startable read_machine_state machine-2 3 0 >/dev/null 2>&1; then
  fail "a destroyed provisioning clone must fail closed"
fi

# Warm-source fleet gate: transitional donor states must wait for stopped, not
# abort (observed: state=started / replacing → immediate fleet INFRA fail).
printf 'started\nreplacing\nstopped\n' > "$machine_states"
cloudbench_wait_machine_stopped read_machine_state warm-0 3 0 ||
  fail "warm source wait must tolerate started→replacing→stopped"
[ ! -s "$machine_states" ] || fail "started→replacing→stopped wait must consume the sequence"

printf 'replacing\nstopping\nstopped\n' > "$machine_states"
cloudbench_wait_machine_stopped read_machine_state warm-1 5 0 ||
  fail "warm source wait must tolerate replacing→stopping→stopped"
[ ! -s "$machine_states" ] || fail "the stopped-state wait must consume the transition sequence"

printf 'creating\nupdating\nrestarting\nstopped\n' > "$machine_states"
cloudbench_wait_machine_stopped read_machine_state warm-2 5 0 ||
  fail "warm source wait must tolerate creating/updating/restarting as transitional"
[ ! -s "$machine_states" ] || fail "creating/updating/restarting wait must consume the sequence"

printf 'started\nstarted\nstarted\n' > "$machine_states"
if cloudbench_wait_machine_stopped read_machine_state warm-stuck 3 0 >/dev/null 2>&1; then
  fail "warm source wait must fail closed when the donor never stops"
fi

printf 'started\ndestroyed\n' > "$machine_states"
if cloudbench_wait_machine_stopped read_machine_state warm-gone 3 0 >/dev/null 2>&1; then
  fail "warm source wait must fail closed when the donor is destroyed"
fi

require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'cloudbench_wait_machine_stopped pool_machine_state "$WARM_ID"' \
  "fleet must wait for the shared warm source to stop before cloning"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'stopping|replacing|starting)' \
  "machine start must wait out Fly stopping/replacing before request_machine_start"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'build_controller_authenticated_git_sync_cmd' \
  "controller authenticated git-sync helper must remain available for stdin/SFTP delivery"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'ssh_exec_controller_git_sync' \
  "controller git-sync must deliver the auth header via stdin, not argv"


cloudbench_validate_fresh_clone_id clone-2 warm-1 clone-1 ||
  fail "a unique non-source clone id must be accepted"
if cloudbench_validate_fresh_clone_id warm-1 warm-1 clone-1; then
  fail "the warm source id must never be accepted as a fresh clone"
fi
if cloudbench_validate_fresh_clone_id clone-1 warm-1 clone-1; then
  fail "a duplicate clone id must never be accepted"
fi

activation_ids="$(printf '%s\n' '[{"id":"warm-1","name":"cloudbench-warm","state":"stopped"},{"id":"lock-1","name":"cloudbench-controller-lock","state":"stopped"},{"id":"clone-1","name":"fleet-1","state":"stopped"},{"id":"provisioning-1","name":"other-controller-clone","state":"created"},{"id":"running-1","name":"other-controller-run","state":"started"}]' | cloudbench_env_activation_machine_ids)"
[ "$activation_ids" = $'warm-1\nclone-1' ] ||
  fail "environment activation must target only stopped non-lock benchmark machines"

node_a="$TMP_ROOT/node-a"
node_b="$TMP_ROOT/node-b"
mkdir -p "$node_a/back-end" "$node_a/front-end" "$node_b/back-end" "$node_b/front-end"
printf '{"lockfileVersion":3,"packages":{"generated":"old"}}\n' > "$node_a/package-lock.json"
printf '{"lockfileVersion":3,"packages":{"generated":"new"}}\n' > "$node_b/package-lock.json"
printf '{"lockfileVersion":3,"packages":{}}\n' > "$node_a/back-end/package-lock.json"
cp "$node_a/back-end/package-lock.json" "$node_b/back-end/package-lock.json"
printf '{"scripts":{"test":"old"},"dependencies":{"tsx":"1.0.0"}}\n' > "$node_a/package.json"
printf '{"scripts":{"test":"new"},"dependencies":{"tsx":"1.0.0"}}\n' > "$node_b/package.json"
for relative in back-end/package.json front-end/package.json; do
  printf '{"scripts":{"test":"old"}}\n' > "$node_a/$relative"
  printf '{"scripts":{"test":"new"}}\n' > "$node_b/$relative"
done
node_a_fingerprint="$(cloudbench_node_dependency_fingerprint "$node_a")"
node_b_fingerprint="$(cloudbench_node_dependency_fingerprint "$node_b")"
[ "$node_a_fingerprint" = "$node_b_fingerprint" ] ||
  fail "scripts and the generated root lock must not invalidate baked dependencies"
printf '{"scripts":{"test":"new"},"dependencies":{"tsx":"2.0.0"}}\n' > "$node_b/package.json"
node_b_fingerprint="$(cloudbench_node_dependency_fingerprint "$node_b")"
[ "$node_a_fingerprint" != "$node_b_fingerprint" ] ||
  fail "dependency field changes must invalidate baked dependencies"
printf '{"lockfileVersion":3,"packages":{"":{"engines":{"node":"22.23.4"}}}}\n' > "$node_a/back-end/package-lock.json"
printf '{"lockfileVersion":3,"packages":{"":{"engines":{"node":"24.22.1"}}}}\n' > "$node_b/back-end/package-lock.json"
printf '{"scripts":{"test":"old"},"dependencies":{"tsx":"1.0.0"}}\n' > "$node_b/package.json"
node_a_fingerprint="$(cloudbench_node_dependency_fingerprint "$node_a")"
node_b_fingerprint="$(cloudbench_node_dependency_fingerprint "$node_b")"
[ "$node_a_fingerprint" = "$node_b_fingerprint" ] ||
  fail "runtime-only engines changes must not invalidate baked dependencies"
printf '{"lockfileVersion":3,"packages":{"":{"engines":{"node":"24.22.1"}},"node_modules/tsx":{"version":"2.0.0"}}}\n' > "$node_b/back-end/package-lock.json"
node_b_fingerprint="$(cloudbench_node_dependency_fingerprint "$node_b")"
[ "$node_a_fingerprint" != "$node_b_fingerprint" ] ||
  fail "locked package changes must invalidate baked dependencies"

lock_file="$TMP_ROOT/controller.lock"
cloudbench_controller_lock_acquire "$lock_file"
if bash -c 'source "$1"; cloudbench_controller_lock_acquire "$2"' _ "$HELPER_SRC" "$lock_file"; then
  fail "a second controller must not acquire an owned lock"
fi

lock_wait_attempts=0
lock_wait_sleeps=0
cloudbench_controller_lock_acquire() {
  lock_wait_attempts=$((lock_wait_attempts + 1))
  [ "$lock_wait_attempts" -ge 3 ]
}
sleep() {
  [ "$1" = "7" ] || fail "controller lock wait used the wrong retry interval"
  lock_wait_sleeps=$((lock_wait_sleeps + 1))
}
cloudbench_controller_lock_acquire_wait "$lock_file" 7 ||
  fail "controller lock wait must continue until its live owner releases"
[ "$lock_wait_attempts" -eq 3 ] ||
  fail "controller lock wait must retry owned lock contention"
[ "$lock_wait_sleeps" -eq 2 ] ||
  fail "controller lock wait must sleep once per owned lock contention result"
unset -f cloudbench_controller_lock_acquire sleep

cloudbench_controller_lock_release "$lock_file"
[ ! -e "$lock_file" ] || fail "controller lock must be removed by its owner"

# Concurrent-workstream contract: the RUN path takes only the workspace-local
# controller lock and treats shared app state as READ-ONLY. Cross-host leases
# and per-run env refreshes were removed on purpose — a second workstream must
# never be blocked by (or race) another's run.
if grep -Fq -- 'cloudbench_controller_acquire' "$ROOT_DIR/scripts/run-bench-fleet"; then
  fail "fleet controllers must not take the cross-host Fly sentinel lease (workspace-local lock only)"
fi
if grep -Fq -- 'cloudbench_cloud_lock_acquire' "$HELPER_SRC"; then
  fail "the removed cross-host sentinel lease must not return to the shared helpers"
fi
if grep -Fq -- 'run-bench-cloud --refresh-secrets;' "$ROOT_DIR/scripts/run-bench-fleet"; then
  fail "the fleet run path must not refresh (mutate) the shared environment — verify only"
fi
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'bash "$RUN_BENCH_CLOUD_BIN" --verify-secrets' \
  "fleet controller must read-only verify the environment before cloning"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'cloudbench_controller_lock_acquire_wait' \
  "fleet controllers must wait for the workspace-local controller lock"
require_text "$ROOT_DIR/scripts/run-predeploy-cloud" \
  'bash "$ROOT_DIR/scripts/tests/cloudbench-multi-workstream.test.sh"' \
  "pre-deploy cloud gate must run the permanent concurrency regression"
require_text "$ROOT_DIR/scripts/run-predeploy-cloud" \
  'bash "$ROOT_DIR/scripts/tests/cloudbench-acceptance-autoscale.test.sh"' \
  "pre-deploy cloud gate must reject every autoscale off-state"
# deploy.md carries no test list: the deploy plan's cloudbench-controller gate
# (scripts/run-cloudbench-controller-local.py) executes the regression.
require_text "$ROOT_DIR/scripts/run-cloudbench-controller-local.py" \
  "('autoscale', 'bash scripts/tests/cloudbench-acceptance-autoscale.test.sh')," \
  "deploy must execute the permanent mandatory-autoscale regression"
require_text "$ROOT_DIR/scripts/deploy_test_plan.py" \
  '{"name": "cloudbench-controller", "command": [sys.executable, "scripts/run-cloudbench-controller-local.py"],' \
  "the deploy plan must run the cloudbench-controller gate that executes the autoscale regression"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'CLOUDBENCH_ENV_VERIFIED=1' \
  "fleet children must receive proof that the controller verified the environment"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'write_pool_claim "$claim_path"' \
  "pool claims must use the atomic host/PID-birth ownership writer"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'printf '"'"'pid_start=%s\n'"'"' "$FLEET_OWNER_PID_START"' \
  "pool and fleet ownership must disambiguate PID reuse"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'verify_app_environment' \
  "run-bench-cloud must expose the read-only environment preflight"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'FLY secrets list -a "$APP" --json' \
  "the environment preflight must be a read-only secrets listing"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'REQUIRED_APP_SECRETS="AGENTS_ENV_B64 BACKEND_ENV_B64 AGENTS_ENV_SHA256 BACKEND_ENV_SHA256 CLOUDBENCH_BROWSER_PROVIDER CLOUDBENCH_WORKER_BROWSER_PROVIDER GITHUB_TOKEN"' \
  "environment preflight must require GITHUB_TOKEN for on-box private-repo git-sync"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'resolve_durable_github_token' \
  "Fly secret injection must use a durable GitHub token, not an ephemeral gh auth token"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'GITHUB_DISPATCH_TOKEN' \
  "token resolution must fall back to GITHUB_DISPATCH_TOKEN when GITHUB_TOKEN is stale"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'warm_source_fetch_ref' \
  "refresh-deps/wmh must sync via warm_source_fetch_ref (controller token + fetch-ref.sh)"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  't="${GITHUB_TOKEN:-${GH_TOKEN:-}}"' \
  "resolve_github_token must honor exported GITHUB_TOKEN/GH_TOKEN before durable dotenv fallback"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'resolve_github_token' \
  "warm-source git-sync must Contents-validate via resolve_github_token"

# Owning-boundary regression: a stale/empty warm-box GITHUB_TOKEN must not be
# the only auth path for refresh-deps. warm_source_fetch_ref uses the controller
# token + cloudbench-fetch-ref.sh (same as guest drivers).
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'cloudbench-fetch-ref.sh' \
  "refresh-deps SSH sync must use cloudbench-fetch-ref.sh with a controller token"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'warm_source_fetch_ref "$mid" "$EXPECTED_REF"' \
  "refresh-deps must call warm_source_fetch_ref for the exact expected ref"require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'FLY secrets set --stage -a "$APP"' \
  "Machines API apps must stage the app-level environment before machine updates"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'transient Fly update failure; retrying machine $machine_id' \
  "machine environment activation must retry transient Fly API failures"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'update_args=(machine update "$machine_id" -a "$APP")' \
  "every owned benchmark machine must build a scoped Fly update command"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'update_args+=(--skip-start --yes)' \
  "every owned benchmark machine must activate staged secrets without starting"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'update_args+=(--image "$image_ref")' \
  "dependency image refresh must reuse the stopped-machine activation boundary"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'activation_targets="$(environment_activation_targets)"' \
  "environment activation must be scoped to the owned warm source and pool"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'activate_machine_environment "$machine_id" "$role"' \
  "environment activation must preserve role-specific concurrency checks"
if grep -Fq -- 'cloudbench_wait_machine_startable fleet_machine_state "$cid"' \
  "$ROOT_DIR/scripts/run-bench-fleet"; then
  fail "fleet controller must delegate created-clone storage/start lifecycle to run-bench-cloud"
fi
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'if machine_storage_ready "$mid"; then' \
  "cloud child must wait for clone storage before requesting start"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'request_machine_start "$mid"' \
  "cloud child must own the transition from created to started"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  '--name "$target_name"' \
  "fresh fleet clones must use an exact unique name for id resolution"
if grep -Fq -- 'FLY secrets deploy' "$ROOT_DIR/scripts/run-bench-cloud"; then
  fail "Machines API apps must not use Fly Launch secrets deploy"
fi
require_text "$ROOT_DIR/scripts/cloudbench-run.sh" \
  'cloudbench_verify_env_file' \
  "primary benchmark machines must verify decoded env digests"
require_text "$ROOT_DIR/scripts/cloudbench-worker.sh" \
  'cloudbench_verify_env_file' \
  "autoscaled benchmark workers must refresh and verify their env files"
require_text "$ROOT_DIR/scripts/cloudbench-worker.sh" \
  'umask 077' \
  "decoded benchmark secrets must be owner-only from file creation"
require_text "$ROOT_DIR/scripts/cloudbench-sync-deps.sh" \
  'cloudbench_node_dependency_fingerprint' \
  "cloud dependency sync must ignore package scripts while binding dependency fields"
if grep -Fq -- 'eval "exec ${CLOUDBENCH_CONTROLLER_LOCK_FD}' "$HELPER_SRC"; then
  fail "controller lock fd cleanup must not use eval"
fi
require_text "$HELPER_SRC" \
  'exec {CLOUDBENCH_CONTROLLER_LOCK_FD}<> "$path"' \
  "flock fallback must open without truncating the current owner"
require_text "$ROOT_DIR/scripts/run-bench-hub-poller" \
  'exit_code" -ne "$CLOUDBENCH_CAPACITY_BUSY_EXIT_CODE' \
  "hub requests must retry only the typed capacity-busy runner status"

# ── Ledger-only unpushed HEAD must not abort a fleet launch ──────────────────
# RCA (2026-07-27): /descend commits its append-only timing ledger before every
# sync, so a descent starting from a clean branch has exactly one unpushed
# commit touching only agents/benchmarks/history/*.jsonl. run-bench-fleet gated
# patch creation on "local HEAD != fetchable base", but create-worktree-patch.sh
# deliberately EXCLUDES those union-merge ledgers, so it emitted an empty patch
# and the controller treated empty as fatal:
#   "❌ could not create the fleet local workspace patch" → exit 1, zero benches.
# The gate and the patch content must share one definition of "shippable delta",
# and "nothing to ship" must run the base ref instead of aborting.
patch_repo="$TMP_ROOT/ledger-only-repo"
mkdir -p "$patch_repo/agents/benchmarks/history"
git -C "$patch_repo" init -q
git -C "$patch_repo" config user.email "bench@example.com"
git -C "$patch_repo" config user.name "Bench"
printf 'print("under test")\n' > "$patch_repo/service.py"
printf '{"run":"a"}\n' > "$patch_repo/agents/benchmarks/history/descend_steps.jsonl"
git -C "$patch_repo" add -A
git -C "$patch_repo" commit -qm "base"
ledger_base="$(git -C "$patch_repo" rev-parse HEAD)"

# The one unpushed commit a /descend run always makes before syncing.
printf '{"run":"b"}\n' >> "$patch_repo/agents/benchmarks/history/descend_steps.jsonl"
git -C "$patch_repo" add -A
git -C "$patch_repo" commit -qm "chore(descend): timing ledger rows"

# Pre-condition: the patch generator itself succeeds but has nothing to ship.
ledger_patch="$TMP_ROOT/ledger-only.patch"
bash "$ROOT_DIR/scripts/create-worktree-patch.sh" "$patch_repo" "$ledger_base" > "$ledger_patch" \
  || fail "create-worktree-patch.sh must succeed for a ledger-only delta"
if [ -s "$ledger_patch" ]; then
  fail "ledger-only delta must produce an empty patch (the excluded-ledger contract)"
fi

# A ledger-only delta must be reported as "no shippable delta", not as failure.
prepared_patch="$TMP_ROOT/prepared.patch"
prepare_rc=0
cloudbench_prepare_workspace_patch "$patch_repo" "$ledger_base" "$prepared_patch" \
  "$ROOT_DIR/scripts/create-worktree-patch.sh" || prepare_rc=$?
if [ "$prepare_rc" -ne "$CLOUDBENCH_PATCH_NO_DELTA" ]; then
  fail "ledger-only unpushed HEAD must report no-shippable-delta (rc=$CLOUDBENCH_PATCH_NO_DELTA), got rc=$prepare_rc"
fi
if [ -s "$prepared_patch" ]; then
  fail "no-shippable-delta must not leave a declared patch payload behind"
fi

# A real source change on top of the same ledger commit must still ship.
printf 'print("changed")\n' > "$patch_repo/service.py"
prepare_rc=0
cloudbench_prepare_workspace_patch "$patch_repo" "$ledger_base" "$prepared_patch" \
  "$ROOT_DIR/scripts/create-worktree-patch.sh" || prepare_rc=$?
[ "$prepare_rc" -eq 0 ] \
  || fail "a real worktree change must still produce a shippable patch (rc=$prepare_rc)"
[ -s "$prepared_patch" ] \
  || fail "a real worktree change must produce a non-empty patch payload"
grep -Fq 'service.py' "$prepared_patch" \
  || fail "the shippable patch must carry the changed source file"
if grep -Fq 'descend_steps.jsonl' "$prepared_patch"; then
  fail "the shippable patch must still exclude append-only history ledgers"
fi

# A local bare remote is not the canonical private repository fetched by guests.
# Even a current origin/* tracking ref cannot alone establish delivery authority.
# Authenticated live-origin admission and stale/deleted-ref controls are exercised
# by test_boot_payload_fetchable_source_uses_authenticated_live_origin in the
# owning dependency suite; this local-only fixture must retain complete patches.
feature_repo="$TMP_ROOT/fetchable-ref"
git init -q "$feature_repo"
git -C "$feature_repo" config user.email cloudbench-test@example.com
git -C "$feature_repo" config user.name cloudbench-test
printf 'main\n' > "$feature_repo/payload.txt"
git -C "$feature_repo" add payload.txt
git -C "$feature_repo" commit -qm main
git -C "$feature_repo" branch -M main
git init -q --bare "$TMP_ROOT/fetchable-origin.git"
git -C "$feature_repo" remote add origin "$TMP_ROOT/fetchable-origin.git"
git -C "$feature_repo" push -q origin HEAD:main
main_sha="$(git -C "$feature_repo" rev-parse HEAD)"
git -C "$feature_repo" checkout -q -b cursor/example-53b6
printf 'feature\n' >> "$feature_repo/payload.txt"
git -C "$feature_repo" commit -qam feature
git -C "$feature_repo" push -q origin HEAD:cursor/example-53b6
feature_sha="$(git -C "$feature_repo" rev-parse HEAD)"
git -C "$feature_repo" fetch -q origin
resolved="$(cloudbench_fetchable_ref "$feature_repo" "$feature_sha" 1)"
[ "$resolved" = "$main_sha" ] \
  || fail "fetchable_ref must use origin/main for an unverified local-only remote (got $resolved, want $main_sha)"
if ! cloudbench_fetchable_ref "$feature_repo" "$feature_sha" 1 >/dev/null 2>"$TMP_ROOT/fetchable.err"; then
  fail "allow-local-patch must succeed by falling back to origin/main"
fi
grep -Fq 'not on origin' "$TMP_ROOT/fetchable.err" \
  || fail "fetchable_ref must explain that a feature-only SHA is not guest-fetchable"

# A genuinely broken generation (unresolvable base ref) stays a hard failure.
prepare_rc=0
cloudbench_prepare_workspace_patch "$patch_repo" "definitely-not-a-ref" "$prepared_patch" \
  "$ROOT_DIR/scripts/create-worktree-patch.sh" >/dev/null 2>&1 || prepare_rc=$?
if [ "$prepare_rc" -ne 1 ]; then
  fail "an unresolvable base ref must stay a hard patch-generation failure (rc=$prepare_rc)"
fi

# Both cloud controllers must route through the shared helper so the launch gate
# can never again disagree with what the patch generator actually emits.
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'cloudbench_prepare_workspace_patch' \
  "fleet controller must prepare its patch through the shared helper"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'cloudbench_prepare_workspace_patch' \
  "cloud controller must prepare its patch through the shared helper"


# ── Machine readiness must fail closed (descend antibot, epoch 4) ────────────
# A whole 7-bench fleet run aborted before provisioning ANY task machine:
#   ▶️  Starting machine 683e47df5094d8 ...
#   ✅ Machine started
#   ⚠️  SSH did not become reachable on 683e47df5094d8 — proceeding (...)
#   🔄 git-syncing /data/repo → f56705fec ...
#      Error: app navi-whisper-lux-bench has no started VMs.
#   ❌ exact remote checkout failed
#   ❌ central dep refresh failed; refusing to provision task machines
# Both readiness gates returned SUCCESS after exhausting their budgets, so the
# controller exec'd into a machine that was not up and the real constraint
# surfaced as an unrelated-looking checkout error. Readiness must fail closed.
readiness_function() {
  awk -v function_name="$1" '
    $0 ~ "^" function_name "\\(\\)" { capture = 1 }
    capture { print }
    capture && /^}$/ { exit }
  ' "$ROOT_DIR/scripts/run-bench-cloud"
}

readiness_failures=0

# The shared warm source is durable provider state and can retain a stale or
# malformed init command across workstreams. Every maintenance resize must
# restore the known keepalive before start; otherwise Fly reports "started" and
# the VM exits cleanly seconds later.
(
  function_body="$(readiness_function resize_stopped_warm_source)"
  [ -n "$function_body" ] || fail "could not load production resize_stopped_warm_source"
  eval "$function_body"
  APP="cloudbench-readiness-regression"
  resize_args="$TMP_ROOT/warm-resize.args"
  machine_state() { echo stopped; }
  FLY() { printf '%s\n' "$*" > "$resize_args"; }
  resize_stopped_warm_source warm-1 shared-cpu-4x 8192 maintenance >/dev/null ||
    fail "warm-source maintenance resize must succeed"
  grep -Fq -- '--command sleep infinity' "$resize_args" ||
    fail "warm-source resize must normalize the durable keepalive command"
) || readiness_failures=$((readiness_failures + 1))

(
  function_body="$(readiness_function wait_for_ssh)"
  [ -n "$function_body" ] || fail "could not load production wait_for_ssh"
  eval "$function_body"
  APP="cloudbench-readiness-regression"
  CLOUDBENCH_SSH_WAIT_ATTEMPTS=2
  CLOUDBENCH_SSH_WAIT_SLEEP_SECONDS=0
  CLOUDBENCH_SSH_PROBE_TIMEOUT_SECONDS=1
  probe_calls=0
  raw_fly_calls=0
  ssh_ready() {
    probe_calls=$((probe_calls + 1))
    return 1
  }
  FLY() {
    raw_fly_calls=$((raw_fly_calls + 1))
    return 1
  }
  machine_state() { echo started; }
  sleep() { :; }               # keep the pre-fix reproduction fast
  rc=0
  wait_for_ssh mach-never-ssh >/dev/null 2>&1 || rc=$?
  [ "$rc" -ne 0 ] ||
    fail "wait_for_ssh must fail closed when SSH never answers (rc=$rc)"
  [ "$probe_calls" -eq 2 ] ||
    fail "wait_for_ssh must use the bounded ssh_ready probe exactly once per attempt"
  [ "$raw_fly_calls" -eq 0 ] ||
    fail "wait_for_ssh must not bypass the bounded SSH timeout path"
) || readiness_failures=$((readiness_failures + 1))

(
  function_body="$(readiness_function start_machine)"
  [ -n "$function_body" ] || fail "could not load production start_machine"
  eval "$function_body"
  CLOUDBENCH_MACHINE_START_ATTEMPTS=2
  CLOUDBENCH_MACHINE_START_SLEEP_SECONDS=0
  machine_state() { echo stopped; }        # never reaches started
  machine_storage_ready() { return 0; }
  request_machine_start() { return 0; }
  sleep() { :; }               # keep the pre-fix reproduction fast
  rc=0
  start_machine mach-never-starts >/dev/null 2>&1 || rc=$?
  [ "$rc" -ne 0 ] ||
    fail "start_machine must fail closed when the machine never reaches started (rc=$rc)"
) || readiness_failures=$((readiness_failures + 1))

# A recoverable started→stopped race must re-assert start (after waiting out
# Fly stopping/replacing), then accept the bounded readiness proof.
(
  function_body="$(readiness_function wait_for_ssh)"
  [ -n "$function_body" ] || fail "could not load production wait_for_ssh"
  eval "$function_body"
  CLOUDBENCH_SSH_WAIT_ATTEMPTS=2
  CLOUDBENCH_SSH_WAIT_SLEEP_SECONDS=0
  current_state=stopped
  restart_calls=0
  ssh_ready() { [ "$current_state" = "started" ]; }
  machine_state() { echo "$current_state"; }
  request_machine_start() {
    restart_calls=$((restart_calls + 1))
    current_state=started
  }
  date() { echo 1000; }
  sleep() { :; }
  wait_for_ssh mach-recovers >/dev/null 2>&1 ||
    fail "wait_for_ssh must recover one stopped→started transition"
  [ "$restart_calls" -eq 1 ] ||
    fail "wait_for_ssh must re-assert a regressed machine start (calls=$restart_calls)"
) || readiness_failures=$((readiness_failures + 1))

# If the machine is still stopping when SSH probes, wait — do not fire a bare
# start into Fly's failed_precondition window (files-in-sub-agents fleet log).
(
  function_body="$(readiness_function wait_for_ssh)"
  [ -n "$function_body" ] || fail "could not load production wait_for_ssh"
  eval "$function_body"
  CLOUDBENCH_SSH_WAIT_ATTEMPTS=5
  CLOUDBENCH_SSH_WAIT_SLEEP_SECONDS=0
  # machine_state runs in $(...), so the cursor must live on disk — a shell
  # variable would reset every probe and never leave "stopping".
  # Timeline: stopping → stopping → stopped → (start issued) → started
  idx_file="$TMP_ROOT/wait-ssh-stopping-idx"
  echo 0 > "$idx_file"
  states_file="$TMP_ROOT/wait-ssh-stopping-states"
  printf '%s\n' stopping stopping stopped started started > "$states_file"
  restart_file="$TMP_ROOT/wait-ssh-stopping-restarts"
  echo 0 > "$restart_file"
  current_state() {
    local idx
    idx="$(cat "$idx_file")"
    sed -n "$((idx + 1))p" "$states_file"
  }
  advance_state() {
    local idx
    idx="$(cat "$idx_file")"
    if [ "$idx" -lt 4 ]; then
      echo $((idx + 1)) > "$idx_file"
    fi
  }
  ssh_ready() {
    [ "$(current_state)" = "started" ]
  }
  machine_state() {
    local s
    s="$(current_state)"
    advance_state
    echo "$s"
  }
  request_machine_start() {
    echo $(( $(cat "$restart_file") + 1 )) > "$restart_file"
  }
  date() { echo 1000; }
  sleep() { :; }
  wait_for_ssh mach-stopping-race >/dev/null 2>&1 ||
    fail "wait_for_ssh must survive stopping→stopped→started before SSH ready"
  [ "$(cat "$restart_file")" -eq 1 ] ||
    fail "wait_for_ssh must start exactly once after stopping clears (calls=$(cat "$restart_file"))"
) || readiness_failures=$((readiness_failures + 1))

# Exercise the maintenance gate itself: a failed start cannot reach the SSH
# probe, and a failed SSH proof cannot let the caller execute remote work.
(
  function_body="$(readiness_function require_machine_ready)"
  [ -n "$function_body" ] || fail "could not load production require_machine_ready"
  eval "$function_body"
  start_calls=0
  wait_calls=0
  start_machine() {
    start_calls=$((start_calls + 1))
    return 1
  }
  wait_for_ssh() {
    wait_calls=$((wait_calls + 1))
    return 0
  }
  rc=0
  require_machine_ready mach-never-starts >/dev/null 2>&1 || rc=$?
  [ "$rc" -ne 0 ] || fail "maintenance readiness must propagate start failure"
  [ "$start_calls" -eq 1 ] && [ "$wait_calls" -eq 0 ] ||
    fail "maintenance readiness must not probe SSH after start failure"

  start_machine() {
    start_calls=$((start_calls + 1))
    return 0
  }
  wait_for_ssh() {
    wait_calls=$((wait_calls + 1))
    return 1
  }
  remote_exec_marker="$TMP_ROOT/readiness-remote-exec"
  if require_machine_ready mach-never-ssh >/dev/null 2>&1; then
    : > "$remote_exec_marker"
  fi
  [ ! -e "$remote_exec_marker" ] ||
    fail "maintenance work executed after readiness failure"
) || readiness_failures=$((readiness_failures + 1))

# A readiness helper that fails closed is useless if a caller bypasses it. All
# three maintenance paths must use the combined gate, leaving the component
# start and SSH calls reachable only inside that gate.
readiness_call_sites="$(grep -c '^[[:space:]]*require_machine_ready "\$mid" || exit 1$' \
  "$ROOT_DIR/scripts/run-bench-cloud" || true)"
[ "$readiness_call_sites" = "3" ] ||
  fail "all 3 maintenance paths must propagate the combined readiness gate (found=$readiness_call_sites)"
start_call_sites="$(grep -c '^[[:space:]]*start_machine "' \
  "$ROOT_DIR/scripts/run-bench-cloud" || true)"
wait_call_sites="$(grep -c '^[[:space:]]*wait_for_ssh "' \
  "$ROOT_DIR/scripts/run-bench-cloud" || true)"
[ "$start_call_sites" = "1" ] && [ "$wait_call_sites" = "1" ] ||
  fail "start/SSH component calls must remain encapsulated by the readiness gate"

[ "$readiness_failures" -eq 0 ] ||
  fail "$readiness_failures machine-readiness regression case(s) failed"

# ── warm-source resize must retry Fly rate limits (descend I-02) ─────────────
# Epoch-2 fleet abort during --refresh-deps:
#   🧮 sizing warm source for maintenance: shared-cpu-4x/8192MB
#   Error: could not get machine … resource_exhausted: rate limit exceeded
#   ❌ central dep refresh failed; refusing to provision task machines
# Relative of 2026-07-15 clone rate-limit RCAs: resize_stopped_warm_source was
# single-shot, so a transient org limiter abort killed the whole slice before
# any task machine existed.
(
  function_body="$(awk '
    $0 ~ /^resize_stopped_warm_source\(\)/ { capture = 1 }
    capture { print }
    capture && /^}$/ { exit }
  ' "$ROOT_DIR/scripts/run-bench-cloud")"
  [ -n "$function_body" ] || fail "could not load resize_stopped_warm_source"
  eval "$function_body"
  APP="cloudbench-resize-rate-limit"
  CLOUDBENCH_WARM_RESIZE_ATTEMPTS=3
  CLOUDBENCH_WARM_RESIZE_RETRY_SECONDS=0
  CLOUDBENCH_WARM_RESIZE_RETRY_MAX_SECONDS=0
  RANDOM=0
  # FLY runs inside $(...), so a shell variable counter cannot cross attempts.
  call_file="$TMP_ROOT/warm-resize-calls"
  echo 0 > "$call_file"
  machine_state() { echo stopped; }
  stop_machine_strict() { return 0; }
  sleep() { :; }
  FLY() {
    local c
    c="$(cat "$call_file")"
    c=$((c + 1))
    echo "$c" > "$call_file"
    if [ "$c" -lt 3 ]; then
      echo "Error: could not get machine $3: resource_exhausted: rate limit exceeded" >&2
      return 1
    fi
    return 0
  }
  resize_stopped_warm_source mid-rl shared-cpu-4x 8192 maintenance >/dev/null ||
    fail "resize_stopped_warm_source must succeed after rate-limit retries"
  [ "$(cat "$call_file")" -eq 3 ] ||
    fail "resize_stopped_warm_source must retry rate limits until success (calls=$(cat "$call_file"))"
) || fail "warm-source resize rate-limit retry regression failed"

(
  function_body="$(awk '
    $0 ~ /^resize_stopped_warm_source\(\)/ { capture = 1 }
    capture { print }
    capture && /^}$/ { exit }
  ' "$ROOT_DIR/scripts/run-bench-cloud")"
  eval "$function_body"
  APP="cloudbench-resize-rate-limit"
  CLOUDBENCH_WARM_RESIZE_ATTEMPTS=2
  CLOUDBENCH_WARM_RESIZE_RETRY_SECONDS=0
  CLOUDBENCH_WARM_RESIZE_RETRY_MAX_SECONDS=0
  RANDOM=0
  machine_state() { echo stopped; }
  stop_machine_strict() { return 0; }
  sleep() { :; }
  FLY() {
    echo "Error: could not get machine $3: resource_exhausted: rate limit exceeded" >&2
    return 1
  }
  rc=0
  resize_stopped_warm_source mid-rl shared-cpu-4x 8192 maintenance >/dev/null 2>&1 || rc=$?
  [ "$rc" -ne 0 ] ||
    fail "resize_stopped_warm_source must fail closed after exhausting rate-limit retries"
) || fail "warm-source resize rate-limit exhaustion regression failed"

(
  function_body="$(awk '
    $0 ~ /^resize_stopped_warm_source\(\)/ { capture = 1 }
    capture { print }
    capture && /^}$/ { exit }
  ' "$ROOT_DIR/scripts/run-bench-cloud")"
  eval "$function_body"
  APP="cloudbench-resize-concurrent"
  CLOUDBENCH_WARM_RESIZE_ATTEMPTS=3
  CLOUDBENCH_WARM_RESIZE_RETRY_SECONDS=0
  CLOUDBENCH_WARM_RESIZE_RETRY_MAX_SECONDS=0
  RANDOM=0
  call_file="$TMP_ROOT/warm-resize-concurrent-calls"
  echo 0 > "$call_file"
  machine_state() { echo stopped; }
  stop_machine_strict() { return 0; }
  sleep() { :; }
  FLY() {
    local c
    c="$(cat "$call_file")"
    c=$((c + 1))
    echo "$c" > "$call_file"
    if [ "$c" -lt 3 ]; then
      echo "Error: aborted: machine version changed: concurrent update in progress" >&2
      return 1
    fi
    return 0
  }
  resize_stopped_warm_source mid-cu shared-cpu-4x 8192 maintenance >/dev/null ||
    fail "resize_stopped_warm_source must retry concurrent-update aborts"
  [ "$(cat "$call_file")" -eq 3 ] ||
    fail "concurrent-update retries must reach success (calls=$(cat "$call_file"))"
) || fail "warm-source resize concurrent-update retry regression failed"

# ── refresh-deps / refresh-wmh git-sync must use controller token (descend I-01) ──
# Observed fleet abort before any task machine was provisioned:
#   🔄 git-syncing /data/repo → <sha> ...
#      fatal: could not read Username for 'https://github.com': No such device or address
#      Error: ssh shell: Process exited with status 128
#   ❌ exact remote checkout failed
#   ❌ central dep refresh failed; refusing to provision task machines
# Root cause: --refresh-deps built AUTH_HDR from optional box-side GITHUB_TOKEN
# (`[ -n "${GITHUB_TOKEN:-}" ] && AUTH_HDR=...`). When the warm machine secret was
# missing, AUTH_HDR stayed empty and git prompted for a Username on a non-TTY.
# Boot-launch already injects CLOUDBENCH_GITHUB_TOKEN_B64 from the controller;
# maintenance git-sync must fail closed the same way and never allow empty auth.
python3 - "$ROOT_DIR/scripts/run-bench-cloud" <<'PY' || fail "refresh-deps/wmh controller-token git-sync contract failed"
import pathlib, re, subprocess, sys, textwrap

src_path = pathlib.Path(sys.argv[1])
src = src_path.read_text()

def mode_block(mode: str) -> str:
    marker = f'if [ "$MODE" = "{mode}" ]; then'
    start = src.find(marker)
    if start < 0:
        raise SystemExit(f"missing {mode} mode block")
    # Take until the matching top-level fi after the mode banner — stop at next MODE block or EOF.
    rest = src[start:]
    next_mode = re.search(r'\nif \[ "\$MODE" = "', rest[1:])
    end = (next_mode.start() + 1) if next_mode else len(rest)
    return rest[:end]

deps = mode_block("refresh-deps")
wmh = mode_block("refresh-wmh")
# refresh-deps + refresh-wmh: shared SHA-pinned warm_source_fetch_ref (fail-closed).
for name, block in (("refresh-deps", deps), ("refresh-wmh", wmh)):
    if "warm_source_fetch_ref" not in block:
        raise SystemExit(f"{name} must call warm_source_fetch_ref")
    for line in block.splitlines():
        if "warm_source_fetch_ref" in line and "|| true" in line:
            raise SystemExit(f"{name} must not mask warm_source_fetch_ref failures")
    if "GITHUB_TOKEN:-" in block and "build_controller_authenticated_git_sync_cmd" in block:
        raise SystemExit(f"{name} must not optionally skip AUTH_HDR when box GITHUB_TOKEN is empty")
if "WMH_CONFORMANCE_EXAMPLES=100" not in wmh or "WMH_REQUIRE_CONFORMANCE=1" not in wmh:
    raise SystemExit("refresh-wmh must fail closed on the 100-example real-trajectory conformance suite")

def extract_bash_function(source: str, name: str) -> str:
    marker = f"{name}() {{"
    start = source.find(marker)
    if start < 0:
        # Allow a comment between ) and {
        import re as _re
        m = _re.search(rf"^{name}\(\)[^\n]*\n\{{", source, flags=_re.M)
        if not m:
            raise SystemExit(f"{name} helper is missing")
        start = m.start()
        brace_at = source.find("{", m.start())
    else:
        brace_at = source.find("{", start)
    depth = 0
    for idx in range(brace_at, len(source)):
        ch = source[idx]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return source[start : idx + 1]
    raise SystemExit(f"{name} helper is missing closing brace")

# warm_source_fetch_ref must Contents-validate via resolve_github_token (not
# unvalidated cloudbench_controller_github_token).
warm_fn = extract_bash_function(src, "warm_source_fetch_ref")
if "resolve_github_token" not in warm_fn:
    raise SystemExit("warm_source_fetch_ref must use resolve_github_token")
if "cloudbench_controller_github_token" in warm_fn:
    raise SystemExit("warm_source_fetch_ref must not use unvalidated cloudbench_controller_github_token")

# --setup clone: keep AUTH_HDR off git argv; use GIT_CONFIG_GLOBAL; wipe remotes
# on partial SFTP failure so a lone token file cannot linger.
clone_start = src.find("SETUP_GITHUB_TOKEN=")
clone_end = src.find("park_warm_source", clone_start)
if clone_start < 0 or clone_end < 0:
    raise SystemExit("--setup clone block missing")
clone = src[clone_start:clone_end]
if "GIT_CONFIG_GLOBAL" not in clone:
    raise SystemExit("--setup clone must use GIT_CONFIG_GLOBAL for http.extraheader")
if "-c http.extraheader=" in clone:
    raise SystemExit("--setup clone must not put AUTH_HDR on git -c argv")
if "rm -f '$remote_setup_token' '$remote_setup_cmd'" not in clone:
    raise SystemExit("--setup must rm remote token/cmd on SFTP failure")
# Existing-repo fetch must reset origin to the trusted URL BEFORE git_auth so a
# retained/altered remote cannot receive the controller token.
fetch_idx = clone.find("repo already present")
if fetch_idx < 0:
    raise SystemExit("--setup existing-repo fetch branch missing")
fetch_branch = clone[fetch_idx : clone.find("else", fetch_idx)]
set_url_at = fetch_branch.find("remote set-url origin")
fetch_at = fetch_branch.find("fetch --quiet origin")
if set_url_at < 0 or fetch_at < 0 or set_url_at > fetch_at:
    raise SystemExit("--setup must set trusted origin before authenticated fetch")

helper = extract_bash_function(src, "build_controller_authenticated_git_sync_cmd")

auth_bits = [
    extract_bash_function(src, name)
    for name in (
        "token_to_git_auth_header",
        "resolve_durable_github_token",
        "resolve_github_token",
        "resolve_controller_git_auth_header",
    )
]
auth_helper = "\n".join(auth_bits)

deliver = extract_bash_function(src, "ssh_exec_controller_git_sync")
if "AUTH_HDR_DURABLE" not in deliver:
    raise SystemExit("stdin delivery must support durable AUTH_HDR_DURABLE retry")
if "resolve_durable_github_token" not in deliver:
    raise SystemExit("stdin delivery must resolve a durable fallback token")
if "sftp put" not in deliver:
    raise SystemExit("git-sync delivery must SFTP credentials (fly ssh -C does not forward stdin)")
if "Authorization: Basic" in deliver.split("-C", 1)[-1]:
    raise SystemExit("AUTH_HDR must not appear in the fly ssh -C argument")
if "remote_auth" not in deliver and "cloudbench-git-sync-auth" not in deliver:
    raise SystemExit("git-sync delivery must stage a remote auth file path")

# Fail closed with no token.
script = auth_helper + "\n" + helper + textwrap.dedent(
    """
    resolve_github_token() { echo ""; }
    resolve_durable_github_token() { echo ""; }
    gh() { return 1; }
    build_controller_authenticated_git_sync_cmd /data/repo abcdef
    """
)
# Run via a tempfile — bash -c mangles the nested quotes inside the multi-line
# helper body (syntax error EOF). File execution preserves the source exactly.
import tempfile, os
with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as fh:
    fh.write(script)
    fail_path = fh.name
try:
    proc = subprocess.run(["bash", fail_path], capture_output=True, text=True)
finally:
    os.unlink(fail_path)
if proc.returncode == 0:
    raise SystemExit("helper must fail closed when no controller GitHub token is available")
if "No controller GitHub token" not in (proc.stderr + proc.stdout):
    raise SystemExit("helper must name the missing controller GitHub token")

# With a token, emit a script that consumes AUTH_HDR via GIT_CONFIG_* — never
# embed the Basic auth header in the returned command (argv leak via fly -C).
script = auth_helper + "\n" + helper + textwrap.dedent(
    """
    resolve_github_token() { echo "ghp_test_token_for_sync_cmd"; }
    resolve_durable_github_token() { echo "ghp_durable_token_for_sync_cmd"; }
    gh() { return 1; }
    build_controller_authenticated_git_sync_cmd /data/repo abcdef0123456789
    """
)
with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as fh:
    fh.write(script)
    ok_path = fh.name
try:
    proc = subprocess.run(["bash", ok_path], capture_output=True, text=True)
finally:
    os.unlink(ok_path)
if proc.returncode != 0:
    raise SystemExit(f"helper must succeed with a controller token: {proc.stderr}")
cmd = proc.stdout
if "_try_fetch" not in cmd:
    raise SystemExit("authenticated sync cmd must use _try_fetch for primary→durable retry")
if "GIT_CONFIG_KEY_0=http.extraheader" not in cmd:
    raise SystemExit("authenticated sync cmd must set http.extraheader via GIT_CONFIG_*")
if "primary GitHub token auth failed; retrying with durable fallback" not in cmd:
    raise SystemExit("authenticated sync cmd must retry with durable AUTH_HDR_DURABLE")
if "GITHUB_TOKEN:-" in cmd:
    raise SystemExit("authenticated sync cmd must not optionally clear AUTH_HDR")
if "Authorization: Basic" in cmd or "x-access-token:" in cmd or "ghp_test_token" in cmd:
    raise SystemExit("authenticated sync cmd must not embed the controller token/header")
if "AUTH_HDR" not in cmd:
    raise SystemExit("authenticated sync cmd must require AUTH_HDR from the delivery path")
if "rev-parse FETCH_HEAD" not in cmd or 'checkout -f "$FETCHED_REF"' not in cmd:
    raise SystemExit("authenticated sync cmd must check out FETCH_HEAD, not a stale local ref")
if "checkout -f $ref_q" in cmd or "checkout -f \"$ref_q\"" in cmd:
    raise SystemExit("authenticated sync cmd must not check out the possibly-stale local ref name")

# Auth header resolver must produce x-access-token Basic payload separately.
script = auth_helper + textwrap.dedent(
    """
    resolve_github_token() { echo "ghp_test_token_for_sync_cmd"; }
    resolve_durable_github_token() { echo "ghp_durable_token_for_sync_cmd"; }
    gh() { return 1; }
    resolve_controller_git_auth_header
    """
)
with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as fh:
    fh.write(script)
    hdr_path = fh.name
try:
    proc = subprocess.run(["bash", hdr_path], capture_output=True, text=True)
finally:
    os.unlink(hdr_path)
if proc.returncode != 0:
    raise SystemExit(f"auth header helper must succeed with a controller token: {proc.stderr}")
hdr = proc.stdout.strip()
if not hdr.startswith("Authorization: Basic "):
    raise SystemExit(f"auth header must be Authorization: Basic …, got {hdr!r}")
import base64
payload = base64.b64decode(hdr.split(" ", 2)[2]).decode()
if payload != "x-access-token:ghp_test_token_for_sync_cmd":
    raise SystemExit(f"AUTH_HDR payload must be x-access-token:…, got {payload!r}")
print("controller-token git-sync contract ok")
PY

# ── ssh_exec must controller-bound flyctl (descend I-07) ──
# Guest timeout alone is insufficient: flyctl ssh hung after warm machine stop.
python3 - "$ROOT_DIR/scripts/run-bench-cloud" <<'PY' || fail "ssh_exec controller-side timeout contract failed"
import pathlib, re, subprocess, sys, textwrap, time

src = pathlib.Path(sys.argv[1]).read_text()

def extract_bash_function(source: str, name: str) -> str:
    marker = f"{name}() {{"
    start = source.find(marker)
    if start < 0:
        m = re.search(rf"^{name}\(\)[^\n]*\n\{{", source, flags=re.M)
        if not m:
            raise SystemExit(f"{name} helper is missing")
        start = m.start()
        brace_at = source.find("{", m.start())
    else:
        brace_at = source.find("{", start)
    depth = 0
    for idx in range(brace_at, len(source)):
        ch = source[idx]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return source[start : idx + 1]
    raise SystemExit(f"{name} helper is missing closing brace")

ssh_exec = extract_bash_function(src, "ssh_exec")
if "_with_timeout" not in ssh_exec:
    raise SystemExit("ssh_exec must wrap flyctl ssh via _with_timeout")
if "FLY ssh console" in ssh_exec:
    raise SystemExit("ssh_exec must call flyctl directly (Popen cannot resolve FLY wrapper)")
if "flyctl ssh console" not in ssh_exec:
    raise SystemExit("ssh_exec must invoke flyctl ssh console")

ws = extract_bash_function(src, "warm_source_fetch_ref")
if "CLOUDBENCH_GIT_SYNC_TIMEOUT" not in ws and "GIT_SYNC_TO" not in ws:
    raise SystemExit("warm_source_fetch_ref must pass an explicit git-sync ssh_exec timeout")
if '"$GIT_SYNC_TO"' not in ws:
    raise SystemExit("warm_source_fetch_ref must call ssh_exec with GIT_SYNC_TO")

fetch_ref = (pathlib.Path(sys.argv[1]).parent / "cloudbench-fetch-ref.sh").read_text()
if "already-at" not in fetch_ref:
    raise SystemExit("cloudbench-fetch-ref.sh must short-circuit when HEAD already matches SHA")

wt = extract_bash_function(src, "_with_timeout")
script = wt + textwrap.dedent(
    """
    _with_timeout 2 sleep 30
    exit $?
    """
)
t0 = time.time()
proc = subprocess.run(["bash", "-lc", script], capture_output=True, text=True)
elapsed = time.time() - t0
if proc.returncode != 124:
    raise SystemExit(f"_with_timeout must exit 124 on overrun, got rc={proc.returncode}")
if elapsed > 8 or elapsed < 1.5:
    raise SystemExit(f"_with_timeout wall {elapsed:.1f}s not ~2s")
print("ssh_exec controller-side timeout contract ok")
PY
# An unprovisioned worktree (plain `git worktree add`, no credentials copied)
# used to burn a full fleet launch and then die on a bare "BACKEND_API_KEY is
# required" line that named neither the file it read nor the provisioning step.
hub_key_guard="$(sed -n '/^require_in_app_hub_visibility()/,/^}/p' "$ROOT_DIR/scripts/run-bench-fleet")"
grep -q 'looked in:' <<<"$hub_key_guard" ||
  fail "the in-app Hub key failure must name every source it searched"
grep -q 'back-end/.env does not exist' <<<"$hub_key_guard" ||
  fail "the in-app Hub key failure must distinguish a missing .env from an empty key"
grep -q 'prepare-deploy-worktree.sh' <<<"$hub_key_guard" ||
  fail "the in-app Hub key failure must name the provisioning command that fixes it"

# ── Validated GitHub token for private-repo git-sync (descend I-01 + #1034) ──
# Fleet run 20260820-202356-7298 aborted before any task machine on a stale
# ambient GITHUB_TOKEN. Merged with #1034 durable/ephemeral split: ephemeral
# resolve_github_token validates Contents access; Fly secrets use durable tokens;
# refresh-deps retries durable fallback after primary auth failure.
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'github_token_can_fetch_repo()' \
  "cloudbench must validate GitHub tokens against the private rose repo"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  "git -c credential.helper= ls-remote --exit-code" \
  "token validation must require private Git contents access without consuming REST quota"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=true' \
  "token validation must fail without terminal or askpass prompts"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'resolve_durable_github_token' \
  "Fly secret injection must use a durable GitHub token, not an ephemeral gh auth token"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'set_args+=("GITHUB_TOKEN=$gh_token")' \
  "Fly secret staging must always set GITHUB_TOKEN (empty clears a stale staged credential)"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'env -u GITHUB_TOKEN -u GH_TOKEN -u GH_HOST gh auth token --hostname github.com' \
  "token resolver must ignore ambient GH_TOKEN/GITHUB_TOKEN/GH_HOST when reading gh auth"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  't="${GITHUB_TOKEN:-${GH_TOKEN:-}}"' \
  "resolve_github_token must honor exported GITHUB_TOKEN/GH_TOKEN before durable dotenv fallback"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'build_controller_authenticated_git_sync_cmd' \
  "controller authenticated git-sync helper must remain for stdin/SFTP delivery paths"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'primary GitHub token auth failed; retrying with durable fallback' \
  "authenticated git-sync must retry git fetch with the durable token after primary auth failure"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  '_try_fetch' \
  "authenticated git-sync must try controller primary token then durable fallback via _try_fetch"
# Prove the live resolver rejects the ambient stale GITHUB_TOKEN and still
# returns a credential with Contents access (requires network).
resolve_snippet="$(mktemp)"
awk '
  /^github_token_can_fetch_repo\(\)/ { capture = 1 }
  capture { print }
  capture && /^resolve_render_env_value\(\)/ { exit }
' "$ROOT_DIR/scripts/run-bench-cloud" | sed '$d' > "$resolve_snippet"
resolve_trimmed="${resolve_snippet}.trimmed"
sed '/^resolve_render_env_value()/,$d' "$resolve_snippet" > "$resolve_trimmed"
mv "$resolve_trimmed" "$resolve_snippet"
(
  set -euo pipefail
  # shellcheck disable=SC1090
  source "$resolve_snippet"
  tok="$(resolve_github_token)"
  [ -n "$tok" ] || fail "resolve_github_token returned empty despite available controller credentials"
  github_token_can_fetch_repo "$tok" \
    || fail "resolve_github_token returned a token without Git contents access to rose"
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    if ! github_token_can_fetch_repo "$GITHUB_TOKEN" && [ "$tok" = "$GITHUB_TOKEN" ]; then
      fail "resolve_github_token returned the ambient stale GITHUB_TOKEN"
    fi
  fi
) || fail "validated GitHub token resolver regression failed"
rm -f "$resolve_snippet"


require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'CLOUDBENCH_SSH_EXEC_TIMEOUT' \
  "ssh_exec must honor an optional timeout so hung refresh-deps sessions fail closed"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'ssh_exec timed out after' \
  "ssh_exec must report timeout distinctly from auth/checkout failures"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'CLOUDBENCH_SSH_EXEC_TIMEOUT="$SYNC_SSH_TIMEOUT"' \
  "refresh-deps must bound warm_source_fetch_ref via CLOUDBENCH_SSH_EXEC_TIMEOUT"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'return "$sync_rc"' \
  "warm_source_fetch_ref must preserve ssh_exec status including timeout 124"

# Branch collateral (image-handling I-01): stripped PATH must fail closed.
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'npx not found on PATH; cannot verify the cloud-guest seed dump' \
  "fleet seed-dump probe must fail closed with a clear npx PATH error"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  '.nvm/versions/node' \
  "fleet seed-dump probe must restore nvm npx onto PATH when stripped"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'Never stop the warm machine ourselves' \
  "fleet must wait for warm stop without stopping a sibling-owned warm source"

# connect_ex returns errno values for failures, including timeouts; only a
# refused connection proves a port free. Execute the actual embedded program.
python3 - "$HELPER_SRC" <<'PY'
import errno
from pathlib import Path
import socket
import sys
from unittest.mock import patch

source = Path(sys.argv[1]).read_text()
function = source.split("cloudbench_tcp_listener_present()", 1)[1]
program = function.split("<<'PY'\n", 1)[1].split("\nPY\n", 1)[0]
compiled = compile(program, f"{sys.argv[1]}:cloudbench_tcp_listener_present", "exec")
for result, expected in [
    (0, 0),
    (errno.ECONNREFUSED, 1),
    # A full accept backlog remains occupied; these names alias on Linux.
    (errno.EAGAIN, 0),
    (errno.EWOULDBLOCK, 0),
    (errno.ETIMEDOUT, 3),
    (errno.EHOSTUNREACH, 3),
    (errno.ENETUNREACH, 3),
    (errno.EACCES, 3),
    (socket.timeout("fixture timeout"), 3),
    (OSError(errno.EMFILE, "fixture socket error"), 3),
]:
    with patch.object(sys, "argv", ["-", "19731"]), patch.object(socket, "socket") as make_socket:
        probe = make_socket.return_value.__enter__.return_value
        if isinstance(result, Exception):
            probe.connect_ex.side_effect = result
        else:
            probe.connect_ex.return_value = result
        try:
            exec(compiled, {"__name__": "__main__"})
        except SystemExit as exc:
            assert exc.code == expected, (result, expected, exc.code)
        else:
            raise AssertionError("TCP probe must report an explicit exit status")
        make_socket.assert_called_once_with(socket.AF_INET, socket.SOCK_STREAM)
        probe.settimeout.assert_called_once_with(0.2)
        probe.connect_ex.assert_called_once_with(("127.0.0.1", 19731))
for invalid in ["not-a-port", "", "-1", "0", "65536"]:
    with patch.object(sys, "argv", ["-", invalid]), patch.object(socket, "socket") as make_socket:
        try:
            exec(compiled, {"__name__": "__main__"})
        except SystemExit as exc:
            assert exc.code == 2, (invalid, 2, exc.code)
        else:
            raise AssertionError("Invalid TCP probe port must fail")
        make_socket.assert_not_called()
print("TCP probe errno classification contract ok")
PY
(
  cloudbench_tcp_listener_present() { return 3; }
  if selected="$(cloudbench_select_central_hub_port 19731 /tmp/no-such-hub-root)"; then
    fail "TCP probe error must prevent hub port selection"
  fi
  [ -z "$selected" ] || fail "TCP probe error must not return a port"
)

# An occupied foreign hub, including the backlog errno result above, must never
# be selected as free or reused without the expected runs-root identity.
(
  cloudbench_tcp_listener_present() {
    [ "$1" -ne 19731 ] || return 0
    return 1
  }
  cloudbench_central_hub_matches() { return 1; }
  selected="$(cloudbench_select_central_hub_port 19731 /tmp/foreign-hub-root)"
  [ "$selected" = "19732" ] ||
    fail "an occupied foreign hub must be skipped before selecting a free port"
)

# Hub port selection must fail closed when the TCP probe errors (not "free").
require_text "$HELPER_SRC" \
  'refusing fail-open port selection' \
  "central hub port selection must fail closed on TCP probe errors"
require_text "$HELPER_SRC" \
  'raise SystemExit(3)' \
  "TCP listener probe must use exit 3 for unexpected probe failures"
(
  # Behavioral: occupied → 0; free port → 1; bad arg → 2.
  rc=0
  cloudbench_tcp_listener_present not-a-port || rc=$?
  [ "$rc" -eq 2 ] || fail "bad port arg must exit 2 (got $rc)"
  # Let the OS assign a port and retain the listener until the probe completes.
  listener_port_file="$TMP_ROOT/tcp-listener-port"
  python3 - "$listener_port_file" <<'PY' &
import pathlib, socket, sys, threading, time
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", 0))
s.listen(1)

# Each probe opens a connection. Consume it so readiness does not fill the
# accept queue and make the following assertion time out on macOS.
def accept_connections():
    while True:
        try:
            connection, _ = s.accept()
        except OSError:
            return
        connection.close()

threading.Thread(target=accept_connections, daemon=True).start()
pathlib.Path(sys.argv[1]).write_text(str(s.getsockname()[1]))
while True:
    time.sleep(1)
PY
  listener_pid=$!
  trap 'kill "$listener_pid" 2>/dev/null || true' EXIT
  for _ in $(seq 1 100); do
    [ -s "$listener_port_file" ] && break
    sleep 0.05
  done
  [ -s "$listener_port_file" ] || fail "occupied port listener did not become ready"
  free_port="$(cat "$listener_port_file")"
  cloudbench_tcp_listener_present "$free_port" \
    || fail "occupied port probe must exit 0"
  kill "$listener_pid" 2>/dev/null || true
  wait "$listener_pid" 2>/dev/null || true
  rc=0
  cloudbench_tcp_listener_present "$free_port" || rc=$?
  [ "$rc" -eq 1 ] || fail "free port probe must exit 1 (got $rc)"

  # `if probe; then` must not swallow exit 1: a free preferred port is allocatable.
  selected="$(cloudbench_select_central_hub_port "$free_port" "/tmp/no-such-hub-root")"
  [ "$selected" = "$free_port" ] || fail "free preferred port must be selected (got ${selected:-empty})"
) || fail "TCP listener probe exit-code contract broken"

# Behavioral: select_central_hub_port must return a free preferred port.
# Regression for the `if cmd; $?` trap — free ports used to FATAL with rc=0.
(
  free_port=19811
  while cloudbench_tcp_listener_present "$free_port"; do
    free_port=$((free_port + 1))
  done
  selected="$(cloudbench_select_central_hub_port "$free_port" "/tmp/cloudbench-hub-select-$$")" || {
    fail "select_central_hub_port must succeed on a free preferred port"
  }
  [ "$selected" = "$free_port" ] || fail "select_central_hub_port must return preferred free port (got $selected)"
) || fail "central hub free-port selection contract broken"

# A refused connect only proves no listener. A bound-but-not-listening socket
# (like a loopback client's ephemeral port or its TIME_WAIT) still fails the
# hub's bind, so selection must skip it rather than re-pick it every attempt.
(
  bound_port_file="$TMP_ROOT/tcp-bound-port"
  python3 - "$bound_port_file" <<'PY' &
import pathlib, socket, sys, time
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.bind(("127.0.0.1", 0))
pathlib.Path(sys.argv[1]).write_text(str(s.getsockname()[1]))
while True:
    time.sleep(1)
PY
  bound_pid=$!
  trap 'kill "$bound_pid" 2>/dev/null || true' EXIT
  for _ in $(seq 1 100); do
    [ -s "$bound_port_file" ] && break
    sleep 0.05
  done
  [ -s "$bound_port_file" ] || fail "bound-only socket did not become ready"
  bound_port="$(cat "$bound_port_file")"
  rc=0
  cloudbench_tcp_listener_present "$bound_port" || rc=$?
  [ "$rc" -eq 1 ] || fail "a bound-only socket must probe as no listener (got $rc)"
  rc=0
  cloudbench_tcp_port_bindable "$bound_port" || rc=$?
  [ "$rc" -eq 1 ] || fail "a bound-only socket must probe as in use (got $rc)"
  selected="$(cloudbench_select_central_hub_port "$bound_port" "/tmp/no-such-hub-root")" ||
    fail "selection must skip, not refuse, a bound-only preferred port"
  [ -n "$selected" ] && [ "$selected" != "$bound_port" ] ||
    fail "a bound-only preferred port must not be selected (got ${selected:-empty})"
  kill "$bound_pid" 2>/dev/null || true
  wait "$bound_pid" 2>/dev/null || true
  rc=0
  cloudbench_tcp_port_bindable "$bound_port" || rc=$?
  [ "$rc" -eq 0 ] || fail "a released port must probe as bindable (got $rc)"
) || fail "central hub bound-only port contract broken"

# --single-box must reject before cd/catalog work. Prefer a scripts-only sandbox
# (cloudbench-multi scenario 14) and cement ordering vs the production-only
# classifier so a missing tasks.json never swallows the parallel-safety message.
python3 - "$ROOT_DIR/scripts/run-bench" <<'PY' || fail "run-bench --single-box must precede production-only classifier"
from pathlib import Path
import sys
text = Path(sys.argv[1]).read_text()
sb = text.find('[[ "${1:-}" == "--single-box" ]]')
prod = text.find("cloudbench-production-only-tasks.py")
if sb < 0 or prod < 0 or not (sb < prod):
    raise SystemExit(f"single-box at {sb}, production-only at {prod}")
PY
single_box_root="$TMP_ROOT/scripts-only-sandbox"
mkdir -p "$single_box_root"
cp -R "$ROOT_DIR/scripts" "$single_box_root/scripts"
single_box_log="$TMP_ROOT/single-box.log"
set +e
bash "$single_box_root/scripts/run-bench" --single-box some-bench >"$single_box_log" 2>&1
single_box_ec=$?
set -e
[ "$single_box_ec" -ne 0 ] || fail "--single-box must be rejected in a scripts-only sandbox"
grep -qiF "parallel-safe" "$single_box_log" ||
  fail "--single-box rejection must explain the parallel-safety hazard without requiring agents/"

bash "$ROOT_DIR/scripts/tests/cloudbench-pid-identity.test.sh" ||
  fail "cloudbench PID birth identities must survive a wall-clock step"

echo "All cloud benchmark environment checks passed."
# BEGIN registered controller lock race controls
python3 - "$HELPER_SRC" <<'PYLOCK'
import os, pathlib, subprocess, sys, tempfile, unittest
HELPER=sys.argv[1]
class ControllerKernelLock(unittest.TestCase):
 def run_case(self,mode):
  with tempfile.TemporaryDirectory()as td:
   script=r'''
set -eu
PATH=/usr/bin:/bin; export PATH
source "$1"
d="$2"; mode="$3"; lock="$d/controller.lock"
actual_flock="$(command -v flock)"
export actual_flock
bash -c 'exec 9<> "$1"; "$actual_flock" 9; printf "99999999\n" > "$1"; touch "$2/ready"; while [ ! -e "$2/release" ]; do sleep .01; done; "$actual_flock" -u 9; exec 9>&-; touch "$2/released"' _ "$lock" "$d" &
holder=$!
trap 'touch "$d/release"; wait "$holder"' EXIT
for n in $(seq 1 200); do [ -e "$d/ready" ] && break; sleep .01; done
[ -e "$d/ready" ]
first=1
flock(){
 local rc=0
 "$actual_flock" "$@" || rc=$?
 if [ "$1" = -n ] && [ "$first" = 1 ]; then
  first=0
  [ "$rc" = 1 ]
  if [ "$mode" != held ]; then
   touch "$d/release"
   for n in $(seq 1 200); do [ -e "$d/released" ] && break; sleep .01; done
   [ -e "$d/released" ]
   if [ "$mode" = replaced ]; then mv "$lock" "$lock.old"; printf '99999999\n' > "$lock"; fi
  fi
 fi
 return "$rc"
}
rc=0
cloudbench_controller_lock_acquire_wait "$lock" 1 || rc=$?
if [ "$mode" = released ]; then
 [ "$rc" = 0 ]
 [ "$(cat "$lock")" = "$$" ]
 ! "$actual_flock" -n "$lock" true
 cloudbench_controller_lock_release "$lock"
else
 [ "$rc" != 0 ]
 [ "$(cat "$lock")" = 99999999 ]
fi
'''
   result=subprocess.run(['bash','-c',script,'_',HELPER,td,mode],capture_output=True,text=True,timeout=8)
   self.assertEqual(result.returncode,0,result.stderr)
 def test_released_owner_reacquires_same_kernel_inode(self):self.run_case('released')
 def test_dead_metadata_with_live_kernel_holder_refuses(self):self.run_case('held')
 def test_replaced_inode_is_not_acquired(self):self.run_case('replaced')
unittest.main(argv=['controller-kernel-lock'],verbosity=2)
PYLOCK
# END registered controller lock race controls

# ── Benchmark guests use their own Temporal namespace (run600c, 2026-10-18) ──
# 600 guests on the production namespace exhausted its Visibility API budget and
# blinded production's autoscaler for ~35 minutes. The real _inject_secrets_locked
# stages guest copies of agents/.env and back-end/.env with only TEMPORAL_ADDRESS,
# TEMPORAL_NAMESPACE and TEMPORAL_API_KEY replaced from a private override file;
# the controller's own env files stay byte-identical, and no override file keeps
# the historical byte-identical blobs.
# Earlier sections unset helper functions they stub; reload the real helper.
# shellcheck source=../lib/cloudbench-env.sh
source "$HELPER_SRC"
guest_temporal_case() {  # <case> ; prints nothing on success
  local case_name="$1" dir="$TMP_ROOT/guest-temporal-$1"
  mkdir -p "$dir/repo/agents" "$dir/repo/back-end" "$dir/tmp"
  chmod 700 "$dir/tmp"
  printf 'OPENAI_API_KEY=sk-agents\nTEMPORAL_ADDRESS=prod.example:7233\nTEMPORAL_NAMESPACE=prod-ns.acct\nTEMPORAL_API_KEY=prod-secret-key\nTEMPORAL_TASK_QUEUE=navi-agent-tasks\nTEMPORAL_ADDRESS_NOTE=keep\n' > "$dir/repo/agents/.env"
  if [ "$case_name" = appended ]; then
    printf 'DATABASE_URL=postgres://prod\nTEMPORAL_TASK_QUEUE=navi-agent-tasks' > "$dir/repo/back-end/.env"
  else
    printf 'DATABASE_URL=postgres://prod\r\nexport TEMPORAL_NAMESPACE=prod-ns.acct\r\nTEMPORAL_API_KEY="prod-secret-key"\r\nTEMPORAL_ADDRESS=prod.example:7233\r\n' > "$dir/repo/back-end/.env"
  fi
  chmod 600 "$dir/repo/agents/.env" "$dir/repo/back-end/.env"
  local override="$dir/repo/agents/.env.benchmark-temporal"
  # bench-* cases stage the real bench app, whose guest namespace is committed.
  local app=cloudbench-guest-temporal guest_namespace=bench-ns.acct
  case "$case_name" in bench-*) app=navi-whisper-lux-bench ;; esac
  [ "$case_name" != bench-applied ] || guest_namespace=rose-labs-bench.tch2n
  case "$case_name" in
    missing|bench-missing|bench-off) ;;
    *)
      printf '# guest only\nCLOUDBENCH_GUEST_TEMPORAL_ADDRESS=us-east-1.aws.api.temporal.io:7233\nCLOUDBENCH_GUEST_TEMPORAL_NAMESPACE=%s\nCLOUDBENCH_GUEST_TEMPORAL_API_KEY=guest-secret-key\n' "$guest_namespace" > "$override"
      chmod 600 "$override"
      ;;
  esac
  [ "$case_name" != loose-mode ] || chmod 640 "$override"
  [ "$case_name" != incomplete ] || sed -i '/API_KEY/d' "$override"
  local before_agents before_backend
  before_agents="$(cloudbench_env_sha256 "$dir/repo/agents/.env")"
  before_backend="$(cloudbench_env_sha256 "$dir/repo/back-end/.env")"
  local function_body rc=0
  function_body="$(awk '
    $0 ~ /^_inject_secrets_locked\(\)/ { capture = 1 }
    capture { print }
    capture && /^}$/ { exit }
  ' "$ROOT_DIR/scripts/run-bench-cloud")"
  [ -n "$function_body" ] || fail "could not load _inject_secrets_locked"
  (
    cd "$dir/repo"
    eval "$function_body"
    APP="$app"
    ROOT_DIR="$dir/repo"
    export TMPDIR="$dir/tmp"
    case "$case_name" in
      off|bench-off) export CLOUDBENCH_GUEST_TEMPORAL_ENV_FILE=off ;;
      explicit-missing) export CLOUDBENCH_GUEST_TEMPORAL_ENV_FILE="$dir/absent" ;;
      *) unset CLOUDBENCH_GUEST_TEMPORAL_ENV_FILE ;;
    esac
    validate_environment_contract() { CLOUDBENCH_PROD_BROWSER_PROVIDER=kernel; CLOUDBENCH_PROD_WORKER_BROWSER_PROVIDER=kernel; }
    resolve_durable_github_token() { echo gh-token; }
    assert_app_environment_lock_ownership() { return 0; }
    environment_activation_targets() { printf 'pool\tpool-1\n'; }
    activate_machine_environment() { echo "$1" >> "$dir/activated"; }
    FLY() {
      local arg
      for arg in "$@"; do
        case "$arg" in
          AGENTS_ENV_B64=*) printf '%s' "${arg#*=}" | base64 -d > "$dir/staged-agents.env" ;;
          BACKEND_ENV_B64=*) printf '%s' "${arg#*=}" | base64 -d > "$dir/staged-backend.env" ;;
          AGENTS_ENV_SHA256=*) printf '%s' "${arg#*=}" > "$dir/staged-agents.sha" ;;
          BACKEND_ENV_SHA256=*) printf '%s' "${arg#*=}" > "$dir/staged-backend.sha" ;;
        esac
      done
    }
    _inject_secrets_locked
  ) > "$dir/stdout" 2> "$dir/stderr" || rc=$?
  [ "$(cloudbench_env_sha256 "$dir/repo/agents/.env")" = "$before_agents" ] ||
    fail "$case_name: controller agents/.env must stay byte-identical"
  [ "$(cloudbench_env_sha256 "$dir/repo/back-end/.env")" = "$before_backend" ] ||
    fail "$case_name: controller back-end/.env must stay byte-identical"
  ! grep -Rq 'secret-key' "$dir/stdout" "$dir/stderr" || fail "$case_name: staging output leaked a Temporal key"
  [ -z "$(ls -A "$dir/tmp")" ] || fail "$case_name: private guest env copies were left behind"
  case "$case_name" in
    explicit-missing|loose-mode|incomplete)
      [ "$rc" -ne 0 ] || fail "$case_name: unusable override must fail closed"
      [ ! -e "$dir/staged-agents.env" ] && [ ! -e "$dir/activated" ] ||
        fail "$case_name: unusable override must stage and activate nothing"
      return 0
      ;;
    bench-missing|bench-off|bench-wrong-ns)
      # 2026-10-19: a host without the private override restaged the bench app
      # with the production namespace; guests refused only at launch.
      [ "$rc" -ne 0 ] || fail "$case_name: bench app staging without its committed guest namespace must fail closed"
      [ ! -e "$dir/staged-agents.env" ] && [ ! -e "$dir/activated" ] ||
        fail "$case_name: refused bench staging must stage and activate nothing"
      grep -Fq 'rose-labs-bench.tch2n' "$dir/stderr" || fail "$case_name: refusal must name the expected bench namespace"
      [ "$case_name" = bench-wrong-ns ] || grep -Fq '.env.benchmark-temporal' "$dir/stderr" ||
        fail "$case_name: refusal must say how to provide the guest override"
      return 0
      ;;
  esac
  [ "$rc" -eq 0 ] || fail "$case_name: staging failed: $(cat "$dir/stderr")"
  [ "$(cat "$dir/activated")" = pool-1 ] || fail "$case_name: pool machine was not activated"
  # Each staged digest is the one the guest checks after decoding.
  cloudbench_verify_env_file "$dir/staged-agents.env" "$(cat "$dir/staged-agents.sha")" agents >/dev/null ||
    fail "$case_name: staged agents digest must verify on the guest"
  cloudbench_verify_env_file "$dir/staged-backend.env" "$(cat "$dir/staged-backend.sha")" backend >/dev/null ||
    fail "$case_name: staged backend digest must verify on the guest"
  local manifest_namespace
  manifest_namespace="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["guest_temporal_namespace"])' "$dir/repo/.context/cloudbench-env-manifest.json")"
  case "$case_name" in
    missing|off)
      cmp -s "$dir/staged-agents.env" "$dir/repo/agents/.env" && cmp -s "$dir/staged-backend.env" "$dir/repo/back-end/.env" ||
        fail "$case_name: without an override the staged env must equal the controller env byte-for-byte"
      [ "$manifest_namespace" = None ] || fail "$case_name: manifest must not claim a guest namespace"
      ;;
    applied)
      printf 'OPENAI_API_KEY=sk-agents\nTEMPORAL_ADDRESS=us-east-1.aws.api.temporal.io:7233\nTEMPORAL_NAMESPACE=bench-ns.acct\nTEMPORAL_API_KEY=guest-secret-key\nTEMPORAL_TASK_QUEUE=navi-agent-tasks\nTEMPORAL_ADDRESS_NOTE=keep\n' > "$dir/expected-agents"
      printf 'DATABASE_URL=postgres://prod\r\nexport TEMPORAL_NAMESPACE=bench-ns.acct\r\nTEMPORAL_API_KEY=guest-secret-key\r\nTEMPORAL_ADDRESS=us-east-1.aws.api.temporal.io:7233\r\n' > "$dir/expected-backend"
      cmp -s "$dir/staged-agents.env" "$dir/expected-agents" || fail "applied: guest agents env must change only the three Temporal keys"
      cmp -s "$dir/staged-backend.env" "$dir/expected-backend" || fail "applied: guest backend env must change only the three Temporal keys"
      grep -Fq 'guest Temporal namespace override: bench-ns.acct' "$dir/stdout" || fail "applied: staging must report the guest namespace"
      [ "$manifest_namespace" = bench-ns.acct ] || fail "applied: manifest must record the guest namespace"
      ;;
    bench-applied)
      [ "$manifest_namespace" = rose-labs-bench.tch2n ] || fail "bench-applied: manifest must record the committed bench namespace"
      [ "$(cloudbench_env_value "$dir/staged-agents.env" TEMPORAL_NAMESPACE)" = rose-labs-bench.tch2n ] ||
        fail "bench-applied: staged guest agents env must carry the committed bench namespace"
      ;;
    appended)
      printf 'DATABASE_URL=postgres://prod\nTEMPORAL_TASK_QUEUE=navi-agent-tasks\nTEMPORAL_ADDRESS=us-east-1.aws.api.temporal.io:7233\nTEMPORAL_NAMESPACE=bench-ns.acct\nTEMPORAL_API_KEY=guest-secret-key\n' > "$dir/expected-backend"
      cmp -s "$dir/staged-backend.env" "$dir/expected-backend" || fail "appended: absent guest Temporal keys must be appended"
      ;;
  esac
}
for guest_case in applied appended missing off explicit-missing loose-mode incomplete bench-applied bench-missing bench-off bench-wrong-ns; do
  guest_temporal_case "$guest_case"
done
# A linked worktree env finds the override beside the authoritative file.
(
  dir="$TMP_ROOT/guest-temporal-linked"
  mkdir -p "$dir/authority/agents" "$dir/worktree/agents"
  : > "$dir/authority/agents/.env"
  : > "$dir/authority/agents/.env.benchmark-temporal"
  ln -s "$dir/authority/agents/.env" "$dir/worktree/agents/.env"
  unset CLOUDBENCH_GUEST_TEMPORAL_ENV_FILE
  [ "$(cloudbench_guest_temporal_override_file "$dir/worktree/agents/.env")" = "$dir/authority/agents/.env.benchmark-temporal" ]
) || fail "a linked agents/.env must resolve the authoritative guest Temporal override"
# A copied env in a linked Git worktree falls back to the main checkout's file.
(
  dir="$TMP_ROOT/guest-temporal-worktree"
  mkdir -p "$dir/main/agents"
  git -C "$dir/main" init -q
  git -C "$dir/main" -c user.email=t@example.com -c user.name=t commit -q --allow-empty -m init
  git -C "$dir/main" worktree add -q "$dir/linked" >/dev/null 2>&1
  mkdir -p "$dir/linked/agents"
  : > "$dir/linked/agents/.env"
  unset CLOUDBENCH_GUEST_TEMPORAL_ENV_FILE
  [ -z "$(cloudbench_guest_temporal_override_file "$dir/linked/agents/.env")" ]
  : > "$dir/main/agents/.env.benchmark-temporal"
  [ "$(cloudbench_guest_temporal_override_file "$dir/linked/agents/.env")" = "$(cd "$dir/main" && pwd -P)/agents/.env.benchmark-temporal" ]
) || fail "a linked Git worktree must resolve the main checkout's guest Temporal override"
# A launcher-bound guest namespace (original600 operator → controller fleet →
# boot env) must fail a guest whose decoded bench-app secrets still carry the
# controller/production namespace, before any Temporal worker starts. No bound
# namespace keeps the historical behavior; guest/fleet wiring stays explicit.
(
  dir="$TMP_ROOT/guest-temporal-require"
  mkdir -p "$dir"
  printf 'TEMPORAL_NAMESPACE=rose-labs-bench.acct\nTEMPORAL_API_KEY=bench-secret\n' > "$dir/agents.env"
  printf 'DATABASE_URL=x\nTEMPORAL_NAMESPACE="rose-labs-bench.acct"\n' > "$dir/backend.env"
  printf 'TEMPORAL_NAMESPACE=prod-ns.acct\nTEMPORAL_API_KEY=prod-secret\n' > "$dir/stale-agents.env"
  printf 'DATABASE_URL=x\r\nexport TEMPORAL_NAMESPACE=rose-labs-bench.acct\r\n' > "$dir/export-backend.env"
  : > "$dir/unset.env"
  cloudbench_require_guest_temporal_namespace "$dir/agents.env" "$dir/backend.env" rose-labs-bench.acct
  # dotenv's `export KEY=value` form is the same key to the guest's loaders.
  cloudbench_require_guest_temporal_namespace "$dir/agents.env" "$dir/export-backend.env" rose-labs-bench.acct
  [ "$(cloudbench_expected_guest_temporal_namespace navi-whisper-lux-bench)" = rose-labs-bench.tch2n ]
  [ -z "$(cloudbench_expected_guest_temporal_namespace some-other-app)" ]
  cloudbench_require_guest_temporal_namespace "$dir/stale-agents.env" "$dir/backend.env" ""
  ! cloudbench_require_guest_temporal_namespace "$dir/stale-agents.env" "$dir/backend.env" rose-labs-bench.acct 2> "$dir/stale.err"
  grep -q 'TEMPORAL_NAMESPACE=prod-ns.acct differs' "$dir/stale.err"
  ! grep -q -e prod-secret -e bench-secret "$dir/stale.err"
  ! cloudbench_require_guest_temporal_namespace "$dir/agents.env" "$dir/unset.env" rose-labs-bench.acct 2>/dev/null
  # Conflicting repeats: the first value matches, but dotenv loaders apply the
  # last one. Guest and staging checks both refuse them. Identical repeats (real
  # env files repeat the key; the override rewrites every line) still pass.
  printf 'TEMPORAL_NAMESPACE=rose-labs-bench.tch2n\nexport TEMPORAL_NAMESPACE=prod-ns.acct\n' > "$dir/dup-agents.env"
  printf 'TEMPORAL_NAMESPACE=rose-labs-bench.tch2n\nTEMPORAL_NAMESPACE="rose-labs-bench.tch2n"\n' > "$dir/same-agents.env"
  printf 'export TEMPORAL_NAMESPACE=rose-labs-bench.tch2n\n' > "$dir/one-backend.env"
  [ "$(cloudbench_env_distinct_value_count "$dir/dup-agents.env" TEMPORAL_NAMESPACE)" = 2 ]
  [ "$(cloudbench_env_distinct_value_count "$dir/same-agents.env" TEMPORAL_NAMESPACE)" = 1 ]
  [ "$(cloudbench_env_distinct_value_count "$dir/unset.env" TEMPORAL_NAMESPACE)" = 0 ]
  ! cloudbench_require_guest_temporal_namespace "$dir/dup-agents.env" "$dir/one-backend.env" rose-labs-bench.tch2n 2> "$dir/dup-guest.err"
  grep -q 'assigns 2 different TEMPORAL_NAMESPACE values' "$dir/dup-guest.err"
  ! cloudbench_require_staged_guest_temporal_namespace navi-whisper-lux-bench "" "$dir/dup-agents.env" "$dir/one-backend.env" 2> "$dir/dup-stage.err"
  grep -q 'assigns 2 different TEMPORAL_NAMESPACE values' "$dir/dup-stage.err"
  ! grep -q prod-ns.acct "$dir/dup-stage.err"
  cloudbench_require_staged_guest_temporal_namespace navi-whisper-lux-bench "" "$dir/same-agents.env" "$dir/one-backend.env"
  cloudbench_require_guest_temporal_namespace "$dir/same-agents.env" "$dir/one-backend.env" rose-labs-bench.tch2n
  python3 - "$ROOT_DIR/scripts/cloudbench-run.sh" "$ROOT_DIR/scripts/run-bench-cloud" <<'PYWIRE'
import sys
from pathlib import Path
run, cloud = (Path(path).read_text() for path in sys.argv[1:])
check = 'cloudbench_require_guest_temporal_namespace "$REPO_DIR/agents/.env" "$REPO_DIR/back-end/.env"'
verify = 'cloudbench_verify_env_file "$REPO_DIR/back-end/.env"'
assert run.count(check) == 1 and run.index(verify) < run.index(check) < run.index('step stack_launch'), 'guest check after digest verify, before stack'
assert '--env "CLOUDBENCH_EXPECTED_GUEST_TEMPORAL_NAMESPACE=${CLOUDBENCH_EXPECTED_GUEST_TEMPORAL_NAMESPACE:-}"' in cloud
default = 'CLOUDBENCH_EXPECTED_GUEST_TEMPORAL_NAMESPACE="${CLOUDBENCH_EXPECTED_GUEST_TEMPORAL_NAMESPACE:-$(cloudbench_expected_guest_temporal_namespace "$APP")}"'
assert cloud.count(default) == 1 and cloud.index('cloudbench-env.sh"') < cloud.index(default) < cloud.index('--env "CLOUDBENCH_EXPECTED_GUEST'), 'launches bind the committed guest namespace by default'
stage_check = 'cloudbench_require_staged_guest_temporal_namespace "$APP" "$guest_temporal_override"'
body = cloud[cloud.index('_inject_secrets_locked() {'):]
assert body.index(stage_check) < body.index('FLY secrets set --stage'), 'staging refuses a wrong guest namespace before any secret is set'
assert 'echo "export CLOUDBENCH_EXPECTED_GUEST_TEMPORAL_NAMESPACE=$(printf \'%q\' "${CLOUDBENCH_EXPECTED_GUEST_TEMPORAL_NAMESPACE:-}")"' in cloud
PYWIRE
) || fail "a launcher-bound guest Temporal namespace must reject stale bench-app secrets"
# Benchmark stacks route BACKEND_API_URL to their own isolated backend, whose
# seeded database never holds a rotating Lantern grant. Without an explicit
# credential, every people_search returned 404 LANTERN_NOT_CONNECTED and all 28
# lantern-people-* cloud jobs hit the 300s backstop (original600-1792433794419199295).
# Execute run.sh's actual fragment: benchmark stacks use the central broker,
# explicit broker/bearer configuration wins, and ordinary dev stacks are unchanged.
(
  dir="$TMP_ROOT/people-credential-authority"
  mkdir -p "$dir"
  fragment="$(sed -n '/^# People credential authority\.$/,/^# End people credential authority\.$/p' "$ROOT_DIR/scripts/run.sh")"
  [ -n "$fragment" ] || { echo "run.sh has no people credential authority fragment" >&2; exit 1; }
  python3 - "$ROOT_DIR/scripts/run.sh" <<'PYWIRE'
import sys
from pathlib import Path
run = Path(sys.argv[1]).read_text()
start = run.index('# People credential authority.')
assert run.index('export BENCHMARK_MODE BENCHMARK_ISOLATED_RUN') < start, 'fragment must follow the benchmark flag export'
assert start < run.index('run_local_worker.sh'), 'fragment must run before any worker launch'
PYWIRE
  effective() {  # <benchmark-mode> <agents-env-file> [VAR=value...] -> worker-visible broker
    local mode="$1" env_file="$2"; shift 2
    env -i PATH="$PATH" "$@" bash -c '
      set -eo pipefail
      source "$1"; BENCHMARK_MODE="$2"; SCRIPT_DIR="$3"
      eval "$4" >/dev/null
      printf "%s" "${PEOPLE_CREDENTIAL_BROKER_URL:-}"
    ' _ "$HELPER_SRC" "$mode" "$dir/scripts" "$fragment"
  }
  mkdir -p "$dir/scripts" "$dir/agents"
  printf 'PEOPLE_API_URL="https://people.lantern.md"\nPEOPLE_API_TOKEN=""\nPEOPLE_CREDENTIAL_BROKER_URL=""\n' > "$dir/agents/.env"
  [ "$(effective true "$dir/agents/.env")" = "https://navi-j9a9.onrender.com" ] \
    || { echo "blank benchmark credentials must use the central broker" >&2; exit 1; }
  [ -z "$(effective false "$dir/agents/.env")" ] \
    || { echo "ordinary dev stacks must keep their configured credential path" >&2; exit 1; }
  [ "$(effective true "$dir/agents/.env" PEOPLE_CREDENTIAL_BROKER_URL=https://broker.example)" = "https://broker.example" ] \
    || { echo "an explicit broker in the environment must win" >&2; exit 1; }
  [ -z "$(effective true "$dir/agents/.env" PEOPLE_API_TOKEN=explicit-bearer)" ] \
    || { echo "an explicit bearer in the environment must not be overridden" >&2; exit 1; }
  printf 'PEOPLE_API_TOKEN="explicit-bearer"\n' > "$dir/agents/.env"
  [ -z "$(effective true "$dir/agents/.env")" ] \
    || { echo "an explicit bearer in agents/.env must not be overridden" >&2; exit 1; }
  printf "PEOPLE_CREDENTIAL_BROKER_URL='https://broker.example'\n" > "$dir/agents/.env"
  [ -z "$(effective true "$dir/agents/.env")" ] \
    || { echo "an explicit broker in agents/.env must be left for the worker to load" >&2; exit 1; }
  rm "$dir/agents/.env"
  [ "$(effective true "$dir/agents/.env")" = "https://navi-j9a9.onrender.com" ] \
    || { echo "a missing agents/.env has no explicit Lantern credential" >&2; exit 1; }
) || fail "benchmark stacks must give workers the central people credential broker"

# Production replay (PR #1627 Group 4 cloud smoke, fleet 20261028-181310-2300577):
# the devbox VM paused for 537 s (kernel audit seq 73645→73646, 18:33:12→18:42:09Z)
# while six status proxies were still retrying through Fly GraphQL 503s. The
# readiness loop measured its 180 s budget with wall-clock time, so the pause
# consumed it; after the thaw every one of those guests was failed closed as
# INFRA without one further probe or attempt, although the identical tunnels
# came up within 20 s for the three guests whose proxies already existed. A
# host stall is not controller runtime: only the bounded work of each step may
# be charged, and the loop must keep probing/attempting after the thaw. Two
# observed variants: (A) the attempt's flyctl had already died on the 503 and
# the pause landed before the next attempt (test-mass-agent-run-0); (B) the
# attempt's flyctl was alive with HTTP 000 when the pause hit and the same
# tunnel served after the thaw (chat-mode). Fakes advance a file-backed clock
# instead of sleeping, so the replay is offline and deterministic.
(
  stall_replay() {  # <variant A|B> ; fakes share state through STALL_* files
    local variant="$1" stall_dir="$TMP_ROOT/proxy-host-stall-$1"
    mkdir -p "$stall_dir"
    export STALL_VARIANT="$variant" STALL_CLOCK="$stall_dir/clock" \
      STALL_COUNT="$stall_dir/attempts" STALL_MARKER="$stall_dir/stall-pending" \
      STALL_DONE="$stall_dir/stall-applied"
    printf '1793212307\n' > "$STALL_CLOCK"
    rm -f "$STALL_COUNT" "$STALL_MARKER" "$STALL_DONE"
    date() {
      case "$*" in
        *+%s*) cat "$STALL_CLOCK" ;;
        *) printf '18:31:47\n' ;;
      esac
    }
    sleep() {  # advance the fake clock; a pending host pause lands in this sleep
      local now secs="${1:-0}"
      secs="${secs%%.*}"
      case "$secs" in ''|*[!0-9]*) secs=1 ;; esac
      [ "$secs" -ge 1 ] || secs=1
      now="$(cat "$STALL_CLOCK")"
      if [ -e "$STALL_MARKER" ]; then
        rm -f "$STALL_MARKER"
        : > "$STALL_DONE"
        now=$((now + 537))
      fi
      printf '%s\n' "$((now + secs))" > "$STALL_CLOCK"
      command sleep 0.02
    }
    flyctl() {  # A: attempts 1-4 die on the Fly GraphQL 503 (pause after #4); B: always alive
      local n
      n=$(( $(cat "$STALL_COUNT" 2>/dev/null || echo 0) + 1 ))
      if [ "$STALL_VARIANT" = A ] && [ "$n" -eq 4 ]; then : > "$STALL_MARKER"; fi
      printf '%s\n' "$n" > "$STALL_COUNT"
      if [ "$STALL_VARIANT" = A ] && [ "$n" -le 4 ]; then
        echo 'Error: failed to run mutation($input: ValidateWireGuardPeersInput!) { validateWireGuardPeers(input: $input) { invalidPeerIps } }: server returned a non-200 status code: 503'
        return 1
      fi
      exec sleep 60
    }
    curl() {
      case " $* " in
        *" -w %{http_code} "*)
          if [ -e "$STALL_DONE" ]; then
            printf 204
          else
            # B: the first health probe fails with HTTP 000 and the pause lands
            # in the wait that follows; the same live tunnel serves after it.
            [ -e "$STALL_MARKER" ] || : > "$STALL_MARKER"
            printf 000
          fi
          return 0 ;;
      esac
      # Lazy-DNS probe: let the background fake register its attempt first, and
      # let a dying attempt finish exiting, so the replay never races the parent.
      while [ "$(cat "$STALL_COUNT" 2>/dev/null || echo 0)" -lt "${attempt:-1}" ]; do command sleep 0.01; done
      if [ "$STALL_VARIANT" = A ] && [ "$(cat "$STALL_COUNT")" -le 4 ]; then
        for _ in $(seq 1 500); do kill -0 "${pid:-0}" 2>/dev/null || break; command sleep 0.01; done
      fi
      return 0
    }
    APP="cloudbench-proxy-host-stall"
    local proxy_log="$stall_dir/cloudbench-status-proxy.log" proxy_status=0 attempts_run
    proxy_pid=""
    cloudbench_start_data_plane_proxy 61807 8011 "fdaa::stall-$variant" "$proxy_log" proxy_pid status 180 \
      2> "$stall_dir/stderr" || proxy_status=$?
    cat "$stall_dir/stderr" >&2
    attempts_run="$(cat "$STALL_COUNT" 2>/dev/null || echo 0)"
    [ "$proxy_status" -eq 0 ] ||
      fail "variant $variant: a 537s host stall must not fail the status proxy closed (exit=$proxy_status, attempts=$attempts_run)"
    [ -n "$proxy_pid" ] && kill -0 "$proxy_pid" 2>/dev/null ||
      fail "variant $variant: a ready status proxy must publish its live pid (pid=${proxy_pid:-<empty>})"
    grep -Eq 'host stall 5[0-9][0-9]s during a [0-9]+s-bounded step' "$proxy_log" ||
      fail "variant $variant: the excluded host stall must be recorded in the proxy log"
    [ -e "$STALL_DONE" ] || fail "variant $variant: the replay never applied its host pause"
    case "$variant" in
      A) [ "$attempts_run" -ge 5 ] ||
           fail "variant A: the loop must make a further attempt after the thaw (attempts=$attempts_run)" ;;
      B) [ "$attempts_run" -eq 1 ] ||
           fail "variant B: a live tunnel that serves after the thaw must not be restarted (attempts=$attempts_run)" ;;
    esac
    cloudbench_terminate_and_wait 1 "$proxy_pid"
  }
  stall_replay A
  stall_replay B
) || fail "status proxy readiness must exclude host stalls from its budget and keep probing after the thaw"

# The same replay lost the first-phase readiness evidence of the three guests
# that passed: ensure_status_proxy re-enters the launcher after the thaw and the
# launcher truncated the log, so only the restart survived. Restarts must retain
# earlier attempts, and the bind-collision classifier must then read only the
# current attempt's output instead of an older port's collision.
(
  retain_dir="$TMP_ROOT/proxy-log-retention"
  mkdir -p "$retain_dir"
  CLOUDBENCH_PROXY_POST_PROBE_SETTLE_SECONDS=0
  flyctl() { exec sleep 60; }
  curl() {
    case " $* " in *" -w %{http_code} "*) printf 204 ;; esac
    return 0
  }
  APP="cloudbench-proxy-log-retention"
  proxy_log="$retain_dir/cloudbench-status-proxy.log"
  printf '[18:31:47] status proxy attempt 1: localhost:61807 -> fdaa::retain:8011\n' > "$proxy_log"
  printf 'Error: listen tcp 127.0.0.1:61807: bind: address already in use\n' >> "$proxy_log"
  proxy_pid=""
  proxy_status=0
  cloudbench_start_data_plane_proxy 61808 8011 fdaa::retain "$proxy_log" proxy_pid status 30 \
    2> "$retain_dir/stderr" || proxy_status=$?
  cat "$retain_dir/stderr" >&2
  [ "$proxy_status" -eq 0 ] ||
    fail "an older port's collision line must not classify the new attempt (exit=$proxy_status)"
  grep -q 'attempt 1: localhost:61807' "$proxy_log" ||
    fail "a proxy restart must retain the earlier attempts' evidence in the log"
  grep -q 'localhost:61808' "$proxy_log" ||
    fail "the restart's own attempt must be appended to the retained log"
  cloudbench_terminate_and_wait 1 "$proxy_pid"
) || fail "status proxy restarts must retain earlier readiness evidence"

python3 "$ROOT_DIR/scripts/tests/cloudbench-proxy-review.test.py"
# A1 (approved 2026-10-20): every cloud guest delegates compute-token lease,
# cooldown and Foundry rate-limit state to one authority (the production
# backend by default), so N guests cannot run N copies of one token's
# semaphore (RCA 2026-10-20-bench-guests-ran-independent-compute-token-semaphores).
# Fresh and pooled Machines both receive the value explicitly (also when opted
# out, so a pooled Machine never keeps an older run's authority), and the guest
# hands it to the stack with its own BACKEND_API_KEY or refuses to start.
(
  dir="$TMP_ROOT/compute-token-authority"
  mkdir -p "$dir"
  [ "$(env -u CLOUDBENCH_COMPUTE_TOKEN_AUTHORITY_URL -u BENCHMARK_COMPUTE_TOKEN_AUTHORITY bash -c 'source "$1"; cloudbench_compute_token_authority_url' _ "$HELPER_SRC")" = "https://navi-j9a9.onrender.com" ] \
    || { echo "guests must default to the production compute-token authority" >&2; exit 1; }
  [ "$(CLOUDBENCH_COMPUTE_TOKEN_AUTHORITY_URL=https://authority.example bash -c 'source "$1"; cloudbench_compute_token_authority_url' _ "$HELPER_SRC")" = "https://authority.example" ] \
    || { echo "an explicit authority URL must win" >&2; exit 1; }
  [ -z "$(BENCHMARK_COMPUTE_TOKEN_AUTHORITY=off CLOUDBENCH_COMPUTE_TOKEN_AUTHORITY_URL=https://authority.example bash -c 'source "$1"; cloudbench_compute_token_authority_url' _ "$HELPER_SRC")" ] \
    || { echo "BENCHMARK_COMPUTE_TOKEN_AUTHORITY=off must opt the guests out" >&2; exit 1; }
  fragment="$(sed -n '/^# Compute-token authority (A1)/,/^fi$/p' "$ROOT_DIR/scripts/cloudbench-run.sh")"
  [ -n "$fragment" ] || { echo "cloudbench-run.sh has no compute-token authority fragment" >&2; exit 1; }
  mkdir -p "$dir/repo/back-end"
  run_fragment() {  # <authority-url> -> STACK_ENV entries, one per line
    env -i PATH="$PATH" CLOUDBENCH_COMPUTE_TOKEN_AUTHORITY_URL="$1" BENCHMARK_COMPUTE_TOKEN_AUTHORITY="${2:-on}" bash -c '
      set -eo pipefail
      source "$1"; REPO_DIR="$2"; STACK_ENV=()
      log() { echo "$*" >&2; }; finish() { exit "$1"; }
      eval "$3"
      printf "%s\n" "${STACK_ENV[@]}"
    ' _ "$HELPER_SRC" "$dir/repo" "$fragment"
  }
  printf 'DATABASE_URL=x\nBACKEND_API_KEY="guest-internal-key"\n' > "$dir/repo/back-end/.env"
  [ "$(run_fragment https://navi-j9a9.onrender.com)" = "$(printf 'BENCHMARK_COMPUTE_TOKEN_AUTHORITY=on\nCOMPUTE_TOKEN_AUTHORITY_URL=https://navi-j9a9.onrender.com\nCOMPUTE_TOKEN_AUTHORITY_API_KEY=guest-internal-key')" ] \
    || { echo "the stack must receive the authority URL and the guest's BACKEND_API_KEY" >&2; exit 1; }
  [ "$(run_fragment '')" = "$(printf 'BENCHMARK_COMPUTE_TOKEN_AUTHORITY=off\nCOMPUTE_TOKEN_AUTHORITY_URL=\nCOMPUTE_TOKEN_AUTHORITY_API_KEY=')" ] || { echo "an opted-out guest must disable local-stack defaults too" >&2; exit 1; }
  [ "$(run_fragment https://authority.example off)" = "$(run_fragment '')" ] \
    || { echo "explicit diagnostic opt-out must override a saved authority URL" >&2; exit 1; }
  printf 'DATABASE_URL=x\n' > "$dir/repo/back-end/.env"
  ! run_fragment https://navi-j9a9.onrender.com > /dev/null 2> "$dir/missing.err" \
    || { echo "a guest without BACKEND_API_KEY must refuse to start" >&2; exit 1; }
  grep -q 'needs BACKEND_API_KEY' "$dir/missing.err"
  python3 - "$ROOT_DIR/scripts/run-bench-cloud" "$ROOT_DIR/scripts/cloudbench-run.sh" <<'PYWIRE'
import sys
from pathlib import Path
cloud, run = (Path(path).read_text() for path in sys.argv[1:])
fresh = '--env "CLOUDBENCH_COMPUTE_TOKEN_AUTHORITY_URL=$(cloudbench_compute_token_authority_url)"'
pooled = 'echo "export CLOUDBENCH_COMPUTE_TOKEN_AUTHORITY_URL=$(printf \'%q\' "$(cloudbench_compute_token_authority_url)")"'
assert cloud.count(fresh) == 1, 'fresh Machines must receive the authority explicitly'
assert cloud.count(pooled) == 1, 'pooled Machines must receive the authority explicitly'
start = run.index('# Compute-token authority (A1)')
assert run.index('STACK_ENV=(') < start < run.index('env "${STACK_ENV[@]}" bash "$REPO_DIR/scripts/run.sh" --benchmark'), \
    'the authority must be in the stack env before run.sh starts'
PYWIRE
) || fail "cloud guests must delegate compute-token state to the shared authority"

# The donor snapshot listing must outlast a provider window that answers a valid empty list. On 2026-11-07 one of nine
# smoke controllers spent its 45 s budget inside such a window ("No complete snapshot"), and the campaign's 1-of-9 infra
# stop cancelled the other eight. Execute the real function against a stubbed provider and clock.
python3 - "$ROOT_DIR" <<'PYSNAP' || fail "donor snapshot listing must survive a minutes-long empty-list window"
import json
import re
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

root = Path(sys.argv[1])
src = (root / "scripts/run-bench-fleet").read_text()
match = re.search(r"^list_donor_snapshots\(\) \{\n.*?^\}\n", src, flags=re.M | re.S)
assert match, "list_donor_snapshots helper is missing"
function = match.group(0)
assert src.count("list_donor_snapshots\n") >= 1 and "for _snap_attempt in 1 2 3 4 5 6" not in src, \
    "the controller must read the donor listing through the retrying helper"
good = json.dumps([{"id": "vs_ok", "status": "created", "created_at": "2026-11-07T07:00:00Z",
                    "size": 123456, "digest": "ab" * 32}])


def scenario(replies):
    with tempfile.TemporaryDirectory() as tmp:
        counter = Path(tmp) / "reads"
        counter.write_text("0")
        script = textwrap.dedent(
            """
            set -uo pipefail
            %s
            SNAPSHOT_SELECTOR_SCRIPT=%s
            VOL_ID=vol_test APP=app_test
            REPLIES=%s
            FLY() {
                local n; n="$(cat %s)"; printf '%%s' "$((n + 1))" > %s
                python3 -c 'import json,sys; r=json.loads(sys.argv[1]); i=int(sys.argv[2]); sys.stdout.write(r[min(i, len(r)-1)])' "$REPLIES" "$n"
            }
            slept=0
            sleep() { slept=$((slept + $1)); }
            list_donor_snapshots
            printf '%%s|%%s|%%s\\n' "$SNAPSHOT_LIST_ATTEMPTS_USED" "$slept" "$SNAPSHOTS_JSON"
            """
        ) % (function, root / "scripts/cloudbench-select-snapshot.py", "'" + json.dumps(replies).replace("'", "'\\''") + "'", counter, counter)
        path = Path(tmp) / "scenario.sh"
        path.write_text(script)
        out = subprocess.run(["bash", str(path)], capture_output=True, text=True, timeout=60, check=True).stdout.strip()
        attempts, slept, listing = out.split("|", 2)
        return int(attempts), int(slept), listing


attempts, _, listing = scenario(["[]"] * 5 + [good])
assert (attempts, "vs_ok" in listing) == (6, True), (attempts, listing)
attempts, _, listing = scenario(["Error: rate limit exceeded"] * 3 + [good])
assert (attempts, "vs_ok" in listing) == (4, True), (attempts, listing)
attempts, slept, listing = scenario(["[]"])
assert (attempts, listing) == (12, "[]") and slept >= 240, (attempts, slept, listing)  # was 6 attempts, 45 s
attempts, slept, listing = scenario(["Error: rate limit exceeded"])
assert (attempts, listing) == (12, "") and slept >= 240, (attempts, slept, listing)
PYSNAP

# A scaled-down worker is destroyed right after its runtime evidence is captured, and one failed flyctl transport read
# ("api.fly.io/graphql: EOF") used to lose that evidence and fail a passing run (test-mass-agent-run-0, 2026-11-07:
# "worker ... runtime evidence was not preserved"). Execute the real capture against a stubbed provider.
python3 - "$ROOT_DIR" <<'PYCAPTURE' || fail "worker runtime evidence capture must retry its transport and still fail closed"
import re
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

root = Path(sys.argv[1])
src = (root / "scripts/run-bench-fleet").read_text()
match = re.search(r"^cloudbench_capture_worker_runtime_evidence\(\) \{[^\n]*\n.*?^\}\n", src, flags=re.M | re.S)
assert match, "cloudbench_capture_worker_runtime_evidence is missing"
function = match.group(0)


def scenario(console_failures, verify_rc):
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        (tmp / "snap").mkdir()
        (tmp / "snap/cloudbench-worker-evidence.py").write_text(f"import sys\nsys.exit({verify_rc})\n")
        base = tmp / "out/worker-runtime-evidence/abc123"
        base.mkdir(parents=True)
        (base / "owner.json").write_text('{"version": 1, "machine_id": "abc123", "run_token": "tok-1"}')
        script = textwrap.dedent(
            """
            set -uo pipefail
            %s
            APP=app_test
            CLOUDBENCH_SCRIPT_SNAPSHOT=%s
            out=%s
            retained=0 console_calls=0 sftp_calls=0
            cloudbench_preserve_unlaunched_worker() { return 1; }
            cloudbench_retain_runtime_evidence() { retained=$((retained + 1)); }
            sleep() { :; }
            fly_with_timeout() {
                shift
                case "$1 $2" in
                    "ssh console") console_calls=$((console_calls + 1)); [ "$console_calls" -gt %d ] ;;
                    "ssh sftp") sftp_calls=$((sftp_calls + 1)); : > "$out/worker-runtime-evidence/abc123/evidence.tar" ;;
                    *) return 99 ;;
                esac
            }
            cloudbench_capture_worker_runtime_evidence "$out" abc123; rc=$?
            printf '%%s %%s %%s %%s\\n' "$rc" "$console_calls" "$sftp_calls" "$retained"
            """
        ) % (function, tmp / "snap", tmp / "out", console_failures)
        path = tmp / "scenario.sh"
        path.write_text(script)
        out = subprocess.run(["bash", str(path)], capture_output=True, text=True, timeout=60, check=True).stdout.split()
        return tuple(int(value) for value in out)


assert scenario(2, 0) == (0, 3, 1, 0), "a transport that recovers on the third read must preserve the evidence"
assert scenario(99, 0) == (1, 4, 0, 1), "an unreachable worker must still fail closed after four reads"
assert scenario(0, 1) == (1, 1, 1, 1), "a verification failure is a verdict on the bytes and is not retried"
PYCAPTURE
