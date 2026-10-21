JEV progress optimization
=========================

This offline experiment changes no production prompts or sidebar behavior.
It evaluates JEV 1.13.0 through TypeSafe and uses GPT-6.1-Sol on OpenRouter
for reflective prompt proposals. It is GEPA-style, not the GEPA package.

Prerequisites:
- The repository agents/venv, including tiktoken.
- TYPESAFE_API_KEY and OPENROUTER_API_KEY in environment or agents/.env /
  back-end/.env. Keys are never written to results.
- A dataset folder containing train.jsonl.gz, test.jsonl.gz and
  traces.jsonl.gz in the format exported by this experiment. The current
  dataset is .context/progress-jev-xp/training-10k; preserve its manifest.

Run from the repository root:
  python3 scripts/tests/jev-progress-core.test.py
  agents/venv/bin/python scripts/jev_progress/cli.py prepare --dataset .context/progress-jev-xp/training-10k --output .context/progress-jev-xp/optimization
  agents/venv/bin/python scripts/jev_progress/cli.py evaluate --dataset .context/progress-jev-xp/training-10k --output .context/progress-jev-xp/optimization --cohort train
  agents/venv/bin/python scripts/jev_progress/cli.py evaluate --dataset .context/progress-jev-xp/training-10k --output .context/progress-jev-xp/optimization --cohort validation
  agents/venv/bin/python scripts/jev_progress/optimize.py --dataset .context/progress-jev-xp/training-10k --output .context/progress-jev-xp/optimization --iterations 8

The core loop must pass before running optimization. Offline tests are also
registered in scripts/run-deploy-structural-gates.py as jev-progress-core.
The CLI errors command prints the actual worst measured development examples:
  agents/venv/bin/python scripts/jev_progress/cli.py errors --dataset .context/progress-jev-xp/training-10k --output .context/progress-jev-xp/optimization --result .context/progress-jev-xp/optimization/train-baseline.json

Family and identical-goal groups are kept intact when making a new validation
slice from the original training set. The prior 2000-example test is sealed
through optimization. Reflection receives only development examples. Prompt
strings and one of three whitelisted prefix formats change; anchors, model,
labels and decoder do not. Formats: structured history; JSON-line timeline
with prefix-only elapsed time and tool counts; compact first-2/latest-8 events
with the same derived fields. No model-generated summary or future data.

Run the paired format ablation before freezing the final test prompt:
  agents/venv/bin/python scripts/jev_progress/formats.py --dataset .context/progress-jev-xp/training-10k --output .context/progress-jev-xp/optimization

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
  agents/venv/bin/python scripts/jev_progress/cli.py evaluate --dataset .context/progress-jev-xp/training-10k --output .context/progress-jev-xp/optimization --cohort test --allow-test --prompt <frozen-prompt.json> --result <test-results.json>

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
All SQL runs with default_transaction_read_only and a 25-second timeout.

One-time bootstrap (fails if an existing research head is present):
  agents/venv/bin/python scripts/jev_progress/weekly.py bootstrap --dataset .context/progress-jev-xp/training-10k --prompt .context/progress-jev-xp/optimization/winner.json
Fresh devboxes need only this repository, dependencies and managed credentials:
  agents/venv/bin/python scripts/jev_progress/weekly.py run

Each run restores the champion (including input format), acquisition filters,
fixed validation IDs and groups, retained Pareto prompts, next mutation number,
joint scoring protocol, per-run budget, corpus, exclusions and watermark.
Warm-start prompts are re-evaluated on current development data before selecting
parents. Saved historical scores are never substituted for current scores.
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
The next week's new data evaluates that candidate prospectively. Empty
cohorts are reported as empty, never as perfect accuracy. Nothing auto-deploys.

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
