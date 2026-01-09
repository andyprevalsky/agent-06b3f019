"""Configuration management for Temporal agents.

IMPORTANT: This module must NOT have side effects at import time.
load_dotenv() is called lazily on first load_config() call, not at import.
This allows the module to be safely imported in Temporal workflow context.
"""

import os
from typing import Optional
from dataclasses import dataclass

# Lazy initialization - NO side effects at import time
_dotenv_loaded = False


def _ensure_dotenv_loaded():
    """Load .env file lazily on first call. Safe to call multiple times."""
    global _dotenv_loaded
    if not _dotenv_loaded:
        from dotenv import load_dotenv
        load_dotenv()
        _dotenv_loaded = True


@dataclass
class TemporalConfig:
    """Temporal Cloud connection configuration."""
    
    api_key: str
    namespace: str
    address: str
    task_queue: str
    
    # Worker concurrency settings
    max_concurrent_activities: int = 50  # Reduced to prevent DB connection exhaustion
    max_concurrent_workflows: int = 50   # Max concurrent agents (aligned with activities)
    max_cached_workflows: int = 100      # Reduced to match workflow count
    max_concurrent_activity_task_pollers: int = 2
    max_concurrent_workflow_task_pollers: int = 2
    
    # Timeout settings (in seconds)
    activity_start_to_close_timeout: int = 300
    activity_schedule_to_close_timeout: int = 600
    activity_heartbeat_timeout: int = 30
    workflow_task_timeout: int = 10
    
    # Retry settings - EXTREME BACKOFF
    activity_max_attempts: int = 6
    activity_retry_backoff_coefficient: float = 4.0
    activity_retry_initial_interval: int = 2
    activity_retry_max_interval: int = 64


@dataclass
class BackendConfig:
    """Backend API configuration."""
    
    api_url: str
    api_key: Optional[str] = None


@dataclass
class OpenRouterConfig:
    """OpenRouter configuration."""
    
    api_key: str
    base_url: str = "https://openrouter.ai/api/v1"
    model: str = "openai/gpt-4-turbo-preview"


@dataclass
class OpenAIConfig:
    """OpenAI configuration for web search."""
    
    api_key: str
    model: str = "gpt-4.1"  # GPT-4.1 with web search capability


@dataclass
class PerplexityConfig:
    """Perplexity configuration for deep research."""
    
    api_key: str
    model: str = "sonar-deep-research"


@dataclass
class GeminiConfig:
    """Google Gemini configuration."""
    
    api_key: str


@dataclass
class BrowserbaseConfig:
    """Browserbase configuration for browser automation."""
    
    api_key: str
    project_id: str


@dataclass
class ParallelConfig:
    """Parallel AI configuration for Find All, Enrich, and Monitor APIs."""
    
    api_key: str


@dataclass
class RoseConfig:
    """Rose API configuration for routing Rose models to Supabase edge function."""
    
    api_url: str = "https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions"
    api_key: str = ""  # Rose API key (x-api-key header)
    supabase_anon_key: str = ""  # Supabase anon key (Authorization header)


@dataclass
class SupabaseConfig:
    """Supabase configuration for direct Realtime broadcasts."""
    
    url: str = "https://kzlurqihzaolhzsbkctf.supabase.co"
    anon_key: str = ""  # Supabase anon key for Realtime
    service_role_key: str = ""  # Supabase service role key (can broadcast to private channels)


@dataclass
class PaymentConfig:
    """Payment decryption configuration for agent autopay."""
    
    decryption_key: str = ""  # Base64-encoded RSA private key for decrypting payment info


@dataclass
class X402Config:
    """x402 protocol configuration for paid API services."""
    
    receiving_wallet: str = ""  # Wallet address for receiving x402 payments (also used as buyer)
    wallet_secret: str = ""  # CDP wallet secret (PKCS#8 DER format, base64-encoded)


@dataclass
class CursorConfig:
    """Cursor Cloud Agent API configuration."""
    
    api_key: str = ""  # Cursor API key for spawning cloud agents
    base_url: str = "https://api.cursor.com/v1"


@dataclass
class VercelConfig:
    """Vercel API configuration for preview deployments."""

    token: str = ""  # Vercel API token for creating projects and fetching deployments
    team_id: Optional[str] = None  # Optional team ID for team-owned projects


@dataclass
class E2BConfig:
    """E2B sandbox configuration for Claude Code."""

    api_key: str = ""  # E2B API key
    template_id: str = ""  # Custom template with Claude Code pre-installed
    default_timeout: int = 600  # 10 minutes


@dataclass
class AnthropicConfig:
    """Anthropic API configuration for Claude Code in E2B sandboxes."""

    api_key: str = ""  # Rose's Anthropic API key (never exposed to users)


@dataclass
class AppConfig:
    """Complete application configuration."""
    
    temporal: TemporalConfig
    backend: BackendConfig
    openrouter: OpenRouterConfig
    openai: OpenAIConfig
    perplexity: PerplexityConfig
    gemini: GeminiConfig
    browserbase: BrowserbaseConfig
    parallel: ParallelConfig
    rose: RoseConfig
    supabase: SupabaseConfig
    payment: PaymentConfig
    x402: X402Config
    cursor: CursorConfig
    vercel: VercelConfig
    e2b: E2BConfig
    anthropic: AnthropicConfig

    health_check_port: int = 3000
    log_level: str = "INFO"
    environment: str = "production"


def load_config() -> AppConfig:
    """Load configuration from environment variables.
    
    Ensures .env file is loaded on first call (lazy initialization).
    Safe to call from both workflow and activity contexts.
    """
    _ensure_dotenv_loaded()
    
    temporal = TemporalConfig(
        api_key=os.environ["TEMPORAL_API_KEY"],
        namespace=os.environ["TEMPORAL_NAMESPACE"],
        address=os.environ["TEMPORAL_ADDRESS"],
        task_queue=os.getenv("TEMPORAL_TASK_QUEUE", "navi-agent-tasks"),
        max_concurrent_activities=int(os.getenv("MAX_CONCURRENT_ACTIVITIES", "50")),
        max_concurrent_workflows=int(os.getenv("MAX_CONCURRENT_WORKFLOWS", "50")),
        max_cached_workflows=int(os.getenv("MAX_CACHED_WORKFLOWS", "100")),
        max_concurrent_activity_task_pollers=int(os.getenv("MAX_CONCURRENT_ACTIVITY_TASK_POLLERS", "2")),
        max_concurrent_workflow_task_pollers=int(os.getenv("MAX_CONCURRENT_WORKFLOW_TASK_POLLERS", "2")),
        activity_start_to_close_timeout=int(os.getenv("ACTIVITY_START_TO_CLOSE_TIMEOUT", "300")),
        activity_schedule_to_close_timeout=int(os.getenv("ACTIVITY_SCHEDULE_TO_CLOSE_TIMEOUT", "600")),
        activity_heartbeat_timeout=int(os.getenv("ACTIVITY_HEARTBEAT_TIMEOUT", "30")),
        workflow_task_timeout=int(os.getenv("WORKFLOW_TASK_TIMEOUT", "10")),
        activity_max_attempts=int(os.getenv("ACTIVITY_MAX_ATTEMPTS", "6")),
        activity_retry_backoff_coefficient=float(os.getenv("ACTIVITY_RETRY_BACKOFF_COEFFICIENT", "4.0")),
        activity_retry_initial_interval=int(os.getenv("ACTIVITY_RETRY_INITIAL_INTERVAL", "2")),
        activity_retry_max_interval=int(os.getenv("ACTIVITY_RETRY_MAX_INTERVAL", "64")),
    )
    
    # Normalize URL - strip trailing slash to prevent double slashes
    backend_url = os.getenv("BACKEND_API_URL", "https://navi-j9a9.onrender.com")
    backend_url = backend_url.rstrip('/') if backend_url else "https://navi-j9a9.onrender.com"
    
    backend = BackendConfig(
        api_url=backend_url,
        api_key=os.getenv("BACKEND_API_KEY"),
    )
    
    openrouter = OpenRouterConfig(
        api_key=os.environ["OPENROUTER_API_KEY"],
        base_url=os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
        model=os.getenv("OPENROUTER_MODEL", "openai/gpt-4-turbo-preview"),
    )
    
    openai = OpenAIConfig(
        api_key=os.environ["OPENAI_API_KEY"],
        model=os.getenv("OPENAI_MODEL", "gpt-4.1"),
    )
    
    perplexity = PerplexityConfig(
        api_key=os.environ["PERPLEXITY_API_KEY"],
        model=os.getenv("PERPLEXITY_MODEL", "sonar-deep-research"),
    )
    
    gemini = GeminiConfig(
        api_key=os.environ["GEMINI_API_KEY"],
    )
    
    browserbase = BrowserbaseConfig(
        api_key=os.environ["BROWSERBASE_API_KEY"],
        project_id=os.environ["BROWSERBASE_PROJECT_ID"],
    )
    
    parallel = ParallelConfig(
        api_key=os.environ["PARRALLEL_API_KEY"],
    )
    
    rose = RoseConfig(
        api_url=os.getenv("ROSE_API_URL", "https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions"),
        api_key=os.getenv("ROSE_API_KEY", ""),
        supabase_anon_key=os.getenv("SUPABASE_ANON_KEY", ""),
    )
    
    supabase = SupabaseConfig(
        url=os.getenv("SUPABASE_URL", "https://kzlurqihzaolhzsbkctf.supabase.co"),
        anon_key=os.getenv("SUPABASE_ANON_KEY", ""),
        service_role_key=os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""),
    )
    
    payment = PaymentConfig(
        decryption_key=os.getenv("PAYMENT_DECRYPTION_KEY", ""),
    )
    
    x402 = X402Config(
        receiving_wallet=os.getenv("X402_RECEIVING_WALLET", ""),
        wallet_secret=os.getenv("CDP_WALLET_SECRET", ""),
    )
    
    cursor = CursorConfig(
        api_key=os.getenv("CURSOR_API_KEY", ""),
        base_url=os.getenv("CURSOR_API_BASE_URL", "https://api.cursor.com/v1"),
    )
    
    vercel = VercelConfig(
        token=os.getenv("VERCEL_TOKEN", ""),
        team_id=os.getenv("VERCEL_TEAM_ID"),
    )

    e2b = E2BConfig(
        api_key=os.getenv("E2B_API_KEY", ""),
        template_id=os.getenv("E2B_CLAUDE_CODE_TEMPLATE_ID", ""),
        default_timeout=int(os.getenv("E2B_TIMEOUT", "600")),
    )

    anthropic = AnthropicConfig(
        api_key=os.getenv("ANTHROPIC_API_KEY", ""),  # For Claude Code in E2B
    )

    return AppConfig(
        temporal=temporal,
        backend=backend,
        openrouter=openrouter,
        openai=openai,
        perplexity=perplexity,
        gemini=gemini,
        browserbase=browserbase,
        parallel=parallel,
        rose=rose,
        supabase=supabase,
        payment=payment,
        x402=x402,
        cursor=cursor,
        vercel=vercel,
        e2b=e2b,
        anthropic=anthropic,
        health_check_port=int(os.getenv("HEALTH_CHECK_PORT", "8082")),
        log_level=os.getenv("LOG_LEVEL", "INFO"),
        environment=os.getenv("ENVIRONMENT", "production"),
    )

