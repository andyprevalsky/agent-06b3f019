"""param_populator domain — constants and configuration."""

# Model used for parameter population (cheap one-shot call)
PARAM_POPULATOR_MODEL = "rose-labs/rose-1-lite"

# LLM generation settings
TEMPERATURE = 0.38
MAX_TOKENS = 4096
REASONING_MAX_TOKENS = 2048

# Call-site identifier for telemetry / cost tracking
CALL_SITE = "dag_param_populator"
