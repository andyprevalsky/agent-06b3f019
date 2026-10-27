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
-- migrate deploy runs this file outside a transaction, so the limit is set for
-- the session and reset at the end (later migrations share the session).
SET lock_timeout = '15s';

-- Baseline tables whose RLS was disabled in production.
ALTER TABLE IF EXISTS public."PlaidAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."PlaidItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."RoseApiKey" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."RoseApiKeyLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."RoseConversationModel" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."RoseModelLatency" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."SmsSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."SmsShortcode" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."SteelSessionAuth" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."Subscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."Tool" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."ToolUsage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."UserAuthAssistanceRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."UserDataDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."UserDataProviderSyncState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."UserSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."UserSnapshotRevision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."Verifier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."Waitlist" ENABLE ROW LEVEL SECURITY;

-- Tables created after the baseline without RLS.
ALTER TABLE IF EXISTS public."AgentPhoneMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."AgentQueuePointer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."AgentTaskProgressEstimate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."AgentTrajectorySearch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."BenchmarkRunRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."BenchmarkTask" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."BrowserProviderProfile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."BrowserProviderProxy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."ComputeAccountConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."ComputeGrant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."ComputeTokenFastCacheAffinity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."ComputeTokenLineageLease" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."FastModeCacheEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."GoogleDataPurge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."PlaidTransaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."PlannerMemory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."PurchaseSpend" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."PurchaseWalletFunding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."TemporalWorkflowCleanup" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."ToolSideEffect" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."TraceArchiveFinalization" ENABLE ROW LEVEL SECURITY;

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

RESET lock_timeout;
