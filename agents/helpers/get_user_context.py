"""Helper for fetching and formatting user context for agent system prompts."""

from temporalio import activity
import structlog
import httpx
import asyncio
from typing import Dict, List, Optional, Any
from datetime import datetime, timedelta
from collections import defaultdict

from config import load_config

logger = structlog.get_logger()

# Module-level cache: { user_id: { "context": str, "fetched_at": datetime } }
_user_context_cache: Dict[str, Dict[str, Any]] = {}
CACHE_TTL_MINUTES = 5

# ============================================================================
# Cookie Auth Detection Constants
# ============================================================================

# Known ad/tracking domains to exclude
AD_TRACKING_DOMAINS = {
    'doubleclick.net', 'adnxs.com', 'pubmatic.com', 'rubiconproject.com', 'criteo.com',
    'taboola.com', 'outbrain.com', 'googlesyndication.com', 'googleadservices.com',
    'amazon-adsystem.com', 'adsrvr.org', 'casalemedia.com', 'openx.net', 'contextweb.com',
    'adroll.com', 'media.net', 'yieldmo.com', 'sharethrough.com', 'triplelift.com',
    'scorecardresearch.com', 'quantserve.com', 'demdex.net', 'bluekai.com',
    '360yield.com', 'adition.com', 'adgrx.com', 'adtdp.com', 'adtonos.com', 'advertserve.com',
    'advolve.io', 'appier.net', 'applovin.com', 'clearnview.com', 'company-target.com',
    'connatix.com', 'cpmstar.com', 'deepintent.com', 'dotomi.com', 'driftpixel.live',
    'emxdgt.com', 'eqads.com', 'extremereach.io', 'feedad.com', 'forter.com', 'idmap.ai',
    'infolinks.com', 'kargo.com', 'knotch.it', 'loopme.me', 'lunamedia.live', 'marphezis.com',
    'measureadv.com', 'mediarithmics.com', 'mediawallahscript.com', 'minutemedia-prebid.com',
    'missena.io', 'mookie1.com', 'newsroom.bi', 'omnifytv.live', 'omtrdc.net', 'openwebmp.com',
    'pmbmonetize.live', 'presage.io', 'prmutv.co', 'rbstsystems.live', 'richaudience.com',
    'seedtag.com', 'smilewanted.com', 'stackadapt.com', 'tappx.com', 'tradehouse.media',
    'unrulymedia.com', 'usbrowserspeed.com', 'vrtcal.com', 'yellowblue.io', 'ymmobi.com',
    'yotpo.com', 'a-mo.net', 'a-mx.com', 'amxrtb.com', 'rtb.mx', 'sptag2.com', 'ad-stir.com',
    '1rx.io', 'pxf.io', 'sjv.io', 'ztk5.net', '7zd4df.net', 'alcmpn.com', 'cdn-net.com',
    'iesnare.com', 'online-metrix.net', 'earlywarning.io', 'signifyd.com', 'ebay-us.com',
    'apata.io', 'finicity.com', 'mmapiws.com', 'rezync.com', 'rkdms.com', 'livechatinc.com',
    'messagebird.com', 'clarity.ms', 'recaptcha.net', 'optimizely.com', 'disqus.com',
    '06yahoo.com', '66yahoo.com', 'yahoodns.net', 'ymail.com', 'zenfs.com', 'yusercontent.com',
    'co.jp', 'com.ec', 'mail.ru', 'healthroundprince.com', 'mcangelus.com', 'powerrobotflower.com',
    'sonobi.com', 'smaato.net', 'intentiq.com', 'sparteo.com', 'trustedstack.com', '3lift.com',
    'aniview.com', 'bricks-co.com', 'insightexpressai.com', 'technoratimedia.com', 'nextmillmedia.com',
    'bfmio.com', 'tremorhub.com', 'bliink.io', 'fwmrm.net', 'smartadserver.com', 'userreport.com',
    'iqm.com', 'acuityplatform.com', 'w55c.net', 'bidmatic.io', 'stickyadstv.com', 'adtelligent.com',
    'optidigital.com', 'sportradarserving.com', 'yieldoptimizer.com', 'betweendigital.com',
    'btloader.com', 'creativecdn.com', 'admaster.cc', 'adscale.de', 'crwdcntrl.net', 'datasteam.io',
    'lemmadigital.com', 'liadm.com', 'lijit.com', 'media6degrees.com', 'mfadsrvr.com', 'pippio.com',
    'sojern.com', 'xplosion.de', 'admanmedia.com', 'adotmob.com', 'bidswitch.net', 'bluecava.com',
    'creative-serving.com', 'ctnsnet.com', 'e-volution.ai', 'impact-ad.jp', 'liftdsp.com',
    'nhnace.com', 'otm-r.com', 'postrelease.com', 'rfihub.com', 'sitescout.com', 'smartclip.net',
    'spotim.market', 'tapad.com', 'turn.com', 'udmserve.net', 'undertone.com', 'viewdeos.com',
    'sitelytics.tech', 'nytrng.com', 'nytb.org', 'inmobi.com', 'goldprice.org',
}

# Cookies that are NEVER auth (false positive triggers)
ALWAYS_FALSE_POSITIVE_COOKIES = [
    'cf_clearance',      # Cloudflare captcha
    '_ga', '_gid', '_gcl',  # Google Analytics
    '_fbp', '_fbc',      # Facebook pixel
    'mp_',               # Mixpanel (starts with)
    '_hp5_',             # Heap analytics
    '_hjSession',        # Hotjar
    'OptanonConsent', 'OptanonAlertBoxClosed',  # Cookie consent
    '_pin_unauth',       # Pinterest unauth
    'intercom-',         # Intercom (not auth)
    '__stripe_mid',      # Stripe tracking (not auth)
    '_rdt_uuid',         # Reddit pixel
    '_tt_enable_cookie', '_ttp',  # TikTok pixel
    '_uetvid',           # Microsoft ads
    'hubspotutk', '__hstc',  # HubSpot tracking
    '__kla_id',          # Klaviyo
    'ajs_anonymous_id',  # Segment anonymous
    'ph_phc_',           # PostHog
    '_clck', '_clsk',    # Clarity
    '_scid', '_sctr',    # Snapchat pixel
    'FPID', 'FPAU',      # First party tracking
    '_derived_epik',     # Pinterest
    '_zitok',            # Generic tracking
    'receive-cookie-deprecation',  # Chrome deprecation test
]

# Auth patterns to match in cookie names
AUTH_PATTERNS = [
    'session', 'sess', 'auth', 'token', 'login', 'logged', 'user', 'usr',
    'sso', 'jwt', 'bearer', 'access', 'refresh', 'credential', 'identity',
    'account', 'member', 'subscriber',
]

# Adult site keywords to filter
ADULT_KEYWORDS = ['xxx', 'porn', 'adult', 'sex', 'xvideos', 'xhamster']


# ============================================================================
# Cookie Processing Functions
# ============================================================================

def _normalize_domain(host_key: str) -> str:
    """Normalize a cookie host_key to a clean domain."""
    domain = host_key.lstrip('.')
    if domain.startswith('www.'):
        domain = domain[4:]
    return domain


def _get_base_domain(domain: str) -> str:
    """Extract base domain (e.g., 'mail.google.com' -> 'google.com')."""
    parts = domain.split('.')
    if len(parts) >= 2:
        return '.'.join(parts[-2:])
    return domain


def _is_false_positive_cookie(name: str) -> bool:
    """Check if cookie name is a known false positive."""
    name_lower = name.lower()
    for fp in ALWAYS_FALSE_POSITIVE_COOKIES:
        if fp.lower() in name_lower:
            return True
    return False


def _is_auth_cookie(cookie: dict) -> bool:
    """Check if a cookie looks like an auth/session cookie."""
    name = cookie.get('name', '')
    name_lower = name.lower()
    
    if _is_false_positive_cookie(name):
        return False
    
    for pattern in AUTH_PATTERNS:
        if pattern in name_lower:
            return True
    
    return False


def _extract_authenticated_sites(integrations: List[dict]) -> List[str]:
    """Extract list of authenticated site domains from integrations."""
    authenticated_sites = []
    
    # Find chrome_cookies integration
    chrome_cookies_integration = None
    for integration in integrations:
        if integration.get('name') == 'chrome_cookies':
            chrome_cookies_integration = integration
            break
    
    if not chrome_cookies_integration:
        return authenticated_sites
    
    config = chrome_cookies_integration.get('config', {})
    cookies = config.get('cookies', [])
    
    if not cookies:
        return authenticated_sites
    
    # Group cookies by domain
    domain_cookies: Dict[str, List[dict]] = defaultdict(list)
    for cookie in cookies:
        host_key = cookie.get('host_key', '')
        domain = _normalize_domain(host_key)
        base = _get_base_domain(domain)
        domain_cookies[base].append(cookie)
    
    # Find domains with auth cookies
    for domain, domain_cookie_list in domain_cookies.items():
        # Skip ad/tracking domains
        if domain in AD_TRACKING_DOMAINS:
            continue
        
        # Skip adult sites
        if any(kw in domain for kw in ADULT_KEYWORDS):
            continue
        
        # Check if any cookie looks like auth
        for cookie in domain_cookie_list:
            if _is_auth_cookie(cookie):
                authenticated_sites.append(domain)
                break
    
    return sorted(authenticated_sites)


# ============================================================================
# Backend API Calls
# ============================================================================

async def _fetch_integrations(client: httpx.AsyncClient, config, user_id: str) -> List[dict]:
    """Fetch user's integrations from backend."""
    try:
        response = await client.get(
            f"{config.backend.api_url}/api/integrations",
            headers={
                "X-API-Key": config.backend.api_key or "",
                "X-User-Id": user_id,
            },
            timeout=30.0
        )
        response.raise_for_status()
        data = response.json()
        return data.get('integrations', [])
    except Exception as e:
        logger.warning("Failed to fetch integrations", user_id=user_id, error=str(e))
        return []


async def _fetch_user_settings(client: httpx.AsyncClient, config, user_id: str) -> dict:
    """Fetch user profile settings from backend."""
    try:
        response = await client.get(
            f"{config.backend.api_url}/api/user-settings",
            headers={
                "X-API-Key": config.backend.api_key or "",
                "X-User-Id": user_id,
            },
            timeout=30.0
        )
        response.raise_for_status()
        return response.json()
    except Exception as e:
        logger.warning("Failed to fetch user settings", user_id=user_id, error=str(e))
        return {}


async def _fetch_recent_messages(client: httpx.AsyncClient, config, user_id: str, limit: int = 200) -> List[dict]:
    """Fetch recent messages from backend."""
    try:
        response = await client.get(
            f"{config.backend.api_url}/api/people/messages/recent",
            params={"limit": limit},
            headers={
                "X-API-Key": config.backend.api_key or "",
                "X-User-Id": user_id,
            },
            timeout=30.0
        )
        response.raise_for_status()
        data = response.json()
        return data.get('messages', [])
    except Exception as e:
        logger.warning("Failed to fetch recent messages", user_id=user_id, error=str(e))
        return []


async def _fetch_frequent_contacts(client: httpx.AsyncClient, config, user_id: str) -> List[dict]:
    """Fetch frequent contacts from backend."""
    try:
        # Get people with communicationFrequency set
        response = await client.get(
            f"{config.backend.api_url}/api/people",
            params={"limit": 100},  # Get more people, filter client-side
            headers={
                "X-API-Key": config.backend.api_key or "",
                "X-User-Id": user_id,
            },
            timeout=30.0
        )
        response.raise_for_status()
        data = response.json()
        people = data.get('people', [])
        
        # Filter to people with daily/weekly/monthly communication frequency
        frequent = [
            p for p in people
            if p.get('communicationFrequency') in ['daily', 'weekly', 'monthly']
        ]
        
        return frequent
    except Exception as e:
        logger.warning("Failed to fetch frequent contacts", user_id=user_id, error=str(e))
        return []


# ============================================================================
# Formatting Functions
# ============================================================================

def _format_user_context(
    authenticated_sites: List[str],
    user_settings: dict,
    recent_messages: List[dict],
    frequent_contacts: List[dict]
) -> str:
    """Format the user context string for the system prompt."""
    sections = []
    
    # Section: Authenticated Browser Sessions
    if authenticated_sites:
        sites_str = ", ".join(authenticated_sites[:50])  # Limit to 50 sites
        if len(authenticated_sites) > 50:
            sites_str += f", ... (+{len(authenticated_sites) - 50} more)"
        
        sections.append(
            "AUTHENTICATED BROWSER SESSIONS\n"
            "You have stored auth credentials for these sites. When using spawn_browser_agent\n"
            "for these domains, the user is already logged in - no authentication required:\n"
            f"{sites_str}"
        )
    
    # Section: User Profile
    profile_parts = []
    if user_settings.get('name'):
        profile_parts.append(f"Name: {user_settings['name']}")
    
    location_parts = []
    if user_settings.get('city'):
        location_parts.append(user_settings['city'])
    if user_settings.get('state'):
        location_parts.append(user_settings['state'])
    if user_settings.get('country'):
        location_parts.append(user_settings['country'])
    
    if location_parts:
        profile_parts.append(f"Location: {', '.join(location_parts)}")
    
    if profile_parts:
        sections.append("USER PROFILE\n" + "\n".join(profile_parts))
    
    # Section: Recent Communications
    if recent_messages:
        message_lines = []
        for msg in recent_messages[:200]:  # Limit to 200 messages
            channel = msg.get('channel', 'UNKNOWN')
            timestamp = msg.get('timestamp', '')
            # Parse timestamp and format nicely
            try:
                dt = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
                time_str = dt.strftime('%Y-%m-%d %H:%M')
            except:
                time_str = timestamp[:16] if len(timestamp) >= 16 else timestamp
            
            from_addr = msg.get('from', 'unknown')
            to_addr = msg.get('to', 'unknown')
            message_text = msg.get('message', '')
            
            # Truncate long messages
            if len(message_text) > 300:
                message_text = message_text[:300] + "..."
            
            # Determine direction
            direction = f"From: {from_addr}" if from_addr else f"To: {to_addr}"
            
            message_lines.append(f"[{channel}] {time_str} | {direction}\n{message_text}")
        
        if message_lines:
            sections.append(
                "RECENT COMMUNICATIONS (past 24 hours)\n\n" + 
                "\n\n".join(message_lines)
            )
    
    # Section: Frequent Contacts
    if frequent_contacts:
        contact_lines = []
        for contact in frequent_contacts[:30]:  # Limit to 30 contacts
            parts = []
            
            # Name
            first = contact.get('firstName', '')
            last = contact.get('lastName', '')
            name = f"{first} {last}".strip()
            if not name:
                continue
            
            # Relation (in parentheses if present)
            relation = contact.get('relation')
            if relation:
                parts.append(f"{name} ({relation})")
            else:
                parts.append(name)
            
            # Communication frequency
            freq = contact.get('communicationFrequency')
            if freq:
                parts.append(freq)
            
            # Profession/Company
            profession = contact.get('profession')
            company = contact.get('company')
            if profession and company:
                parts.append(f"{profession} @ {company}")
            elif profession:
                parts.append(profession)
            elif company:
                parts.append(f"@ {company}")
            
            # Contact info (phone or email)
            phone = contact.get('phoneNumber')
            email = contact.get('email')
            if phone:
                parts.append(phone)
            elif email:
                parts.append(email)
            
            contact_lines.append("- " + " | ".join(parts))
        
        if contact_lines:
            sections.append("FREQUENT CONTACTS\n" + "\n".join(contact_lines))
    
    # Combine all sections
    if not sections:
        return ""
    
    return "USER CONTEXT:\n\n" + "\n\n".join(sections)


# ============================================================================
# Core Function (can be called from other activities)
# ============================================================================

async def fetch_user_context(user_id: str) -> str:
    """
    Fetch and format user context for the agent system prompt.
    
    Uses a 5-minute TTL cache to avoid excessive backend calls.
    This is the core implementation that can be called from other activities.
    
    Args:
        user_id: The user's ID
        
    Returns:
        Formatted user context string, or empty string if no context available
    """
    global _user_context_cache
    
    try:
        # Check cache
        now = datetime.utcnow()
        if user_id in _user_context_cache:
            cached = _user_context_cache[user_id]
            fetched_at = cached.get('fetched_at')
            if fetched_at and (now - fetched_at) < timedelta(minutes=CACHE_TTL_MINUTES):
                logger.info(
                    "User context cache hit",
                    user_id=user_id[:8],
                    age_seconds=(now - fetched_at).total_seconds()
                )
                return cached.get('context', '')
        
        # Cache miss - fetch fresh data
        logger.info("User context cache miss, fetching fresh data", user_id=user_id[:8])
        
        config = load_config()
        
        async with httpx.AsyncClient() as client:
            # Make all 4 calls in parallel
            integrations_task = _fetch_integrations(client, config, user_id)
            user_settings_task = _fetch_user_settings(client, config, user_id)
            messages_task = _fetch_recent_messages(client, config, user_id, limit=200)
            contacts_task = _fetch_frequent_contacts(client, config, user_id)
            
            integrations, user_settings, recent_messages, frequent_contacts = await asyncio.gather(
                integrations_task,
                user_settings_task,
                messages_task,
                contacts_task
            )
        
        # Extract authenticated sites from cookies
        authenticated_sites = _extract_authenticated_sites(integrations)
        
        # Format the context string
        context = _format_user_context(
            authenticated_sites=authenticated_sites,
            user_settings=user_settings,
            recent_messages=recent_messages,
            frequent_contacts=frequent_contacts
        )
        
        # Update cache
        _user_context_cache[user_id] = {
            'context': context,
            'fetched_at': now
        }
        
        logger.info(
            "User context fetched and cached",
            user_id=user_id[:8],
            authenticated_sites=len(authenticated_sites),
            messages=len(recent_messages),
            contacts=len(frequent_contacts),
            context_length=len(context),
            context=context
        )
        
        return context
        
    except Exception as e:
        logger.error(
            "Failed to get user context",
            user_id=user_id[:8] if user_id else "unknown",
            error=str(e)
        )
        # Return empty string on error - don't break the agent
        return ""


# ============================================================================
# Temporal Activity Wrapper
# ============================================================================

@activity.defn
async def get_user_context(user_id: str) -> str:
    """
    Temporal activity wrapper for fetch_user_context.
    
    Can be called as a standalone activity from workflows.
    """
    activity.heartbeat(f"Getting user context for {user_id[:8]}...")
    return await fetch_user_context(user_id)

