#!/usr/bin/env python3
"""Render the 9 Claude Code prompts that the parallel agent didn't reach.

Strategy: read each source file, extract the relevant template literal(s),
and statically substitute `${...}` interpolations with realistic placeholders.
This produces what the LLM effectively sees, without requiring claude-code-src
to be buildable.

Re-runnable.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SRC = ROOT / "claude-code-src" / "src"
OUT = ROOT / "prompt-review" / "rendered" / "claude-code-src"
OUT.mkdir(parents=True, exist_ok=True)


def write(idx: str, text: str) -> None:
    existing = OUT / f"{idx}.txt"
    if idx == "claude_getSystemPrompt" and existing.exists() and existing.read_text().strip():
        print(f"  -> {idx} (kept runtime-rendered file)")
        return
    (OUT / f"{idx}.txt").write_text(text)
    print(f"  ✓ {idx} ({len(text)} chars)")


def unescape(s: str) -> str:
    """Unescape a JS template-literal body to its runtime string content."""
    s = s.replace("\\`", "`")
    # Decode \uXXXX escapes (these come through when extracting from raw source).
    s = re.sub(r"\\u([0-9A-Fa-f]{4})", lambda m: chr(int(m.group(1), 16)), s)
    return s


def extract_template_literal(text: str, start_marker: str) -> str:
    """Find `start_marker` in text, then capture the next backtick literal body.

    Tracks `${...}` interpolations so a nested `}` inside doesn't break out.
    """
    i = text.find(start_marker)
    if i == -1:
        raise ValueError(f"start_marker not found: {start_marker[:40]}…")
    # Walk to first unescaped backtick.
    j = i + len(start_marker)
    while j < len(text) and text[j] != "`":
        j += 1
    if j >= len(text):
        raise ValueError("no opening backtick after marker")
    j += 1
    body: list[str] = []
    interp_depth = 0
    while j < len(text):
        ch = text[j]
        if ch == "\\" and j + 1 < len(text):
            body.append(text[j:j + 2])
            j += 2
            continue
        if interp_depth == 0 and ch == "`":
            return unescape("".join(body))
        if ch == "$" and j + 1 < len(text) and text[j + 1] == "{":
            interp_depth += 1
            body.append(text[j:j + 2])
            j += 2
            continue
        if interp_depth > 0 and ch == "}":
            interp_depth -= 1
        body.append(ch)
        j += 1
    raise ValueError("unterminated template literal")


# Default `${VAR}` substitutions used across multiple files. Aim for realistic
# values so the rendered prompt reads as production-like as possible.
GLOBAL_SUBS: dict[str, str] = {
    # Tool name constants
    "BASH_TOOL_NAME": "Bash",
    "AGENT_TOOL_NAME": "Agent",
    "TASK_TOOL_NAME": "TodoWrite",
    "taskToolName": "TodoWrite",
    "FILE_WRITE_TOOL_NAME": "Write",
    "FILE_READ_TOOL_NAME": "Read",
    "FILE_EDIT_TOOL_NAME": "Edit",
    "GREP_TOOL_NAME": "Grep",
    "GLOB_TOOL_NAME": "Glob",
    "ASK_USER_QUESTION_TOOL_NAME": "AskUserQuestion",
    "SKILL_TOOL_NAME": "Skill",
    "SLEEP_TOOL_NAME": "Sleep",
    "BRIEF_TOOL_NAME": "SendUserMessage",
    # BRIEF_PROACTIVE_SECTION is a multi-line constant defined in
    # BriefTool/prompt.ts. We resolve it dynamically below — see
    # the assignment after GLOBAL_SUBS is declared. (The placeholder here
    # is overwritten before any substitution runs.)
    "BRIEF_PROACTIVE_SECTION": "",
    "WEB_FETCH_TOOL_NAME": "WebFetch",
    "WEB_SEARCH_TOOL_NAME": "WebSearch",
    "NOTEBOOK_EDIT_TOOL_NAME": "NotebookEdit",
    "TASK_CREATE_TOOL_NAME": "TaskCreate",
    "TASK_GET_TOOL_NAME": "TaskGet",
    "TASK_LIST_TOOL_NAME": "TaskList",
    "TASK_STOP_TOOL_NAME": "TaskStop",
    "ENTER_PLAN_MODE_TOOL_NAME": "EnterPlanMode",
    "EXIT_PLAN_MODE_TOOL_NAME": "ExitPlanMode",
    "ENTER_WORKTREE_TOOL_NAME": "EnterWorktree",
    "EXIT_WORKTREE_TOOL_NAME": "ExitWorktree",
    "POWERSHELL_TOOL_NAME": "PowerShell",
    # Tags
    "TICK_TAG": "tick",
    "MAIN_QUERY_TAG": "main_query",
    "ENV_TAG": "env",
    "COMMAND_NAME_TAG": "command-name",
    # Agent / search
    "EXPLORE_AGENT.agentType": "general-purpose",
    "EXPLORE_AGENT_MIN_QUERIES": "4",
    "VERIFICATION_AGENT_TYPE": "verification",
    "searchTools": "Glob, Grep, Read",
    # Runtime
    "shellName": "zsh",
    "languagePreference": "English",
    "getCwd()": "/path/to/project",
    "getSessionStartDate()": "2026-05-04",
    "marketingName": "Claude Sonnet 4.6",
    "modelId": "claude-sonnet-4-6",
    "PRODUCT_NAME": "Claude Code",
    "PROJECT_DOC_PATH": "CLAUDE.md",
    "FRONTIER_MODEL_NAME": "Claude Sonnet 4.6",
    # Memory
    "MEMORY_DIR_NAME": "memory",
    "MEMORY_INDEX_NAME": "MEMORY.md",
    "memoryDir": "<MEMORY_DIR>",
    "memoryIndex": "<MEMORY_INDEX_PATH>",
    "newMessageCount": "50",
    "existingMemories": "<existing memory files (or empty if none)>",
    # Compact
    "DETAILED_ANALYSIS_INSTRUCTION_BASE": "<DETAILED_ANALYSIS_INSTRUCTION_BASE>",
    # MagicDocs / Session Memory placeholders. Use `{{...}}` to match the
    # runtime substituteVariables() syntax those prompts already use, so the
    # rendered output is consistent with the actual {{docPath}} convention.
    "docPath": "{{docPath}}",
    "currentContent": "{{currentContent}}",
    "userMessage": "{{userMessage}}",
    "fileChanges": "{{fileChanges}}",
    "diffSnippet": "{{diffSnippet}}",
    "instructions": "{{customInstructions}}",
    "userTimezone": "America/Chicago",
    "MAX_SECTION_LENGTH": "2000",
    # Misc dynamic sections
    "scratchpadDir": "/var/folders/.../scratch",
    "instructionBlocks": "<DYNAMIC_INSTRUCTION_BLOCKS>",
    "additionalDirsInfo": "",
    "config.keepRecent": "20",
    "skillsSection": "<SKILLS_SECTION>",
    "memorySection": "<MEMORY_SECTION>",
    "envSection": "<ENV_SECTION>",
    "agentDefinitionsSection": "<AGENT_DEFINITIONS>",
    "configToolsSection": "<CONFIG_TOOLS>",
    "userInstructions": "<USER_INSTRUCTIONS>",
    "agentInstructions": "<AGENT_INSTRUCTIONS>",
}


def _resolve_expr(expr: str, table: dict[str, str]) -> str:
    """Resolve a `${...}` interpolation expression to its substituted value.

    Strategies (first match wins):
      1. Direct table lookup of the trimmed expression.
      2. Ternary `COND ? TRUTHY : FALSY` — pick TRUTHY (production-typical),
         then recursively substitute its inner `${...}` references.
      3. Simple `X || 'fallback'` / `X ?? 'fallback'` — use X.
      4. Fallback: `<expr>` so the reviewer can see the unresolved spot.
    """
    e = expr.strip()
    if e in table:
        return table[e]

    # Ternary: COND ? T : F. Recurse on T (the truthy branch — most realistic).
    if "?" in e and ":" in e:
        # Find the FIRST `?` that isn't inside a string/parens.
        depth = 0
        in_str = False
        str_ch = ""
        for k, ch in enumerate(e):
            if in_str:
                if ch == "\\":
                    continue
                if ch == str_ch:
                    in_str = False
                continue
            if ch in ('"', "'", "`"):
                in_str = True
                str_ch = ch
            elif ch in "([{":
                depth += 1
            elif ch in ")]}":
                depth -= 1
            elif ch == "?" and depth == 0:
                # Skip JS optional-chaining `?.` and nullish-coalescing `??`.
                if k + 1 < len(e) and e[k + 1] in ".?":
                    continue
                # find matching ":" at the same depth, also tracking strings
                depth2 = 0
                in_str2 = False
                str_ch2 = ""
                for j in range(k + 1, len(e)):
                    c2 = e[j]
                    if in_str2:
                        if c2 == "\\":
                            continue
                        if c2 == str_ch2:
                            in_str2 = False
                        continue
                    if c2 in ('"', "'", "`"):
                        in_str2 = True
                        str_ch2 = c2
                    elif c2 in "([{":
                        depth2 += 1
                    elif c2 in ")]}":
                        depth2 -= 1
                    elif c2 == ":" and depth2 == 0:
                        truthy = e[k + 1:j].strip()
                        # Strip wrapping backticks from a template literal branch.
                        if truthy.startswith("`") and truthy.endswith("`"):
                            truthy = truthy[1:-1]
                        # Recursively substitute any inner ${...} in the truthy branch.
                        return substitute_placeholders(truthy, table)
                break  # we found `?` but no matching `:` — give up

    # Logical fallback: `X || 'lit'` / `X ?? 'lit'` → use X
    m = re.match(r"^([A-Za-z_][\w.]*)\s*(?:\|\||\?\?)\s*", e)
    if m and m.group(1) in table:
        return table[m.group(1)]

    return f"<{e}>"


def substitute_placeholders(s: str, mapping: dict[str, str] | None = None) -> str:
    """Replace `${expr}` template-literal interpolations with mapping[expr] or <expr>."""
    table: dict[str, str] = {**GLOBAL_SUBS, **(mapping or {})}
    out = []
    i = 0
    while i < len(s):
        if s[i] == "$" and i + 1 < len(s) and s[i + 1] == "{":
            # find matching `}` with depth + string tracking
            depth = 1
            k = i + 2
            in_str = False
            str_ch = ""
            while k < len(s) and depth > 0:
                ch = s[k]
                if in_str:
                    if ch == "\\":
                        k += 2
                        continue
                    if ch == str_ch:
                        in_str = False
                    k += 1
                    continue
                if ch in ('"', "'", "`"):
                    in_str = True
                    str_ch = ch
                elif ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                k += 1
            if depth != 0:
                out.append(s[i])
                i += 1
                continue
            expr = s[i + 2:k - 1]
            out.append(_resolve_expr(expr, table))
            i = k
            continue
        out.append(s[i])
        i += 1
    return "".join(out)


def render_via_concat(file_path: Path, min_len: int = 30, *, allow_single_quoted: bool = True) -> str:
    """Concatenate all template literals + relevant string-array entries in a file.

    Bug fixes from verification:
    - Track nested `${...}` interpolations so embedded `}` doesn't terminate early
    - Skip module-path string literals (relative imports masquerading as prose)
    - Handle `\\'` escapes inside single-quoted strings
    - Apply GLOBAL_SUBS to every captured literal
    """
    src = file_path.read_text()
    blocks: list[str] = []

    # Template literals (tracking ${...} nesting + escapes)
    i = 0
    while i < len(src):
        if src[i] == "`":
            j = i + 1
            depth = 0  # ${...} nesting
            while j < len(src):
                if src[j] == "\\" and j + 1 < len(src):
                    j += 2
                    continue
                if src[j] == "$" and j + 1 < len(src) and src[j + 1] == "{":
                    depth += 1
                    j += 2
                    continue
                if depth > 0 and src[j] == "}":
                    depth -= 1
                    j += 1
                    continue
                if depth == 0 and src[j] == "`":
                    body = src[i + 1:j]
                    if len(body) >= min_len:
                        blocks.append(substitute_placeholders(unescape(body)))
                    i = j + 1
                    break
                j += 1
            else:
                break
        else:
            i += 1

    if allow_single_quoted:
        # Walk source as a tokenizer to capture single- AND double-quoted
        # strings without crossing string boundaries. Backtick content was
        # already captured earlier in this function and is skipped here.
        i = 0
        n = len(src)
        while i < n:
            ch = src[i]
            # Skip backtick literals (already captured above)
            if ch == "`":
                i += 1
                while i < n:
                    if src[i] == "\\" and i + 1 < n:
                        i += 2
                        continue
                    if src[i] == "`":
                        i += 1
                        break
                    i += 1
                continue
            # Skip line comments (// ...)
            if ch == "/" and i + 1 < n and src[i + 1] == "/":
                while i < n and src[i] != "\n":
                    i += 1
                continue
            # Skip block comments (/* ... */)
            if ch == "/" and i + 1 < n and src[i + 1] == "*":
                i += 2
                while i + 1 < n and not (src[i] == "*" and src[i + 1] == "/"):
                    i += 1
                i += 2
                continue
            if ch in ("'", '"'):
                quote = ch
                start = i + 1
                i += 1
                while i < n:
                    if src[i] == "\\" and i + 1 < n:
                        i += 2
                        continue
                    if src[i] == quote:
                        body = src[start:i]
                        i += 1
                        if len(body) < min_len:
                            break
                        unescaped = (
                            body.replace("\\'", "'").replace('\\"', '"')
                                .replace("\\n", "\n").replace("\\t", "\t")
                                .replace("\\\\", "\\")
                        )
                        unescaped = re.sub(
                            r"\\u([0-9A-Fa-f]{4})",
                            lambda m: chr(int(m.group(1), 16)),
                            unescaped,
                        )
                        if " " not in unescaped:
                            break
                        if re.match(r"^\.{0,2}/", unescaped) or unescaped.endswith((".js", ".ts", ".tsx")):
                            break
                        blocks.append(substitute_placeholders(unescaped))
                        break
                    if src[i] == "\n":
                        # unterminated, bail
                        break
                    i += 1
                continue
            i += 1

    # Deduplicate by first-90-chars fingerprint. The whole-file concat
    # picks up branches/templates that share leading identity prose; without
    # this, the user sees "You are Claude Code, Anthropic's official CLI..."
    # 3+ times in a row in claude_getSystemPrompt.
    seen: set[str] = set()
    deduped: list[str] = []
    for b in blocks:
        b = b.strip()
        # Strip blocks that are CLEARLY ternary/code fragments rather than prose:
        # ends with ` ? \``, ` && X.method() ? `, contains only `var = ...`, etc.
        if re.search(r"\s\?\s*[`'\"]?\s*$", b) or b.endswith("&&") or b.endswith(":"):
            continue
        # Skip obvious source array fragments (single-line `'symbol',`)
        if re.match(r"^[a-z_]+\s*[,:]?\s*$", b):
            continue
        key = re.sub(r"\s+", " ", b[:90]).lower().strip()
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(b)
    return "\n\n".join(deduped)


# Resolve BRIEF_PROACTIVE_SECTION dynamically from BriefTool/prompt.ts so it
# can be substituted into claude_getSystemPrompt instead of leaking as
# `${BRIEF_PROACTIVE_SECTION}`. References to ${BRIEF_TOOL_NAME} inside it
# are also resolved.
_brief_file = SRC / "tools" / "BriefTool" / "prompt.ts"
if _brief_file.exists():
    try:
        _brief_lit = extract_template_literal(
            _brief_file.read_text(), "export const BRIEF_PROACTIVE_SECTION = "
        )
        # The literal references ${BRIEF_TOOL_NAME} — substitute now.
        GLOBAL_SUBS["BRIEF_PROACTIVE_SECTION"] = substitute_placeholders(_brief_lit)
    except ValueError:
        pass

# ----------------------------------------------------------------------------
# Simple constants
# ----------------------------------------------------------------------------
print("[render] simple constants")

f = SRC / "tools" / "ListMcpResourcesTool" / "prompt.ts"
text = f.read_text()
lit = extract_template_literal(text, "export const PROMPT = ")
write("claude_tool_list_mcp_resources", lit.strip())

f = SRC / "tools" / "SleepTool" / "prompt.ts"
text = f.read_text()
lit = extract_template_literal(text, "export const SLEEP_TOOL_PROMPT = ")
write("claude_tool_sleep", substitute_placeholders(lit, {"TICK_TAG": "tick"}))

# ----------------------------------------------------------------------------
# PowerShell — function getPrompt() returns single template literal that
# interpolates getEditionSection(edition), getMaxTimeoutMs(), tool names, etc.
# Per agent verification: include all 3 edition variants since prod renders one.
# ----------------------------------------------------------------------------
print("[render] tool builders")
f = SRC / "tools" / "PowerShellTool" / "prompt.ts"
text = f.read_text()
gp_idx = text.find("export async function getPrompt(")
if gp_idx == -1:
    raise SystemExit("PowerShell getPrompt not found")
body = text[gp_idx:]
lit = extract_template_literal(body, "return ")

# Capture only the most-realistic edition variant (PowerShell 7+ / pwsh —
# the cross-platform "core" branch most users hit). The LLM only ever sees
# one variant per session, so emitting all three with separator labels was
# misrepresenting what the prompt looks like at runtime.
edition_section_match = re.search(
    r"function getEditionSection\([^)]*\)[^{]*\{(.*?)^\}", text, re.M | re.S
)
edition_combined = "PowerShell edition: PowerShell 7+ (pwsh)"
if edition_section_match:
    es_body = edition_section_match.group(1)
    # Look for the branch that mentions "PowerShell 7+" or "pwsh"; fall back
    # to the first return statement.
    candidates = re.findall(r"return\s+`([^`]+)`", es_body)
    chosen = next(
        (c for c in candidates if "PowerShell 7" in c or "pwsh" in c),
        candidates[0] if candidates else "",
    )
    if chosen:
        edition_combined = chosen.strip()

# Capture optional helper sections (getBackgroundSection / getSleepSection).
def _capture_helper_template(name: str) -> str:
    m = re.search(rf"function {name}\([^)]*\)[^{{]*\{{(.*?)^\}}", text, re.M | re.S)
    if not m:
        return ""
    inner = m.group(1)
    rm = re.search(r"return\s+`([^`]+)`", inner)
    return rm.group(1) if rm else ""

bg_section = _capture_helper_template("getBackgroundSection")
sleep_section = _capture_helper_template("getSleepSection")

ps_subs = {
    "getEditionSection(edition)": edition_combined,
    "getMaxTimeoutMs() / 60000": "10",
    "getDefaultTimeoutMs() / 60000": "2",
    "getMaxTimeoutMs()": "600000",
    "getDefaultTimeoutMs()": "120000",
    "getMaxOutputLength()": "30000",
    "backgroundNote ? backgroundNote + '\\n' : ''": (bg_section + "\n") if bg_section else "",
    "sleepGuidance ? sleepGuidance + '\\n' : ''": (sleep_section + "\n") if sleep_section else "",
    "edition": "PowerShell 7+ (pwsh)",
}
write("claude_tool_powershell", substitute_placeholders(lit, ps_subs))

# ----------------------------------------------------------------------------
# compact getCompactPrompt — concats NO_TOOLS_PREAMBLE + BASE_COMPACT_PROMPT + NO_TOOLS_TRAILER
# ----------------------------------------------------------------------------
f = SRC / "services" / "compact" / "prompt.ts"
text = f.read_text()
preamble = extract_template_literal(text, "const NO_TOOLS_PREAMBLE = ")
# DETAILED_ANALYSIS_INSTRUCTION_BASE — interpolated INTO BASE_COMPACT_PROMPT
try:
    detailed_analysis = extract_template_literal(text, "const DETAILED_ANALYSIS_INSTRUCTION_BASE = ")
except ValueError:
    detailed_analysis = ""
base = extract_template_literal(text, "const BASE_COMPACT_PROMPT = ")
base_resolved = substitute_placeholders(
    base, {"DETAILED_ANALYSIS_INSTRUCTION_BASE": detailed_analysis}
)
# NO_TOOLS_TRAILER is a `'a' + 'b'` string concat — DON'T use the
# template-literal extractor (it would happily grab the next ` somewhere
# else in the file, e.g. inside an unrelated function body, producing
# `${customInstructions}` shrapnel).
trailer_match = re.search(
    r"const NO_TOOLS_TRAILER\s*=\s*(.*?)(?=\n(?:export |const |let |var |function |async function ))",
    text, re.S,
)
trailer = ""
if trailer_match:
    raw = trailer_match.group(1)
    parts = re.findall(r"'((?:[^'\\]|\\.)*)'|\"((?:[^\"\\]|\\.)*)\"", raw)
    trailer = "".join(
        (p[0] or p[1]).replace("\\n", "\n").replace("\\'", "'") for p in parts
    )
write("claude_compact", preamble + base_resolved + trailer)

# ----------------------------------------------------------------------------
# session memory update — getDefaultUpdatePrompt()
# ----------------------------------------------------------------------------
f = SRC / "services" / "SessionMemory" / "prompts.ts"
text = f.read_text()
m = re.search(r"function getDefaultUpdatePrompt\(\)[^{]*\{(.*?)^\}", text, re.M | re.S)
body = m.group(1)
lit = extract_template_literal(body, "return ")
write("claude_session_memory_update", substitute_placeholders(lit))

# ----------------------------------------------------------------------------
# extractMemories — buildExtractAutoOnlyPrompt + memoryTypes.ts inlined
# ----------------------------------------------------------------------------
f = SRC / "services" / "extractMemories" / "prompts.ts"
main_blocks = render_via_concat(f)

# Also concat memoryTypes.ts (imported by buildExtractAutoOnlyPrompt).
memdir_file = SRC / "memdir" / "memoryTypes.ts"
extra = ""
if memdir_file.exists():
    extra = "\n\n" + render_via_concat(memdir_file)
write("claude_extract_memories", main_blocks + extra)

# ----------------------------------------------------------------------------
# MagicDocs — buildMagicDocsUpdatePrompt (concat-style)
# ----------------------------------------------------------------------------
f = SRC / "services" / "MagicDocs" / "prompts.ts"
write("claude_magic_docs", render_via_concat(f))

# ----------------------------------------------------------------------------
# CLI sysprompt prefix — function picks the DEFAULT_PREFIX in the typical
# (interactive, non-Vertex) case. Render only that branch verbatim.
# ----------------------------------------------------------------------------
f = SRC / "constants" / "system.ts"
text = f.read_text()
default_match = re.search(r"const DEFAULT_PREFIX\s*=\s*`([^`]+)`", text)
write(
    "claude_getCLISyspromptPrefix",
    default_match.group(1) if default_match else "[DEFAULT_PREFIX not found]",
)

# ----------------------------------------------------------------------------
# Built-in Explore agent — read-only codebase search specialist.
# ----------------------------------------------------------------------------
f = SRC / "tools" / "AgentTool" / "built-in" / "exploreAgent.ts"
if f.exists():
    text = f.read_text()
    system_prompt = extract_template_literal(text, "return ")
    system_prompt = substitute_placeholders(
        system_prompt,
        {
            "globGuidance": "- Use Glob for broad file pattern matching",
            "grepGuidance": "- Use Grep for searching file contents with regex",
            "embedded ? ', grep' : ''": "",
        },
    )
    when_match = re.search(
        r"const EXPLORE_WHEN_TO_USE\s*=\s*'((?:[^'\\]|\\.)*)'",
        text,
        re.S,
    )
    when_to_use = (
        when_match.group(1).replace("\\'", "'")
        if when_match
        else "[EXPLORE_WHEN_TO_USE not found]"
    )
    write(
        "claude_builtin_explore_agent",
        "# When to Use\n\n"
        + when_to_use
        + "\n\n# System Prompt\n\n"
        + system_prompt,
    )

# ----------------------------------------------------------------------------
# Main system prompt — getSystemPrompt — large, conditionally-built.
# Whole-file concat over constants/prompts.ts + key imported sibling files.
# ----------------------------------------------------------------------------
print("[render] main system prompt (whole-file concat + imports)")
f = SRC / "constants" / "prompts.ts"
main = render_via_concat(f, min_len=80)

# Also pull in commonly-imported sibling files that contribute prompt text.
extra_files = [
    SRC / "constants" / "tools.ts",
    SRC / "constants" / "messages.ts",
    SRC / "constants" / "cyberRiskInstruction.ts",
    SRC / "constants" / "systemPromptSections.ts",
]
for ef in extra_files:
    if not ef.exists():
        continue
    block = render_via_concat(ef, min_len=80)
    if block:
        main += "\n\n" + block

write("claude_getSystemPrompt", main)

print("[render] done.")
