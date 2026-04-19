"""Browser-use sub-flow — message build + JSON-action extraction.

Browser-use rides the same claudeAuth -> waterfall machinery as rose-1-lite
and rose-1-ultra (see `pools.py:rose-1-browser-use`). What's specific:

  - The user message bundles a full browser snapshot (URL, viewport,
    DOM tree, action history, optional screenshot) plus the dynamic
    system prompt that enumerates the agent's available actions.
  - The model is expected to reply with a JSON envelope containing a
    `thinking` string and an `action` array. We extract the JSON from
    its (possibly markdown-fenced) text reply and normalize the first
    action into the `UnifiedAction` shape the browser handler expects.

No tools are passed — every supported model in this pool returns the
JSON in plain text, matching the legacy edge-function behavior.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional

import structlog

logger = structlog.get_logger()


# ---------------------------------------------------------------------------
# Tool catalog (mirrors research/.../browser-use-native.ts:BROWSER_USE_TOOLS)
# ---------------------------------------------------------------------------

BROWSER_USE_TOOLS: Dict[str, Dict[str, Any]] = {
    "goto": {
        "description": "Navigate to a URL",
        "params": {"url": {"type": "string", "description": "URL to navigate to", "required": True}},
    },
    "navback": {"description": "Go back to the previous page in browser history", "params": {}},
    "wait": {
        "description": "Wait for x seconds (capped at 30s)",
        "params": {"seconds": {"type": "integer", "description": "Seconds to wait (default: 3)"}},
    },
    "click": {
        "description": "Click element by index",
        "params": {"index": {"type": "integer", "description": "Element index from browser_state", "required": True}},
    },
    "click_coordinates": {
        "description": "Click at specific coordinates (for vision models when index unavailable)",
        "params": {
            "x": {"type": "integer", "description": "X coordinate", "required": True},
            "y": {"type": "integer", "description": "Y coordinate", "required": True},
        },
    },
    "input_text": {
        "description": "Input text into element by index",
        "params": {
            "index": {"type": "integer", "description": "Element index from browser_state", "required": True},
            "text": {"type": "string", "description": "Text to input", "required": True},
            "clear": {"type": "boolean", "description": "Clear field before typing (default: true)"},
        },
    },
    "press_key": {
        "description": "Send keyboard keys or shortcuts",
        "params": {
            "keys": {
                "type": "string",
                "description": "Keys (Escape, Enter, PageDown) or shortcuts (Control+o)",
                "required": True,
            },
        },
    },
    "scroll": {
        "description": (
            "Scroll by pages. Use down=True for scroll down, down=False for scroll up. "
            "Use index for scroll containers."
        ),
        "params": {
            "down": {"type": "boolean", "description": "True=scroll down, False=scroll up (default: true)", "required": True},
            "pages": {"type": "number", "description": "0.5=half page, 1=full page, 10=to bottom/top (default: 1.0)"},
            "index": {"type": "integer", "description": "Optional element index to scroll within specific container"},
        },
    },
    "find_text": {
        "description": "Scroll to specific text on the page",
        "params": {"text": {"type": "string", "description": "Text to find and scroll to", "required": True}},
    },
    "extract": {
        "description": (
            "LLM extracts structured data from page markdown. "
            "Use when on right page and know what to extract."
        ),
        "params": {
            "query": {"type": "string", "description": "What to extract from the page", "required": True},
            "extract_links": {"type": "boolean", "description": "Set True to extract URLs (default: false)"},
        },
    },
    "dropdown_options": {
        "description": "Get all options from a native dropdown or ARIA menu",
        "params": {"index": {"type": "integer", "description": "Element index of the dropdown", "required": True}},
    },
    "select_dropdown": {
        "description": "Set the option of a <select> element",
        "params": {
            "index": {"type": "integer", "description": "Element index of the dropdown", "required": True},
            "text": {"type": "string", "description": "Exact text of the option to select", "required": True},
        },
    },
    "evaluate": {
        "description": (
            "Execute browser JavaScript. Wrap in IIFE with try-catch. "
            "Use for hover, drag, custom selectors, shadow DOM."
        ),
        "params": {"code": {"type": "string", "description": "JavaScript code to execute", "required": True}},
    },
    "switch_tab": {
        "description": "Switch to another open tab by tab_id (last 4 chars of target_id shown in browser state)",
        "params": {"tab_id": {"type": "string", "description": "4-char tab ID", "required": True}},
    },
    "close_tab": {
        "description": "Close a tab by tab_id. Closes current tab if omitted.",
        "params": {"tab_id": {"type": "string", "description": "4-char tab ID (optional, closes current if omitted)"}},
    },
    "open_new_tab": {
        "description": "Open a new browser tab, optionally navigating to a URL",
        "params": {"url": {"type": "string", "description": "URL to open in new tab (defaults to about:blank)"}},
    },
    "done": {
        "description": "Complete the task and provide final result",
        "params": {
            "text": {"type": "string", "description": "Final result message in the format user requested", "required": True},
            "success": {"type": "boolean", "description": "True if task completed successfully (default: true)"},
        },
    },
    "attempt_completion": {
        "description": "Attempt to complete the task with a result message",
        "params": {"result": {"type": "string", "description": "The result/answer for the user", "required": True}},
    },
    "send_message_to_user": {
        "description": "Send a message to the user (for updates or asking for help)",
        "params": {"message": {"type": "string", "description": "Message content", "required": True}},
    },
    "screenshot": {
        "description": (
            "Take a full-page screenshot of the current page (captures entire page, not just viewport). "
            "The screenshot is saved and returned to the orchestrating agent. "
            "Only call once per page — one call captures everything."
        ),
        "params": {},
    },
}


def generate_tool_descriptions(available_actions: List[str]) -> str:
    """Produce the system-prompt action list filtered by `available_actions`."""
    descriptions: List[str] = []
    for action_name in available_actions:
        tool = BROWSER_USE_TOOLS.get(action_name)
        if not tool:
            continue
        param_parts: List[str] = []
        for param_name, info in tool["params"].items():
            part = f"{param_name}={info['type']}"
            desc = info.get("description")
            if desc:
                part += f" ({desc})"
            param_parts.append(part)
        params_str = f" ({', '.join(param_parts)})" if param_parts else ""
        descriptions.append(f"- {action_name}: {tool['description']}{params_str}")
    return "\n".join(descriptions)


def build_browser_use_system_prompt(available_actions: List[str]) -> str:
    """Dynamic system prompt — enumerates the agent's available actions."""
    tool_descriptions = generate_tool_descriptions(available_actions)
    return f"""You are a browser-use agent operating in thinking mode. You automate browser tasks by outputting structured JSON actions.

<intro>
You excel at:
1. Navigating complex websites and extracting precise information
2. Automating form submissions and interactive web actions
3. Operating effectively in an agent loop
4. Efficiently performing diverse web tasks
</intro>

<input>
At every step, your input will consist of:
1. Current URL, viewport size, scroll position
2. Interactive elements indexed for actions (format: [index]<type>text</type>)
3. Previous action results and history
4. Optional screenshot of the browser
</input>

<browser_rules>
- Only interact with elements that have a numeric [index] assigned
- Only use indexes that are explicitly provided in the current state
- If expected elements are missing, try scrolling or waiting
- By default, only elements in the visible viewport are listed - use scroll if content is offscreen
- You can scroll by pages using the pages parameter (0.5 for half page, 2.0 for two pages)
- If you fill an input field and action is interrupted, suggestions may have appeared
</browser_rules>

<available_actions>
{tool_descriptions}
</available_actions>

<output>
You must ALWAYS respond with valid JSON in this exact format:
{{
  "thinking": "A structured reasoning block analyzing: current page state, what was attempted, what worked/failed, and strategic planning for next steps.",
  "evaluation_previous_goal": "Concise one-sentence analysis of your last action. Clearly state success, failure, or uncertain.",
  "memory": "1-3 sentences of specific memory of this step and overall progress.",
  "next_goal": "State the next immediate goal and action to achieve it.",
  "action": [{{"action_name": {{...params...}}}}]
}}
Action list should NEVER be empty.
</output>"""


# ---------------------------------------------------------------------------
# Message build (mirrors transformToBrowserUseFormat)
# ---------------------------------------------------------------------------


def _format_action_history(action_history: List[Dict[str, Any]]) -> str:
    if not action_history:
        return ""
    parts: List[str] = ["\n\nPrevious Actions:\n"]
    for entry in action_history:
        line = f"Step {entry.get('step')}: "
        if entry.get("thinking"):
            line += f"[Thinking: {entry['thinking']}] "
        line += str(entry.get("action", ""))
        if entry.get("index") is not None:
            line += f" (index: {entry['index']})"
        result = entry.get("result", {}) or {}
        if result.get("success"):
            line += " ✓"
        else:
            line += f" ✗ Error: {result.get('error') or 'Unknown error'}"
        parts.append(line + "\n")
    return "".join(parts)


def _format_browser_state_text(task: str, browser_state: Dict[str, Any]) -> str:
    bs = browser_state
    stats_text = ""
    page_stats = bs.get("page_stats")
    if page_stats:
        stats_text = (
            f"<page_stats>{page_stats.get('links', 0)} links, "
            f"{page_stats.get('interactive', 0)} interactive, "
            f"{page_stats.get('iframes', 0)} iframes, "
            f"{page_stats.get('scroll_containers', 0)} scroll containers"
        )
        if page_stats.get("images", 0) > 0:
            stats_text += f", {page_stats['images']} images"
        stats_text += f", {page_stats.get('total_elements', 0)} total elements</page_stats>\n"

    scroll = bs.get("scroll_position") or {}
    scroll_text = f"Scroll: ({scroll.get('x', 0)}, {scroll.get('y', 0)})"
    if "pages_above" in scroll:
        scroll_text += f" | {scroll.get('pages_above')} pages above, {scroll.get('pages_below')} pages below"

    tabs_text = ""
    tabs = bs.get("tabs") or []
    if tabs:
        tabs_text = "\nOpen Tabs:\n"
        for tab in tabs:
            tabs_text += f"  Tab {tab.get('id')}: {tab.get('url')} - {tab.get('title')}\n"

    events = bs.get("recent_events") or []
    events_text = f"\nRecent Events: {', '.join(events)}\n" if events else ""

    popups = bs.get("closed_popups") or []
    popups_text = ""
    if popups:
        popups_text = "\nAuto-closed dialogs:\n"
        for popup in popups:
            popups_text += f"  - {popup}\n"

    viewport = bs.get("viewport") or {}
    title_part = f" - {bs['title']}" if bs.get("title") else ""

    return (
        f"Task: {task}\n\n"
        f"{stats_text}Current URL: {bs.get('url', '')}{title_part}\n"
        f"Viewport: {viewport.get('width', 0)}x{viewport.get('height', 0)}\n"
        f"{scroll_text}{tabs_text}{events_text}{popups_text}"
        f"Interactive elements:\n{bs.get('dom_tree', '')}"
    )


def build_browser_use_messages(
    *,
    task: str,
    browser_state: Dict[str, Any],
    action_history: List[Dict[str, Any]],
    available_actions: List[str],
    include_screenshot: bool = True,
) -> List[Dict[str, Any]]:
    """Build the OpenAI-style messages array for one browser-use step.

    Returns `[system, user]`. The user message is multimodal (text + image)
    when `include_screenshot=True` and a screenshot is present in the
    browser state — otherwise a plain text user message.
    """
    text_content = _format_browser_state_text(task, browser_state) + _format_action_history(action_history)

    user_content: Any
    screenshot = browser_state.get("screenshot")
    if screenshot and include_screenshot:
        image_url = screenshot if screenshot.startswith("http") else f"data:image/png;base64,{screenshot}"
        user_content = [
            {"type": "text", "text": text_content},
            {"type": "image_url", "image_url": {"url": image_url}},
        ]
    else:
        user_content = text_content

    return [
        {"role": "system", "content": build_browser_use_system_prompt(available_actions)},
        {"role": "user", "content": user_content},
    ]


# ---------------------------------------------------------------------------
# Response normalization (mirrors normalizeBrowserUseResponse)
# ---------------------------------------------------------------------------


_FENCED_JSON_RE = re.compile(r"```(?:json)?\s*([\s\S]*?)```")
_OBJECT_RE = re.compile(r"\{[\s\S]*\}")
_ARRAY_RE = re.compile(r"\[[\s\S]*\]")


def extract_json(content: str) -> Any:
    """Extract a JSON value from possibly markdown-wrapped text. Returns None."""
    if not isinstance(content, str) or not content:
        return None
    trimmed = content.strip()
    for raw in (trimmed, _match(_FENCED_JSON_RE, trimmed, group=1), _match(_OBJECT_RE, trimmed), _match(_ARRAY_RE, trimmed)):
        if raw is None:
            continue
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            continue
    return None


def _match(regex: re.Pattern[str], text: str, group: int = 0) -> Optional[str]:
    m = regex.search(text)
    if not m:
        return None
    return m.group(group).strip()


_ACTION_NAME_MAP: Dict[str, str] = {
    "navigate": "goto",
    "go_back": "navback",
    "input": "input_text",
    "send_keys": "press_key",
    "switch": "switch_tab",
    "close": "close_tab",
    "done": "attempt_completion",
}

_VALID_ACTIONS = frozenset({
    "click", "click_coordinates", "scroll", "wait", "extract", "evaluate",
    "dropdown_options", "select_dropdown", "screenshot", "find_text",
    "upload_file", "search", "goto", "navback", "input_text", "press_key",
    "switch_tab", "close_tab", "open_new_tab", "attempt_completion",
    # BROWSER_USE_TOOLS advertises send_message_to_user so the model can ask
    # the user for help mid-task. Keep the allowlist in sync with the tool
    # schema or normalize_browser_use_response() will reject it.
    "send_message_to_user",
})


def normalize_browser_use_response(completion: Any) -> Dict[str, Any]:
    """Convert a model completion into the agent's UnifiedAction shape.

    Mirrors `normalizeBrowserUseResponse` in
    `research/domains/completions/service/generic.ts`. Handles three
    action shapes:
      1. `{"action_name": "click", "index": 5}` (flat)
      2. `{"click": {"index": 5}}` (nested, browser-use native)
      3. `{"action_name": {...params}}` (semi-nested)

    Raises `ValueError` for unparseable text, empty action arrays,
    unknown action names, or click-without-index.
    """
    if isinstance(completion, str):
        parsed = extract_json(completion)
        if parsed is None:
            raise ValueError(
                f"normalize_browser_use_response: Could not extract JSON from completion: {completion[:200]}"
            )
        return normalize_browser_use_response(parsed)

    if not isinstance(completion, dict):
        raise ValueError(
            f"normalize_browser_use_response: completion must be a dict or string, got {type(completion).__name__}"
        )

    actions = completion.get("action")
    if not actions:
        raise ValueError("normalize_browser_use_response: No actions returned in completion")

    first_action = actions[0]
    if not isinstance(first_action, dict):
        raise ValueError(
            f"normalize_browser_use_response: first action must be an object, got {type(first_action).__name__}"
        )

    if "action_name" in first_action:
        action_name = first_action["action_name"]
        params: Dict[str, Any] = {k: v for k, v in first_action.items() if k != "action_name"}
        index = first_action.get("index")
    else:
        keys = list(first_action.keys())
        if not keys:
            raise ValueError("normalize_browser_use_response: empty action object")
        action_name = keys[0]
        params = first_action.get(action_name) or {}
        if not isinstance(params, dict):
            params = {}
        index = params.get("index")

    normalized_action = _ACTION_NAME_MAP.get(action_name, action_name)
    if normalized_action not in _VALID_ACTIONS:
        raise ValueError(
            f'normalize_browser_use_response: Unknown action "{normalized_action}" '
            f'(raw: "{action_name}") - add to _ACTION_NAME_MAP or _VALID_ACTIONS'
        )

    thinking = completion.get("next_goal") or completion.get("thinking")

    if normalized_action == "click_coordinates":
        x = params.get("x", params.get("coordinate_x"))
        y = params.get("y", params.get("coordinate_y"))
        if x is None or y is None:
            raise ValueError(
                f"normalize_browser_use_response: click_coordinates requires x and y, got: {params}"
            )
        return {
            "action": "click",
            "thinking": thinking,
            "coordinates": {"x": x, "y": y},
            "params": {},
        }

    if normalized_action == "click" and index is None:
        raise ValueError(
            f"normalize_browser_use_response: click action requires element index, got none. Raw action: {first_action}"
        )

    normalized_params = _normalize_action_params(action_name, normalized_action, params, first_action, index)

    coordinates: Optional[Dict[str, Any]] = None
    if params.get("coordinate_x") is not None:
        coordinates = {"x": params.get("coordinate_x"), "y": params.get("coordinate_y")}

    return {
        "action": normalized_action,
        "thinking": thinking,
        "index": index,
        "coordinates": coordinates,
        "element_description": params.get("element_description"),
        "params": normalized_params,
    }


def _normalize_action_params(
    raw_action_name: str,
    normalized_action: str,
    params: Dict[str, Any],
    first_action: Dict[str, Any],
    index: Any,
) -> Dict[str, Any]:
    out: Dict[str, Any] = {}

    if params.get("url"):
        out["url"] = params["url"]
    if params.get("text"):
        out["text"] = params["text"]
    if params.get("typing_text"):  # Yutori format
        out["text"] = params["typing_text"]

    if first_action.get("filename"):
        out["filename"] = first_action["filename"]
    elif params.get("filename"):
        out["filename"] = params["filename"]
    if first_action.get("file_path"):
        out["file_path"] = first_action["file_path"]
    elif params.get("file_path"):
        out["file_path"] = params["file_path"]

    if params.get("key"):
        out["key"] = params["key"]
    if params.get("keys"):
        out["key"] = params["keys"]

    if params.get("instruction"):
        out["instruction"] = params["instruction"]
    if params.get("query"):
        out["instruction"] = params["query"]
    if params.get("extract_links") is not None:
        out["extract_links"] = params["extract_links"]

    if params.get("code"):
        out["code"] = params["code"]

    if normalized_action == "select_dropdown" and params.get("text"):
        out["value"] = params["text"]
    elif params.get("value"):
        out["value"] = params["value"]

    if params.get("tab_id"):
        out["tab_id"] = params["tab_id"]
    if params.get("message"):
        out["message"] = params["message"]
    if params.get("reasoning"):
        out["reasoning"] = params["reasoning"]
    if params.get("reason"):
        out["reason"] = params["reason"]

    if params.get("seconds") is not None:
        out["time_ms"] = params["seconds"] * 1000
    if params.get("timeout") is not None:
        out["time_ms"] = params["timeout"]
    if params.get("time_ms") is not None:
        out["time_ms"] = params["time_ms"]

    if raw_action_name == "scroll_up":
        out["direction"] = "up"
        out["amount"] = 300
    elif raw_action_name == "scroll_down":
        out["direction"] = "down"
        out["amount"] = 300
    elif params.get("down") is not None:
        out["direction"] = "down" if params["down"] else "up"
        pages = params.get("pages", 1.0)
        out["amount"] = round(pages * 600)
    elif params.get("direction"):
        out["direction"] = params["direction"]
        out["amount"] = params.get("amount", 300)

    if index is not None:
        out["index"] = index

    return out
