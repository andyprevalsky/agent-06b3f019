Run13 is the single authorized 60-minute simulation on `badbbc2b3`. These
follow-up changes were developed in a separate local worktree while that run
continued. They were not hot-loaded and have not received a paid model trial.

The running Flash/Azure configuration is much faster than Run12, but some Luna
replies contain malformed JSON. Native protocol repair recovers some attempts;
exhausted repairs can fail activities. The existing provider discards rejected
reply bytes before the native record is written, so the exact original bad
strings are unavailable for an unchanged parser replay. This is an observability
gap; the absence of JSON mode is not claimed as a proven live root cause.

The next prepared WHM configuration uses `WMH_JSON_MODE=1`. It sends JSON-object
format through Rose's existing Azure Responses and Cerebras/OpenRouter paths;
the strict native distribution/state/call-ID validation remains. This setting
has its own execution and DEMO cache identity. Ordinary calls retain their
existing output format and cache material. Rejected replies now reach the
loopback native adapter for its existing private, redacted prediction record,
allowing an exact future parser repro without another model call. They are not
added to world history, cache replay, tool errors or ordinary logs.

The DEMO store logs also overstated persistence. Run12 has 107 `llm.cache.stored`
events and 107 explicit `fast_cache.set_skipped_demo_namespace` events. During
Run13 the same mismatch was observed with an empty owned cache table. Executing
the exact baseline `RoseClient.complete` method with a rejected cache write
reproduced a false stored event. The corrected owning test passes for both
accepted and rejected writes. Both Rose cache paths now report the write result.
The isolated trajectory helper explicitly enables deliberate DEMO recording only
for the owned local run; shared/global recording policy is unchanged. Run13
itself still uses the original frozen write setting. Logged attempts are not
counted as durable stores in the report. The current private database snapshot
is preserved before canonical cleanup; originals and their receipts are intact.

Full source fixture verification still passes: all 42,910 Tamy messages exist
in the running benchmark DB. The native initial-state file is 10,523 JSON bytes
and describes network/source counts and connectivity, including 2,225 contacts;
it does not contain all underlying message contents. Consequently complete DB
seeding is not proof that the native model can establish actual warm paths.
Preparing source-grounded message evidence is a distinct next-step decision.
No correspondence, prior relationship, investor interest or money was invented
to fill that gap.

Validation: world-model-harness includes 59 native cases and 200 provider,
identity, clock, wire, initial-state and vendor cases; Rose's 224 cases and
fast-cache-client also pass. Tests inspect the actual Azure request body, default
format isolation, cache write-result logging, private rejected-reply plumbing,
repair without an invalid commit, and sample/replay integrity. No new agents,
paid calls, benchmark/prompt/evaluator edits, native rebuild, merge or deploy
were used for this follow-up. The RCA outcome remains open.
