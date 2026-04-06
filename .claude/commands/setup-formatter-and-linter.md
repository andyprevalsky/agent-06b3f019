---
description: "Apply formatting and strict lint rules to a single domain. Fixes files, adds them to strict enforcement, and verifies blackbox tests still pass."
argument-hint: "<domain-name>"
---

# Setup Formatter and Linter for a Domain

Apply formatting and strict lint enforcement to a single domain, one domain at a time to keep diffs small and reviewable.

Read `.context/attachments/pasted_text_2026-04-05_20-13-11.txt` for the foundational thinking. Key insight: "We invested heavily in custom linters with auto-fix capability, especially for agents... every lint rule comes with a clear fix description, so agents can self-correct rather than just failing."

If `$ARGUMENTS` is empty, ask the user for the domain name and stop.

**This is a loop. Do NOT stop after partial work. Continue until the domain is fully clean and tests pass.**

## Step 0: Verify required infrastructure

### 0a: Domain mapping script

```bash
find . -maxdepth 3 -name 'map-domains.*' -o -name 'map_domains.*' | grep -v node_modules | grep -v __pycache__
```

**If no domain mapping script is found:** Run `/map-domains` first. It will analyze the codebase and write the mapping script.

### 0b: Lint config with strict per-domain overlay

```bash
# TypeScript
find . -maxdepth 2 -name 'eslint.config.*' -o -name '.eslintrc.*' | grep -v node_modules
# Python
find . -maxdepth 2 -name 'pyproject.toml' -o -name 'ruff.toml' | grep -v node_modules
# Other
find . -maxdepth 2 -name '.golangci.yml' -o -name 'Cargo.toml' | grep -v node_modules
```

If a config exists, check whether it supports **per-domain strict enforcement** — a mechanism to apply tighter rules to a specific list of files while leaving the rest of the codebase on base rules. If it does, proceed to Step 1.

**If no lint config with strict overlay support exists**, create one. Read the existing implementation at `back-end/eslint.config.mjs` for the pattern, then adapt it to this codebase's language.

#### Requirements for the lint config

1. **Base rules for all source files** — reasonable defaults: unused vars, consistent formatting, basic error prevention
2. **Strict overlay** — tighter rules applied ONLY to files explicitly opted in:
   - **File size**: max 300 lines (skip blanks/comments)
   - **Function size**: max 80 lines per function
   - **Async correctness**: no unhandled promises, no misused async callbacks
   - **Type safety**: strict boolean expressions, consistent type imports
   - **No side-effect leaks**: no raw `print`/`console.log` (use structured logging)
3. **Per-domain file list** — a list of file globs/paths under strict enforcement. New domains are added to this list as they're cleaned. This list must be easy to edit (a simple array or config section at the top of the file).
4. **Incremental adoption** — files NOT in the strict list still get base rules only. This lets you clean one domain at a time without breaking the rest of the codebase.
5. **Formatter compatibility** — must not conflict with the project's formatter
6. **CI-runnable** — a single command to check lint for the whole codebase

#### Language-specific guidance

**TypeScript (ESLint flat config + Prettier):**
- Create `eslint.config.mjs` using `typescript-eslint` flat config API
- Define `STRICT_DOMAIN_FILES` as a const array at the top of the file
- Base: `@eslint/js` recommended + `typescript-eslint` recommended
- Strict overlay: type-aware rules (`projectService: true`) — `no-floating-promises`, `no-misused-promises`, `strict-boolean-expressions`, `consistent-type-imports`
- Add `eslint-config-prettier` last to disable format-conflicting rules
- Formatter: `.prettierrc` with project conventions (inspect existing code for quote style, trailing commas)

**Python (Ruff):**
- Add `[tool.ruff]` section to `pyproject.toml` (or create `ruff.toml`)
- Base: `select = ["E", "F", "W", "I"]` (pycodestyle, pyflakes, isort)
- Strict overlay via `[tool.ruff.per-file-overrides]`:
  - Additional rules: `"B"` (bugbear), `"SIM"` (simplify), `"C901"` (complexity), `"TCH"` (type-checking imports)
  - Tighter line length or complexity thresholds for cleaned files
- Formatter: `ruff format` (built-in) or Black defaults

**Go (golangci-lint):**
- Create `.golangci.yml`
- Base: `govet`, `errcheck`, `staticcheck`
- Strict: `gosec`, `cyclop` (complexity), `funlen` (function length)
- Per-domain: use `issues.exclude-rules` with path filters

After creating the config:
1. Run the linter on an existing file — verify 0 errors on clean code
2. Introduce a deliberate violation in a file on the strict list — verify it's caught
3. Remove the violation

### 0c: Formatter config

If no formatter config exists for this codebase's language, create one using the language's standard conventions. Inspect existing code to match the project's style (indentation, quote style, line length).

## Step 1: Identify domain files

Run the domain mapping script to get all files in the domain's import graph:

```bash
<mapping-script> $ARGUMENTS
```

These are the files you will format and lint.

**Important:** Shared files (providers/, helpers/, lib/) touched by multiple domains should only be fixed if they don't break other domains. When fixing a shared file, run the full blackbox suite afterward, not just the target domain's tests.

## Step 2: Format domain files

Run the formatter on all domain files from Step 1:

```bash
# TypeScript
npx prettier --write <file1> <file2> ...
# Python
ruff format <file1> <file2> ...
```

## Step 3: Run linter with auto-fix

Auto-fix what the linter can handle (base rules, not strict yet):

```bash
# TypeScript
npx eslint --fix <file1> <file2> ...
# Python
ruff check --fix <file1> <file2> ...
```

## Step 4: Enable strict rules and fix remaining errors

Add the domain's files to the strict enforcement list in the lint config, then run the linter to see what strict violations remain:

```bash
<linter> <file1> <file2> ...
```

For each remaining error, fix it manually:

- **Unhandled promises / async errors**: Add `await` or explicit `void` (TS), ensure all coroutines are awaited (Python)
- **Strict boolean expressions**: Use explicit comparisons (`!== null`, `!== undefined`, `.length > 0`)
- **Type imports**: Use `import type { Foo }` (TS) or `from __future__ import annotations` (Python)
- **File too long**: Extract helpers or split the file
- **Function too long**: Extract sub-functions
- **Complexity too high**: Simplify control flow, extract sub-functions

**Suppress-only policy** (ordered by priority):
1. **Prompt strings**: If a lint rule flags code inside an LLM-facing string (system prompts, tool descriptions, messages sent to LLMs), suppress with a disable comment. **Never modify prompt content to satisfy a lint rule.**
2. **Behavior-changing fixes**: If a fix would change observable runtime behavior, suppress with a comment explaining why, and get user approval.
3. **Everything else**: Fix the actual code. Do NOT add disable comments — fix the root cause.

## Step 5: Verify blackbox tests pass

Run the domain's blackbox tests:

```bash
<blackbox-test-runner> $ARGUMENTS
```

If the domain touches shared files, also run the full suite. If tests fail, the formatting/linting introduced a behavior change. Fix it before proceeding.

## Step 6: Finalize strict enforcement

Confirm the domain's files are in the strict enforcement list. Verify both report 0 issues:

```bash
# Formatter check (no writes, just verify)
<formatter> --check <domain-files>
# Linter check
<linter> <domain-files>
```

## Step 7: Report

Output:
- Which files were formatted and linted
- What manual fixes were needed (and why)
- Blackbox test results
- The updated strict enforcement file list

Only say `Domain lint enforcement complete` if:
- All domain files pass formatter check
- All domain files pass linter with strict rules (0 errors)
- All blackbox tests pass
- Strict enforcement list is updated in the lint config
