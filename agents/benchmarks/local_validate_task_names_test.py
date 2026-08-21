"""validate_task_names preserves intentional repeats for pass@k."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from benchmarks.local import validate_task_names


class ValidateTaskNamesTests(unittest.TestCase):
    def test_preserves_repeated_task_names_for_pass_at_k(self) -> None:
        with patch(
            "benchmarks.local.known_task_names",
            return_value=["user-data-prod-grep", "browser-agent"],
        ):
            got = validate_task_names(
                [
                    "user-data-prod-grep",
                    "user-data-prod-grep",
                    "user-data-prod-grep",
                    "user-data-prod-grep",
                    "user-data-prod-grep",
                ]
            )
        self.assertEqual(got, ["user-data-prod-grep"] * 5)

    def test_rejects_unknown_names(self) -> None:
        with patch("benchmarks.local.known_task_names", return_value=["user-data-prod-grep"]):
            with self.assertRaises(ValueError):
                validate_task_names(["not-a-real-task"])


if __name__ == "__main__":
    unittest.main()
