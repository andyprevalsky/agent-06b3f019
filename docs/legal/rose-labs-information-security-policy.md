# Information Security Policy

| | |
| --- | --- |
| **Effective date** | 2026-05-01 |
| **Version** | 1.5 |
| **Owner** | Andy Prevalsky, Founder (security@roselabs.ai) |
| **Review cadence** | Annually, and ad hoc upon material changes to product scope, infrastructure providers, or applicable law |

## 1. Purpose

This policy defines the controls Rose Labs uses to identify, mitigate, and monitor information-security risks across our systems and consumer data, including data obtained from third-party integrations such as Plaid. It applies to all employees, contractors, and systems operated by Rose Labs.

## 2. Scope

This policy covers:

- All production systems operated by Rose Labs: backend API, agent workers, frontend, database, and observability.
- All consumer personal data and financial-account data collected, processed, or stored, including data retrieved via the Plaid API (balances, transactions, identity, income, investments, liabilities, statements).
- All administrative access to managed-infrastructure providers and processors enumerated in Section 12.

## 3. Roles and Responsibilities

- **Founder (Andy Prevalsky).** Owner of this policy. Responsible for production access, vendor selection, security reviews, incident response, and policy review.
- **Engineering contributors.** Required to follow the change-management and access-control practices in this document.
- **Third-party processors.** Required to maintain published security certifications (SOC 2 or equivalent) and to honor deletion requests within their SLAs.

## 4. Risk Management

Rose Labs identifies and tracks security risks through the following ongoing activities:

- Continuous review of dependency CVE alerts from GitHub Dependabot (see §8).
- Continuous review of provider security advisories from Supabase, Render, Fly.io, and Vercel.
- Annual review of this policy and supporting controls.
- Ad hoc review whenever a new third-party processor is introduced or a new data category is collected.

Material risks are remediated on a defined SLA (Section 8) and tracked through GitHub issues with the `security` label.

## 5. Identity and Access Management

- **Centralized identity.** Administrative access to production systems and managed providers is gated by Google Workspace SSO where the provider supports SSO, and by per-provider MFA-enforced accounts where it does not. The founder verifies MFA enforcement individually on each managed-provider console.
- **MFA enforcement.** Non-phishing-resistant MFA (Google Prompt or TOTP) is enforced on Google Workspace and propagates to all SSO-integrated providers. Hardware-key and passkey adoption is on the roadmap.
- **Principle of least privilege.** Access to production assets is restricted to the founder. New contributors receive only the access required for their scope of work.
- **Row-level isolation.** Application-layer access is enforced by Supabase Row-Level Security (RLS), enabled on all consumer-data tables, with per-table SELECT policies restricting reads to the owning user. Writes to consumer-data tables are performed exclusively by the backend using the Supabase service-role key after the backend's own authentication middleware verifies the caller's identity; the frontend's anon key cannot write directly to consumer-data tables.
- **Non-human authentication.** Service-to-service authentication between the backend and the agent workers uses a shared backend API key transmitted over TLS. The key is stored in provider-managed secret stores (Render, Fly secrets) and is rotated upon contributor departure or suspected exposure. Scheduled-cadence rotation is on the roadmap. Outbound calls to third-party services use provider-issued OAuth tokens or scoped API keys. Sensitive secrets are encrypted at rest as described in Section 7 and are never written to logs in plaintext.
- **Onboarding and offboarding.** Production credentials are provisioned individually (no shared admin accounts) and revoked immediately upon contributor departure.

## 6. Consumer Authentication

Consumers authenticate to Rose Labs via SMS one-time-passcode (OTP) through Twilio Verify. Consumers must successfully complete the OTP challenge before any sensitive flow, including Plaid Link, is reachable. Phone numbers are bound to a single Rose Labs account.

## 7. Data Protection

**Encryption in transit.** TLS 1.2 minimum (TLS 1.3 negotiated where supported by the client) is enforced by our managed hosting providers: Vercel, Render, Supabase, and Fly.io. Connections below TLS 1.2 are rejected. HTTPS is required for all public endpoints; HSTS is enabled by default by our edge providers.

**Encryption at rest.** All consumer data, including data retrieved from the Plaid API, is encrypted at rest. The database (Supabase Postgres) and disk-backed services (Render, Fly.io volumes) provide AES-256 encryption at rest by default.

**Application-layer encryption of credentials that grant access to consumer financial data.** Claude Code OAuth credentials and uploaded browser-password credentials are encrypted at the application layer using AES-256-GCM with envelope encryption (RSA-OAEP-SHA256 wrap of the data key) prior to storage in our database, and are decrypted only inside agent workers at the moment of use. Implementation lives in `back-end/src/providers/claudeCredentials.ts` and `back-end/src/domains/integrations/uploadService.passwords.ts`. The same envelope scheme will be applied to Plaid access tokens before any Plaid integration ships to production; the cryptographic scaffolding is already in active use for the credential types listed above. Other long-lived OAuth tokens (for example, Gmail) and non-credential browser-session data (cookies, localStorage) currently rely on the underlying database's at-rest encryption; extending app-layer encryption to those is on the roadmap.

**Network separation.** Production and non-production workloads are logically separated by provider account, project, and network namespace. Non-production environments never receive real consumer data.

**Secret management.** All secrets are stored in provider-managed secret stores (Render env vars, Fly secrets, Vercel env vars, GitHub Actions secrets). Secrets are never committed to source control; `.env` and `.env.*` files are gitignored at the repository root and in each service subdirectory. GitHub secret scanning provides a safety net for public repositories; extending it to private repositories via the GitHub Secret Protection add-on is on the roadmap (see §8).

## 8. Vulnerability Management

**Dependency scanning.** GitHub Dependabot security updates are enabled at the repository level and open pull requests for known CVEs in our software supply chain. A `.github/dependabot.yml` configures version-update PRs across npm, pip, and GitHub Actions ecosystems on a weekly cadence.

**Secret scanning.** GitHub secret scanning and push protection are configured at the organization level and are active on public repositories (GitHub free tier). The primary Rose Labs source repository is private; full secret scanning and push protection on private repositories require the GitHub Secret Protection add-on (or GitHub Advanced Security), which is on the near-term roadmap. In the interim, `.env` and `.env.*` files are gitignored, secrets are stored exclusively in provider-managed secret stores (Render, Fly, Vercel, GitHub Actions), and developers review their own diffs for accidental credential exposure before pushing.

**Patch SLA.**

| Severity | Patch window |
| --- | --- |
| Critical and high | Within 7 days |
| Medium | Within 30 days |
| Low | Next regular release cadence |

**End-of-life software.** Node.js, Python, and base container images are tracked against their published support windows and upgraded to current LTS versions on a quarterly cadence. Provider-managed services (Supabase, Render, Fly.io) handle underlying OS and runtime patching.

**Endpoint scanning.** Employee and contractor laptop MDM and endpoint scanning are on the roadmap and not currently in place.

## 9. Change Management

- All production changes flow through GitHub pull requests against the `main` branch.
- Automated checks (lint, type-check, unit tests, integration tests, coverage thresholds) must pass before merge.
- AI-assisted code review (CodeRabbit) flags issues on every PR.
- Production deployments to backend, agents, and frontend are automatic on merge to `main`.
- Database schema changes go through Prisma migrations and are reviewed prior to merge.

## 10. Logging and Monitoring

- HTTP request logs (method, path, status, duration) are emitted by the backend and retained.
- Agent execution logs are streamed from Fly.io to ClickHouse and retained for 7 days.
- Errors are logged with stack traces and correlation IDs (agent ID, user ID, request ID) and surfaced for triage.
- Outbound HTTP captures used by our blackbox-test harness redact `Authorization`, `apikey`, `x-api-key`, and similar credential headers before persisting capture entries (`agents/helpers/httpx_capture.py`, `back-end/src/providers/fetchCapture.ts`). A production-grade logging-redaction wrapper covering outbound HTTP credentials and inbound consumer financial-account payloads (Plaid-sourced balances, transactions, identity) is on the roadmap and will be in place before the Plaid integration ships. Until then, developers omit raw credentials and financial payloads from `log.info` and `log.error` extra-context objects at the call site, and `.env*` files plus provider-managed secret stores prevent secrets from being checked in or echoed by services at boot.

## 11. Incident Response

- The founder is the primary incident responder and on-call contact (security@roselabs.ai).
- On suspected compromise of consumer data, the response sequence is: (1) contain by revoking affected credentials and rotating secrets; (2) assess scope and root cause; (3) notify affected users and applicable regulators within statutorily required windows (CCPA: 45 days; GDPR: 72 hours where applicable); (4) remediate root cause and document in the post-incident review.
- Plaid is notified of any incident materially affecting Plaid-sourced consumer data within the timelines required by the Plaid Customer Agreement.

## 12. Vendor and Processor Management

Rose Labs uses the following third-party processors for consumer data. Processors that handle consumer financial data are not added without published SOC 2 (or equivalent) attestation. New processors are reviewed by the founder against the expected attestations below before being added.

### 12.1 Infrastructure

| Processor | Purpose | Attestation |
| --- | --- | --- |
| Supabase | Postgres database, auth, realtime, storage | SOC 2 Type II |
| Render | Backend API hosting | SOC 2 Type II |
| Fly.io | Agent worker hosting | SOC 2 Type II |
| Vercel | Frontend hosting, edge | SOC 2 Type II |

### 12.2 Communications and Identity

| Processor | Purpose | Attestation |
| --- | --- | --- |
| Twilio | SMS OTP via Twilio Verify | SOC 2, ISO 27001 |

### 12.3 Financial Data

| Processor | Purpose | Attestation |
| --- | --- | --- |
| Plaid | Financial account aggregation | SOC 2 Type II |

### 12.4 LLM Inference and AI Processing

User messages and the conversational context required to answer them, which after the Plaid integration ships may include data sourced from connected financial accounts, are sent to LLM providers as part of normal agent operation. Each enumerated LLM provider operates under its published no-training-on-API-traffic policy by default. Rose Labs does not currently set additional provider-specific zero-retention flags at the request layer; enabling provider zero-retention modes (Anthropic ZDR, OpenAI `store=false`, and equivalent) is on the roadmap and will be evaluated before the Plaid integration ships. Users are informed of LLM processing of their data through the Rose Labs Privacy Policy at `https://roselabs.ai/privacy` and accept it as a condition of account creation. An in-product, per-action consent surface for high-sensitivity flows is on the roadmap.

| Processor | Purpose | Attestation |
| --- | --- | --- |
| Anthropic | Claude family (direct API and OAuth-mediated Claude Code) | SOC 2 Type II; no training on API traffic by default |
| OpenAI | Text embeddings via `text-embedding-3-small`; ChatGPT and Codex via OAuth-mediated endpoints | SOC 2 Type II; no training on API traffic by default |
| Google | Gemini family via Google AI / `google-genai` SDK | SOC 2 Type II; no training on API traffic by default |
| Perplexity | Sonar / deep-research API | SOC 2 Type II; no training on API traffic by default |
| OpenRouter | Model-routing aggregator; routes to additional sub-providers including Anthropic, OpenAI, Google, xAI (Grok), Moonshot AI, and Z.ai (GLM) | Sub-providers are subject to their own attestations |

### 12.5 Search and Enrichment

| Processor | Purpose | Attestation |
| --- | --- | --- |
| Exa | People and web search / enrichment, used by the `message_person` flow | SOC 2 Type II; no training on API traffic |
| Perplexity | Search and research surface in the deep-research tool (also listed under LLM Inference) | SOC 2 Type II |

### 12.6 Browser Automation and Sandboxed Execution

| Processor | Purpose | Attestation |
| --- | --- | --- |
| Browserbase | Managed headless-browser sessions used by the browser-use sub-agent; users authenticate to third-party sites through these sessions | SOC 2 Type II |
| E2B | Sandboxed execution environment for Claude Code; receives decrypted Claude Code OAuth credentials at the moment of use, never written to disk in plaintext outside the sandbox | SOC 2 Type II |

### 12.7 Payments

| Processor | Purpose | Attestation |
| --- | --- | --- |
| Stripe | Subscription billing and payment processing for Rose Labs services | PCI DSS Level 1, SOC 1 Type II, SOC 2 Type II |

### 12.8 Provisioned but Not Active

Disclosed for completeness; activation against consumer financial data requires founder review.

| Processor | Status |
| --- | --- |
| Parallel AI (Find All / Enrich / Monitor APIs) | Credentials provisioned; no current production code path against consumer financial data |
| Supermemory (long-term memory store) | Credentials provisioned; no current production code path against consumer financial data |
| Cursor | Helper code present; blackbox-test usage only today; no production code path |
| Vercel API | Deployment automation only; does not receive consumer data |

### 12.9 Observability

| Processor | Purpose | Attestation |
| --- | --- | --- |
| ClickHouse Cloud | Retained agent log storage; retention 7 days | SOC 2 Type II |

### 12.10 Source Control and Supply Chain

| Processor | Purpose | Attestation |
| --- | --- | --- |
| GitHub | Source control, Dependabot, secret scanning, Actions | SOC 2 Type II |

## 13. Data Retention and Deletion

Data retention, deletion, and disposal practices are defined in the separate **Rose Labs Data Retention and Disposal Policy**, which is incorporated by reference into this policy.

## 14. Employee Security Awareness

All contributors are required to:

- Use Google Workspace SSO with MFA for all production access where the provider supports SSO; otherwise use per-provider MFA-enforced accounts.
- Use unique, password-manager-generated credentials for all accounts.
- Encrypt laptop disks (FileVault on macOS).
- Report suspected security incidents to security@roselabs.ai immediately.

Formal security-awareness training is on the roadmap and will be rolled out as the team grows beyond the founder.

## 15. Policy Review and Updates

This policy is reviewed at least annually by the founder, and ad hoc upon material changes to product scope, infrastructure providers, or applicable law. Version history is maintained in this document and in the source repository (`docs/legal/information-security-policy.md`). Material changes are communicated to consumers through the Rose Labs Privacy Policy at `https://roselabs.ai/privacy`.

## 16. Contact

Questions regarding this policy, security concerns, and vulnerability reports should be directed to:

> **security@roselabs.ai**
> Rose Labs / Andy Prevalsky, Founder

