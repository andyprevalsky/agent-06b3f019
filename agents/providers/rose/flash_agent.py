"""Flash root/explore policy, deliberately separate from chat and browser pools."""

from dataclasses import replace

from providers.rose.pools import PoolSpec, get_pool

FLASH_AGENT_CALL_SITES = frozenset({"plan_loop", "execute_loop", "explore_agent"})


def is_flash_agent_call(pool: str, call_site: str) -> bool:
    return pool == "rose-1-flash" and call_site in FLASH_AGENT_CALL_SITES


def pool_for_call(pool: str, call_site: str) -> PoolSpec:
    spec = get_pool(pool)
    if not is_flash_agent_call(pool, call_site):
        return spec
    return replace(
        spec,
        gpt_auth_model="gpt-6.1-terra",
        subscription_auth_enabled=True,
        direct_auth_enabled=False,
    )
