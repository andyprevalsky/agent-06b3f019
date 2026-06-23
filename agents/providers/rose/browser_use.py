"""Browser-use sub-flow — message build + tool-call extraction.

Browser-use rides the same claudeAuth -> waterfall machinery as rose-1-lite
and rose-1-ultra (see `pools.py:rose-1-browser-use`). What's specific:

  - The user message bundles a full browser snapshot (URL, viewport,
    DOM tree, action history, optional screenshot).
  - Available browser actions are passed as provider tools built from
    `BROWSER_USE_TOOLS`, then the first native tool call is normalized into
    the `UnifiedAction` shape the browser handler expects.
  - Legacy JSON text replies are still normalized defensively for old dumps
    and mocked streams.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import structlog

from tools.prompts import attempt_completion_prompt

# Single source of truth for verifier rules. The browser prompt embeds the
# same grading block as the main agent so attempt_completion semantics do not
# drift between agent types.
from utils.prompts import VERIFICATION_RULES

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
        "description": "Wait for x seconds (no enforced cap; use sparingly).",
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
            "Scroll by pages (approximate; one 'page' is a fixed pixel amount per call, NOT a true viewport-aware page). "
            "Use down=True for scroll down, down=False for scroll up. Use index for scroll containers. "
            "For deeply long pages, you may need multiple scroll calls; pages=10 is approximate and may not actually reach the bottom/top in one call."
        ),
        "params": {
            "down": {"type": "boolean", "description": "True=scroll down, False=scroll up (default: true)", "required": True},
            "pages": {"type": "number", "description": "0.5=half page, 1=full page, 10=approximately to bottom/top (default: 1.0). Approximate; may need multiple calls."},
            "index": {"type": "integer", "description": "Optional element index to scroll within specific container"},
        },
    },
    "find_text": {
        "description": "Scroll to specific text on the page",
        "params": {"text": {"type": "string", "description": "Text to find and scroll to", "required": True}},
    },
    "dropdown_options": {
        "description": "Get all options from a native dropdown or ARIA menu",
        "params": {"index": {"type": "integer", "description": "Element index of the dropdown", "required": True}},
    },
    "select_dropdown": {
        "description": (
            "Set the option of a NATIVE HTML <select> element only. Does NOT work for ARIA/custom dropdowns "
            "(role=listbox, combobox, or any non-native widget). For custom dropdowns, click to open and "
            "click the desired option, or use `evaluate` to drive the underlying state."
        ),
        "params": {
            "index": {"type": "integer", "description": "Element index of the native <select>", "required": True},
            "text": {"type": "string", "description": "Exact text of the <option> to select", "required": True},
        },
    },
    "evaluate": {
        "description": (
            "Execute JavaScript in the live browser page context. Use for ACTIONS or LIVE DOM STATE QUERIES "
            "that page markdown cannot answer: hover, drag, custom selectors, shadow DOM traversal, reading "
            "computed styles, dispatching events, querying iframe contents. Wrap in IIFE with try-catch. "
            "NOT for extracting visible content; for that, use `extract`. NOT interchangeable with `extract`."
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
    "upload_file": {
        "description": (
            "Upload a file to a file input element. The file must be available in the session's available_files "
            "list. Find an <input type='file'> element in the DOM tree and pass its index along with the filename."
        ),
        "params": {
            "index": {"type": "integer", "description": "Element index of the <input type='file'>", "required": True},
            "filename": {"type": "string", "description": "Filename to upload (must match available_files)", "required": True},
        },
    },
    "attempt_completion": {
        "description": attempt_completion_prompt.strip(),
        "params": {},
    },
    "send_message_to_user": {
        "description": "Send a message to the user (for updates or asking for help)",
        "params": {"message": {"type": "string", "description": "Message content", "required": True}},
    },
    "request_user_assistance_for_authentication": {
        "description": (
            "Request user help signing in only after every automated auth option in the current session is exhausted. "
            "Before calling, you must have tried every saved password, email OTP if available, SMS OTP if "
            "available, the minted agent account when it has an email, and guest/anonymous completion if possible. Cookie and "
            "Steel-session auth are applied automatically before you start."
        ),
        "params": {},
    },
    "screenshot": {
        "description": (
            "Take a full-page screenshot of the current page (captures entire page, not just viewport). "
            "The screenshot is saved and returned to the orchestrating agent. "
            "Only call once per page; one call captures everything."
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


def build_browser_use_tools(available_actions: List[str]) -> List[Dict[str, Any]]:
    """Build provider-tool schemas from `BROWSER_USE_TOOLS`.

    The catalog remains the single source of truth for tool descriptions and
    argument descriptions. This helper only reshapes those strings into native
    tool schemas.
    """
    tools: List[Dict[str, Any]] = []
    for action_name in available_actions:
        tool = BROWSER_USE_TOOLS.get(action_name)
        if not tool:
            continue

        properties: Dict[str, Any] = {}
        required: List[str] = []
        for param_name, info in tool["params"].items():
            prop: Dict[str, Any] = {"type": info["type"]}
            description = info.get("description")
            if description:
                prop["description"] = description
            properties[param_name] = prop
            if info.get("required") is True:
                required.append(param_name)

        tools.append({
            "name": action_name,
            "description": tool["description"],
            "input_schema": {
                "type": "object",
                "properties": properties,
                "required": required,
                "additionalProperties": False,
            },
        })
    return tools


def build_browser_use_system_prompt(available_actions: List[str]) -> str:
    """Canonical browser-automation system prompt.

    Static across calls (no time, no URL, no per-step state, no tool list).
    The v3 spawner delegates to this builder so the Rose pool prompt and the
    v3 prompt share one source of truth; per-spawn extras (goal,
    custom_instructions, available_files) are appended below the
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY by the caller when dynamic context is
    present. Provider transforms strip the marker before sending the request.
    """
    _ = available_actions
    return f"""# Role

You are a browser automation agent. You take in a user goal and complete the goal by interacting with a browser you are exposed to via tools.

# Input

Each turn you will receive a snapshot of the current browser environment which includes:
1. Current URL, viewport size, and scroll position
2. Page stats
3. Tab information
4. DOM tree with interactive elements indexed for actions (format: [index]<type>text</type>)
5. A full-page screenshot if the screenshot tool was called on the previous turn

# Browser Rules

- Your browser is in full screen mode. No search bar or navigation bar.
- Control+L will NOT focus the address bar - use the goto action to navigate to URLs.
- Browser cookies have been injected - assume the user is logged in until proven otherwise.
- Avoid login flows unless the site forces you to login to complete your directed goal.
- Only interact with elements that have a numeric [index] assigned
- Only use indexes that are explicitly provided in the current state
- If expected elements are missing, try scrolling or waiting
- By default, only elements in the visible viewport are listed; use scroll if content is offscreen
- You can scroll by pages using the pages parameter (0.5 for half page, 2.0 for two pages)
- If you fill an input field and the action is interrupted, suggestions may have appeared

# Output Format

You must call exactly one available browser action tool. Do not write a JSON
action envelope in text; use the provided tool call.

{VERIFICATION_RULES.strip()}

# Safety Rules

- NEVER delete or close any user account
- NEVER sign legal agreements on the user's behalf (accepting Terms of Service checkboxes is acceptable)
- When making payments or posting to social media, you may be asked to confirm with the user first

# Authentication

- Use the cheapest viable authentication path for this single site.
- Priority:
  - 1. Existing Steel/cookie session
  - 2. Passkey (if one is listed in Auth Options)
  - 3. Saved passwords
  - 4. Email OTP
  - 5. SMS OTP
  - 6. Minted account
  - 7. Guest/anonymous completion, if viable
- Cookie-based and existing Steel-session auth are applied automatically before you start.
- If a passkey is listed for this site and you are not already logged in, prefer it: start the login and choose the passkey / "Sign in with a passkey" option. The passkey is pre-loaded into the browser's authenticator and signs automatically, with no code or password needed, and may complete on its own as soon as the login page loads. If passkey sign-in is offered but does not complete, fall through to the next option. A site may still require an additional OTP step after the passkey; handle that OTP normally.
- For saved passwords, type the listed ref (for example, pwd:andy@email.com) into password fields; the browser tool decrypts it and records credential usage.
- For multi-account sites, prefer the task-specific user context when present, then the freshest enabled cookie bundle.
- When a site offers OTP delivery options, prefer email over SMS.
- OTP codes from email or SMS are automatically injected as user messages into your context as soon as they become available. If no OTP code is received after 60 seconds since requested, request a resend of the OTP code. If after another 60 seconds no OTP code is received, consider that authentication route exhausted and unusable.
- If authentication blocks the task after all available automated auth options are exhausted, call request_user_assistance_for_authentication. Do not call attempt_completion, send_message_to_user, or report a status instead.
- Do not open AgentMail, webmail, or inbox websites to retrieve OTP codes."""


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
    timestamp = bs.get("timestamp") or bs.get("current_timestamp") or bs.get("current_time")
    if not timestamp:
        timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
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
        f"# Current Browser State\n\n"
        f"Timestamp: {timestamp}\n"
        f"{stats_text}Current URL: {bs.get('url', '')}{title_part}\n"
        f"Viewport: {viewport.get('width', 0)}x{viewport.get('height', 0)}\n"
        f"{scroll_text}{tabs_text}{events_text}{popups_text}"
        f"Interactive elements:\n{bs.get('dom_tree', '')}"
    )


def build_browser_state_message_content(
    *,
    task: str,
    browser_state: Dict[str, Any],
    include_screenshot: bool = True,
    include_task: bool = False,
) -> Any:
    """Build the per-turn browser-state user message content."""
    text_content = _format_browser_state_text(task, browser_state)
    display_text = f"Task: {task}\n\n{text_content}" if include_task else text_content

    screenshot = browser_state.get("screenshot")
    if screenshot and include_screenshot:
        image_url = screenshot if screenshot.startswith("http") else f"data:image/png;base64,{screenshot}"
        return [
            {"type": "text", "text": display_text},
            {"type": "image_url", "image_url": {"url": image_url}},
        ]
    return display_text


def _tool_status(message: Dict[str, Any]) -> Optional[str]:
    metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
    status = metadata.get("toolStatus") or metadata.get("tool_status")
    if isinstance(status, str):
        return status
    content = message.get("content")
    if isinstance(content, str) and content.strip().startswith("{"):
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError:
            return None
        if isinstance(parsed, dict):
            parsed_status = parsed.get("toolStatus") or parsed.get("tool_status") or parsed.get("status")
            if isinstance(parsed_status, str):
                return parsed_status
    return None


def filter_browser_turn_messages(turn_messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Drop in-progress tool rows and keep the latest tool result per call id."""
    latest_tool_index_by_id: Dict[str, int] = {}
    skipped_indexes: set[int] = set()

    for index, message in enumerate(turn_messages):
        if message.get("role") != "tool":
            continue
        status = (_tool_status(message) or "").upper()
        if status == "IN_PROGRESS":
            skipped_indexes.add(index)
            continue
        tool_call_id = message.get("tool_call_id")
        if not tool_call_id:
            continue
        tool_call_id = str(tool_call_id)
        previous = latest_tool_index_by_id.get(tool_call_id)
        if previous is not None:
            skipped_indexes.add(previous)
        latest_tool_index_by_id[tool_call_id] = index

    if not skipped_indexes:
        return list(turn_messages)
    return [message for index, message in enumerate(turn_messages) if index not in skipped_indexes]


def build_browser_use_messages(
    *,
    task: str,
    browser_state: Dict[str, Any],
    action_history: List[Dict[str, Any]],
    available_actions: List[str],
    include_screenshot: bool = True,
    extra_user_messages: Optional[List[Any]] = None,
    dynamic_system_context: Optional[str] = None,
    turn_messages: Optional[List[Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    """Build the OpenAI-style messages array for one browser-use step.

    When `turn_messages` is provided, returns a full browser-task transcript:
    `[system, optional dynamic-system, initial user goal, prior turns,
    current state]`. Legacy callers without `turn_messages` get the older
    compact single-step shape.
    """
    user_content = build_browser_state_message_content(
        task=task,
        browser_state=browser_state,
        include_screenshot=include_screenshot,
        include_task=turn_messages is None,
    )
    if turn_messages is None and isinstance(user_content, str):
        user_content = user_content + _format_action_history(action_history)
    elif turn_messages is None and isinstance(user_content, list) and user_content:
        user_content[0]["text"] = str(user_content[0].get("text", "")) + _format_action_history(action_history)

    system_content = build_browser_use_system_prompt(available_actions)
    if dynamic_system_context:
        from utils.prompts import SYSTEM_PROMPT_DYNAMIC_BOUNDARY

        system_content = system_content + SYSTEM_PROMPT_DYNAMIC_BOUNDARY + dynamic_system_context

    messages = [{"role": "system", "content": system_content}]

    if turn_messages is not None:
        messages.append({"role": "user", "content": task})
        messages.extend(filter_browser_turn_messages(turn_messages))
        messages.append({"role": "user", "content": user_content})
    else:
        messages.append({"role": "user", "content": user_content})

    state_extra_user_messages = (
        browser_state.get("_extra_user_messages")
        or browser_state.get("extra_user_messages")
        or []
    )
    merged_extra_user_messages = list(extra_user_messages or []) + list(state_extra_user_messages or [])
    for extra in merged_extra_user_messages:
        if isinstance(extra, dict):
            role = extra.get("role", "user")
            content = extra.get("content", extra.get("text", ""))
            messages.append({"role": role, "content": content})
        else:
            messages.append({"role": "user", "content": str(extra)})
    return messages


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


def normalize_browser_use_tool_call(
    tool_call: Dict[str, Any],
    *,
    thinking: Optional[str] = None,
) -> Dict[str, Any]:
    """Convert one provider-native tool call into the UnifiedAction shape."""
    name = tool_call.get("name")
    function = tool_call.get("function") if isinstance(tool_call.get("function"), dict) else {}
    if not isinstance(name, str) or not name:
        name = function.get("name")
    if not isinstance(name, str) or not name:
        raise ValueError(f"normalize_browser_use_tool_call: missing tool name in {tool_call}")

    raw_args: Any = (
        tool_call.get("arguments")
        if "arguments" in tool_call
        else tool_call.get("input")
    )
    if raw_args is None and function:
        raw_args = function.get("arguments")
    if raw_args in (None, ""):
        args: Dict[str, Any] = {}
    elif isinstance(raw_args, str):
        try:
            parsed = json.loads(raw_args)
        except json.JSONDecodeError as exc:
            raise ValueError(
                f"normalize_browser_use_tool_call: invalid JSON arguments for {name}: {raw_args[:200]}"
            ) from exc
        if not isinstance(parsed, dict):
            raise ValueError(
                f"normalize_browser_use_tool_call: arguments for {name} must decode to an object"
            )
        args = parsed
    elif isinstance(raw_args, dict):
        args = raw_args
    else:
        raise ValueError(
            f"normalize_browser_use_tool_call: unsupported arguments type for {name}: {type(raw_args).__name__}"
        )

    return normalize_browser_use_response({
        "thinking": thinking,
        "action": [{name: args}],
    })


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
    "send_message_to_user", "request_user_assistance_for_authentication",
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

    # `thinking` is the canonical field. `next_goal` is a defensive fallback for
    # older runs / pre-shrunken-envelope models that still emit it; relaxed to
    # optional and only consulted when `thinking` is absent.
    thinking = completion.get("thinking") or completion.get("next_goal")

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
    if normalized_action == "input_text" and params.get("clear") is not None:
        out["clear"] = bool(params["clear"])

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
    cookie_bundle_id = params.get("cookie_bundle_id") or params.get("cookieBundleId") or first_action.get("cookie_bundle_id")
    if cookie_bundle_id:
        out["cookie_bundle_id"] = cookie_bundle_id
    label = params.get("label") or first_action.get("label")
    if label:
        out["label"] = label
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
