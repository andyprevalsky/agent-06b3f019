# Teams and explicit data sharing

## Acceptance

Add Teams beside Biz health. Users create/name teams and invite saved contacts by email, with current on-Rose and membership state. Invitations require acceptance. Every integration account and project is private until its owner explicitly shares it with a team. Email and iMessage are shareable; iPhone, credentials and device control are excluded. The same controls appear on Teams, Integrations and Project Settings.

Root and explore receive a live team/shared-data inventory. Searches include authorized shared accounts, support owner/team filters, and retain owner provenance. Account filtering must occur before matching, context expansion and pagination. Pending membership, revoked grants, removed members, unrelated teams and disconnected integrations cannot confer access. Multiple shared teams must not duplicate records. Project sharing permits agent discovery, not access to project secrets.

Initial team: Rose Labs, requester Andy, invitation to tamara@roselabs.ai. Bootstrap is idempotent; no production write before deployed schema/routes are verified.

## Implementation and validation

- Backend: team/membership/account/project grant models, additive migration, authenticated routes, live access resolver, invitation delivery and tests.
- Frontend: team management and account/project share controls, status refresh, blackbox coverage and screenshot/video evidence.
- Data/agents: SQL-scoped shared access and provenance, live summaries, root/explore prompts and daily team benchmarks.
- Integration review: typecheck/lint/structural gates, focused blackbox suites, exact daily benchmark outcomes; repair failures without weakening assertions.
- Keep prompt hunks reviewable for user review at deployment. This feature request does not itself authorize a production deployment.

## Scale and privacy

Resolve grants from indexed membership/account rows per query; no per-agent polling, shared per-user realtime fan-in, or broad user-data authorization. Fail closed for unknown source/account identities and unsupported providers. Never return integration credentials or project environment data in sharing metadata.

## Implementation details

Email invitations use a hashed, one-use mailbox token carried in the URL fragment. Accepting with a matching profile email but no token is denied. The frontend removes the proof from the URL and holds it only in tab memory. Delivery state is separate from membership; uncertain sends are not retried automatically.

The initial provider allowlist is Gmail and the single default iMessage account. Gmail grants identify the selected credential's normalized inbox, including legacy connectors with multiple inboxes. Unattributed old email records are not shared. Other providers need reliable per-record provenance before their data can be shared.

Shared message authorization is repeated in SQL for match counts, page results and neighbor context, including current membership, grant, integration and credential state. Root context fetches the map afresh even when other user context is cached. Shared projects expose a bounded list of agent IDs, titles and statuses; existing owner-only project and agent mutation routes remain unchanged.

Daily benchmarks: `team-daily-investor-email-count` and `team-daily-access-boundaries`. Fixtures cover two direct overlapping teams, a transitive outsider, a pending invite, a private sibling inbox, disconnected credentials, unattributed records and project discovery. They require tool-grounded counts and forbid external communication.

### Actual-account validation correction

The seeded requester uses phone authentication and has no User.email. Team creation and sending invitations must therefore accept nonanonymous phone-based users. Accepted members may have no profile email; invitations still target an exact mailbox and require its token. Never fabricate an owner email or force the requester to link an inbox merely to create a team.

Shared-project agent discovery also has a dedicated metadata-only grep source, `shared_project_agents`, with project filtering and ordinary paging. The overview remains bounded; agents can search beyond it without receiving private goals or trajectories.

## Release handoff

After the schema and application are deployed and verified, run the idempotent `back-end/scripts/bootstrap-team.ts` against the explicitly selected production database for owner `1f85ff25-6e29-4c1b-8739-f917bd101a30` (verified local seeded name: Andy Prevalsky), team `Rose Labs`, invite `tamara@roselabs.ai`. Run its dry-run first, verify the owner against that target, then apply and confirm the actual delivery status. Do not send an invitation from a local database: its token would not be valid on production. This step has not run during implementation or UI capture.
