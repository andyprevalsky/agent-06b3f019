"""Minimal test-result aggregator for structural tests.

Structural tests are AST-only and don't need the httpx capture harness
that blackbox tests pull in — hence this local, dependency-free runner.
"""

from typing import Any, Awaitable, Callable


class Result:
    def __init__(self) -> None:
        self.passed = 0
        self.failed = 0
        self.errors: list[str] = []

    def record(self, name: str, fn: Callable[[], Any]) -> None:
        try:
            fn()
            self.passed += 1
            print(f"  ✅ {name}")
        except Exception as e:
            self.failed += 1
            self.errors.append(f"{name}: {e}")
            print(f"  ❌ {name}: {e}")

    async def record_async(self, name: str, fn: Callable[[], Awaitable[Any]]) -> None:
        try:
            await fn()
            self.passed += 1
            print(f"  ✅ {name}")
        except Exception as e:
            self.failed += 1
            self.errors.append(f"{name}: {e}")
            print(f"  ❌ {name}: {e}")

    @property
    def all_passed(self) -> bool:
        return self.failed == 0
