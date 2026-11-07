# Production semantic source attribution

The first local fallback was mistakenly run from PR branch tip
`d9b7106284c305db89c9df5f36b1d8102ecbeb20`. Its stale semantic spec expected
`Expand display: Orbit Runner`, while production correctly rendered the display
expanded and returned `Collapse display: Orbit Runner`.

Independent RCA thread:
https://boxes.dev/thread/ph7c89gkk49wr8nc6t6gq5whhd8hrcwa

`Gate: NOT_INTRODUCED`

The merge `50a582a14dd2dcec7d63e8b46c6fbbf7c0ace275` and its first parent
`d7fcfa021f7ec37a41ec3899db3321a28cc8ea98` contain byte-identical display
implementation and tests. Both initialize expanded state and assert
`Collapse display: Orbit Runner`. The expanded-by-default behavior and matching
test landed through PR #1725 more than twelve hours before PR #1726 merged.

The exact focused production test passed on the merge in 18.2 seconds. The full
exact-merge fallback then passed 47 broad cases with 6 intentional skips, and
all 5 latency cases passed. This is a recurrence of the wrong-source/stale-spec
validation class, not a deployed product defect, so there is no repair handoff.
