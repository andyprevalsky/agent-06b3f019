# V39 operator boundary fixtures

`provenance.json` binds each sanitized native object to its preserved private
original SHA. Object fields, provider-event ordering, timestamps and old/fresh
inequality are retained. Resource identities are replaced consistently; image
identity and executable status-file payload are harmless fixture values. These
fixtures prove full-object equality, not actual provider eligibility.

The native-pair RED selects the original mismatched inputs using
`CLOUDBENCH_V39_PAIR_SELECTION=captured`. GREEN selects the fresh pair. The
production `current_cold_native` validator remains unchanged: the defect was
operator input selection, not a permissive validator.

`runtime.json` preserves the exact AST-selected venv assignment and following
assertion from the failed source whose SHA is recorded. The retained private
runtime fixture fails that historical `/app` assumption and passes the actual
shared receipt-bound selector; the remaining ABI/package verification stays in
the private caller.

The all-UID cleanup case invokes the actual canonical `writers` function with a
controlled proc filesystem. It rejects PID1 and other non-self protected
writers and unobservable processes, without requiring a particular PID1 init
shape. `cleanup.json` preserves the original failed guest assertion and PID1
exclusion recovered from root tool call4498. Captured mode
`CLOUDBENCH_V39_CLEANUP_SELECTION=captured` fails its historical assumption that
PID1 runs `/bin/sleep 180` when the observed provider init is `/fly/init`.
The corrected canonical predicate has no PID1 special case. This is a captured
boundary replay, not an actual native process observation.
