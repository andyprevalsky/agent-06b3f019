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
        except Exception as exc:
            failures.append(f"{module_name}: import failed: {type(exc).__name__}: {exc}")
            continue
        if not hasattr(module, "workflow_generation_headers"):
            failures.append(
                f"{module_name}: calls workflow_generation_headers() but never imports it — "
                f"this raises NameError at call time and py_compile cannot see it"
            )
    return failures


def _post_has_generation_headers(node: ast.Call, tree: ast.AST) -> bool:
    def direct_header(value: ast.AST) -> bool:
        return (
            isinstance(value, ast.Call)
            and isinstance(value.func, ast.Name)
            and value.func.id == "workflow_generation_headers"
            and not value.args
            and not value.keywords
        )

    def includes_header(value: ast.AST) -> bool:
        if direct_header(value):
            return True
        if not isinstance(value, ast.Dict):
            return False
        # Only helper spreads and known different headers preserve attribution.
        # Unknown earlier spreads can add a differently cased duplicate key;
        # unknown later spreads can replace the generation outright.
        found_header = False
        for key, item in zip(value.keys, value.values):
            if key is None:
                if not direct_header(item):
                    return False
                found_header = True
                continue
            if not isinstance(key, ast.Constant) or not isinstance(key.value, str):
                return False
            if key.value.lower() == "x-agent-workflow-generation":
                return False
        return found_header

    header = next((kw.value for kw in node.keywords if kw.arg == "headers"), None)
    if header is None:
        return False
    if includes_header(header):
        return True
    if not isinstance(header, ast.Name):
        return False
    # Recording retries preserve one header dictionary. Resolve its preceding
    # assignment in an enclosing sequential block, without accepting conditional
    # sibling assignments or a later overwrite that drops the generation.
    parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}

    def mentions_alias(statement: ast.AST) -> bool:
        return any(isinstance(child, ast.Name) and child.id == header.id for child in ast.walk(statement))

    current: ast.AST = node
    while current in parents:
        parent = parents[current]
        if isinstance(parent, ast.ExceptHandler) and parent.name == header.id:
            return False
        # Enclosing tests/bindings and sibling handlers/finally clauses can
        # replace or mutate the alias before this call or the next iteration.
        for _field, value in ast.iter_fields(parent):
            if value is current or isinstance(value, list) and current in value:
                continue
            children = value if isinstance(value, list) else [value]
            if any(isinstance(child, ast.AST) and mentions_alias(child) for child in children):
                return False
        for field in ("body", "orelse", "finalbody"):
            block = getattr(parent, field, None)
            if not isinstance(block, list) or current not in block:
                continue
            for statement in reversed(block[: block.index(current)]):
                if (
                    isinstance(statement, ast.Assign)
                    and len(statement.targets) == 1
                    and isinstance(statement.targets[0], ast.Name)
                    and statement.targets[0].id == header.id
                ):
                    return includes_header(statement.value)
                if (
                    isinstance(statement, ast.AnnAssign)
                    and isinstance(statement.target, ast.Name)
                    and statement.target.id == header.id
                ):
                    return statement.value is not None and includes_header(statement.value)
                # Unknown uses may mutate or rebind the dictionary, including
                # conditional assignments, alias escapes and method calls.
                if mentions_alias(statement):
                    return False
            if isinstance(parent, (ast.For, ast.AsyncFor, ast.While)):
                if any(mentions_alias(statement) for statement in block[block.index(current) + 1 :]):
                    return False
        if isinstance(parent, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            return False
        if isinstance(parent, (ast.For, ast.AsyncFor)) and mentions_alias(parent.target):
            return False
        current = parent
    return False


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
            if not _post_has_generation_headers(node, tree):
                failures.append(
                    f"{path.name}:{node.lineno}: POST to /messages does not send "
                    f"workflow_generation_headers() — its writes will be attributed to "
                    f"generation 1 and fenced after any deploy replacement"
                )
    return failures


def _test_header_alias_resolution() -> List[str]:
    snippets = (
        ("headers = {**workflow_generation_headers()}\nclient.post('/messages', headers=headers)", True),
        ("headers = {**workflow_generation_headers()}\nheaders = {}\nclient.post('/messages', headers=headers)", False),
        (
            "if enabled:\n    headers = {**workflow_generation_headers()}\nclient.post('/messages', headers=headers)",
            False,
        ),
        ("client.post('/messages', headers={**workflow_generation_headers()})", True),
        ("client.post('/messages', headers={})", False),
        (
            "headers = {**workflow_generation_headers()}\nif enabled:\n    headers = {}\nclient.post('/messages', headers=headers)",
            False,
        ),
        (
            "headers = {**workflow_generation_headers()}\nheaders: dict = {}\nclient.post('/messages', headers=headers)",
            False,
        ),
        (
            "headers = {**workflow_generation_headers()}\ndef send(headers):\n    client.post('/messages', headers=headers)",
            False,
        ),
        (
            "headers = {**workflow_generation_headers()}\nheaders.clear()\nclient.post('/messages', headers=headers)",
            False,
        ),
        (
            "headers = {**workflow_generation_headers()}\nmutate(headers)\nclient.post('/messages', headers=headers)",
            False,
        ),
        (
            "headers = {**workflow_generation_headers()}\nfor item in items:\n    client.post('/messages', headers=headers)\n    headers.clear()",
            False,
        ),
        (
            "headers = {**workflow_generation_headers()}\nwith resource as headers:\n    client.post('/messages', headers=headers)",
            False,
        ),
        (
            "headers = {**workflow_generation_headers()}\nif (headers := {'other': 'value'}):\n    client.post('/messages', headers=headers)",
            False,
        ),
        (
            "headers = {**workflow_generation_headers()}\ntry:\n    work()\nexcept Exception as headers:\n    client.post('/messages', headers=headers)",
            False,
        ),
        (
            "headers = {**workflow_generation_headers()}\nfor item in items:\n    try:\n        client.post('/messages', headers=headers)\n    finally:\n        headers.clear()",
            False,
        ),
        (
            "headers = {'Other': workflow_generation_headers().get('X-Agent-Workflow-Generation', '')}\nclient.post('/messages', headers=headers)",
            False,
        ),
        (
            "headers = {**workflow_generation_headers(), 'X-Agent-Workflow-Generation': 'stale'}\nclient.post('/messages', headers=headers)",
            False,
        ),
        (
            "headers = {**workflow_generation_headers(), **unknown}\nclient.post('/messages', headers=headers)",
            False,
        ),
        (
            "headers = {**unknown, **workflow_generation_headers()}\nclient.post('/messages', headers=headers)",
            False,
        ),
        (
            "headers = {'x-api-key': key, **workflow_generation_headers()}\nclient.post('/messages', headers=headers)",
            True,
        ),
        ("headers = workflow_generation_headers()\nclient.post('/messages', headers=headers)", True),
        (
            "client.post('/messages', headers={**workflow_generation_headers(), 'x-agent-workflow-generation': 'stale'})",
            False,
        ),
        (
            "headers = {**workflow_generation_headers(), key: 'stale'}\nclient.post('/messages', headers=headers)",
            False,
        ),
    )
    failures = []
    for index, (source, expected) in enumerate(snippets):
        tree = ast.parse(source)
        post = next(
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "post"
        )
        if _post_has_generation_headers(post, tree) != expected:
            failures.append(f"header alias fixture {index} incorrectly classified")
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
            names = [h.type.id for h in node.handlers if isinstance(h.type, ast.Name)]
            if "Exception" in names and "WorkflowGenerationSealed" not in names:
                failures.append(
                    f"{path.name}:{node.lineno}: a try/except Exception wraps "
                    f"raise_if_generation_sealed() without re-raising "
                    f"WorkflowGenerationSealed — the stop signal is swallowed"
                )
    return failures


# Deferred-post queues that gather() their writes. `return_exceptions=True`
# turns a raised WorkflowGenerationSealed into a VALUE, so unless the caller
# inspects the results and re-raises, the stop signal is downgraded to a log
# line and the worker keeps running on a replaced generation. This is how the
# explore agent went quiet 1s after a cutover and then emitted one more fenced
# write 17s later.
QUEUE_PATHS = [
    DOMAINS_ROOT / "spawn_agent" / "service.py",
]


def _test_gather_reraises_sealed() -> List[str]:
    """A gather(return_exceptions=True) over agent writes must re-raise the seal."""
    failures: List[str] = []
    for path in QUEUE_PATHS:
        source = path.read_text(encoding="utf-8")
        if "return_exceptions=True" not in source:
            continue
        if "WorkflowGenerationSealed" not in source:
            failures.append(
                f"{path.name}: gathers agent writes with return_exceptions=True but never "
                f"mentions WorkflowGenerationSealed — a sealed generation would be swallowed"
            )
            continue
        if "raise sealed" not in source and "raise result" not in source:
            failures.append(
                f"{path.name}: inspects results for WorkflowGenerationSealed but never "
                f"re-raises it — the abort is downgraded to a log line"
            )
    return failures


async def run_all_tests() -> Dict[str, Any]:
    passed = 0
    failed = 0
    messages: List[str] = []

    for name, case in (
        ("generation header symbol is resolvable in every TOOL writer", _test_symbol_is_resolvable),
        ("every /messages POST sends the generation header", _test_message_posts_send_the_header),
        ("header aliases preserve generation and reject overwrites", _test_header_alias_resolution),
        ("every /messages POST aborts on a sealed generation", _test_message_posts_abort_on_409),
        ("the sealed-generation abort is never swallowed", _test_abort_survives_blanket_handlers),
        ("gather(return_exceptions) never downgrades the abort", _test_gather_reraises_sealed),
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
