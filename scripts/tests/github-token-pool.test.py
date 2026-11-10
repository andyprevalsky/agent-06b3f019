#!/usr/bin/env python3
"""Owning-boundary regressions for scripts/github_token_pool.py.

Every GitHub consumer shared one user token whose 5,000/h quota other threads
drained to 0 twice within an hour (2026-11-06). The pool ranks GITHUB_TOKEN,
GITHUB_TOKEN_2..9, the GitHub App and GITHUB_DISPATCH_TOKEN by remaining quota from the free
/rate_limit endpoint. A local fake GitHub serves per-token quotas; no live call.
"""

from __future__ import annotations

import base64
import http.server
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/github_token_pool.py"
spec = importlib.util.spec_from_file_location("github_token_pool", SCRIPT)
pool = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = pool
spec.loader.exec_module(pool)

RESET = 1_900_000_000
# token -> behaviour: (status, core_remaining, graphql_remaining, reset, delay_seconds)
BEHAVIOUR: dict[str, tuple[int, int, int, int, float]] = {}
SLOW_SECONDS = 2.0


# GitHub App installation-token mints: installation id -> response status.
APP_MINTS: list[dict[str, str]] = []
APP_MINT_STATUS = {"777": 201}
APP_PUBLIC_KEY: dict[str, str] = {}
APP_EXPIRES_IN = {"seconds": 3600}


def _unb64url(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


class FakeGitHub(http.server.BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        installation = self.path.removeprefix("/app/installations/").removesuffix("/access_tokens")
        jwt = self.headers.get("Authorization", "").removeprefix("Bearer ")
        header, payload, signature = (jwt.split(".") + ["", "", ""])[:3]
        with tempfile.TemporaryDirectory() as scratch:
            (Path(scratch) / "pub.pem").write_text(APP_PUBLIC_KEY.get("pem", ""))
            (Path(scratch) / "sig").write_bytes(_unb64url(signature))
            verified = subprocess.run(
                ["openssl", "dgst", "-sha256", "-verify", f"{scratch}/pub.pem", "-signature", f"{scratch}/sig"],
                input=f"{header}.{payload}".encode(), capture_output=True, check=False,
            ).returncode == 0
        claims = json.loads(_unb64url(payload) or b"{}") if payload else {}
        APP_MINTS.append({"installation": installation, "iss": str(claims.get("iss")), "verified": str(verified)})
        status = APP_MINT_STATUS.get(installation, 404) if verified else 401
        expires = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + APP_EXPIRES_IN["seconds"]))
        body = json.dumps({"token": f"app-token-{len(APP_MINTS)}", "expires_at": expires}).encode()
        BEHAVIOUR[f"app-token-{len(APP_MINTS)}"] = (200, 12000, 12000, RESET, 0.0)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        token = self.headers.get("Authorization", "").removeprefix("Bearer ")
        status, core, graphql, reset, delay = BEHAVIOUR.get(token, (401, 0, 0, RESET, 0.0))
        if delay:
            time.sleep(delay)
        if self.path != "/rate_limit":
            status = 404
        if status == 200:
            body = json.dumps({"resources": {
                "core": {"limit": 5000, "remaining": core, "reset": reset, "used": 5000 - core},
                "graphql": {"limit": 5000, "remaining": graphql, "reset": reset, "used": 5000 - graphql},
            }}).encode()
        else:
            body = json.dumps({"message": "Bad credentials"}).encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the client timed out first

    def log_message(self, *_args: object) -> None:
        pass


class GithubTokenPoolTests(unittest.TestCase):
    server: http.server.ThreadingHTTPServer
    base: str

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeGitHub)
        cls.server.daemon_threads = True
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self) -> None:
        BEHAVIOUR.clear()
        self.tmp = Path(tempfile.mkdtemp(prefix="github-token-pool-"))
        (self.tmp / "agents").mkdir()
        (self.tmp / "back-end").mkdir()

    def pick(self, environ: dict[str, str], resource: str = "both", timeout: float = 5.0) -> str | None:
        return pool.pick_token(resource, self.tmp, environ, self.base, timeout)

    def cli(self, *args: str, environ: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        env = {"PATH": os.environ.get("PATH", ""), "GITHUB_API_BASE_URL": self.base,
               "GITHUB_TOKEN_POOL_TIMEOUT_SECONDS": "1",
               # Never let a child fall back to the real ~/.cache token cache.
               "GITHUB_APP_TOKEN_CACHE": os.environ.get("GITHUB_APP_TOKEN_CACHE", str(self.tmp / "cache.json")),
               **(environ or {})}
        return subprocess.run([sys.executable, str(SCRIPT), *args, "--repo-root", str(self.tmp)],
                              env=env, capture_output=True, text=True, timeout=30)

    def test_most_remaining_quota_wins(self) -> None:
        BEHAVIOUR.update({"tok-a": (200, 100, 100, RESET, 0), "tok-b": (200, 4000, 4000, RESET, 0),
                          "tok-c": (200, 50, 50, RESET, 0)})
        env = {"GITHUB_TOKEN": "tok-a", "GITHUB_TOKEN_2": "tok-b", "GITHUB_TOKEN_3": "tok-c"}
        self.assertEqual(self.pick(env), "tok-b")

    def test_pick_member_names_the_chosen_read_member_for_core_reads(self) -> None:
        # deploy_test_github reads with this member and records only its name; core decides REST reads.
        BEHAVIOUR.update({"tok-a": (200, 20, 4000, RESET, 0), "tok-b": (200, 3000, 10, RESET, 0)})
        env = {"GITHUB_TOKEN": "tok-a", "GITHUB_TOKEN_2": "tok-b"}
        self.assertEqual(pool.pick_member("core", self.tmp, env, self.base, 5.0), pool.Member("GITHUB_TOKEN_2", "tok-b"))
        self.assertEqual(pool.pick_member("graphql", self.tmp, env, self.base, 5.0).name, "GITHUB_TOKEN")
        BEHAVIOUR.update({"tok-a": (401, 0, 0, RESET, 0), "tok-b": (401, 0, 0, RESET, 0)})
        self.assertIsNone(pool.pick_member("core", self.tmp, env, self.base, 5.0))

    def test_rejected_member_is_skipped(self) -> None:
        BEHAVIOUR.update({"tok-a": (200, 10, 10, RESET, 0), "tok-b": (401, 0, 0, RESET, 0)})
        env = {"GITHUB_TOKEN": "tok-a", "GITHUB_TOKEN_2": "tok-b"}
        self.assertEqual(self.pick(env), "tok-a")
        BEHAVIOUR["tok-a"] = (401, 0, 0, RESET, 0)
        self.assertIsNone(self.pick(env))

    def test_timed_out_member_ranks_between_positive_and_exhausted(self) -> None:
        BEHAVIOUR.update({"tok-dry": (200, 0, 0, RESET, 0), "tok-slow": (200, 5000, 5000, RESET, SLOW_SECONDS),
                          "tok-ok": (200, 3, 3, RESET, 0)})
        started = time.monotonic()
        self.assertEqual(self.pick({"GITHUB_TOKEN": "tok-dry", "GITHUB_TOKEN_2": "tok-slow"}, timeout=0.5),
                         "tok-slow")
        self.assertLess(time.monotonic() - started, SLOW_SECONDS, "probes must not wait out a slow member")
        self.assertEqual(self.pick({"GITHUB_TOKEN": "tok-slow", "GITHUB_TOKEN_2": "tok-ok"}, timeout=0.5),
                         "tok-ok")

    def test_resource_selects_core_graphql_or_their_minimum(self) -> None:
        BEHAVIOUR.update({"tok-rest": (200, 5000, 10, RESET, 0), "tok-even": (200, 1000, 1000, RESET, 0)})
        env = {"GITHUB_TOKEN": "tok-rest", "GITHUB_TOKEN_2": "tok-even"}
        self.assertEqual(self.pick(env, "core"), "tok-rest")
        self.assertEqual(self.pick(env, "graphql"), "tok-even")
        self.assertEqual(self.pick(env, "both"), "tok-even")

    def test_all_exhausted_prefers_soonest_reset(self) -> None:
        BEHAVIOUR.update({"tok-late": (200, 0, 0, RESET + 900, 0), "tok-soon": (200, 0, 0, RESET + 60, 0)})
        self.assertEqual(self.pick({"GITHUB_TOKEN": "tok-late", "GITHUB_TOKEN_2": "tok-soon"}), "tok-soon")

    def test_process_env_wins_over_env_files_and_duplicates_collapse(self) -> None:
        (self.tmp / "agents" / ".env").write_text(
            "# comment\nGITHUB_TOKEN=file-primary\nGITHUB_TOKEN_2=\"agents-two\"\nexport GITHUB_TOKEN_4='agents-four'\n")
        (self.tmp / "back-end" / ".env").write_text("GITHUB_TOKEN_2=backend-two\nGITHUB_TOKEN_3=backend-three\n")
        found = pool.members(self.tmp, {"GITHUB_TOKEN": "env-primary", "GITHUB_DISPATCH_TOKEN": "env-primary",
                                        "GITHUB_TOKEN_5": "  "})
        self.assertEqual([(m.name, m.token) for m in found], [
            ("GITHUB_TOKEN", "env-primary"), ("GITHUB_TOKEN_2", "agents-two"),
            ("GITHUB_TOKEN_3", "backend-three"), ("GITHUB_TOKEN_4", "agents-four")])
        BEHAVIOUR.update({"env-primary": (200, 1, 1, RESET, 0), "backend-three": (200, 4999, 4999, RESET, 0)})
        result = self.cli("pick")
        # CLI reads the same files; process env here carries no members.
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "backend-three")

    def test_missing_members_fail_pick_and_report_status(self) -> None:
        result = self.cli("pick")
        self.assertEqual(result.returncode, 1)
        self.assertIn("no member configured", result.stderr)
        self.assertEqual(result.stdout, "")
        status = self.cli("status")
        self.assertEqual(status.returncode, 0, status.stderr)
        self.assertIn("no GitHub token pool members", status.stdout)

    def test_status_never_prints_a_token(self) -> None:
        secrets = {"GITHUB_TOKEN": "ghp_secretprimary0123456789", "GITHUB_TOKEN_2": "ghp_secretsecond0123456789",
                   "GITHUB_TOKEN_3": "ghp_secretrejected012345678", "GITHUB_DISPATCH_TOKEN": "gho_secretdispatch01234567"}
        BEHAVIOUR.update({secrets["GITHUB_TOKEN"]: (200, 0, 7, RESET, 0),
                          secrets["GITHUB_TOKEN_2"]: (200, 4200, 4100, RESET, 0),
                          secrets["GITHUB_TOKEN_3"]: (401, 0, 0, RESET, 0)})
        result = self.cli("status", environ=secrets)
        self.assertEqual(result.returncode, 0, result.stderr)
        for token in secrets.values():
            self.assertNotIn(token, result.stdout + result.stderr)
        lines = result.stdout.splitlines()
        self.assertEqual([line.split()[0] for line in lines],
                         ["GITHUB_TOKEN", "GITHUB_TOKEN_2", "GITHUB_TOKEN_3", "GITHUB_DISPATCH_TOKEN"])
        self.assertIn("core=4200/5000", lines[1])
        self.assertIn("graphql=4100/5000", lines[1])
        self.assertIn("http=401", lines[2])
        picked = self.cli("pick", environ=secrets)
        self.assertEqual(picked.stdout.strip(), secrets["GITHUB_TOKEN_2"])

    def app_env(self) -> dict[str, str]:
        key_path = self.tmp / "app.pem"
        subprocess.run(["openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048",
                        "-out", str(key_path)], check=True, capture_output=True)
        APP_PUBLIC_KEY["pem"] = subprocess.run(["openssl", "pkey", "-in", str(key_path), "-pubout"], check=True,
                                               capture_output=True, text=True).stdout
        os.environ["GITHUB_APP_TOKEN_CACHE"] = str(self.tmp / "cache" / "app-token.json")
        return {"GITHUB_TOKEN": "tok-primary", "GITHUB_DISPATCH_TOKEN": "tok-dispatch",
                "GITHUB_APP_ID": "424242", "GITHUB_APP_INSTALLATION_ID": "777",
                "GITHUB_APP_PRIVATE_KEY_B64": base64.b64encode(key_path.read_bytes()).decode()}

    def test_github_app_member_is_minted_cached_and_ranked(self) -> None:
        APP_MINTS.clear()
        APP_MINT_STATUS["777"] = 201
        APP_EXPIRES_IN["seconds"] = 3600
        env = self.app_env()
        BEHAVIOUR.update({"tok-primary": (200, 400, 400, RESET, 0), "tok-dispatch": (200, 400, 400, RESET, 0)})
        found = pool.members(self.tmp, env, self.base)
        self.assertEqual([member.name for member in found], ["GITHUB_TOKEN", "GITHUB_APP", "GITHUB_DISPATCH_TOKEN"])
        self.assertEqual(APP_MINTS, [{"installation": "777", "iss": "424242", "verified": "True"}],
                         "one mint, with a JWT signed by the configured private key")
        cache = Path(os.environ["GITHUB_APP_TOKEN_CACHE"])
        self.assertEqual(cache.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.pick(env), "app-token-1", "the installation's own quota outranks a drained user")
        self.assertEqual(len(APP_MINTS), 1, "an unexpired cached token is reused")
        result = self.cli("status", environ=env)
        self.assertNotIn("app-token-1", result.stdout + result.stderr)
        self.assertIn("GITHUB_APP http=200 core=12000/5000", result.stdout)

    def test_github_app_token_near_expiry_is_reminted(self) -> None:
        APP_MINTS.clear()
        APP_MINT_STATUS["777"] = 201
        APP_EXPIRES_IN["seconds"] = 120
        env = self.app_env()
        pool.members(self.tmp, env, self.base)
        pool.members(self.tmp, env, self.base)
        self.assertEqual(len(APP_MINTS), 2, "a token inside the five-minute margin is minted again")

    def test_github_app_mint_failure_keeps_static_members(self) -> None:
        APP_MINTS.clear()
        APP_MINT_STATUS["777"] = 500
        env = self.app_env()
        BEHAVIOUR.update({"tok-primary": (200, 400, 400, RESET, 0)})
        found = pool.members(self.tmp, env, self.base)
        self.assertEqual([member.name for member in found], ["GITHUB_TOKEN", "GITHUB_DISPATCH_TOKEN"])
        self.assertEqual(self.pick(env), "tok-primary")
        APP_MINT_STATUS["777"] = 201

    def test_github_app_malformed_private_key_skips_the_member_instead_of_crashing(self) -> None:
        BEHAVIOUR.update({"tok-primary": (200, 400, 400, RESET, 0)})
        for bad in ("!!!not base64!!!", base64.b64encode(b"\xff\xfe\xfa").decode()):
            env = {"GITHUB_TOKEN": "tok-primary", "GITHUB_APP_ID": "424242", "GITHUB_APP_INSTALLATION_ID": "777",
                   "GITHUB_APP_PRIVATE_KEY_B64": bad}
            status = self.cli("status", environ=env)
            self.assertEqual(status.returncode, 0, status.stderr)
            self.assertIn("GITHUB_TOKEN http=200", status.stdout)
            self.assertNotIn("GITHUB_APP", status.stdout)
            self.assertIn("skipping the GitHub App member", status.stderr)
            self.assertNotIn("Traceback", status.stderr)
            self.assertEqual(self.cli("pick", environ=env).stdout.strip(), "tok-primary")

    def test_github_app_cache_is_private_and_untrusted_when_not(self) -> None:
        APP_MINTS.clear()
        APP_MINT_STATUS["777"] = 201
        APP_EXPIRES_IN["seconds"] = 3600
        env = self.app_env()
        BEHAVIOUR.update({"tok-primary": (200, 400, 400, RESET, 0), "tok-dispatch": (200, 400, 400, RESET, 0)})
        cache = Path(os.environ["GITHUB_APP_TOKEN_CACHE"])
        cache.parent.mkdir(parents=True)
        os.chmod(cache.parent, 0o777)  # a pre-existing, wide-open directory that we own is tightened
        pool.members(self.tmp, env, self.base)
        self.assertEqual(cache.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(cache.stat().st_mode & 0o777, 0o600)
        self.assertEqual([entry.name for entry in cache.parent.iterdir()], [cache.name],
                         "the exclusive staging file is renamed away, never left behind")
        minted = len(APP_MINTS)
        pool.members(self.tmp, env, self.base)
        self.assertEqual(len(APP_MINTS), minted, "a private cache is reused")
        os.chmod(cache, 0o644)  # a readable cache file is not trusted: a fresh mint replaces it
        pool.members(self.tmp, env, self.base)
        self.assertEqual(len(APP_MINTS), minted + 1)
        self.assertEqual(cache.stat().st_mode & 0o777, 0o600)

    def tearDown(self) -> None:
        os.environ.pop("GITHUB_APP_TOKEN_CACHE", None)


if __name__ == "__main__":
    unittest.main()
