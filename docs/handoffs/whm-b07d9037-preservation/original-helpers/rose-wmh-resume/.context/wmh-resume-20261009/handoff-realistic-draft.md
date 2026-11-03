### Realistic fundraiser iterations (October 10-11)

The user sets world base rates per run through WMH context insertion
(`agents/benchmarks/wmh_context_insertion.py` → `--wmh-initial-state-file`):
`structured.simulation_event_probabilities` plus a scratchpad calibration note,
inside the stable task prefix. Current table
(`.context/wmh-resume-20261009/fundraiser/context/events-r1.json`): cold reply
0.07, warm reply 0.35, meeting accepted 0.45, meeting held 0.85, follow-up 0.25,
verbal commit 0.05 per meeting (~200 meetings for $5M), SAFE e-signed 0.95, wire
settles in Brex within one simulated business day 0.95. Window: 3,600 s
(user-authorized). Each run uses an external WMH started by
`.context/wmh-resume-20261009/run-fundraiser.sh <seconds> <state file>`.

Fixes from these runs, each with an owning test in the WMH/rose/benchmark gates:

- Native explore starvation: conflicted operations take the commit turn oldest
  first, so each rebases at most once (an 8-way fan-out needs 15 predictions,
  not 36).
- Output cut-offs: `RoseClient.collect(result_required=True)` applies Rose's
  cut-off recovery (larger limit, then next model) to a reply that is itself
  the result; WMH opts in and validates only the recovered attempt.
- No operation deadline: a Temporal retry rejoins the live native operation.
- Tree-stall early-fail counts in-flight WMH operations
  (`GET /world_models/{name}/sessions/{id}/activity`).
- Bridge keep-alive race: the bridge's idle timeout (30 s) outlives the
  child's (5 s).
- Azure first: the WMH pool tries its Foundry `gpt-6.1-sol` deployment before
  OpenRouter; billing routes are normalized out of the artifact's pool identity
  (still `31497e14…`).
- Append-merge (user-approved): a prediction whose selected outcome only
  appends records commits over append-only commits without re-predicting.

OpenRouter credit ran out on 2026-10-10 ($11,003.17 used of $11,000); local
`agents/.env` and `back-end/.env` now carry the Render Foundry settings.

| Run | Route | Ran | Outcome | Provider cache | DEMO | Progress |
| --- | --- | --- | --- | --- | --- | --- |
| `ee95747b` root `062da7ea` | OpenRouter | 1,099 s | false tree-stall (fixed) | 140,181 / 421,594 (33.25%) | 0/19 | ~8% |
| `291bb810` root `161810ab` | OpenRouter | 1,412 s | OpenRouter 402 | 265,023 / 1,197,051 (22.14%) | 0/66 | ~15% |
| `e4cd9280` root `a1495e13` | Azure | 3,618 s | 60-min cap | 0 / 2,703,298 (0%) | 0/66 | ~18% |

Run 3 had no world-model errors (65/66 predictions; one cancelled at
teardown): research, a $0 Brex check, then a for-each outreach to ~20 funds
whose children each ran a Gmail duplicate check and a pitch through the official
intake. 29 commits: 17 explores, 10 browser, 1 Claude Code, 1 SMS; about six
pitches sent, no replies yet. Its queue drained ~1 commit per 1.5 min because
the model records results by creating keys, which the first append-merge did
not cover (fixed in `6752dc48`). Azure prompt caching reuses only a shared
`instructions` prefix or an exact repeat, never a prefix shared inside the user
input (measured 0 cached tokens for a 4.5k-token shared input prefix; 9,208 of
9,230 when the same text sat in instructions), so the WMH layout gets 0% there.
FE: https://www.roselabs.ai/?agent-id=a1495e13-6262-47d3-98fe-9f93a5840dd4#benchmark-share=e4cd9280-b953-4383-affa-50723fe0bc89.1794290166.5134b4f7bfbec86bb7d0ebf5d589c6365526e09a8ca20ee400e51707a11fc900
