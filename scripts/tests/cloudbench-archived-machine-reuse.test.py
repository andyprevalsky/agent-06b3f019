#!/usr/bin/env python3
import copy
from contextlib import contextmanager
import json
from pathlib import Path
import runpy
import tempfile
import unittest
import os
import subprocess
from unittest import mock

H = runpy.run_path(str(Path(__file__).resolve().parents[1] / "cloudbench-archived-machine-reuse.py"))


def fixture(count=1):
    machines = []
    rows = []
    for i in range(count):
        m = dict(
            id=f"{i + 1:014x}",
            name=f"old-native-{i}",
            instance_id=f"old-version-{i}",
            created_at="2026-10-01",
            region="iad",
            state="stopped",
            config=dict(
                image="registry.fly.io/navi-whisper-lux-bench:fixture@sha256:" + "1" * 64,
                persist_rootfs="never",
                mounts=[dict(volume=f"vol_old{i}", path="/data")],
                init=dict(cmd=["bash", "/cloudbench-boot.sh"]),
                guest=dict(cpus=2, memory_mb=4096, cpu_kind="shared"),
            ),
        )
        machines.append(m)
        rows.append(H["target_from"](m, dict(volume_id=f"vol_old{i}", owner_token="a" * 32), "b" * 64))
    request = dict(
        image_ref="registry.fly.io/navi-whisper-lux-bench@sha256:" + "1" * 64,
        schema=H["SCHEMA"],
        storage_mode=H["STORAGE"],
        app=H["APP"],
        cohort="c" * 32,
        harness_ref="d" * 40,
        task_ref=H["TASK_REF"],
        archives=[dict(archive_sha256="b" * 64)],
        candidates=rows,
    )
    successor = dict(
        controller_id="f" * 14,
        harness_ref="d" * 40,
        task_ref=H["TASK_REF"],
        owner_token="e" * 32,
        ordinal=0,
        run_id="new-run",
        task="original-name",
    )
    return request, machines, successor


class Tests(unittest.TestCase):
    def test_capacity_all376_preserves_original600(self):
        request, machines, _ = fixture(376)
        result = H["capacity_demand"](request, machines, {"f" * 14})
        self.assertEqual(result["new_machine_demand"], 225)
        self.assertEqual(result["qualified_reuse_count"], 376)
        self.assertEqual(result["original_tasks"], 600)
        self.assertEqual(len({r["name"] for r in machines}), 376)

    def test_stale_foreign_protected_or_duplicate_never_get_capacity_credit(self):
        for change in ("running", "version", "config", "volume", "protected", "duplicate", "marker"):
            request, machines, _ = fixture()
            protected = set()
            if change == "running":
                machines[0]["state"] = "started"
            if change == "version":
                machines[0]["instance_id"] = "changed"
            if change == "config":
                machines[0]["config"]["extra"] = "changed"
            if change == "volume":
                machines[0]["config"]["mounts"][0]["volume"] = "vol_foreign"
            if change == "protected":
                protected.add(machines[0]["id"])
            if change == "duplicate":
                request["candidates"].append(request["candidates"][0])
            if change == "marker":
                machines[0]["config"]["metadata"] = {H["MARKER"]: "foreign"}
            with self.subTest(change=change), self.assertRaises(ValueError):
                H["capacity_demand"](request, machines, protected)

    def test_native_claim_preserves_id_volume_and_oldname_and_is_idempotent(self):
        request, machines, successor = fixture()
        current = copy.deepcopy(machines[0])
        effects = []

        class API:
            @contextmanager
            def lease(self, mid):
                effects.append(("lease", mid))
                yield

            def request(self, method, url, body=None):
                nonlocal current
                if method == "GET":
                    if "/wait?" in url:
                        return dict(ok=True)
                    return copy.deepcopy(current)
                effects.append((method, url, body))
                self.assert_version(body)
                current = dict(current, config=body["config"], instance_id="new-version")
                return copy.deepcopy(current)

            def assert_version(self, body):
                assert body["current_version"] == "old-version-0" and body["skip_launch"] is True

        with tempfile.TemporaryDirectory() as tmp:
            result = H["claim_native"](API(), request, request["candidates"][0], successor, Path(tmp) / "journal")
            again = H["claim_native"](API(), request, request["candidates"][0], successor, Path(tmp) / "journal")
            self.assertEqual(result, again)
            self.assertEqual(current["id"], machines[0]["id"])
            self.assertEqual(current["name"], "old-native-0")
            self.assertEqual(current["config"]["mounts"], machines[0]["config"]["mounts"])
            self.assertEqual(sum(e[0] == "POST" for e in effects), 1)
            self.assertNotIn("fresh-clone", json.dumps(result))
            self.assertIn("UNRESOLVED", result["old_liabilities"])
            self.assertEqual(result["guest"]["data_dir"], "/data/.cloudbench-generations/" + result["claim_id"])
            self.assertTrue((Path(tmp) / "journal/source-exclusion.json").exists())

    def test_lost_ack_or_foreign_claim_never_reposts_or_releases(self):
        request, machines, successor = fixture()
        current = copy.deepcopy(machines[0])
        posts = []

        class API:
            @contextmanager
            def lease(self, mid):
                yield

            def request(self, method, url, body=None):
                nonlocal current
                if method == "GET":
                    if "/wait?" in url:
                        return dict(ok=True)
                    return copy.deepcopy(current)
                posts.append(body)
                current = dict(current, config=body["config"], instance_id="new-version")
                raise TimeoutError("lost ACK")

        with tempfile.TemporaryDirectory() as tmp:
            journal = Path(tmp) / "journal"
            with self.assertRaises(TimeoutError):
                H["claim_native"](API(), request, request["candidates"][0], successor, journal)
            H["claim_native"](API(), request, request["candidates"][0], successor, journal)
            self.assertEqual(len(posts), 1)
            successor["owner_token"] = "9" * 32
            with self.assertRaises(ValueError):
                H["claim_native"](API(), request, request["candidates"][0], successor, Path(tmp) / "foreign")
            self.assertEqual(len(posts), 1)


class IntegratedControls(unittest.TestCase):
    def test_actual_fly_mutation_grammar_and_owner_journals(self):
        import shlex

        root = Path(__file__).resolve().parents[2]
        source = (root / "scripts/run-bench-fleet").read_text()
        function = "FLY() {" + source.split("FLY() {", 1)[1].split("\nis_sim_on()", 1)[0]
        with tempfile.TemporaryDirectory() as tmp:
            capture = Path(tmp) / "calls"
            prefix = (
                "source "
                + shlex.quote(str(root / "scripts/lib/cloudbench-archived-reuse.sh"))
                + "\n"
                + "APP=navi-whisper-lux-bench; ROOT_DIR="
                + shlex.quote(str(root))
                + "\n"
                + "GIT_COMMON_DIR="
                + shlex.quote(tmp)
                + "; FLEET_OWNER_TOKEN="
                + "a" * 32
                + "; RUN_ID=first; CAPTURE="
                + shlex.quote(str(capture))
                + "\n"
                + "private_source_allows_provider_call(){ return 0; }\n"
                + 'python3(){ printf "%s\\n" "$*" >> "$CAPTURE"; }\n'
                + function
            )
            for args in (
                "machine destroy --force 1234567890abcd -a navi-whisper-lux-bench",
                "machines destroy 1234567890abcd --app=navi-whisper-lux-bench -f",
                "machine stop 1234567890abcd -a navi-whisper-lux-bench",
            ):
                result = subprocess.run(["bash", "-c", prefix + "\nFLY " + args], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
            lines = capture.read_text().splitlines()
            self.assertTrue(all("--machine 1234567890abcd --operation" in line for line in lines))
            self.assertTrue(all("/" + "a" * 32 + "/first/" in line for line in lines))
            capture.unlink()
            for args in (
                "machine destroy --force 1234567890abcd 1234567890abce -a navi-whisper-lux-bench",
                "machine stop 1234567890abcd --unknown -a navi-whisper-lux-bench",
                "machine stop 1234567890abcd -a navi-whisper-lux",
            ):
                result = subprocess.run(["bash", "-c", prefix + "\nFLY " + args], capture_output=True)
                self.assertNotEqual(result.returncode, 0)
            self.assertFalse(capture.exists())
            script = (
                prefix
                + "\nFLY machine stop 1234567890abcd -a navi-whisper-lux-bench\nFLEET_OWNER_TOKEN="
                + "b" * 32
                + "; RUN_ID=second\nFLY machine stop 1234567890abcd -a navi-whisper-lux-bench"
            )
            subprocess.run(["bash", "-c", script], check=True)
            first, second = capture.read_text().splitlines()
            self.assertNotEqual(first, second)

    def test_predecessor_effect_reconciles_stop_but_never_replays_unknown(self):
        _, machines, _ = fixture()
        current = copy.deepcopy(machines[0])
        current["state"] = "started"
        posts = []
        lost = False

        class API:
            @contextmanager
            def lease(self, mid):
                yield

            def request(self, method, url, body=None):
                if method == "GET":
                    return copy.deepcopy(current)
                posts.append((method, url))
                if lost:
                    raise TimeoutError("lost ACK")
                current["state"] = "stopped"
                return {"ok": True}

        with tempfile.TemporaryDirectory() as tmp:
            first = Path(tmp) / "first"
            second = Path(tmp) / "second"
            H["fenced_native_effect"](API(), current["id"], "stop", first)
            H["fenced_native_effect"](API(), current["id"], "stop", first)
            self.assertEqual(len(posts), 1)
            current["state"] = "started"
            H["fenced_native_effect"](API(), current["id"], "stop", second)
            self.assertEqual(len(posts), 2)
            current["state"] = "started"
            lost = True
            unknown = Path(tmp) / "unknown"
            with self.assertRaises(TimeoutError):
                H["fenced_native_effect"](API(), current["id"], "stop", unknown)
            with self.assertRaises(ValueError):
                H["fenced_native_effect"](API(), current["id"], "stop", unknown)
            self.assertEqual(len(posts), 3)
            current["state"] = "stopped"
            H["fenced_native_effect"](API(), current["id"], "stop", unknown)
            self.assertEqual(len(posts), 3)
            current["config"]["metadata"] = {H["MARKER"]: "successor"}
            with self.assertRaises(ValueError):
                H["fenced_native_effect"](API(), current["id"], "stop", Path(tmp) / "foreign")
            self.assertEqual(len(posts), 3)

    def test_actual600_single_task_children_and_retry_indices(self):
        request, machines, successor = fixture(376)
        names = json.loads((Path(__file__).parent / "fixtures/original600-tasks.json").read_text())
        request["task_names"] = names
        for index in (0, 199, 200, 599):
            child = dict(
                successor,
                campaign_job_id=f"r{index // 200 + 1:03d}-j{index + 1:04d}",
                campaign_total_jobs=600,
                campaign_attempt=1,
                task=names[index % 200],
            )
            self.assertEqual(H["campaign_candidate_index"](request, child), index)
            for key, value in [
                ("ordinal", index + 1),
                ("task", "wrong"),
                ("campaign_total_jobs", 599),
                ("campaign_job_id", "r999-j0001"),
            ]:
                with self.subTest(index=index, key=key), self.assertRaises(ValueError):
                    H["campaign_candidate_index"](request, dict(child, **{key: value}))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "request.json"
            for row in request["candidates"]:
                row["reservation"] = {"cohort": request["cohort"]}
            H["save"](path, request)
            env = dict(
                os.environ,
                CLOUDBENCH_ARCHIVED_REUSE_REQUEST=str(path),
                CLOUDBENCH_ARCHIVED_REUSE_REQUEST_SHA256=H["sha"](path.read_bytes()),
                RUN_BENCH_CAMPAIGN_JOB_ID="r002-j0201",
                RUN_BENCH_CAMPAIGN_TOTAL_JOBS="600",
            )
            command = [
                "python3",
                "-S",
                str(Path(__file__).resolve().parents[1] / "cloudbench-archived-machine-reuse.py"),
                "capacity-credit",
                "--task",
                names[0],
            ]
            self.assertEqual(subprocess.check_output(command, env=env, text=True).strip(), "1")
            env["RUN_BENCH_CAMPAIGN_ATTEMPT"] = "2"
            self.assertEqual(subprocess.check_output(command, env=env, text=True).strip(), "0")

    def test_reservation_before_credit_created_resume_and_foreign_cohort(self):
        request, machines, _ = fixture()
        current = copy.deepcopy(machines[0])
        posts = []

        class API:
            @contextmanager
            def lease(self, mid):
                yield

            def request(self, method, url, body=None):
                nonlocal current
                if method == "GET":
                    if "/wait?" in url:
                        return dict(ok=True)
                    return copy.deepcopy(current)
                posts.append(body)
                current = dict(current, config=body["config"], instance_id="reserved-version", state="created")
                return copy.deepcopy(current)

        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                H["capacity_demand"](request, machines, set(), require_reserved=True)
            reserved = H["reserve_cohort"](lambda out: API(), request, Path(directory) / "first")
            self.assertEqual(
                H["capacity_demand"](reserved, [current], set(), require_reserved=True)["new_machine_demand"], 600
            )
            self.assertEqual(H["reserve_cohort"](lambda out: API(), request, Path(directory) / "first"), reserved)
            self.assertEqual(len(posts), 1)
            with self.assertRaises(ValueError):
                H["reserve_cohort"](lambda out: API(), dict(request, cohort="f" * 32), Path(directory) / "foreign")
            self.assertEqual(len(posts), 1)

    def test_lost_reservation_ack_with_old_visibility_never_reposts(self):
        request, machines, _ = fixture()
        posts = []

        class API:
            @contextmanager
            def lease(self, mid):
                yield

            def request(self, method, url, body=None):
                if method == "GET":
                    return copy.deepcopy(machines[0])
                posts.append(body)
                raise TimeoutError("unknown provider effect")

        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(TimeoutError):
                H["reserve_cohort"](lambda out: API(), request, directory)
            with self.assertRaises(ValueError):
                H["reserve_cohort"](lambda out: API(), request, directory)
            self.assertEqual(len(posts), 1)

    def test_actual_archive_parser_and_current_marker_exclusion(self):
        previous = runpy.run_path(str(Path(__file__).with_name("cloudbench-archived-owner-stop.test.py")))[
            "ArchivedStop"
        ]()
        previous.setUp()
        try:
            inventory = json.loads(previous.inventory.read_text())
            inventory[0]["state"] = "stopped"
            inventory[0]["region"] = "iad"
            previous.inventory.write_text(json.dumps(inventory))
            previous.inventory.chmod(0o600)
            request = H["prepare_request"]([previous.run], previous.inventory, "c" * 32, "d" * 40)
            self.assertEqual([r["machine_id"] for r in request["candidates"]], [previous.mid])
            inventory[0]["config"]["metadata"] = {H["MARKER"]: "new-successor"}
            previous.inventory.write_text(json.dumps(inventory))
            previous.inventory.chmod(0o600)
            with self.assertRaises(ValueError):
                H["prepare_request"]([previous.run], previous.inventory, "e" * 32, "d" * 40)
        finally:
            previous.doCleanups()

    def test_native_wire_reuses_auth_and_unique_durable_journals_on_resume(self):
        import http.server
        import threading
        import types

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                self.respond(dict(data=dict(nonce="fixture-nonce")))

            def do_DELETE(self):
                self.respond({})

            def do_GET(self):
                self.respond(dict(id="exact-fixture"))

            def respond(self, value):
                data = json.dumps(value).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                api = types.SimpleNamespace(
                    app=H["APP"],
                    base=f"http://127.0.0.1:{server.server_port}",
                    authorization="Bearer already-resolved",
                    loopback=True,
                    env=dict(os.environ, FLY_API_TOKEN="unused-original"),
                )
                for attempt in range(2):
                    adapter = H["NativeAdapter"](api, directory)
                    with adapter.lease("a" * 14):
                        self.assertEqual(adapter.request("GET", "/machines/" + "a" * 14), dict(id="exact-fixture"))
                records = list(Path(directory).glob("*/0001-wire.json"))
                self.assertEqual(len(records), 6)
                for record in records:
                    wire = json.loads(record.read_bytes())
                    self.assertEqual(wire["status"], 200)
                    self.assertEqual(H["sha"](__import__("base64").b64decode(wire["body_b64"])), wire["sha256"])
                self.assertFalse(
                    any(b"already-resolved" in path.read_bytes() for path in Path(directory).rglob("*.json"))
                )
        finally:
            server.shutdown()
            thread.join()
            server.server_close()

    def test_lost_stop_ack_resume_and_terminal_reentry_do_not_repeat_stop(self):
        request, machines, successor = fixture()
        proof = H["proof_for"](request, request["candidates"][0], successor)
        current = copy.deepcopy(machines[0])
        current["state"] = "started"
        current["config"]["metadata"] = {H["MARKER"]: H["canonical"](proof["native_marker"]).decode()}
        posts = []

        class API:
            @contextmanager
            def lease(self, mid):
                yield

            def request(self, method, url, body=None):
                if method == "GET":
                    return copy.deepcopy(current)
                posts.append(url)
                current["state"] = "stopped"
                raise TimeoutError("STOP accepted but ACK lost")

        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(TimeoutError):
                H["retire_native"](API(), proof, directory)
            H["retire_native"](API(), proof, directory)
            H["retire_native"](API(), proof, directory)
            self.assertEqual(posts, ["/machines/" + proof["machine_id"] + "/stop"])
            terminal = json.loads((Path(directory) / "retained-terminal.json").read_bytes())
            self.assertTrue(terminal["machine_retained"])
            self.assertTrue(terminal["volume_retained"])
            self.assertEqual(terminal["old_liabilities"], "UNRESOLVED")

    def test_actual_fleet_hook_credit_and_nested_canary_scope(self):
        root = Path(__file__).resolve().parents[2]
        library = root / "scripts/lib/cloudbench-archived-reuse.sh"
        output = subprocess.check_output(
            [
                "bash",
                "-c",
                'source "$1"; CLOUDBENCH_ARCHIVED_REUSE_REQUEST=/missing; CLOUDBENCH_INFRA_CANARY_PREFLIGHT_ACTIVE=1; archived_reuse_allocate task /missing; archived_reuse_capacity_credit',
                "fixture",
                str(library),
            ],
            text=True,
        )
        self.assertEqual(output, "0")
        source = (root / "scripts/run-bench-fleet").read_text()
        start = source.index("provision_primary_machine() {")
        function = source[start : source.index("\n}\n", start) + 3]
        script = (
            function
            + "\narchived_reuse_allocate() { printf retained-mid; }; primary_vm_size_for_bench() { exit 99; }; clone_machine_target() { exit 98; }; provision_primary_machine task /unused"
        )
        subprocess.run(["bash", "-c", script], check=True)
        start = source.index("    local archived_reuse_count", source.index("enforce_app_capacity_guard()"))
        end = source.index('    if [ "${POOL_REUSE_ONLY:-0}"', start)
        fragment = source[start:end]
        script = (
            "test_guard() { requested_machines=1; available_pool_machines=0; replacement_slots=3; requested_shared=2; archived_reuse_capacity_credit() { printf 1; }; "
            + fragment
            + '\nreservation_machine_slots=$((requested_fresh_machines+replacement_slots)); printf "%s %s %s" "$requested_fresh_machines" "$reservation_machine_slots" "$requested_shared"; }; test_guard'
        )
        self.assertEqual(subprocess.check_output(["bash", "-c", script], text=True), "0 3 2")

    def test_successor_chain_binds_current_marker_and_excludes_predecessor(self):
        request, machines, successor = fixture()
        first = H["proof_for"](request, request["candidates"][0], successor)
        current = copy.deepcopy(machines[0])
        current["instance_id"] = "second-version"
        current["config"]["metadata"] = {H["MARKER"]: H["canonical"](first["native_marker"]).decode()}
        row = H["target_from"](current, dict(volume_id=first["volume_id"], archived_reuse_proof=first), "9" * 64)
        later = dict(request, cohort="8" * 32, archives=[dict(archive_sha256="9" * 64)], candidates=[row])
        second = H["proof_for"](later, row, dict(successor, owner_token="7" * 32, controller_id="6" * 14))
        self.assertNotEqual(first["generation_id"], second["generation_id"])
        self.assertEqual(first["volume_id"], second["volume_id"])
        self.assertEqual(
            second["native_marker"]["prior_marker_sha256"], H["sha"](H["canonical"](first["native_marker"]))
        )
        with self.assertRaises(ValueError):
            H["same_source"](request["candidates"][0], current)
        current["config"]["metadata"][H["MARKER"]] = H["canonical"](second["native_marker"]).decode()
        with self.assertRaises(ValueError):
            H["target_from"](current, dict(volume_id=first["volume_id"], archived_reuse_proof=first), "9" * 64)

    def test_concrete_fly_raw_observer_before_parse_and404(self):
        import io
        import urllib.error

        source = H["module"]("cloudbench-original-volume-capture.py")
        api = object.__new__(source["Fly"])
        api.app = H["APP"]
        api.base = "https://fixture.invalid"
        api.authorization = "Bearer private-fixture"
        api.loopback = False

        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def read(self, size):
                return b"not-json"

        records = []
        opener = mock.Mock()
        opener.open.return_value = Response()
        with mock.patch("urllib.request.build_opener", return_value=opener):
            with self.assertRaises(json.JSONDecodeError):
                api.api("GET", "/machines/a", observer=lambda *args: records.append(args))
        self.assertEqual(records[0][2:], (200, b"not-json"))
        opener.open.side_effect = urllib.error.HTTPError("fixture", 404, "missing", {}, io.BytesIO(b"actual404"))
        with mock.patch("urllib.request.build_opener", return_value=opener):
            with self.assertRaises(source["NotFound"]):
                api.api("GET", "/machines/a", observer=lambda *args: records.append(args))
        self.assertEqual(records[1][2:], (404, b"actual404"))


if __name__ == "__main__":
    unittest.main()
