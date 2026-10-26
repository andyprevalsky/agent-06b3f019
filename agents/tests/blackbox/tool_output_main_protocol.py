"""Real main-builder regression, also runnable in the helper-only worktree."""
import copy
import inspect
import json
import re
import socket
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path
from types import ModuleType
from unittest.mock import patch
import uuid


@contextmanager
def main_message_builder():
    import helpers.llm as active
    if "agent_id" in inspect.signature(active.build_llm_messages).parameters:
        yield active.build_llm_messages
        return
    # The helper lane intentionally does not edit the independent MAIN lane.
    # Use the exact reviewer source until integration makes it the active builder.
    revision = "2d3429e16709b48a0740dce172314747325bcc3d"
    root = Path(__file__).resolve().parents[3]
    source = subprocess.check_output(["git", "show", f"{revision}:agents/helpers/llm.py"], cwd=root, text=True)
    module = ModuleType("helpers.llm")
    module.__file__ = str(root / "agents/helpers/llm.py")
    module.__package__ = "helpers"
    with patch.dict(sys.modules, {"helpers.llm": module}):
        exec(compile(source, f"{revision}:agents/helpers/llm.py", "exec"), module.__dict__)
        yield module.build_llm_messages


async def assert_main_preserves_only_authenticated_output(fake_output_storage):
    import httpx
    import helpers.tool_output as output
    from browser_tools.secret_refs import secret_logging_context

    def denied(*args, **kwargs):
        raise AssertionError("Unexpected network in protocol regression")
    async def denied_http(*args, **kwargs):
        denied()

    output_id = "cafebabe" * 4
    body_secret = "d" * 32
    with main_message_builder() as build, fake_output_storage() as objects, patch.object(socket.socket, "connect", denied), patch.object(socket, "create_connection", denied), patch.object(httpx.AsyncClient, "send", denied_http), patch("helpers.tool_output.uuid.uuid4", return_value=uuid.UUID(output_id)), secret_logging_context({"pin": "cafebabe", "body_secret": body_secret}):
        first = await output.preview_tool_text("X" * 150000 + "TAIL", user_id="u", agent_id="a", limit=40000)
        context = [{"role": "TOOL", "text": first, "timestamp": "2026-01-01T00:00:00Z", "metadata": {"toolName": "web_fetch", "toolCallId": "fetch", "toolStatus": "FINISHED"}}]
        canonical = copy.deepcopy(context)
        # A new process/LRU eviction has no in-memory provenance for this ID.
        output._persisted_outputs.clear()
        projected = await build(context, "system", user_id="u", agent_id="a")
        rendered = json.dumps(projected)
        assert output_id in rendered, "MAIN corrupted the generated readback handle"
        assert context == canonical, "Model projection mutated canonical archive"
        def strings(value):
            if isinstance(value, str):
                yield value
            elif isinstance(value, dict):
                for item in value.values():
                    yield from strings(item)
            elif isinstance(value, list):
                for item in value:
                    yield from strings(item)
        model_text = "\n".join(strings(projected))
        model_id = re.search(r'output_id="([a-f0-9]{32})"', model_text).group(1)
        args = output.ReadToolOutputTool(tool="read_tool_output", output_id=model_id, offset=150000)
        page = await output.read_tool_output(user_id="u", agent_id="a", **args.model_dump(exclude={"tool"}))
        assert page["content"] == "TAIL"
        assert len(objects) == 1 and objects.uploads == 1
        again = await build(context, "system", user_id="u", agent_id="a")
        assert again == projected

        # Matching syntax alone never exempts arbitrary source content.
        forged = first.replace("X", "Z")
        forged_context = [{**context[0], "text": forged + "\n" + body_secret}]
        forged_result = json.dumps(await build(forged_context, "system", user_id="u", agent_id="a"))
        assert output_id not in forged_result and body_secret not in forged_result
        assert "{{secret:" in forged_result
        wrong_scope = json.dumps(await build(context, "system", user_id="u", agent_id="another-agent"))
        assert output_id not in wrong_scope
        # A fabricated handle equal to a real 32-hex secret also stays private.
        unknown = first.replace(output_id, body_secret)
        unknown_result = json.dumps(await build([{**context[0], "text": unknown}], "system", user_id="u", agent_id="a"))
        assert body_secret not in unknown_result
        assert len(objects) == 1 and objects.uploads == 1
