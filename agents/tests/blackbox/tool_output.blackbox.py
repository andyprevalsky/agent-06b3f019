"""Offline storage-contract checks; agent dispatcher integration is separate."""
import asyncio
import json
import uuid
from contextlib import contextmanager
from unittest.mock import patch
from _test_utils import BlackboxResult


@contextmanager
def fake_output_storage():
    """Faithful existing upload path, hard failure for any unmocked I/O."""
    class StoredOutputs(dict):
        uploads = 0
    objects = StoredOutputs()
    async def upload(user_id, content, filename, mime_type, *, idempotency_key=None):
        objects.uploads += 1
        await asyncio.sleep(0)
        path = f"{user_id}/{uuid.uuid5(uuid.NAMESPACE_URL, idempotency_key)}_{filename}"
        objects[path] = content
        return {"storage_path": path}
    async def download(path):
        if path not in objects:
            raise FileNotFoundError("No output for this scope")
        return objects[path]
    # Each fixture models a fresh storage/account universe; metadata must not
    # leak references to an artifact held by a prior fixture.
    from collections import OrderedDict
    with patch("helpers.tool_output._persisted_outputs", OrderedDict()), patch("helpers.tool_output._pending_outputs", {}), patch("helpers.attachments.upload_to_storage", upload), patch("helpers.attachments.download_from_storage", download):
        yield objects


async def test_scoped_output_roundtrip():
    import re
    from helpers.tool_output import preview_tool_text, read_tool_output
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
        with patch("helpers.tool_output.time.time", return_value=10**12):
            try:
                await read_tool_output(**owner, output_id=output_id)
            except ValueError as exc:
                assert "expired" in str(exc)
            else:
                raise AssertionError("Expired retrieval succeeded")


async def test_native_values_and_failure():
    from helpers.tool_output import bound_tool_result, preview_tool_text
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


async def test_repeated_projection_is_stable_and_readable():
    import re
    from helpers.tool_output import preview_tool_text, read_tool_output
    owner = dict(user_id="repeat-user", agent_id="repeat-agent", session_id="repeat-session")
    text = "x" * 150_000 + "TAIL"
    with fake_output_storage() as objects:
        first = await preview_tool_text(text, **owner)
        first_bytes = dict(objects)
        second = await preview_tool_text(text, **owner)
        assert first == second, "Repeated unchanged projection changes the retrieval handle"
        assert len(objects) == 1 and objects == first_bytes, "Repeated projection uploads duplicate artifacts"
        output_id = re.search(r'output_id="([a-f0-9]{32})"', first).group(1)
        page = await read_tool_output(**owner, output_id=output_id, offset=150_000)
        assert page["content"] == "TAIL"


async def test_main_retained_protocol_survives_redaction():
    from tool_output_main_protocol import assert_main_preserves_only_authenticated_output
    await assert_main_preserves_only_authenticated_output(fake_output_storage)


async def run_all_tests():
    r = BlackboxResult()
    await r.record_async("main_retained_protocol_survives_redaction", test_main_retained_protocol_survives_redaction)
    await r.record_async("projection_identity_scope_expiry_and_failure", test_projection_identity_scope_expiry_and_failure)
    await r.record_async("concurrent_projection_shares_upload", test_concurrent_projection_shares_upload)
    await r.record_async("repeated_projection_is_stable_and_readable", test_repeated_projection_is_stable_and_readable)
    await r.record_async("scoped_output_roundtrip", test_scoped_output_roundtrip)
    await r.record_async("native_values_and_failure", test_native_values_and_failure)
    return r.summary()


async def test_projection_identity_scope_expiry_and_failure():
    import re
    from helpers.tool_output import preview_tool_text, read_tool_output, OUTPUT_TTL_SECONDS
    owner = dict(user_id="u", agent_id="a", session_id="s")
    text = "y" * 150_000 + "TAIL"
    clock = [1000.0]
    def identifier(preview):
        return re.search(r'output_id="([a-f0-9]{32})"', preview).group(1)
    with fake_output_storage() as objects, patch("helpers.tool_output.time.time", side_effect=lambda: clock[0]):
        first = await preview_tool_text(text, **owner)
        initial_bytes = dict(objects)
        clock[0] += 10
        assert await preview_tool_text(text, **owner) == first
        assert objects == initial_bytes and objects.uploads == 1
        for field in owner:
            changed_owner = {**owner, field: "OTHER"}
            assert identifier(await preview_tool_text(text, **changed_owner)) != identifier(first)
            try:
                await read_tool_output(**changed_owner, output_id=identifier(first))
            except FileNotFoundError:
                pass
            else:
                raise AssertionError("New scope accessed original artifact")
        changed = await preview_tool_text(text + "CHANGED", **owner)
        assert identifier(changed) != identifier(first) and objects.uploads == 5
        assert (await read_tool_output(**owner, output_id=identifier(first), offset=150_000))["content"] == "TAIL"
        async def fail(*args, **kwargs):
            raise OSError("fixture store failure")
        with patch("helpers.attachments.upload_to_storage", fail):
            assert await preview_tool_text(text, **owner) == first
            try:
                await preview_tool_text(text + "NEW_FAILURE", **owner)
            except OSError:
                pass
            else:
                raise AssertionError("Failed output was cached as success")
        retry = await preview_tool_text(text + "NEW_FAILURE", **owner)
        assert (await read_tool_output(**owner, output_id=identifier(retry), offset=150_000))["content"] == "TAILNEW_FAILURE"
        clock[0] = 1000 + OUTPUT_TTL_SECONDS + 1
        for _ in range(2):
            try:
                await read_tool_output(**owner, output_id=identifier(first))
            except ValueError as error:
                assert "expired" in str(error)
            else:
                raise AssertionError("Original expiry was extended")
            renewed = await preview_tool_text(text, **owner)
            assert identifier(renewed) != identifier(first)
            assert (await read_tool_output(**owner, output_id=identifier(renewed), offset=150_000))["content"] == "TAIL"


async def test_concurrent_projection_shares_upload():
    import helpers.tool_output as output
    owner = dict(user_id="concurrent-user", agent_id="a")
    text = "z" * 150_000
    with fake_output_storage() as objects:
        results = await asyncio.gather(*(output.preview_tool_text(text, **owner) for _ in range(5)))
        assert len(set(results)) == 1 and objects.uploads == 1 and len(objects) == 1
        assert not output._pending_outputs
        async def fail(*args, **kwargs):
            await asyncio.sleep(0)
            raise OSError("shared upload failed")
        with patch("helpers.attachments.upload_to_storage", fail):
            errors = await asyncio.gather(*(output.preview_tool_text(text + "FAIL", **owner) for _ in range(5)), return_exceptions=True)
        assert all(isinstance(error, OSError) for error in errors)
        assert not output._pending_outputs and len(output._persisted_outputs) == 1
        await output.preview_tool_text(text + "FAIL", **owner)
        assert objects.uploads == 2
