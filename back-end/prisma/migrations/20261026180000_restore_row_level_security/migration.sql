-- Restore row-level security that production lost after its migrations were
-- recorded applied (RCA 2026-06-27-stray-db-push-from-another-worktree-dropped-a-prod-column).
--
-- The live catalog had RLS disabled on 20 tables the baseline enables, the 19
-- baseline policies on them were gone, and 21 tables created since the
-- baseline never enabled RLS. `anon` and `authenticated` hold SELECT on every
-- public table and the Data API exposes `public`, so RLS is the only barrier.
-- No client reads these tables through PostgREST; the backend connects as a
-- BYPASSRLS role, so enabling RLS changes no application path. Tables without a
-- policy deny all Data API access.
--
-- Idempotent: safe after a manual ENABLE or policy restore has already run.
SET LOCAL lock_timeout = '15s';

-- Baseline tables whose RLS was disabled in production.
ALTER TABLE IF EXISTS "PlaidAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "PlaidItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "RoseApiKey" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "RoseApiKeyLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "RoseConversationModel" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "RoseModelLatency" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "SmsSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "SmsShortcode" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "SteelSessionAuth" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "Subscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "Tool" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "ToolUsage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "UserAuthAssistanceRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "UserDataDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "UserDataProviderSyncState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "UserSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "UserSnapshotRevision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "Verifier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "Waitlist" ENABLE ROW LEVEL SECURITY;

-- Tables created after the baseline without RLS.
ALTER TABLE IF EXISTS "AgentPhoneMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "AgentQueuePointer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "AgentTaskProgressEstimate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "AgentTrajectorySearch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "BenchmarkRunRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "BenchmarkTask" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "BrowserProviderProfile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "BrowserProviderProxy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "ComputeAccountConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "ComputeGrant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "ComputeTokenFastCacheAffinity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "ComputeTokenLineageLease" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "FastModeCacheEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "GoogleDataPurge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "PlaidTransaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "PlannerMemory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "PurchaseSpend" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "PurchaseWalletFunding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "TemporalWorkflowCleanup" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "ToolSideEffect" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "TraceArchiveFinalization" ENABLE ROW LEVEL SECURITY;

-- Baseline policies, verbatim from 00000000000000_init.
DROP POLICY IF EXISTS "Anyone can read" ON public."RoseConversationModel";
CREATE POLICY "Anyone can read" ON public."RoseConversationModel" FOR SELECT USING (true);
DROP POLICY IF EXISTS "Anyone can read" ON public."RoseModelLatency";
CREATE POLICY "Anyone can read" ON public."RoseModelLatency" FOR SELECT USING (true);
DROP POLICY IF EXISTS "Anyone can view tools" ON public."Tool";
CREATE POLICY "Anyone can view tools" ON public."Tool" FOR SELECT USING (true);
DROP POLICY IF EXISTS "PlaidAccount_select_own" ON public."PlaidAccount";
CREATE POLICY "PlaidAccount_select_own" ON public."PlaidAccount" FOR SELECT USING (("userId" = ((current_setting('request.jwt.claims'::text, true))::json ->> 'sub'::text)));
DROP POLICY IF EXISTS "PlaidItem_select_own" ON public."PlaidItem";
CREATE POLICY "PlaidItem_select_own" ON public."PlaidItem" FOR SELECT USING (("userId" = ((current_setting('request.jwt.claims'::text, true))::json ->> 'sub'::text)));
DROP POLICY IF EXISTS "UserDataDocument_select_own" ON public."UserDataDocument";
CREATE POLICY "UserDataDocument_select_own" ON public."UserDataDocument" FOR SELECT USING (("userId" = ((current_setting('request.jwt.claims'::text, true))::json ->> 'sub'::text)));
DROP POLICY IF EXISTS "UserDataProviderSyncState_select_own" ON public."UserDataProviderSyncState";
CREATE POLICY "UserDataProviderSyncState_select_own" ON public."UserDataProviderSyncState" FOR SELECT USING (("userId" = ((current_setting('request.jwt.claims'::text, true))::json ->> 'sub'::text)));
DROP POLICY IF EXISTS "UserSnapshotRevision_select_own" ON public."UserSnapshotRevision";
CREATE POLICY "UserSnapshotRevision_select_own" ON public."UserSnapshotRevision" FOR SELECT USING (("userId" = ((current_setting('request.jwt.claims'::text, true))::json ->> 'sub'::text)));
DROP POLICY IF EXISTS "UserSnapshot_select_own" ON public."UserSnapshot";
CREATE POLICY "UserSnapshot_select_own" ON public."UserSnapshot" FOR SELECT USING (("userId" = ((current_setting('request.jwt.claims'::text, true))::json ->> 'sub'::text)));
DROP POLICY IF EXISTS "Users can select own data" ON public."RoseApiKey";
CREATE POLICY "Users can select own data" ON public."RoseApiKey" FOR SELECT USING (((auth.uid())::text = "userId"));
DROP POLICY IF EXISTS "Users can select own data" ON public."RoseApiKeyLog";
CREATE POLICY "Users can select own data" ON public."RoseApiKeyLog" FOR SELECT USING (((auth.uid())::text = "userId"));
DROP POLICY IF EXISTS "Users can select own data" ON public."SmsSession";
CREATE POLICY "Users can select own data" ON public."SmsSession" FOR SELECT USING (((auth.uid())::text = "userId"));
DROP POLICY IF EXISTS "Users can select own data" ON public."SmsShortcode";
CREATE POLICY "Users can select own data" ON public."SmsShortcode" FOR SELECT USING (((auth.uid())::text = "userId"));
DROP POLICY IF EXISTS "Users can select own data" ON public."SteelSessionAuth";
CREATE POLICY "Users can select own data" ON public."SteelSessionAuth" FOR SELECT USING (((auth.uid())::text = "userId"));
DROP POLICY IF EXISTS "Users can select own data" ON public."Subscription";
CREATE POLICY "Users can select own data" ON public."Subscription" FOR SELECT USING (((auth.uid())::text = "userId"));
DROP POLICY IF EXISTS "Users can select own data" ON public."ToolUsage";
CREATE POLICY "Users can select own data" ON public."ToolUsage" FOR SELECT USING (((auth.uid())::text = "userId"));
DROP POLICY IF EXISTS "Users can select own data" ON public."User";
CREATE POLICY "Users can select own data" ON public."User" FOR SELECT USING (((auth.uid())::text = "userId"));
DROP POLICY IF EXISTS "Users can select own data" ON public."UserAuthAssistanceRequest";
CREATE POLICY "Users can select own data" ON public."UserAuthAssistanceRequest" FOR SELECT USING (((auth.uid())::text = "userId"));
DROP POLICY IF EXISTS "Users can view own agent verifiers" ON public."Verifier";
CREATE POLICY "Users can view own agent verifiers" ON public."Verifier" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public."Agent"
  WHERE (("Agent".id = "Verifier"."agentId") AND ("Agent"."userId" = (auth.uid())::text)))));
