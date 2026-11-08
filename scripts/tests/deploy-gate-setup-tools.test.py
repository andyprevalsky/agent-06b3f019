#!/usr/bin/env python3
"""Blacksmith gate VMs install flyctl, ngrok and cloudflared from the sticky dependency disk.

Hunt round 7 (2026-11-08): four GitHub Releases 504s in 7 s failed "Prepare runner" on 11 of 12
gate VMs at once, because every VM downloaded cloudflared (and flyctl, ngrok) on every run with no
outer retry. scripts/ci/deploy-gate-setup.sh now keeps them in $DEPS/tools and downloads only
what is missing, with retries. This runs that exact block of the real script against fake
curl/sudo: a short outage is ridden out, and a second VM on the same sticky disk needs no network.
"""
from __future__ import annotations

import io
import os
import stat
import subprocess
import tarfile
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SETUP = ROOT / 'scripts/ci/deploy-gate-setup.sh'


def tools_block() -> str:
    text = SETUP.read_text()
    start, end = text.index('TOOLS="$DEPS/tools"'), text.index('step "dependency disk"')
    return text[start:end]


def executable(path: Path, body: str) -> None:
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


class GateSetupTools(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.deps, self.bin, self.calls = base / 'deps', base / 'bin', base / 'curl.calls'
        self.bin.mkdir()
        self.failures = base / 'failures-left'
        tgz = io.BytesIO()
        with tarfile.open(fileobj=tgz, mode='w:gz') as archive:
            data = b'#!/bin/sh\necho "ngrok version 3.0.0"\n'
            info = tarfile.TarInfo('ngrok')
            info.size, info.mode = len(data), 0o755
            archive.addfile(info, io.BytesIO(data))
        (base / 'ngrok.tgz').write_bytes(tgz.getvalue())
        # Fake curl: records each URL; each attempt (1 + --retry N, like curl --retry-all-errors)
        # consumes one queued failure and fails like a 504 (exit 22) while any remain.
        executable(self.bin / 'curl', textwrap.dedent(f'''\
            #!/usr/bin/env bash
            out=""; url=""; retries=0
            while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; --retry) retries="$2"; shift 2;;
              --retry-delay|--retry-max-time|--connect-timeout|--max-time) shift 2;; -*) shift;; *) url="$1"; shift;; esac; done
            echo "$url" >> {self.calls}
            for attempt in $(seq 0 "$retries"); do
              left=$(cat {self.failures} 2>/dev/null || echo 0)
              [ "$left" -gt 0 ] || break
              echo $((left - 1)) > {self.failures}
              [ "$attempt" -lt "$retries" ] || exit 22
            done
            case "$url" in
              *fly.io/install.sh) printf '%s\\n' 'mkdir -p "$FLYCTL_INSTALL/bin"' \\
                  'printf "#!/bin/sh\\necho flyctl v0\\n" > "$FLYCTL_INSTALL/bin/flyctl"' \\
                  'chmod +x "$FLYCTL_INSTALL/bin/flyctl"' > "$out" ;;
              *ngrok*) cp {base / 'ngrok.tgz'} "$out" ;;
              *cloudflared*) printf '#!/bin/sh\\necho cloudflared\\n' > "$out" ;;
              *) exit 22 ;;
            esac
            '''))
        executable(self.bin / 'sudo', '#!/bin/sh\n"$@"\n')
        executable(self.bin / 'shlock', '#!/bin/sh\nexit 0\n')  # the runner image's lock helper, out of scope here
        executable(self.bin / 'sleep', '#!/bin/sh\nexit 0\n')  # the block's backoff sleeps cost no time here

    def tearDown(self):
        self.tmp.cleanup()

    def run_block(self, failures: int) -> subprocess.CompletedProcess:
        self.failures.write_text(str(failures))
        script = 'set -euo pipefail\nstep() { :; }\n' + tools_block()
        env = {'PATH': f'{self.bin}:/usr/bin:/bin', 'HOME': self.tmp.name, 'DEPS': str(self.deps),
               'GITHUB_PATH': str(Path(self.tmp.name) / 'github-path'), 'TMPDIR': self.tmp.name}
        return subprocess.run(['bash', '-c', script], cwd=ROOT, env=env, capture_output=True, text=True,
                              timeout=120)

    def test_short_outage_is_ridden_out_and_the_next_vm_needs_no_network(self):
        first = self.run_block(failures=4)  # the round-7 outage: four 504s in a row
        self.assertEqual(first.returncode, 0, first.stderr)
        for tool in ('flyctl', 'ngrok', 'cloudflared'):
            self.assertTrue(os.access(self.deps / 'tools' / tool, os.X_OK), tool)
        self.assertIn(str(self.deps / 'tools'), (Path(self.tmp.name) / 'github-path').read_text())
        self.calls.unlink()
        second = self.run_block(failures=10_000)  # the network is down for the whole second VM
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertFalse(self.calls.exists(), 'a cached tool was downloaded again')

    def test_a_persistent_outage_still_fails_the_step(self):
        result = self.run_block(failures=10_000)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('flyctl unavailable', result.stderr)


if __name__ == '__main__':
    unittest.main()
