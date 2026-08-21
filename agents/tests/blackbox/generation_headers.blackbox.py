"""Every agent-side TOOL writer must be able to attribute its own writes.

Why this exists
---------------
The backend fences TOOL lifecycle writes by comparing the incoming
`X-Agent-Workflow-Generation` header against the agent's live generation. A
writer that omits the header used to be silently attributed to generation 1 (the
agent id IS generation 1's workflow id), so after any deploy replacement its
live writes were rewritten into "Tool interrupted by deployment". Prod: 3,983
such rows across 81 agents in 14 days.

The fix added `workflow_generation_headers()` to the domain writers. A first
attempt inserted the CALL into nine sites but never added the IMPORT, which
`py_compile` cannot catch — an undefined global only explodes at call time. It
shipped past the backend blackbox (which never executes Python) and surfaced as
`NameError: name 'workflow_generation_headers' is not defined`, killing the
browser agent 2s after start.

So this suite does what a syntax check cannot: it IMPORTS each writer module and
resolves the symbol, and it asserts every POST to /messages carries the header.
"""

from __future__ import annotations

import ast
import importlib
from pathlib import Path
from typing import Any, Dict, List

DOMAINS_ROOT = Path(__file__).resolve().parents[2] / "domains"

# Every module that POSTs a TOOL-role message to /api/agents/{id}/messages.
TOOL_WRITER_MODULES = [
    "domains.spawn_browser_agent_v3.repo",
    "domains.spawn_claude_code_agent.repo",
    "domains.call_phone_number.repo",
    "domains.spawn_agent.repo",
]

WRITER_PATHS = [
    DOMAINS_ROOT / "spawn_browser_agent_v3" / "repo.py",
    DOMAINS_ROOT / "spawn_claude_code_agent" / "repo.py",
    DOMAINS_ROOT / "call_phone_number" / "repo.py",
    DOMAINS_ROOT / "spawn_agent" / "repo.py",
]


def _test_symbol_is_resolvable() -> List[str]:
    """Import each writer and resolve the header helper at module scope."""
    failures: List[str] = []
    for module_name in TOOL_WRITER_MODULES:
        try:
            module = importlib.import_module(module_name)
        except Exception as exc:  # noqa: BLE001 - report, do not mask
            failures.append(f"{module_name}: import failed: {type(exc).__name__}: {exc}")
            continue
        if not hasattr(module, "workflow_generation_headers"):
            failures.append(
                f"{module_name}: calls workflow_generation_headers() but never imports it — "
                f"this raises NameError at call time and py_compile cannot see it"
            )
    return failures


def _test_message_posts_send_the_header() -> List[str]:
    """Every POST to /messages in a writer must spread the generation headers."""
    failures: List[str] = []
    for path in WRITER_PATHS:
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if not (isinstance(func, ast.Attribute) and func.attr == "post"):
                continue
            rendered = ast.get_source_segment(source, node) or ""
            if "/messages" not in rendered:
                continue
            if "workflow_generation_headers()" not in rendered:
                failures.append(
                    f"{path.name}:{node.lineno}: POST to /messages does not send "
                    f"workflow_generation_headers() — its writes will be attributed to "
                    f"generation 1 and fenced after any deploy replacement"
                )
    return failures


def _test_message_posts_abort_on_409() -> List[str]:
    """A writer that ignores 409 keeps stepping on a replaced generation."""
    failures: List[str] = []
    for path in WRITER_PATHS:
        source = path.read_text(encoding="utf-8")
        if "/messages" not in source:
            continue
        if "raise_if_generation_sealed" not in source:
            failures.append(
                f"{path.name}: POSTs to /messages but never calls "
                f"raise_if_generation_sealed() — an orphaned activity would keep "
                f"running after its generation is replaced"
            )
    return failures


def _test_abort_survives_blanket_handlers() -> List[str]:
    """`except Exception` must not swallow the only stop signal we get."""
    failures: List[str] = []
    for path in WRITER_PATHS:
        source = path.read_text(encoding="utf-8")
        if "raise_if_generation_sealed" not in source:
            continue
        tree = ast.parse(source, filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Try):
                continue
            body = ast.get_source_segment(source, node) or ""
            if "raise_if_generation_sealed" not in body:
                continue
            names = [
                h.type.id
                for h in node.handlers
                if isinstance(h.type, ast.Name)
            ]
            if "Exception" in names and "WorkflowGenerationSealed" not in names:
                failures.append(
                    f"{path.name}:{node.lineno}: a try/except Exception wraps "
                    f"raise_if_generation_sealed() without re-raising "
                    f"WorkflowGenerationSealed — the stop signal is swallowed"
                )
    return failures


async def run_all_tests() -> Dict[str, Any]:
    passed = 0
    failed = 0
    messages: List[str] = []

    for name, case in (
        ("generation header symbol is resolvable in every TOOL writer", _test_symbol_is_resolvable),
        ("every /messages POST sends the generation header", _test_message_posts_send_the_header),
        ("every /messages POST aborts on a sealed generation", _test_message_posts_abort_on_409),
        ("the sealed-generation abort is never swallowed", _test_abort_survives_blanket_handlers),
    ):
        problems = case()
        if problems:
            failed += 1
            messages.append(f"FAIL {name}")
            messages.extend(f"  - {p}" for p in problems)
        else:
            passed += 1
            messages.append(f"PASS {name}")

    for line in messages:
        print(line)
    return {"passed": passed, "failed": failed}
