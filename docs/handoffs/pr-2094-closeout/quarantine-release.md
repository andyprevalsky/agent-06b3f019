# Two ready-marker releases after PR #2094

The native post-merge report recorded the fleet reserve-cohort case at 40/5 consecutive observations and the concurrent first-use identity case at 19/5. These counters qualify the standing five-pass release criterion; they are not a count of complete loaded parameterized runs. Actual ownership was reconciled before editing: PR #2039 owns Steel auth persistence, and PR #2064 owns both successor-cycle cases. Those three markers remain untouched.

This follow-up removes only the two unowned markers. Python retains its loader/binding initialization and both `admission` and `cancel-before-admission` parameters. TypeScript replaces the quarantine wrapper with its exact callback and removes the now-unused import. Whole-module AST comparisons and independent review verify that assertions, registration, timeouts, concurrency and cleanup remain unchanged.

Post-apply source base: `9030a5b1482179e60a229c4a7d022ac77b23afa4`. Prettier, ESLint, backend TypeScript and `git diff --check` passed. The native stability engine ran both existing owning runners five consecutive times with unchanged roots under eight occupied load slots, one unit at a time:

- Pytest selected the exact reserve-cohort function; both parameters ran on each of five passes (2 passed each run).
- The complete `auth-options` domain passed five times, including the named concurrent identity case in every domain log. It used a dedicated localhost database that the runner created and dropped.

The native explicit-file discovery command reported no added/changed top-level units for these imported sidecars and earned no execution credit. The preserved adapter calls the same native `run_stability` engine with explicit existing pytest/domain units; it retains the engine's case selection, load workers, deadlines, digest checks, database isolation and teardown. It does not alter source discovery or any gate. Digests before and after were identical; all ten unit attempts exited zero with load alive. All recorded load-process births were reaped and the isolated database was dropped.

This is marker release and closeout metadata only. It adds no benchmark, task execution, production behavior, permission, timeout, assertion change or smoke rerun. The original PR #2094 source, gates and production evidence retain their own revision binding. Full private evidence is included in the final closeout archive.
