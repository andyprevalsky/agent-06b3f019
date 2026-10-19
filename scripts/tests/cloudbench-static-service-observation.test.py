"""Cold observation preserves canonical identity while allowing inert listeners."""
import copy
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
GUARD = runpy.run_path(os.environ.get(
    "ROSE_OBSERVATION_GUARD_UNDER_TEST",
    str(ROOT / "scripts/cloudbench-static-service-observation.py")))


class StaticServiceObservationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.native = {
            "id": "8577296f164678", "name": "original-clone", "state": "stopped",
            "instance_id": "original-instance", "config": {
                "init": {"cmd": ["sleep", "infinity"]}, "restart": {"policy": "no"},
                "env": {}, "image": "registry.example/fixture@sha256:" + "a" * 64,
                "mounts": [{"volume": "vol_original", "path": "/data"}],
                "guest": {"cpu_kind": "shared", "cpus": 1, "memory_mb": 1024},
                # Exact service shape recorded on all 34 stopped Machines.
                "services": [{"force_instance_key": None, "internal_port": 8011,
                    "ports": [{"handlers": ["http", "tls"], "port": 443}],
                    "protocol": "tcp"}]}}
        self.original = {"clone_name": "original-clone", "volume_id": "vol_original"}
        self.volume = {"id": "vol_original", "attached_machine_id": self.native["id"],
                       "state": "created"}

    def validate(self, native=None, after=None, volume=None):
        native = self.native if native is None else native
        values = {"before": native, "after": native if after is None else after,
                  "volume": self.volume if volume is None else volume}
        paths = {}
        for name, value in values.items():
            paths[name] = self.root / (name + ".json")
            paths[name].write_text(json.dumps(value))
        before = {name: path.read_bytes() for name, path in paths.items()}
        try:
            return GUARD["validate_observation_native"](
                self.native["id"], self.original, **paths)
        finally:
            self.assertEqual(before, {name: path.read_bytes() for name, path in paths.items()})

    def test_recorded_static_listener_passes_canonical_cold_observation(self):
        self.validate()

    def test_absent_and_explicitly_disabled_services_pass(self):
        native = copy.deepcopy(self.native)
        native["config"].pop("services")
        self.validate(native)
        native = copy.deepcopy(self.native)
        native["config"]["disable_machine_autostart"] = True
        native["config"]["services"][0].update(
            autostart=False, autostop="off", min_machines_running=0)
        self.validate(native)

    def test_activation_ambiguity_and_unknown_controls_refuse(self):
        cases = [
            ("service", "autostart", True), ("service", "autostart", None),
            ("service", "autostart", 0), ("service", "autostop", "stop"),
            ("service", "min_machines_running", 1),
            ("service", "min_machines_running", False),
            ("service", "checks", []), ("service", "force_instance_key", "other"),
            ("service", "internal_port", 8012), ("service", "protocol", "udp"),
            ("service", "ports", [{"port": 443}]),
            ("config", "disable_machine_autostart", False),
            ("config", "disable_machine_autostart", None),
            ("config", "auto_start_machines", False), ("config", "autostart", False),
            ("config", "auto_stop_machines", False), ("config", "services", None),
        ]
        for level, key, value in cases:
            with self.subTest(level=level, key=key, value=value):
                native = copy.deepcopy(self.native)
                target = native["config"] if level == "config" else native["config"]["services"][0]
                target[key] = value
                with self.assertRaisesRegex(ValueError, "untouched"):
                    self.validate(native)

    def test_policy_refusal_survives_python_optimize(self):
        guard = os.environ.get("ROSE_OBSERVATION_GUARD_UNDER_TEST",
                               str(ROOT / "scripts/cloudbench-static-service-observation.py"))
        program = ("import json,runpy,sys\n"
                   "check=runpy.run_path(sys.argv[1])['validate_observation_services']\n"
                   "try:\n check(json.loads(sys.argv[2]))\n"
                   "except ValueError as error:\n print('REFUSED', error); sys.exit(3)\n"
                   "print('ADMITTED')\n")
        refused = [{"autostart": False}, {"disable_machine_autostart": False},
                   {"services": [dict(self.native["config"]["services"][0], autostart=True)]},
                   {"services": [dict(self.native["config"]["services"][0], internal_port=8012)]}]
        env = dict(os.environ, PYTHONOPTIMIZE="1")
        for config in refused + [self.native["config"]]:
            with self.subTest(config=config):
                result = subprocess.run([sys.executable, "-c", program, guard, json.dumps(config)],
                                        capture_output=True, text=True, env=env, timeout=60)
                if config is self.native["config"]:
                    self.assertEqual((result.returncode, result.stdout.strip()), (0, "ADMITTED"), result.stderr)
                else:
                    self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
                    self.assertIn("untouched", result.stdout)

    def test_canonical_identity_and_inert_init_remain_required(self):
        for field, value in (("state", "started"), ("instance_id", "changed")):
            with self.subTest(field=field):
                after = copy.deepcopy(self.native)
                after[field] = value
                with self.assertRaises(ValueError):
                    self.validate(after=after)
        native = copy.deepcopy(self.native)
        native["config"]["init"] = {"cmd": ["bash", "/cloudbench-boot.sh"]}
        with self.assertRaises(ValueError):
            self.validate(native)
        volume = dict(self.volume, attached_machine_id="foreign")
        with self.assertRaises(ValueError):
            self.validate(volume=volume)


if __name__ == "__main__":
    unittest.main()
