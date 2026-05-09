---
description: "Scan the codebase and regenerate CLAUDE.md as a token-efficient table of contents. Idempotent — safe to run whenever the codebase changes."
---

# Generate CLAUDE.md

Scan the codebase and produce a concise, high-signal CLAUDE.md following harness engineering principles: "Give the agent a map, not a 1,000-page instruction manual."

**This skill is idempotent.** Running it again after codebase changes should produce an updated, accurate CLAUDE.md. It overwrites the existing CLAUDE.md entirely.

---

## Principles

1. **Context is scarce.** Every line in CLAUDE.md competes with the task prompt for context window space. Target ~100-150 lines. If a section exceeds 10 lines, it probably belongs in a separate doc that CLAUDE.md points to.
2. **Table of contents, not encyclopedia.** Short pointers to deeper docs, skills, and code — not inline reproductions of their content.
3. **Progressive disclosure.** CLAUDE.md tells the agent *where* to look. The agent reads the deeper doc *when it needs it*.
4. **Skills are the playbook.** Don't duplicate skill instructions in CLAUDE.md. Reference the skill name and a 1-line description.
5. **Mechanical enforcement over prose.** Prefer "ESLint enforces X (see `eslint.config.mjs`)" over a paragraph explaining X.
6. **Guidelines over tutorials.** Bulleted rules the agent can scan in one pass. No multi-step tutorials (those belong in skills).

---

## Step 1: Scan the codebase

Gather these inputs (read files, run commands). Do NOT output any of this to the user — it's input for generation.

### 1a. Structure

```bash
# Top-level directories
ls -d */ 2>/dev/null

# Backend domain structure
ls back-end/src/domains/ 2>/dev/null
ls back-end/src/routes/ 2>/dev/null
ls back-end/src/providers/ 2>/dev/null
ls back-end/src/utils/ 2>/dev/null

# Key config files
ls conductor.json .coderabbit.yaml back-end/prisma/schema.prisma 2>/dev/null
```

### 1b. Skills inventory

```bash
ls .claude/commands/*.md
```

Read the `description` frontmatter from each skill file (first 5 lines). Build a table: skill name → 1-line description → when to use.

### 1c. Entry points

Identify the main entry point for each top-level service directory:
- `back-end/src/server.ts`
- `front-end/src/App.tsx`
- `agents/worker.py`
- `agents/workflows/agent_workflow.py`
- `research/supabase/functions/completions/index.ts`
- `mac-app/main/index.ts` (if exists)
- `docs/mint.json` (if exists)
- `back-end/prisma/schema.prisma`

Verify each exists. Drop any that don't.

### 1d. Test commands

```bash
# Find test scripts in package.json files
grep -A1 '"test' back-end/package.json 2>/dev/null
grep -A1 '"test' front-end/package.json 2>/dev/null

# Find Python test runners
ls agents/tests/run_all_tests.py agents/tests/e2e/run_e2e_tests.py 2>/dev/null

# Find benchmark runner
ls agents/benchmarks/run_benchmark.py 2>/dev/null
```

### 1e. Existing CLAUDE.md

Read the current `CLAUDE.md`. Identify:
- Sections that are **concise and high-signal** → keep (possibly condense)
- Sections that are **verbose inline docs** → extract to a reference doc under `docs/internal/` and replace with a pointer
- Sections that **duplicate skill content** → replace with skill reference
- Sections that are **stale or inaccurate** → drop or update

### 1f. Plans and completed work

```bash
ls docs/plans/active/ 2>/dev/null
ls docs/plans/completed/ 2>/dev/null
```

### 1g. CI/CD and deploy

Read `.coderabbit.yaml` (if exists) for review config. Check for GitHub Actions workflows:
```bash
ls .github/workflows/*.yml 2>/dev/null
```

### 1h. Deep reference docs

Check if any internal reference docs already exist:
```bash
ls docs/internal/ 2>/dev/null
```

### 1i. Resource discovery (log files, scripts, config)

**This step is critical.** Do NOT rely on the old CLAUDE.md to know what resources exist. Discover them programmatically from the codebase.

**Log files** — find every log file path configured or referenced in the project:
```bash
# 1. Glob for existing log files and log-like files at the repo root and one level deep
find . -maxdepth 2 -name '*.log' -o -name '*-logs.*' -o -name '*-log.*' 2>/dev/null | grep -v node_modules | grep -v dist | grep -v .git

# 2. Check conductor.json for log file paths (services often configure log output here)
grep -i 'log' conductor.json 2>/dev/null

# 3. Grep scripts and code for hardcoded log file paths (catches log paths that don't exist yet)
grep -rn '\-logs\.\|\.log["\x27]' scripts/ back-end/src/ agents/ --include='*.ts' --include='*.sh' --include='*.py' --include='*.json' 2>/dev/null | grep -v node_modules | head -30
```

Every log file path discovered MUST appear in the External Context table. Cross-check your final External Context table against this list — if a discovered log file is missing from the table, add it.

**Query/debug scripts** — find utility scripts an agent might need:
```bash
ls back-end/scripts/*.ts agents/scripts/*.py agents/benchmarks/*.py 2>/dev/null
```

**Config files with env vars** — find `.env` files and their locations:
```bash
find . -maxdepth 2 -name '.env' -o -name '.env.*' 2>/dev/null | grep -v node_modules
```

---

## Step 2: Extract verbose content to reference docs

For any section in the current CLAUDE.md that exceeds ~10 lines of detailed content (tables, multi-step procedures, curl examples), extract it to a standalone doc.

**Extraction targets** (check if these exist in current CLAUDE.md and are verbose):

| Current CLAUDE.md section | Extract to | Pointer in new CLAUDE.md |
|---|---|---|
| LLM Call Map (tables of call sites, token estimates, gates) | `docs/internal/llm-call-map.md` | "LLM call map: `docs/internal/llm-call-map.md`" |
| Autonomous Agent Testing (multi-step loop) | Already in `/loop` skill | "Agent testing loop: `/loop`" |
| Production Logs (Render API commands) | `docs/internal/prod-logs.md` | "Prod log access: `docs/internal/prod-logs.md`" |
| CodeRabbit Review (step-by-step) | Already in `/deploy` skill | "PR review: handled by `/deploy`" |
| Detailed benchmark instructions | Already in `/benchmark` skill | "Benchmarks: `/benchmark <task>`" |
| Mac app release process (if verbose) | `docs/internal/mac-app-releases.md` | One-line summary + pointer |

**Rules for extraction:**
- Create `docs/internal/` if it doesn't exist
- Each extracted doc should be self-contained (copy content as-is, don't rewrite)
- Add a header comment: `<!-- Extracted from CLAUDE.md by /generate-claude-md. Source of truth for this topic. -->`
- If the extracted doc already exists, **overwrite it** with the latest content (idempotent)
- Preserve any content that was ONLY in the extracted doc (not in CLAUDE.md) by reading it first

**Dedup against skills — CRITICAL:**
Before creating a `docs/internal/` file for any topic, check if a skill (`.claude/commands/*.md`) already covers that content. To check:
1. Read the skill descriptions gathered in Step 1b
2. If a skill's description matches the topic (e.g., `/loop` covers agent testing, `/deploy` covers PR review, `/benchmark` covers benchmark instructions), **do NOT create an extracted doc for that topic**
3. Do NOT reference the skill in CLAUDE.md either — skills are injected via system prompt and don't need to be listed
4. Simply omit that topic from CLAUDE.md entirely. The content lives in the skill, the agent will find it when it needs it.

Only extract to `docs/internal/` when the content is **reference material** (data tables, credentials, API commands) that no skill covers.

---

## Step 3: Generate the new CLAUDE.md

Write the new CLAUDE.md with exactly **4 sections**. Each section has a max line budget. No other top-level sections.

### Section 1: Identity (3-5 lines)

```markdown
# <Project Name>

<1-line description of what this is>
- Prod: <url>
- API: <url>
- Docs: <url>
```

### Section 2: Architecture (10-15 lines)

The directory tree (already concise in most projects). Include:
- Top-level directory → tech stack → deploy target (1 line each)
- Key entry points as a bullet list (file path only, no descriptions)
- Schema source of truth pointer

### Section 3: External Context

Pointers to logs, databases, APIs, and extracted reference docs — the "where to look" table. One line per resource, with the access command or file path.

**This table MUST be built from Step 1i discovery results, not from memory or the old CLAUDE.md.** Every log file, query script, and config path found in Step 1i must have a row. Cross-check the final table against discovery output before writing.

No fixed line budget — the table has as many rows as there are resources. Completeness matters more than brevity here.

```markdown
## External Context

| Resource | Access |
|---|---|
| Backend logs | `back-end/backend-logs.log` |
| Worker logs | `agents/navi-worker-log.txt` |
| Frontend logs | `front-end/frontend-logs.log` |
| Research logs | `research/research-logs.log` |
| ... (every log file from discovery) | ... |
| Prod logs (Render/ClickHouse/Fly/Supabase) | `docs/internal/prod-logs.md` |
| DB schema | `back-end/prisma/schema.prisma` |
| DB queries | `npx tsx back-end/scripts/query-db.ts` |
| ... (every script/config from discovery) | ... |
```

### Section 4: Guidelines (30-45 lines)

Bulleted rules — the "common mistakes" and "how we work" section. Each rule is 1-2 lines max. Group by category. Only include rules that an agent is likely to violate (not obvious things).

This section absorbs everything: test commands, credentials, plans, architecture rules, deploy gotchas, and common mistakes. If it's a short rule or fact, it's a guideline bullet.

Categories to include:
- **Testing** — TDD loop, API changes require tests, which test commands to run for each service
- **Architecture** — layer rules, provider boundaries, import direction
- **Code quality** — no defensive fixes, search before implementing, no fallbacks
- **Agent patterns** — Temporal determinism, activity idempotency, error handling
- **Frontend** — state diagrams, no over-truncation
- **Deploy** — mac app tag requirements, plan archival
- **Logging** — what to log, format
- **Plans** — where they live (`docs/plans/active/` and `docs/plans/completed/`), check completed plans before modifying files they touched
- **Credentials** — minimum needed for local dev (test phone/OTP, API key, user ID, Supabase URL). No curl examples — those live in skills.

Only include guidelines that are:
1. Non-obvious (an agent wouldn't naturally do this)
2. Learned from past mistakes (the user added them for a reason)
3. Enforceable (the agent can check if it's following the rule)

Drop guidelines that are:
1. Already enforced mechanically (by ESLint, structural tests, CI)
2. Generic software engineering advice
3. Too verbose (rewrite as 1 line)

**Skills are NOT listed here.** They are already injected into every conversation via the system prompt. Do not duplicate them.

---

## Step 4: Verify

After writing the new CLAUDE.md:

1. **Line count check:**
   ```bash
   wc -l CLAUDE.md
   ```
   Must be under 175 lines. If over, find sections that can be further compressed or extracted.

2. **No broken pointers:** For every file path or doc reference in the new CLAUDE.md, verify the file exists:
   ```bash
   # Extract all file paths referenced and check each
   grep -oE '`[a-zA-Z][a-zA-Z0-9/_.-]+\.(ts|py|json|md|yaml|log|txt|mjs)`' CLAUDE.md | tr -d '`' | while read f; do
     [ -f "$f" ] || echo "MISSING: $f"
   done
   ```
   Fix any missing references (either create the extracted doc or remove the pointer).

3. **No duplicated content:** Verify that extracted docs exist and contain the detailed content:
   ```bash
   ls -la docs/internal/*.md 2>/dev/null
   ```

4. **External Context completeness:** Re-run the log file discovery commands from Step 1i. For every log file path found, verify it has a row in the External Context table. If any are missing, add them and rewrite CLAUDE.md.

---

## Step 5: Information loss review (run TWICE)

**This step is critical. Run it exactly twice before proceeding to Step 6.**

After the first pass generates the new CLAUDE.md, information will inevitably be lost. Some of that loss is intentional (verbose content moved to extracted docs, skill-covered content omitted). Some is accidental (useful pointers, conventions, or reference data silently dropped).

### How to run each review pass:

1. **Read the previous CLAUDE.md** (the version from before this skill ran — use `git show HEAD:CLAUDE.md` if already overwritten, or the copy you read in Step 1e).

2. **Read the new CLAUDE.md** you just wrote.

3. **Diff them mentally, section by section.** For every piece of information in the old version, classify it:
   - **Kept** — present in the new CLAUDE.md (possibly condensed). No action.
   - **Extracted** — moved to a `docs/internal/` file. No action.
   - **Covered by skill** — a skill (`.claude/commands/*.md`) contains this content. No action.
   - **Lost** — not in the new CLAUDE.md, not in any extracted doc, not in any skill. **Evaluate below.**

4. **For each piece of lost information, ask:**
   - Is this a **file path, URL, command, or convention** that an agent would need and can't discover by searching? → **Restore it** (as a 1-line guideline bullet or External Context row).
   - Is this a **workflow or multi-step procedure** already in a skill? → Confirmed covered, leave it out.
   - Is this **discoverable from the codebase** (e.g., by reading `package.json`, running `ls`, grepping)? → Safe to drop.
   - Is this a **domain-specific convention or gotcha** (e.g., naming conventions, migration workflow, manual release triggers) that an agent wouldn't know without being told? → **Restore it.**
   - Is this **stale, redundant, or generic advice**? → Confirmed drop.

5. **If any lost information should be restored**, add it to the new CLAUDE.md:
   - File paths / URLs / commands → External Context table row
   - Conventions / gotchas / rules → Guidelines bullet (1 line)
   - Reference data (test files, env var names) → Guidelines bullet or External Context row

6. **After restoring, re-run the Step 4 verification checks** (line count, broken pointers, External Context completeness).

### Pass tracking

Run this review exactly twice:
- **Pass 1:** Catch the obvious losses — sections that were entirely dropped, file paths that vanished, conventions that disappeared.
- **Pass 2:** Catch subtler losses — individual facts within sections that were partially condensed, specific commands or examples that were trimmed away.

After both passes, compile a list of everything you **deliberately chose NOT to restore** with a 1-line reason for each. This list is output to the user in Step 6.

---

## Step 6: Report

Output to the user:
- Line count: before → after
- Sections extracted to `docs/internal/` (list with line counts)
- **Information deliberately dropped** (table format):

```markdown
| Dropped content | Reason |
|---|---|
| Rose API test file list (4 files) | Discoverable via `ls research/supabase/functions/completions/test-*` |
| ... | ... |
```

The user should be able to review the "deliberately dropped" table and tell you to restore anything they disagree with.

Only say **"CLAUDE.md regenerated"** if:
- [ ] Under 150 lines
- [ ] All file/doc references resolve to existing files
- [ ] Extracted docs exist in `docs/internal/`
- [ ] No verbose inline content (no section > 10 lines of detailed content)
- [ ] Two information loss review passes completed
- [ ] Deliberately-dropped table shown to user
