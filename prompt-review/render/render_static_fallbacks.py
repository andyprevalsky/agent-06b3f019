#!/usr/bin/env python3
"""Static fallback renderer for Claude Code prompts that the bun runtime
interceptor couldn't reach due to deep import chains.

Each prompt is rendered by reading the source template literal directly,
selecting the most-common-branch when the function has flag-controlled
variants, and substituting `${...}` interpolations with realistic values.

The output is the verbatim text the LLM would see at runtime — no comments,
no separators, no labels.

Targets covered (only those NOT already produced by intercept_claude.ts):
  - claude_tool_powershell      (pick PowerShell 7+ / core branch)
  - claude_tool_bash            (default branch, no sandbox/embedded/MONITOR)
  - claude_tool_read            (targetedRangeNudge=true, USER_TYPE=external)
  - claude_tool_edit            (isCompactLinePrefixEnabled=true, external)
  - claude_tool_write           (default)
  - claude_tool_agent           (non-fork, non-coordinator, listViaAttachment=false)
  - claude_extract_memories     (auto-only path, no team memory)
  - claude_getSystemPrompt      (default external CLI, no sandbox)

Idempotent.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SRC = ROOT / "claude-code-src" / "src"
OUT = ROOT / "prompt-review" / "rendered" / "claude-code-src"
OUT.mkdir(parents=True, exist_ok=True)


def write(idx: str, text: str) -> None:
    path = OUT / f"{idx}.txt"
    path.write_text(text)
    print(f"  wrote {idx}.txt ({len(text)} chars)")


def extract_template_literal(text: str, start_marker: str, *, after: int = 0) -> str:
    i = text.find(start_marker, after)
    if i == -1:
        raise ValueError(f"start_marker not found: {start_marker[:60]}")
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
            return "".join(body)
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


def unescape_template(s: str) -> str:
    """Convert JS escape sequences in template literal body to plain text."""
    # Order: handle escaped-backslash (\\\\), backtick (\\`), and unicode (\\uXXXX) first.
    s = s.replace("\\`", "`")
    # \\u escapes
    s = re.sub(
        r"\\u([0-9a-fA-F]{4})",
        lambda m: chr(int(m.group(1), 16)),
        s,
    )
    # Common escape sequences (\n is REAL newline in template literal so keep)
    s = s.replace("\\$", "$")
    return s


# ---------------------------------------------------------------------------
# claude_tool_powershell — pick PowerShell 7+ / `core` branch only.
# ---------------------------------------------------------------------------
def render_powershell() -> None:
    src_text = (SRC / "tools" / "PowerShellTool" / "prompt.ts").read_text()

    # Extract the main template literal returned by getPrompt().
    # First anchor: `export async function getPrompt`.
    gp_idx = src_text.find("export async function getPrompt")
    body_after = src_text[gp_idx:]
    main_template = extract_template_literal(body_after, "return ")

    # Extract the `core` edition's return value (the most common — PowerShell 7+).
    # Use a proper template-literal extractor that respects escaped backticks.
    core_idx = src_text.find("if (edition === 'core')")
    if core_idx == -1:
        raise SystemExit("Could not find 'core' edition branch")
    core_section = extract_template_literal(src_text, "return ", after=core_idx)

    # Background-section + sleep-guidance come from helper functions.
    # Default branch (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS unset): both included.
    bg_idx = src_text.find("function getBackgroundUsageNote")
    bg_text = extract_template_literal(src_text, "return ", after=bg_idx) if bg_idx != -1 else ""

    sl_idx = src_text.find("function getSleepGuidance")
    sl_text = extract_template_literal(src_text, "return ", after=sl_idx) if sl_idx != -1 else ""

    # Substitute interpolations in main_template.
    subs = {
        "getEditionSection(edition)": core_section,
        "getMaxTimeoutMs() / 60000": "10",
        "getDefaultTimeoutMs() / 60000": "2",
        "getMaxTimeoutMs()": "600000",
        "getDefaultTimeoutMs()": "120000",
        "getMaxOutputLength()": "30000",
        "backgroundNote ? backgroundNote + '\\n' : ''": bg_text + "\n",
        "sleepGuidance ? sleepGuidance + '\\n' : ''": sl_text + "\n",
        "GLOB_TOOL_NAME": "Glob",
        "GREP_TOOL_NAME": "Grep",
        "FILE_READ_TOOL_NAME": "Read",
        "FILE_EDIT_TOOL_NAME": "Edit",
        "FILE_WRITE_TOOL_NAME": "Write",
        "POWERSHELL_TOOL_NAME": "PowerShell",
    }
    out = subst(main_template, subs)
    out = unescape_template(out)
    # Template literals in JS use trailing `\` for line-continuation. After our
    # substitution, those leave bare `\` lines — strip them.
    out = re.sub(r"^\\\s*$\n?", "", out, flags=re.M)
    write("claude_tool_powershell", out.strip() + "\n")


def subst(s: str, mapping: dict[str, str]) -> str:
    """Replace ${...} interpolations using mapping. Unknown stays as-is."""
    out = []
    i = 0
    while i < len(s):
        if s[i] == "$" and i + 1 < len(s) and s[i + 1] == "{":
            depth = 1
            k = i + 2
            while k < len(s) and depth > 0:
                if s[k] == "{":
                    depth += 1
                elif s[k] == "}":
                    depth -= 1
                k += 1
            if depth != 0:
                out.append(s[i])
                i += 1
                continue
            expr = s[i + 2:k - 1].strip()
            out.append(mapping.get(expr, "<" + expr + ">"))
            i = k
            continue
        out.append(s[i])
        i += 1
    return "".join(out)


# ---------------------------------------------------------------------------
# claude_tool_bash — default branch
# ---------------------------------------------------------------------------
def render_bash() -> None:
    src_text = (SRC / "tools" / "BashTool" / "prompt.ts").read_text()
    # Find `export function getDescription(...)` or main getPrompt — anchor on "Executes a given bash"
    template = re.search(r"`(Executes a given bash command[^`]+)`", src_text, re.S)
    if not template:
        raise SystemExit("Could not find Bash main template")
    body = template.group(1)

    subs = {
        "BASH_TOOL_NAME": "Bash",
        "AGENT_TOOL_NAME": "Agent",
        "FILE_READ_TOOL_NAME": "Read",
        "FILE_EDIT_TOOL_NAME": "Edit",
        "FILE_WRITE_TOOL_NAME": "Write",
        "GLOB_TOOL_NAME": "Glob",
        "GREP_TOOL_NAME": "Grep",
        "TASK_TOOL_NAME": "TodoWrite",
        "TodoWriteTool.toolName": "TodoWrite",
        "shellName": "zsh",
        "getMaxBashTimeoutMs() / 60000": "10",
        "getDefaultBashTimeoutMs() / 60000": "2",
        "getMaxBashTimeoutMs()": "600000",
        "getDefaultBashTimeoutMs()": "120000",
        "getMaxOutputLength()": "30000",
        "getClaudeTempDir()": "/tmp/claude",
    }
    out = subst(body, subs)
    out = unescape_template(out)
    write("claude_tool_bash", out.strip() + "\n")


# ---------------------------------------------------------------------------
# claude_tool_read
# ---------------------------------------------------------------------------
def render_read() -> None:
    src_text = (SRC / "tools" / "FileReadTool" / "prompt.ts").read_text()
    template = re.search(r"`(Reads a file from the local filesystem[^`]+)`", src_text, re.S)
    if not template:
        # Try alternative anchor
        template = re.search(r"return\s+`([^`]+local filesystem[^`]+)`", src_text, re.S)
    if not template:
        raise SystemExit("Could not find Read main template")
    body = template.group(1)
    subs = {
        "FILE_READ_TOOL_NAME": "Read",
        "MAX_LINES": "2000",
        "MAX_BYTES": "256000",
    }
    out = subst(body, subs)
    out = unescape_template(out)
    write("claude_tool_read", out.strip() + "\n")


# ---------------------------------------------------------------------------
# claude_tool_edit
# ---------------------------------------------------------------------------
def render_edit() -> None:
    src_text = (SRC / "tools" / "FileEditTool" / "prompt.ts").read_text()
    template = re.search(r"`(Performs exact string replacements[^`]+)`", src_text, re.S)
    if not template:
        template = re.search(r"return\s+`([^`]+exact string replacement[^`]+)`", src_text, re.S | re.I)
    if not template:
        raise SystemExit("Could not find Edit main template")
    body = template.group(1)
    subs = {
        "FILE_EDIT_TOOL_NAME": "Edit",
        "FILE_READ_TOOL_NAME": "Read",
    }
    out = subst(body, subs)
    out = unescape_template(out)
    write("claude_tool_edit", out.strip() + "\n")


# ---------------------------------------------------------------------------
# claude_tool_write
# ---------------------------------------------------------------------------
def render_write() -> None:
    src_text = (SRC / "tools" / "FileWriteTool" / "prompt.ts").read_text()
    template = re.search(r"`(Writes a file to the local filesystem[^`]+)`", src_text, re.S)
    if not template:
        template = re.search(r"return\s+`([^`]+local filesystem[^`]+)`", src_text, re.S)
    if not template:
        raise SystemExit("Could not find Write main template")
    body = template.group(1)
    subs = {
        "FILE_WRITE_TOOL_NAME": "Write",
        "FILE_READ_TOOL_NAME": "Read",
        "FILE_EDIT_TOOL_NAME": "Edit",
    }
    out = subst(body, subs)
    out = unescape_template(out)
    write("claude_tool_write", out.strip() + "\n")


# ---------------------------------------------------------------------------
# claude_tool_agent — non-fork, non-coordinator, default agent (general-purpose)
# ---------------------------------------------------------------------------
def render_agent() -> None:
    src_text = (SRC / "tools" / "AgentTool" / "prompt.ts").read_text()

    # Extract the `shared` template literal (line: const shared = `...`)
    shared = extract_template_literal(src_text, "const shared = ")
    # currentExamples
    current_examples = extract_template_literal(src_text, "const currentExamples = ")
    # writingThePromptSection (template-literal value)
    writing_section = extract_template_literal(src_text, "const writingThePromptSection = ")
    # whenNotToUseSection: forkEnabled=false branch — the literal after `: \``
    wn_match = re.search(
        r"const whenNotToUseSection = forkEnabled\s*\?\s*''\s*:\s*`([^`]+)`",
        src_text, re.S,
    )
    wn_section = wn_match.group(1) if wn_match else ""
    # concurrencyNote: !listViaAttachment && !pro -> show
    cn_match = re.search(
        r"const concurrencyNote =[^`]*?`([^`]+)`",
        src_text, re.S,
    )
    cn_text = cn_match.group(1) if cn_match else ""

    # Replace the agentListSection in shared with default branch
    agent_listing = (
        "Available agent types and the tools they have access to:\n"
        "- general-purpose: General-purpose agent for researching complex questions, "
        "searching for code, and executing multi-step tasks. When you are searching for "
        "a keyword or file and are not confident that you will find the right match in "
        "the first few tries use this agent to perform the search for you. (Tools: All tools)"
    )

    shared_filled = subst(shared, {
        "AGENT_TOOL_NAME": "Agent",
        "agentListSection": agent_listing,
        # forkEnabled=false: take the second branch of the ternary
        "forkEnabled\n    ? `When using the ${AGENT_TOOL_NAME} tool, specify a subagent_type to use a specialized agent, or omit it to fork yourself — a fork inherits your full conversation context.`\n    : `When using the ${AGENT_TOOL_NAME} tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.`":
            "When using the Agent tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.",
    })
    # Cleanup if the ternary substitution didn't catch it: split into pieces
    shared_filled = re.sub(
        r"\$\{[\s\S]*?forkEnabled[\s\S]*?\}",
        "When using the Agent tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.",
        shared_filled,
    )

    when_filled = subst(wn_section, {
        "AGENT_TOOL_NAME": "Agent",
        "FILE_READ_TOOL_NAME": "Read",
        "FILE_WRITE_TOOL_NAME": "Write",
        "GLOB_TOOL_NAME": "Glob",
        "fileSearchHint": "the Glob tool",
        "contentSearchHint": "the Glob tool",
    })

    cn_filled = subst(cn_text, {})
    writing_filled = subst(writing_section, {
        "forkEnabled ? 'When spawning a fresh agent (with a `subagent_type`), it starts with zero context. ' : ''": "",
        "forkEnabled ? 'For fresh agents, terse' : 'Terse'": "Terse",
    })

    examples_filled = subst(current_examples, {
        "FILE_WRITE_TOOL_NAME": "Write",
        "AGENT_TOOL_NAME": "Agent",
    })

    # Compose final.
    out = shared_filled.strip("\n") + "\n" + when_filled
    # Usage notes block from the source (the `return \`${shared}\\n${whenNotToUseSection}...\` block):
    usage_match = re.search(
        r"return `\$\{shared\}\s*\n\$\{whenNotToUseSection\}\s*(\nUsage notes:[\s\S]*?)`\n?\}\n?",
        src_text, re.S,
    )
    if usage_match:
        usage = usage_match.group(1)
        # Resolve the dynamic substitutions:
        # - !isEnvTruthy(CLAUDE_CODE_DISABLE_BACKGROUND_TASKS) && !isInProcessTeammate() && !forkEnabled → true
        usage = re.sub(
            r"\$\{[\s\S]*?CLAUDE_CODE_DISABLE_BACKGROUND_TASKS[\s\S]*?\}",
            "\n- You can optionally run agents in the background using the run_in_background parameter. When an agent runs in the background, you will be automatically notified when it completes — do NOT sleep, poll, or proactively check on its progress. Continue with other work or respond to the user instead.\n- **Foreground vs background**: Use foreground (default) when you need the agent's results before you can proceed — e.g., research agents whose findings inform your next steps. Use background when you have genuinely independent work to do in parallel.",
            usage,
        )
        # USER_TYPE branch removed (default external)
        usage = re.sub(
            r"\$\{[\s\S]*?USER_TYPE === 'ant'[\s\S]*?\}",
            "",
            usage,
        )
        # isInProcessTeammate / isTeammate branches removed (default neither)
        usage = re.sub(
            r"\$\{[\s\S]*?isInProcessTeammate\(\)[\s\S]*?\}",
            "",
            usage,
        )
        usage = subst(usage, {
            "shared": "",  # already prepended
            "whenNotToUseSection": "",
            "concurrencyNote": cn_filled,
            "writingThePromptSection": writing_filled,
            "whenToForkSection": "",  # forkEnabled=false
            "forkEnabled ? forkExamples : currentExamples": examples_filled,
            "AGENT_TOOL_NAME": "Agent",
            "FILE_READ_TOOL_NAME": "Read",
            "FILE_WRITE_TOOL_NAME": "Write",
            "GLOB_TOOL_NAME": "Glob",
            "SEND_MESSAGE_TOOL_NAME": "SendMessage",
            "forkEnabled ? 'Each fresh Agent invocation with a subagent_type starts without context — provide a complete task description.' : 'Each Agent invocation starts fresh — provide a complete task description.'": "Each Agent invocation starts fresh — provide a complete task description.",
            "forkEnabled ? '' : \", since it is not aware of the user's intent\"": ", since it is not aware of the user's intent",
        })
        out += usage

    out = unescape_template(out)
    # Collapse multiple blanks
    out = re.sub(r"\n{3,}", "\n\n", out)
    write("claude_tool_agent", out.strip() + "\n")


# ---------------------------------------------------------------------------
# claude_extract_memories — auto-only, no team memory
# ---------------------------------------------------------------------------
def render_extract_memories() -> None:
    src_text = (SRC / "services" / "extractMemories" / "prompts.ts").read_text()

    # opener function returns a string built via array.join('\n').
    # We extract the template literals & string literals inside.
    opener_match = re.search(r"function opener\([^)]*\)[^{]*\{(.*?)^\}", src_text, re.M | re.S)
    opener_body = opener_match.group(1) if opener_match else ""

    # Captures inside opener: 5 lines (4 strings + the conditional manifest)
    opener_strings: list[str] = []
    for m in re.finditer(r"`((?:[^`\\]|\\.)*)`", opener_body):
        opener_strings.append(m.group(1))

    # Render with realistic substitutions.
    subs_opener = {
        "newMessageCount": "50",
        "FILE_READ_TOOL_NAME": "Read",
        "GREP_TOOL_NAME": "Grep",
        "GLOB_TOOL_NAME": "Glob",
        "BASH_TOOL_NAME": "Bash",
        "FILE_EDIT_TOOL_NAME": "Edit",
        "FILE_WRITE_TOOL_NAME": "Write",
        "manifest": "",  # default: no existing memories
    }
    opener_text = "\n".join(subst(s, subs_opener) for s in opener_strings).rstrip()

    # buildExtractAutoOnlyPrompt — the body returns opener + heredoc + memory types.
    # We grep its big template literals.
    fn_match = re.search(
        r"export function buildExtractAutoOnlyPrompt\([^)]*\)[^{]*\{(.*?)^\}",
        src_text, re.M | re.S,
    )
    fn_body = fn_match.group(1) if fn_match else ""
    body_strings = []
    pos = 0
    for m in re.finditer(r"`((?:[^`\\]|\\.)*)`", fn_body):
        body_strings.append(m.group(1))

    subs_body = {
        "FILE_READ_TOOL_NAME": "Read",
        "GREP_TOOL_NAME": "Grep",
        "GLOB_TOOL_NAME": "Glob",
        "BASH_TOOL_NAME": "Bash",
        "FILE_EDIT_TOOL_NAME": "Edit",
        "FILE_WRITE_TOOL_NAME": "Write",
        "memoryDir": "/Users/user/.claude/memory",
        "TYPES_SECTION_INDIVIDUAL": "<TYPES_SECTION_INDIVIDUAL>",
        "TYPES_SECTION_COMBINED": "<TYPES_SECTION_COMBINED>",
        "WHAT_NOT_TO_SAVE_SECTION": "<WHAT_NOT_TO_SAVE_SECTION>",
        "MEMORY_FRONTMATTER_EXAMPLE": "<MEMORY_FRONTMATTER_EXAMPLE>",
        "opener(newMessageCount, existingMemories)": opener_text,
        "newMessageCount": "50",
        "existingMemories": "",
    }
    out_body = "\n".join(subst(s, subs_body) for s in body_strings).strip()
    out = opener_text + "\n\n" + out_body
    out = unescape_template(out)
    write("claude_extract_memories", out.strip() + "\n")


# ---------------------------------------------------------------------------
# claude_getSystemPrompt — high-level structure (default external CLI branch).
# This is the most complex prompt; we render its top-level skeleton via concat.
# ---------------------------------------------------------------------------
def render_get_system_prompt() -> None:
    src_text = (SRC / "constants" / "prompts.ts").read_text()

    # Extract every template literal in the file with min length 80
    blocks: list[str] = []
    i = 0
    n = len(src_text)
    while i < n:
        if src_text[i] == "`":
            j = i + 1
            depth = 0
            while j < n:
                if src_text[j] == "\\" and j + 1 < n:
                    j += 2
                    continue
                if src_text[j] == "$" and j + 1 < n and src_text[j + 1] == "{":
                    depth += 1
                    j += 2
                    continue
                if depth > 0 and src_text[j] == "}":
                    depth -= 1
                    j += 1
                    continue
                if depth == 0 and src_text[j] == "`":
                    body = src_text[i + 1:j]
                    if len(body) >= 80:
                        blocks.append(body)
                    i = j + 1
                    break
                j += 1
            else:
                break
        else:
            i += 1

    subs = {
        "BASH_TOOL_NAME": "Bash",
        "AGENT_TOOL_NAME": "Agent",
        "FILE_READ_TOOL_NAME": "Read",
        "FILE_EDIT_TOOL_NAME": "Edit",
        "FILE_WRITE_TOOL_NAME": "Write",
        "GLOB_TOOL_NAME": "Glob",
        "GREP_TOOL_NAME": "Grep",
        "TASK_CREATE_TOOL_NAME": "TaskCreate",
        "TODO_WRITE_TOOL_NAME": "TodoWrite",
        "SKILL_TOOL_NAME": "Skill",
        "VERIFICATION_AGENT_TYPE": "verification",
        "PRODUCT_NAME": "Claude Code",
        "PROJECT_DOC_PATH": "CLAUDE.md",
        "FRONTIER_MODEL_NAME": "Claude Sonnet 4.6",
        "marketingName": "Claude Sonnet 4.6",
        "modelId": "claude-sonnet-4-6",
        "shellName": "zsh",
        "getCwd()": "/Users/user/project",
        "getSessionStartDate()": "2026-05-04",
        "languagePreference": "English",
    }
    rendered = []
    for b in blocks:
        try:
            rendered.append(subst(b, subs))
        except Exception:
            continue
    out = "\n\n".join(rendered)
    out = unescape_template(out)
    out = re.sub(r"\n{3,}", "\n\n", out)
    write("claude_getSystemPrompt", out.strip() + "\n")


# ---------------------------------------------------------------------------
def main() -> int:
    print("[render-static] starting fallback render")
    render_powershell()
    # Bash, Read, Edit, Write, Agent, getSystemPrompt are already rendered by
    # the existing render_claude_remaining.py concat-style approach. We skip
    # them here since the cleanup_rendered.py pass already strips HTML
    # comments, leaving only the prompt body. Re-running them via this
    # static fallback risks losing detail.
    # render_extract_memories handled in cleanup pass too.
    print("[render-static] done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
