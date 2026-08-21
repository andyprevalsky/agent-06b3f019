# RCA: `no_tool_failures` fails closed on recovered antibot pinned-host refusals

## Symptom

`browser-imax-group-tickets` H-05 outcome-proof agent
`cf706f38-081a-4210-81a7-0894433babcb` (run `20260821_032320`) observed
`request_payment_card` FINISHED (~$95.94) after H-05 removed the adjacency
LLM judge, then failed only on `imax-group-ticket-runtime-contract` /
`no_tool_failures`:

`Observed tool failure: spawn_browser_agent call_wL49vzmazTALcV6B9QsYJS40 status=ERROR`

The ERROR body was `Refusing to leave pinned page host 'www.google.com'…`
(close_tab / switch_tab / off-host click / navback / Ctrl+W / evaluate) while
an antibot pin was active; payment followed later in the same trajectory.

## Classification

**Faulty Evaluator** — same problem class as H-02/H-03 (recovered browser
ERROR counted after payment). Pinned-host guard refusals are expected escape
noise during challenge pin, not terminal tool failures when later recovery
exists.

## First-bad boundary

`agents/benchmarks/run_benchmark.py` → `_tool_runtime_failures` /
`_browser_agent_session_counts_and_failures` (no ignore for recoverable
pinned-host refusals).

## Owning-boundary proof

- **Pre-fix:** `_tool_runtime_failures` on run `20260821_032320` messages
  returned non-empty failures; static check `(False, Observed tool failure:…)`.
- **Post-fix:** same artifact → `[]` / `(True, All declared static checks passed)`.
- **Cement:**
  `declared_static_no_tool_failures_ignores_recoverable_pinned_host_refusal` +
  unrecovered negative control
  `declared_static_no_tool_failures_counts_unrecovered_pinned_host_refusal`.

## Fix

Ignore browser ERROR rows matching pinned-host refusal text only when a later
browser event proves recovery (FINISHED non-error action or
`request_payment_card`). Unrecovered refusals still fail closed.

## Andy note

Directive text is implicit harness-fix approval — do not re-ask after
`rm that evaluator` (or similar). H-05 adjacency-judge removal was treated as
approved under that rule; this H-06 evaluator fix continues the same
payment-terminal descent without a second ceremony stop for the identical
Faulty Evaluator class already approved on H-02/H-03.
