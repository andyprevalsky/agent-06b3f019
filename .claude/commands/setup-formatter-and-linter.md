---
description: "Apply Prettier formatting + strict ESLint rules to a single backend domain. Fixes files, adds them to strict enforcement, and verifies blackbox tests still pass."
argument-hint: "<domain-name>"
---

# Setup Formatter and Linter for a Domain

Apply Prettier formatting and strict ESLint enforcement to a single backend domain, one domain at a time to keep diffs small and reviewable.

If `$ARGUMENTS` is empty, ask the user for the domain name and stop.

**This is a loop. Do NOT stop after partial work. Continue until the domain is fully clean and tests pass.**

## Phase 1 strict rules being enforced

These rules are added on top of the base ESLint config for cleaned domains:

| Rule | Config |
|---|---|
| `max-lines` | 300 (tightened from base 600) |
| `max-lines-per-function` | 80 |
| `@typescript-eslint/no-floating-promises` | error |
| `@typescript-eslint/no-misused-promises` | error |
| `@typescript-eslint/strict-boolean-expressions` | error |
| `@typescript-eslint/consistent-type-imports` | error (prefer type-imports) |

Plus Prettier formatting for consistent style.

## Step 1: Identify domain files

Run the domain map to get all files in the domain's import graph:

```bash
cd back-end && npx tsx scripts/map-domains.ts $ARGUMENTS
```

This gives you the route file and all its transitive local imports. These are the files you will format and lint.

**Important:** Shared files (lib/, middleware/) touched by multiple domains should only be fixed if they don't break other domains. When fixing a shared file, run the full blackbox suite afterward, not just the target domain's tests.

## Step 2: Run Prettier on domain files

Format all domain files with Prettier:

```bash
cd back-end && npx prettier --write <file1> <file2> ...
```

Use the exact file paths from Step 1.

## Step 3: Run ESLint --fix on domain files

Auto-fix what ESLint can handle:

```bash
cd back-end && npx eslint --fix <file1> <file2> ...
```

This uses the base config rules (not strict yet — strict rules get enabled after the files are clean).

## Step 4: Enable strict rules and check remaining errors

Temporarily add the domain's files to `STRICT_DOMAIN_FILES` in `back-end/eslint.config.mjs`, then run ESLint to see what strict violations remain:

```bash
cd back-end && npx eslint <file1> <file2> ...
```

For each remaining error, fix it manually:

- **`no-floating-promises`**: Add `await` or `void` prefix
- **`no-misused-promises`**: Don't pass async functions where sync callbacks are expected
- **`strict-boolean-expressions`**: Use explicit comparisons (`!== null`, `!== undefined`, `.length > 0`)
- **`consistent-type-imports`**: Change `import { Foo }` to `import type { Foo }` for type-only imports
- **`max-lines`**: Extract helpers or split the file
- **`max-lines-per-function`**: Extract sub-functions

**Do NOT add eslint-disable comments.** Fix the actual code. The only exception is if a fix would change observable behavior — document why and get user approval.

## Step 5: Verify blackbox tests pass

Run the domain's blackbox tests:

```bash
cd back-end && npm run test:blackbox:existing -- $ARGUMENTS
```

If the domain touches shared files (lib/, middleware/), also run the full suite:

```bash
cd back-end && npm run test:blackbox:existing
```

If tests fail, the formatting/linting introduced a behavior change. Fix it before proceeding.

## Step 6: Finalize strict enforcement

Confirm the domain's files are in `STRICT_DOMAIN_FILES` in `back-end/eslint.config.mjs`. This ensures future changes to these files must also pass strict rules.

Verify the strict config is active:

```bash
cd back-end && npx eslint <file1> <file2> ...
```

Should report 0 errors.

## Step 7: Report

Output:
- Which files were formatted and linted
- What manual fixes were needed (and why)
- Blackbox test results
- The updated `STRICT_DOMAIN_FILES` list

Only say `Domain lint enforcement complete` if:
- All domain files pass Prettier check (`npx prettier --check`)
- All domain files pass ESLint with strict rules (0 errors)
- All blackbox tests pass
- `STRICT_DOMAIN_FILES` is updated in `eslint.config.mjs`
