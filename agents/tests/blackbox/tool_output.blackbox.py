"""Offline storage-contract checks; agent dispatcher integration is separate."""
import json
import uuid
from contextlib import contextmanager
from unittest.mock import patch
from _test_utils import BlackboxResult


@contextmanager
def fake_output_storage():
    """Faithful existing upload path, hard failure for any unmocked I/O."""
    objects = {}
    async def upload(user_id, content, filename, mime_type, *, idempotency_key=None):
        path = f"{user_id}/{uuid.uuid5(uuid.NAMESPACE_URL, idempotency_key)}_{filename}"
        objects[path] = content
        return {"storage_path": path}
    async def download(path):
        if path not in objects:
            raise FileNotFoundError("No output for this scope")
        return objects[path]
    with patch("helpers.attachments.upload_to_storage", upload), patch("helpers.attachments.download_from_storage", download):
        yield objects


async def test_scoped_output_roundtrip():
    import re
    from utils.tool_output import preview_tool_text, read_tool_output
    from browser_tools.secret_refs import secret_logging_context
    owner = dict(user_id="u", agent_id="a", session_id="s")
    text = "😀" * 110_000 + "SECRET_VALUE" + "EXACT_TAIL"
    with fake_output_storage() as objects, secret_logging_context({"password": "SECRET_VALUE"}):
        preview = await preview_tool_text(text, **owner)
        assert len(preview) <= 100_000
        assert b"SECRET_VALUE" not in next(iter(objects.values()))
        match = re.search(r'output_id="([a-f0-9]{32})" offset=(\d+)', preview)
        assert match
        output_id, offset = match.groups()
        recovered = preview.split("\n[Retained tool output:")[0]
        while offset is not None:
            page = await read_tool_output(**owner, output_id=output_id, offset=int(offset), limit=7777)
            assert len(page["content"]) <= 7777
            recovered += page["content"]
            offset = page["next_offset"]
        assert recovered.endswith("EXACT_TAIL") and "SECRET_VALUE" not in recovered, repr(recovered[-200:])
        found = await read_tool_output(**owner, output_id=output_id, query="EXACT_TAIL")
        assert found["content"] == "EXACT_TAIL" and found["found"]
        absent = await read_tool_output(**owner, output_id=output_id, query="MISSING")
        assert not absent["found"] and absent["next_offset"] is None
        for field in owner:
            other = {**owner, field: "OTHER"}
            try:
                await read_tool_output(**other, output_id=output_id)
            except FileNotFoundError:
                pass
            else:
                raise AssertionError("Cross-owner retrieval succeeded")
        with patch("utils.tool_output.time.time", return_value=10**12):
            try:
                await read_tool_output(**owner, output_id=output_id)
            except ValueError as exc:
                assert "expired" in str(exc)
            else:
                raise AssertionError("Expired retrieval succeeded")


async def test_native_values_and_failure():
    from utils.tool_output import bound_tool_result, preview_tool_text
    owner = dict(user_id="u", agent_id="a")
    with fake_output_storage():
        for value in (None, False, 42, [1, 2], {"value": "small"}):
            assert await bound_tool_result(value, **owner) is value
        result = await bound_tool_result({"success": False, "error": True, "body": ["x"] * 100_000}, **owner)
        assert result["success"] is False and result["error"] is True
        assert len(json.dumps(result, ensure_ascii=False)) <= 100_000
    async def fail(*args, **kwargs):
        raise OSError("storage down")
    with patch("helpers.attachments.upload_to_storage", fail):
        try:
            await preview_tool_text("x" * 100_001, **owner)
        except OSError as exc:
            assert "storage down" in str(exc)
        else:
            raise AssertionError("Storage failure reported a successful preview")


async def run_all_tests():
    r = BlackboxResult()
    await r.record_async("scoped_output_roundtrip", test_scoped_output_roundtrip)
    await r.record_async("native_values_and_failure", test_native_values_and_failure)
    return r
