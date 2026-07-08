-- Baseline migration (squash of the pre-2026-07-06 migration history).
-- Generated from a pg_dump --schema-only of prod (the source of truth),
-- then cleaned by scripts/clean-baseline-dump.py. Reproduces the full prod
-- schema: tables, enums, indexes (incl. the pg_trgm expression index),
-- functions, broadcast triggers, and RLS policies. Existing environments
-- have this marked applied via `prisma migrate resolve`; only a fresh DB
-- actually runs it.

--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.0

SET check_function_bodies = false;

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--



--
-- Name: AgentSource; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."AgentSource" AS ENUM (
    'WEB',
    'MAC_APP',
    'SMS'
);


--
-- Name: AgentStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."AgentStatus" AS ENUM (
    'STARTING_UP',
    'ACTIVE',
    'PAUSED',
    'COMPLETED',
    'FAILED',
    'OUT_OF_CREDITS',
    'COST_LIMIT_REACHED'
);


--
-- Name: BrowserSessionStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."BrowserSessionStatus" AS ENUM (
    'ACTIVE',
    'CLOSED',
    'ERROR',
    'PAUSED'
);


--
-- Name: ClaudeCodeSessionStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ClaudeCodeSessionStatus" AS ENUM (
    'ACTIVE',
    'COMPLETED',
    'CLOSED',
    'ERROR'
);


--
-- Name: EmailProvider; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."EmailProvider" AS ENUM (
    'GMAIL',
    'YAHOO'
);


--
-- Name: IntegrationStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."IntegrationStatus" AS ENUM (
    'NOT_CONNECTED',
    'CONNECTED',
    'SYNCING',
    'SYNC_FAILED',
    'EXPIRED'
);


--
-- Name: IntegrationType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."IntegrationType" AS ENUM (
    'TOOL_SETUP',
    'DATA_SOURCE'
);


--
-- Name: MessageChannel; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."MessageChannel" AS ENUM (
    'IMESSAGE',
    'WHATSAPP',
    'EMAIL',
    'TELEGRAM',
    'TWITTER',
    'INSTAGRAM_DM',
    'MESSENGER',
    'LINKEDIN'
);


--
-- Name: MessageRole; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."MessageRole" AS ENUM (
    'SYSTEM',
    'ASSISTANT',
    'USER',
    'TOOL'
);


--
-- Name: PlaidItemStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."PlaidItemStatus" AS ENUM (
    'ACTIVE',
    'DISCONNECTED',
    'REQUIRES_REAUTH',
    'ERROR'
);


--
-- Name: PurchaseSpendStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."PurchaseSpendStatus" AS ENUM (
    'PENDING_APPROVAL',
    'CHARGING',
    'HELD',
    'CLEARED',
    'VOIDED',
    'REFUNDED',
    'FAILED',
    'CAPTURE_FAILED',
    'FUNDING_RECLAIM_FAILED'
);


--
-- Name: PurchaseWalletFundingStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."PurchaseWalletFundingStatus" AS ENUM (
    'PENDING',
    'FUNDED',
    'CONSUMED',
    'RECLAIMING',
    'RECLAIMED',
    'FAILED',
    'RECLAIM_FAILED'
);


--
-- Name: TransactionDirection; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."TransactionDirection" AS ENUM (
    'OUTFLOW',
    'INFLOW'
);


--
-- Name: VerifierType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."VerifierType" AS ENUM (
    'FLOAT_LLM_JUDGE'
);


--
-- Name: agent_attention_request_broadcast_trigger(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_attention_request_broadcast_trigger() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_topic text;
BEGIN
  v_topic := 'user:' || COALESCE(NEW."userId", OLD."userId");
  PERFORM realtime.broadcast_changes(
    v_topic,
    TG_OP,
    TG_OP,
    TG_TABLE_NAME,
    TG_TABLE_SCHEMA,
    NEW,
    OLD
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: agent_broadcast_trigger(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_broadcast_trigger() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_topic text;
BEGIN
  v_topic := 'agent:' || COALESCE(NEW."id", OLD."id");
  PERFORM realtime.broadcast_changes(
    v_topic,
    TG_OP,
    TG_OP,
    TG_TABLE_NAME,
    TG_TABLE_SCHEMA,
    NEW,
    OLD
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: increment_loser_latency(text, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_loser_latency(p_model text, p_pool text, p_increment integer DEFAULT 10) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  UPDATE "RoseModelLatency"
  SET 
    "latencyMs" = "latencyMs" + p_increment,
    "measuredAt" = NOW()
  WHERE model = p_model AND pool = p_pool;
END;
$$;


--
-- Name: message_broadcast_trigger(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.message_broadcast_trigger() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_topic text;
BEGIN
  v_topic := 'agent:' || COALESCE(NEW."agentId", OLD."agentId");
  PERFORM realtime.broadcast_changes(
    v_topic,
    TG_OP,
    TG_OP,
    TG_TABLE_NAME,
    TG_TABLE_SCHEMA,
    NEW,
    OLD
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;




--
-- Name: Agent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Agent" (
    id text NOT NULL,
    "userId" text NOT NULL,
    goal text NOT NULL,
    progress double precision DEFAULT 0.0 NOT NULL,
    status public."AgentStatus" DEFAULT 'STARTING_UP'::public."AgentStatus" NOT NULL,
    "statusMessage" text,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "temporalWorkflowId" text,
    model text DEFAULT 'rose-labs/rose-1-ultra'::text NOT NULL,
    "contextSize" integer DEFAULT 0 NOT NULL,
    "messageCount" integer DEFAULT 0 NOT NULL,
    "tokenCount" integer DEFAULT 0 NOT NULL,
    "tokensIn" integer DEFAULT 0 NOT NULL,
    "tokensOut" integer DEFAULT 0 NOT NULL,
    "parentAgentId" text,
    "tokenInPriceMicrodollars" integer,
    "tokenOutPriceMicrodollars" integer,
    source public."AgentSource" DEFAULT 'WEB'::public."AgentSource" NOT NULL,
    depth integer DEFAULT 0 NOT NULL,
    "parentWorkflowId" text,
    "reasoningMaxTokens" integer DEFAULT 2048 NOT NULL,
    "responseSchema" jsonb,
    "busId" text,
    "toolsInUse" text[] DEFAULT ARRAY[]::text[],
    "structuredResponse" jsonb,
    "proxyCity" text,
    "proxyCountry" text,
    "proxyState" text,
    "priceLimitCents" integer DEFAULT 100 NOT NULL,
    "treeCostCents" integer DEFAULT 0 NOT NULL,
    "writeLockEnabled" boolean DEFAULT true NOT NULL,
    "githubRepoUrl" text,
    "ownCostCents" double precision DEFAULT 0 NOT NULL,
    "fastModeCacheEnabled" boolean DEFAULT false NOT NULL
);

ALTER TABLE ONLY public."Agent" REPLICA IDENTITY FULL;


--
-- Name: AgentAttentionRequest; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AgentAttentionRequest" (
    id text NOT NULL,
    "userId" text NOT NULL,
    "agentId" text NOT NULL,
    "workflowId" text NOT NULL,
    question text NOT NULL,
    "userResponse" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "imageUrl" text,
    metadata jsonb
);

ALTER TABLE ONLY public."AgentAttentionRequest" REPLICA IDENTITY FULL;


--
-- Name: AgentIdentity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AgentIdentity" (
    id text NOT NULL,
    "userId" text NOT NULL,
    email text NOT NULL,
    phone text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "phoneProvider" text,
    "phoneProviderAgentId" text,
    "phoneProviderNumberId" text
);


--
-- Name: AgentPhoneMessage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AgentPhoneMessage" (
    id text NOT NULL,
    "userId" text NOT NULL,
    "externalId" text NOT NULL,
    "providerAgentId" text,
    "providerNumberId" text,
    "from" text NOT NULL,
    "to" text NOT NULL,
    body text NOT NULL,
    channel text NOT NULL,
    "receivedAt" timestamp(3) without time zone NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: AgentRunCredentialPropagation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AgentRunCredentialPropagation" (
    "agentId" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: AgentTool; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AgentTool" (
    "agentId" text NOT NULL,
    "toolId" text NOT NULL,
    "assignedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: BenchmarkRun; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."BenchmarkRun" (
    id text NOT NULL,
    "userId" text NOT NULL,
    "benchmarkName" text NOT NULL,
    "modelConfig" jsonb NOT NULL,
    results jsonb NOT NULL,
    "aggregateScore" double precision NOT NULL,
    "totalCostCents" integer NOT NULL,
    "sampledQuestions" integer NOT NULL,
    "durationSeconds" integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: BrowserContext; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."BrowserContext" (
    id text NOT NULL,
    "userId" text NOT NULL,
    "contextId" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: BrowserPassword; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."BrowserPassword" (
    id text NOT NULL,
    "userId" text NOT NULL,
    origin text NOT NULL,
    username text NOT NULL,
    "encryptedPassword" text NOT NULL,
    "dateLastUsed" bigint,
    "dateCreated" bigint,
    "browserSource" text NOT NULL,
    "syncedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "browserProfile" text DEFAULT ''::text NOT NULL,
    "disabledAt" timestamp(3) without time zone,
    "disabledReason" text
);


--
-- Name: BrowserPermission; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."BrowserPermission" (
    id text NOT NULL,
    "userId" text NOT NULL,
    origin text NOT NULL,
    permission text NOT NULL,
    setting integer NOT NULL,
    "syncedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: BrowserSession; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."BrowserSession" (
    id text NOT NULL,
    "contextId" text NOT NULL,
    "agentId" text NOT NULL,
    "sessionId" text NOT NULL,
    status public."BrowserSessionStatus" DEFAULT 'ACTIVE'::public."BrowserSessionStatus" NOT NULL,
    "debugUrl" text,
    "currentUrl" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "closedAt" timestamp(3) without time zone,
    "wsUrl" text,
    "injectedOrigins" jsonb,
    "startUrl" text
);


--
-- Name: CacheStorageOrigin; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."CacheStorageOrigin" (
    id text NOT NULL,
    "userId" text NOT NULL,
    origin text NOT NULL,
    caches jsonb NOT NULL,
    hash text NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: ClaudeCodeSession; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ClaudeCodeSession" (
    id text NOT NULL,
    "agentId" text NOT NULL,
    "sandboxId" text NOT NULL,
    "streamUrl" text,
    goal text NOT NULL,
    status public."ClaudeCodeSessionStatus" DEFAULT 'ACTIVE'::public."ClaudeCodeSessionStatus" NOT NULL,
    output text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "closedAt" timestamp(3) without time zone,
    "claudeTokenIntegrationId" text,
    "claudeTokenSource" text
);


--
-- Name: ComputeTokenFastCacheAffinity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ComputeTokenFastCacheAffinity" (
    "affinityKey" text NOT NULL,
    "tokenType" text NOT NULL,
    "userId" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: ComputeTokenLineageLease; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ComputeTokenLineageLease" (
    "lineageKey" text NOT NULL,
    "tokenType" text NOT NULL,
    "tokenSource" text NOT NULL,
    "tokenIdentity" text NOT NULL,
    "userId" text,
    "agentId" text,
    "rootAgentId" text,
    "assignedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "lastUsedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "releasedAt" timestamp(3) without time zone
);


--
-- Name: Cookie; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Cookie" (
    id text NOT NULL,
    "userId" text NOT NULL,
    domain text NOT NULL,
    name text NOT NULL,
    path text DEFAULT '/'::text NOT NULL,
    value text NOT NULL,
    "expiresUtc" bigint,
    "isSecure" boolean DEFAULT false NOT NULL,
    "isHttpOnly" boolean DEFAULT false NOT NULL,
    "browserSource" text NOT NULL,
    "syncedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "creationUtc" bigint,
    "hasExpires" boolean DEFAULT true NOT NULL,
    "isPersistent" boolean DEFAULT true NOT NULL,
    "lastAccessUtc" bigint,
    "lastUpdateUtc" bigint,
    priority integer DEFAULT 1 NOT NULL,
    "sameSite" integer DEFAULT '-1'::integer NOT NULL,
    "sourcePort" integer DEFAULT '-1'::integer NOT NULL,
    "sourceScheme" integer DEFAULT 0 NOT NULL,
    "topFrameSiteKey" text DEFAULT ''::text NOT NULL,
    "browserProfile" text DEFAULT ''::text NOT NULL
);


--
-- Name: CookieBundle; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."CookieBundle" (
    id text NOT NULL,
    "userId" text NOT NULL,
    "authRealm" text NOT NULL,
    "browserSource" text NOT NULL,
    "browserProfile" text DEFAULT ''::text NOT NULL,
    "accountLabel" text,
    "disabledAt" timestamp(3) without time zone,
    "disabledReason" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: Credit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Credit" (
    id text NOT NULL,
    "userId" text NOT NULL,
    "amountCents" integer NOT NULL,
    "expirationDate" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: EmailIntegrationCredential; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."EmailIntegrationCredential" (
    id text NOT NULL,
    "userId" text NOT NULL,
    "integrationId" text NOT NULL,
    provider public."EmailProvider" NOT NULL,
    "pkceVerifier" text,
    "stateToken" text,
    "accessToken" text,
    "refreshToken" text,
    "expiresAt" timestamp(3) without time zone,
    scopes text[] DEFAULT ARRAY[]::text[],
    metadata jsonb,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    email text
);


--
-- Name: FastModeCacheEntry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FastModeCacheEntry" (
    key text NOT NULL,
    kind text NOT NULL,
    "goalHash" text NOT NULL,
    value jsonb,
    "blobPath" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: Feedback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Feedback" (
    id text NOT NULL,
    "userId" text NOT NULL,
    feedback text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: GithubRepoAccess; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."GithubRepoAccess" (
    id text NOT NULL,
    "userId" text NOT NULL,
    "repoUrl" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: GoalBlueprint; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."GoalBlueprint" (
    id text NOT NULL,
    "userId" text NOT NULL,
    title text NOT NULL,
    blueprint jsonb NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    embedding jsonb,
    metadata jsonb
);


--
-- Name: GoalHistory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."GoalHistory" (
    id text NOT NULL,
    "originalAgentId" text NOT NULL,
    "userId" text NOT NULL,
    goal text NOT NULL,
    status public."AgentStatus" NOT NULL,
    "statusMessage" text,
    model text NOT NULL,
    "contextSize" integer NOT NULL,
    "messageCount" integer NOT NULL,
    "tokenCount" integer NOT NULL,
    "tokensIn" integer NOT NULL,
    "tokensOut" integer NOT NULL,
    source public."AgentSource" NOT NULL,
    depth integer NOT NULL,
    "agentCreatedAt" timestamp(3) without time zone NOT NULL,
    "agentUpdatedAt" timestamp(3) without time zone NOT NULL,
    "agentDeletedAt" timestamp(3) without time zone,
    "archivedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: ImessageQueue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ImessageQueue" (
    id text NOT NULL,
    "userId" text NOT NULL,
    "agentId" text NOT NULL,
    "phoneNumber" text NOT NULL,
    message text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: IndexedDBOrigin; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."IndexedDBOrigin" (
    id text NOT NULL,
    "userId" text NOT NULL,
    origin text NOT NULL,
    databases jsonb NOT NULL,
    hash text NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: Integration; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Integration" (
    id text NOT NULL,
    "userId" text NOT NULL,
    type public."IntegrationType" NOT NULL,
    name text NOT NULL,
    status public."IntegrationStatus" DEFAULT 'NOT_CONNECTED'::public."IntegrationStatus" NOT NULL,
    "isActive" boolean DEFAULT false NOT NULL,
    "lastSyncAt" timestamp(3) without time zone,
    "lastSuccessfulSyncAt" timestamp(3) without time zone,
    "lastFailedSyncAt" timestamp(3) without time zone,
    "failureReason" text,
    config jsonb,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "poolingEnabled" boolean DEFAULT false NOT NULL,
    "rateLimitedUntil" timestamp(3) without time zone,
    "lastUsedAt" timestamp(3) without time zone
);


--
-- Name: LocalStorageOrigin; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."LocalStorageOrigin" (
    id text NOT NULL,
    "userId" text NOT NULL,
    origin text NOT NULL,
    entries jsonb NOT NULL,
    hash text NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: Message; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Message" (
    id text NOT NULL,
    "agentId" text NOT NULL,
    "timestamp" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    text text NOT NULL,
    role public."MessageRole" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    metadata jsonb,
    "filePointer" jsonb
);

ALTER TABLE ONLY public."Message" REPLICA IDENTITY FULL;


--
-- Name: MessageRecord; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."MessageRecord" (
    id text NOT NULL,
    "personId" text NOT NULL,
    channel public."MessageChannel" NOT NULL,
    "from" text NOT NULL,
    "to" text NOT NULL,
    "timestamp" timestamp(3) without time zone NOT NULL,
    message text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "externalId" text
);


--
-- Name: MintedAccount; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."MintedAccount" (
    id text NOT NULL,
    "userId" text NOT NULL,
    "authRealm" text NOT NULL,
    "accountLabel" text NOT NULL,
    "disabledAt" timestamp(3) without time zone,
    "disabledReason" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: ModelPricingCache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ModelPricingCache" (
    "modelId" text NOT NULL,
    "tokenInPriceMicrodollars" integer NOT NULL,
    "tokenOutPriceMicrodollars" integer NOT NULL,
    "cachedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "expiresAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: PasskeyCredential; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."PasskeyCredential" (
    id text NOT NULL,
    "userId" text NOT NULL,
    "authRealm" text NOT NULL,
    "rpId" text NOT NULL,
    "credentialId" text NOT NULL,
    "encryptedPrivateKey" text NOT NULL,
    "userHandle" text,
    "signCount" bigint DEFAULT 0 NOT NULL,
    origin text,
    "browserSource" text DEFAULT 'cdp_virtual'::text NOT NULL,
    "disabledAt" timestamp(3) without time zone,
    "disabledReason" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: PendingLocalStorageBatch; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."PendingLocalStorageBatch" (
    id text NOT NULL,
    "userId" text NOT NULL,
    "uploadId" text NOT NULL,
    "batchIndex" integer NOT NULL,
    "totalBatches" integer NOT NULL,
    data jsonb NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: Person; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Person" (
    id text NOT NULL,
    "userId" text NOT NULL,
    "firstName" text NOT NULL,
    "lastName" text NOT NULL,
    age integer,
    location text,
    profession text,
    company text,
    title text,
    industry text,
    email text,
    "phoneNumber" text,
    "linkedinUrl" text,
    "instagramHandle" text,
    "facebookUrl" text,
    "twitterHandle" text,
    embedding jsonb,
    "emailAddresses" jsonb DEFAULT '[]'::jsonb,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "communicationFrequency" text,
    "contactStatus" text,
    "currentBandwidth" text,
    "estimatedNetWorthUsd" double precision,
    "estimatedWorldPowerRanking" integer,
    interests jsonb DEFAULT '[]'::jsonb,
    "networkOrientation" text,
    notes text,
    relation text,
    "relationshipQuality" text,
    skills jsonb DEFAULT '[]'::jsonb,
    "totalOnlineReach" integer,
    "messagesExchanged" integer DEFAULT 0 NOT NULL
);


--
-- Name: PlaidAccount; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."PlaidAccount" (
    id text NOT NULL,
    "userId" text NOT NULL,
    "plaidItemId" text NOT NULL,
    "plaidAccountId" text NOT NULL,
    name text NOT NULL,
    "officialName" text,
    mask text,
    type text NOT NULL,
    subtype text,
    "verificationStatus" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "disconnectedAt" timestamp(3) without time zone
);


--
-- Name: PlaidItem; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."PlaidItem" (
    id text NOT NULL,
    "userId" text NOT NULL,
    "integrationId" text NOT NULL,
    "plaidItemId" text NOT NULL,
    "plaidInstitutionId" text,
    "institutionName" text,
    "encryptedAccessToken" text NOT NULL,
    status public."PlaidItemStatus" DEFAULT 'ACTIVE'::public."PlaidItemStatus" NOT NULL,
    products text[] DEFAULT ARRAY[]::text[],
    cursor text,
    "lastSyncAt" timestamp(3) without time zone,
    "lastWebhookAt" timestamp(3) without time zone,
    "errorCode" text,
    "errorMessage" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "disconnectedAt" timestamp(3) without time zone
);


--
-- Name: PlaidTransaction; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."PlaidTransaction" (
    id text NOT NULL,
    "userId" text NOT NULL,
    "plaidItemId" text NOT NULL,
    "plaidAccountId" text NOT NULL,
    "plaidTransactionId" text NOT NULL,
    "plaidAccountExternalId" text NOT NULL,
    date timestamp(3) without time zone NOT NULL,
    "authorizedDate" timestamp(3) without time zone,
    datetime timestamp(3) without time zone,
    "authorizedDatetime" timestamp(3) without time zone,
    name text NOT NULL,
    "merchantName" text,
    "originalDescription" text,
    amount numeric(18,4) NOT NULL,
    "absoluteAmount" numeric(18,4) NOT NULL,
    direction public."TransactionDirection" NOT NULL,
    "isoCurrencyCode" text,
    "unofficialCurrencyCode" text,
    category text[] DEFAULT ARRAY[]::text[],
    "categoryId" text,
    "personalFinanceCategory" text,
    "personalFinanceDetailed" text,
    "paymentChannel" text,
    "locationSummary" text,
    pending boolean DEFAULT false NOT NULL,
    "pendingTransactionId" text,
    "accountOwner" text,
    "checkNumber" text,
    "removedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: PurchaseSpend; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."PurchaseSpend" (
    id text NOT NULL,
    "userId" text NOT NULL,
    "agentId" text,
    fingerprint text NOT NULL,
    "cardId" text,
    merchant text NOT NULL,
    "lineItemsJson" jsonb NOT NULL,
    "totalCents" integer NOT NULL,
    status public."PurchaseSpendStatus" DEFAULT 'PENDING_APPROVAL'::public."PurchaseSpendStatus" NOT NULL,
    "stripePaymentIntentId" text,
    provider text DEFAULT 'agentcard'::text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: PurchaseWalletFunding; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."PurchaseWalletFunding" (
    id text NOT NULL,
    "purchaseId" text NOT NULL,
    "userId" text NOT NULL,
    "agentId" text,
    provider text DEFAULT 'agentcard'::text NOT NULL,
    "amountCents" integer NOT NULL,
    currency text DEFAULT 'usd'::text NOT NULL,
    status public."PurchaseWalletFundingStatus" DEFAULT 'PENDING'::public."PurchaseWalletFundingStatus" NOT NULL,
    "providerTransferId" text,
    "reclaimProviderTransferId" text,
    "idempotencyKey" text NOT NULL,
    "reclaimIdempotencyKey" text,
    metadata jsonb,
    "errorMessage" text,
    "fundedAt" timestamp(3) without time zone,
    "consumedAt" timestamp(3) without time zone,
    "reclaimedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: RoseApiKey; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."RoseApiKey" (
    id text NOT NULL,
    "userId" text NOT NULL,
    "apiKey" text NOT NULL,
    name text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: RoseApiKeyLog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."RoseApiKeyLog" (
    id text NOT NULL,
    "apiKeyId" text NOT NULL,
    "userId" text NOT NULL,
    input jsonb NOT NULL,
    output jsonb NOT NULL,
    "costCents" integer NOT NULL,
    "cotSteps" integer DEFAULT 1 NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: RoseConversationModel; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."RoseConversationModel" (
    id text NOT NULL,
    "conversationId" text NOT NULL,
    model text NOT NULL,
    pool text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: RoseModelLatency; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."RoseModelLatency" (
    id text NOT NULL,
    model text NOT NULL,
    pool text NOT NULL,
    "latencyMs" integer NOT NULL,
    "measuredAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: SmsSession; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."SmsSession" (
    id text NOT NULL,
    "userId" text NOT NULL,
    messages jsonb DEFAULT '[]'::jsonb NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "lastInboundSeq" integer DEFAULT 0 NOT NULL
);


--
-- Name: SmsShortcode; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."SmsShortcode" (
    id text NOT NULL,
    code text NOT NULL,
    "userId" text NOT NULL,
    "attentionRequestId" text NOT NULL,
    "agentId" text NOT NULL,
    "workflowId" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "expiresAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: SteelSessionAuth; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."SteelSessionAuth" (
    id text NOT NULL,
    "userId" text NOT NULL,
    "contextId" text NOT NULL,
    "authRealm" text NOT NULL,
    "authenticatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "disabledAt" timestamp(3) without time zone,
    "disabledReason" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: Subscription; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Subscription" (
    id text NOT NULL,
    "userId" text NOT NULL,
    "subscriptionTier" integer NOT NULL,
    "stripeSubscriptionId" text NOT NULL,
    "stripeCustomerId" text NOT NULL,
    "currentPeriodEnd" timestamp(3) without time zone NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: Tool; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Tool" (
    id text NOT NULL,
    name text NOT NULL,
    description text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: ToolSideEffect; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ToolSideEffect" (
    id text NOT NULL,
    "operationKey" text NOT NULL,
    "operationType" text NOT NULL,
    status text DEFAULT 'STARTED'::text NOT NULL,
    "externalId" text,
    request jsonb,
    response jsonb,
    error text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: ToolUsage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ToolUsage" (
    id text NOT NULL,
    "agentId" text,
    "toolName" text NOT NULL,
    "totalCostCents" integer NOT NULL,
    "usageItems" jsonb NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "userId" text NOT NULL
);


--
-- Name: User; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."User" (
    id text NOT NULL,
    "userId" text NOT NULL,
    name text,
    "addressLine1" text,
    "addressLine2" text,
    city text,
    state text,
    "postalCode" text,
    country text DEFAULT 'United States'::text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "inviteCode" integer,
    "inviteCodeUses" integer DEFAULT 0 NOT NULL,
    "usedInviteCode" integer,
    "encryptedPaymentInformation" text,
    phone text,
    "isAnonymous" boolean DEFAULT false NOT NULL,
    "onboardingCompletedAt" timestamp(3) without time zone,
    "customSystemPrompt" text,
    "profilePicture" text,
    "systemName" text,
    "voicePreferenceId" text
);


--
-- Name: UserAuthAssistanceRequest; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."UserAuthAssistanceRequest" (
    id text NOT NULL,
    "agentId" text NOT NULL,
    "userId" text NOT NULL,
    "authRealm" text NOT NULL,
    "steelSessionId" text NOT NULL,
    mode text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "completedAt" timestamp(3) without time zone,
    "browserSessionId" text
);


--
-- Name: UserDataDocument; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."UserDataDocument" (
    id text NOT NULL,
    "userId" text NOT NULL,
    source text NOT NULL,
    "externalId" text NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    url text,
    metadata jsonb DEFAULT '{}'::jsonb,
    "contentHash" text NOT NULL,
    "sourceUpdatedAt" timestamp(3) without time zone,
    "lastSeenAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: UserDataProviderSyncState; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."UserDataProviderSyncState" (
    id text NOT NULL,
    "userId" text NOT NULL,
    source text NOT NULL,
    status text DEFAULT 'NOT_CONNECTED'::text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb,
    cursor jsonb DEFAULT '{}'::jsonb,
    "lastStartedAt" timestamp(3) without time zone,
    "lastSuccessfulSyncAt" timestamp(3) without time zone,
    "lastError" text,
    "nextSyncAt" timestamp(3) without time zone,
    "realtimeEnabled" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: UserSnapshot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."UserSnapshot" (
    id text NOT NULL,
    "userId" text NOT NULL,
    content jsonb DEFAULT '{}'::jsonb NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: UserSnapshotRevision; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."UserSnapshotRevision" (
    id text NOT NULL,
    "userId" text NOT NULL,
    "snapshotId" text NOT NULL,
    "documentId" text,
    source text NOT NULL,
    before jsonb DEFAULT '{}'::jsonb NOT NULL,
    after jsonb DEFAULT '{}'::jsonb NOT NULL,
    changes jsonb DEFAULT '{}'::jsonb,
    model text,
    "promptKey" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: Verifier; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Verifier" (
    id text NOT NULL,
    "agentId" text NOT NULL,
    type public."VerifierType" DEFAULT 'FLOAT_LLM_JUDGE'::public."VerifierType" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: Waitlist; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Waitlist" (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    variant text,
    referral_code text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: AgentAttentionRequest AgentAttentionRequest_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentAttentionRequest"
    ADD CONSTRAINT "AgentAttentionRequest_pkey" PRIMARY KEY (id);


--
-- Name: AgentIdentity AgentIdentity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentIdentity"
    ADD CONSTRAINT "AgentIdentity_pkey" PRIMARY KEY (id);


--
-- Name: AgentPhoneMessage AgentPhoneMessage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentPhoneMessage"
    ADD CONSTRAINT "AgentPhoneMessage_pkey" PRIMARY KEY (id);


--
-- Name: AgentRunCredentialPropagation AgentRunCredentialPropagation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentRunCredentialPropagation"
    ADD CONSTRAINT "AgentRunCredentialPropagation_pkey" PRIMARY KEY ("agentId");


--
-- Name: AgentTool AgentTool_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentTool"
    ADD CONSTRAINT "AgentTool_pkey" PRIMARY KEY ("agentId", "toolId");


--
-- Name: Agent Agent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Agent"
    ADD CONSTRAINT "Agent_pkey" PRIMARY KEY (id);


--
-- Name: BenchmarkRun BenchmarkRun_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BenchmarkRun"
    ADD CONSTRAINT "BenchmarkRun_pkey" PRIMARY KEY (id);


--
-- Name: BrowserContext BrowserContext_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BrowserContext"
    ADD CONSTRAINT "BrowserContext_pkey" PRIMARY KEY (id);


--
-- Name: BrowserPassword BrowserPassword_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BrowserPassword"
    ADD CONSTRAINT "BrowserPassword_pkey" PRIMARY KEY (id);


--
-- Name: BrowserPermission BrowserPermission_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BrowserPermission"
    ADD CONSTRAINT "BrowserPermission_pkey" PRIMARY KEY (id);


--
-- Name: BrowserSession BrowserSession_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BrowserSession"
    ADD CONSTRAINT "BrowserSession_pkey" PRIMARY KEY (id);


--
-- Name: CacheStorageOrigin CacheStorageOrigin_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CacheStorageOrigin"
    ADD CONSTRAINT "CacheStorageOrigin_pkey" PRIMARY KEY (id);


--
-- Name: ClaudeCodeSession ClaudeCodeSession_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ClaudeCodeSession"
    ADD CONSTRAINT "ClaudeCodeSession_pkey" PRIMARY KEY (id);


--
-- Name: ComputeTokenFastCacheAffinity ComputeTokenFastCacheAffinity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ComputeTokenFastCacheAffinity"
    ADD CONSTRAINT "ComputeTokenFastCacheAffinity_pkey" PRIMARY KEY ("affinityKey");


--
-- Name: ComputeTokenLineageLease ComputeTokenLineageLease_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ComputeTokenLineageLease"
    ADD CONSTRAINT "ComputeTokenLineageLease_pkey" PRIMARY KEY ("lineageKey");


--
-- Name: CookieBundle CookieBundle_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CookieBundle"
    ADD CONSTRAINT "CookieBundle_pkey" PRIMARY KEY (id);


--
-- Name: Cookie Cookie_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Cookie"
    ADD CONSTRAINT "Cookie_pkey" PRIMARY KEY (id);


--
-- Name: Cookie Cookie_userId_domain_name_path_topFrameSiteKey_browserSource_br; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Cookie"
    ADD CONSTRAINT "Cookie_userId_domain_name_path_topFrameSiteKey_browserSource_br" UNIQUE ("userId", domain, name, path, "topFrameSiteKey", "browserSource", "browserProfile");


--
-- Name: Credit Credit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Credit"
    ADD CONSTRAINT "Credit_pkey" PRIMARY KEY (id);


--
-- Name: EmailIntegrationCredential EmailIntegrationCredential_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."EmailIntegrationCredential"
    ADD CONSTRAINT "EmailIntegrationCredential_pkey" PRIMARY KEY (id);


--
-- Name: FastModeCacheEntry FastModeCacheEntry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FastModeCacheEntry"
    ADD CONSTRAINT "FastModeCacheEntry_pkey" PRIMARY KEY (key);


--
-- Name: Feedback Feedback_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Feedback"
    ADD CONSTRAINT "Feedback_pkey" PRIMARY KEY (id);


--
-- Name: GithubRepoAccess GithubRepoAccess_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GithubRepoAccess"
    ADD CONSTRAINT "GithubRepoAccess_pkey" PRIMARY KEY (id);


--
-- Name: GoalBlueprint GoalBlueprint_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GoalBlueprint"
    ADD CONSTRAINT "GoalBlueprint_pkey" PRIMARY KEY (id);


--
-- Name: GoalHistory GoalHistory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GoalHistory"
    ADD CONSTRAINT "GoalHistory_pkey" PRIMARY KEY (id);


--
-- Name: ImessageQueue ImessageQueue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ImessageQueue"
    ADD CONSTRAINT "ImessageQueue_pkey" PRIMARY KEY (id);


--
-- Name: IndexedDBOrigin IndexedDBOrigin_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."IndexedDBOrigin"
    ADD CONSTRAINT "IndexedDBOrigin_pkey" PRIMARY KEY (id);


--
-- Name: Integration Integration_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Integration"
    ADD CONSTRAINT "Integration_pkey" PRIMARY KEY (id);


--
-- Name: LocalStorageOrigin LocalStorageOrigin_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."LocalStorageOrigin"
    ADD CONSTRAINT "LocalStorageOrigin_pkey" PRIMARY KEY (id);


--
-- Name: MessageRecord MessageRecord_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MessageRecord"
    ADD CONSTRAINT "MessageRecord_pkey" PRIMARY KEY (id);


--
-- Name: Message Message_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Message"
    ADD CONSTRAINT "Message_pkey" PRIMARY KEY (id);


--
-- Name: MintedAccount MintedAccount_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MintedAccount"
    ADD CONSTRAINT "MintedAccount_pkey" PRIMARY KEY (id);


--
-- Name: ModelPricingCache ModelPricingCache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ModelPricingCache"
    ADD CONSTRAINT "ModelPricingCache_pkey" PRIMARY KEY ("modelId");


--
-- Name: PasskeyCredential PasskeyCredential_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PasskeyCredential"
    ADD CONSTRAINT "PasskeyCredential_pkey" PRIMARY KEY (id);


--
-- Name: PendingLocalStorageBatch PendingLocalStorageBatch_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PendingLocalStorageBatch"
    ADD CONSTRAINT "PendingLocalStorageBatch_pkey" PRIMARY KEY (id);


--
-- Name: Person Person_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Person"
    ADD CONSTRAINT "Person_pkey" PRIMARY KEY (id);


--
-- Name: PlaidAccount PlaidAccount_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PlaidAccount"
    ADD CONSTRAINT "PlaidAccount_pkey" PRIMARY KEY (id);


--
-- Name: PlaidItem PlaidItem_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PlaidItem"
    ADD CONSTRAINT "PlaidItem_pkey" PRIMARY KEY (id);


--
-- Name: PlaidTransaction PlaidTransaction_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PlaidTransaction"
    ADD CONSTRAINT "PlaidTransaction_pkey" PRIMARY KEY (id);


--
-- Name: PurchaseSpend PurchaseSpend_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PurchaseSpend"
    ADD CONSTRAINT "PurchaseSpend_pkey" PRIMARY KEY (id);


--
-- Name: PurchaseWalletFunding PurchaseWalletFunding_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PurchaseWalletFunding"
    ADD CONSTRAINT "PurchaseWalletFunding_pkey" PRIMARY KEY (id);


--
-- Name: RoseApiKeyLog RoseApiKeyLog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."RoseApiKeyLog"
    ADD CONSTRAINT "RoseApiKeyLog_pkey" PRIMARY KEY (id);


--
-- Name: RoseApiKey RoseApiKey_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."RoseApiKey"
    ADD CONSTRAINT "RoseApiKey_pkey" PRIMARY KEY (id);


--
-- Name: RoseConversationModel RoseConversationModel_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."RoseConversationModel"
    ADD CONSTRAINT "RoseConversationModel_pkey" PRIMARY KEY (id);


--
-- Name: RoseModelLatency RoseModelLatency_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."RoseModelLatency"
    ADD CONSTRAINT "RoseModelLatency_pkey" PRIMARY KEY (id);


--
-- Name: SmsSession SmsSession_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SmsSession"
    ADD CONSTRAINT "SmsSession_pkey" PRIMARY KEY (id);


--
-- Name: SmsShortcode SmsShortcode_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SmsShortcode"
    ADD CONSTRAINT "SmsShortcode_pkey" PRIMARY KEY (id);


--
-- Name: SteelSessionAuth SteelSessionAuth_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SteelSessionAuth"
    ADD CONSTRAINT "SteelSessionAuth_pkey" PRIMARY KEY (id);


--
-- Name: Subscription Subscription_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Subscription"
    ADD CONSTRAINT "Subscription_pkey" PRIMARY KEY (id);


--
-- Name: ToolSideEffect ToolSideEffect_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ToolSideEffect"
    ADD CONSTRAINT "ToolSideEffect_pkey" PRIMARY KEY (id);


--
-- Name: ToolUsage ToolUsage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ToolUsage"
    ADD CONSTRAINT "ToolUsage_pkey" PRIMARY KEY (id);


--
-- Name: Tool Tool_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Tool"
    ADD CONSTRAINT "Tool_pkey" PRIMARY KEY (id);


--
-- Name: UserAuthAssistanceRequest UserAuthAssistanceRequest_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserAuthAssistanceRequest"
    ADD CONSTRAINT "UserAuthAssistanceRequest_pkey" PRIMARY KEY (id);


--
-- Name: UserDataDocument UserDataDocument_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserDataDocument"
    ADD CONSTRAINT "UserDataDocument_pkey" PRIMARY KEY (id);


--
-- Name: UserDataProviderSyncState UserDataProviderSyncState_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserDataProviderSyncState"
    ADD CONSTRAINT "UserDataProviderSyncState_pkey" PRIMARY KEY (id);


--
-- Name: UserSnapshotRevision UserSnapshotRevision_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserSnapshotRevision"
    ADD CONSTRAINT "UserSnapshotRevision_pkey" PRIMARY KEY (id);


--
-- Name: UserSnapshot UserSnapshot_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserSnapshot"
    ADD CONSTRAINT "UserSnapshot_pkey" PRIMARY KEY (id);


--
-- Name: User User_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."User"
    ADD CONSTRAINT "User_pkey" PRIMARY KEY (id);


--
-- Name: Verifier Verifier_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Verifier"
    ADD CONSTRAINT "Verifier_pkey" PRIMARY KEY (id);


--
-- Name: Waitlist Waitlist_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Waitlist"
    ADD CONSTRAINT "Waitlist_pkey" PRIMARY KEY (id);


--
-- Name: AgentAttentionRequest_updatedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentAttentionRequest_updatedAt_idx" ON public."AgentAttentionRequest" USING btree ("updatedAt");


--
-- Name: AgentAttentionRequest_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentAttentionRequest_userId_idx" ON public."AgentAttentionRequest" USING btree ("userId");


--
-- Name: AgentAttentionRequest_workflowId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentAttentionRequest_workflowId_idx" ON public."AgentAttentionRequest" USING btree ("workflowId");


--
-- Name: AgentIdentity_phone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentIdentity_phone_idx" ON public."AgentIdentity" USING btree (phone);


--
-- Name: AgentIdentity_userId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "AgentIdentity_userId_key" ON public."AgentIdentity" USING btree ("userId");


--
-- Name: AgentPhoneMessage_externalId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "AgentPhoneMessage_externalId_key" ON public."AgentPhoneMessage" USING btree ("externalId");


--
-- Name: AgentPhoneMessage_to_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentPhoneMessage_to_idx" ON public."AgentPhoneMessage" USING btree ("to");


--
-- Name: AgentPhoneMessage_userId_receivedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentPhoneMessage_userId_receivedAt_idx" ON public."AgentPhoneMessage" USING btree ("userId", "receivedAt");


--
-- Name: AgentTool_agentId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentTool_agentId_idx" ON public."AgentTool" USING btree ("agentId");


--
-- Name: AgentTool_toolId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AgentTool_toolId_idx" ON public."AgentTool" USING btree ("toolId");


--
-- Name: Agent_busId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Agent_busId_idx" ON public."Agent" USING btree ("busId");


--
-- Name: Agent_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Agent_createdAt_idx" ON public."Agent" USING btree ("createdAt");


--
-- Name: Agent_parentAgentId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Agent_parentAgentId_idx" ON public."Agent" USING btree ("parentAgentId");


--
-- Name: Agent_temporalWorkflowId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Agent_temporalWorkflowId_idx" ON public."Agent" USING btree ("temporalWorkflowId");


--
-- Name: Agent_userId_deletedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Agent_userId_deletedAt_idx" ON public."Agent" USING btree ("userId", "deletedAt");


--
-- Name: BenchmarkRun_benchmarkName_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BenchmarkRun_benchmarkName_idx" ON public."BenchmarkRun" USING btree ("benchmarkName");


--
-- Name: BenchmarkRun_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BenchmarkRun_createdAt_idx" ON public."BenchmarkRun" USING btree ("createdAt");


--
-- Name: BenchmarkRun_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BenchmarkRun_userId_idx" ON public."BenchmarkRun" USING btree ("userId");


--
-- Name: BrowserContext_contextId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BrowserContext_contextId_idx" ON public."BrowserContext" USING btree ("contextId");


--
-- Name: BrowserContext_contextId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "BrowserContext_contextId_key" ON public."BrowserContext" USING btree ("contextId");


--
-- Name: BrowserContext_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BrowserContext_userId_idx" ON public."BrowserContext" USING btree ("userId");


--
-- Name: BrowserContext_userId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "BrowserContext_userId_key" ON public."BrowserContext" USING btree ("userId");


--
-- Name: BrowserPassword_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BrowserPassword_userId_idx" ON public."BrowserPassword" USING btree ("userId");


--
-- Name: BrowserPassword_userId_origin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BrowserPassword_userId_origin_idx" ON public."BrowserPassword" USING btree ("userId", origin);


--
-- Name: BrowserPassword_userId_origin_username_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "BrowserPassword_userId_origin_username_key" ON public."BrowserPassword" USING btree ("userId", origin, username);


--
-- Name: BrowserPermission_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BrowserPermission_userId_idx" ON public."BrowserPermission" USING btree ("userId");


--
-- Name: BrowserPermission_userId_origin_permission_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "BrowserPermission_userId_origin_permission_key" ON public."BrowserPermission" USING btree ("userId", origin, permission);


--
-- Name: BrowserSession_agentId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BrowserSession_agentId_idx" ON public."BrowserSession" USING btree ("agentId");


--
-- Name: BrowserSession_contextId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BrowserSession_contextId_idx" ON public."BrowserSession" USING btree ("contextId");


--
-- Name: BrowserSession_sessionId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BrowserSession_sessionId_idx" ON public."BrowserSession" USING btree ("sessionId");


--
-- Name: BrowserSession_sessionId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "BrowserSession_sessionId_key" ON public."BrowserSession" USING btree ("sessionId");


--
-- Name: BrowserSession_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BrowserSession_status_idx" ON public."BrowserSession" USING btree (status);


--
-- Name: CacheStorageOrigin_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "CacheStorageOrigin_userId_idx" ON public."CacheStorageOrigin" USING btree ("userId");


--
-- Name: CacheStorageOrigin_userId_origin_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "CacheStorageOrigin_userId_origin_key" ON public."CacheStorageOrigin" USING btree ("userId", origin);


--
-- Name: ClaudeCodeSession_agentId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ClaudeCodeSession_agentId_idx" ON public."ClaudeCodeSession" USING btree ("agentId");


--
-- Name: ClaudeCodeSession_sandboxId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ClaudeCodeSession_sandboxId_idx" ON public."ClaudeCodeSession" USING btree ("sandboxId");


--
-- Name: ClaudeCodeSession_sandboxId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ClaudeCodeSession_sandboxId_key" ON public."ClaudeCodeSession" USING btree ("sandboxId");


--
-- Name: ClaudeCodeSession_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ClaudeCodeSession_status_idx" ON public."ClaudeCodeSession" USING btree (status);


--
-- Name: ComputeTokenFastCacheAffinity_tokenType_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ComputeTokenFastCacheAffinity_tokenType_idx" ON public."ComputeTokenFastCacheAffinity" USING btree ("tokenType");


--
-- Name: ComputeTokenFastCacheAffinity_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ComputeTokenFastCacheAffinity_userId_idx" ON public."ComputeTokenFastCacheAffinity" USING btree ("userId");


--
-- Name: ComputeTokenLineageLease_agentId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ComputeTokenLineageLease_agentId_idx" ON public."ComputeTokenLineageLease" USING btree ("agentId");


--
-- Name: ComputeTokenLineageLease_rootAgentId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ComputeTokenLineageLease_rootAgentId_idx" ON public."ComputeTokenLineageLease" USING btree ("rootAgentId");


--
-- Name: ComputeTokenLineageLease_tokenType_tokenSource_tokenIdentity_re; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ComputeTokenLineageLease_tokenType_tokenSource_tokenIdentity_re" ON public."ComputeTokenLineageLease" USING btree ("tokenType", "tokenSource", "tokenIdentity", "releasedAt", "lastUsedAt");


--
-- Name: CookieBundle_userId_authRealm_browserSource_browserProfile_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "CookieBundle_userId_authRealm_browserSource_browserProfile_key" ON public."CookieBundle" USING btree ("userId", "authRealm", "browserSource", "browserProfile");


--
-- Name: CookieBundle_userId_authRealm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "CookieBundle_userId_authRealm_idx" ON public."CookieBundle" USING btree ("userId", "authRealm");


--
-- Name: Cookie_userId_browserSource_browserProfile_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Cookie_userId_browserSource_browserProfile_idx" ON public."Cookie" USING btree ("userId", "browserSource", "browserProfile");


--
-- Name: Cookie_userId_domain_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Cookie_userId_domain_idx" ON public."Cookie" USING btree ("userId", domain);


--
-- Name: Cookie_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Cookie_userId_idx" ON public."Cookie" USING btree ("userId");


--
-- Name: Credit_expirationDate_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Credit_expirationDate_idx" ON public."Credit" USING btree ("expirationDate");


--
-- Name: Credit_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Credit_userId_idx" ON public."Credit" USING btree ("userId");


--
-- Name: EmailIntegrationCredential_integrationId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "EmailIntegrationCredential_integrationId_idx" ON public."EmailIntegrationCredential" USING btree ("integrationId");


--
-- Name: EmailIntegrationCredential_userId_provider_email_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "EmailIntegrationCredential_userId_provider_email_key" ON public."EmailIntegrationCredential" USING btree ("userId", provider, email);


--
-- Name: EmailIntegrationCredential_userId_provider_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "EmailIntegrationCredential_userId_provider_idx" ON public."EmailIntegrationCredential" USING btree ("userId", provider);


--
-- Name: FastModeCacheEntry_goalHash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "FastModeCacheEntry_goalHash_idx" ON public."FastModeCacheEntry" USING btree ("goalHash");


--
-- Name: FastModeCacheEntry_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "FastModeCacheEntry_kind_idx" ON public."FastModeCacheEntry" USING btree (kind);


--
-- Name: Feedback_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Feedback_createdAt_idx" ON public."Feedback" USING btree ("createdAt");


--
-- Name: Feedback_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Feedback_userId_idx" ON public."Feedback" USING btree ("userId");


--
-- Name: GithubRepoAccess_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "GithubRepoAccess_userId_idx" ON public."GithubRepoAccess" USING btree ("userId");


--
-- Name: GithubRepoAccess_userId_repoUrl_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "GithubRepoAccess_userId_repoUrl_key" ON public."GithubRepoAccess" USING btree ("userId", "repoUrl");


--
-- Name: GoalBlueprint_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "GoalBlueprint_created_at_idx" ON public."GoalBlueprint" USING btree (created_at);


--
-- Name: GoalBlueprint_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "GoalBlueprint_userId_idx" ON public."GoalBlueprint" USING btree ("userId");


--
-- Name: GoalHistory_archivedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "GoalHistory_archivedAt_idx" ON public."GoalHistory" USING btree ("archivedAt");


--
-- Name: GoalHistory_originalAgentId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "GoalHistory_originalAgentId_idx" ON public."GoalHistory" USING btree ("originalAgentId");


--
-- Name: GoalHistory_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "GoalHistory_userId_idx" ON public."GoalHistory" USING btree ("userId");


--
-- Name: ImessageQueue_agentId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ImessageQueue_agentId_idx" ON public."ImessageQueue" USING btree ("agentId");


--
-- Name: ImessageQueue_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ImessageQueue_userId_idx" ON public."ImessageQueue" USING btree ("userId");


--
-- Name: IndexedDBOrigin_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IndexedDBOrigin_userId_idx" ON public."IndexedDBOrigin" USING btree ("userId");


--
-- Name: IndexedDBOrigin_userId_origin_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IndexedDBOrigin_userId_origin_key" ON public."IndexedDBOrigin" USING btree ("userId", origin);


--
-- Name: Integration_poolingEnabled_rateLimitedUntil_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Integration_poolingEnabled_rateLimitedUntil_idx" ON public."Integration" USING btree ("poolingEnabled", "rateLimitedUntil");


--
-- Name: Integration_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Integration_status_idx" ON public."Integration" USING btree (status);


--
-- Name: Integration_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Integration_type_idx" ON public."Integration" USING btree (type);


--
-- Name: Integration_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Integration_userId_idx" ON public."Integration" USING btree ("userId");


--
-- Name: Integration_userId_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Integration_userId_name_key" ON public."Integration" USING btree ("userId", name);


--
-- Name: LocalStorageOrigin_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "LocalStorageOrigin_userId_idx" ON public."LocalStorageOrigin" USING btree ("userId");


--
-- Name: LocalStorageOrigin_userId_origin_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "LocalStorageOrigin_userId_origin_key" ON public."LocalStorageOrigin" USING btree ("userId", origin);


--
-- Name: MessageRecord_channel_timestamp_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "MessageRecord_channel_timestamp_idx" ON public."MessageRecord" USING btree (channel, "timestamp");


--
-- Name: MessageRecord_personId_channel_externalId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "MessageRecord_personId_channel_externalId_key" ON public."MessageRecord" USING btree ("personId", channel, "externalId");


--
-- Name: MessageRecord_personId_channel_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "MessageRecord_personId_channel_idx" ON public."MessageRecord" USING btree ("personId", channel);


--
-- Name: MessageRecord_personId_timestamp_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "MessageRecord_personId_timestamp_idx" ON public."MessageRecord" USING btree ("personId", "timestamp");


--
-- Name: MessageRecord_timestamp_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "MessageRecord_timestamp_idx" ON public."MessageRecord" USING btree ("timestamp");


--
-- Name: Message_agentId_timestamp_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Message_agentId_timestamp_idx" ON public."Message" USING btree ("agentId", "timestamp");


--
-- Name: Message_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Message_createdAt_idx" ON public."Message" USING btree ("createdAt");


--
-- Name: MintedAccount_userId_authRealm_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "MintedAccount_userId_authRealm_key" ON public."MintedAccount" USING btree ("userId", "authRealm");


--
-- Name: ModelPricingCache_expiresAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ModelPricingCache_expiresAt_idx" ON public."ModelPricingCache" USING btree ("expiresAt");


--
-- Name: PasskeyCredential_userId_authRealm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PasskeyCredential_userId_authRealm_idx" ON public."PasskeyCredential" USING btree ("userId", "authRealm");


--
-- Name: PasskeyCredential_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PasskeyCredential_userId_idx" ON public."PasskeyCredential" USING btree ("userId");


--
-- Name: PasskeyCredential_userId_rpId_credentialId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "PasskeyCredential_userId_rpId_credentialId_key" ON public."PasskeyCredential" USING btree ("userId", "rpId", "credentialId");


--
-- Name: PendingLocalStorageBatch_userId_uploadId_batchIndex_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "PendingLocalStorageBatch_userId_uploadId_batchIndex_key" ON public."PendingLocalStorageBatch" USING btree ("userId", "uploadId", "batchIndex");


--
-- Name: PendingLocalStorageBatch_userId_uploadId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PendingLocalStorageBatch_userId_uploadId_idx" ON public."PendingLocalStorageBatch" USING btree ("userId", "uploadId");


--
-- Name: Person_communicationFrequency_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Person_communicationFrequency_idx" ON public."Person" USING btree ("communicationFrequency");


--
-- Name: Person_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Person_company_idx" ON public."Person" USING btree (company);


--
-- Name: Person_currentBandwidth_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Person_currentBandwidth_idx" ON public."Person" USING btree ("currentBandwidth");


--
-- Name: Person_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Person_email_idx" ON public."Person" USING btree (email);


--
-- Name: Person_firstName_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Person_firstName_idx" ON public."Person" USING btree ("firstName");


--
-- Name: Person_grep_contact_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Person_grep_contact_trgm_idx" ON public."Person" USING gin ((((((((((((((((COALESCE("firstName", ''::text) || '
'::text) || COALESCE("lastName", ''::text)) || '
'::text) || COALESCE(email, ''::text)) || '
'::text) || COALESCE("phoneNumber", ''::text)) || '
'::text) || COALESCE(company, ''::text)) || '
'::text) || COALESCE(title, ''::text)) || '
'::text) || COALESCE(relation, ''::text)) || '
'::text) || COALESCE("communicationFrequency", ''::text))) public.gin_trgm_ops);


--
-- Name: Person_lastName_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Person_lastName_idx" ON public."Person" USING btree ("lastName");


--
-- Name: Person_phoneNumber_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Person_phoneNumber_idx" ON public."Person" USING btree ("phoneNumber");


--
-- Name: Person_profession_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Person_profession_idx" ON public."Person" USING btree (profession);


--
-- Name: Person_relation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Person_relation_idx" ON public."Person" USING btree (relation);


--
-- Name: Person_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Person_userId_idx" ON public."Person" USING btree ("userId");


--
-- Name: Person_userId_phoneNumber_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Person_userId_phoneNumber_key" ON public."Person" USING btree ("userId", "phoneNumber");


--
-- Name: PlaidAccount_plaidAccountId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "PlaidAccount_plaidAccountId_key" ON public."PlaidAccount" USING btree ("plaidAccountId");


--
-- Name: PlaidAccount_plaidItemId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PlaidAccount_plaidItemId_idx" ON public."PlaidAccount" USING btree ("plaidItemId");


--
-- Name: PlaidAccount_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PlaidAccount_userId_idx" ON public."PlaidAccount" USING btree ("userId");


--
-- Name: PlaidItem_integrationId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PlaidItem_integrationId_idx" ON public."PlaidItem" USING btree ("integrationId");


--
-- Name: PlaidItem_plaidItemId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "PlaidItem_plaidItemId_key" ON public."PlaidItem" USING btree ("plaidItemId");


--
-- Name: PlaidItem_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PlaidItem_userId_idx" ON public."PlaidItem" USING btree ("userId");


--
-- Name: PlaidItem_userId_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PlaidItem_userId_status_idx" ON public."PlaidItem" USING btree ("userId", status);


--
-- Name: PlaidTransaction_plaidAccountExternalId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PlaidTransaction_plaidAccountExternalId_idx" ON public."PlaidTransaction" USING btree ("plaidAccountExternalId");


--
-- Name: PlaidTransaction_plaidAccountId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PlaidTransaction_plaidAccountId_idx" ON public."PlaidTransaction" USING btree ("plaidAccountId");


--
-- Name: PlaidTransaction_plaidItemId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PlaidTransaction_plaidItemId_idx" ON public."PlaidTransaction" USING btree ("plaidItemId");


--
-- Name: PlaidTransaction_plaidTransactionId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "PlaidTransaction_plaidTransactionId_key" ON public."PlaidTransaction" USING btree ("plaidTransactionId");


--
-- Name: PlaidTransaction_userId_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PlaidTransaction_userId_date_idx" ON public."PlaidTransaction" USING btree ("userId", date);


--
-- Name: PlaidTransaction_userId_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PlaidTransaction_userId_pending_idx" ON public."PlaidTransaction" USING btree ("userId", pending);


--
-- Name: PlaidTransaction_userId_removedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PlaidTransaction_userId_removedAt_idx" ON public."PlaidTransaction" USING btree ("userId", "removedAt");


--
-- Name: PurchaseSpend_agentId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PurchaseSpend_agentId_idx" ON public."PurchaseSpend" USING btree ("agentId");


--
-- Name: PurchaseSpend_cardId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PurchaseSpend_cardId_idx" ON public."PurchaseSpend" USING btree ("cardId");


--
-- Name: PurchaseSpend_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PurchaseSpend_createdAt_idx" ON public."PurchaseSpend" USING btree ("createdAt");


--
-- Name: PurchaseSpend_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PurchaseSpend_status_idx" ON public."PurchaseSpend" USING btree (status);


--
-- Name: PurchaseSpend_userId_fingerprint_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PurchaseSpend_userId_fingerprint_idx" ON public."PurchaseSpend" USING btree ("userId", fingerprint);


--
-- Name: PurchaseWalletFunding_agentId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PurchaseWalletFunding_agentId_idx" ON public."PurchaseWalletFunding" USING btree ("agentId");


--
-- Name: PurchaseWalletFunding_idempotencyKey_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "PurchaseWalletFunding_idempotencyKey_key" ON public."PurchaseWalletFunding" USING btree ("idempotencyKey");


--
-- Name: PurchaseWalletFunding_purchaseId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "PurchaseWalletFunding_purchaseId_key" ON public."PurchaseWalletFunding" USING btree ("purchaseId");


--
-- Name: PurchaseWalletFunding_status_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PurchaseWalletFunding_status_createdAt_idx" ON public."PurchaseWalletFunding" USING btree (status, "createdAt");


--
-- Name: PurchaseWalletFunding_userId_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PurchaseWalletFunding_userId_status_idx" ON public."PurchaseWalletFunding" USING btree ("userId", status);


--
-- Name: RoseApiKeyLog_apiKeyId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "RoseApiKeyLog_apiKeyId_idx" ON public."RoseApiKeyLog" USING btree ("apiKeyId");


--
-- Name: RoseApiKeyLog_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "RoseApiKeyLog_createdAt_idx" ON public."RoseApiKeyLog" USING btree ("createdAt");


--
-- Name: RoseApiKeyLog_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "RoseApiKeyLog_userId_idx" ON public."RoseApiKeyLog" USING btree ("userId");


--
-- Name: RoseApiKey_apiKey_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "RoseApiKey_apiKey_idx" ON public."RoseApiKey" USING btree ("apiKey");


--
-- Name: RoseApiKey_apiKey_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "RoseApiKey_apiKey_key" ON public."RoseApiKey" USING btree ("apiKey");


--
-- Name: RoseApiKey_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "RoseApiKey_userId_idx" ON public."RoseApiKey" USING btree ("userId");


--
-- Name: RoseConversationModel_conversationId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "RoseConversationModel_conversationId_idx" ON public."RoseConversationModel" USING btree ("conversationId");


--
-- Name: RoseConversationModel_conversationId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "RoseConversationModel_conversationId_key" ON public."RoseConversationModel" USING btree ("conversationId");


--
-- Name: RoseModelLatency_model_pool_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "RoseModelLatency_model_pool_key" ON public."RoseModelLatency" USING btree (model, pool);


--
-- Name: RoseModelLatency_pool_measuredAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "RoseModelLatency_pool_measuredAt_idx" ON public."RoseModelLatency" USING btree (pool, "measuredAt");


--
-- Name: SmsSession_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SmsSession_userId_idx" ON public."SmsSession" USING btree ("userId");


--
-- Name: SmsSession_userId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "SmsSession_userId_key" ON public."SmsSession" USING btree ("userId");


--
-- Name: SmsShortcode_code_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SmsShortcode_code_idx" ON public."SmsShortcode" USING btree (code);


--
-- Name: SmsShortcode_code_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "SmsShortcode_code_key" ON public."SmsShortcode" USING btree (code);


--
-- Name: SmsShortcode_expiresAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SmsShortcode_expiresAt_idx" ON public."SmsShortcode" USING btree ("expiresAt");


--
-- Name: SmsShortcode_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SmsShortcode_userId_idx" ON public."SmsShortcode" USING btree ("userId");


--
-- Name: SteelSessionAuth_userId_contextId_authRealm_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "SteelSessionAuth_userId_contextId_authRealm_key" ON public."SteelSessionAuth" USING btree ("userId", "contextId", "authRealm");


--
-- Name: Subscription_stripeSubscriptionId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Subscription_stripeSubscriptionId_idx" ON public."Subscription" USING btree ("stripeSubscriptionId");


--
-- Name: Subscription_stripeSubscriptionId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Subscription_stripeSubscriptionId_key" ON public."Subscription" USING btree ("stripeSubscriptionId");


--
-- Name: Subscription_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Subscription_userId_idx" ON public."Subscription" USING btree ("userId");


--
-- Name: Subscription_userId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Subscription_userId_key" ON public."Subscription" USING btree ("userId");


--
-- Name: ToolSideEffect_externalId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ToolSideEffect_externalId_idx" ON public."ToolSideEffect" USING btree ("externalId");


--
-- Name: ToolSideEffect_operationKey_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ToolSideEffect_operationKey_key" ON public."ToolSideEffect" USING btree ("operationKey");


--
-- Name: ToolSideEffect_operationType_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ToolSideEffect_operationType_idx" ON public."ToolSideEffect" USING btree ("operationType");


--
-- Name: ToolSideEffect_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ToolSideEffect_status_idx" ON public."ToolSideEffect" USING btree (status);


--
-- Name: ToolUsage_agentId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ToolUsage_agentId_idx" ON public."ToolUsage" USING btree ("agentId");


--
-- Name: ToolUsage_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ToolUsage_createdAt_idx" ON public."ToolUsage" USING btree ("createdAt");


--
-- Name: ToolUsage_toolName_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ToolUsage_toolName_idx" ON public."ToolUsage" USING btree ("toolName");


--
-- Name: ToolUsage_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ToolUsage_userId_idx" ON public."ToolUsage" USING btree ("userId");


--
-- Name: Tool_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Tool_name_key" ON public."Tool" USING btree (name);


--
-- Name: UserAuthAssistanceRequest_agentId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "UserAuthAssistanceRequest_agentId_idx" ON public."UserAuthAssistanceRequest" USING btree ("agentId");


--
-- Name: UserAuthAssistanceRequest_browserSessionId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "UserAuthAssistanceRequest_browserSessionId_idx" ON public."UserAuthAssistanceRequest" USING btree ("browserSessionId");


--
-- Name: UserDataDocument_userId_source_deletedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "UserDataDocument_userId_source_deletedAt_idx" ON public."UserDataDocument" USING btree ("userId", source, "deletedAt");


--
-- Name: UserDataDocument_userId_source_externalId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UserDataDocument_userId_source_externalId_key" ON public."UserDataDocument" USING btree ("userId", source, "externalId");


--
-- Name: UserDataDocument_userId_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "UserDataDocument_userId_source_idx" ON public."UserDataDocument" USING btree ("userId", source);


--
-- Name: UserDataDocument_userId_updatedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "UserDataDocument_userId_updatedAt_idx" ON public."UserDataDocument" USING btree ("userId", "updatedAt");


--
-- Name: UserDataProviderSyncState_nextSyncAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "UserDataProviderSyncState_nextSyncAt_idx" ON public."UserDataProviderSyncState" USING btree ("nextSyncAt");


--
-- Name: UserDataProviderSyncState_userId_source_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UserDataProviderSyncState_userId_source_key" ON public."UserDataProviderSyncState" USING btree ("userId", source);


--
-- Name: UserDataProviderSyncState_userId_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "UserDataProviderSyncState_userId_status_idx" ON public."UserDataProviderSyncState" USING btree ("userId", status);


--
-- Name: UserSnapshotRevision_documentId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "UserSnapshotRevision_documentId_idx" ON public."UserSnapshotRevision" USING btree ("documentId");


--
-- Name: UserSnapshotRevision_snapshotId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "UserSnapshotRevision_snapshotId_idx" ON public."UserSnapshotRevision" USING btree ("snapshotId");


--
-- Name: UserSnapshotRevision_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "UserSnapshotRevision_source_idx" ON public."UserSnapshotRevision" USING btree (source);


--
-- Name: UserSnapshotRevision_userId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "UserSnapshotRevision_userId_createdAt_idx" ON public."UserSnapshotRevision" USING btree ("userId", "createdAt");


--
-- Name: UserSnapshot_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "UserSnapshot_userId_idx" ON public."UserSnapshot" USING btree ("userId");


--
-- Name: UserSnapshot_userId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UserSnapshot_userId_key" ON public."UserSnapshot" USING btree ("userId");


--
-- Name: User_inviteCode_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "User_inviteCode_idx" ON public."User" USING btree ("inviteCode");


--
-- Name: User_inviteCode_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "User_inviteCode_key" ON public."User" USING btree ("inviteCode");


--
-- Name: User_isAnonymous_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "User_isAnonymous_idx" ON public."User" USING btree ("isAnonymous");


--
-- Name: User_usedInviteCode_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "User_usedInviteCode_idx" ON public."User" USING btree ("usedInviteCode");


--
-- Name: User_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "User_userId_idx" ON public."User" USING btree ("userId");


--
-- Name: User_userId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "User_userId_key" ON public."User" USING btree ("userId");


--
-- Name: Verifier_agentId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Verifier_agentId_key" ON public."Verifier" USING btree ("agentId");


--
-- Name: Waitlist_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Waitlist_created_at_idx" ON public."Waitlist" USING btree (created_at);


--
-- Name: Waitlist_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Waitlist_email_idx" ON public."Waitlist" USING btree (email);


--
-- Name: Waitlist_email_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Waitlist_email_key" ON public."Waitlist" USING btree (email);


--
-- Name: AgentAttentionRequest agent_attention_request_broadcast_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER agent_attention_request_broadcast_trg AFTER INSERT OR DELETE OR UPDATE ON public."AgentAttentionRequest" FOR EACH ROW EXECUTE FUNCTION public.agent_attention_request_broadcast_trigger();


--
-- Name: Agent agent_broadcast_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER agent_broadcast_trg AFTER INSERT OR DELETE OR UPDATE ON public."Agent" FOR EACH ROW EXECUTE FUNCTION public.agent_broadcast_trigger();


--
-- Name: Message message_broadcast_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER message_broadcast_trg AFTER INSERT OR DELETE OR UPDATE ON public."Message" FOR EACH ROW EXECUTE FUNCTION public.message_broadcast_trigger();


--
-- Name: AgentIdentity AgentIdentity_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentIdentity"
    ADD CONSTRAINT "AgentIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"("userId") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: AgentPhoneMessage AgentPhoneMessage_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentPhoneMessage"
    ADD CONSTRAINT "AgentPhoneMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"("userId") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: AgentTool AgentTool_agentId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentTool"
    ADD CONSTRAINT "AgentTool_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES public."Agent"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: AgentTool AgentTool_toolId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AgentTool"
    ADD CONSTRAINT "AgentTool_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES public."Tool"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Agent Agent_parentAgentId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Agent"
    ADD CONSTRAINT "Agent_parentAgentId_fkey" FOREIGN KEY ("parentAgentId") REFERENCES public."Agent"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: BrowserSession BrowserSession_contextId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BrowserSession"
    ADD CONSTRAINT "BrowserSession_contextId_fkey" FOREIGN KEY ("contextId") REFERENCES public."BrowserContext"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: CookieBundle CookieBundle_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CookieBundle"
    ADD CONSTRAINT "CookieBundle_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"("userId") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Credit Credit_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Credit"
    ADD CONSTRAINT "Credit_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"("userId") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: EmailIntegrationCredential EmailIntegrationCredential_integrationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."EmailIntegrationCredential"
    ADD CONSTRAINT "EmailIntegrationCredential_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES public."Integration"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: MessageRecord MessageRecord_personId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MessageRecord"
    ADD CONSTRAINT "MessageRecord_personId_fkey" FOREIGN KEY ("personId") REFERENCES public."Person"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Message Message_agentId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Message"
    ADD CONSTRAINT "Message_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES public."Agent"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: MintedAccount MintedAccount_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MintedAccount"
    ADD CONSTRAINT "MintedAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"("userId") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: PasskeyCredential PasskeyCredential_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PasskeyCredential"
    ADD CONSTRAINT "PasskeyCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"("userId") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: PlaidAccount PlaidAccount_plaidItemId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PlaidAccount"
    ADD CONSTRAINT "PlaidAccount_plaidItemId_fkey" FOREIGN KEY ("plaidItemId") REFERENCES public."PlaidItem"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: PlaidItem PlaidItem_integrationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PlaidItem"
    ADD CONSTRAINT "PlaidItem_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES public."Integration"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: PlaidTransaction PlaidTransaction_plaidAccountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PlaidTransaction"
    ADD CONSTRAINT "PlaidTransaction_plaidAccountId_fkey" FOREIGN KEY ("plaidAccountId") REFERENCES public."PlaidAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: PlaidTransaction PlaidTransaction_plaidItemId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PlaidTransaction"
    ADD CONSTRAINT "PlaidTransaction_plaidItemId_fkey" FOREIGN KEY ("plaidItemId") REFERENCES public."PlaidItem"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: PurchaseSpend PurchaseSpend_agentId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PurchaseSpend"
    ADD CONSTRAINT "PurchaseSpend_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES public."Agent"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: PurchaseSpend PurchaseSpend_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PurchaseSpend"
    ADD CONSTRAINT "PurchaseSpend_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"("userId") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: PurchaseWalletFunding PurchaseWalletFunding_purchaseId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PurchaseWalletFunding"
    ADD CONSTRAINT "PurchaseWalletFunding_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES public."PurchaseSpend"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: RoseApiKeyLog RoseApiKeyLog_apiKeyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."RoseApiKeyLog"
    ADD CONSTRAINT "RoseApiKeyLog_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES public."RoseApiKey"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: SteelSessionAuth SteelSessionAuth_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SteelSessionAuth"
    ADD CONSTRAINT "SteelSessionAuth_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"("userId") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Subscription Subscription_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Subscription"
    ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"("userId") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ToolUsage ToolUsage_agentId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ToolUsage"
    ADD CONSTRAINT "ToolUsage_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES public."Agent"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: UserAuthAssistanceRequest UserAuthAssistanceRequest_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserAuthAssistanceRequest"
    ADD CONSTRAINT "UserAuthAssistanceRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"("userId") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: UserDataDocument UserDataDocument_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserDataDocument"
    ADD CONSTRAINT "UserDataDocument_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"("userId") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: UserDataProviderSyncState UserDataProviderSyncState_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserDataProviderSyncState"
    ADD CONSTRAINT "UserDataProviderSyncState_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"("userId") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: UserSnapshotRevision UserSnapshotRevision_documentId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserSnapshotRevision"
    ADD CONSTRAINT "UserSnapshotRevision_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES public."UserDataDocument"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: UserSnapshotRevision UserSnapshotRevision_snapshotId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserSnapshotRevision"
    ADD CONSTRAINT "UserSnapshotRevision_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES public."UserSnapshot"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: UserSnapshotRevision UserSnapshotRevision_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserSnapshotRevision"
    ADD CONSTRAINT "UserSnapshotRevision_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"("userId") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: UserSnapshot UserSnapshot_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserSnapshot"
    ADD CONSTRAINT "UserSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"("userId") ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Verifier Verifier_agentId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Verifier"
    ADD CONSTRAINT "Verifier_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES public."Agent"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Agent; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Agent" ENABLE ROW LEVEL SECURITY;

--
-- Name: AgentAttentionRequest; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."AgentAttentionRequest" ENABLE ROW LEVEL SECURITY;

--
-- Name: AgentIdentity; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."AgentIdentity" ENABLE ROW LEVEL SECURITY;

--
-- Name: AgentRunCredentialPropagation; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."AgentRunCredentialPropagation" ENABLE ROW LEVEL SECURITY;

--
-- Name: AgentTool; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."AgentTool" ENABLE ROW LEVEL SECURITY;

--
-- Name: ModelPricingCache Anyone can read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can read" ON public."ModelPricingCache" FOR SELECT USING (true);


--
-- Name: RoseConversationModel Anyone can read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can read" ON public."RoseConversationModel" FOR SELECT USING (true);


--
-- Name: RoseModelLatency Anyone can read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can read" ON public."RoseModelLatency" FOR SELECT USING (true);


--
-- Name: Tool Anyone can view tools; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can view tools" ON public."Tool" FOR SELECT USING (true);


--
-- Name: BenchmarkRun; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."BenchmarkRun" ENABLE ROW LEVEL SECURITY;

--
-- Name: BrowserContext; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."BrowserContext" ENABLE ROW LEVEL SECURITY;

--
-- Name: BrowserPassword; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."BrowserPassword" ENABLE ROW LEVEL SECURITY;

--
-- Name: BrowserPermission; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."BrowserPermission" ENABLE ROW LEVEL SECURITY;

--
-- Name: BrowserSession; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."BrowserSession" ENABLE ROW LEVEL SECURITY;

--
-- Name: CacheStorageOrigin; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."CacheStorageOrigin" ENABLE ROW LEVEL SECURITY;

--
-- Name: ClaudeCodeSession; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ClaudeCodeSession" ENABLE ROW LEVEL SECURITY;

--
-- Name: Cookie; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Cookie" ENABLE ROW LEVEL SECURITY;

--
-- Name: CookieBundle; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."CookieBundle" ENABLE ROW LEVEL SECURITY;

--
-- Name: Credit; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Credit" ENABLE ROW LEVEL SECURITY;

--
-- Name: EmailIntegrationCredential; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."EmailIntegrationCredential" ENABLE ROW LEVEL SECURITY;

--
-- Name: Feedback; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Feedback" ENABLE ROW LEVEL SECURITY;

--
-- Name: GithubRepoAccess; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."GithubRepoAccess" ENABLE ROW LEVEL SECURITY;

--
-- Name: GoalBlueprint; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."GoalBlueprint" ENABLE ROW LEVEL SECURITY;

--
-- Name: GoalHistory; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."GoalHistory" ENABLE ROW LEVEL SECURITY;

--
-- Name: ImessageQueue; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ImessageQueue" ENABLE ROW LEVEL SECURITY;

--
-- Name: IndexedDBOrigin; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."IndexedDBOrigin" ENABLE ROW LEVEL SECURITY;

--
-- Name: Integration; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Integration" ENABLE ROW LEVEL SECURITY;

--
-- Name: LocalStorageOrigin; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."LocalStorageOrigin" ENABLE ROW LEVEL SECURITY;

--
-- Name: Message; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Message" ENABLE ROW LEVEL SECURITY;

--
-- Name: MessageRecord; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."MessageRecord" ENABLE ROW LEVEL SECURITY;

--
-- Name: MintedAccount; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."MintedAccount" ENABLE ROW LEVEL SECURITY;

--
-- Name: ModelPricingCache; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ModelPricingCache" ENABLE ROW LEVEL SECURITY;

--
-- Name: PasskeyCredential; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."PasskeyCredential" ENABLE ROW LEVEL SECURITY;

--
-- Name: PendingLocalStorageBatch; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."PendingLocalStorageBatch" ENABLE ROW LEVEL SECURITY;

--
-- Name: Person; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Person" ENABLE ROW LEVEL SECURITY;

--
-- Name: PlaidAccount; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."PlaidAccount" ENABLE ROW LEVEL SECURITY;

--
-- Name: PlaidAccount PlaidAccount_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "PlaidAccount_select_own" ON public."PlaidAccount" FOR SELECT USING (("userId" = ((current_setting('request.jwt.claims'::text, true))::json ->> 'sub'::text)));


--
-- Name: PlaidItem; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."PlaidItem" ENABLE ROW LEVEL SECURITY;

--
-- Name: PlaidItem PlaidItem_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "PlaidItem_select_own" ON public."PlaidItem" FOR SELECT USING (("userId" = ((current_setting('request.jwt.claims'::text, true))::json ->> 'sub'::text)));


--
-- Name: RoseApiKey; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."RoseApiKey" ENABLE ROW LEVEL SECURITY;

--
-- Name: RoseApiKeyLog; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."RoseApiKeyLog" ENABLE ROW LEVEL SECURITY;

--
-- Name: RoseConversationModel; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."RoseConversationModel" ENABLE ROW LEVEL SECURITY;

--
-- Name: RoseModelLatency; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."RoseModelLatency" ENABLE ROW LEVEL SECURITY;

--
-- Name: SmsSession; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."SmsSession" ENABLE ROW LEVEL SECURITY;

--
-- Name: SmsShortcode; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."SmsShortcode" ENABLE ROW LEVEL SECURITY;

--
-- Name: SteelSessionAuth; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."SteelSessionAuth" ENABLE ROW LEVEL SECURITY;

--
-- Name: Subscription; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Subscription" ENABLE ROW LEVEL SECURITY;

--
-- Name: Tool; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Tool" ENABLE ROW LEVEL SECURITY;

--
-- Name: ToolUsage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ToolUsage" ENABLE ROW LEVEL SECURITY;

--
-- Name: User; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."User" ENABLE ROW LEVEL SECURITY;

--
-- Name: UserAuthAssistanceRequest; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."UserAuthAssistanceRequest" ENABLE ROW LEVEL SECURITY;

--
-- Name: UserDataDocument; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."UserDataDocument" ENABLE ROW LEVEL SECURITY;

--
-- Name: UserDataDocument UserDataDocument_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "UserDataDocument_select_own" ON public."UserDataDocument" FOR SELECT USING (("userId" = ((current_setting('request.jwt.claims'::text, true))::json ->> 'sub'::text)));


--
-- Name: UserDataProviderSyncState; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."UserDataProviderSyncState" ENABLE ROW LEVEL SECURITY;

--
-- Name: UserDataProviderSyncState UserDataProviderSyncState_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "UserDataProviderSyncState_select_own" ON public."UserDataProviderSyncState" FOR SELECT USING (("userId" = ((current_setting('request.jwt.claims'::text, true))::json ->> 'sub'::text)));


--
-- Name: UserSnapshot; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."UserSnapshot" ENABLE ROW LEVEL SECURITY;

--
-- Name: UserSnapshotRevision; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."UserSnapshotRevision" ENABLE ROW LEVEL SECURITY;

--
-- Name: UserSnapshotRevision UserSnapshotRevision_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "UserSnapshotRevision_select_own" ON public."UserSnapshotRevision" FOR SELECT USING (("userId" = ((current_setting('request.jwt.claims'::text, true))::json ->> 'sub'::text)));


--
-- Name: UserSnapshot UserSnapshot_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "UserSnapshot_select_own" ON public."UserSnapshot" FOR SELECT USING (("userId" = ((current_setting('request.jwt.claims'::text, true))::json ->> 'sub'::text)));


--
-- Name: Agent Users can delete own agents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete own agents" ON public."Agent" FOR DELETE USING (((auth.uid())::text = "userId"));


--
-- Name: AgentAttentionRequest Users can delete own attention requests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete own attention requests" ON public."AgentAttentionRequest" FOR DELETE USING (((auth.uid())::text = "userId"));


--
-- Name: Message Users can insert messages to own agents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert messages to own agents" ON public."Message" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public."Agent"
  WHERE (("Agent".id = "Message"."agentId") AND ("Agent"."userId" = (auth.uid())::text)))));


--
-- Name: Agent Users can insert own agents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert own agents" ON public."Agent" FOR INSERT WITH CHECK (((auth.uid())::text = "userId"));


--
-- Name: AgentAttentionRequest Users can insert own attention requests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert own attention requests" ON public."AgentAttentionRequest" FOR INSERT WITH CHECK (((auth.uid())::text = "userId"));


--
-- Name: AgentIdentity Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."AgentIdentity" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: BenchmarkRun Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."BenchmarkRun" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: BrowserContext Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."BrowserContext" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: BrowserPassword Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."BrowserPassword" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: BrowserPermission Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."BrowserPermission" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: BrowserSession Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."BrowserSession" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public."BrowserContext"
  WHERE (("BrowserContext".id = "BrowserSession"."contextId") AND ("BrowserContext"."userId" = (auth.uid())::text)))));


--
-- Name: CacheStorageOrigin Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."CacheStorageOrigin" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: ClaudeCodeSession Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."ClaudeCodeSession" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public."Agent"
  WHERE (("Agent".id = "ClaudeCodeSession"."agentId") AND ("Agent"."userId" = (auth.uid())::text)))));


--
-- Name: Cookie Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."Cookie" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: CookieBundle Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."CookieBundle" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: Credit Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."Credit" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: EmailIntegrationCredential Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."EmailIntegrationCredential" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: Feedback Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."Feedback" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: GithubRepoAccess Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."GithubRepoAccess" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: GoalBlueprint Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."GoalBlueprint" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: GoalHistory Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."GoalHistory" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: ImessageQueue Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."ImessageQueue" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: IndexedDBOrigin Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."IndexedDBOrigin" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: Integration Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."Integration" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: LocalStorageOrigin Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."LocalStorageOrigin" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: MessageRecord Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."MessageRecord" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public."Person"
  WHERE (("Person".id = "MessageRecord"."personId") AND ("Person"."userId" = (auth.uid())::text)))));


--
-- Name: MintedAccount Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."MintedAccount" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: PasskeyCredential Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."PasskeyCredential" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: PendingLocalStorageBatch Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."PendingLocalStorageBatch" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: Person Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."Person" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: RoseApiKey Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."RoseApiKey" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: RoseApiKeyLog Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."RoseApiKeyLog" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: SmsSession Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."SmsSession" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: SmsShortcode Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."SmsShortcode" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: SteelSessionAuth Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."SteelSessionAuth" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: Subscription Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."Subscription" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: ToolUsage Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."ToolUsage" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: User Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."User" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: UserAuthAssistanceRequest Users can select own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can select own data" ON public."UserAuthAssistanceRequest" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: Agent Users can update own agents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own agents" ON public."Agent" FOR UPDATE USING (((auth.uid())::text = "userId")) WITH CHECK (((auth.uid())::text = "userId"));


--
-- Name: AgentAttentionRequest Users can update own attention requests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own attention requests" ON public."AgentAttentionRequest" FOR UPDATE USING (((auth.uid())::text = "userId")) WITH CHECK (((auth.uid())::text = "userId"));


--
-- Name: Message Users can view own agent messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own agent messages" ON public."Message" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public."Agent"
  WHERE (("Agent".id = "Message"."agentId") AND ("Agent"."userId" = (auth.uid())::text)))));


--
-- Name: AgentTool Users can view own agent tools; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own agent tools" ON public."AgentTool" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public."Agent"
  WHERE (("Agent".id = "AgentTool"."agentId") AND ("Agent"."userId" = (auth.uid())::text)))));


--
-- Name: Verifier Users can view own agent verifiers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own agent verifiers" ON public."Verifier" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public."Agent"
  WHERE (("Agent".id = "Verifier"."agentId") AND ("Agent"."userId" = (auth.uid())::text)))));


--
-- Name: Agent Users can view own agents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own agents" ON public."Agent" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: AgentAttentionRequest Users can view own attention requests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own attention requests" ON public."AgentAttentionRequest" FOR SELECT USING (((auth.uid())::text = "userId"));


--
-- Name: Verifier; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Verifier" ENABLE ROW LEVEL SECURITY;

--
-- Name: Waitlist; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Waitlist" ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--


