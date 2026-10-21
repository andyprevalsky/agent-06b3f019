"""Structured transcript of a code agent's session (Claude Code + Codex).

The sandbox ws-server turns each CLI's stream (Claude Code ``stream-json``,
Codex ``exec --json``) into normalized ``code_agent_event`` dicts. This module
folds those events into the compact records a coding-agent UI shows:

    goal / user turn ──► user        "You → Claude: …"
    thinking block   ──► thinking    collapsible; Claude Code may omit the text
    assistant text   ──► assistant
    tool_use+result  ──► tool        Read (lines) / Edit (+a −r) / Run (✓/✗ exit N)
    result / final   ──► result
    error            ──► error
    direct_chat      ──► control     the user took over / handed back

Records are upserts: a tool row appears ``running`` and is re-emitted with the
same ``id`` and a higher ``rev`` when its result lands. Ids derive from CLI ids
(``tool_use_id`` / Codex ``item_id``) or the event's index in the sandbox's
append-only history, so replaying the same events yields the same records.

Record schema (``version`` 1, every record)::

    id: str           stable within the session
    rev: int          1 on first emit, +1 on each update
    seq: int          index of the event that created the record (sort key)
    kind: "user" | "thinking" | "assistant" | "tool" | "result" | "error" | "control"
    provider: "claude" | "codex"
    at: str | None    ISO timestamp of the latest contributing event
    text: str         body (may be empty for redacted thinking)

    user:      sender ("user" | "agent"), turn_id (None for the goal)
    thinking:  redacted (bool), tokens (int | None, Claude's estimate)
    tool:      category ("read" | "edit" | "run" | "search" | "other"),
               name (CLI tool name, "command" / "file_change" for Codex),
               status ("running" | "ok" | "error"), title (one line),
               path, paths, command, lines, added, removed, exit_code,
               output (preview), output_chars, output_truncated
    result:    status ("completed" | "failed")
    control:   event ("held" | "released"), reason
"""

import re
from typing import Any, Literal, Optional, TypedDict, cast

TRANSCRIPT_VERSION = 1
# Compact rows: the Terminal tab and the persisted terminal transcript keep the
# full output; a row shows the tail a user scans for the failure.
TOOL_OUTPUT_PREVIEW_CHARS = 4000

RecordKind = Literal["user", "thinking", "assistant", "tool", "result", "error", "control", "turn", "metrics"]

_READ_TOOLS = frozenset({"Read", "NotebookRead"})
_EDIT_TOOLS = frozenset({"Edit", "MultiEdit", "Write", "NotebookEdit"})
_RUN_TOOLS = frozenset({"Bash", "BashOutput"})
_SEARCH_TOOLS = frozenset({"Grep", "Glob", "LS", "WebSearch", "WebFetch", "ToolSearch"})
_EXIT_CODE_RE = re.compile(r"^(?:Error: )?Exit code (\d+)")


class TranscriptRecord(TypedDict, total=False):
    id: str
    rev: int
    seq: int
    kind: RecordKind
    provider: str
    at: Optional[str]
    text: str
    sender: str
    turn_id: Optional[str]
    client_message_id: Optional[str]
    turn_started_at: Optional[str]
    turn_ended_at: Optional[str]
    turn_outcome: Optional[str]
    activity_kind: str
    partial: bool
    attachments: list[Any]
    output_tokens: int
    input_tokens: int
    cached_input_tokens: int
    usage_scope: str
    redacted: bool
    tokens: Optional[int]
    category: str
    name: str
    status: str
    title: str
    path: Optional[str]
    paths: list[str]
    command: Optional[str]
    lines: Optional[int]
    added: Optional[int]
    removed: Optional[int]
    exit_code: Optional[int]
    output: str
    output_chars: int
    output_truncated: bool
    event: str
    reason: Optional[str]


def _tool_category(name: str) -> str:
    if name in _READ_TOOLS:
        return "read"
    if name in _EDIT_TOOLS:
        return "edit"
    if name in _RUN_TOOLS:
        return "run"
    if name in _SEARCH_TOOLS:
        return "search"
    return "other"


def _preview(text: str) -> tuple[str, int, bool]:
    if len(text) <= TOOL_OUTPUT_PREVIEW_CHARS:
        return text, len(text), False
    return text[-TOOL_OUTPUT_PREVIEW_CHARS:], len(text), True


def _patch_counts(patch: Any) -> tuple[Optional[int], Optional[int]]:
    """(+added, −removed) lines from Claude Code's ``structuredPatch`` hunks."""
    if not isinstance(patch, list):
        return None, None
    added = removed = 0
    for hunk in patch:
        for line in (hunk or {}).get("lines") or []:
            if isinstance(line, str) and line.startswith("+"):
                added += 1
            elif isinstance(line, str) and line.startswith("-"):
                removed += 1
    return added, removed


def _one_line(value: Any, limit: int = 240) -> str:
    return " ".join(str(value or "").split())[:limit]


def _short_path(path: Optional[str]) -> Optional[str]:
    if not path:
        return path
    for prefix in ("/home/user/workspace/", "/home/user/"):
        if path.startswith(prefix):
            return path[len(prefix) :]
    return path


def _tool_title(name: str, tool_input: dict[str, Any]) -> tuple[str, Optional[str], Optional[str]]:
    """(title, path, command) for a Claude Code tool_use input."""
    path = next(
        (tool_input[key] for key in ("file_path", "notebook_path", "path") if isinstance(tool_input.get(key), str)),
        None,
    )
    command = tool_input.get("command") if isinstance(tool_input.get("command"), str) else None
    if command:
        return _one_line(command), path, command
    if path:
        return _short_path(path) or path, path, None
    for key in ("pattern", "query", "url", "description", "prompt"):
        if isinstance(tool_input.get(key), str) and tool_input[key].strip():
            return _one_line(tool_input[key]), path, None
    return name, path, None


class CodeTranscriptBuilder:
    """Folds normalized sandbox events into transcript record upserts.

    ``feed(event, index)`` returns the records created or changed by that
    event (full records, latest ``rev``). Feed every event of a session in
    order; the caller decides which upserts it still has to persist.
    """

    def __init__(self, provider: str, goal: Optional[str] = None) -> None:
        self.provider = provider if provider in ("claude", "codex") else "claude"
        self._records: dict[str, dict[str, Any]] = {}
        self._order: list[str] = []
        self._pending_tools: list[str] = []  # tool record ids awaiting a result (FIFO fallback)
        self._open_commands: dict[str, str] = {}  # Codex command text → record id (no item_id)
        self._thinking_tokens: Optional[int] = None
        self._goal = goal.strip() if isinstance(goal, str) and goal.strip() else None
        self._goal_emitted = False
        self._turn_context: dict[str, Any] = {}
        self._event_context: dict[str, Any] = {}

    # -- public -------------------------------------------------------------

    @property
    def records(self) -> list[TranscriptRecord]:
        return [cast(TranscriptRecord, dict(self._records[record_id])) for record_id in self._order]

    def feed(self, event: dict[str, Any], index: int) -> list[TranscriptRecord]:
        if not isinstance(event, dict):
            return []
        self._event_context = {
            key: event[key] for key in ("turn_id", "turn_started_at", "turn_ended_at", "turn_outcome")
            if isinstance(event.get(key), str)
        }
        if event.get("type") == "turn_started":
            self._turn_context = dict(self._event_context)
        out: list[TranscriptRecord] = []
        if not self._goal_emitted and self._goal is not None:
            self._goal_emitted = True
            out.append(
                self._upsert(
                    "goal",
                    index,
                    event.get("timestamp"),
                    kind="user",
                    text=self._goal,
                    sender="agent",
                    turn_id=None,
                )
            )
        handler = getattr(self, f"_on_{event.get('type')}", None)
        if handler is not None:
            out.extend(record for record in handler(event, index) if record is not None)
        if event.get("type") == "turn_ended":
            self._turn_context = {}
        return out

    # -- record helpers -----------------------------------------------------

    def _upsert(self, key: str, index: int, at: Any, **fields: Any) -> TranscriptRecord:
        record = self._records.get(key)
        if record is None:
            record = {"id": key, "rev": 0, "seq": index, "provider": self.provider, "at": None}
            self._records[key] = record
            self._order.append(key)
        record.update(self._turn_context)
        record.update(self._event_context)
        record.update(fields)
        record["rev"] = int(record.get("rev") or 0) + 1
        record["at"] = at if isinstance(at, str) else record.get("at")
        return cast(TranscriptRecord, dict(record))

    # -- shared events ------------------------------------------------------

    def _on_user_turn(self, event: dict[str, Any], index: int) -> list[Optional[TranscriptRecord]]:
        text = event.get("text")
        attachments = event.get("attachments") if isinstance(event.get("attachments"), list) else []
        if not isinstance(text, str) or not text.strip():
            names = [item.rsplit("/", 1)[-1] if isinstance(item, str) else str(item.get("name") or "attachment") for item in attachments if isinstance(item, (str, dict))]
            if not names:
                return []
            text = "Attached: " + ", ".join(names)
        turn_id = event.get("turn_id") if isinstance(event.get("turn_id"), str) else None
        client_message_id = event.get("client_message_id") if isinstance(event.get("client_message_id"), str) else turn_id
        sender = "agent" if event.get("sender") == "agent" else "user"
        return [
            self._upsert(
                f"turn:{client_message_id or index}",
                index,
                event.get("timestamp"),
                kind="user",
                text=text,
                sender=sender,
                turn_id=turn_id,
                client_message_id=client_message_id,
                attachments=attachments,
            )
        ]

    def _on_usage(self, event: dict[str, Any], index: int) -> list[Optional[TranscriptRecord]]:
        fields = {key: event[key] for key in ("output_tokens", "input_tokens", "cached_input_tokens")
                  if isinstance(event.get(key), (int, float)) and not isinstance(event.get(key), bool) and event[key] >= 0}
        if not fields:
            return []
        return [self._upsert(f"metrics:{event.get('turn_id') or 'session'}:{index}", index, event.get("timestamp"),
                            kind="metrics", text="", usage_scope=event.get("usage_scope"), **fields)]

    def _on_turn_started(self, event: dict[str, Any], index: int) -> list[Optional[TranscriptRecord]]:
        turn_id = event.get("turn_id")
        if not isinstance(turn_id, str):
            return []
        return [self._upsert(f"lifecycle:{turn_id}", index, event.get("timestamp"), kind="turn", event="started", text="")]

    def _on_turn_ended(self, event: dict[str, Any], index: int) -> list[Optional[TranscriptRecord]]:
        turn_id = event.get("turn_id")
        if not isinstance(turn_id, str):
            return []
        return [self._upsert(f"lifecycle:{turn_id}", index, event.get("timestamp"), kind="turn", event="ended", text="")]

    def _on_direct_chat(self, event: dict[str, Any], index: int) -> list[Optional[TranscriptRecord]]:
        status = event.get("status")
        if status not in ("held", "released"):
            return []
        reason = event.get("reason") if isinstance(event.get("reason"), str) else None
        text = "You took over this session" if status == "held" else "Handed back to Rose"
        return [
            self._upsert(
                f"control:{index}",
                index,
                event.get("timestamp"),
                kind="control",
                text=text,
                event=status,
                reason=reason,
            )
        ]

    def _on_thinking(self, event: dict[str, Any], index: int) -> list[Optional[TranscriptRecord]]:
        text = event.get("text") if isinstance(event.get("text"), str) else ""
        key = f"item:{event['item_id']}" if isinstance(event.get("item_id"), str) else f"thinking:{index}"
        tokens, self._thinking_tokens = self._thinking_tokens, None
        return [
            self._upsert(
                key,
                index,
                event.get("timestamp"),
                kind="thinking",
                text=text,
                redacted=bool(event.get("redacted")) or not text,
                tokens=tokens,
                partial=event.get("partial") is True,
            )
        ]

    def _on_cli_message(self, event: dict[str, Any], index: int) -> list[Optional[TranscriptRecord]]:
        message = event.get("cli_message")
        if (
            isinstance(message, dict)
            and message.get("type") == "system"
            and message.get("subtype") == "thinking_tokens"
        ):
            estimated = message.get("estimated_tokens")
            if isinstance(estimated, int):
                self._thinking_tokens = estimated
        return []

    def _on_agent_message(self, event: dict[str, Any], index: int) -> list[Optional[TranscriptRecord]]:
        text = event.get("text")
        if not isinstance(text, str) or not text.strip():
            return []
        key = f"item:{event['item_id']}" if isinstance(event.get("item_id"), str) else f"assistant:{index}"
        return [self._upsert(key, index, event.get("timestamp"), kind="assistant", text=text, partial=event.get("partial") is True)]

    def _on_result(self, event: dict[str, Any], index: int) -> list[Optional[TranscriptRecord]]:
        status = "completed" if event.get("status") == "completed" else "failed"
        text = event.get("text") if isinstance(event.get("text"), str) else ""
        return [self._upsert(f"result:{index}", index, event.get("timestamp"), kind="result", text=text, status=status)]

    def _on_final(self, event: dict[str, Any], index: int) -> list[Optional[TranscriptRecord]]:
        # Claude reports its outcome in `result`; Codex only in `final`.
        if self.provider != "codex":
            return []
        status = "completed" if event.get("status") == "completed" else "failed"
        exit_code = event.get("exit_code")
        text = "Finished" if status == "completed" else f"Exited with code {exit_code}"
        return [self._upsert(f"result:{index}", index, event.get("timestamp"), kind="result", text=text, status=status)]

    def _on_error(self, event: dict[str, Any], index: int) -> list[Optional[TranscriptRecord]]:
        message = event.get("message")
        if not isinstance(message, str) or not message.strip():
            return []
        return [self._upsert(f"error:{index}", index, event.get("timestamp"), kind="error", text=message.strip())]

    # -- Claude Code --------------------------------------------------------

    def _on_tool_use(self, event: dict[str, Any], index: int) -> list[Optional[TranscriptRecord]]:
        name = event.get("tool") if isinstance(event.get("tool"), str) else "tool"
        tool_input = event.get("input") if isinstance(event.get("input"), dict) else {}
        tool_use_id = event.get("tool_use_id") if isinstance(event.get("tool_use_id"), str) else None
        key = f"tool:{tool_use_id}" if tool_use_id else f"tool:{index}"
        title, path, command = _tool_title(name, tool_input)
        if key not in self._pending_tools:
            self._pending_tools.append(key)
        return [
            self._upsert(
                key,
                index,
                event.get("timestamp"),
                kind="tool",
                text=title,
                category=_tool_category(name),
                name=name,
                status="running",
                title=title,
                path=path,
                command=command,
            )
        ]

    def _on_tool_result(self, event: dict[str, Any], index: int) -> list[Optional[TranscriptRecord]]:
        tool_use_id = event.get("tool_use_id") if isinstance(event.get("tool_use_id"), str) else None
        key = f"tool:{tool_use_id}" if tool_use_id else None
        if key is None or key not in self._records:
            # Sandboxes predating `tool_use_id` on results: pair FIFO.
            key = self._pending_tools[0] if self._pending_tools else None
        if key is None:
            return []
        if key in self._pending_tools:
            self._pending_tools.remove(key)
        record = self._records[key]
        result = event.get("tool_use_result")
        is_error = event.get("is_error") is True or (isinstance(result, str) and result.startswith("Error"))
        fields: dict[str, Any] = {"status": "error" if is_error else "ok"}
        name = record.get("name", "")
        category = record.get("category")

        output = ""
        if isinstance(result, dict):
            if isinstance(result.get("stdout"), str) or isinstance(result.get("stderr"), str):
                output = "\n".join(part for part in (result.get("stdout"), result.get("stderr")) if part)
            file_info = result.get("file") if isinstance(result.get("file"), dict) else None
            if category == "read" and file_info is not None:
                lines = file_info.get("numLines")
                fields["lines"] = lines if isinstance(lines, int) else None
            if category == "edit":
                added, removed = _patch_counts(result.get("structuredPatch"))
                if result.get("type") == "create" and isinstance(result.get("content"), str):
                    added, removed = len(result["content"].splitlines()), 0
                fields["added"], fields["removed"] = added, removed
        elif isinstance(result, str):
            output = result

        if category == "run":
            match = _EXIT_CODE_RE.match(output) if is_error else None
            if match:
                fields["exit_code"] = int(match.group(1))
            elif not is_error and not (isinstance(result, dict) and result.get("interrupted")):
                fields["exit_code"] = 0
            else:
                fields["exit_code"] = None
        if output and (category == "run" or is_error or name not in _READ_TOOLS):
            preview, total, truncated = _preview(output)
            fields.update(output=preview, output_chars=total, output_truncated=truncated)
        return [self._upsert(key, record["seq"], event.get("timestamp"), **fields)]

    # -- Codex --------------------------------------------------------------

    def _on_command(self, event: dict[str, Any], index: int) -> list[Optional[TranscriptRecord]]:
        command = event.get("command") if isinstance(event.get("command"), str) else ""
        item_id = event.get("item_id") if isinstance(event.get("item_id"), str) else None
        title = _one_line(command)
        if event.get("status") == "started":
            key = f"item:{item_id}" if item_id else f"command:{index}"
            if not item_id:
                self._open_commands[command] = key
            return [
                self._upsert(
                    key,
                    index,
                    event.get("timestamp"),
                    kind="tool",
                    text=title,
                    category="run",
                    name="command",
                    status="running",
                    title=title,
                    path=None,
                    command=command,
                )
            ]
        key = f"item:{item_id}" if item_id else self._open_commands.pop(command, f"command:{index}")
        exit_code = event.get("exit_code") if isinstance(event.get("exit_code"), int) else None
        preview, total, truncated = _preview(event.get("output") if isinstance(event.get("output"), str) else "")
        seq = self._records[key]["seq"] if key in self._records else index
        return [
            self._upsert(
                key,
                seq,
                event.get("timestamp"),
                kind="tool",
                text=title,
                category="run",
                name="command",
                status="ok" if exit_code == 0 else "error",
                title=title,
                path=None,
                command=command,
                exit_code=exit_code,
                output=preview,
                output_chars=total,
                output_truncated=truncated,
            )
        ]

    def _on_file_change(self, event: dict[str, Any], index: int) -> list[Optional[TranscriptRecord]]:
        changes = [change for change in event.get("changes") or [] if isinstance(change, dict)]
        paths = [change["path"] for change in changes if isinstance(change.get("path"), str)]
        kinds = sorted({str(change.get("kind") or "update") for change in changes})
        item_id = event.get("item_id") if isinstance(event.get("item_id"), str) else None
        key = f"item:{item_id}" if item_id else f"file_change:{index}"
        shown = ", ".join(_short_path(path) or path for path in paths[:3]) or "files"
        more = f" (+{len(paths) - 3} more)" if len(paths) > 3 else ""
        title = f"{'/'.join(kinds)} {shown}{more}".strip()
        return [
            self._upsert(
                key,
                index,
                event.get("timestamp"),
                kind="tool",
                text=title,
                category="edit",
                name="file_change",
                status="ok" if event.get("status") in (None, "completed") else "error",
                title=title,
                path=paths[0] if paths else None,
                paths=paths,
                command=None,
                # Codex reports which files changed, not line counts.
                added=None,
                removed=None,
            )
        ]


def build_code_transcript(
    events: list[dict[str, Any]],
    provider: str,
    goal: Optional[str] = None,
) -> list[TranscriptRecord]:
    """Final records for a whole event history (latest rev of each record)."""
    builder = CodeTranscriptBuilder(provider, goal=goal)
    for index, event in enumerate(events):
        builder.feed(event, index)
    return builder.records


def _provider_label(provider: str) -> str:
    return "Codex" if provider == "codex" else "Claude"


def render_transcript_text(records: list[TranscriptRecord]) -> str:
    """Plain-text rendering, one line per record (message text, tree grep)."""
    lines: list[str] = []
    for record in records:
        label = _provider_label(str(record.get("provider")))
        kind = record.get("kind")
        text = str(record.get("text") or "")
        if kind == "user":
            who = "Agent" if record.get("sender") == "agent" else "You"
            lines.append(f"[{who} → {label}] {text}")
        elif kind == "thinking":
            lines.append(f"[Thinking] {text}".rstrip())
        elif kind == "assistant":
            lines.append(f"[{label}] {text}")
        elif kind == "tool":
            status = record.get("status")
            mark = "…" if status == "running" else ("✓" if status == "ok" else "✗")
            name = str(record.get("name") or "tool")
            title = str(record.get("title") or "")
            detail = ""
            if record.get("category") == "edit" and record.get("added") is not None:
                detail = f" +{record.get('added')} −{record.get('removed')}"
            elif record.get("category") == "read" and record.get("lines") is not None:
                detail = f" ({record.get('lines')} lines)"
            elif record.get("category") == "run" and record.get("exit_code") is not None:
                detail = f" exit {record.get('exit_code')}"
            lines.append(f"[{name} {mark}] {title}{detail}")
        elif kind == "result":
            lines.append(f"[Result {record.get('status')}] {text}")
        elif kind == "error":
            lines.append(f"[Error] {text}")
        elif kind == "control":
            lines.append(f"[{text}]")
    return "\n".join(lines)


_UI_TOOL_NAMES = {"read": "Read", "edit": "Edit", "run": "Run"}


def to_ui_record(record: TranscriptRecord) -> dict[str, Any]:
    """The persisted/broadcast shape the UI's Transcript tab renders.

    UI contract (agreed with the UI thread, 2026-10-20)::

        {type: 'thinking'|'message'|'tool', ts, text?,
         tool?: {name: 'Read'|'Edit'|'Run'|string, target, added?, removed?, result?}}

    plus upsert keys (``id``, ``rev``, ``seq``), ``provider``, and the extra
    types ``result`` / ``error`` / ``control`` that a renderer may skip.
    """
    kind = record.get("kind")
    out: dict[str, Any] = {
        "id": record.get("id"),
        "rev": record.get("rev"),
        "seq": record.get("seq"),
        "provider": record.get("provider"),
        "ts": record.get("at"),
    }
    for key in ("turn_id", "client_message_id", "turn_started_at", "turn_ended_at", "turn_outcome", "partial", "attachments"):
        if key in record:
            out[key] = record[key]
    text = record.get("text")
    if kind in ("assistant", "user"):
        out.update(type="message", role="assistant" if kind == "assistant" else "user", text=text or "")
        if kind == "user":
            out.update(sender=record.get("sender"), turn_id=record.get("turn_id"))
    elif kind == "thinking":
        out.update(type="thinking", text=text or "", redacted=bool(record.get("redacted")), tokens=record.get("tokens"))
    elif kind == "tool":
        category = str(record.get("category") or "other")
        raw_name = str(record.get("name") or "tool")
        if category == "run":
            target = record.get("command") or record.get("title")
        elif category in ("read", "edit"):
            target = _short_path(record.get("path")) or record.get("title")
        else:
            target = record.get("title")
        result: dict[str, Any] = {"status": record.get("status")}
        for key in ("exit_code", "lines", "output", "output_chars", "output_truncated"):
            if record.get(key) is not None:
                result[key] = record.get(key)
        tool: dict[str, Any] = {
            "name": _UI_TOOL_NAMES.get(category, raw_name),
            "target": target,
            "raw_name": raw_name,
            "category": category,
            "activity_kind": "web" if raw_name in ("WebSearch", "WebFetch") else "exec" if category == "run" else category,
            "result": result,
        }
        if category == "edit":
            tool.update(added=record.get("added"), removed=record.get("removed"))
        if record.get("paths"):
            tool["paths"] = record.get("paths")
        out.update(type="tool", text=record.get("title") or "", tool=tool)
    elif kind == "metrics":
        out.update(type="metrics", usage_scope=record.get("usage_scope"))
        for key in ("output_tokens", "input_tokens", "cached_input_tokens"):
            if key in record:
                out[key] = record[key]
    elif kind == "turn":
        out.update(type="turn", event=record.get("event"), text="")
    elif kind == "result":
        out.update(type="result", text=text or "", status=record.get("status"))
    elif kind == "error":
        out.update(type="error", text=text or "")
    elif kind == "control":
        out.update(type="control", text=text or "", event=record.get("event"), reason=record.get("reason"))
    return out
