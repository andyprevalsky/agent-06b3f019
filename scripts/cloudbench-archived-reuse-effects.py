#!/usr/bin/env python3
"""Bounded leased effects; validation callbacks are supplied by the reuse owner."""

import base64
from contextlib import contextmanager
import copy
import json
from pathlib import Path
import time
from urllib.parse import quote

HERE = Path(__file__).resolve().parent

_contract = globals().pop("VALIDATION")
need = _contract["need"]
canonical = _contract["canonical"]
sha = _contract["sha"]
config_sha = _contract["config_sha"]
module = _contract["module"]
private = _contract["private"]
save = _contract["save"]
exact_or_save = _contract["exact_or_save"]
validate_request = _contract["validate_request"]
same_source = _contract["same_source"]
MARKER = _contract["MARKER"]
SCHEMA = _contract["SCHEMA"]


class NativeAdapter:
    """Existing bounded Fly transport plus a native lease nonce on every owned write."""

    def __init__(self, api, journal=None):
        self.api = api
        self.nonce = None
        self.journal = Path(journal) if journal else None
        self.sequence = 0
        self.lease_end = 0

    def observe(self, method, url, status, raw):
        if self.journal is not None:
            self.journal.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.sequence += 1
            save(
                self.journal / (str(self.sequence).zfill(4) + "-wire.json"),
                dict(
                    method=method,
                    path=url,
                    status=status,
                    body_b64=base64.b64encode(raw).decode(),
                    sha256=sha(raw),
                    monotonic_ns=time.monotonic_ns(),
                ),
            )

    def wire(self, method, url, body=None, timeout=30, headers=None):
        # A socket timeout does not bound drip-fed headers/bodies. Each exact
        # request has an owned subprocess, absolute deadline, and mandatory join.
        import uuid

        need(self.journal is not None, "durable native response journal required")
        directory = self.journal / uuid.uuid4().hex
        directory.mkdir(parents=True, mode=0o700)
        save(
            directory / "request.json",
            dict(app=self.api.app, method=method, path=url, body=body, timeout=timeout, headers=headers or {}),
        )
        with open(
            directory / "stderr.private.log", "xb", opener=lambda path, flags: __import__("os").open(path, flags, 0o600)
        ) as errors:
            self._run_wire(directory, method, url, body, timeout, headers, errors)
        return json.loads(private(directory / "result.json"))

    def _run_wire(self, directory, method, url, body, timeout, headers, errors):
        import subprocess
        import sys

        subprocess.run(
            [sys.executable, "-S", str(HERE / "cloudbench-archived-machine-reuse.py"), "wire", str(directory)],
            env=dict(
                self.api.env,
                CLOUDBENCH_WIRE_AUTH=self.api.authorization,
                CLOUDBENCH_WIRE_BASE=self.api.base,
                CLOUDBENCH_WIRE_LOOPBACK=str(int(self.api.loopback)),
            ),
            check=True,
            timeout=timeout + 5,
            stdout=subprocess.DEVNULL,
            stderr=errors,
        )

    def request(self, method, url, body=None):
        headers = {"fly-machine-lease-nonce": self.nonce} if self.nonce else {}
        need(method == "GET" or self.nonce, "native write without exclusive lease")
        need(not self.nonce or time.monotonic() + 40 < self.lease_end, "native lease budget exhausted before operation")
        return self.wire(method, url, body, headers=headers)

    @contextmanager
    def lease(self, mid):
        response = self.wire(
            "POST",
            "/machines/" + mid + "/lease",
            {"ttl": 180, "description": "archived same-volume successor"},
            timeout=20,
        )
        nonce = response.get("data", {}).get("nonce")
        need(isinstance(nonce, str) and nonce, "native lease nonce absent")
        self.nonce = nonce
        self.lease_end = time.monotonic() + 155
        try:
            yield
        finally:
            self.wire("DELETE", "/machines/" + mid + "/lease", timeout=20, headers={"fly-machine-lease-nonce": nonce})
            self.nonce = None


def reserve_cohort(api_factory, request, journal):
    """Offline eligibility is not capacity credit. Every credited ID is first natively reserved."""
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    cancelled = Event()
    validate_request(request)
    journal = Path(journal)
    journal.mkdir(parents=True, exist_ok=True, mode=0o700)

    def reserve(row):
        out = journal / row["machine_id"]
        out.mkdir(mode=0o700, exist_ok=True)
        marker = dict(
            schema=SCHEMA,
            state="RESERVED",
            cohort=request["cohort"],
            machine_id=row["machine_id"],
            volume_id=row["volume_id"],
            source_excluded=True,
            archive_sha256=row["archive_sha256"],
            harness_ref=request["harness_ref"],
        )
        need(not cancelled.is_set(), "reservation admission interrupted before native effect")
        api = api_factory(out)
        with api.lease(row["machine_id"]):
            url = "/machines/" + row["machine_id"]
            current = api.request("GET", url)
            if current["config"].get("metadata", {}).get(MARKER) != canonical(marker).decode():
                same_source(row, current)
                need(not (out / "intent.json").exists(), "unknown reservation update; reconcile only")
                config = copy.deepcopy(current["config"])
                config.setdefault("metadata", {})[MARKER] = canonical(marker).decode()
                config["init"] = {"cmd": ["sleep", "infinity"]}
                save(out / "original-native.json", current)
                save(out / "source-exclusion.json", dict(predecessor=row, marker=marker))
                save(
                    out / "intent.json", dict(current_version=current["instance_id"], config_sha256=config_sha(config))
                )
                need(not cancelled.is_set(), "reservation admission interrupted before native update")
                ack = api.request(
                    "POST", url, dict(config=config, current_version=current["instance_id"], skip_launch=True)
                )
                need(
                    ack.get("id") == row["machine_id"]
                    and isinstance(ack.get("instance_id"), str)
                    and ack["instance_id"]
                    and ack["instance_id"] != current["instance_id"]
                    and config_sha(ack["config"]) == config_sha(config),
                    "reservation ACK mismatch",
                )
                waited = api.request(
                    "GET",
                    url
                    + "/wait?state="
                    + ("created" if ack.get("state") == "created" else "stopped")
                    + "&instance_id="
                    + quote(ack["instance_id"], safe="")
                    + "&timeout=10",
                )
                need(waited.get("ok") is True, "reservation native version wait did not confirm")
                current = api.request("GET", url)
                need(current["instance_id"] == ack["instance_id"], "reservation native version not visible")
            intent = json.loads(private(out / "intent.json"))
            need(
                current["state"] in ("created", "stopped") and config_sha(current["config"]) == intent["config_sha256"],
                "reserved config/state changed",
            )
            reserved = dict(
                row,
                source_instance_id=current["instance_id"],
                source_config_sha256=config_sha(current["config"]),
                prior_marker=canonical(marker).decode(),
                reservation=dict(
                    cohort=request["cohort"],
                    marker=marker,
                    instance_id=current["instance_id"],
                    config_sha256=config_sha(current["config"]),
                ),
            )
            exact_or_save(out / "reserved.json", reserved)
            return reserved

    # Native calls only when invoked by the explicit operator --run path.
    workers = ThreadPoolExecutor(max_workers=16)
    futures = []
    try:
        futures = [workers.submit(reserve, row) for row in request["candidates"]]
        rows = [future.result() for future in futures]
    except BaseException:
        cancelled.set()
        for future in futures:
            future.cancel()
        raise
    finally:
        workers.shutdown(wait=True, cancel_futures=True)
    value = dict(request, candidates=rows)
    exact_or_save(journal / "reserved-request.json", value)
    return value


def retire_native(api, proof, journal):
    """Stop only the current successor, retaining the Machine/Volume/claims/data."""
    journal = Path(journal)
    journal.mkdir(mode=0o700, parents=True, exist_ok=True)
    url = "/machines/" + proof["machine_id"]
    with api.lease(proof["machine_id"]):
        current = api.request("GET", url)
        need(
            current["config"].get("metadata", {}).get(MARKER) == canonical(proof["native_marker"]).decode(),
            "cannot retire foreign successor",
        )
        need(
            [m["volume"] for m in current["config"].get("mounts", [])] == [proof["volume_id"]],
            "successor volume changed",
        )
        observation = journal / "retirement-observation.json"
        if observation.exists():
            original = json.loads(private(observation))
            need(
                all(original.get(key) == current.get(key) for key in ("id", "instance_id", "config")),
                "successor retirement identity changed",
            )
        else:
            save(observation, current)
        if current["state"] not in ("stopped", "created"):
            intent = journal / "stop-intent.json"
            if intent.exists():
                raise ValueError("ambiguous prior STOP; reconcile only, never repeat")
            save(intent, dict(instance_id=current["instance_id"], claim_id=proof["claim_id"]))
            api.request("POST", url + "/stop", dict(signal="SIGTERM", timeout="10s"))
            api.request("GET", url + "/wait?state=stopped&instance_id=" + current["instance_id"] + "&timeout=10")
        after = api.request("GET", url)
        need(
            after["state"] in ("stopped", "created")
            and after["instance_id"] == current["instance_id"]
            and after["config"] == current["config"],
            "successor native retirement unconfirmed",
        )
        terminal = journal / "retained-terminal.json"
        if terminal.exists():
            previous = json.loads(private(terminal))
            need(
                previous["proof"] == proof
                and all(previous["native"].get(key) == after.get(key) for key in ("id", "instance_id", "config")),
                "retained terminal identity changed",
            )
            return after
        exact_or_save(
            terminal,
            dict(
                schema=SCHEMA,
                proof=proof,
                native=after,
                source="archived-reuse",
                machine_retained=True,
                volume_retained=True,
                old_liabilities="UNRESOLVED",
            ),
        )
    return after
