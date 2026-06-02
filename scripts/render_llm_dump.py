#!/usr/bin/env python3
"""Render an .llm-dumps JSON file as human-readable HTML."""

from __future__ import annotations

import argparse
import base64
import html
import json
import re
import webbrowser
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCREENSHOT_KEYS = {"screenshot", "image", "png", "jpeg", "jpg"}
DEFAULT_OUTPUT_DIR = Path(".context/rendered-llm-dumps")
SYSTEM_PROMPT_BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__"
AVAILABLE_ACTIONS_HEADING = "# Available Actions"
NEXT_SYSTEM_HEADING_RE = re.compile(r"\n# (?!Available Actions\b)")
ATTACHMENT_PATH_RE = re.compile(r"((?:\.context|/\S*?\.context)/attachments/[^\s`<>\]]+)")
BROWSER_STATE_HEADING = "# Current Browser State"
SCREENSHOT_TOOL_SECTION_RE = re.compile(r"\n?# Screenshot Tool\n.*?(?=\n# |\Z)", re.S)
TOKEN_ENCODINGS: dict[str, Any] = {}


def escape(value: Any) -> str:
    return html.escape(str(value), quote=True)


def slug(value: Any) -> str:
    text = re.sub(r"[^a-zA-Z0-9_.-]+", "-", str(value)).strip("-")
    return text or "llm-dump"


def looks_like_base64_image(value: Any) -> bool:
    if not isinstance(value, str) or len(value) < 128:
        return False
    if value.startswith("data:image/"):
        return True
    if value.startswith(("iVBOR", "/9j/", "R0lGOD")):
        return True
    return False


def image_data_uri(value: str) -> str:
    if value.startswith("data:image/"):
        return value
    if value.startswith("/9j/"):
        mime = "image/jpeg"
    elif value.startswith("R0lGOD"):
        mime = "image/gif"
    else:
        mime = "image/png"
    return f"data:{mime};base64,{value}"


def split_image_data(value: str) -> tuple[str, bytes]:
    if value.startswith("data:image/"):
        header, payload = value.split(",", 1)
        mime = header.removeprefix("data:").split(";", 1)[0]
    elif value.startswith("/9j/"):
        mime = "image/jpeg"
        payload = value
    elif value.startswith("R0lGOD"):
        mime = "image/gif"
        payload = value
    else:
        mime = "image/png"
        payload = value
    return mime, base64.b64decode(payload)


def image_extension(mime: str) -> str:
    if mime == "image/jpeg":
        return ".jpg"
    if mime == "image/gif":
        return ".gif"
    return ".png"


def write_image_asset(output_path: Path, name: str, image: str) -> Path | str:
    assets_dir = output_path.with_suffix("")
    assets_dir = assets_dir.parent / f"{assets_dir.name}_assets"
    assets_dir.mkdir(parents=True, exist_ok=True)
    mime, image_bytes = split_image_data(image)
    image_path = assets_dir / f"{slug(name)}{image_extension(mime)}"
    image_path.write_bytes(image_bytes)
    return image_path.relative_to(output_path.parent)


def sanitize_json(value: Any, key: str | None = None) -> Any:
    if isinstance(value, dict):
        return {k: sanitize_json(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [sanitize_json(item, key) for item in value]
    if key and key.lower() in SCREENSHOT_KEYS and looks_like_base64_image(value):
        return f"[{key} omitted; rendered as an image]"
    if isinstance(value, str) and looks_like_base64_image(value):
        return "[base64 image omitted; rendered as an image]"
    return value


def render_json(value: Any) -> str:
    cleaned = sanitize_json(value)
    return (
        "<pre><code>"
        + escape(json.dumps(cleaned, indent=2, sort_keys=True, default=str))
        + "</code></pre>"
    )


def token_encoder() -> Any | None:
    for encoding_name in ("o200k_base", "cl100k_base"):
        if encoding_name in TOKEN_ENCODINGS:
            return TOKEN_ENCODINGS[encoding_name]
        try:
            import tiktoken  # type: ignore[import-not-found]

            encoding = tiktoken.get_encoding(encoding_name)
            TOKEN_ENCODINGS[encoding_name] = encoding
            return encoding
        except Exception:
            continue
    return None


def token_count(value: Any) -> int:
    text = str(value or "")
    encoder = token_encoder()
    if encoder is None:
        return max(1, len(text) // 4) if text else 0
    return len(encoder.encode(text))


def token_badge(count: int, label: str = "tokens") -> str:
    return f'<span class="token-badge">{escape(count)} {escape(label)}</span>'


def message_token_text(message: dict[str, Any]) -> str:
    return json.dumps(sanitize_json(message), sort_keys=True, default=str)


def render_inline_markdown(text: str) -> str:
    escaped = escape(text)
    escaped = re.sub(r"`([^`]+)`", r"<code>\1</code>", escaped)
    escaped = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", escaped)
    escaped = ATTACHMENT_PATH_RE.sub(replace_attachment_path_with_chip, escaped)
    escaped = re.sub(
        r"(https?://[^\s<]+)",
        r'<a href="\1" target="_blank" rel="noreferrer">\1</a>',
        escaped,
    )
    return escaped


def split_trailing_punctuation(value: str) -> tuple[str, str]:
    trailing = ""
    while value and value[-1] in ".,;:)":
        trailing = value[-1] + trailing
        value = value[:-1]
    return value, trailing


def attachment_chip(path: str) -> str:
    label = Path(path).name or path
    return (
        f'<span class="attachment-chip" title="{escape(path)}">'
        '<span class="attachment-chip-kind">attachment</span>'
        f'<span class="attachment-chip-name">{escape(label)}</span>'
        "</span>"
    )


def replace_attachment_path_with_chip(match: re.Match[str]) -> str:
    path, trailing = split_trailing_punctuation(match.group(1))
    return attachment_chip(path) + escape(trailing)


def render_code_or_attachment_block(code_lines: list[str]) -> str:
    code = "\n".join(code_lines)
    non_empty = [line.strip() for line in code_lines if line.strip()]
    if non_empty and all(ATTACHMENT_PATH_RE.fullmatch(line) for line in non_empty):
        chips = "".join(attachment_chip(line) for line in non_empty)
        return f'<div class="attachment-chip-row">{chips}</div>'
    return "<pre><code>" + escape(code) + "</code></pre>"


def render_list_entries(entries: list[tuple[int, str]]) -> str:
    def parse_level(start: int, indent: int) -> tuple[str, int]:
        parts = ["<ul>"]
        index = start
        while index < len(entries):
            item_indent, item_text = entries[index]
            if item_indent < indent:
                break
            if item_indent > indent:
                nested_html, index = parse_level(index, item_indent)
                parts.append(nested_html)
                continue

            parts.append(f"<li>{render_inline_markdown(item_text)}")
            index += 1
            while index < len(entries) and entries[index][0] > indent:
                nested_html, index = parse_level(index, entries[index][0])
                parts.append(nested_html)
            parts.append("</li>")
        parts.append("</ul>")
        return "".join(parts), index

    if not entries:
        return ""
    html_text, _ = parse_level(0, entries[0][0])
    return html_text


def text_content(value: Any) -> str:
    if isinstance(value, list):
        parts: list[str] = []
        for block in value:
            if isinstance(block, dict) and isinstance(block.get("text"), str):
                parts.append(block["text"])
            elif not isinstance(block, dict):
                parts.append(str(block))
        return "\n".join(parts)
    return str(value or "")


def contains_browser_state(value: Any) -> bool:
    text = text_content(value)
    return BROWSER_STATE_HEADING in text and "<page_stats>" in text


def split_browser_state_text(text: str) -> tuple[str, str | None]:
    start = text.find(BROWSER_STATE_HEADING)
    if start < 0:
        return text, None
    return text[:start].rstrip(), text[start:].strip()


def render_browser_state_text(state_text: str) -> str:
    page_stats_match = re.search(r"<page_stats>(.*?)</page_stats>", state_text, re.S)
    page_stats = page_stats_match.group(1).strip() if page_stats_match else ""

    current_url_match = re.search(r"^Current URL:\s*(.*)$", state_text, re.M)
    viewport_match = re.search(r"^Viewport:\s*(.*)$", state_text, re.M)
    scroll_match = re.search(r"^Scroll:\s*(.*)$", state_text, re.M)

    tabs = ""
    tabs_match = re.search(r"^Open Tabs:\n(.*?)(?=^Interactive elements:)", state_text, re.S | re.M)
    if tabs_match:
        tabs = tabs_match.group(1).strip()

    dom_tree = ""
    previous_actions = ""
    dom_match = re.search(r"^Interactive elements:\n(.*)$", state_text, re.S | re.M)
    if dom_match:
        dom_and_actions = dom_match.group(1).strip()
        previous_actions_marker = "\n\nPrevious Actions:\n"
        if previous_actions_marker in dom_and_actions:
            dom_tree, previous_actions = dom_and_actions.split(previous_actions_marker, 1)
            dom_tree = dom_tree.strip()
            previous_actions = previous_actions.strip()
        else:
            dom_tree = dom_and_actions

    meta = "".join(
        [
            render_kv("URL", current_url_match.group(1).strip() if current_url_match else None),
            render_kv("Viewport", viewport_match.group(1).strip() if viewport_match else None),
            render_kv("Scroll", scroll_match.group(1).strip() if scroll_match else None),
        ]
    )

    body_parts = []
    if meta:
        body_parts.append(f'<dl class="meta-grid compact-meta">{meta}</dl>')
    if page_stats:
        body_parts.append(
            '<details class="panel nested-panel"><summary>Page Stats '
            + token_badge(token_count(page_stats))
            + "</summary>"
            f"<pre><code>{escape(page_stats)}</code></pre></details>"
        )
    if tabs:
        body_parts.append(
            '<details class="panel nested-panel"><summary>Tabs '
            + token_badge(token_count(tabs))
            + "</summary>"
            f"<pre><code>{escape(tabs)}</code></pre></details>"
        )
    if dom_tree:
        body_parts.append(
            '<details class="panel nested-panel"><summary>DOM Tree '
            + token_badge(token_count(dom_tree))
            + "</summary>"
            f"<pre><code>{escape(dom_tree)}</code></pre></details>"
        )
    if previous_actions:
        body_parts.append(
            '<details class="panel nested-panel"><summary>Previous Actions '
            + token_badge(token_count(previous_actions))
            + "</summary>"
            f"<pre><code>{escape(previous_actions)}</code></pre></details>"
        )

    return (
        '<section class="browser-state-block">'
        "<h4>Current Browser State</h4>"
        '<div class="browser-state-body">'
        + "\n".join(body_parts)
        + "</div></section>"
    )


def render_browser_state_aware_markdown(text: str) -> str:
    prefix, state_text = split_browser_state_text(text)
    if not state_text:
        return render_basic_markdown(text)
    parts = []
    if prefix.strip():
        parts.append(render_basic_markdown(prefix))
    parts.append(render_browser_state_text(state_text))
    return "\n".join(parts)


def render_basic_markdown(text: Any) -> str:
    if text is None:
        return ""
    lines = str(text).splitlines()
    blocks: list[str] = []
    paragraph: list[str] = []
    list_items: list[tuple[int, str]] = []
    in_code = False
    code_lines: list[str] = []

    def flush_paragraph() -> None:
        nonlocal paragraph
        if paragraph:
            body = " ".join(line.strip() for line in paragraph)
            blocks.append(f"<p>{render_inline_markdown(body)}</p>")
            paragraph = []

    def flush_list() -> None:
        nonlocal list_items
        if list_items:
            blocks.append(render_list_entries(list_items))
            list_items = []

    for line in lines:
        stripped = line.strip()

        if stripped.startswith("```"):
            if in_code:
                blocks.append(render_code_or_attachment_block(code_lines))
                code_lines = []
                in_code = False
            else:
                flush_paragraph()
                flush_list()
                in_code = True
            continue

        if in_code:
            code_lines.append(line)
            continue

        if not stripped:
            flush_paragraph()
            flush_list()
            continue

        heading = re.match(r"^(#{1,6})\s+(.+)$", stripped)
        if heading:
            flush_paragraph()
            flush_list()
            level = min(len(heading.group(1)) + 1, 6)
            blocks.append(f"<h{level}>{render_inline_markdown(heading.group(2))}</h{level}>")
            continue

        bullet = re.match(r"^(\s*)[-*]\s+(.+)$", line)
        if bullet:
            flush_paragraph()
            indent = len(bullet.group(1).expandtabs(2))
            list_items.append((indent, bullet.group(2)))
            continue

        flush_list()
        paragraph.append(line)

    if in_code:
        blocks.append(render_code_or_attachment_block(code_lines))
    flush_paragraph()
    flush_list()
    return "\n".join(blocks)


def render_markdown(text: Any) -> str:
    if text is None:
        return ""
    return render_browser_state_aware_markdown(str(text))


def _format_compact_mapping(value: dict[str, Any]) -> list[str]:
    lines: list[str] = []
    for key, item in value.items():
        if isinstance(item, (dict, list)):
            rendered = json.dumps(item, ensure_ascii=False, default=str)
        else:
            rendered = str(item)
        lines.append(f"- {key}: {rendered}")
    return lines


def normalize_inline_structured_sections(text: str) -> str:
    """Normalize legacy inline schema/result blocks in message text.

    `Output Schema` is not result data, so it is dropped from message bodies.
    Actual structured values are rendered as compact key/value rows.
    """
    markers = ("Output Schema:", "Structured Response:")
    if not any(marker in text for marker in markers):
        return text

    lines: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        matched_marker = next((marker for marker in markers if stripped.startswith(marker)), None)
        if matched_marker is None:
            lines.append(line)
            continue

        raw_value = stripped[len(matched_marker):].strip()
        if not raw_value:
            if matched_marker == "Structured Response:":
                lines.append(line)
            continue

        try:
            parsed = json.loads(raw_value)
        except Exception:
            if matched_marker == "Structured Response:":
                lines.append(line)
            continue

        if matched_marker == "Output Schema:":
            continue

        if not isinstance(parsed, dict):
            lines.append(line)
            continue

        lines.append("Structured Response:")
        lines.extend(_format_compact_mapping(parsed))

    return "\n".join(lines)


def render_kv(label: str, value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        rendered = "true" if value else "false"
    elif isinstance(value, list):
        rendered = ", ".join(str(item) for item in value)
    elif isinstance(value, dict):
        rendered = json.dumps(value, default=str)
    else:
        rendered = str(value)
    return f"<div class=\"kv\"><dt>{escape(label)}</dt><dd>{escape(rendered)}</dd></div>"


def render_kv_html(label: str, value_html: str | None) -> str:
    if value_html is None:
        return ""
    return f'<div class="kv"><dt>{escape(label)}</dt><dd>{value_html}</dd></div>'


def collapsible_section(title: str, body: str, is_open: bool = True) -> str:
    open_attr = " open" if is_open else ""
    return (
        f"<details class=\"panel section-panel\"{open_attr}>"
        f"<summary>{escape(title)}</summary>"
        f"<div class=\"section-body\">{body}</div>"
        "</details>"
    )


def maybe_parse_json_string(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    stripped = value.strip()
    if not stripped or stripped[0] not in "{[":
        return value
    try:
        return json.loads(stripped)
    except Exception:
        return value


def render_output_value(value: Any) -> str:
    value = maybe_parse_json_string(value)
    if isinstance(value, (dict, list)):
        return render_json(value)
    return f'<div class="markdown readable-content">{render_markdown(value)}</div>'


def output_action_name(data: dict[str, Any]) -> str | None:
    for candidate in (data.get("output"), (data.get("extra") or {}).get("output")):
        if not isinstance(candidate, dict):
            continue
        action = candidate.get("action")
        if isinstance(action, dict) and action.get("action"):
            return str(action["action"])
    return None


def output_iteration(data: dict[str, Any]) -> int | None:
    extra = data.get("extra") or {}
    value = extra.get("iteration")
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    call_site = str(data.get("call_site") or "")
    match = re.search(r"browser_use_step_(\d+)", call_site)
    return int(match.group(1)) if match else None


def recording_search_roots(source_path: Path | None = None) -> list[Path]:
    roots: list[Path] = []

    def add(path: Path) -> None:
        resolved = path.expanduser().resolve()
        if resolved not in roots:
            roots.append(resolved)

    add(Path(".context/browser-agent-recordings"))
    if source_path:
        try:
            resolved_source = source_path.expanduser().resolve()
            for parent in (resolved_source.parent, *resolved_source.parents):
                candidate = parent / ".context/browser-agent-recordings"
                if candidate.exists():
                    add(candidate)
        except Exception:
            pass
    return roots


def dump_contains_browser_context(data: dict[str, Any]) -> bool:
    call_site = str(data.get("call_site") or "")
    extra = data.get("extra") if isinstance(data.get("extra"), dict) else {}
    return (
        call_site.startswith("browser_use")
        or bool(extra.get("browser_state"))
        or bool(extra.get("action_history"))
    )


def score_recording_manifest(data: dict[str, Any], manifest_path: Path) -> tuple[int, float]:
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        return (-1, 0.0)

    haystack = json.dumps(data, default=str)
    score = 0
    for key, weight in (("task_id", 100), ("session_id", 80), ("browser_url", 60)):
        value = manifest.get(key)
        if value and str(value) in haystack:
            score += weight

    iteration = output_iteration(data)
    action_name = output_action_name(data)
    frames = manifest.get("frames") if isinstance(manifest.get("frames"), list) else []
    for frame in frames:
        if not isinstance(frame, dict):
            continue
        metadata = frame.get("metadata") if isinstance(frame.get("metadata"), dict) else {}
        if iteration is not None and (
            metadata.get("step") == iteration or str(metadata.get("step")) == str(iteration)
        ):
            score += 20
        if action_name and (frame.get("action") == action_name or metadata.get("action") == action_name):
            score += 5

    return (score, manifest_path.stat().st_mtime if manifest_path.exists() else 0.0)


def discover_browser_recording_manifest(
    data: dict[str, Any],
    source_path: Path | None = None,
) -> Path | None:
    if not dump_contains_browser_context(data):
        return None
    agent_id = data.get("agent_id")
    if not agent_id:
        return None

    manifests: list[Path] = []
    for root in recording_search_roots(source_path):
        agent_dir = root / str(agent_id)
        if agent_dir.exists():
            manifests.extend(agent_dir.glob("*/manifest.json"))

    if not manifests:
        return None
    if len(manifests) == 1:
        return manifests[0]

    scored = sorted(
        ((score_recording_manifest(data, manifest), manifest) for manifest in manifests),
        key=lambda item: item[0],
        reverse=True,
    )
    best_score, best_manifest = scored[0]
    if best_score[0] < 0:
        return None
    return best_manifest


def browser_recording_manifest_path(
    data: dict[str, Any],
    source_path: Path | None = None,
) -> Path | None:
    extra = data.get("extra") or {}
    path = extra.get("browser_recording_manifest_path")
    if not path and extra.get("browser_recording_path"):
        path = str(Path(str(extra["browser_recording_path"])).with_name("manifest.json"))
    if not path:
        return discover_browser_recording_manifest(data, source_path)
    return Path(str(path)).expanduser()


def select_recording_default_index(
    frames: list[dict[str, Any]],
    *,
    action_name: str | None,
    iteration: int | None,
) -> int:
    def matches_step(frame: dict[str, Any]) -> bool:
        if iteration is None:
            return False
        metadata = frame.get("metadata") if isinstance(frame.get("metadata"), dict) else {}
        return metadata.get("step") == iteration or str(metadata.get("step")) == str(iteration)

    def matches_action(frame: dict[str, Any]) -> bool:
        if not action_name:
            return False
        metadata = frame.get("metadata") if isinstance(frame.get("metadata"), dict) else {}
        return frame.get("action") == action_name or metadata.get("action") == action_name

    for index, frame in enumerate(frames):
        metadata = frame.get("metadata") if isinstance(frame.get("metadata"), dict) else {}
        if matches_step(frame) and matches_action(frame) and metadata.get("phase") == "start":
            return index
    for index, frame in enumerate(frames):
        if matches_step(frame) and matches_action(frame):
            return index
    for index, frame in enumerate(frames):
        if matches_action(frame):
            return index
    return 0


def load_recording_frames(manifest_path: Path) -> tuple[dict[str, Any], list[dict[str, Any]], str | None]:
    if not manifest_path.exists():
        return {}, [], f"Recording manifest was not found: {manifest_path}"

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return {}, [], f"Could not read recording manifest {manifest_path}: {exc}"

    raw_frames = manifest.get("frames")
    if not isinstance(raw_frames, list) or not raw_frames:
        return manifest, [], None

    frames: list[dict[str, Any]] = []
    for frame in raw_frames:
        if not isinstance(frame, dict) or not frame.get("src"):
            continue
        cloned = dict(frame)
        src_path = manifest_path.parent / str(frame["src"])
        cloned["src"] = src_path.resolve().as_uri()
        frames.append(cloned)
    return manifest, frames, None


def render_browser_session_metadata(metadata: Any) -> str:
    if not isinstance(metadata, dict) or not metadata:
        return ""

    location = metadata.get("proxy_location") or metadata.get("proxyLocation") or {}
    if not isinstance(location, dict):
        location = {}

    rows: list[tuple[str, Any]] = [
        ("Provider", metadata.get("provider")),
        ("Proxy Source", metadata.get("proxy_source") or metadata.get("proxySource")),
        ("Proxy City", location.get("city")),
        ("Proxy State", location.get("state")),
        ("Proxy Country", location.get("country")),
    ]
    present = [(label, value) for label, value in rows if value not in (None, "", {})]
    if not present:
        return ""

    row_html = "\n".join(
        f"<tr><th>{escape(label)}</th><td>{escape(value)}</td></tr>" for label, value in present
    )
    return f"""
        <table class="recording-meta">
          <tbody>
            {row_html}
          </tbody>
        </table>
    """


def render_browser_recording_player_from_manifest(
    manifest_path: Path,
    *,
    action_name: str | None = None,
    iteration: int | None = None,
    player_seed: str = "",
    section_class: str = "output-primary browser-recording",
    default_to_last: bool = False,
    browser_session_metadata: Any = None,
) -> str:
    manifest, frames, error = load_recording_frames(manifest_path)
    if error:
        return (
            f'<section class="{escape(section_class)}">'
            "<h3>Browser Recording</h3>"
            f'<p class="muted">{escape(error)}</p>'
            "</section>"
        )
    if not frames:
        return ""

    default_index = select_recording_default_index(frames, action_name=action_name, iteration=iteration)
    if default_to_last and action_name is None and iteration is None:
        default_index = len(frames) - 1
    default_frame = frames[default_index]
    player_id = slug(f"browser-recording-{manifest_path}-{player_seed}")
    frames_json = json.dumps(frames)
    default_ts = float(default_frame.get("ts_ms") or 0) / 1000
    action_label = action_name or "browser action"
    iteration_label = f"step {iteration}" if iteration is not None else "this dump"
    metadata_html = render_browser_session_metadata(
        browser_session_metadata or manifest.get("browser_session_metadata")
    )

    return f"""
      <section class="{escape(section_class)}">
        <h3>Browser Recording</h3>
        <p class="section-summary">
          Defaulted to {escape(action_label)} for {escape(iteration_label)} at {default_ts:.1f}s.
          Full local replay: <a href="{escape((manifest_path.parent / 'index.html').resolve().as_uri())}" target="_blank" rel="noreferrer">open standalone</a>
        </p>
        {metadata_html}
        <div class="recording-player" id="{escape(player_id)}">
          <div class="recording-controls">
            <button type="button" data-play>Play</button>
            <label>Speed <select data-speed><option>1</option><option>2</option><option selected>4</option><option>8</option></select>x</label>
            <label><input type="checkbox" data-skip-idle checked> skip idle</label>
            <input type="range" min="0" max="{escape(len(frames) - 1)}" value="{escape(default_index)}" data-timeline>
            <span data-time></span>
          </div>
          <canvas data-canvas></canvas>
        </div>
        <script>
        (() => {{
          const root = document.getElementById({json.dumps(player_id)});
          if (!root) return;
          const frames = {frames_json};
          const canvas = root.querySelector('[data-canvas]');
          const ctx = canvas.getContext('2d');
          const playBtn = root.querySelector('[data-play]');
          const speed = root.querySelector('[data-speed]');
          const skipIdle = root.querySelector('[data-skip-idle]');
          const timeline = root.querySelector('[data-timeline]');
          const time = root.querySelector('[data-time]');
          const images = frames.map(f => {{ const img = new Image(); img.src = f.src; return img; }});
          let idx = {default_index}, playing = false, timer = null;
          function normalizeCursor(cursor) {{
            if (!cursor || cursor.x == null || cursor.y == null) return null;
            const x = Number(cursor.x), y = Number(cursor.y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
            return {{ x, y }};
          }}
          function frameCursor(frame) {{
            return normalizeCursor(frame.cursor)
              || normalizeCursor(frame.metadata && frame.metadata.cursor)
              || normalizeCursor(frame.metadata && frame.metadata.coordinates);
          }}
          const firstCursor = frames.map(frameCursor).find(Boolean) || null;
          const cursorByFrame = [];
          let lastCursor = firstCursor;
          frames.forEach(frame => {{
            const nextCursor = frameCursor(frame);
            if (nextCursor) lastCursor = nextCursor;
            cursorByFrame.push(lastCursor);
          }});
          function duration(i) {{
            if (i >= frames.length - 1) return 500;
            let d = Math.max(100, (frames[i + 1].ts_ms || 0) - (frames[i].ts_ms || 0));
            if (skipIdle.checked) d = Math.min(d, 1500);
            return d / Number(speed.value || 1);
          }}
          function drawCursor(cursor) {{
            if (!cursor) return;
            ctx.save();
            ctx.translate(cursor.x || 0, cursor.y || 0);
            ctx.fillStyle = 'rgba(255,255,255,.95)';
            ctx.strokeStyle = 'rgba(0,0,0,.85)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(0, 0); ctx.lineTo(0, 22); ctx.lineTo(6, 17); ctx.lineTo(10, 28); ctx.lineTo(15, 26); ctx.lineTo(11, 15); ctx.lineTo(20, 15); ctx.closePath();
            ctx.fill(); ctx.stroke();
            ctx.restore();
          }}
          function render(i) {{
            idx = Math.max(0, Math.min(frames.length - 1, i));
            const frame = frames[idx];
            const img = images[idx];
            const paint = () => {{
              canvas.width = img.naturalWidth || 1280;
              canvas.height = img.naturalHeight || 800;
              ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
              drawCursor(cursorByFrame[idx]);
              ctx.fillStyle = 'rgba(0,0,0,.72)';
              ctx.fillRect(0, canvas.height - 54, canvas.width, 54);
              ctx.fillStyle = '#fff';
              ctx.font = '18px system-ui, sans-serif';
              ctx.fillText(`${{frame.action || 'frame'}}: ${{frame.label || ''}}`, 14, canvas.height - 22);
              timeline.value = idx;
              time.textContent = `${{((frame.ts_ms || 0) / 1000).toFixed(1)}}s / frame ${{idx + 1}} of ${{frames.length}}`;
            }};
            if (img.complete) paint(); else img.onload = paint;
          }}
          function tick() {{
            if (!playing) return;
            render(idx);
            if (idx >= frames.length - 1) {{ playing = false; playBtn.textContent = 'Play'; return; }}
            const delay = duration(idx);
            idx += 1;
            timer = setTimeout(tick, delay);
          }}
          playBtn.onclick = () => {{
            playing = !playing;
            playBtn.textContent = playing ? 'Pause' : 'Play';
            clearTimeout(timer);
            if (playing) tick();
          }};
          timeline.oninput = event => {{
            playing = false;
            playBtn.textContent = 'Play';
            clearTimeout(timer);
            render(Number(event.target.value));
          }};
          render(idx);
        }})();
        </script>
      </section>
    """


def render_browser_recording_player(data: dict[str, Any], source_path: Path | None = None) -> str:
    manifest_path = browser_recording_manifest_path(data, source_path)
    if not manifest_path:
        return ""
    extra = data.get("extra") if isinstance(data.get("extra"), dict) else {}
    return render_browser_recording_player_from_manifest(
        manifest_path,
        action_name=output_action_name(data),
        iteration=output_iteration(data),
        player_seed=str(data.get("call_site") or ""),
        browser_session_metadata=extra.get("browser_session_metadata"),
    )


def parse_message_timestamp_epoch(message: dict[str, Any]) -> float | None:
    content = str(message.get("content") or "")
    match = re.match(r"^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]", content)
    if not match:
        return None
    try:
        # Provider-context timestamps are UTC minute stamps in current dumps.
        return datetime.strptime(match.group(1), "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc).timestamp()
    except Exception:
        return None


def manifest_index_path(manifest_path: Path) -> Path:
    return manifest_path.parent / "index.html"


def recording_manifest_summary(manifest_path: Path) -> dict[str, Any]:
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        manifest = {}
    index_path = manifest_index_path(manifest_path)
    return {
        "task_id": manifest.get("task_id") or manifest_path.parent.name,
        "session_id": manifest.get("session_id"),
        "frame_count": manifest.get("frame_count") or len(manifest.get("frames") or []),
        "index_path": index_path,
        "manifest_path": manifest_path,
    }


def recording_manifest_for_tool_message(
    message: dict[str, Any],
    data: dict[str, Any],
    source_path: Path | None = None,
) -> Path | None:
    metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
    explicit_path = metadata.get("recording_path") or metadata.get("browser_recording_path")
    if explicit_path:
        index_path = Path(str(explicit_path)).expanduser()
        manifest_path = index_path.with_name("manifest.json") if index_path.name == "index.html" else index_path
        if manifest_path.exists():
            return manifest_path

    task_id = metadata.get("task_id") or metadata.get("subAgentId")
    agent_id = data.get("agent_id")
    manifests: list[Path] = []
    for root in recording_search_roots(source_path):
        if task_id and agent_id:
            candidate = root / str(agent_id) / str(task_id) / "manifest.json"
            if candidate.exists():
                return candidate
        if agent_id:
            agent_dir = root / str(agent_id)
            if agent_dir.exists():
                manifests.extend(agent_dir.glob("*/manifest.json"))

    if not manifests:
        return None

    message_epoch = parse_message_timestamp_epoch(message)
    if message_epoch is None:
        return max(manifests, key=lambda path: manifest_index_path(path).stat().st_mtime)

    def score(manifest_path: Path) -> tuple[int, float, float]:
        index_path = manifest_index_path(manifest_path)
        mtime = index_path.stat().st_mtime if index_path.exists() else manifest_path.stat().st_mtime
        delta = abs(mtime - message_epoch)
        # Result messages are minute-granular and are usually posted shortly after
        # the recording is saved, so prefer recordings in that minute window.
        in_result_minute_window = message_epoch <= mtime <= message_epoch + 90
        return (0 if in_result_minute_window else 1, delta, -mtime)

    return min(manifests, key=score)


def render_browser_recording_for_tool_message(
    message: dict[str, Any],
    data: dict[str, Any],
    source_path: Path | None = None,
    message_index: int | None = None,
) -> str:
    if message.get("role") != "tool":
        return ""
    tool_name = message.get("name") or (message.get("metadata") or {}).get("toolName")
    if tool_name != "spawn_browser_agent":
        return ""
    if "Browser automation complete" not in str(message.get("content") or ""):
        return ""

    manifest_path = recording_manifest_for_tool_message(message, data, source_path)
    if not manifest_path:
        return ""

    if not manifest_index_path(manifest_path).exists():
        return ""

    return render_browser_recording_player_from_manifest(
        manifest_path,
        player_seed=f"message-{message_index or 0}-{message.get('tool_call_id') or ''}",
        section_class="message-recording browser-recording",
        default_to_last=True,
        browser_session_metadata=(message.get("metadata") or {}).get("browser_session_metadata"),
    )


def render_output_section(data: dict[str, Any], source_path: Path | None = None) -> str:
    extra = data.get("extra") or {}
    candidates = [
        ("Output", extra.get("output")),
        ("Reasoning", extra.get("reasoning")),
        ("Tool Calls", extra.get("tool_calls")),
        ("Error", extra.get("error")),
        ("Top-level Output", data.get("output")),
        ("Result", data.get("result")),
        ("Response", data.get("response")),
    ]
    present = [(label, value) for label, value in candidates if value not in (None, "", [])]
    if not present:
        return '<p class="muted">No model output or result was present in this dump.</p>'

    sections: list[str] = []
    for index, (label, value) in enumerate(present):
        body = render_output_value(value)
        if index == 0:
            sections.append(f'<section class="output-primary"><h3>{escape(label)}</h3>{body}</section>')
            recording_player = render_browser_recording_player(data, source_path)
            if recording_player:
                sections.append(recording_player)
        else:
            sections.append(
                f'<details class="panel nested-panel"><summary>{escape(label)}</summary>{body}</details>'
            )
    return "\n".join(sections)


def find_usage(data: dict[str, Any]) -> dict[str, Any]:
    output = data.get("output") if isinstance(data.get("output"), dict) else {}
    extra = data.get("extra") if isinstance(data.get("extra"), dict) else {}
    extra_output = extra.get("output") if isinstance(extra.get("output"), dict) else {}
    for candidate in (output.get("usage"), extra_output.get("usage"), data.get("usage")):
        if isinstance(candidate, dict):
            return candidate
    return {}


def numeric_usage_value(usage: dict[str, Any], *keys: str) -> int:
    for key in keys:
        value = usage.get(key)
        if isinstance(value, (int, float)):
            return int(value)
    return 0


def token_bar(label: str, value: int, denominator: int, detail: str) -> str:
    pct = (value / denominator * 100) if denominator else 0
    pct = max(0, min(100, pct))
    return f"""
      <div class="token-cell">
        <div class="token-row-head">
          <span>{escape(label)}</span>
          <span>{escape(value)} tokens · {pct:.1f}%</span>
        </div>
        <div class="token-bar"><span style="width: {pct:.2f}%"></span></div>
        <div class="token-detail">{escape(detail)}</div>
      </div>
    """


def token_value(label: str, value: int, detail: str) -> str:
    return f"""
      <div class="token-cell">
        <div class="token-row-head">
          <span>{escape(label)}</span>
          <span>{escape(value)} tokens</span>
        </div>
        <div class="token-detail">{escape(detail)}</div>
      </div>
    """


def find_timing(data: dict[str, Any]) -> dict[str, Any]:
    output = data.get("output") if isinstance(data.get("output"), dict) else {}
    extra = data.get("extra") if isinstance(data.get("extra"), dict) else {}
    extra_output = extra.get("output") if isinstance(extra.get("output"), dict) else {}
    for candidate in (output.get("timing"), extra_output.get("timing"), data.get("timing")):
        if isinstance(candidate, dict):
            return candidate
    return {}


def render_seconds(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return f"{value:.3f}s"
    return str(value)


def timing_overview_rows(data: dict[str, Any]) -> str:
    timing = find_timing(data)
    if not timing:
        return ""
    first_contentful = (
        timing.get("first_contentful_token_s")
        if "first_contentful_token_s" in timing
        else timing.get("ttft_s")
    )
    round_trip = timing.get("round_trip_s") if "round_trip_s" in timing else timing.get("elapsed_s")
    return "".join(
        [
            render_kv("First Contentful Token", render_seconds(first_contentful)),
            render_kv("Round Trip Time", render_seconds(round_trip)),
        ]
    )


def usage_uses_inclusive_input_cache(data: dict[str, Any], usage: dict[str, Any]) -> bool:
    token_used = usage.get("compute_token_used")
    if isinstance(token_used, dict) and token_used.get("type") == "gpt":
        return True
    model = str(data.get("model") or "")
    if model.startswith("gpt-"):
        return True
    output = data.get("output") if isinstance(data.get("output"), dict) else {}
    actual_model = str(output.get("actual_model") or output.get("model") or "")
    return actual_model.endswith("-gpt")


def token_overview_rows(data: dict[str, Any]) -> str:
    usage = find_usage(data)
    if not usage:
        return ""

    input_tokens = numeric_usage_value(usage, "prompt_tokens", "input_tokens")
    output_tokens = numeric_usage_value(usage, "completion_tokens", "output_tokens")
    total_tokens = numeric_usage_value(usage, "total_tokens") or input_tokens + output_tokens
    cache_read = numeric_usage_value(usage, "cache_read_input_tokens", "cache_read_tokens", "cached_tokens")
    cache_write = numeric_usage_value(usage, "cache_creation_input_tokens", "cache_write_tokens")
    if cache_write == 0 and usage_uses_inclusive_input_cache(data, usage):
        cache_write = max(input_tokens - cache_read, 0)

    return "".join(
        [
            render_kv_html(
                "Input Tokens",
                token_value("Input Tokens", input_tokens, "Raw provider input token count."),
            ),
            render_kv_html(
                "Cache Read Input Tokens",
                token_bar("Cache Read Input Tokens", cache_read, input_tokens, "Share of input tokens read from prompt cache."),
            ),
            render_kv_html(
                "Cache Write Input Tokens",
                token_bar("Cache Write Input Tokens", cache_write, input_tokens, "Share of input tokens written to prompt cache."),
            ),
            render_kv("Output Tokens", f"{output_tokens} tokens"),
        ]
    )


def section_token_counts(data: dict[str, Any], messages: list[dict[str, Any]]) -> dict[str, int]:
    system_prompt, dynamic_system_parts, normalized_messages, _ = split_system_prompt_parts(messages)
    config = data.get("config") or {}
    system_prompt = system_prompt or ""
    dynamic_system_prompt = "\n\n".join(dynamic_system_parts)
    tools_payload = (
        data.get("tools")
        or config.get("tools")
        or (config.get("requested_params") if isinstance(config.get("requested_params"), dict) else {}).get("tools")
        or []
    )
    response_schema_payload = data.get("response_format") or config.get("response_format") or config.get("response_model") or ""
    tools_and_schema_payload = {
        "tools": sanitize_json(tools_payload),
        "output_schema": sanitize_json(response_schema_payload),
    }
    messages_payload = [sanitize_json(message) for message in normalized_messages]
    counts = {
        "system_prompt": token_count(system_prompt),
        "dynamic_system_prompt": token_count(dynamic_system_prompt),
        "tools_output_schema": token_count(json.dumps(tools_and_schema_payload, default=str)),
        "messages": token_count(json.dumps(messages_payload, default=str)),
    }
    for idx, part in enumerate(dynamic_system_parts):
        counts[f"dynamic_system_prompt_{idx}"] = token_count(part)
    return counts


def title_with_tokens(title: str, count: int | None) -> str:
    if count is None:
        return title
    return f"{title} ({count} tokens)"


def find_config_value(value: Any, wanted_key_parts: tuple[str, ...]) -> Any:
    if isinstance(value, dict):
        for key, child in value.items():
            lowered = key.lower().replace("-", "_")
            if all(part in lowered for part in wanted_key_parts):
                return child
        for key, child in value.items():
            if key in {"messages", "browser_state", "action_history", "screenshot", "dom_tree"}:
                continue
            found = find_config_value(child, wanted_key_parts)
            if found is not None:
                return found
    elif isinstance(value, list):
        for child in value:
            found = find_config_value(child, wanted_key_parts)
            if found is not None:
                return found
    return None


def prefixed_param_fields(
    prefix: str,
    params: dict[str, Any],
    keys: list[tuple[str, str]],
) -> list[tuple[str, Any]]:
    return [
        (f"{prefix} {label}", params.get(key))
        for label, key in keys
        if key in params and params.get(key) is not None
    ]


def render_token_type(config: dict[str, Any]) -> str:
    mode = config.get("mode")
    actual_model_raw = str(config.get("actual_model_raw") or "")
    direct_auth = config.get("direct_auth") if isinstance(config.get("direct_auth"), dict) else {}
    if mode == "gpt" or actual_model_raw.endswith("-gpt") or direct_auth.get("gpt"):
        return "Codex"
    if mode == "claude" or actual_model_raw.endswith("-claude") or direct_auth.get("claude"):
        return "Claude"
    return "None"


def render_config(data: dict[str, Any]) -> str:
    extra = data.get("extra") or {}
    config = data.get("config") or extra.get("llm_config") or {}
    effective_params = config.get("effective_params") if isinstance(config.get("effective_params"), dict) else {}
    requested_params = config.get("requested_params") if isinstance(config.get("requested_params"), dict) else {}
    available_actions = extra.get("available_actions") or []
    if not available_actions and isinstance(config.get("available_actions"), list):
        available_actions = config["available_actions"]
    browser_state = extra.get("browser_state") or {}
    direct_auth = config.get("direct_auth") if isinstance(config.get("direct_auth"), dict) else {}

    temperament_keys = [
        ("Model", "model"),
        ("Temperature", "temperature"),
        ("Max Tokens", "max_tokens"),
        ("Reasoning Effort", "reasoning_effort"),
        ("Thinking", "thinking"),
        ("Seed", "seed"),
        ("Store", "store"),
        ("Parallel Tool Calls", "parallel_tool_calls"),
        ("Include", "include"),
        ("Stream", "stream"),
    ]

    fields = [
        ("Model", config.get("actual_model") or data.get("model")),
        ("Actual Model Raw", config.get("actual_model_raw")),
        ("Token Type Used", render_token_type(config)),
        ("Pool", config.get("pool") or config.get("pool_name")),
        ("Mode", config.get("mode")),
        ("Call Site", data.get("call_site")),
        ("Agent ID", data.get("agent_id")),
        ("Span ID", data.get("span_id")),
        ("Message Count", data.get("message_count")),
        *prefixed_param_fields("Requested", requested_params, temperament_keys),
        *prefixed_param_fields("Effective", effective_params, temperament_keys),
        ("Tool Choice", config.get("tool_choice") or requested_params.get("tool_choice")),
        ("Include Screenshot", config.get("include_screenshot")),
        ("Deadline Seconds", config.get("deadline_s")),
        ("Direct Auth Claude Token", direct_auth.get("claude_token")),
        ("Direct Auth GPT Token", direct_auth.get("gpt_token")),
        ("Direct Auth GPT Account ID", direct_auth.get("gpt_account_id")),
        ("Iteration", extra.get("iteration")),
        ("Browser Use Mode", extra.get("browser_use_mode")),
        ("Available Actions", len(available_actions) if available_actions else 0),
        ("Browser URL", browser_state.get("url")),
        ("Browser Title", browser_state.get("title")),
    ]
    return "<dl class=\"meta-grid\">" + "".join(render_kv(label, value) for label, value in fields) + "</dl>"


def split_system_prompt_parts(messages: list[dict[str, Any]]) -> tuple[str | None, list[str], list[dict[str, Any]], str | None]:
    normalized: list[dict[str, Any]] = []
    system_parts: list[str] = []
    dynamic_system_parts: list[str] = []
    extraction_note: str | None = None

    for message in messages:
        cloned = dict(message)
        role = cloned.get("role")
        content = str(cloned.get("content", ""))
        if role == "system":
            target_parts = system_parts if not system_parts else dynamic_system_parts
            if SYSTEM_PROMPT_BOUNDARY in content:
                parts = content.split(SYSTEM_PROMPT_BOUNDARY)
                if parts[0].strip():
                    target_parts.append(parts[0].strip())
                dynamic_system_parts.extend(part.strip() for part in parts[1:] if part.strip())
            else:
                target_parts.append(content)
            continue
        if SYSTEM_PROMPT_BOUNDARY in content:
            system_prompt, remaining = content.split(SYSTEM_PROMPT_BOUNDARY, 1)
            system_parts.append(system_prompt.strip())
            cloned["content"] = remaining.strip()
            extraction_note = (
                "Legacy synthetic dump: no standalone role=system message was recorded in this dump, "
                f"so this section was extracted from the first message before {SYSTEM_PROMPT_BOUNDARY}. "
                "This means the dump file was not the exact provider messages array; new browser-use dumps "
                "record the real role=system message separately."
            )
        normalized.append(cloned)

    system_prompt_text = "\n\n".join(part for part in system_parts if part)
    if system_prompt_text and SYSTEM_PROMPT_BOUNDARY in system_prompt_text:
        parts = system_prompt_text.split(SYSTEM_PROMPT_BOUNDARY)
        static_system = parts[0]
        dynamic_system_parts = [*dynamic_system_parts, *(part.strip() for part in parts[1:] if part.strip())]
        return static_system.strip() or None, dynamic_system_parts, normalized, extraction_note
    return system_prompt_text or None, dynamic_system_parts, normalized, extraction_note


def split_system_prompt(messages: list[dict[str, Any]]) -> tuple[str | None, str | None, list[dict[str, Any]], str | None]:
    system_prompt_text, dynamic_system_parts, normalized, extraction_note = split_system_prompt_parts(messages)
    dynamic_system_text = "\n\n".join(part for part in dynamic_system_parts if part)
    return system_prompt_text, dynamic_system_text or None, normalized, extraction_note


def split_available_actions_from_system_prompt(system_prompt: str | None) -> tuple[str | None, str | None]:
    if not system_prompt or AVAILABLE_ACTIONS_HEADING not in system_prompt:
        return system_prompt, None
    start = system_prompt.find(AVAILABLE_ACTIONS_HEADING)
    after_heading = start + len(AVAILABLE_ACTIONS_HEADING)
    match = NEXT_SYSTEM_HEADING_RE.search(system_prompt, after_heading)
    end = match.start() if match else len(system_prompt)
    before = system_prompt[:start].rstrip()
    tools = system_prompt[after_heading:end].strip()
    after = system_prompt[end:].lstrip()
    cleaned_system = "\n\n".join(part for part in (before, after) if part)
    return cleaned_system or None, tools or None


def remove_deprecated_screenshot_tool_section(system_prompt: str | None) -> str | None:
    if not system_prompt:
        return system_prompt
    cleaned = SCREENSHOT_TOOL_SECTION_RE.sub("", system_prompt).strip()
    return cleaned or None


def render_system_prompt(messages: list[dict[str, Any]]) -> str:
    system_prompt, _, _, note = split_system_prompt(messages)
    if not system_prompt:
        return '<p class="muted">No system prompt was present in this dump.</p>'
    system_prompt = remove_deprecated_screenshot_tool_section(system_prompt)
    system_prompt, _ = split_available_actions_from_system_prompt(system_prompt)
    note_html = f'<p class="note">{escape(note)}</p>' if note else ""
    return f"{note_html}<div class=\"markdown readable-content\">{render_markdown(system_prompt)}</div>"


def render_dynamic_system_prompt(messages: list[dict[str, Any]]) -> str:
    _, dynamic_system_prompt, _, _ = split_system_prompt(messages)
    if not dynamic_system_prompt:
        return '<p class="muted">No dynamic system prompt was present in this dump.</p>'
    return f'<div class="markdown readable-content">{render_markdown(dynamic_system_prompt)}</div>'


def dynamic_system_section_title(index: int, content: str) -> str:
    stripped = content.lstrip()
    if stripped.startswith("# Current Phase"):
        return "Current Phase"
    if stripped.startswith("# User Context"):
        return "Dynamic System Prompt"
    if stripped.startswith("# Required Output Schema"):
        return "Output Schema System Prompt"
    return "Dynamic System Prompt" if index == 0 else f"Dynamic System Prompt {index + 1}"


def render_dynamic_system_sections(messages: list[dict[str, Any]], token_counts: dict[str, int]) -> str:
    _, dynamic_system_parts, _, _ = split_system_prompt_parts(messages)
    if not dynamic_system_parts:
        return collapsible_section(
            title_with_tokens("Dynamic System Prompt", token_counts.get("dynamic_system_prompt")),
            '<p class="muted">No dynamic system prompt was present in this dump.</p>',
            False,
        )
    return "\n".join(
        collapsible_section(
            title_with_tokens(dynamic_system_section_title(index, content), token_counts.get(f"dynamic_system_prompt_{index}")),
            f'<div class="markdown readable-content">{render_markdown(content)}</div>',
            False,
        )
        for index, content in enumerate(dynamic_system_parts)
    )


def render_tools_section(data: dict[str, Any], messages: list[dict[str, Any]]) -> str:
    system_prompt, _, _, _ = split_system_prompt(messages)
    system_prompt = remove_deprecated_screenshot_tool_section(system_prompt)
    _, tools_text = split_available_actions_from_system_prompt(system_prompt)
    if tools_text:
        return (
            '<p class="note">Browser-use actions are text-defined JSON actions, not native provider tool calls. '
            "They are embedded in the system prompt sent to the model; this section is split out for readability.</p>"
            f"<div class=\"markdown readable-content tools-list\">{render_markdown(tools_text)}</div>"
        )

    config = data.get("config") or {}
    configured_tools = config.get("tools") or data.get("tools")
    if configured_tools:
        return render_tool_schemas(configured_tools)

    available_actions = config.get("available_actions") or (data.get("extra") or {}).get("available_actions")
    if available_actions:
        return render_json(available_actions)

    return '<p class="muted">No tools or browser-use action descriptions were present in this dump.</p>'


def available_tool_count(data: dict[str, Any], messages: list[dict[str, Any]]) -> int | None:
    system_prompt, _, _, _ = split_system_prompt(messages)
    system_prompt = remove_deprecated_screenshot_tool_section(system_prompt)
    _, tools_text = split_available_actions_from_system_prompt(system_prompt)
    if tools_text:
        matches = re.findall(r"^\s*[-*]\s+`?[\w.-]+`?\s*:", tools_text, re.M)
        if matches:
            return len(matches)

    config = data.get("config") or {}
    requested_params = config.get("requested_params") if isinstance(config.get("requested_params"), dict) else {}
    candidates = [
        config.get("tools"),
        data.get("tools"),
        requested_params.get("tools"),
        config.get("available_actions"),
        (data.get("extra") or {}).get("available_actions"),
    ]
    for candidate in candidates:
        if isinstance(candidate, list):
            return len(candidate)
    return None


def render_output_schema_section(data: dict[str, Any]) -> str:
    response_format = data.get("response_format") or (data.get("config") or {}).get("response_format")
    if response_format:
        return render_json(response_format)

    response_model = (data.get("config") or {}).get("response_model")
    if response_model:
        return render_json(response_model)

    return '<p class="muted">No structured output schema was present in this dump.</p>'


def render_tools_and_output_schema_section(data: dict[str, Any], messages: list[dict[str, Any]]) -> str:
    count = available_tool_count(data, messages)
    count_html = (
        f'<span class="section-count">{escape(count)} available</span>'
        if count is not None
        else ""
    )
    return (
        "<h3>Output Schema</h3>"
        + render_output_schema_section(data)
        + f"<h3>Tools {count_html}</h3>"
        + render_tools_section(data, messages)
    )


def tools_and_output_schema_title(data: dict[str, Any], messages: list[dict[str, Any]]) -> str:
    count = available_tool_count(data, messages)
    if count is None:
        return "Tools / Output Schema"
    return f"Tools / Output Schema ({count} tools)"


def render_tool_schemas(tools: Any) -> str:
    if not isinstance(tools, list):
        return render_json(tools)

    cards: list[str] = []
    for tool in tools:
        if not isinstance(tool, dict):
            cards.append(render_json(tool))
            continue
        function = tool.get("function") if isinstance(tool.get("function"), dict) else tool
        name = function.get("name") or "(unnamed)"
        description = function.get("description") or ""
        schema = function.get("input_schema") or function.get("parameters") or {}
        props = schema.get("properties") if isinstance(schema, dict) else {}
        required = set(schema.get("required") or []) if isinstance(schema, dict) else set()

        if isinstance(props, dict) and props:
            rows = []
            for arg_name, arg_schema in props.items():
                arg_schema = arg_schema if isinstance(arg_schema, dict) else {}
                type_name = arg_schema.get("type") or "any"
                arg_desc = arg_schema.get("description") or ""
                req = "required" if arg_name in required else "optional"
                rows.append(
                    "<tr>"
                    f"<td><code>{escape(str(arg_name))}</code></td>"
                    f"<td>{escape(str(type_name))}</td>"
                    f"<td>{escape(req)}</td>"
                    f"<td>{render_inline_markdown(str(arg_desc))}</td>"
                    "</tr>"
                )
            args_html = (
                '<table class="tool-args"><thead><tr>'
                "<th>Arg</th><th>Type</th><th>Required</th><th>Description</th>"
                "</tr></thead><tbody>"
                + "".join(rows)
                + "</tbody></table>"
            )
        else:
            args_html = '<p class="muted">No arguments.</p>'

        cards.append(
            '<section class="tool-card">'
            f"<h3>{escape(str(name))}</h3>"
            f'<div class="markdown readable-content">{render_markdown(str(description))}</div>'
            f"{args_html}"
            "</section>"
        )

    return '<div class="tools-grid">' + "\n".join(cards) + "</div>"


def render_message_content(content: Any, output_path: Path, message_index: int) -> str:
    if isinstance(content, list):
        parts: list[str] = []
        for block_index, block in enumerate(content, start=1):
            if not isinstance(block, dict):
                parts.append(f"<p>{render_inline_markdown(str(block))}</p>")
                continue

            block_type = block.get("type")
            if isinstance(block.get("text"), str):
                parts.append(render_markdown(block["text"]))
                continue

            image_url = None
            if block_type in {"image_url", "input_image"}:
                raw_image = block.get("image_url")
                if isinstance(raw_image, dict):
                    image_url = raw_image.get("url")
                elif isinstance(raw_image, str):
                    image_url = raw_image
            if isinstance(image_url, str) and image_url:
                if looks_like_base64_image(image_url):
                    src = write_image_asset(
                        output_path,
                        f"message-{message_index:02d}-image-{block_index:02d}",
                        image_url,
                    )
                else:
                    src = image_url
                parts.append(
                    f"""
                    <figure class="screenshot inline-message-image">
                      <figcaption>Message {escape(message_index)} image {escape(block_index)}</figcaption>
                      <img src="{escape(src)}" alt="Message {escape(message_index)} image {escape(block_index)}" />
                    </figure>
                    """
                )
                continue

            parts.append(render_json(block))
        return "\n".join(parts)
    return render_markdown(normalize_inline_structured_sections(str(content)))


def parse_json_maybe(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    stripped = value.strip()
    if not stripped:
        return value
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        return value


def tool_call_name(tool_call: dict[str, Any]) -> str:
    function = tool_call.get("function") if isinstance(tool_call.get("function"), dict) else {}
    return str(tool_call.get("name") or function.get("name") or "unknown")


def tool_call_arguments(tool_call: dict[str, Any]) -> Any:
    function = tool_call.get("function") if isinstance(tool_call.get("function"), dict) else {}
    if "arguments" in tool_call:
        return parse_json_maybe(tool_call.get("arguments"))
    if "input" in tool_call:
        return parse_json_maybe(tool_call.get("input"))
    return parse_json_maybe(function.get("arguments", {}))


def build_tool_call_name_index(messages: list[dict[str, Any]]) -> dict[str, str]:
    names: dict[str, str] = {}
    for message in messages:
        for tool_call in message.get("tool_calls") or []:
            if isinstance(tool_call, dict) and tool_call.get("id"):
                names[str(tool_call["id"])] = tool_call_name(tool_call)
    return names


def render_tool_calls(tool_calls: Any) -> str:
    if not isinstance(tool_calls, list) or not tool_calls:
        return ""
    parts: list[str] = ['<div class="message-tool-calls"><h4>Tool Calls</h4>']
    for index, tool_call in enumerate(tool_calls, start=1):
        if not isinstance(tool_call, dict):
            parts.append(render_json(tool_call))
            continue
        name = tool_call_name(tool_call)
        call_id = tool_call.get("id", "")
        arguments = tool_call_arguments(tool_call)
        parts.append(
            f"""
            <section class="tool-call-card">
              <dl class="message-meta">
                <div class="kv"><dt>Call</dt><dd>{escape(index)}</dd></div>
                <div class="kv"><dt>Name</dt><dd>{escape(name)}</dd></div>
                <div class="kv"><dt>ID</dt><dd>{escape(call_id)}</dd></div>
              </dl>
              <h5>Arguments</h5>
              {render_json(arguments)}
            </section>
            """
        )
    parts.append("</div>")
    return "\n".join(parts)


def render_reasoning_fields(message: dict[str, Any], output_path: Path, message_index: int) -> str:
    parts: list[str] = []
    for key in ("thinking", "reasoning", "reasoning_content", "encrypted_reasoning"):
        value = message.get(key)
        if not value:
            continue
        parts.append(
            f"""
            <section class="message-reasoning">
              <h4>{escape(key.replace("_", " ").title())}</h4>
              <div class="markdown readable-content">{render_message_content(value, output_path, message_index)}</div>
            </section>
            """
        )
    return "\n".join(parts)


def render_provider_message_content(message: dict[str, Any], output_path: Path, message_index: int) -> str:
    content = message.get("content", "")
    if not content:
        if message.get("role") == "assistant" and message.get("tool_calls"):
            return ""
        return '<p class="muted">No text content.</p>'
    if message.get("role") == "tool":
        parsed = parse_json_maybe(content)
        if not isinstance(parsed, str):
            return render_json(parsed)
    return render_message_content(content, output_path, message_index)


def render_message_sequence(
    messages: list[dict[str, Any]], data: dict[str, Any], output_path: Path, source_path: Path | None = None
) -> str:
    _, _, normalized_messages, _ = split_system_prompt(messages)
    if not normalized_messages:
        return "<p class=\"muted\">No non-system messages found.</p>"

    extra = data.get("extra") or {}
    browser_state = extra.get("browser_state") or {}
    parts: list[str] = [
        f'<p class="section-summary">Message count: <strong>{escape(len(normalized_messages))}</strong></p>'
    ]
    tool_call_names = build_tool_call_name_index(normalized_messages)

    for index, message in enumerate(normalized_messages, start=1):
        role = message.get("role", "unknown")
        content = message.get("content", "")
        message_tokens = token_count(message_token_text(message))
        content_tokens = token_count(text_content(content))
        meta_rows = [
            f'<div class="kv"><dt>Role</dt><dd>{escape(role)}</dd></div>',
            f'<div class="kv"><dt>Message Tokens</dt><dd>{escape(message_tokens)}</dd></div>',
        ]
        if content:
            meta_rows.append(f'<div class="kv"><dt>Content Tokens</dt><dd>{escape(content_tokens)}</dd></div>')
        if role == "tool":
            tool_call_id = message.get("tool_call_id", "")
            tool_name = message.get("name") or tool_call_names.get(str(tool_call_id), "")
            if tool_name:
                meta_rows.append(f'<div class="kv"><dt>Tool Name</dt><dd>{escape(tool_name)}</dd></div>')
            if tool_call_id:
                meta_rows.append(f'<div class="kv"><dt>Tool Call ID</dt><dd>{escape(tool_call_id)}</dd></div>')
        content_html = render_provider_message_content(message, output_path, index)
        reasoning_html = render_reasoning_fields(message, output_path, index)
        tool_calls_html = render_tool_calls(message.get("tool_calls"))
        browser_recording_html = render_browser_recording_for_tool_message(
            message, data, source_path, index
        )
        message_content_html = (
            f'<div class="message-content"><div class="markdown readable-content">{content_html}</div></div>'
            if content_html
            else ""
        )
        attachment = ""
        if index == len(normalized_messages) and browser_state and not contains_browser_state(message.get("content")):
            attachment = f"""
              <div class="message-attachment">
                <h4>Dump Metadata: Current Browser State</h4>
                <p class="muted">Renderer-only context from <code>extra.browser_state</code>. This helps inspect the dump, but it was not sent as a separate message. The message content above is exactly what was sent to the LLM.</p>
                {render_context_screenshot(data, output_path)}
                {render_browser_state(browser_state)}
              </div>
            """
        parts.append(
            f"""
            <section class="message-card">
              <h3>Message {escape(index)} {token_badge(message_tokens)}</h3>
              <dl class="message-meta">
                {''.join(meta_rows)}
              </dl>
              {reasoning_html}
              {message_content_html}
              {tool_calls_html}
              {browser_recording_html}
              {attachment}
            </section>
            """
        )
    return "\n".join(parts)


def render_messages(messages: list[dict[str, Any]]) -> str:
    if not messages:
        return "<p class=\"muted\">No messages found.</p>"
    parts: list[str] = []
    for index, message in enumerate(messages):
        role = message.get("role", "unknown")
        content = message.get("content", "")
        parts.append(
            f"""
            <details class="panel" open>
              <summary>Message {index}: {escape(role)}</summary>
              <div class="markdown">{render_markdown(content)}</div>
            </details>
            """
        )
    return "\n".join(parts)


def collect_screenshots(data: dict[str, Any]) -> list[tuple[str, str]]:
    screenshots: list[tuple[str, str]] = []

    def walk(value: Any, path: str = "") -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                child_path = f"{path}.{key}" if path else key
                if key.lower() in SCREENSHOT_KEYS and looks_like_base64_image(child):
                    screenshots.append((child_path, child))
                else:
                    walk(child, child_path)
        elif isinstance(value, list):
            for index, child in enumerate(value):
                walk(child, f"{path}[{index}]")

    walk(data)
    return screenshots


def render_screenshots(data: dict[str, Any], output_path: Path) -> str:
    screenshots = collect_screenshots(data)
    if not screenshots:
        return "<p class=\"muted\">No screenshots found.</p>"

    cards = []
    for index, (path, image) in enumerate(screenshots, start=1):
        safe_name = slug(path.replace(".", "_").replace("[", "_").replace("]", ""))
        try:
            src = write_image_asset(output_path, f"screenshot-{index:02d}-{safe_name}", image)
        except Exception as exc:  # pragma: no cover - defensive fallback for corrupt dumps.
            src = image_data_uri(image)
            path = f"{path} (could not write image file: {exc})"
        cards.append(
            f"""
            <figure class="screenshot">
              <figcaption>{escape(path)}</figcaption>
              <img src="{escape(src)}" alt="{escape(path)} screenshot" />
            </figure>
            """
        )
    return "\n".join(cards)


def render_context_screenshot(data: dict[str, Any], output_path: Path) -> str:
    screenshots = collect_screenshots(data)
    if not screenshots:
        return ""
    first_path, first_image = screenshots[0]
    wrapper = {"screenshot": first_image}
    return (
        '<div class="inline-attachment">'
        f"<h3>Attached Screenshot</h3><p class=\"muted\">{escape(first_path)}</p>"
        + render_screenshots(wrapper, output_path)
        + "</div>"
    )


def render_browser_state(browser_state: dict[str, Any]) -> str:
    if not browser_state:
        return "<p class=\"muted\">No browser state found.</p>"

    page_stats = browser_state.get("page_stats")
    scroll_position = browser_state.get("scroll_position")
    tabs = browser_state.get("tabs")
    dom_tree = browser_state.get("dom_tree")

    meta = "".join(
        [
            render_kv("URL", browser_state.get("url")),
            render_kv("Title", browser_state.get("title")),
            render_kv("Viewport", json.dumps(browser_state.get("viewport")) if browser_state.get("viewport") else None),
            render_kv("Scroll", json.dumps(scroll_position) if scroll_position else None),
        ]
    )

    sections = [f"<dl class=\"meta-grid\">{meta}</dl>"]
    if page_stats:
        sections.append("<details class=\"panel\"><summary>Page Stats</summary>" + render_json(page_stats) + "</details>")
    if tabs:
        sections.append("<details class=\"panel\"><summary>Tabs</summary>" + render_json(tabs) + "</details>")
    if dom_tree:
        sections.append(
            "<details class=\"panel\"><summary>DOM Tree</summary>"
            + "<pre><code>"
            + escape(dom_tree)
            + "</code></pre></details>"
        )
    return "\n".join(sections)


def render_action_history(actions: list[dict[str, Any]]) -> str:
    if not actions:
        return "<p class=\"muted\">No action history found.</p>"

    parts: list[str] = []
    for action in actions:
        step = action.get("step", "?")
        name = action.get("action", "unknown")
        thinking = action.get("thinking")
        details = {k: v for k, v in action.items() if k not in {"step", "action", "thinking"}}
        parts.append(
            f"""
            <article class="action">
              <header><span class="badge">Step {escape(step)}</span><strong>{escape(name)}</strong></header>
              {f'<p class="thinking">{render_inline_markdown(thinking)}</p>' if thinking else ''}
              {render_json(details)}
            </article>
            """
        )
    return "\n".join(parts)


def render_ordered_context(data: dict[str, Any], output_path: Path) -> str:
    extra = data.get("extra") or {}
    messages = data.get("messages") or []
    browser_state = extra.get("browser_state") or {}
    action_history = extra.get("action_history") or []

    parts: list[str] = []
    for index, message in enumerate(messages):
        role = message.get("role", "unknown")
        content = message.get("content", "")
        parts.append(
            f"""
            <section class="ordered-block">
              <h3>Message {escape(index)}: {escape(role)}</h3>
              <div class="markdown">{render_markdown(content)}</div>
            </section>
            """
        )

    if browser_state:
        parts.append(
            f"""
            <section class="ordered-block">
              <h3>Attached Browser State</h3>
              {render_context_screenshot(data, output_path)}
              {render_browser_state(browser_state)}
            </section>
            """
        )

    if action_history:
        parts.append(
            f"""
            <section class="ordered-block">
              <h3>Previous Tool Calls / Action History</h3>
              {render_action_history(action_history)}
            </section>
            """
        )

    return "\n".join(parts) if parts else "<p class=\"muted\">No ordered context found.</p>"


def build_html(data: dict[str, Any], source_path: Path, output_path: Path) -> str:
    extra = data.get("extra") or {}
    messages = data.get("messages") or []

    title = f"LLM Dump: {source_path.name}"
    overview = "".join(
        [
            render_kv("Source", source_path),
            render_kv("Call Site", data.get("call_site")),
            render_kv("Agent ID", data.get("agent_id")),
            render_kv("Span ID", data.get("span_id")),
            render_kv("Model", data.get("model")),
            render_kv("Message Count", data.get("message_count")),
            render_kv("Iteration", extra.get("iteration")),
            render_kv("Browser Mode", extra.get("browser_use_mode")),
            token_overview_rows(data),
            timing_overview_rows(data),
        ]
    )
    token_counts = section_token_counts(data, messages)

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{escape(title)}</title>
  <style>
    :root {{
      color-scheme: light;
      --bg: #f7f8fa;
      --panel: #ffffff;
      --text: #17202a;
      --muted: #667085;
      --border: #d8dee8;
      --accent: #0f766e;
      --code-bg: #101828;
      --code-text: #e6edf3;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }}
    main {{ max-width: 1180px; margin: 0 auto; padding: 28px; }}
    h1 {{ margin: 0 0 20px; font-size: 28px; letter-spacing: 0; }}
    h2 {{ margin: 34px 0 12px; font-size: 20px; letter-spacing: 0; }}
    h3, h4, h5, h6 {{ margin: 20px 0 8px; letter-spacing: 0; }}
    a {{ color: var(--accent); }}
    .panel, .action, .screenshot, .meta-grid {{
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      margin: 12px 0;
      overflow: hidden;
    }}
    .panel > summary {{
      cursor: pointer;
      padding: 12px 14px;
      font-weight: 650;
      border-bottom: 1px solid var(--border);
      background: #fbfcfe;
    }}
    .panel:not([open]) > summary {{ border-bottom: 0; }}
    .section-panel {{
      margin: 18px 0;
    }}
    .section-panel > summary {{
      font-size: 18px;
    }}
    .section-body {{
      padding: 14px 18px 18px;
    }}
    .section-body > h3:first-child,
    .output-primary > h3:first-child {{
      margin-top: 0;
    }}
    .section-body > .meta-grid,
    .section-body > .panel,
    .section-body > .message-card,
    .section-body > .action {{
      margin-left: 0;
      margin-right: 0;
    }}
    .section-summary {{
      margin: 0 0 12px;
      color: var(--muted);
    }}
    .nested-panel {{
      margin: 12px 0;
    }}
    .markdown {{ padding: 14px 18px; }}
    .markdown p {{ margin: 0 0 12px; }}
    .markdown ul {{ margin: 0 0 12px 22px; padding: 0; }}
    .markdown li > ul {{ margin: 6px 0 6px 18px; }}
    .ordered-block {{
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      margin: 12px 0 18px;
      overflow: hidden;
    }}
    .ordered-block > h3 {{
      margin: 0;
      padding: 12px 14px;
      border-bottom: 1px solid var(--border);
      background: #fbfcfe;
      font-size: 15px;
    }}
    .ordered-block > .panel,
    .ordered-block > .action,
    .ordered-block > .meta-grid,
    .ordered-block > .inline-attachment {{
      margin-left: 14px;
      margin-right: 14px;
    }}
    .inline-attachment > h3 {{
      margin: 14px 0 4px;
      font-size: 14px;
    }}
    .inline-attachment > .muted {{ margin: 0 0 8px; }}
    .message-card {{
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      margin: 12px 0 18px;
      overflow: hidden;
    }}
    .message-card > h3 {{
      margin: 0;
      padding: 12px 14px;
      border-bottom: 1px solid var(--border);
      background: #fbfcfe;
      font-size: 15px;
    }}
    .message-meta {{
      margin: 0;
      display: grid;
      grid-template-columns: minmax(120px, 180px) 1fr;
      border-bottom: 1px solid var(--border);
    }}
    .message-content {{ padding: 14px 18px; }}
    .message-content > .markdown {{
      padding: 0;
    }}
    .message-attachment {{
      border-top: 1px solid var(--border);
      padding: 0 14px 14px;
      background: #fbfcfe;
    }}
    .message-attachment > h4 {{
      margin: 14px 0 4px;
      font-size: 14px;
    }}
    .readable-content {{
      max-width: 86ch;
    }}
    .note {{
      color: var(--muted);
      background: #fff8e6;
      border: 1px solid #f3d28a;
      border-radius: 8px;
      padding: 10px 12px;
      margin: 0 0 12px;
    }}
    .meta-grid {{
      display: grid;
      grid-template-columns: minmax(120px, 180px) 1fr;
      padding: 8px 0;
    }}
    .kv {{ display: contents; }}
    dt, dd {{
      padding: 8px 14px;
      border-top: 1px solid var(--border);
      overflow-wrap: anywhere;
    }}
    .kv:first-child dt, .kv:first-child dd {{ border-top: 0; }}
    dt {{ color: var(--muted); font-weight: 650; }}
    dd {{ margin: 0; }}
    pre {{
      margin: 0;
      padding: 14px;
      overflow: auto;
      background: var(--code-bg);
      color: var(--code-text);
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }}
    code {{
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      background: rgba(15, 118, 110, 0.09);
      padding: 1px 4px;
      border-radius: 4px;
    }}
    pre code {{ background: transparent; padding: 0; border-radius: 0; }}
    .attachment-chip-row {{
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 10px 0;
    }}
    .attachment-chip {{
      display: inline-flex;
      align-items: center;
      max-width: 100%;
      gap: 7px;
      padding: 4px 8px;
      margin: 0 2px;
      border: 1px solid #b9d8d4;
      border-radius: 999px;
      background: #ecfdf9;
      color: #134e4a;
      vertical-align: baseline;
      font-size: 12px;
      line-height: 1.35;
      white-space: nowrap;
    }}
    .attachment-chip-kind {{
      color: #0f766e;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0;
      font-size: 10px;
    }}
    .attachment-chip-name {{
      overflow: hidden;
      text-overflow: ellipsis;
    }}
    .browser-state-block {{
      margin: 12px 0;
      border: 1px solid #b9d8d4;
      border-radius: 8px;
      background: #fbfffe;
      overflow: hidden;
    }}
    .browser-state-block > h4 {{
      margin: 0;
      padding: 10px 12px;
      border-bottom: 1px solid #b9d8d4;
      color: #134e4a;
      font-size: 13px;
      text-transform: uppercase;
    }}
    .browser-state-body {{
      padding: 8px 10px 10px;
      color: var(--text);
    }}
    .browser-state-body > .meta-grid,
    .browser-state-body > .panel {{
      margin: 8px 0;
    }}
    .compact-meta {{
      font-size: 12px;
    }}
    .token-cell {{
      padding: 2px 0;
    }}
    .token-row-head {{
      display: flex;
      justify-content: space-between;
      gap: 12px;
      font-weight: 650;
      margin-bottom: 6px;
    }}
    .token-bar {{
      height: 9px;
      border-radius: 999px;
      background: #e5e7eb;
      overflow: hidden;
    }}
    .token-bar > span {{
      display: block;
      height: 100%;
      border-radius: inherit;
      background: var(--accent);
    }}
    .token-detail {{
      margin-top: 5px;
      color: var(--muted);
      font-size: 12px;
    }}
    .token-badge {{
      display: inline-flex;
      align-items: center;
      margin-left: 8px;
      padding: 1px 7px;
      border: 1px solid #b9d8d4;
      border-radius: 999px;
      background: #ecfdf9;
      color: #134e4a;
      font-size: 12px;
      font-weight: 650;
      text-transform: none;
      vertical-align: middle;
    }}
    .screenshot {{ padding: 12px; }}
    .screenshot figcaption {{ color: var(--muted); font-weight: 650; margin-bottom: 10px; }}
    .screenshot img {{
      display: block;
      max-width: 100%;
      height: auto;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: #fff;
    }}
    .action {{ padding: 0; }}
    .action header {{
      display: flex;
      gap: 10px;
      align-items: center;
      padding: 12px 14px;
      border-bottom: 1px solid var(--border);
      background: #fbfcfe;
    }}
    .badge {{
      display: inline-flex;
      align-items: center;
      border: 1px solid #b7e4db;
      background: #e6fffa;
      color: #115e59;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 12px;
      font-weight: 700;
    }}
    .thinking {{ margin: 0; padding: 12px 14px; border-bottom: 1px solid var(--border); }}
    .message-reasoning {{
      border-bottom: 1px solid var(--border);
      background: #fbfcfe;
    }}
    .message-reasoning h4,
    .message-tool-calls h4,
    .tool-call-card h5 {{
      margin: 0;
      padding: 10px 14px;
      font-size: 13px;
      color: var(--muted);
    }}
    .message-tool-calls {{
      border-top: 1px solid var(--border);
      background: #fbfcfe;
    }}
    .message-recording {{
      border-top: 1px solid var(--border);
      background: #f7fffd;
    }}
    .message-recording h4 {{
      margin: 0;
      padding: 10px 14px;
      font-size: 13px;
      color: #134e4a;
    }}
    .tool-call-card {{
      margin: 0 14px 14px;
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      background: var(--panel);
    }}
    .tools-list ul {{ list-style: none; margin-left: 0; }}
    .tools-list li {{
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      margin: 8px 0;
      background: #fbfcfe;
    }}
    .tools-grid {{ display: grid; gap: 12px; }}
    .browser-recording {{
      padding: 14px;
    }}
    .browser-recording > h3 {{
      margin-top: 0;
    }}
    .recording-meta {{
      width: auto;
      min-width: 360px;
      max-width: 720px;
      margin: 0 0 12px;
      border-collapse: collapse;
      font-size: 13px;
    }}
    .recording-meta th,
    .recording-meta td {{
      border: 1px solid var(--border);
      padding: 6px 8px;
      text-align: left;
      vertical-align: top;
    }}
    .recording-meta th {{
      width: 150px;
      color: var(--muted);
      background: #f8fafc;
      font-weight: 600;
    }}
    .recording-player {{
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      background: #0b0f14;
    }}
    .recording-controls {{
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      padding: 10px;
      border-bottom: 1px solid #263241;
      background: #111827;
      color: #f9fafb;
    }}
    .recording-controls button,
    .recording-controls select {{
      font: inherit;
      color: #f9fafb;
      background: #1f2937;
      border: 1px solid #4b5563;
      border-radius: 6px;
      padding: 4px 8px;
    }}
    .recording-controls input[type="range"] {{
      flex: 1 1 220px;
      min-width: 160px;
    }}
    .recording-player canvas {{
      display: block;
      width: 100%;
      height: auto;
      max-height: 720px;
      object-fit: contain;
      background: #050505;
    }}
    .section-count {{
      display: inline-flex;
      align-items: center;
      margin-left: 8px;
      padding: 2px 8px;
      border: 1px solid #b9d8d4;
      border-radius: 999px;
      background: #ecfdf9;
      color: #134e4a;
      font-size: 12px;
      font-weight: 650;
      vertical-align: middle;
    }}
    .tool-card {{
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 14px;
      background: #fbfcfe;
    }}
    .tool-card h3 {{ margin: 0 0 8px; font-size: 15px; }}
    .tool-args {{
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
      font-size: 13px;
    }}
    .tool-args th, .tool-args td {{
      text-align: left;
      vertical-align: top;
      border-top: 1px solid var(--border);
      padding: 7px 8px;
    }}
    .tool-args th {{ color: var(--muted); font-weight: 700; }}
    .muted {{ color: var(--muted); }}
  </style>
</head>
<body>
  <main>
    <h1>{escape(title)}</h1>

    <h2>Overview</h2>
    <dl class="meta-grid">{overview}</dl>

    {collapsible_section("Config", render_config(data), False)}

    {collapsible_section(title_with_tokens("System Prompt", token_counts.get("system_prompt")), render_system_prompt(messages), False)}

    {render_dynamic_system_sections(messages, token_counts)}

    {collapsible_section(title_with_tokens(tools_and_output_schema_title(data, messages), token_counts.get("tools_output_schema")), render_tools_and_output_schema_section(data, messages), False)}

    {collapsible_section(title_with_tokens("Messages", token_counts.get("messages")), render_message_sequence(messages, data, output_path, source_path), False)}

    {collapsible_section("Output", render_output_section(data, source_path), False)}
  </main>
</body>
</html>
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Render an .llm-dumps JSON file into human-readable HTML."
    )
    parser.add_argument("dump", type=Path, help="Path to an .llm-dumps JSON file")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        help="Output HTML path. Defaults to .context/rendered-llm-dumps/<dump>.html",
    )
    parser.add_argument(
        "--no-open",
        action="store_true",
        help="Write the HTML but do not open it in the default browser.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    dump_path = args.dump
    if not dump_path.exists():
        raise SystemExit(f"Dump file not found: {dump_path}")

    with dump_path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise SystemExit(f"Expected top-level JSON object in {dump_path}")

    output_path = args.output or DEFAULT_OUTPUT_DIR / f"{slug(dump_path.stem)}.html"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(build_html(data, dump_path.resolve(), output_path.resolve()), encoding="utf-8")
    url = output_path.resolve().as_uri()
    print(url)
    if not args.no_open:
        webbrowser.open(url)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
