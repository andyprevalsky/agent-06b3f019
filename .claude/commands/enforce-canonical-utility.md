---
description: "Add ESLint custom rules to enforce that a cross-cutting concern uses its canonical utility. Bans hand-rolled alternatives via no-restricted-syntax."
argument-hint: "<utility-name> (e.g., retry, config) — or leave blank to run full audit"
---

# Enforce Canonical Utility

Add ESLint `no-restricted-syntax` rules that ban hand-rolled implementations of cross-cutting concerns, pointing developers to canonical utilities in `providers/` (backend) or `shared/lib/` (frontend) instead.

**This is a loop. Do NOT stop after partial work. Continue until ESLint passes on the entire codebase.**

## Background

From the OpenAI harness engineering playbook: when the same capability is implemented N times, only one version gets proper observability. The fix is to designate one canonical implementation and ban alternatives via lint rules.

The structural tests in `layer-deps.test.ts` enforce **architecture** (import direction, boundaries). This skill enforces **"use the shared thing, don't roll your own"** via ESLint AST selectors.

---

## Source root detection

Before any audit, determine `<source-root>` — the directory containing the domain/feature source code:

```bash
# Detect source root: look for domains/, features/, or src/ with domain-like structure
for candidate in ./back-end ./front-end ./src . ; do
  if [ -d "$candidate/src/domains" ] || [ -d "$candidate/src/features" ] || [ -d "$candidate/domains" ] || [ -d "$candidate/features" ]; then
    echo "SOURCE_ROOT=$candidate"
    break
  fi
done
```

All commands below use `<source-root>` as a placeholder. Replace it with the detected path. For frontend codebases, also substitute: `domains/` → `features/`, `providers/` → `shared/lib/`, `utils/` → `shared/utils/`.

---

## Step 0: Audit for cross-cutting concern leakage (if `$ARGUMENTS` is empty)

If `$ARGUMENTS` is empty, **do not ask the user**. Instead, run an audit to discover cross-cutting concerns that have leaked into domain code.

The audit has two phases: **import graph analysis** (primary, structural, catches everything) and **inline pattern scan** (secondary, catches reimplementations that don't show up as imports).

### 0a. Import graph fan-in analysis (primary discovery mechanism)

This is the most robust way to find cross-cutting concerns. Instead of grepping for known patterns, analyze what domains actually import and look at **fan-in** — which external dependencies appear across the most domain files.

**Extract and categorize all imports from `domains/`:**

For every source file under `<source-root>/src/domains/` (or `<source-root>/src/features/` for frontend), extract its import statements and categorize each one:

| Category | Pattern | What it means |
|----------|---------|---------------|
| **Provider** | `from '../../providers/...'` or `from '@/providers/...'` | Correct — using the canonical provider |
| **Util** | `from '../../utils/...'` | Correct — using shared utility |
| **npm package** | `from 'stripe'`, `from 'ioredis'`, `from 'twilio'` | ⚠️ Direct dependency — should go through a provider |
| **Node built-in** | `from 'node:crypto'`, `from 'node:fs'`, `from 'fs'` | ⚠️ Infrastructure concern — should go through a provider |
| **Other domain** | `from '../other-domain/...'` | ⚠️ Cross-domain coupling (structural tests may already catch this) |
| **Relative local** | `from './types'`, `from './service'` | OK — intra-domain import |

```bash
cd <source-root> && grep -rhn "^import\|^} from\|from '" src/domains/ src/features/ --include="*.ts" --include="*.tsx" 2>/dev/null | \
  grep -v "from '\.\/" | \
  sed "s/.*from '//; s/'.*//" | \
  sort | uniq -c | sort -rn | head -40
```

This gives you a ranked list of external dependencies by fan-in. **High fan-in = cross-cutting concern.**

**Key thresholds:**
- **3+ domains importing the same npm package directly** → Definitely needs a provider wrapper
- **2+ domains importing the same Node built-in** → Likely needs a provider
- **Any domain importing an npm package that a provider already wraps** → The domain is bypassing the provider

**Cross-reference with existing providers:**

```bash
ls <source-root>/src/providers/ <source-root>/src/shared/lib/ 2>/dev/null    # What providers exist?
ls <source-root>/src/utils/ <source-root>/src/shared/utils/ 2>/dev/null      # What utils exist?
```

For each high-fan-in dependency:
- **Provider already exists for this concern** → Domain is bypassing it. Add ESLint rule + migrate.
- **No provider exists, fan-in ≥ 2** → Create a thin provider wrapper, add ESLint rule, migrate domain code.
- **Fan-in = 1** → Still add an ESLint rule (ban the raw import/pattern in domains). Migrate the single usage to go through a provider or suppress with justification.

### 0b. Inline pattern scan (secondary — catches reimplementations)

Import analysis misses cases where developers reimplement a concern inline without importing anything (e.g., hand-rolling a retry loop with `setTimeout`, or reading `process.env` directly). Scan for these:

```bash
cd <source-root> && echo "=== Inline pattern scan ===" && \
DOMAIN_DIR=$([ -d src/domains ] && echo "src/domains/" || echo "src/features/") && \
for pattern in 'process\.env\.' 'console\.(log|error|warn)' 'setTimeout' 'crypto\.' 'fs\.' 'new Headers' 'Authorization.*Bearer'; do
  count=$(grep -rn "$pattern" "$DOMAIN_DIR" --include="*.ts" --include="*.tsx" 2>/dev/null | wc -l)
  if [ "$count" -gt 0 ]; then
    echo "--- $pattern ($count hits) ---"
    grep -rn "$pattern" "$DOMAIN_DIR" --include="*.ts" --include="*.tsx" | head -10
    echo ""
  fi
done
```

**Frontend-specific inline patterns** (add to the scan if the codebase is a React/frontend SPA):

```bash
cd <source-root> && echo "=== Frontend inline pattern scan ===" && \
for pattern in 'fetch(' 'axios\.' 'useNavigate\|useRouter' 'localStorage\.' 'sessionStorage\.' 'window\.location' 'document\.(get|query)' 'console\.(log|error|warn)'; do
  count=$(grep -rn "$pattern" src/features/ --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v '/api\.' | grep -v 'shared/lib' | wc -l)
  if [ "$count" -gt 0 ]; then
    echo "--- $pattern ($count hits outside api/shared/lib) ---"
    grep -rn "$pattern" src/features/ --include="*.ts" --include="*.tsx" | grep -v '/api\.' | grep -v 'shared/lib' | head -10
    echo ""
  fi
done
```

Key frontend concerns:
- **Direct fetch/axios outside `api.ts`** → must go through the feature's `api.ts` layer or `shared/lib/apiClient`
- **Direct router/navigation outside components** → `useNavigate`/`useRouter` only in component files or page files
- **Direct localStorage/sessionStorage** → should go through `shared/lib/storage.ts`
- **Direct DOM access** → should go through shared hooks

### 0c. Semantic review (catches what mechanical scans miss)

Import graphs and pattern scans are mechanical — they only find what can be detected structurally. But some cross-cutting concerns only emerge from understanding what the code *does*:

- **Repeated response shapes** — Do multiple domains manually construct the same error/success response format? That's a response builder concern.
- **Duplicated validation logic** — Are multiple domains hand-validating the same patterns (emails, phone numbers, UUIDs)? That's a validation utility concern.
- **Bespoke auth checks** — Are domains checking permissions inline instead of through middleware?
- **Repeated data transformations** — Do multiple domains serialize/deserialize the same way (e.g., snake_case ↔ camelCase, date formatting)?
- **Duplicated pagination** — Are multiple route files building offset/limit/cursor logic independently?
- **Inline rate limiting** — Are domains tracking request counts or timestamps to throttle?
- **Repeated error wrapping** — Do multiple domains catch errors and wrap them in the same shape before re-throwing?

**How to do this:** Scan **every** domain, not a sample. Use the Agent tool to parallelize — launch one sub-agent per domain in rolling batches of 10. Each sub-agent reads all files in its assigned domain and answers one question:

> "What code in this domain is solving an infrastructure problem rather than a domain problem? List any repeated patterns: error response construction, validation, auth checks, data transforms, pagination, rate limiting, error wrapping, or anything else that looks like boilerplate rather than business logic."

Each sub-agent returns a short list of findings (pattern description + file:line references). After all batches complete, deduplicate across domains — if the same pattern appears in 3+ domains, it's a cross-cutting concern.

Add any findings to the report table with `How discovered: Semantic review`.

### 0d. Produce a report

Combine findings from 0a (import graph), 0b (inline patterns), and 0c (semantic review) into a single table:

| Cross-cutting concern | How discovered | Fan-in / count | Provider exists? | Files affected | Action |
|----------------------|---------------|----------------|-----------------|---------------|--------|
| Stripe billing | Import graph: `stripe` in 6 domains | 6 | No | list... | **Create** `providers/stripe.ts` + ESLint `no-restricted-imports` + migrate |
| Retry/backoff | Inline scan: `for` + `setTimeout` in 2 files | 2 | `retry.ts` ✓ | list... | ESLint rule already exists ✓ |
| Config access | Inline scan: `process.env.X` in 8 files | 8 | domain config.ts pattern | list... | ESLint rule + migrate to config.ts |
| Redis caching | Import graph: `ioredis` in 4 domains | 4 | No | list... | **Create** `providers/cache.ts` + ESLint `no-restricted-imports` + migrate |
| Error responses | Semantic review: 5 domains build `{ error, status }` | 5 | No | list... | **Create** `utils/apiResponse.ts` + ESLint rule + migrate |
| Logging | Inline scan: `console.*` | — | `logger.ts` ✓ | — | Already enforced by `no-console` ✓ |

Every row must end with an action that results in an ESLint rule. No "flag for later" or "recommendation" — fix it now.

**Prioritize by fan-in** — the concern that touches the most domains gets enforced first.

**There are no "gaps." Every cross-cutting concern found in domain code MUST get an ESLint rule by the end of this run.** If a provider doesn't exist, create one. Then add the rule, then migrate domain code.

Then proceed to Step 0e (create missing providers) and Step 1 (add ESLint rules) for **every** concern in the table, starting with the highest-fan-in concern.

### 0e. Create thin provider wrappers for concerns that lack one

For each concern where no provider exists, create a **thin wrapper** in `providers/` (or `utils/` if it's a pure utility with no I/O). The wrapper should:

1. **Re-export** a configured instance or helper functions that domain code can import
2. **Be minimal** — just enough surface area to cover what domain code currently does. Don't over-abstract.
3. **Centralize the raw import** — the provider file is the ONE place that imports the npm package / Node built-in directly

**Examples of thin wrappers:**

```typescript
// providers/crypto.ts — thin wrapper around Node crypto
import crypto from 'crypto';
export function randomUUID(): string { return crypto.randomUUID(); }
export function randomBytes(size: number): Buffer { return crypto.randomBytes(size); }
export function createHash(algorithm: string) { return crypto.createHash(algorithm); }
export function createHmac(algorithm: string, key: string | Buffer) { return crypto.createHmac(algorithm, key); }
export function timingSafeEqual(a: Buffer, b: Buffer): boolean { return crypto.timingSafeEqual(a, b); }
// Add only what domain code actually uses — grep domain files to find the full set of crypto operations.
```

**What NOT to do:**
- Don't create an elaborate abstraction layer — just re-export what's needed
- Don't change function signatures — keep the wrapper transparent so migration is trivial
- Don't add logging/metrics/retry in this step — that's a future enhancement

After creating each provider, add it to the `STRICT_DOMAIN_FILES` array in `eslint.config.mjs` if applicable.

---

## Step 1: Identify the canonical utility and its banned alternatives

If `$ARGUMENTS` was provided, use it directly. Otherwise, work through **every** concern from the Step 0 audit — both existing providers being bypassed AND providers you just created in Step 0e.

Read the canonical utility file to understand what it provides. Then identify the **AST patterns** that signal a hand-rolled alternative.

For each banned pattern, you need:
- An **ESTree AST selector** that matches the pattern (used by ESLint `no-restricted-syntax`)
- A **human-readable message** that names the canonical alternative

For **direct npm package imports** that bypass a provider, use `no-restricted-imports` instead of `no-restricted-syntax`:
```javascript
'no-restricted-imports': ['error', {
  paths: [{ name: 'stripe', message: 'Use providers/stripe.ts instead of importing stripe directly.' }],
}],
```

### Pattern reference for common utilities

**Retry/backoff** (`providers/retry.ts`):
| Pattern | AST Selector | Message |
|---------|-------------|---------|
| `for` loop with setTimeout | `ForStatement:has(CallExpression[callee.name='setTimeout'])` | Use `retryWithBackoff()` from `providers/retry.ts` instead of hand-rolling retry loops. |
| `while` loop with setTimeout | `WhileStatement:has(CallExpression[callee.name='setTimeout'])` | Use `retryWithBackoff()` from `providers/retry.ts` instead of hand-rolling retry loops. |

**Config access** (`providers/config.ts` — if it exists):
| Pattern | AST Selector | Message |
|---------|-------------|---------|
| Direct `process.env.X` reads | `MemberExpression[object.object.name='process'][object.property.name='env']` | Use config from `providers/config.ts` instead of reading `process.env` directly. |

**Logging** (`providers/logger.ts`):
Already enforced globally by `no-console: error`. No additional rule needed.

**HTTP client** (`providers/http.ts` — if it exists):
| Pattern | AST Selector | Message |
|---------|-------------|---------|
| Bare `fetch()` calls in domains | `CallExpression[callee.name='fetch']` | Use the canonical HTTP client from `providers/http.ts` instead of calling `fetch()` directly. |

**Frontend-specific patterns:**

| Pattern | AST Selector | Message |
|---------|-------------|---------|
| Direct `fetch()` in features | `CallExpression[callee.name='fetch']` | Use the API client from `shared/lib/apiClient` via the feature's `api.ts` instead of calling `fetch()` directly. |
| Direct localStorage | `MemberExpression[object.name='localStorage']` | Use `shared/lib/storage.ts` instead of accessing localStorage directly. |
| Direct sessionStorage | `MemberExpression[object.name='sessionStorage']` | Use `shared/lib/storage.ts` instead of accessing sessionStorage directly. |

**Other patterns**: Read the utility, identify what inline code it replaces, and craft an AST selector. Use https://astexplorer.net with the `@typescript-eslint/parser` to test selectors.

## Step 2: Add the rules to eslint.config.mjs

Read the ESLint config (`eslint.config.mjs` or equivalent) in `<source-root>`. Add the `no-restricted-syntax` rules to the **base config** (applies to all `.ts`/`.tsx` files).

Rules go in the existing base config's `rules` object:

```javascript
'no-restricted-syntax': ['error',
  {
    selector: '<AST_SELECTOR>',
    message: '<CANONICAL_ALTERNATIVE_MESSAGE>',
  },
  // ... more patterns
],
```

**Important**: If `no-restricted-syntax` already has entries, APPEND to the existing array — don't replace it.

## Step 3: Run ESLint to find all existing violations

```bash
cd <source-root> && npx eslint src/ --no-fix 2>&1 | grep "no-restricted-syntax\|no-restricted-imports" | head -50
```

This shows every file that still uses the banned pattern. These are the files that need migration.

## Step 4: Triage violations

For each violation, decide:

1. **Migrate now** — The file can trivially switch to the canonical utility. Do it.
2. **Suppress with eslint-disable** — The file has a legitimate reason to use the pattern (e.g., the canonical utility itself, a Prisma extension that can't use the wrapper, browser-context code). Add an `eslint-disable-next-line` with a comment explaining WHY.

**Rules for eslint-disable:**
- The canonical utility file itself (`retry.ts`, `config.ts`, etc.) should have a file-level disable for its own pattern
- Files where the pattern is structurally different from what the utility handles (e.g., Prisma `$extends` middleware) get a disable with explanation
- Everything else gets migrated, not suppressed

## Step 5: Fix violations

For files being migrated:
1. Import the canonical utility
2. Replace the hand-rolled pattern with a call to the utility
3. Remove any now-unused local helpers (e.g., `sleep()` functions)

For files being suppressed:
1. Add `// eslint-disable-next-line no-restricted-syntax -- <reason>` above the flagged line
2. The reason must explain why this case can't use the canonical utility

## Step 6: Verify

### 6a. ESLint passes
```bash
cd <source-root> && npx eslint src/ 2>&1 | tail -5
```
Must report 0 errors (or only pre-existing errors unrelated to this change).

### 6b. TypeScript compiles
```bash
cd <source-root> && npx tsc --noEmit 2>&1 | grep -v fetchCapture
```
Must report 0 errors.

### 6c. Structural tests pass
```bash
cd <source-root> && npx tsx <structural-test-path>
```

### 6d. Blackbox tests pass (if running)
```bash
cd <source-root> && <blackbox-test-command> 2>&1 | tail -10
```

## Step 7: Report

Output:
- **Audit results** (if run): table of cross-cutting concerns found via import graph + inline patterns, ranked by fan-in
- **Providers created this run**: any new thin wrappers added to `providers/` or `utils/`
- **Rules enforced this run**: the ESLint selectors added (selector + message)
- **Files migrated** to use the canonical utility
- **Files suppressed** with eslint-disable (and why)
- **Test results**

**There must be zero gaps.** Every cross-cutting concern found in domain code must have an ESLint rule by the end of this run. If you identified a concern but didn't add a rule for it, you're not done.

Only say **`Canonical utility enforcement complete`** if ALL of:
- [ ] Audit completed (if no arguments provided)
- [ ] Every cross-cutting concern has an ESLint rule — zero gaps
- [ ] ESLint passes with 0 new errors
- [ ] TypeScript compiles
- [ ] Structural tests pass
- [ ] Every suppression has a documented reason
