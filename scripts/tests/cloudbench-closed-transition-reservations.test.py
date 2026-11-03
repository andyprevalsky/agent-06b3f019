#!/usr/bin/env python3
"""Offline version-fenced closed-transition eligibility controls."""

import copy
import runpy
import tempfile
from unittest import mock
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
M = runpy.run_path(str(ROOT / "scripts/cloudbench-closed-transition-reservations.py"))


class ClosedTransition(unittest.TestCase):
    def fixture(self):
        mid = "a" * 14
        before = dict(
            id=mid,
            instance_id="old",
            config={},
            name="native",
            region="ord",
            created_at="recorded",
            state="stopped",
        )
        expected = dict(metadata=dict(claim="new"))
        update = dict(
            app=M["H"]["APP"],
            method="POST",
            path="/machines/" + mid,
            headers={"fly-machine-lease-nonce": "nonce"},
            body=dict(config=expected, current_version="old", skip_launch=True),
        )
        records = [
            (
                1,
                dict(
                    app=M["H"]["APP"], method="POST", path="/machines/" + mid + "/lease"
                ),
                dict(data=dict(nonce="nonce")),
                201,
            ),
            (
                2,
                dict(
                    app=M["H"]["APP"],
                    method="GET",
                    path="/machines/" + mid,
                    headers={"fly-machine-lease-nonce": "nonce"},
                ),
                before,
                200,
            ),
            (3, update, None, None),
        ]
        return (
            before,
            copy.deepcopy(before),
            update,
            dict(current_version="old", config_sha256=M["config_sha"](expected)),
            records,
            mid,
            expected,
        )

    def test_unknown_effect_is_zero_credit_and_prior_state_exact(self):
        args = self.fixture()
        proof = M["unchanged"](*args)
        self.assertEqual(proof["capacity_credit"], 0)
        self.assertEqual(proof["old_outcome"], "UNKNOWN_OR_ERROR_RETAINED")
        for key in ("instance_id", "config", "name", "created_at", "region"):
            bad = list(copy.deepcopy(args))
            bad[1][key] = "changed"
            with self.subTest(key=key), self.assertRaises(ValueError):
                M["unchanged"](*bad)
        for code in (409, 499):
            bad = list(copy.deepcopy(args))
            bad[4][-1] = (*bad[4][-1][:3], code)
            self.assertEqual(M["unchanged"](*bad)["old_response_status"], code)

    def test_extra_writer_repeat_cas_missing_lease_and_wrong_version_deny(self):
        for mutation in ("second", "version", "lease", "foreign"):
            args = list(copy.deepcopy(self.fixture()))
            if mutation == "second":
                args[4].append(args[4][-1])
            elif mutation == "version":
                args[2]["body"]["current_version"] = "other"
            elif mutation == "lease":
                args[4].pop(0)
            else:
                args[4].append(
                    (
                        4,
                        dict(
                            app=M["H"]["APP"],
                            method="DELETE",
                            path="/machines/" + args[5],
                        ),
                        None,
                        None,
                    )
                )
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                M["unchanged"](*args)

    def test_omitted_requires_positive_ancestry_and_no_archived_task_claim(self):
        before, current, update, intent, records, mid, _ = self.fixture()
        before["config"] = dict(mounts=[dict(volume="vol_fixture")])
        current = copy.deepcopy(before)
        row = dict(
            machine_id=mid,
            volume_id="vol_fixture",
            name=before["name"],
            created_at=before["created_at"],
            source_instance_id=before["instance_id"],
            source_config_sha256=M["config_sha"](before["config"]),
            prior_marker=None,
            archive_sha256="f" * 64,
        )
        ancestry = dict(directory="/old-expired")
        row["expired_reservation_proof"] = dict(
            ancestry,
            original_failure_retained=True,
            positive_held_ack=False,
            capacity_credit=0,
        )
        request = dict(
            cohort="c" * 32,
            harness_ref="d" * 40,
            archives=[
                dict(
                    archive_sha256=row["archive_sha256"],
                    expired_admission=ancestry,
                    inputs={},
                )
            ],
        )
        marker = dict(
            schema=M["H"]["SCHEMA"],
            state="RESERVED",
            cohort=request["cohort"],
            machine_id=mid,
            volume_id=row["volume_id"],
            source_excluded=True,
            archive_sha256=row["archive_sha256"],
            harness_ref=request["harness_ref"],
        )
        expected = copy.deepcopy(before["config"])
        expected.update(
            metadata={M["H"]["MARKER"]: M["canonical"](marker).decode()},
            init=dict(cmd=["sleep", "infinity"]),
        )
        intent = dict(current_version="old", config_sha256=M["config_sha"](expected))
        update["body"]["config"] = expected
        records[1] = (2, records[1][1], before, 200)
        wire = [
            (req, dict(monotonic_ns=at, status=code), value, None)
            for at, req, value, code in records
        ]
        objects = {
            "original-native.json": before,
            "source-exclusion.json": dict(predecessor=row, marker=marker),
            "intent.json": intent,
            "dispatch-entered.json": dict(
                intent_sha256=M["H"]["sha"](M["canonical"](intent))
            ),
        }
        checked = []
        source = dict(
            validate_handoff=lambda _: checked.append("closure"),
            plan=lambda _: dict(
                directory="/old-expired",
                inputs={},
                original_request=dict(candidates=[row], cohort="old"),
                closed_request=dict(candidates=[row]),
            ),
            U=dict(
                validate_candidate=lambda *_: checked.append("positive-reservation")
            ),
            SOURCE="oldsource",
            obj=lambda path, _: objects[path.name],
        )
        incomplete = dict(classified_wire=lambda *_: (wire, [], []))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "archived-reuse-reservations" / mid
            path.mkdir(parents=True)
            for name in objects:
                (path / name).write_text("{}")
            context = dict(
                directory=directory, original=request, held_rows=[dict(machine_id=mid)]
            )

            def modules(path):
                return (
                    incomplete
                    if path.endswith("cloudbench-incomplete-reservations.py")
                    else source
                )

            with mock.patch.object(M["runpy"], "run_path", side_effect=modules):
                result = M["omitted"](context, row, current, {}, {})
                self.assertEqual(checked, ["closure", "positive-reservation"])
                self.assertEqual(
                    result["closed_transition_proof"]["capacity_credit"], 0
                )
                with self.assertRaisesRegex(ValueError, "task claim"):
                    M["omitted"](context, row, current, {}, {mid: {}})
                bad = copy.deepcopy(row)
                bad["expired_reservation_proof"]["positive_held_ack"] = True
                with self.assertRaisesRegex(ValueError, "ancestry proof differs"):
                    M["omitted"](context, bad, current, {}, {})

    def test_only_zero_response_of_exact_get_is_unknown_observation(self):
        mid, root = "a" * 14, "context/fleet/runs/run/task"
        prefix = "archived-reuse-wire/" + "b" * 32 + "/"
        path = root + "/" + prefix + "0001-wire.json"
        group = dict(
            root=root,
            files={
                prefix + "request.json": dict(
                    app=M["H"]["APP"], method="GET", path="/machines/" + mid
                )
            },
            hashes={path: M["H"]["sha"](b"")},
            malformed_json=[dict(path=path, bytes=0, sha256=M["H"]["sha"](b""))],
        )
        self.assertEqual(M["read_failures"](group, mid), group["malformed_json"])
        for mutation in ("request", "method", "bytes", "result"):
            bad = copy.deepcopy(group)
            if mutation == "request":
                bad["malformed_json"][0]["path"] = root + "/" + prefix + "request.json"
            elif mutation == "method":
                bad["files"][prefix + "request.json"]["method"] = "POST"
            elif mutation == "bytes":
                bad["malformed_json"][0]["bytes"] = 1
            else:
                bad["files"][prefix + "result.json"] = {}
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                M["read_failures"](bad, mid)


if __name__ == "__main__":
    unittest.main()
