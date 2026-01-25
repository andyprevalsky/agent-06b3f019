"""x402 Bazaar tools - search and pay for x402 services.

Uses Coinbase x402 protocol for paid API discovery and execution.
"""

from typing import Dict, Any, Optional, Callable, Awaitable
from temporalio import activity
from temporalio.common import RetryPolicy
from datetime import timedelta
import structlog
import httpx
import time
import base64

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus, format_tool_message, format_error_message
from helpers.handle_tool_event import handle_tool_event

# Config import is safe - no side effects at import time (load_dotenv is lazy)
from config import load_config

# Type alias for execute_activity callable
ExecuteActivityCallable = Callable[..., Awaitable[Any]]

logger = structlog.get_logger()


def _safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox where time.time() is restricted."""
    try:
        return time.time()
    except Exception:
        return 0.0

# x402 Bazaar API endpoint
X402_BAZAAR_API = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources"


# ========================================
# SEARCH X402 BAZAAR TOOL
# ========================================

class SearchX402BazaarManager(ToolManager):
    """Manager for searching the x402 Bazaar for available paid API services."""

    tool_name = "search_x402_bazaar"
    read_only = True  # Research phase tool - no side effects

    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: Dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Execute x402 Bazaar search and post events via handle_tool_event.

        Args:
            execute_activity: workflow.execute_activity or call_temporal_activity_from_activity
            tool_call: Tool call dict with optional 'max_price_cents', 'keyword'
            tool_call_id: Unique ID for this tool call
            agent_id: Agent ID for event routing
            user_id: User ID for usage tracking
            
        Returns:
            Result dict with services found
        """
        max_price_cents = tool_call.get("max_price_cents")
        keyword = tool_call.get("keyword")

        # Track start time for elapsed time calculation
        start_time = _safe_time()

        # Build display message
        filters = []
        if max_price_cents:
            filters.append(f"max price: ${max_price_cents/100:.2f}")
        if keyword:
            filters.append(f"keyword: {keyword}")
        filter_str = ", ".join(filters) if filters else "no filters"

        # 1. Pre-execution status
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title="🔍 Searching x402 Bazaar",
                message=f"Discovering paid API services ({filter_str})",
                status=MessageStatus.IN_PROGRESS
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="search_x402_bazaar",
            execute_activity=execute_activity,
            user_id=user_id,
        )

        # 2. Execute search activity
        try:
            result = await execute_activity(
                search_x402_bazaar_activity,
                args=[max_price_cents, keyword],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(
                    maximum_attempts=3,
                    backoff_coefficient=2.0,
                    initial_interval=timedelta(seconds=1),
                    maximum_interval=timedelta(seconds=10)
                )
            )

            # 3. Calculate elapsed time
            elapsed_time = _safe_time() - start_time

            # Format success message using standardized format
            message = format_tool_message(
                params=tool_call,
                result=result,
                time_elapsed=elapsed_time,
                cost_cents=0  # Search is free
            )

            # Post-execution success
            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"✅ Found {result.get('service_count', 0)} x402 services",
                    message=message,
                    status=MessageStatus.FINISHED
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="search_x402_bazaar",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            # Return with standardized usage for workflow cost tracking (search is free)
            return {
                "result": result,
                "usage": {
                    "llm": [],
                    "service": [],
                }
            }

        except Exception as e:
            # Calculate elapsed time even on error
            elapsed_time = _safe_time() - start_time

            # Format error message using standardized format
            error_message = format_error_message(
                params=tool_call,
                error=e,
                time_elapsed=elapsed_time,
                cost_cents=0
            )

            # Error status
            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="❌ x402 Bazaar search failed",
                    message=error_message,
                    status=MessageStatus.ERROR
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="search_x402_bazaar",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            return {
                "result": {"error": str(e), "services": [], "service_count": 0},
                "usage": {"llm": [], "service": []},
            }


# ========================================
# PAY FOR X402 BAZAAR SERVICE TOOL
# ========================================

class PayForX402BazaarServiceManager(ToolManager):
    """Manager for executing paid x402 service calls."""

    tool_name = "pay_for_x402_bazaar_service"
    read_only = False  # This tool makes payments - not read-only

    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: Dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Execute a paid x402 service call and post events via handle_tool_event.

        Args:
            execute_activity: workflow.execute_activity or call_temporal_activity_from_activity
            tool_call: Tool call dict with 'resource_url', 'method', 'params', 'max_amount_cents'
            tool_call_id: Unique ID for this tool call
            agent_id: Agent ID for event routing
            user_id: User ID for usage tracking
            
        Returns:
            Result dict with response and payment info
        """
        resource_url = tool_call.get("resource_url", "")
        method = tool_call.get("method", "GET")
        params = tool_call.get("params")
        max_amount_cents = tool_call.get("max_amount_cents", 0)

        # Track start time for elapsed time calculation
        start_time = _safe_time()

        # Truncate URL for display
        display_url = resource_url if len(resource_url) <= 60 else resource_url[:57] + "..."

        # 1. Pre-execution status
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title="💳 Calling x402 Service",
                message=f"**URL:** {display_url}\n**Method:** {method}\n**Max Payment:** ${max_amount_cents/100:.2f}",
                status=MessageStatus.IN_PROGRESS
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="pay_for_x402_bazaar_service",
            execute_activity=execute_activity,
            user_id=user_id,
        )

        # 2. Execute payment and service call activity
        try:
            result = await execute_activity(
                pay_for_x402_service_activity,
                args=[resource_url, method, params, max_amount_cents],
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(
                    maximum_attempts=2,  # Fewer retries for payment operations
                    backoff_coefficient=2.0,
                    initial_interval=timedelta(seconds=2),
                    maximum_interval=timedelta(seconds=10)
                )
            )

            # 3. Calculate elapsed time and cost
            elapsed_time = _safe_time() - start_time
            cost_cents = result.get("amount_paid_cents", 0)

            # Format success message using standardized format
            message = format_tool_message(
                params=tool_call,
                result=result,
                time_elapsed=elapsed_time,
                cost_cents=cost_cents
            )

            # Post-execution success
            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"✅ x402 Service completed (${cost_cents/100:.4f})",
                    message=message,
                    status=MessageStatus.FINISHED
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="pay_for_x402_bazaar_service",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            # Return with standardized usage for workflow cost tracking
            return {
                "result": result,
                "usage": {
                    "llm": [],
                    "service": [{"cost_cents": int(cost_cents), "provider": f"x402 Bazaar ({result.get('network', 'base')})"}] if cost_cents > 0 else [],
                }
            }

        except Exception as e:
            # Calculate elapsed time even on error
            elapsed_time = _safe_time() - start_time

            # Format error message using standardized format
            error_message = format_error_message(
                params=tool_call,
                error=e,
                time_elapsed=elapsed_time,
                cost_cents=0
            )

            # Error status
            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="❌ x402 Service call failed",
                    message=error_message,
                    status=MessageStatus.ERROR
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="pay_for_x402_bazaar_service",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            return {
                "result": {"error": str(e)},
                "usage": {"llm": [], "service": []},
            }


# ========================================
# SINGLETONS
# ========================================

_search_manager: Optional[SearchX402BazaarManager] = None
_pay_manager: Optional[PayForX402BazaarServiceManager] = None


def get_search_manager() -> SearchX402BazaarManager:
    """Get or create search manager singleton."""
    global _search_manager
    if _search_manager is None:
        _search_manager = SearchX402BazaarManager()
    return _search_manager


def get_pay_manager() -> PayForX402BazaarServiceManager:
    """Get or create pay manager singleton."""
    global _pay_manager
    if _pay_manager is None:
        _pay_manager = PayForX402BazaarServiceManager()
    return _pay_manager


# ========================================
# TOOL ENTRY POINTS
# ========================================

async def search_x402_bazaar(
    execute_activity: ExecuteActivityCallable,
    tool_call: Dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Execute search_x402_bazaar tool.

    Args:
        execute_activity: workflow.execute_activity or call_temporal_activity_from_activity
        tool_call: Tool call dict with optional 'max_price_cents', 'keyword'
        tool_call_id: Unique ID for this tool call
        agent_id: Agent ID for event routing
        user_id: User ID for usage tracking
        
    Returns:
        Result dict with services found
    """
    manager = get_search_manager()
    return await manager.execute_tool(
        execute_activity=execute_activity,
        tool_call=tool_call,
        tool_call_id=tool_call_id,
        agent_id=agent_id,
        user_id=user_id,
    )


async def pay_for_x402_bazaar_service(
    execute_activity: ExecuteActivityCallable,
    tool_call: Dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Execute pay_for_x402_bazaar_service tool.

    Args:
        execute_activity: workflow.execute_activity or call_temporal_activity_from_activity
        tool_call: Tool call dict with 'resource_url', 'method', 'params', 'max_amount_cents'
        tool_call_id: Unique ID for this tool call
        agent_id: Agent ID for event routing
        user_id: User ID for usage tracking
        
    Returns:
        Result dict with response and payment info
    """
    manager = get_pay_manager()
    return await manager.execute_tool(
        execute_activity=execute_activity,
        tool_call=tool_call,
        tool_call_id=tool_call_id,
        agent_id=agent_id,
        user_id=user_id,
    )


# ========================================
# TEMPORAL ACTIVITIES
# ========================================

@activity.defn
async def search_x402_bazaar_activity(
    max_price_cents: Optional[int] = None,
    keyword: Optional[str] = None
) -> Dict[str, Any]:
    """
    Activity: Search the x402 Bazaar for available paid API services.

    Args:
        max_price_cents: Optional maximum price filter (in cents)
        keyword: Optional keyword to filter services

    Returns:
        Dict with:
            - services: List of available services (filtered)
            - service_count: Number of services found
            - filters_applied: Dict of filters that were applied
    """
    try:
        activity.heartbeat("Searching x402 Bazaar...")

        config = load_config()
        
        # Get our wallet address to filter out our own services (anti-cannibalization)
        our_wallet = config.x402.receiving_wallet.lower() if config.x402.receiving_wallet else None

        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(X402_BAZAAR_API)

            if response.status_code != 200:
                raise Exception(f"x402 Bazaar API error: {response.status_code}")

            data = response.json()
            
            # Defensive check: ensure data is a dict
            if not isinstance(data, dict):
                raise Exception(f"x402 Bazaar API returned unexpected type: {type(data).__name__}")
            
            items = data.get("items", [])
            
            # Defensive check: ensure items is a list
            if not isinstance(items, list):
                raise Exception(f"x402 Bazaar API 'items' is not a list: {type(items).__name__}")

            # Process and filter services
            services = []
            for item in items:
                # Defensive check: skip non-dict items
                if not isinstance(item, dict):
                    logger.warning("Skipping non-dict item in x402 Bazaar response", item_type=type(item).__name__)
                    continue
                
                # Extract service info from the nested structure
                accepts = item.get("accepts", [])
                if not accepts or not isinstance(accepts, list):
                    continue

                # Get first payment requirement (most services have one)
                payment_req = accepts[0]
                
                # Defensive check: ensure payment_req is a dict
                if not isinstance(payment_req, dict):
                    logger.warning("Skipping non-dict payment_req", payment_req_type=type(payment_req).__name__)
                    continue
                
                # Anti-cannibalization: Skip services owned by our wallet
                pay_to = payment_req.get("payTo", "")
                if not isinstance(pay_to, str):
                    pay_to = str(pay_to) if pay_to else ""
                pay_to = pay_to.lower()
                
                if our_wallet and pay_to == our_wallet:
                    logger.debug("Filtering out our own service", resource=item.get("resource"))
                    continue

                # Extract price in cents (convert from atomic units - USDC has 6 decimals)
                max_amount_str = payment_req.get("maxAmountRequired", "0")
                try:
                    max_amount = int(max_amount_str)
                except (ValueError, TypeError):
                    max_amount = 0
                # USDC has 6 decimals, so divide by 10000 to get cents (6 decimals - 2 for cents = 4)
                price_cents = max_amount // 10000

                # Apply price filter
                if max_price_cents is not None and price_cents > max_price_cents:
                    continue

                # Extract resource URL
                resource_url = payment_req.get("resource") or item.get("resource", "")

                # Apply keyword filter
                if keyword:
                    keyword_lower = keyword.lower()
                    resource_lower = str(resource_url).lower()
                    metadata_str = str(item.get("metadata", {})).lower()
                    if keyword_lower not in resource_lower and keyword_lower not in metadata_str:
                        continue

                # Safely extract nested schema values with defensive checks
                output_schema = payment_req.get("outputSchema")
                if not isinstance(output_schema, dict):
                    output_schema = {}
                
                input_schema = output_schema.get("input")
                if not isinstance(input_schema, dict):
                    input_schema = {}
                
                method = input_schema.get("method", "GET") if isinstance(input_schema, dict) else "GET"
                
                # Build service info
                service = {
                    "resource": resource_url,
                    "price_cents": price_cents,
                    "price_display": f"${price_cents/100:.4f}",
                    "pay_to": payment_req.get("payTo"),
                    "asset": payment_req.get("asset"),
                    "network": payment_req.get("network", "base"),
                    "method": method,
                    "input_schema": input_schema if input_schema else None,
                    "output_schema": output_schema.get("output") if output_schema else None,
                    "metadata": item.get("metadata") if isinstance(item.get("metadata"), dict) else {},
                    "last_updated": item.get("lastUpdated"),
                }
                services.append(service)

            result = {
                "services": services,
                "service_count": len(services),
                "filters_applied": {
                    "max_price_cents": max_price_cents,
                    "keyword": keyword,
                    "excluded_own_wallet": our_wallet is not None,
                }
            }

            logger.info(
                "x402 Bazaar search completed",
                service_count=len(services),
                total_items=len(items),
                filters=result["filters_applied"]
            )

            return result

    except Exception as e:
        logger.error("x402 Bazaar search failed", error=str(e))
        raise


def _get_private_key_from_cdp_secret(cdp_wallet_secret: str) -> bytes:
    """
    Extract raw private key bytes from CDP wallet secret (PKCS#8 DER format, base64-encoded).
    
    Args:
        cdp_wallet_secret: Base64-encoded PKCS#8 DER private key
        
    Returns:
        Raw 32-byte private key
    """
    from cryptography.hazmat.primitives import serialization
    
    # Decode base64 to get PKCS#8 DER bytes
    pkcs8_bytes = base64.b64decode(cdp_wallet_secret)
    
    # Load the private key
    private_key = serialization.load_der_private_key(pkcs8_bytes, password=None)
    
    # Extract the raw private value (32 bytes for secp256k1)
    raw_bytes = private_key.private_numbers().private_value.to_bytes(32, 'big')
    
    return raw_bytes


@activity.defn
async def pay_for_x402_service_activity(
    resource_url: str,
    method: str = "GET",
    params: Optional[Dict[str, Any]] = None,
    max_amount_cents: int = 0
) -> Dict[str, Any]:
    """
    Activity: Execute a paid x402 service call.

    Uses the x402 protocol to make a payment and call the service.

    Args:
        resource_url: The x402 service URL
        method: HTTP method (GET or POST)
        params: Request parameters (query params for GET, body for POST)
        max_amount_cents: Maximum amount willing to pay (in cents)

    Returns:
        Dict with:
            - response: Service response data
            - amount_paid_cents: Amount paid in cents
            - transaction_id: Payment transaction ID (if available)
    """
    try:
        activity.heartbeat(f"Calling x402 service: {resource_url[:50]}...")

        config = load_config()
        
        # Validate we have wallet credentials
        if not config.x402.wallet_secret:
            raise Exception("CDP_WALLET_SECRET not configured - cannot make payments")

        async with httpx.AsyncClient(timeout=60.0) as client:
            # Step 1: Make initial request to get 402 response with payment requirements
            if method.upper() == "GET":
                initial_response = await client.get(resource_url, params=params)
            else:
                initial_response = await client.post(resource_url, json=params)

            # If not 402, the service might not require payment or there's an error
            if initial_response.status_code == 200:
                # Service returned data without payment (possibly free)
                return {
                    "response": initial_response.json(),
                    "amount_paid_cents": 0,
                    "transaction_id": None,
                    "note": "Service did not require payment"
                }

            if initial_response.status_code != 402:
                raise Exception(f"Unexpected response: {initial_response.status_code} - {initial_response.text}")

            # Step 2: Parse 402 response to get payment requirements
            # The x402 protocol returns payment info in headers or body
            payment_header = initial_response.headers.get("X-Payment")
            
            if not payment_header:
                # Try to get from body
                try:
                    body = initial_response.json()
                except:
                    raise Exception("402 response missing payment information")
                
                # x402 returns accepts array with payment options
                accepts = body.get("accepts", [])
                if not accepts:
                    raise Exception(f"402 response has no payment options: {initial_response.text}")
                
                # Use the first accept option
                payment_info = accepts[0]
            else:
                import json
                payment_info = json.loads(payment_header)

            # Extract payment requirements - amount is in atomic USDC units (6 decimals)
            # 10000 atomic = 0.01 USDC = 1 cent
            required_amount = int(payment_info.get("maxAmountRequired", 0))
            required_cents = required_amount // 10000  # Convert from atomic USDC to cents
            
            # If conversion results in 0 but there's a required amount, round up to 1 cent
            if required_cents == 0 and required_amount > 0:
                required_cents = 1

            # Check against max amount willing to pay
            if required_cents > max_amount_cents:
                raise Exception(
                    f"Service requires ${required_cents/100:.4f} but max allowed is ${max_amount_cents/100:.4f}"
                )

            pay_to = payment_info.get("payTo")
            asset = payment_info.get("asset")
            network = payment_info.get("network", "base")

            activity.heartbeat(f"Processing payment of ${required_cents/100:.4f}...")

            # Step 3: Create and sign payment using EIP-3009 (transferWithAuthorization)
            from eth_account import Account
            import json
            import time as time_module
            import secrets

            # Extract raw private key from CDP wallet secret
            private_key_bytes = _get_private_key_from_cdp_secret(config.x402.wallet_secret)
            account = Account.from_key(private_key_bytes)
            
            # The payer address MUST be derived from the signing key
            payer_address = account.address

            # Generate random nonce (32 bytes hex)
            nonce = "0x" + secrets.token_hex(32)
            
            valid_after = int(time_module.time())
            valid_before = valid_after + 3600  # Valid for 1 hour

            # Build EIP-712 typed data for EIP-3009 transferWithAuthorization
            # USDC uses this for gasless transfers
            chain_id = 8453 if network == "base" else 84532  # base mainnet vs base-sepolia
            
            typed_data = {
                "types": {
                    "EIP712Domain": [
                        {"name": "name", "type": "string"},
                        {"name": "version", "type": "string"},
                        {"name": "chainId", "type": "uint256"},
                        {"name": "verifyingContract", "type": "address"},
                    ],
                    "TransferWithAuthorization": [
                        {"name": "from", "type": "address"},
                        {"name": "to", "type": "address"},
                        {"name": "value", "type": "uint256"},
                        {"name": "validAfter", "type": "uint256"},
                        {"name": "validBefore", "type": "uint256"},
                        {"name": "nonce", "type": "bytes32"},
                    ],
                },
                "primaryType": "TransferWithAuthorization",
                "domain": {
                    "name": "USDC",
                    "version": "2",
                    "chainId": chain_id,
                    "verifyingContract": asset,  # USDC contract address from payment_info
                },
                "message": {
                    "from": payer_address,  # Must match the signer's address
                    "to": pay_to,
                    "value": required_amount,
                    "validAfter": valid_after,
                    "validBefore": valid_before,
                    "nonce": nonce,
                },
            }

            # Sign the EIP-712 typed data (must use full_message keyword argument)
            signed = account.sign_typed_data(full_message=typed_data)

            # Create payment payload
            payment_payload = {
                "x402Version": 1,
                "scheme": "exact",
                "network": network,
                "payload": {
                    "signature": "0x" + signed.signature.hex(),
                    "authorization": {
                        "from": payer_address,  # Must match the signer's address
                        "to": pay_to,
                        "value": str(required_amount),
                        "validAfter": str(valid_after),
                        "validBefore": str(valid_before),
                        "nonce": nonce,
                    }
                }
            }

            # Step 4: Make the paid request with X-PAYMENT header (base64 encoded)
            payment_header_json = json.dumps(payment_payload)
            payment_header_b64 = base64.b64encode(payment_header_json.encode()).decode()
            
            headers = {
                "X-PAYMENT": payment_header_b64,
                "Content-Type": "application/json"
            }

            if method.upper() == "GET":
                paid_response = await client.get(resource_url, params=params, headers=headers)
            else:
                paid_response = await client.post(resource_url, json=params, headers=headers)

            if paid_response.status_code != 200:
                raise Exception(f"Paid request failed: {paid_response.status_code} - {paid_response.text}")

            # Parse response
            try:
                response_data = paid_response.json()
            except:
                response_data = {"raw_response": paid_response.text}

            result = {
                "response": response_data,
                "amount_paid_cents": required_cents,
                "amount_paid_display": f"${required_cents/100:.4f}",
                "transaction_id": payment_payload["payload"]["authorization"]["nonce"],
                "pay_to": pay_to,
                "network": network,
            }

            logger.info(
                "x402 service call completed",
                resource=resource_url[:50],
                amount_paid_cents=required_cents,
                network=network
            )

            return result

    except Exception as e:
        logger.error("x402 service call failed", error=str(e), resource=resource_url[:50])
        raise
