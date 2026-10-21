"""Exercise the actual Phone branch of the browser supervisor's timeout boundary."""
import ast
import asyncio
import copy
from pathlib import Path
from unittest.mock import AsyncMock, patch


async def check_phone_supervisor_boundary():
    from domains.spawn_browser_agent_v3 import handler

    tree = ast.parse(Path(handler.__file__).read_text())
    boundary = next(
        node for node in ast.walk(tree)
        if isinstance(node, ast.Try) and node.body and isinstance(node.body[0], ast.If)
        and any(isinstance(child, ast.Constant) and child.value == "phone" for child in ast.walk(node.body[0].test))
        and any(isinstance(child, ast.Constant) and child.value == "Browser action timed out; CDP stall classification" for child in ast.walk(node))
    )
    namespace = dict(handler.__dict__)
    recover = AsyncMock()
    classify = AsyncMock()
    namespace.update(action_name="phone", _recover_browser_step=recover)
    function = ast.AsyncFunctionDef(
        name="actual_phone_supervisor",
        args=ast.arguments(posonlyargs=[], args=[], kwonlyargs=[], kw_defaults=[], defaults=[]),
        body=[copy.deepcopy(boundary), ast.Return(value=ast.Name(id="result", ctx=ast.Load()))],
        decorator_list=[],
    )
    exec(compile(ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[])), handler.__file__, "exec"), namespace)

    async def timeout():
        raise asyncio.TimeoutError("CANARY-PRIVATE-INPUT")

    async def cancelled():
        raise asyncio.CancelledError()

    with patch("domains.spawn_browser_agent_v3.service_actions.classify_evaluate_cdp_stall", classify):
        namespace["action_task"] = asyncio.create_task(timeout())
        result = await namespace["actual_phone_supervisor"]()
        assert result == {"success": False, "status": "UNKNOWN", "error": "Phone outcome unconfirmed; inspect owned receipt"}
        assert "CANARY" not in str(result)
        namespace["action_task"] = asyncio.create_task(cancelled())
        try:
            await namespace["actual_phone_supervisor"]()
        except asyncio.CancelledError:
            pass
        else:
            raise AssertionError("Phone cancellation must propagate")
    classify.assert_not_awaited()
    recover.assert_not_awaited()
