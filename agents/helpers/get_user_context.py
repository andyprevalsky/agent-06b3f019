"""Helper for fetching and formatting user context for agent system prompts."""

import asyncio
import json
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

import httpx
import structlog
from temporalio import activity

from config import load_config
from helpers.user_profile import build_user_profile_sections

logger = structlog.get_logger()

# Cache stable, non-profile context only. Personal data is intentionally fetched
# for every agent start so a saved identity correction is visible immediately.
_user_context_cache: Dict[str, Dict[str, Any]] = {}
CACHE_TTL_MINUTES = 5
PROFILE_REFRESH_TIMEOUT_SECONDS = 2.0

# ============================================================================
# Cookie Auth Detection Constants
# ============================================================================

# Known ad/tracking domains to exclude
AD_TRACKING_DOMAINS = {
    "doubleclick.net",
    "adnxs.com",
    "pubmatic.com",
    "rubiconproject.com",
    "criteo.com",
    "taboola.com",
    "outbrain.com",
    "googlesyndication.com",
    "googleadservices.com",
    "amazon-adsystem.com",
    "adsrvr.org",
    "casalemedia.com",
    "openx.net",
    "contextweb.com",
    "adroll.com",
    "media.net",
    "yieldmo.com",
    "sharethrough.com",
    "triplelift.com",
    "scorecardresearch.com",
    "quantserve.com",
    "demdex.net",
    "bluekai.com",
    "360yield.com",
    "adition.com",
    "adgrx.com",
    "adtdp.com",
    "adtonos.com",
    "advertserve.com",
    "advolve.io",
    "appier.net",
    "applovin.com",
    "clearnview.com",
    "company-target.com",
    "connatix.com",
    "cpmstar.com",
    "deepintent.com",
    "dotomi.com",
    "driftpixel.live",
    "emxdgt.com",
    "eqads.com",
    "extremereach.io",
    "feedad.com",
    "forter.com",
    "idmap.ai",
    "infolinks.com",
    "kargo.com",
    "knotch.it",
    "loopme.me",
    "lunamedia.live",
    "marphezis.com",
    "measureadv.com",
    "mediarithmics.com",
    "mediawallahscript.com",
    "minutemedia-prebid.com",
    "missena.io",
    "mookie1.com",
    "newsroom.bi",
    "omnifytv.live",
    "omtrdc.net",
    "openwebmp.com",
    "pmbmonetize.live",
    "presage.io",
    "prmutv.co",
    "rbstsystems.live",
    "richaudience.com",
    "seedtag.com",
    "smilewanted.com",
    "stackadapt.com",
    "tappx.com",
    "tradehouse.media",
    "unrulymedia.com",
    "usbrowserspeed.com",
    "vrtcal.com",
    "yellowblue.io",
    "ymmobi.com",
    "yotpo.com",
    "a-mo.net",
    "a-mx.com",
    "amxrtb.com",
    "rtb.mx",
    "sptag2.com",
    "ad-stir.com",
    "1rx.io",
    "pxf.io",
    "sjv.io",
    "ztk5.net",
    "7zd4df.net",
    "alcmpn.com",
    "cdn-net.com",
    "iesnare.com",
    "online-metrix.net",
    "earlywarning.io",
    "signifyd.com",
    "ebay-us.com",
    "apata.io",
    "finicity.com",
    "mmapiws.com",
    "rezync.com",
    "rkdms.com",
    "livechatinc.com",
    "messagebird.com",
    "clarity.ms",
    "recaptcha.net",
    "optimizely.com",
    "disqus.com",
    "06yahoo.com",
    "66yahoo.com",
    "yahoodns.net",
    "ymail.com",
    "zenfs.com",
    "yusercontent.com",
    "co.jp",
    "com.ec",
    "mail.ru",
    "healthroundprince.com",
    "mcangelus.com",
    "powerrobotflower.com",
    "sonobi.com",
    "smaato.net",
    "intentiq.com",
    "sparteo.com",
    "trustedstack.com",
    "3lift.com",
    "aniview.com",
    "bricks-co.com",
    "insightexpressai.com",
    "technoratimedia.com",
    "nextmillmedia.com",
    "bfmio.com",
    "tremorhub.com",
    "bliink.io",
    "fwmrm.net",
    "smartadserver.com",
    "userreport.com",
    "iqm.com",
    "acuityplatform.com",
    "w55c.net",
    "bidmatic.io",
    "stickyadstv.com",
    "adtelligent.com",
    "optidigital.com",
    "sportradarserving.com",
    "yieldoptimizer.com",
    "betweendigital.com",
    "btloader.com",
    "creativecdn.com",
    "admaster.cc",
    "adscale.de",
    "crwdcntrl.net",
    "datasteam.io",
    "lemmadigital.com",
    "liadm.com",
    "lijit.com",
    "media6degrees.com",
    "mfadsrvr.com",
    "pippio.com",
    "sojern.com",
    "xplosion.de",
    "admanmedia.com",
    "adotmob.com",
    "bidswitch.net",
    "bluecava.com",
    "creative-serving.com",
    "ctnsnet.com",
    "e-volution.ai",
    "impact-ad.jp",
    "liftdsp.com",
    "nhnace.com",
    "otm-r.com",
    "postrelease.com",
    "rfihub.com",
    "sitescout.com",
    "smartclip.net",
    "spotim.market",
    "tapad.com",
    "turn.com",
    "udmserve.net",
    "undertone.com",
    "viewdeos.com",
    "sitelytics.tech",
    "nytrng.com",
    "nytb.org",
    "inmobi.com",
    "goldprice.org",
}

# Cookies that are NEVER auth (false positive triggers)
ALWAYS_FALSE_POSITIVE_COOKIES = [
    "cf_clearance",  # Cloudflare captcha
    "_ga",
    "_gid",
    "_gcl",  # Google Analytics
    "_fbp",
    "_fbc",  # Facebook pixel
    "mp_",  # Mixpanel (starts with)
    "_hp5_",  # Heap analytics
    "_hjSession",  # Hotjar
    "OptanonConsent",
    "OptanonAlertBoxClosed",  # Cookie consent
    "_pin_unauth",  # Pinterest unauth
    "intercom-",  # Intercom (not auth)
    "__stripe_mid",  # Stripe tracking (not auth)
    "_rdt_uuid",  # Reddit pixel
    "_tt_enable_cookie",
    "_ttp",  # TikTok pixel
    "_uetvid",  # Microsoft ads
    "hubspotutk",
    "__hstc",  # HubSpot tracking
    "__kla_id",  # Klaviyo
    "ajs_anonymous_id",  # Segment anonymous
    "ph_phc_",  # PostHog
    "_clck",
    "_clsk",  # Clarity
    "_scid",
    "_sctr",  # Snapchat pixel
    "FPID",
    "FPAU",  # First party tracking
    "_derived_epik",  # Pinterest
    "_zitok",  # Generic tracking
    "receive-cookie-deprecation",  # Chrome deprecation test
]

# Auth patterns to match in cookie names
AUTH_PATTERNS = [
    "session",
    "sess",
    "auth",
    "token",
    "login",
    "logged",
    "user",
    "usr",
    "sso",
    "jwt",
    "bearer",
    "access",
    "refresh",
    "credential",
    "identity",
    "account",
    "member",
    "subscriber",
]

# Adult site keywords to filter
ADULT_KEYWORDS = ["xxx", "porn", "adult", "sex", "xvideos", "xhamster"]


# ============================================================================
# Cookie Processing Functions
# ============================================================================


def _normalize_domain(host_key: str) -> str:
    """Normalize a cookie host_key to a clean domain."""
    domain = host_key.lstrip(".")
    if domain.startswith("www."):
        domain = domain[4:]
    return domain


def _get_base_domain(domain: str) -> str:
    """Extract base domain (e.g., 'mail.google.com' -> 'google.com')."""
    parts = domain.split(".")
    if len(parts) >= 2:
        return ".".join(parts[-2:])
    return domain


def _is_false_positive_cookie(name: str) -> bool:
    """Check if cookie name is a known false positive."""
    name_lower = name.lower()
    return any(fp.lower() in name_lower for fp in ALWAYS_FALSE_POSITIVE_COOKIES)


def _is_auth_cookie(cookie: dict) -> bool:
    """Check if a cookie looks like an auth/session cookie."""
    name = cookie.get("name", "")
    name_lower = name.lower()

    if _is_false_positive_cookie(name):
        return False

    return any(pattern in name_lower for pattern in AUTH_PATTERNS)


# ============================================================================
# Backend API Calls
# ============================================================================


async def _fetch_integrations_and_auth_domains(
    client: httpx.AsyncClient, config, user_id: str
) -> tuple[List[dict], List[str]]:
    """Fetch user's integrations and authenticated domains from backend."""
    try:
        response = await client.get(
            f"{config.backend.api_url}/api/integrations",
            headers={
                "X-API-Key": config.backend.api_key or "",
                "X-User-Id": user_id,
            },
            timeout=30.0,
        )
        response.raise_for_status()
        data = response.json()
        integrations = data.get("integrations", [])
        authenticated_domains = data.get("authenticatedDomains", [])
        return integrations, authenticated_domains
    except Exception as e:
        logger.warning("Failed to fetch integrations", user_id=user_id, error=str(e))
        return [], []


async def _fetch_user_settings(client: httpx.AsyncClient, config, user_id: str) -> dict:
    """Fetch user profile settings from backend."""
    user_settings, _ = await _fetch_user_settings_with_status(client, config, user_id)
    return user_settings


async def _fetch_user_settings_with_status(client: httpx.AsyncClient, config, user_id: str) -> tuple[dict, bool]:
    """Fetch user profile settings and report whether the read succeeded."""
    try:
        response = await client.get(
            f"{config.backend.api_url}/api/user-settings",
            headers={
                "X-API-Key": config.backend.api_key or "",
                "X-User-Id": user_id,
            },
            timeout=30.0,
        )
        response.raise_for_status()
        # Eligibility piggybacks on this existing server-owned profile read.
        # Off/noneligible profiles omit the marker; never discover phone here.
        return response.json(), True
    except Exception as e:
        logger.warning("Failed to fetch user settings", user_id=user_id, error=str(e))
        return {}, False


RECENT_MESSAGES_CONTEXT_LIMIT = 20


async def _fetch_recent_messages(
    client: httpx.AsyncClient, config, user_id: str, limit: int = RECENT_MESSAGES_CONTEXT_LIMIT
) -> List[dict]:
    """Fetch recent messages from backend."""
    try:
        response = await client.get(
            f"{config.backend.api_url}/api/people/messages/recent",
            params={"limit": limit},
            headers={
                "X-API-Key": config.backend.api_key or "",
                "X-User-Id": user_id,
            },
            timeout=30.0,
        )
        response.raise_for_status()
        data = response.json()
        return data.get("messages", [])
    except Exception as e:
        logger.warning("Failed to fetch recent messages", user_id=user_id, error=str(e))
        return []


NETWORK_CONTEXT_LIMIT = 100


async def _fetch_top_contacts(
    client: httpx.AsyncClient, config, user_id: str, limit: int = NETWORK_CONTEXT_LIMIT
) -> List[dict]:
    """Fetch top contacts sorted by message count (tiebreak: most recent message)."""
    try:
        response = await client.get(
            f"{config.backend.api_url}/api/people",
            params={"limit": limit},
            headers={
                "X-API-Key": config.backend.api_key or "",
                "X-User-Id": user_id,
            },
            timeout=30.0,
        )
        response.raise_for_status()
        data = response.json()
        return data.get("people", [])
    except Exception as e:
        logger.warning("Failed to fetch top contacts", user_id=user_id, error=str(e))
        return []


async def _fetch_user_snapshot(client: httpx.AsyncClient, config, user_id: str) -> dict:
    """Fetch the current distilled user snapshot from backend."""
    try:
        response = await client.get(
            f"{config.backend.api_url}/api/data/snapshot",
            headers={
                "X-API-Key": config.backend.api_key or "",
                "X-User-Id": user_id,
            },
            timeout=30.0,
        )
        response.raise_for_status()
        return response.json().get("snapshot") or {}
    except Exception as e:
        logger.warning("Failed to fetch user snapshot", user_id=user_id, error=str(e))
        return {}


async def _fetch_messages_for_simulation(client: httpx.AsyncClient, config, user_id: str, days: int = 7) -> List[dict]:
    """
    Fetch user's messages from the past N days for user simulation.

    This fetches a larger sample of messages to understand the user's
    communication style, vocabulary, and response patterns.

    Args:
        client: HTTP client
        config: App config
        user_id: User ID
        days: Number of days to look back (default 7)

    Returns:
        List of message dicts with channel, from, to, message, timestamp
    """
    try:
        # Fetch messages with days parameter for extended history
        response = await client.get(
            f"{config.backend.api_url}/api/people/messages/recent",
            params={"limit": 500, "days": days},  # Request 7 days of messages
            headers={
                "X-API-Key": config.backend.api_key or "",
                "X-User-Id": user_id,
            },
            timeout=30.0,
        )
        response.raise_for_status()
        data = response.json()
        return data.get("messages", [])
    except Exception as e:
        logger.warning("Failed to fetch messages for simulation", user_id=user_id, days=days, error=str(e))
        return []


# ============================================================================
# Formatting Functions
# ============================================================================


def _format_user_context(
    authenticated_sites: List[str],
    user_settings: dict,
    recent_messages: List[dict],
    frequent_contacts: List[dict],
    integrations: Optional[List[dict]] = None,
    user_snapshot: Optional[dict] = None,
) -> str:
    """Format the user context string for the system prompt."""
    sections = []

    # Section: Connected Integrations (Gmail, etc.)
    if integrations:
        integration_lines = []
        for integ in integrations:
            status = integ.get("status", "")
            name = integ.get("name", "")
            creds = integ.get("emailCredentials")
            if not isinstance(creds, list):
                creds = []
            emails: List[str] = []
            for credential in creds:
                email = credential.get("email") if isinstance(credential, dict) else None
                if isinstance(email, str) and email:
                    emails.append(email)
            # Prefer credential rows; fall back to the denormalized config copy
            # that withDerivedConnectedEmails writes for the UI. Without this,
            # a SYNC_FAILED Gmail row whose nested credentials were stripped
            # from the payload disappears from the prompt even though
            # config.connectedEmails still lists usable send-from addresses.
            if not emails:
                config = integ.get("config") if isinstance(integ.get("config"), dict) else {}
                connected = config.get("connectedEmails") if isinstance(config, dict) else None
                if isinstance(connected, list):
                    emails = [e for e in connected if isinstance(e, str) and e]
                primary = config.get("connectedEmail") if isinstance(config, dict) else None
                if isinstance(primary, str) and primary and primary not in emails:
                    emails.insert(0, primary)
            # Gmail is connected only for the inboxes the runtime can read; an
            # inbox that needs reconnecting is not an available integration.
            readable = integ.get("readableInboxEmails")
            if name.lower() == "gmail" and isinstance(readable, list):
                emails = [email for email in readable if isinstance(email, str) and email]
                if not emails:
                    continue
            # Include if CONNECTED, if it has email credentials (Gmail can send
            # even if sync failed), or if a non-Gmail sync failed (its synced
            # data stays searchable; Gmail is listed only for readable inboxes).
            if (
                status == "CONNECTED"
                or emails
                or (status == "SYNC_FAILED" and name.lower() != "gmail")
            ):
                if name.lower() in {"granola", "fireflies"}:
                    name = f"Meeting note taker ({name.lower()}.ai)"
                if emails:
                    integration_lines.append(f"- {name}: {', '.join(emails)}")
                else:
                    integration_lines.append(f"- {name}")
        if integration_lines:
            sections.append(
                "## Connected Integrations\n"
                "These integrations are connected and available.\n"
                "Their synced data is searchable through an explore agent's grep.\n"
                + "\n".join(integration_lines)
            )

    # Section: Authenticated Browser Sessions
    if authenticated_sites:
        sites_str = ", ".join(authenticated_sites)

        sections.append(
            "## Authenticated Browser Sessions\n"
            "Stored auth credentials are available for these sites. When using spawn_browser_agent\n"
            "for these domains, the agent will be logged into the user's account; no authentication is required. "
            "Prefer authenticated sites when they are suitable for the task.\n"
            f"{sites_str}"
        )

    sections.extend(build_user_profile_sections(user_settings))

    # Section: Distilled User Snapshot
    snapshot_content = user_snapshot.get("content") if user_snapshot else None
    if isinstance(snapshot_content, dict) and snapshot_content:
        snapshot_lines = [
            f"Version: {user_snapshot.get('version')}",
            f"Updated: {user_snapshot.get('updatedAt')}",
            json.dumps(snapshot_content, ensure_ascii=False, indent=2, sort_keys=True),
        ]
        revisions = user_snapshot.get("revisions")
        if isinstance(revisions, list) and revisions:
            latest = revisions[0]
            snapshot_lines.append(
                "Latest update: "
                + json.dumps(
                    {
                        "source": latest.get("source"),
                        "createdAt": latest.get("createdAt"),
                        "changes": latest.get("changes"),
                    },
                    ensure_ascii=False,
                    sort_keys=True,
                )
            )
        sections.append("## Distilled User Snapshot\n" + "\n".join(snapshot_lines))

    # Section: Recent Communications
    if recent_messages:
        message_lines = []
        for msg in recent_messages[:RECENT_MESSAGES_CONTEXT_LIMIT]:
            channel = msg.get("channel", "UNKNOWN")
            timestamp = msg.get("timestamp", "")
            # Parse timestamp and format nicely
            try:
                dt = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
                time_str = dt.isoformat(timespec="minutes")
            except Exception:
                time_str = timestamp[:16] if len(timestamp) >= 16 else timestamp

            from_addr = msg.get("from", "unknown")
            to_addr = msg.get("to", "unknown")
            message_text = msg.get("message", "")

            # Truncate long messages
            if len(message_text) > 300:
                message_text = message_text[:300] + "..."

            # Determine direction
            direction = f"From: {from_addr}" if from_addr else f"To: {to_addr}"

            message_lines.append(f"[{channel}] {time_str} | {direction}\n{message_text}")

        if message_lines:
            messages_body = "\n\n".join(message_lines)
            if len(recent_messages) >= RECENT_MESSAGES_CONTEXT_LIMIT:
                messages_body += (
                    f"\n\n… (showing {RECENT_MESSAGES_CONTEXT_LIMIT} most recent — "
                    'use grep with source="messages" to search by keyword, person_id, or time range)'
                )
            sections.append("## Recent Communications\n" + messages_body)

    # Section: Network (top contacts by message volume)
    if frequent_contacts:
        contact_lines = []
        for contact in frequent_contacts:
            # Name or phone as identifier
            first = contact.get("firstName", "")
            last = contact.get("lastName", "")
            name = f"{first} {last}".strip()
            phone = contact.get("phoneNumber")

            if not name and not phone:
                continue

            # Always-included fields
            parts = [name] if name else []

            if phone:
                parts.append(phone)

            freq = contact.get("communicationFrequency")
            if freq:
                parts.append(freq)

            msgs = contact.get("messagesExchanged")
            if msgs:
                parts.append(f"{msgs} msgs")

            # Conditionally-included fields (only when populated)
            relation = contact.get("relation")
            if relation:
                parts.append(relation)

            company = contact.get("company")
            if company:
                parts.append(company)

            email = contact.get("email")
            if email and not phone:
                # Only include email if no phone (avoid redundant contact info)
                parts.append(email)

            contact_lines.append(" | ".join(parts))

        if contact_lines:
            network_body = "\n".join(contact_lines)
            if len(frequent_contacts) >= NETWORK_CONTEXT_LIMIT:
                network_body += (
                    f"\n… (showing top {NETWORK_CONTEXT_LIMIT} by message volume — "
                    'use grep with source="network" to search all contacts)'
                )
            sections.append("## User Network\n" + network_body)

    # Combine all sections
    if not sections:
        return ""

    section_order = [
        "## Personal Information",
        "## Delivery Address",
        "## Dedicated cloud iPhone",
        "## Distilled User Snapshot",
        "## Connected Integrations",
        "## Authenticated Browser Sessions",
        "## Recent Communications",
        "## User Network",
    ]
    sections.sort(key=lambda section: section_order.index(section.split("\n", 1)[0]))
    return "\n\n".join(sections)


def _render_profile_context(user_settings: dict) -> str:
    """Render canonical personal-information and delivery-address sections."""
    return "\n\n".join(build_user_profile_sections(user_settings))


def _combine_profile_and_context(profile_context: str, base_context: str) -> str:
    """Prepend fresh profile sections to independently cached context."""
    sections = [profile_context] if profile_context else []
    if base_context:
        sections.append(base_context)
    return "\n\n".join(sections)


# ============================================================================
# Core Function (can be called from other activities)
# ============================================================================


async def fetch_user_context(user_id: str, context_gates: Optional[Dict[str, bool]] = None) -> str:
    """
    Fetch and format user context for the agent system prompt.

    Uses a 5-minute TTL cache for stable context. The small user-settings read
    stays fresh so name and delivery changes reach every newly started agent.
    When context_gates are provided, only fetches/includes gated-on sections.

    Args:
        user_id: The user's ID
        context_gates: Optional dict controlling which sections to include.
            Keys: user_profile, user_snapshot, authenticated_sessions, integrations,
                  recent_communications, network, custom_system_prompt.
            Default (None or missing key) = True (include section).

    Returns:
        Formatted user context string, or empty string if no context available
    """
    global _user_context_cache
    gates = context_gates or {}

    def _gate_open(name: str) -> bool:
        return gates.get(name, True)

    # If ALL relevant gates are closed, skip everything
    relevant_gates = [
        "user_profile",
        "user_snapshot",
        "authenticated_sessions",
        "integrations",
        "recent_communications",
        "network",
    ]
    if all(not _gate_open(g) for g in relevant_gates):
        logger.info("All user context gates closed, skipping fetch", user_id=user_id[:8])
        return ""

    try:
        # Only use cache when no gates are specified (full context)
        # Gated requests are cheap enough and shouldn't poison the full-context cache
        now = datetime.utcnow()
        if not gates and user_id in _user_context_cache:
            cached = _user_context_cache[user_id]
            fetched_at = cached.get("fetched_at")
            if fetched_at and (now - fetched_at) < timedelta(minutes=CACHE_TTL_MINUTES):
                refresh_generation = cached.get("profile_refresh_generation", 0) + 1
                cached["profile_refresh_generation"] = refresh_generation
                config = load_config()
                try:
                    async with httpx.AsyncClient() as client:
                        user_settings, settings_read_succeeded = await asyncio.wait_for(
                            _fetch_user_settings_with_status(client, config, user_id),
                            timeout=PROFILE_REFRESH_TIMEOUT_SECONDS,
                        )
                except TimeoutError:
                    logger.warning(
                        "User settings refresh timed out; using cached profile",
                        user_id=user_id[:8],
                        timeout_seconds=PROFILE_REFRESH_TIMEOUT_SECONDS,
                    )
                    user_settings, settings_read_succeeded = {}, False
                if settings_read_succeeded:
                    profile_context = _render_profile_context(user_settings)
                    if cached.get("profile_refresh_generation") == refresh_generation:
                        cached["profile_context"] = _render_profile_context({**user_settings, "iphoneCapability": None})
                else:
                    profile_context = cached.get("profile_context", "")
                logger.info(
                    "User context cache hit", user_id=user_id[:8], age_seconds=(now - fetched_at).total_seconds()
                )
                return _combine_profile_and_context(
                    profile_context,
                    cached.get("base_context", ""),
                )

        # Cache miss or gated request - fetch data selectively
        skipped = [g for g in relevant_gates if not _gate_open(g)]
        logger.info(
            "Fetching user context",
            user_id=user_id[:8],
            gates_closed=skipped if skipped else "none",
        )

        config = load_config()

        async def _noop_integrations():
            return ([], [])

        async def _noop_dict():
            return {}

        async def _noop_list():
            return []

        async with httpx.AsyncClient() as client:
            # Only fetch what's needed based on gates
            integrations_future = (
                _fetch_integrations_and_auth_domains(client, config, user_id)
                if _gate_open("integrations") or _gate_open("authenticated_sessions")
                else _noop_integrations()
            )
            user_settings_future = (
                _fetch_user_settings(client, config, user_id) if _gate_open("user_profile") else _noop_dict()
            )
            messages_future = (
                _fetch_recent_messages(client, config, user_id, limit=200)
                if _gate_open("recent_communications")
                else _noop_list()
            )
            contacts_future = _fetch_top_contacts(client, config, user_id) if _gate_open("network") else _noop_list()
            snapshot_future = (
                _fetch_user_snapshot(client, config, user_id) if _gate_open("user_snapshot") else _noop_dict()
            )

            (
                (integrations, authenticated_sites),
                user_settings,
                recent_messages,
                frequent_contacts,
                user_snapshot,
            ) = await asyncio.gather(
                integrations_future,
                user_settings_future,
                messages_future,
                contacts_future,
                snapshot_future,
            )

        # Profile data must never be folded into the five-minute cache. Delivery
        # and identity edits should be reflected on the next agent invocation.
        base_context = _format_user_context(
            authenticated_sites=authenticated_sites if _gate_open("authenticated_sessions") else [],
            user_settings={},
            recent_messages=recent_messages if _gate_open("recent_communications") else [],
            frequent_contacts=frequent_contacts if _gate_open("network") else [],
            integrations=integrations if _gate_open("integrations") else None,
            user_snapshot=user_snapshot if _gate_open("user_snapshot") else None,
        )
        profile_context = _render_profile_context(user_settings) if _gate_open("user_profile") else ""
        context = _combine_profile_and_context(profile_context, base_context)

        # Only cache full (ungated) context
        if not gates:
            _user_context_cache[user_id] = {
                "base_context": base_context,
                # Entitlement/guidance is fresh only; the fallback retains
                # personal profile without any phone permission or guidance.
                "profile_context": _render_profile_context({**user_settings, "iphoneCapability": None}),
                "profile_refresh_generation": 0,
                "fetched_at": now,
            }

        logger.info(
            "User context fetched",
            user_id=user_id[:8],
            authenticated_sites=len(authenticated_sites) if _gate_open("authenticated_sessions") else "skipped",
            messages=len(recent_messages) if _gate_open("recent_communications") else "skipped",
            contacts=len(frequent_contacts) if _gate_open("network") else "skipped",
            context_length=len(context),
        )

        return context

    except Exception as e:
        logger.error("Failed to get user context", user_id=user_id[:8] if user_id else "unknown", error=str(e))
        # Return empty string on error - don't break the agent
        return ""


# ============================================================================
# Fetch Messages for User Simulation
# ============================================================================

# Cache for simulation messages: { user_id: { "messages": list, "fetched_at": datetime } }
_simulation_messages_cache: Dict[str, Dict[str, Any]] = {}
SIMULATION_CACHE_TTL_MINUTES = 10


async def fetch_frequent_contact_messages(user_id: str) -> List[dict]:
    """
    Fetch user's messages from the past 7 days for user simulation.

    This provides a deep sample of the user's communication style for
    creating an authentic simulated response.

    Uses a 10-minute TTL cache to avoid excessive backend calls.

    Args:
        user_id: The user's ID

    Returns:
        List of message dicts with channel, from, to, message, timestamp
    """
    global _simulation_messages_cache

    try:
        # Check cache
        now = datetime.utcnow()
        if user_id in _simulation_messages_cache:
            cached = _simulation_messages_cache[user_id]
            fetched_at = cached.get("fetched_at")
            if fetched_at and (now - fetched_at) < timedelta(minutes=SIMULATION_CACHE_TTL_MINUTES):
                logger.info(
                    "Simulation messages cache hit",
                    user_id=user_id[:8],
                    age_seconds=(now - fetched_at).total_seconds(),
                    message_count=len(cached.get("messages", [])),
                )
                return cached.get("messages", [])

        # Cache miss - fetch fresh data
        logger.info("Simulation messages cache miss, fetching 7 days of messages", user_id=user_id[:8])

        config = load_config()

        async with httpx.AsyncClient() as client:
            messages = await _fetch_messages_for_simulation(client, config, user_id, days=7)

        # Update cache
        _simulation_messages_cache[user_id] = {"messages": messages, "fetched_at": now}

        logger.info("Simulation messages fetched and cached", user_id=user_id[:8], message_count=len(messages))

        return messages

    except Exception as e:
        logger.error("Failed to fetch simulation messages", user_id=user_id[:8] if user_id else "unknown", error=str(e))
        return []


def format_messages_for_simulation(messages: List[dict], user_name: str = "User") -> str:
    """
    Format messages into a string showing the user's communication style.

    This creates example conversations that demonstrate how the user writes,
    to help the LLM simulate authentic responses.

    Args:
        messages: List of message dicts
        user_name: The user's name for labeling

    Returns:
        Formatted string of message examples
    """
    if not messages:
        return ""

    formatted_lines = []

    for msg in messages[:100]:  # Limit to 100 messages for context size
        channel = msg.get("channel", "UNKNOWN")
        timestamp = msg.get("timestamp", "")
        from_addr = msg.get("from", "")
        to_addr = msg.get("to", "")
        message_text = msg.get("message", "")

        # Skip empty messages
        if not message_text.strip():
            continue

        # Parse timestamp
        try:
            dt = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
            time_str = dt.strftime("%m/%d %H:%M")
        except Exception:
            time_str = ""

        # Truncate long messages
        if len(message_text) > 500:
            message_text = message_text[:500] + "..."

        # Determine if user sent or received
        # The user's messages show their writing style
        direction = "SENT" if from_addr else "RECEIVED"
        other_party = to_addr if from_addr else from_addr

        formatted_lines.append(f"[{channel}] {time_str} {direction} to/from {other_party}:\n{message_text}")

    return "\n\n".join(formatted_lines)


# ============================================================================
# Temporal Activity Wrapper
# ============================================================================


@activity.defn
async def get_user_context(user_id: str, context_gates: Optional[Dict[str, bool]] = None) -> str:
    """
    Temporal activity wrapper for fetch_user_context.

    Can be called as a standalone activity from workflows.

    Args:
        user_id: The user's ID
        context_gates: Optional dict controlling which sections to include.
    """
    activity.heartbeat(f"Getting user context for {user_id[:8]}...")
    return await fetch_user_context(user_id, context_gates)


@activity.defn
async def get_user_system_name(user_id: str) -> str:
    """
    Fetch the user's custom system name (or default to "Rose").

    Used for dynamic name replacement in approval messages and SMS notifications.
    """
    try:
        config = load_config()
        async with httpx.AsyncClient() as client:
            user_settings = await _fetch_user_settings(client, config, user_id)
            return user_settings.get("systemName") or "Rose"
    except Exception as e:
        logger.warning("Failed to fetch system name, using default", user_id=user_id[:8], error=str(e))
        return "Rose"


@activity.defn
async def get_user_custom_system_prompt(user_id: str) -> Optional[str]:
    """
    Fetch the user's custom system prompt.

    Used for injecting personality/behavior customization at chat start.
    Returns None if no custom prompt is set.
    """
    try:
        config = load_config()
        async with httpx.AsyncClient() as client:
            user_settings = await _fetch_user_settings(client, config, user_id)
            return user_settings.get("customSystemPrompt") or None
    except Exception as e:
        logger.warning("Failed to fetch custom system prompt", user_id=user_id[:8], error=str(e))
        return None
