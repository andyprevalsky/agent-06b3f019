"""Configuration management for Temporal agents."""

import os
from typing import Optional
from dataclasses import dataclass
from dotenv import load_dotenv

load_dotenv()


@dataclass
class TemporalConfig:
    """Temporal Cloud connection configuration."""
    
    api_key: str
    namespace: str
    address: str
    task_queue: str
    
    # Worker concurrency settings
    max_concurrent_activities: int = 500
    max_concurrent_workflows: int = 200 # max concurrent agents
    max_cached_workflows: int = 1000
    max_concurrent_activity_task_pollers: int = 5
    max_concurrent_workflow_task_pollers: int = 5
    
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
class TwilioConfig:
    """Twilio configuration for SMS (optional - only needed if using SMS tool)."""
    
    account_sid: Optional[str] = None
    auth_token: Optional[str] = None
    phone_number: Optional[str] = None


@dataclass
class SearchConfig:
    """Web search configuration."""
    
    serper_api_key: str  # Required - using Serper API


@dataclass
class AppConfig:
    """Complete application configuration."""
    
    temporal: TemporalConfig
    backend: BackendConfig
    openrouter: OpenRouterConfig
    twilio: TwilioConfig
    search: SearchConfig
    
    health_check_port: int = 3000
    log_level: str = "INFO"
    environment: str = "production"


def load_config() -> AppConfig:
    """Load configuration from environment variables."""
    
    temporal = TemporalConfig(
        api_key=os.environ["TEMPORAL_API_KEY"],
        namespace=os.environ["TEMPORAL_NAMESPACE"],
        address=os.environ["TEMPORAL_ADDRESS"],
        task_queue=os.getenv("TEMPORAL_TASK_QUEUE", "navi-agent-tasks"),
        max_concurrent_activities=int(os.getenv("MAX_CONCURRENT_ACTIVITIES", "500")),
        max_concurrent_workflows=int(os.getenv("MAX_CONCURRENT_WORKFLOWS", "200")),
        max_cached_workflows=int(os.getenv("MAX_CACHED_WORKFLOWS", "1000")),
        max_concurrent_activity_task_pollers=int(os.getenv("MAX_CONCURRENT_ACTIVITY_TASK_POLLERS", "5")),
        max_concurrent_workflow_task_pollers=int(os.getenv("MAX_CONCURRENT_WORKFLOW_TASK_POLLERS", "5")),
        activity_start_to_close_timeout=int(os.getenv("ACTIVITY_START_TO_CLOSE_TIMEOUT", "300")),
        activity_schedule_to_close_timeout=int(os.getenv("ACTIVITY_SCHEDULE_TO_CLOSE_TIMEOUT", "600")),
        activity_heartbeat_timeout=int(os.getenv("ACTIVITY_HEARTBEAT_TIMEOUT", "30")),
        workflow_task_timeout=int(os.getenv("WORKFLOW_TASK_TIMEOUT", "10")),
        activity_max_attempts=int(os.getenv("ACTIVITY_MAX_ATTEMPTS", "6")),
        activity_retry_backoff_coefficient=float(os.getenv("ACTIVITY_RETRY_BACKOFF_COEFFICIENT", "4.0")),
        activity_retry_initial_interval=int(os.getenv("ACTIVITY_RETRY_INITIAL_INTERVAL", "2")),
        activity_retry_max_interval=int(os.getenv("ACTIVITY_RETRY_MAX_INTERVAL", "64")),
    )
    
    backend = BackendConfig(
        api_url=os.getenv("BACKEND_API_URL", "https://navi-j9a9.onrender.com"),
        api_key=os.getenv("BACKEND_API_KEY"),
    )
    
    openrouter = OpenRouterConfig(
        api_key=os.environ["OPENROUTER_API_KEY"],
        base_url=os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
        model=os.getenv("OPENROUTER_MODEL", "openai/gpt-4-turbo-preview"),
    )
    
    twilio = TwilioConfig(
        account_sid=os.getenv("TWILIO_ACCOUNT_SID"),
        auth_token=os.getenv("TWILIO_AUTH_TOKEN"),
        phone_number=os.getenv("TWILIO_PHONE_NUMBER"),
    )
    
    search = SearchConfig(
        serper_api_key=os.environ["SERPER_API_KEY"],
    )
    
    return AppConfig(
        temporal=temporal,
        backend=backend,
        openrouter=openrouter,
        twilio=twilio,
        search=search,
        health_check_port=int(os.getenv("HEALTH_CHECK_PORT", "8080")),
        log_level=os.getenv("LOG_LEVEL", "INFO"),
        environment=os.getenv("ENVIRONMENT", "production"),
    )

