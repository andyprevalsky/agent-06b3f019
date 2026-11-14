JEV progress optimization
=========================

This offline experiment changes no production prompts or sidebar behavior.
It evaluates JEV 1.13.0 through TypeSafe and uses GPT-6.1-Sol on OpenRouter
for reflective prompt proposals. It is GEPA-style, not the GEPA package.
The owner goal is to optimize progress AND ETA in one loop, including how the
incoming prefix is formatted, refreshed weekly from production.

Runtime integration shipped separately (9347c525af per-turn asynchronous
estimates through the existing realtime channels and sidebar ring; c3ffc0092d
DEMO replays skip the live estimate). It reads the pinned prompt in
agents/config/jev_progress_prompt.json (candidate-165). This research loop never
edits that file or deploys a prompt; promoting a new champion is a reviewed
source change.

Hard rules:
- Never commit production traces, datasets, raw responses or receipts: they
  contain users' private messages. Keep them encrypted in R2 or under the
  ignored .context/ directory. Never commit or print credentials.
- Never rerun bootstrap, reset the watermark, regenerate validation membership
  or restart from the generic seed to improve scores.
- Never relabel unknown outcomes as successes, and never remove a trace only
  because it ran a long time.
- Every progress report includes the updated graph: one value per iteration
  for average progress error and ETA error.

Prerequisites:
- The repository agents/venv, including tiktoken.
- TYPESAFE_API_KEY and OPENROUTER_API_KEY in environment or agents/.env /
  back-end/.env. Keys are never written to results.
- A dataset folder containing train.jsonl.gz, test.jsonl.gz and
  traces.jsonl.gz in the format exported by this experiment. The current
  dataset is .context/progress-jev-xp/training-success-v2; preserve its manifest.
  Only final, positively verified successful tasks are eligible. The former
  training-10k dataset is quarantined historical evidence, not training input.

Run from the repository root:
  python3 scripts/tests/jev-progress-core.test.py
  agents/venv/bin/python scripts/jev_progress/cli.py prepare --dataset .context/progress-jev-xp/training-success-v2 --output .context/progress-jev-xp/optimization-success-v2
  agents/venv/bin/python scripts/jev_progress/cli.py evaluate --dataset .context/progress-jev-xp/training-success-v2 --output .context/progress-jev-xp/optimization-success-v2 --cohort train
  agents/venv/bin/python scripts/jev_progress/cli.py evaluate --dataset .context/progress-jev-xp/training-success-v2 --output .context/progress-jev-xp/optimization-success-v2 --cohort validation
  agents/venv/bin/python scripts/jev_progress/optimize.py --dataset .context/progress-jev-xp/training-success-v2 --output .context/progress-jev-xp/optimization-success-v2 --iterations 8

The core loop must pass before running optimization. Offline tests are also
registered in scripts/run-deploy-structural-gates.py as jev-progress-core.
The CLI errors command prints the actual worst measured development examples:
  agents/venv/bin/python scripts/jev_progress/cli.py errors --dataset .context/progress-jev-xp/training-success-v2 --output .context/progress-jev-xp/optimization-success-v2 --result .context/progress-jev-xp/optimization/train-baseline.json

Family and identical-goal groups are kept intact when making a new validation
slice from the original training set. The prior 2000-example test is sealed
through optimization. Reflection receives only development examples. Prompt
strings and one of three whitelisted prefix formats change; anchors, model,
labels and decoder do not. Formats: structured history; JSON-line timeline
with prefix-only elapsed time and tool counts; compact first-2/latest-8 events
with the same derived fields. No model-generated summary or future data.

Run the paired format ablation before freezing the final test prompt:
  agents/venv/bin/python scripts/jev_progress/formats.py --dataset .context/progress-jev-xp/training-success-v2 --output .context/progress-jev-xp/optimization-success-v2

Selection minimizes the equal-weight mean of baseline-normalized trace-macro
progress MAE and baseline-normalized mean absolute log1p-seconds ETA error.
The original progress-primary phase is retained separately; the joint phase
re-ranks its existing candidates without additional paid evaluations. The Pareto pool
retains complementary progress/ETA candidates and permits component merging.
Four consecutive non-improvements stop the bounded search. Every proposal,
training score and paired validation score is retained. Candidate failures
are explicit and prohibit promotion; they do not shrink the denominator.

Requests cache by complete request plus decoder version. Rerunning a command
reuses identical successful responses; it does not repeat paid calls. Failed
requests can be retried by rerunning. A changed prompt invalidates its cache.
Transport retries only transient HTTP failures, at most three attempts.

winner.json contains the selected prompt and its validation score.
Freeze it before the optional final test evaluation:
  agents/venv/bin/python scripts/jev_progress/cli.py evaluate --dataset .context/progress-jev-xp/training-success-v2 --output .context/progress-jev-xp/optimization-success-v2 --cohort test --allow-test --prompt <frozen-prompt.json> --result <test-results.json>

Progress labels measure fraction of actual future-issued batches, not semantic
goal completion. ETA uses the final verifier FINISHED time; browser/explore
ETA references are missing. Unknown future human waits cannot be inferred
reliably from a prefix. Report prefix and trace-macro metrics together.

Full-bucket plots (gray actual, blue optimized JEV) are reproducible with:
  agents/venv/bin/python scripts/jev_progress/bucket_plot.py --winner <test-results.json> --view eta --output <eta.png>
  agents/venv/bin/python scripts/jev_progress/bucket_plot.py --winner <test-results.json> --view batches --output <batches.png>
All configured buckets, including empty buckets, are displayed. Actual values
map to the nearest available anchor. The batch estimate is the expected count,
then mapped to its nearest anchor; this is not the raw probability distribution.
These histograms count saved prefixes; short traces and repeated tool-result
events create discrete progress spikes. They do not measure wall-clock occupancy.

Isolated prior-prediction ablation (does not change the champion):
  agents/venv/bin/python scripts/jev_progress/previous_prediction.py --experiment <previous-optimization-folder> --dataset <dataset-folder> --output <ablation-folder>
It adds only one strictly earlier baseline prediction to each prefix, preserving
the frozen prompt and validation IDs. First prefixes have no prior. This tests
one-step conditioning, not recursive production rollout behavior.

Parallel adaptive search (35 independent proposals, then select; five rounds):
  agents/venv/bin/python scripts/jev_progress/batch.py --dataset <dataset-folder> --cohorts <cohorts.json> --output <batch-folder> --width 35 --rounds 5
This restores the durable champion and Pareto alternatives, freezes the incoming
normalization and cohort for the run, and advances selection only after each
whole round passes. Each round includes history, timeline and compact formats.
API concurrency is bounded and backs off on 429s; perfect throughput scaling
is not assumed. Raw responses and per-candidate results are encrypted in R2,
so parallel evaluation does not fill the disk with caches. Round manifests and
the next candidate number survive in the durable checkpoint.

Weekly fresh-data workflow
-------------------------
Also requires boto3, cryptography, python-dotenv and psql. R2_ACCOUNT_ID,
R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_TRACE_ARCHIVE and
TRACE_ARCHIVE_ENCRYPTION_KEY_B64 use the existing private trace bucket.
Production DB comes from explicit JEV_PROD_DATABASE_URL or back-end/.env's
DATABASE_URL, not the commonly injected local development DATABASE_URL.
All SQL runs with default_transaction_read_only and a 25-second statement
timeout set through startup PGOPTIONS, and production.py also wraps every query
in explicit BEGIN READ ONLY / ROLLBACK: transaction-pooling proxies may ignore
startup PGOPTIONS. Behind such a proxy the read-only transaction still holds,
but only the 90-second psql subprocess timeout bounds a query.

One-time bootstrap (fails if an existing research head is present):
  agents/venv/bin/python scripts/jev_progress/weekly.py bootstrap --dataset .context/progress-jev-xp/training-success-v2 --prompt .context/progress-jev-xp/optimization/winner.json
Fresh devboxes need only this repository, dependencies and managed credentials:
  agents/venv/bin/python scripts/jev_progress/weekly.py run

Each run restores the champion (including input format), acquisition filters,
fixed validation IDs and groups, retained Pareto prompts, next mutation number,
joint scoring protocol, per-run budget, corpus, exclusions and watermark.
Warm-start prompts are re-evaluated on current development data before selecting
parents. Saved historical scores are provenance only and are never substituted
for current scores.
The optimizer writes optimizer-state.json after each completed mutation.
--iterations N explicitly changes and persists the per-run budget; omit it to
retain the last setting. Protocol mismatches fail closed, never reset to defaults.
To continue learning without waiting for new data and inspect late improvement:
  agents/venv/bin/python scripts/jev_progress/weekly.py run --train-existing --iterations 10 --patience 10
This runs ten mutations even across an early plateau, using the same validation
set and incoming-champion normalization. --patience persists the stopping rule.
Generate the per-candidate curve and a descriptive plateau/late-drop check with:
  agents/venv/bin/python scripts/jev_progress/learning_curve.py --experiment <optimization-folder>
The late-drop rule is a >=5% joint-error decrease after four candidates without
a new best; it is descriptive, not proof of statistical double descent.
JEV_CACHE_DIR optionally shares the content-addressed response cache across
runs. It never changes inputs, labels, or which examples enter the experiment.
Existing v1 checkpoints require the one-time explicit migrate command with the
encrypted initial experiment artifact. The current checkpoint is migrated.

Encrypted durable state: s3://<R2_BUCKET_TRACE_ARCHIVE>/jev-research/v1/.
Each run freezes and records the incoming champion before its read-only pull.
New root families with unseen normalized goals enter a fixed random 80/20
training/sealed split. Every prefix of the sealed 20% is evaluated once with
the frozen incoming champion. Identical goals and all descendants stay in one
split; repeats are excluded, sealed rows never enter optimization. Receipts
are create-only; the state pointer advances conditionally to reject races.
Only afterwards does the training split drive joint prompt/format mutation.
The next week's new data evaluates that candidate prospectively. Sealed
prefixes never reach reflection, validation or candidate selection. Report
sample sizes, coverage and failures explicitly; empty cohorts are reported as
empty, never as perfect accuracy. Nothing auto-deploys.

Current fresh pull handles persistent root and child agents with verified
terminal completion. It rejects missing/archived tool histories, and does NOT
claim fresh browser/explore coverage. Those require further archive recovery;
the historical dataset does contain both, with no reliable ETA labels.
This is a protocol against test-driven selection, not a security boundary
against an operator deliberately editing code or accessing sealed artifacts.

Isolated general-model comparison through OpenRouter (OPENROUTER_API_KEY):
  agents/venv/bin/python scripts/jev_progress/general_model.py --experiment <optimization-folder> --dataset <dataset-folder> --output <comparison-folder>
Defaults to pinned deepseek/deepseek-v4.1-flash-1017 with reasoning disabled.
Uses the frozen JEV validation IDs, input formatter, questions and decoding.
The JSON adapter preserves the returned model and rejects a model mismatch.
--limit is a transport pilot only; use all cases for the paired comparison.
Results include actual provider-reported cost, latency and separate/joint
metrics; this does not mutate the incumbent or touch the held-out test.

Explicitly requested report-only test curve for completed parallel rounds:
  agents/venv/bin/python scripts/jev_progress/test_curve.py --batch <batch-folder> --dataset <dataset-folder> --cohorts <cohorts.json> --output <test-report-folder>
Selects each round's best new candidate using validation before evaluating
the frozen 2,000-case test. Never reads test scores into the optimizer; stores
raw responses and scored results encrypted, and resumes completed reports.
Re-run after the final round if it was not complete at the initial launch.

Success-only cleanup (October 21, 2026)
------------------------------------
Active corpus: 7,002 training / 1,572 test prefixes, 1,509 successful traces.
Retained development validation: 164 prefixes. Original assignments were
preserved; no replacements or duration cutoffs. Removed 106 traces (11
deployment interruptions, 58 mismatched final receipts, 37 browser/explore
without positive task-success evidence). Old graphs and scores used a tainted
corpus and are historical only. No browser/explore currently qualifies.

Persistent success requires final own completion-call linkage, final verifier
100% with verifierMessage, completed lifecycle, no deployment interruption,
no superseding feedback and no plan-only completion. A browser teardown or
explore loop stopping is not task success. Explicit success evidence remains
outside every model prefix. Acquisition, dataset verification and saved-state
validation enforce this policy. Cleaned checkpoint preserves watermark, prompt
history, candidate numbering and group ownership. Old candidate scores are
marked pre_cleanup_validation_metrics and must be rescored before selection.

Reproduce the explicit dataset/checkpoint migration:
  agents/venv/bin/python scripts/jev_progress/clean.py --source <old-dataset> --evidence <production-success-evidence.jsonl.gz> --output <new-dataset>
  agents/venv/bin/python scripts/jev_progress/clean_checkpoint.py --dataset <new-dataset> --batch <finished-batch> --output <migration-receipt.json>
  agents/venv/bin/python scripts/jev_progress/clean_scores.py --dataset <new-dataset> --batch <finished-batch> --old-test <old-test-report> --output <clean-report>
These are versioned one-time operations. Do not rerun checkpoint migration or
reset a dataset to work around the success gate. The normal continuation
remains weekly.py run, restoring the cleaned durable checkpoint.

Recorded results (historical; reproduce from receipts, do not reuse as fresh scores)
----------------------------------------------------------------------------------
Pre-cleanup historical corpus (now quarantined): 8,000 training / 2,000 test
prefixes from 1,615 completed traces; development used 256 training and 500
validation prefixes grouped by root family AND normalized goal. Progress is the
fraction of actually issued tool batches; ETA is time to the final own
completion-tool receipt. The sample is not a random production census and
repeated prefixes are correlated. Distribution audit: 125/179 held-out traces
have two tool batches; of 499 prefixes in the 50-60% bin, 449 are exactly 50%
(369 from two-batch traces, 186 from one root family). These are
event-weighted counts, not time occupancy or semantic completion.

Model and objective: remaining-batch anchors 0,1,2,3,5,8,13,21,34,55+ give
progress = observed/(observed+expected remaining). ETA options are every minute
1-59, hour 1-23, day 1-29, month 1-11 (30-day) and 1 year, so the one-minute
minimum cannot represent zero-time cases exactly. The reflector runs at low
reasoning effort. Labels, bins and decoding stay frozen.

Format ablation chose the JSON-lines timeline with prefix-derived elapsed time
and observed tool counts; compact first-2/latest-8 saved tokens but hurt
accuracy. Final paired 2,000-case test (1,744 ETA labels, tainted corpus):
progress MAE 18.56->14.45pp; within +/-10pp 38.0%->52.25%; empirical 65% band
+/-22.12->+/-17.57pp; 95% band +/-46.54->+/-48.52pp (coverage bands, not
sigma). ETA log error 2.0435->2.0741 (worse), median relative error
98.89%->98.40%, mean absolute error 18.18h->43.25h: no ETA improvement is
claimed. Long waits are badly underestimated and some 15-104 minute jobs were
called one year. Never use that test to select further mutations.

35x5 parallel batch: all 175 candidates finished in 41.74 minutes; its original
winner was candidate-165 (joint ratio 0.990991) on the tainted corpus. After
the success-only cleanup the existing prompt is carried forward, not declared
the clean-data winner. The user authorized report-only per-iteration test
evaluations: all five frozen, validation-selected candidates have clean-cohort
results in .context/progress-jev-xp/batch-35x5-clean-report/summary.json on
the same 1,572 test / 164 validation prefixes; test results never enter
mutation or selection.

Previous-prediction ablation (500 validation prefixes, a prior estimate in
457): one-step conditioning moved progress MAE 14.99->15.25pp and ETA log error
1.726->1.683 (joint 0.06% worse); recursive sampled-prefix feedback gave
15.31pp / 1.688 (0.17% worse). Keep it off by default.

DeepSeek comparison (2026-10-21, pinned deepseek/deepseek-v4.1-flash-1017,
reasoning off, same frozen instructions and 500 validation prefixes, 171 ETA
labels): progress MAE JEV 14.99pp vs 18.46pp; within 10pp 44.4% vs 38.6%; ETA
log error 1.726 vs 1.673; combined normalized error 1.0522 (DeepSeek 5.22%
worse); mean absolute ETA error 51.47h vs 13.07m (one JEV 1-year outlier).
OpenRouter reported $0.52584 for all 500 cases, median latency 0.995s. JEV
stays the research incumbent; this is not a held-out or DeepSeek-tuned
comparison. Encrypted receipt: jev-research/v1/objects/79300ede5bad8ebe3195cd648a1a97601557038cbc36552c59a1b2e4fd670f37.
