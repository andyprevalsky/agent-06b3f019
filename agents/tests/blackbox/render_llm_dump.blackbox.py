"""Blackbox tests for the local LLM dump HTML renderer."""

import importlib.util
import json
import os
import tempfile
from pathlib import Path

from _test_utils import BlackboxResult


ROOT = Path(__file__).resolve().parents[3]


def _load_renderer():
    spec = importlib.util.spec_from_file_location("render_llm_dump", ROOT / "scripts" / "render_llm_dump.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_output_section_embeds_browser_recording_at_action_timestamp():
    renderer = _load_renderer()

    with tempfile.TemporaryDirectory() as tmp:
        recording_dir = Path(tmp) / "recording"
        frames_dir = recording_dir / "frames"
        frames_dir.mkdir(parents=True)
        (frames_dir / "frame_00001.jpg").write_bytes(b"frame-one")
        (frames_dir / "frame_00002.jpg").write_bytes(b"frame-two")
        manifest_path = recording_dir / "manifest.json"
        manifest_path.write_text(
            json.dumps(
                {
                    "frames": [
                        {
                            "src": "frames/frame_00001.jpg",
                            "ts_ms": 100,
                            "label": "idle",
                            "action": "idle",
                            "metadata": {},
                        },
                        {
                            "src": "frames/frame_00002.jpg",
                            "ts_ms": 1234,
                            "label": "Clicking Submit",
                            "action": "click",
                            "cursor": {"x": 10, "y": 20},
                            "metadata": {"step": 4, "phase": "start", "action": "click"},
                        },
                    ]
                }
            )
        )
        output_path = Path(tmp) / "rendered" / "dump.html"
        output_path.parent.mkdir(parents=True)

        html = renderer.render_output_section(
            {
                "call_site": "browser_use_step_4",
                "output": {"action": {"action": "click", "index": 7}},
                "extra": {
                    "browser_recording_manifest_path": str(manifest_path),
                    "iteration": 4,
                },
            },
            output_path=output_path,
        )

        assert "Browser Recording" in html
        assert "Defaulted to click for step 4 at 1.2s" in html
        assert "frame_00002.jpg" in html
        assert "file://" not in html
        assert "cursorByFrame" in html
        assert 'value="1"' in html
        assert "<option selected>4</option>" in html
        assert (output_path.parent / f"{output_path.stem}_assets").exists()


def test_token_overview_uses_raw_input_and_infers_gpt_cache_write():
    renderer = _load_renderer()

    html = renderer.token_overview_rows(
        {
            "model": "gpt-5.5",
            "output": {
                "usage": {
                    "prompt_tokens": 8311,
                    "completion_tokens": 39,
                    "total_tokens": 8350,
                    "cache_read_input_tokens": 4992,
                    "cache_creation_input_tokens": 0,
                    "compute_token_used": {"type": "gpt"},
                }
            },
        }
    )

    input_section = html.split("<dt>Input Tokens</dt>", 1)[1].split("</dd>", 1)[0]
    assert "8311 tokens" in input_section
    assert "token-bar" not in input_section
    assert "3319 tokens" in html


def test_finished_browser_tool_result_embeds_recording_by_task_id():
    renderer = _load_renderer()

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / ".context" / "browser-agent-recordings" / "agent-1" / "task-1"
        root.mkdir(parents=True)
        (root / "index.html").write_text("<html>recording</html>")
        (root / "manifest.json").write_text(
            json.dumps(
                {
                    "task_id": "task-1",
                    "session_id": "session-1",
                    "frame_count": 1,
                    "frames": [
                        {
                            "src": "frame.jpg",
                            "ts_ms": 1000,
                            "label": "done",
                            "action": "verify",
                            "metadata": {},
                        }
                    ],
                }
            )
        )
        (root / "frame.jpg").write_bytes(b"fake-image")
        output_path = Path(tmp) / "rendered" / "dump.html"
        output_path.parent.mkdir(parents=True)

        html = renderer.render_browser_recording_for_tool_message(
            {
                "role": "tool",
                "name": "spawn_browser_agent",
                "content": "[2026-05-28 02:00] Browser automation complete: **Status**: ✅ SUCCESS",
                "metadata": {
                    "task_id": "task-1",
                    "browser_session_metadata": {
                        "provider": "steel",
                        "proxy_source": "steel",
                        "proxy_location": {"city": "DALLAS", "state": "TX", "country": "US"},
                    },
                },
            },
            {"agent_id": "agent-1"},
            root / "dump.json",
            3,
            output_path,
        )

    assert "Browser Recording" in html
    assert "recording-player" in html
    assert "data-canvas" in html
    assert "open standalone" in html
    assert "file://" not in html
    assert "Proxy City" in html
    assert "DALLAS" in html


def test_published_dump_never_embeds_file_uri_recordings():
    """Published dump HTML must stay playable after the source recording dir is gone."""
    renderer = _load_renderer()

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        recording_dir = tmp_path / "recording"
        frames_dir = recording_dir / "frames"
        frames_dir.mkdir(parents=True)
        (frames_dir / "frame_00001.jpg").write_bytes(b"\xff\xd8\xff\xe0frame-one")
        (frames_dir / "frame_00002.jpg").write_bytes(b"\xff\xd8\xff\xe0frame-two")
        (recording_dir / "index.html").write_text("<html>recording</html>")
        manifest_path = recording_dir / "manifest.json"
        manifest_path.write_text(
            json.dumps(
                {
                    "frames": [
                        {
                            "src": "frames/frame_00001.jpg",
                            "ts_ms": 100,
                            "label": "idle",
                            "action": "idle",
                            "metadata": {},
                        },
                        {
                            "src": "frames/frame_00002.jpg",
                            "ts_ms": 1234,
                            "label": "Clicking Submit",
                            "action": "click",
                            "cursor": {"x": 10, "y": 20},
                            "metadata": {"step": 4, "phase": "start", "action": "click"},
                        },
                    ]
                }
            )
        )

        dump_data = {
            "call_site": "browser_use_step_4",
            "agent_id": "agent-repro",
            "model": "test",
            "messages": [],
            "output": {"action": {"action": "click", "index": 7}},
            "extra": {
                "browser_recording_manifest_path": str(manifest_path),
                "iteration": 4,
                "output": {"action": {"action": "click"}},
            },
        }
        out = tmp_path / "rendered" / "llm_dump_browser_use_step_4.html"
        out.parent.mkdir(parents=True)
        source = tmp_path / "dump.json"
        source.write_text(json.dumps(dump_data))
        out.write_text(renderer.build_html(dump_data, source, out), encoding="utf-8")

        artifacts_dir = tmp_path / "artifacts"
        artifacts_dir.mkdir()
        published = renderer.publish_rendered_dump(out, artifacts_dir)
        assert published is not None
        pub_html = published.read_text(encoding="utf-8")
        assert "file://" not in pub_html
        assert "Browser Recording" in pub_html
        assert "_assets/" in pub_html or "data:image/" in pub_html

        # Wipe the original recording tree — published dump must still have assets.
        import shutil

        shutil.rmtree(recording_dir)
        asset_frames = list((artifacts_dir / "llm_dump_browser_use_step_4_assets").rglob("frame_*.jpg"))
        assert asset_frames, "published dump must copy recording frames into _assets"


def test_missing_recording_frames_omits_player_instead_of_invalid_section():
    renderer = _load_renderer()

    with tempfile.TemporaryDirectory() as tmp:
        recording_dir = Path(tmp) / "recording"
        recording_dir.mkdir()
        manifest_path = recording_dir / "manifest.json"
        manifest_path.write_text(
            json.dumps(
                {
                    "frames": [
                        {
                            "src": "frames/missing.jpg",
                            "ts_ms": 100,
                            "label": "gone",
                            "action": "click",
                            "metadata": {},
                        }
                    ]
                }
            )
        )
        html = renderer.render_browser_recording_player_from_manifest(
            manifest_path,
            action_name="click",
            iteration=1,
            player_seed="broken",
            output_path=Path(tmp) / "out.html",
        )

    assert html == ""
    assert "Browser Recording" not in html


def test_split_system_prompt_drops_all_dynamic_boundaries():
    renderer = _load_renderer()

    boundary = renderer.SYSTEM_PROMPT_BOUNDARY
    messages = [
        {
            "role": "system",
            "content": f"static rules\n{boundary}\ndynamic rules\n{boundary}\n",
        },
        {"role": "user", "content": "hello"},
    ]

    static_prompt, dynamic_prompt, normalized_messages, _ = renderer.split_system_prompt(messages)

    assert static_prompt == "static rules"
    assert dynamic_prompt == "dynamic rules"
    assert boundary not in renderer.render_system_prompt(messages)
    assert boundary not in renderer.render_dynamic_system_prompt(messages)
    assert normalized_messages == [{"role": "user", "content": "hello"}]


def test_split_system_prompt_uses_second_system_as_dynamic_prompt():
    renderer = _load_renderer()

    messages = [
        {"role": "system", "content": "static rules"},
        {"role": "system", "content": "dynamic rules"},
        {"role": "user", "content": "hello"},
    ]

    static_prompt, dynamic_prompt, normalized_messages, _ = renderer.split_system_prompt(messages)

    assert static_prompt == "static rules"
    assert dynamic_prompt == "dynamic rules"
    assert "static rules" in renderer.render_system_prompt(messages)
    assert "dynamic rules" in renderer.render_dynamic_system_prompt(messages)
    assert normalized_messages == [{"role": "user", "content": "hello"}]


def test_message_renderer_drops_inline_output_schema_fields():
    renderer = _load_renderer()

    html = renderer.render_message_content(
        'done\n\nOutput Schema: {"fields": [{"description": "", "name": "selected_url", "properties": [], "required": true, "type": "str"}]}',
        Path("/tmp/rendered.html"),
        1,
    )

    assert "done" in html
    assert "selected_url" not in html
    assert "Output Schema" not in html
    assert "description" not in html
    assert "properties" not in html
    assert "required" not in html


def test_message_renderer_compacts_structured_response_values():
    renderer = _load_renderer()

    html = renderer.render_message_content(
        'done\n\nStructured Response: {"selected_url": "https://amazon.com/item", "added_to_cart": true}',
        Path("/tmp/rendered.html"),
        1,
    )

    assert "Structured Response" in html
    assert "selected_url:" in html
    assert "https://amazon.com/item" in html
    assert "added_to_cart: True" in html


def test_publish_dump_https_uploads_and_returns_presigned_url():
    """HTTPS publish must return a clickable URL (not a local artifact path)."""
    renderer = _load_renderer()

    class _FakeClient:
        def __init__(self):
            self.put = None

        def put_object(self, **kwargs):
            self.put = kwargs

        def generate_presigned_url(self, _op, Params=None, ExpiresIn=None):
            assert Params is not None
            assert ExpiresIn == 7 * 24 * 3600
            return f"https://example.r2.dev/{Params['Key']}?X-Amz-Signature=test"

    fake = _FakeClient()

    def _fake_r2():
        return fake, "trace-bucket"

    setattr(renderer, "_r2_client", _fake_r2)

    with tempfile.TemporaryDirectory() as tmp:
        html_path = Path(tmp) / "dump.html"
        html_path.write_text("<html>ok</html>", encoding="utf-8")
        url = renderer.publish_dump_https(html_path, agent_id="agent-1")
        assert url is not None
        assert url.startswith("https://")
        assert "file://" not in url
        assert "/opt/cursor/artifacts" not in url
        assert fake.put is not None
        assert fake.put["Bucket"] == "trace-bucket"
        assert fake.put["ContentType"].startswith("text/html")
        assert "agent-1" in fake.put["Key"]


def test_publish_dump_https_returns_none_without_r2():
    renderer = _load_renderer()

    def _missing():
        return None, ""

    setattr(renderer, "_r2_client", _missing)
    with tempfile.TemporaryDirectory() as tmp:
        html_path = Path(tmp) / "dump.html"
        html_path.write_text("<html>ok</html>", encoding="utf-8")
        assert renderer.publish_dump_https(html_path, agent_id="a") is None


def test_r2_unavailable_reason_names_the_real_cause():
    """A missing boto3 must not be reported as missing R2 env."""
    renderer = _load_renderer()
    saved = {name: os.environ.get(name) for name in renderer.R2_ENV}
    real_find_spec = renderer.importlib.util.find_spec
    try:
        for name in renderer.R2_ENV:
            os.environ.pop(name, None)
        assert renderer.r2_unavailable_reason() == "set " + ", ".join(renderer.R2_ENV)

        for name in renderer.R2_ENV:
            os.environ[name] = "x"
        renderer.importlib.util.find_spec = lambda name: None if name == "boto3" else real_find_spec(name)
        reason = renderer.r2_unavailable_reason()
        assert reason.startswith("boto3 is not importable"), reason
        assert "agents/venv/bin/python" in reason

        renderer.importlib.util.find_spec = lambda name: object()
        assert renderer.r2_unavailable_reason() == ""
    finally:
        renderer.importlib.util.find_spec = real_find_spec
        for name, value in saved.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def test_publish_rendered_dump_copies_html_and_assets():
    renderer = _load_renderer()

    with tempfile.TemporaryDirectory() as tmp:
        src_dir = Path(tmp) / "rendered"
        artifacts_dir = Path(tmp) / "artifacts"
        src_dir.mkdir()
        artifacts_dir.mkdir()
        html_path = src_dir / "llm_dump_browser_use_step_24.html"
        assets_dir = src_dir / "llm_dump_browser_use_step_24_assets"
        assets_dir.mkdir()
        (assets_dir / "shot.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"png-bytes")
        html_path.write_text(
            '<html><img src="llm_dump_browser_use_step_24_assets/shot.png"></html>',
            encoding="utf-8",
        )

        published = renderer.publish_rendered_dump(html_path, artifacts_dir)

        assert published == artifacts_dir / "llm_dump_browser_use_step_24.html"
        assert published is not None
        published_html = published.read_text(encoding="utf-8")
        assert "file://" not in published_html
        assert "data:image/png;base64," in published_html
        assert "llm_dump_browser_use_step_24_assets/shot.png" not in published_html
        assert renderer.publish_rendered_dump(html_path, Path(tmp) / "missing") is None


def test_published_dump_is_viewable_without_sidecar_assets():
    """Published HTML must remain viewable even if the _assets directory is deleted."""
    renderer = _load_renderer()

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        recording_dir = tmp_path / "recording"
        frames_dir = recording_dir / "frames"
        frames_dir.mkdir(parents=True)
        (frames_dir / "frame_00001.jpg").write_bytes(b"\xff\xd8\xff\xe0frame-one")
        (frames_dir / "frame_00002.jpg").write_bytes(b"\xff\xd8\xff\xe0frame-two")
        (recording_dir / "index.html").write_text("<html>recording</html>")
        manifest_path = recording_dir / "manifest.json"
        manifest_path.write_text(
            json.dumps(
                {
                    "frames": [
                        {
                            "src": "frames/frame_00001.jpg",
                            "ts_ms": 100,
                            "label": "idle",
                            "action": "idle",
                            "metadata": {},
                        },
                        {
                            "src": "frames/frame_00002.jpg",
                            "ts_ms": 1234,
                            "label": "Clicking Submit",
                            "action": "click",
                            "cursor": {"x": 10, "y": 20},
                            "metadata": {"step": 4, "phase": "start", "action": "click"},
                        },
                    ]
                }
            )
        )
        dump_data = {
            "call_site": "browser_use_step_4",
            "agent_id": "agent-repro",
            "model": "test",
            "messages": [],
            "output": {"action": {"action": "click", "index": 7}},
            "extra": {
                "browser_recording_manifest_path": str(manifest_path),
                "iteration": 4,
                "output": {"action": {"action": "click"}},
            },
        }
        out = tmp_path / "rendered" / "llm_dump_browser_use_step_4.html"
        out.parent.mkdir(parents=True)
        source = tmp_path / "dump.json"
        source.write_text(json.dumps(dump_data))
        out.write_text(renderer.build_html(dump_data, source, out), encoding="utf-8")

        artifacts_dir = tmp_path / "artifacts"
        artifacts_dir.mkdir()
        published = renderer.publish_rendered_dump(out, artifacts_dir)
        assert published is not None
        # Delete every sidecar — the published HTML must still embed the frames.
        for path in artifacts_dir.iterdir():
            if path != published:
                if path.is_dir():
                    import shutil

                    shutil.rmtree(path)
                else:
                    path.unlink()
        pub_html = published.read_text(encoding="utf-8")
        assert "file://" not in pub_html
        assert "Browser Recording" in pub_html
        assert "data:image/jpeg;base64," in pub_html
        assert "_assets/" not in pub_html


async def run_all_tests():
    r = BlackboxResult()
    r.record(
        "output_section_embeds_browser_recording_at_action_timestamp",
        test_output_section_embeds_browser_recording_at_action_timestamp,
    )
    r.record(
        "token_overview_raw_input_infers_gpt_write",
        test_token_overview_uses_raw_input_and_infers_gpt_cache_write,
    )
    r.record(
        "finished_browser_tool_result_embeds_recording_by_task_id",
        test_finished_browser_tool_result_embeds_recording_by_task_id,
    )
    r.record(
        "published_dump_never_embeds_file_uri_recordings",
        test_published_dump_never_embeds_file_uri_recordings,
    )
    r.record(
        "missing_recording_frames_omits_player_instead_of_invalid_section",
        test_missing_recording_frames_omits_player_instead_of_invalid_section,
    )
    r.record(
        "split_system_prompt_drops_all_dynamic_boundaries",
        test_split_system_prompt_drops_all_dynamic_boundaries,
    )
    r.record(
        "split_system_prompt_uses_second_system_as_dynamic_prompt",
        test_split_system_prompt_uses_second_system_as_dynamic_prompt,
    )
    r.record(
        "message_renderer_drops_inline_output_schema_fields",
        test_message_renderer_drops_inline_output_schema_fields,
    )
    r.record(
        "message_renderer_compacts_structured_response_values",
        test_message_renderer_compacts_structured_response_values,
    )
    r.record(
        "publish_rendered_dump_copies_html_and_assets",
        test_publish_rendered_dump_copies_html_and_assets,
    )
    r.record(
        "publish_dump_https_uploads_and_returns_presigned_url",
        test_publish_dump_https_uploads_and_returns_presigned_url,
    )
    r.record(
        "publish_dump_https_returns_none_without_r2",
        test_publish_dump_https_returns_none_without_r2,
    )
    r.record(
        "r2_unavailable_reason_names_the_real_cause",
        test_r2_unavailable_reason_names_the_real_cause,
    )
    r.record(
        "published_dump_is_viewable_without_sidecar_assets",
        test_published_dump_is_viewable_without_sidecar_assets,
    )
    return r.all_passed
