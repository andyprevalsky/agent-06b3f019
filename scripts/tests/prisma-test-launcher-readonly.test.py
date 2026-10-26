"""Run the shipped test launchers against disposable DB/process boundaries.

Installed dependencies are shared with other local stacks. Preparing a test DB
must not rewrite their Prisma client, and a stale client must fail before DDL.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


class PrismaLauncherReadOnlyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        # npm workspaces may hoist either package. Resolve exactly as the
        # backend does instead of assuming backend-local node_modules.
        result = subprocess.run(
            [
                "node",
                "-e",
                """
const {createRequire} = require('node:module');
const {join, dirname} = require('node:path');
const backend = createRequire(join(process.cwd(), 'back-end/package.json'));
const client = backend.resolve('@prisma/client/package.json');
const generated = createRequire(client).resolve('.prisma/client/default');
console.log(JSON.stringify({client, prisma: dirname(backend.resolve('prisma/package.json')),
  schema: join(dirname(generated), 'schema.prisma')}));
""",
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=10,
            check=True,
        )
        cls.installed = {
            key: Path(value) for key, value in json.loads(result.stdout).items()
        }

    def run_launcher(self, launcher: str, *, state: str = "fresh") -> None:
        with tempfile.TemporaryDirectory(prefix="rose-prisma-launcher-") as directory:
            fixture = Path(directory)
            scripts = fixture / "back-end/scripts"
            scripts.mkdir(parents=True)
            for name in (
                launcher,
                "local-db-container.sh",
                "coverage-failure-evidence.sh",
                "coverage-process-lock.py",
                "test-db-run-lock.sh",
                "coverage_process_registry.py",
                "blackbox-auto-rca-env.sh",
                "assert-prisma-client-current.mjs",
                "normalize-local-user-phones.sh",
                "backfill-local-message-record-owner.sh",
                "apply-local-message-record-trgm-index.sh",
                "blackbox-phone-env.sh",
            ):
                source = ROOT / "back-end/scripts" / name
                if source.exists():
                    shutil.copy2(source, scripts / name)
            lib = fixture / "scripts/lib"
            lib.mkdir(parents=True)
            shutil.copy2(ROOT / "scripts/lib/workspace-env.sh", lib)
            shutil.copy2(ROOT / "scripts/lib/run-process-cleanup.sh", lib)
            dependencies = fixture / "back-end/node_modules"
            client = dependencies / "@prisma/client"
            client.mkdir(parents=True)
            package = json.loads(self.installed["client"].read_text())
            if state == "version-mismatch":
                package["version"] = "0.0.0"
            (client / "package.json").write_text(json.dumps(package))
            (dependencies / "prisma").symlink_to(self.installed["prisma"])
            generated = dependencies / ".prisma/client"
            if state != "missing":
                generated.mkdir(parents=True)
                (generated / "default.js").touch()
                shutil.copy2(self.installed["schema"], generated)
            schema = fixture / "back-end/prisma/schema.prisma"
            schema.parent.mkdir()
            schema.write_bytes((ROOT / "back-end/prisma/schema.prisma").read_bytes())
            if state == "stale":
                with schema.open("a") as handle:
                    handle.write(
                        "\nmodel ReadonlyRegressionFixture {\n id String @id\n}\n"
                    )
            # Stop at the first boundary AFTER db push. No backend, credentials,
            # DB, network provider, or coverage report is needed for this test.
            (scripts / "apply-local-runtime-sql-hooks.sh").write_text("exit 77\n")
            binary = fixture / "bin"
            binary.mkdir()
            events = fixture / "events"
            events.touch()
            commands = {
                "docker": "exit 1\n",
                "pg_isready": "exit 0\n",
                # The workspace test database is created on demand (never the
                # shared `victoria`); record those calls distinctly.
                "psql": (
                    'case "$*" in\n'
                    '  *"CREATE DATABASE"*) printf "psql create-db\\n" >> "$PRISMA_TEST_EVENTS";;\n'
                    '  *"FROM pg_database"*) printf "psql db-exists\\n" >> "$PRISMA_TEST_EVENTS";;\n'
                    '  *) printf "psql\\n" >> "$PRISMA_TEST_EVENTS";;\n'
                    "esac\n"
                    "cat >/dev/null\nexit 0\n"
                ),
                "npx": (
                    'case "$*" in\n'
                    # Pre-push User.phone normalization: a data rewrite on the
                    # local DB, never a Prisma client regeneration.
                    '  "--no-install prisma db execute --url "*" --stdin")\n'
                    '    cat >/dev/null; printf "prisma db execute\\n" >> "$PRISMA_TEST_EVENTS"; exit 0;;\n'
                    "esac\n"
                    'printf "%s\\n" "$*" >> "$PRISMA_TEST_EVENTS"\n'
                    'case "$*" in\n'
                    '  "prisma generate"|"prisma db push --skip-generate --accept-data-loss") exit 0;;\n'
                    '  *) echo "Unexpected test command" >&2; exit 78;;\n'
                    "esac\n"
                ),
            }
            for name, body in commands.items():
                path = binary / name
                path.write_text("#!/usr/bin/env bash\nset -eu\n" + body)
                path.chmod(0o755)
            env = {
                key: value
                for key, value in os.environ.items()
                if key in {"HOME", "USER", "TMPDIR", "PATH"}
            }
            env.update(
                {
                    "PATH": f"{binary}:{env['PATH']}",
                    "CONDUCTOR_ROOT_PATH": str(fixture),
                    "CONDUCTOR_WORKSPACE_NAME": fixture.name,
                    "CONDUCTOR_PORT": "58001",
                    "BROWSER_PROVIDER": "kernel",
                    "PRISMA_TEST_EVENTS": str(events),
                    "BLACKBOX_TEST_RUN_ID": "readonly-client-fixture",
                    "DATABASE_URL": "postgresql://postgres:postgres@localhost:5432/victoria",
                    "DIRECT_URL": "postgresql://postgres:postgres@localhost:5432/victoria",
                }
            )
            result = subprocess.run(
                ["bash", str(scripts / launcher)],
                cwd=fixture,
                env=env,
                text=True,
                capture_output=True,
                timeout=40,
                check=False,
            )
            calls = events.read_text().splitlines()
            if state != "fresh":
                self.assertNotEqual(result.returncode, 0)
                self.assertNotEqual(result.returncode, 77)
                self.assertIn("Prisma client is stale", result.stderr)
                self.assertEqual(
                    calls, [], "stale dependencies must fail before DB sync"
                )
            else:
                self.assertEqual(result.returncode, 77, result.stdout + result.stderr)
                self.assertEqual(
                    calls,
                    [
                        "psql db-exists",
                        "psql create-db",
                        "psql",
                        "prisma db execute",
                        "prisma db execute",
                        "prisma db push --skip-generate --accept-data-loss",
                    ],
                    "test preparation rewrote a client that concurrent stacks can be loading",
                )

    def test_blackbox_fresh_client_remains_read_only(self) -> None:
        self.run_launcher("run-blackbox-tests.sh")

    def test_coverage_fresh_client_remains_read_only(self) -> None:
        self.run_launcher("run-coverage.sh")

    def test_blackbox_rejects_stale_client_before_db_sync(self) -> None:
        self.run_launcher("run-blackbox-tests.sh", state="stale")

    def test_coverage_rejects_stale_client_before_db_sync(self) -> None:
        self.run_launcher("run-coverage.sh", state="stale")

    def test_blackbox_rejects_missing_client_before_db_sync(self) -> None:
        self.run_launcher("run-blackbox-tests.sh", state="missing")

    def test_coverage_rejects_mismatched_versions_before_db_sync(self) -> None:
        self.run_launcher("run-coverage.sh", state="version-mismatch")


if __name__ == "__main__":
    unittest.main()
