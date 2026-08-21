# RCA: IMAX earliest showtime selected without grounded filtered option set

## Symptom

`browser-imax-group-tickets` outcome-proof agent
`2982550e-0c34-42c3-a217-de16abd6885c` (run `20260821_024712`) passed
`imax-group-ticket-runtime-contract` (payment_approval ~$95.94, seats A1/A2/A3)
then failed `imax-group-ticket-adjacency-semantics` (score 0.0):

> The first missing requirement is grounded evidence that the 10:00 PM IMAX
> 70MM showing was the earliest qualifying premium-format showtime remaining
> tonight. The browser output shows the IMAX filter being selected and the
> 10:00 PM showtime clicked, but it does not expose the complete filtered
> showtime list… The assistant’s statement that it was the earliest is
> unsupported.

## Classification

**Agent Reasoning Failure** — task criteria, judge, tools, and fixtures are
valid; the browser agent selected a showtime and claimed “earliest” without
leaving a trajectory-grounded capture of the full filtered option set.

## Archive search

- `earliest showtime ordered options filtered` — related IMAX contract cases
  (payment prerequisite, purchase verifier) are evaluator/contract issues, not
  this agent-behavior gap.
- `adjacency-semantics grounded` — no prior case for missing showtime-list
  evidence before earliest pick.

Novel incident; not a recurrence of H-01–H-04.

## First-bad boundary

`agents/providers/rose/browser_use.py` → `build_browser_use_system_prompt`
`# Browser Rules` — no instruction required capturing the filtered option set
before an ordered (earliest/latest/cheapest) selection, so the acting agent
could click a single showtime and rely on thinking text alone.

## Owning-boundary proof

- **Pre-fix:** strip the ordered-options Browser Rules bullet →
  `test_build_browser_use_system_prompt_requires_ordered_option_set_capture`
  fails (`AssertionError: assert 'choosing among ordered options' in prompt`).
- **Post-fix:** restore bullet → same test passes; existing
  `test_build_browser_use_system_prompt_does_not_advertise_extract` still passes
  (bullet uses `screenshot` / `evaluate`, not `extract`).
- **Cement:**
  `build_browser_use_system_prompt_requires_ordered_option_set_capture` in
  `agents/tests/blackbox/rose_browser_use.blackbox.py`.

## Fix (superseded by Andy edit)

Initial proposal: Browser Rules bullet requiring filtered option-set capture
before ordered picks (landed on branch as defense-in-depth).

**Andy edit (H-05):** remove evaluator `imax-group-ticket-adjacency-semantics`.
Only that judge failed; `imax-group-ticket-runtime-contract` already passed.
Task becomes static_check-only, matching sibling `browser-event-ticket`.

## Outcome proof (pending)

Exact local `scripts/run-bench --local browser-imax-group-tickets` after Andy
approves the evaluator-removal snapshot. Owning-boundary green does not
complete the benchmark RCA.
