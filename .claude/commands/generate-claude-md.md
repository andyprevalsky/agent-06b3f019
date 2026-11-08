---
description: "Scan the codebase and refresh the root CLAUDE.md and the package CLAUDE.md files in place, keeping their structure and rule IDs. Idempotent — safe to run whenever the codebase changes."
---

# Generate CLAUDE.md

Scan the codebase and keep the instruction files concise, high-signal and accurate, following harness engineering principles: "Give the agent a map, not a 1,000-page instruction manual."

The instruction files are:

- **Root `CLAUDE.md`**: repo-wide rules only. A one-line purpose, the standing banners, a `Sections:` line, then the `##` sections it lists (Priorities, Communication, Never, Delegation and waiting, Workspaces, Testing, Benchmarks, Database, Agents and scale, LLM calls, Credentials and environment, Production, Repository, Where else to look). Every rule is one bullet on one line. There is no numbered list: a kept rule carries its stable ID in parentheses, for example `(rule 19)`, because other files cite it.
- **Package `CLAUDE.md` files** (`front-end/CLAUDE.md`, `back-end/CLAUDE.md`, `agents/CLAUDE.md`, each with an `AGENTS.md` symlink beside it): rules and commands that apply only inside that package, including its test and coverage commands. A rule moved here from the root keeps its ID.
- **Reference docs**: `docs/testing.md` for the testing guide, `docs/internal/*.md` for reference material (tables, API recipes), `docs/setup-mac.md` for Mac setup.

**This skill is idempotent.** Running it again after codebase changes should produce updated, accurate files. It edits them in place: it never overwrites the root `CLAUDE.md` wholesale, never restructures its sections and never renumbers, reuses or drops a cited rule ID.

---

## Principles

1. **Context is scarce.** Every line in the root CLAUDE.md competes with the task prompt for context window space. Keep it under 175 lines. Package-only detail belongs in that package's CLAUDE.md; long reference material belongs in a doc the file points to.
2. **Table of contents, not encyclopedia.** Short pointers to deeper docs, skills, and code — not inline reproductions of their content.
3. **Progressive disclosure.** CLAUDE.md tells the agent *where* to look. The agent reads the deeper doc *when it needs it*.
4. **Skills are the playbook.** Don't duplicate skill instructions in CLAUDE.md; a one-line pointer to the skill is enough.
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
ls .coderabbit.yaml back-end/prisma/schema.prisma 2>/dev/null
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

### 1e. Existing instruction files

Read the root `CLAUDE.md` and every package `CLAUDE.md`. For each bullet, identify whether it is:
- **concise, repo-wide and accurate** → keep it where it is
- **package-only** → move it to that package's CLAUDE.md, keeping its rule ID
- **verbose reference material** → extract it to `docs/internal/<topic>.md` and leave a one-line pointer
- **duplicate skill content** → replace it with a one-line skill pointer
- **stale or inaccurate** → update it, or delete it only when nothing cites its rule ID (Step 4)

Also list the text other files pin, so it survives unchanged (Step 4):

```bash
grep -rln 'CLAUDE.md' scripts/tests back-end/scripts back-end/src/tests 2>/dev/null
```

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

# 3. Grep scripts and code for hardcoded log file paths (catches log paths that don't exist yet)
grep -rn '\-logs\.\|\.log["\x27]' scripts/ back-end/src/ agents/ --include='*.ts' --include='*.sh' --include='*.py' --include='*.json' 2>/dev/null | grep -v node_modules | head -30
```

Every log file path discovered MUST be reachable from the instruction files (Step 3). Cross-check against this list and add any discovered log file that is missing.

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

For any content in an instruction file that exceeds a few lines of detail (tables, multi-step procedures, curl examples), extract it to a standalone doc and leave a one-line pointer.

**Already extracted** (keep the pointers; never inline these back): `docs/internal/llm-call-map.md` (LLM call map), `docs/internal/prod-logs.md` (prod logs), `docs/internal/rose-completions.md`, `docs/internal/prod-env-vars.md`, `docs/internal/planner-memory.md`, `docs/setup-mac.md`, `docs/testing.md`; agent testing lives in `/loop`, PR review in `/deploy`, benchmarks in `/benchmark`.

**Package detail** (commands, layer rules, test and coverage commands for one service) goes to that package's CLAUDE.md, not to `docs/internal/`.

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
3. At most keep a one-line pointer to the skill (root CLAUDE.md "Where else to look" lists the main ones)
4. Otherwise omit that topic from CLAUDE.md. The content lives in the skill, the agent will find it when it needs it.

Only extract to `docs/internal/` when the content is **reference material** (data tables, credentials, API commands) that no skill covers.

---

## Step 3: Update the files in place

### Root CLAUDE.md

Keep its exact shape:

- `# Rose Labs`, the one-line RWLH purpose and the all-caps banners stay first.
- The `Sections:` line lists every `##` section in order; add or rename a section only when the user asks, and update that line with it.
- Each rule is one bullet on one line, one or two short clauses. Never hard-wrap a rule: tests match pinned phrases line by line.
- No numbered lists. A kept rule keeps its ID in parentheses (`(rule 0a)`, `(rules 1, 12, 19)`); never renumber an ID, reuse a deleted one or give a new rule a number just to have one.
- Add a bullet to the section it belongs to; replace an outdated bullet rather than adding a second one beside it.
- Repo-wide only: anything that applies only inside `front-end/`, `back-end/` or `agents/` goes to that package's file, and the root keeps at most a pointer.
- No YAML frontmatter: a `rose-agent-spawn` frontmatter key in any CLAUDE.md or AGENTS.md changes agent spawn authorization (`back-end/src/providers/agentGraph/cliAccount.ts`).

### Package CLAUDE.md files

For each of `front-end/`, `back-end/` and `agents/`:

- Keep its entry points, layer rules, local commands, test and coverage commands, and rules moved from the root with their IDs.
- Use the same one-line-per-rule bullets; group them under short `##` headings.
- Keep its `AGENTS.md` a symlink to the `CLAUDE.md` beside it (`ln -s CLAUDE.md AGENTS.md`); never replace the link with a copy.

### What to include

Only include rules that are:
1. Non-obvious (an agent wouldn't naturally do this)
2. Learned from past mistakes (the user added them for a reason)
3. Enforceable (the agent can check if it's following the rule)

Drop or shorten rules that are:
1. Already enforced mechanically (by ESLint, structural tests, CI), unless a pointer to the enforcing check helps
2. Generic software engineering advice
3. Too verbose (rewrite as one line)

Every log file and query script found in Step 1i must be reachable: listed in root "Repository" (local logs), the owning package file or a `docs/internal/` doc.

---

## Step 4: Verify

After updating the files:

1. **Line count and shape check:**
   ```bash
   wc -l CLAUDE.md                          # must be under 175
   grep -nE '^ *[0-9]+[a-z]?\. ' CLAUDE.md   # must print nothing: no numbered lists
   ```
   If over the budget, move package-only bullets to their package file or extract reference detail.

2. **No broken pointers:** For every file path in the root and package files, verify the file exists:
   ```bash
   for doc in CLAUDE.md front-end/CLAUDE.md back-end/CLAUDE.md agents/CLAUDE.md; do
     grep -oE '`[a-zA-Z][a-zA-Z0-9/_.-]+\.(ts|py|json|md|yaml|log|txt|mjs)`' "$doc" | tr -d '`' | while read f; do
       [ -e "$f" ] || [ -e "$(dirname "$doc")/$f" ] || echo "MISSING in $doc: $f"
     done
   done
   ```
   Fix any missing references (either create the extracted doc or remove the pointer).

3. **Cited rule IDs still exist:** every `rule N` cited elsewhere must still be defined in the root or a package file:
   ```bash
   git grep -hoE 'CLAUDE\.md rules? [0-9]+[a-z]?' -- . ':!docs/rca/cases' ':!docs/handoffs' ':!docs/plans/completed' | sort -u
   grep -ohE '\(rules? [0-9a-z, ]+\)' CLAUDE.md */CLAUDE.md | sort -u
   ```
   Restore a cited rule that went missing, or update the citing file to the rule's new location.

4. **Pinned text still passes:** run the tests that read CLAUDE.md (Step 1e), at least:
   ```bash
   bash scripts/tests/approval-format.test.sh
   bash scripts/tests/descend-command.test.sh
   bash scripts/tests/semantic-deploy-gate.test.sh
   python3 scripts/tests/deploy-failure-policy.test.py
   bash back-end/scripts/prisma-local-push.test.sh
   ```

5. **No duplicated content:** Verify that extracted docs exist and contain the detailed content:
   ```bash
   ls -la docs/internal/*.md 2>/dev/null
   ```

6. **Resource completeness:** Re-run the log file discovery commands from Step 1i. For every log file path found, verify the root "Repository" section, a package file or a `docs/internal/` doc points to it. Add any that are missing.

---

## Step 5: Information loss review (run TWICE)

**This step is critical. Run it exactly twice before proceeding to Step 6.**

After the first pass updates the files, information will inevitably be lost. Some of that loss is intentional (verbose content moved to extracted docs, skill-covered content omitted). Some is accidental (useful pointers, conventions, or reference data silently dropped).

### How to run each review pass:

1. **Read the previous files** (the versions from before this skill ran — use `git show HEAD:CLAUDE.md` and `git show HEAD:<package>/CLAUDE.md`, or the copies you read in Step 1e).

2. **Read the updated files** you just wrote.

3. **Diff them mentally, section by section.** For every piece of information in the old version, classify it:
   - **Kept** — present in the root or a package CLAUDE.md (possibly condensed). No action.
   - **Extracted** — moved to a `docs/internal/` file. No action.
   - **Covered by skill** — a skill (`.claude/commands/*.md`) contains this content. No action.
   - **Lost** — not in any CLAUDE.md, extracted doc or skill. **Evaluate below.**

4. **For each piece of lost information, ask:**
   - Is this a **file path, URL, command, or convention** that an agent would need and can't discover by searching? → **Restore it** (as a one-line bullet in the root or package file).
   - Is this a **workflow or multi-step procedure** already in a skill? → Confirmed covered, leave it out.
   - Is this **discoverable from the codebase** (e.g., by reading `package.json`, running `ls`, grepping)? → Safe to drop.
   - Is this a **domain-specific convention or gotcha** (e.g., naming conventions, migration workflow, manual release triggers) that an agent wouldn't know without being told? → **Restore it.**
   - Is this **stale, redundant, or generic advice**? → Confirmed drop.

5. **If any lost information should be restored**, add it as one-line bullets:
   - Repo-wide rules, paths, URLs and commands → the matching root section
   - Package-only rules and commands → that package's CLAUDE.md
   - Reference data (tables, recipes) → the owning `docs/internal/` doc

6. **After restoring, re-run the Step 4 verification checks** (line count and shape, broken pointers, cited rule IDs, pinned text, resource completeness).

### Pass tracking

Run this review exactly twice:
- **Pass 1:** Catch the obvious losses — sections that were entirely dropped, file paths that vanished, conventions that disappeared.
- **Pass 2:** Catch subtler losses — individual facts within sections that were partially condensed, specific commands or examples that were trimmed away.

After both passes, compile a list of everything you **deliberately chose NOT to restore** with a 1-line reason for each. This list is output to the user in Step 6.

---

## Step 6: Report

Output to the user:
- Line count of each file: before → after
- Bullets moved between files and docs extracted to `docs/internal/` (list with line counts)
- **Information deliberately dropped** (table format):

```markdown
| Dropped content | Reason |
|---|---|
| Rose API test file list (4 files) | Discoverable via `ls research/supabase/functions/completions/test-*` |
| ... | ... |
```

The user should be able to review the "deliberately dropped" table and tell you to restore anything they disagree with.

Only say **"CLAUDE.md files refreshed"** if:
- [ ] Root CLAUDE.md under 175 lines, one line per rule, no numbered list, section structure unchanged
- [ ] Every cited rule ID still resolves, and the pinned-text tests pass
- [ ] All file/doc references resolve to existing files
- [ ] Extracted docs exist in `docs/internal/`
- [ ] Two information loss review passes completed
- [ ] Deliberately-dropped table shown to user
