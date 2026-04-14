"""Constants and defaults for the deep-research domain."""

# Perplexity model
PERPLEXITY_MODEL = "sonar-deep-research"
PERPLEXITY_BASE_URL = "https://api.perplexity.ai"

# Research defaults
DEFAULT_MAX_TOKENS = 8000
DEFAULT_TEMPERATURE = 0.2  # Low temperature for factual research

# System prompt for the research model
RESEARCH_SYSTEM_PROMPT = (
    "You are a thorough research assistant. Conduct comprehensive, multi-step research "
    "on the topic. Evaluate sources critically, synthesize findings, and provide "
    "well-cited reports with clear structure and evidence. Always include citations "
    "and sources in your response. Format your response with markdown."
)

# Perplexity pricing (cents per million tokens, except search)
PRICE_INPUT_TOKENS_PER_MILLION = 200  # $2 per million
PRICE_OUTPUT_TOKENS_PER_MILLION = 800  # $8 per million
PRICE_CITATION_TOKENS_PER_MILLION = 200  # $2 per million
PRICE_REASONING_TOKENS_PER_MILLION = 300  # $3 per million
PRICE_SEARCH_CENTS_PER_THOUSAND = 5  # $5 per 1,000 = 0.5 cents per search
