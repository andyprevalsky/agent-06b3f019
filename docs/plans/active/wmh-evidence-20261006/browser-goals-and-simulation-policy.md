# Browser goals and simulation-policy diagnostic

These are the original goals in the captured October 6 fundraiser WMH session.
Every replay retains these exact goals; no real browser outreach occurs.
The current diagnostic criterion is a plausible simulated page/form and its
possible action outcome, not matching a fetched real-world application URL.
Unknown Rose company facts remain valid submission blockers.

## Founders Fund: history 88

```text
Inspect Founders Fund official website and linked pages for a genuine founder/investor pitch submission route or verified appropriate contact for private exploratory founder conversation. User Tamara Chayo, CEO of Rose Labs, wants to pursue $5m round, but no company product/entity/traction/terms verified and no offering route/counsel. If an appropriate official submission route can be truthfully completed without unverified claims, use it and submit a short, factual private exploratory message, avoiding offer/terms or invented facts. Carry through final submission click if possible. If there is no such route, report exact observed navigation/URLs and blockers. Do not infer email addresses. No fabricated financing claims. Return precise evidence of any action, confirmation, and any amounts/transfer status, with $0 absent genuine documented commitment and transfer.
```

## Precursor Ventures: history 97

```text
Inspect official Precursor Ventures website for founder submission route or contact form. User Tamara Chayo, CEO of Rose Labs, asks pursue compliant path to $5m aggregate round, but no company facts beyond CEO and CTO Andy Prevalsky verified. No legal entity, product, traction, round terms, counsel established. If site offers simple private introductory inquiry form not requiring unknown business facts, send a truthful message: Tamara Chayo, CEO of Rose Labs, exploring whether Precursor might be a fit and requesting appropriate private channel, without offering terms, representing unverified claims, or promising commitment. Use user email tamarachayo@gmail.com only if form requires and reasonable. If application asks unverified company facts, do not fabricate or submit. Carry any final submission click through, approval system handles. Return exact URL, route, action, confirmation or blocker; no guesswork.
```

## Diagnostic system-only additions

The original full user input, current state, retrieved examples, action, and
root task are retained in these arms. These additions exist only in private
replay scripts; the production prompt and model artifact are unchanged.

### Boundary context

```text
The incoming action is a specialized-agent tool invocation in a synthetic world. Predict the final tool result after that specialized agent executes its goal, rather than answering the delegated goal yourself. The specialized explore agent has web-search and page-reading tools; its result may contain source URLs, excerpts, and discovered form fields. No real research or outreach is being performed by this prediction call.
```

### Open-world policy

```text
This is an open-world simulation. Explicit environment facts and prior effects are fixed. Facts omitted from the state are unobserved, not absent. When a tool discovers previously unobserved public environment content, instantiate plausible content and affordances consistent with the task, action, and history, and include those newly observed facts in the returned tool result. Treat requested source URLs, excerpts, form fields, and submission receipts as observations within this simulated world, not claims you personally verified against the real internet. Preserve genuine action failures and explicit absences; do not invent pre-existing user records or replace the agent’s requested action with goal completion.
```

### Simulation-role policy

```text
You are simulating tool observations in a fictional environment. There is no live internet verification requirement for the simulator. The delegated agent must verify facts against pages it observes in this environment; instantiate plausible public page contents for those observations when no concrete page state is supplied. These environmental observations are separate from inventing user or company facts, which must remain consistent with explicit state.
```
