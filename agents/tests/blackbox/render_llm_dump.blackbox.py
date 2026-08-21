"""Blackbox tests for the local LLM dump HTML renderer."""

import importlib.util
import json
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

        html = renderer.render_output_section(
            {
                "call_site": "browser_use_step_4",
                "output": {"action": {"action": "click", "index": 7}},
                "extra": {
                    "browser_recording_manifest_path": str(manifest_path),
                    "iteration": 4,
                },
            }
        )

    assert "Browser Recording" in html
    assert "Defaulted to click for step 4 at 1.2s" in html
    assert "frame_00002.jpg" in html
    assert "cursorByFrame" in html
    assert 'value="1"' in html
    assert "<option selected>4</option>" in html


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
        )

    assert "Browser Recording" in html
    assert "recording-player" in html
    assert "data-canvas" in html
    assert "open standalone" in html
    assert "Proxy City" in html
    assert "DALLAS" in html


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
        html_path.write_text(
            '<html><img src="llm_dump_browser_use_step_24_assets/shot.png"></html>',
            encoding="utf-8",
        )
        (assets_dir / "shot.png").write_bytes(b"png-bytes")

        published = renderer.publish_rendered_dump(html_path, artifacts_dir)

        assert published == artifacts_dir / "llm_dump_browser_use_step_24.html"
        assert published is not None
        assert published.read_text(encoding="utf-8") == html_path.read_text(encoding="utf-8")
        copied_asset = artifacts_dir / "llm_dump_browser_use_step_24_assets" / "shot.png"
        assert copied_asset.read_bytes() == b"png-bytes"
        assert renderer.publish_rendered_dump(html_path, Path(tmp) / "missing") is None


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
    return r.all_passed
