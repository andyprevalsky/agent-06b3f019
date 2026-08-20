"""Regression: user-data/plaid fixture freeze must read prod from .env files.

Isolated local benchmarks set process DATABASE_URL to the per-run Victoria DB.
If fixture env builders read that process value as the freeze source, source
equals target, BENCHMARK_*_SOURCE_DATABASE_URL is omitted, and a missing
frozen fixture file fails with "no BENCHMARK_USER_DATA_SOURCE_DATABASE_URL".
"""

from __future__ import annotations

import os
import unittest
from unittest import mock

from benchmarks import run_benchmark as rb


class ProdSourceDatabaseUrlForFixtureTest(unittest.TestCase):
    def test_process_local_database_url_does_not_mask_backend_env_source(self) -> None:
        local_url = "postgresql://postgres:postgres@localhost:5432/victoria"
        prod_direct = "postgresql://postgres:secret@db.example.supabase.co:5432/postgres"
        with mock.patch.dict(os.environ, {"DATABASE_URL": local_url}, clear=False):
                with mock.patch.object(
                rb,
                "load_env_var",
                side_effect=lambda name, *files, include_process_env=True: {
                    ("DIRECT_URL", False): prod_direct,
                    ("DIRECT_DATABASE_URL", False): "",
                    ("DATABASE_URL", False): "postgresql://pooler.example/postgres",
                    ("DATABASE_URL", True): local_url,
                }.get((name, include_process_env), ""),
            ):
                    source = rb._prod_source_database_url_for_fixture(local_url)
        self.assertIsNotNone(source)
        assert source is not None
        self.assertIn("db.example.supabase.co", source)
        self.assertNotIn("localhost", source)

    def test_user_data_fixture_env_sets_source_when_process_points_at_local(self) -> None:
        local_url = "postgresql://postgres:postgres@localhost:5432/victoria"
        prod_url = "postgresql://postgres:secret@aws-1-us-east-2.pooler.supabase.com:6543/postgres"
        with mock.patch.object(rb, "_local_victoria_database_url", return_value=local_url):
            with mock.patch.object(rb, "_prod_source_database_url_for_fixture", return_value=prod_url):
                with mock.patch.dict(os.environ, {"DATABASE_URL": local_url}, clear=False):
                    env = rb._user_data_fixture_env()
        self.assertEqual(env["DATABASE_URL"], local_url)
        self.assertEqual(env["BENCHMARK_USER_DATA_SOURCE_DATABASE_URL"], prod_url)


if __name__ == "__main__":
    unittest.main()
