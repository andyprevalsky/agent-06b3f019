"""param_populator domain — constants and configuration."""

# Always ultra. Lite/sonnet-5 systematically emits one spawn per sibling DAG
# node even when told "exactly one tool"; ultra/fable follows the contract.
# Keep in sync with providers.rose.pools.PARAM_POPULATOR_MODEL and
# back-end/src/providers/rose/pools.ts.
PARAM_POPULATOR_MODEL = "rose-labs/rose-1-ultra"

# LLM generation settings
TEMPERATURE = 0.38
MAX_TOKENS = 4096
REASONING_MAX_TOKENS = 2048

# Call-site identifier for telemetry / cost tracking
CALL_SITE = "dag_param_populator"
