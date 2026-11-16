# PR #2328 production verification closeout

Release merge: `765eb3abe570a6b305d978ce588039c04c9ece18`; reviewed source: `2ec5e1c5a000df63566cec01fbbf74a13192e820`.

The original production verifier could not parse the real multiline cutover-monitor report. After parser repair #2407 merged as `f14f0cc030f288d2212c8d76acdd63043a3ed679`, this continuation acquired only its required `run_deploy_pipeline.py` blob (`762d237c5465c3665a250257042493f93bd1ad5d`) and ran the original native production command against the original release and state directory. No runtime change, new worker cutover or benchmark campaign was made here.

| Native check | Actual result |
| --- | --- |
| Original source validation | 17/17 selected gates PASS on the original reviewed source, including 8/8 smoke tasks and cleanup. No new-source credit claimed. |
| Fly qualification | PASS through live successor `c6d0be4b47474127dc35536c9384096abcc1de9c04cf4682323e395bdac2c321`, source `457cc757d706bad1360fe89876a1b4a79b820d3a`; native monitor exit 0, cooperative drain complete. |
| Workflow migration | 45/45 rows PASS; fixture cleanup PASS; validator exit 0. |
| Production semantics | [Run 43934871586](https://github.com/Rose-Ai-Labs/rose/actions/runs/43934871586) SUCCESS, all five jobs successful. PASS-verified-by-descendant frontend `2f71d8a69a8e613fe4d1ee0f6caf70c50664ad27`. Frontend flows: 70 PASS, 6 SKIPPED; latency ratchets: 8 PASS across four jobs. |
| Native completion | Production command exit 0, 2026-11-16T19:00:44Z–19:12:13Z. Normal deploy finish PASS at 19:13:44Z, preserving the original start at 05:11:20Z. |

Production URLs: https://www.roselabs.ai and https://navi-j9a9.onrender.com.

## Historical failures and limits

- [Original Fly Actions run 43827845653](https://github.com/Rose-Ai-Labs/rose/actions/runs/43827845653) remains FAILURE. Its durable job `d345a37ca8c8cab2a28658958b3cbfd889719d305cf578b4e7d3ffa12b2caf21` was SUCCEEDED but overtaken. The original 09:03 production attempt remains FAIL, with migration and semantics BLOCKED. Current qualification is through the verified live successor; it does not relabel the old workflow.
- First-source structural UNVERIFIED and `iphone-control` FLAKY outcomes remain preserved. The old FLAKY packet has no recorded attribution; that historical coverage gap is not converted into PASS. Final full source gates passed on the later reviewed source.
- One successor preflight sequencing mistake at 18:59 allowed the old verifier to run after a guard rejected an idle resident harness. That FAIL is preserved privately. Fail-closed sequencing and exact merged-blob verification preceded the successful attempt. No cutover or campaign was created by that failed invocation.
- Original CodeRabbit review was skipped at the recorded organization usage cap: the original release **merged unreviewed**. Records-only review disposition is recorded independently in the follow-up PR.
- Six semantic cases retain their native production skips: magic-OTP login requires dev credentials, browser takeover requires a local DB seed, and four overlay probes require a local fixture page. No assertion or timeout was changed.
- Real phone wall-time and before/after phone-loop latency measurements remain unverified and outside this continuation. No phone actions, texts, device acceptance or setup-policy changes were performed. Freedom and the protected stopped Machines were preserved; old Google400 was not restarted.

## Preservation and readiness

The verified base archive contains 51,767 regular files. The final delta contains 83 file versions, including the completed native receipts, original and successor failures, raw workflow logs, semantic artifacts and recovery evidence. Both encrypted archives passed full authenticated readback; all 83 final versions matched a post-upload rehash. Native finish removed only its two active-run pointers; their original bytes are retained in the base archive and completed timing is retained in the delta.

See the two archive receipts, preservation post-scan, and closeout manifest. Raw logs, harness transcripts, secrets and artifact bodies are private; these committed records contain sanitized results and recovery references. Final deletion readiness is the separate native `deletion-readiness.json` receipt. No deletion is authorized by this record, and a resident idle Claude harness must remain untouched.

Current recovery execution: GPT-6.1-Sol, high effort, Codex 0.166.0. Service tier and historical token/cost accounting are unmeasured. This is a records-only delivery; it creates no additional production-service rollout.
