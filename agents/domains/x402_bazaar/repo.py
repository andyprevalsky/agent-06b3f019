"""x402 Bazaar domain data access.

Temporal activities that perform HTTP calls to the Coinbase x402 API.
Imports: own types, own config, providers (httpx, config, crypto).
"""

from __future__ import annotations

import base64
from typing import Any, Dict, Optional

import httpx
import structlog
from temporalio import activity

from config import load_config

from .config import (
    BASE_MAINNET_CHAIN_ID,
    BASE_SEPOLIA_CHAIN_ID,
    PAY_TIMEOUT_SECONDS,
    PAYMENT_VALIDITY_SECONDS,
    SEARCH_TIMEOUT_SECONDS,
    USDC_ATOMIC_TO_CENTS_DIVISOR,
    X402_BAZAAR_API,
)

logger = structlog.get_logger()


@activity.defn
async def search_x402_bazaar_activity(  # noqa: C901
    max_price_cents: Optional[int] = None,
    keyword: Optional[str] = None,
) -> Dict[str, Any]:
    """Search the x402 Bazaar for available paid API services.

    Args:
        max_price_cents: Optional maximum price filter (in cents).
        keyword: Optional keyword to filter services.

    Returns:
        Dict with services, service_count, and filters_applied.
    """
    try:
        activity.heartbeat("Searching x402 Bazaar...")

        config = load_config()

        # Get our wallet address to filter out our own services (anti-cannibalization)
        our_wallet = config.x402.receiving_wallet.lower() if config.x402.receiving_wallet else None

        async with httpx.AsyncClient(timeout=SEARCH_TIMEOUT_SECONDS) as client:
            response = await client.get(X402_BAZAAR_API)

            if response.status_code != 200:
                msg = f"x402 Bazaar API error: {response.status_code}"
                raise Exception(msg)  # noqa: TRY002

            data = response.json()

            # Defensive check: ensure data is a dict
            if not isinstance(data, dict):
                msg = f"x402 Bazaar API returned unexpected type: {type(data).__name__}"
                raise Exception(msg)  # noqa: TRY002

            items = data.get("items", [])

            # Defensive check: ensure items is a list
            if not isinstance(items, list):
                msg = f"x402 Bazaar API 'items' is not a list: {type(items).__name__}"
                raise Exception(msg)  # noqa: TRY002

            services = _filter_services(items, max_price_cents, keyword, our_wallet)

            result = {
                "services": services,
                "service_count": len(services),
                "filters_applied": {
                    "max_price_cents": max_price_cents,
                    "keyword": keyword,
                    "excluded_own_wallet": our_wallet is not None,
                },
            }

            logger.info(
                "x402 Bazaar search completed",
                service_count=len(services),
                total_items=len(items),
                filters=result["filters_applied"],
            )

            return result

    except Exception as e:
        logger.error("x402 Bazaar search failed", error=str(e))
        raise


def _filter_services(
    items: list,
    max_price_cents: Optional[int],
    keyword: Optional[str],
    our_wallet: Optional[str],
) -> list:
    """Filter and transform raw Bazaar items into service dicts."""
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
        price_cents = max_amount // USDC_ATOMIC_TO_CENTS_DIVISOR

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

        method = input_schema.get("method", "GET")

        # Build service info
        service = {
            "resource": resource_url,
            "price_cents": price_cents,
            "price_display": f"${price_cents / 100:.4f}",
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

    return services


def _get_private_key_from_cdp_secret(cdp_wallet_secret: str) -> bytes:
    """Extract raw private key bytes from CDP wallet secret (PKCS#8 DER format, base64-encoded).

    Args:
        cdp_wallet_secret: Base64-encoded PKCS#8 DER private key.

    Returns:
        Raw 32-byte private key.
    """
    from cryptography.hazmat.primitives import serialization

    # Decode base64 to get PKCS#8 DER bytes
    pkcs8_bytes = base64.b64decode(cdp_wallet_secret)

    # Load the private key
    private_key = serialization.load_der_private_key(pkcs8_bytes, password=None)

    # Extract the raw private value (32 bytes for secp256k1)
    return private_key.private_numbers().private_value.to_bytes(32, "big")


@activity.defn
async def pay_for_x402_service_activity(
    resource_url: str,
    method: str = "GET",
    params: Optional[Dict[str, Any]] = None,
    max_amount_cents: int = 0,
) -> Dict[str, Any]:
    """Execute a paid x402 service call.

    Uses the x402 protocol to make a payment and call the service.

    Args:
        resource_url: The x402 service URL.
        method: HTTP method (GET or POST).
        params: Request parameters (query params for GET, body for POST).
        max_amount_cents: Maximum amount willing to pay (in cents).

    Returns:
        Dict with response, amount_paid_cents, transaction_id, etc.
    """
    try:
        activity.heartbeat(f"Calling x402 service: {resource_url[:50]}...")

        config = load_config()

        # Validate we have wallet credentials
        if not config.x402.wallet_secret:
            msg = "CDP_WALLET_SECRET not configured - cannot make payments"
            raise Exception(msg)  # noqa: TRY002

        async with httpx.AsyncClient(timeout=PAY_TIMEOUT_SECONDS) as client:
            # Step 1: Make initial request to get 402 response with payment requirements
            initial_response = await _make_request(client, resource_url, method, params)

            # If not 402, the service might not require payment or there's an error
            if initial_response.status_code == 200:
                return {
                    "response": initial_response.json(),
                    "amount_paid_cents": 0,
                    "transaction_id": None,
                    "note": "Service did not require payment",
                }

            if initial_response.status_code != 402:
                msg = f"Unexpected response: {initial_response.status_code} - {initial_response.text}"
                raise Exception(msg)  # noqa: TRY002

            # Step 2: Parse 402 response to get payment requirements
            payment_info = _extract_payment_info(initial_response)

            # Extract payment requirements - amount is in atomic USDC units (6 decimals)
            required_amount = int(payment_info.get("maxAmountRequired", 0))
            required_cents = required_amount // USDC_ATOMIC_TO_CENTS_DIVISOR

            # If conversion results in 0 but there's a required amount, round up to 1 cent
            if required_cents == 0 and required_amount > 0:
                required_cents = 1

            # Check against max amount willing to pay
            if required_cents > max_amount_cents:
                msg = f"Service requires ${required_cents / 100:.4f} but max allowed is ${max_amount_cents / 100:.4f}"
                raise Exception(msg)  # noqa: TRY002

            pay_to = payment_info.get("payTo")
            asset = payment_info.get("asset")
            network = payment_info.get("network", "base")

            activity.heartbeat(f"Processing payment of ${required_cents / 100:.4f}...")

            # Step 3: Create and sign payment
            payment_header_b64, tx_nonce = _create_signed_payment(
                config.x402.wallet_secret,
                pay_to,
                asset,
                network,
                required_amount,
            )

            # Step 4: Make the paid request with X-PAYMENT header
            headers = {"X-PAYMENT": payment_header_b64, "Content-Type": "application/json"}

            paid_response = await _make_request(client, resource_url, method, params, headers)

            if paid_response.status_code != 200:
                msg = f"Paid request failed: {paid_response.status_code} - {paid_response.text}"
                raise Exception(msg)  # noqa: TRY002

            # Parse response
            try:
                response_data = paid_response.json()
            except Exception:
                response_data = {"raw_response": paid_response.text}

            result = {
                "response": response_data,
                "amount_paid_cents": required_cents,
                "amount_paid_display": f"${required_cents / 100:.4f}",
                "transaction_id": tx_nonce,
                "pay_to": pay_to,
                "network": network,
            }

            logger.info(
                "x402 service call completed",
                resource=resource_url[:50],
                amount_paid_cents=required_cents,
                network=network,
            )

            return result

    except Exception as e:
        logger.error("x402 service call failed", error=str(e), resource=resource_url[:50])
        raise


async def _make_request(
    client: httpx.AsyncClient,
    url: str,
    method: str,
    params: Optional[Dict[str, Any]] = None,
    headers: Optional[Dict[str, str]] = None,
) -> httpx.Response:
    """Make an HTTP request with the given method."""
    if method.upper() == "GET":
        return await client.get(url, params=params, headers=headers)
    return await client.post(url, json=params, headers=headers)


def _extract_payment_info(response: httpx.Response) -> Dict[str, Any]:
    """Extract payment info from a 402 response (header or body)."""
    import json

    payment_header = response.headers.get("X-Payment")

    if payment_header:
        return json.loads(payment_header)

    # Try to get from body
    try:
        body = response.json()
    except Exception as e:
        msg = "402 response missing payment information"
        raise Exception(msg) from e  # noqa: TRY002

    accepts = body.get("accepts", [])
    if not accepts:
        msg = f"402 response has no payment options: {response.text}"
        raise Exception(msg)  # noqa: TRY002

    return accepts[0]


def _create_signed_payment(
    wallet_secret: str,
    pay_to: str,
    asset: str,
    network: str,
    required_amount: int,
) -> tuple[str, str]:
    """Create and sign an EIP-3009 payment.

    Returns:
        Tuple of (base64-encoded X-PAYMENT header value, nonce used as transaction ID).
    """
    import json
    import secrets
    import time as time_module

    from eth_account import Account

    # Extract raw private key from CDP wallet secret
    private_key_bytes = _get_private_key_from_cdp_secret(wallet_secret)
    account = Account.from_key(private_key_bytes)

    # The payer address MUST be derived from the signing key
    payer_address = account.address

    # Generate random nonce (32 bytes hex)
    nonce = "0x" + secrets.token_hex(32)

    valid_after = int(time_module.time())
    valid_before = valid_after + PAYMENT_VALIDITY_SECONDS

    # Build EIP-712 typed data for EIP-3009 transferWithAuthorization
    chain_id = BASE_MAINNET_CHAIN_ID if network == "base" else BASE_SEPOLIA_CHAIN_ID

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
            "verifyingContract": asset,
        },
        "message": {
            "from": payer_address,
            "to": pay_to,
            "value": required_amount,
            "validAfter": valid_after,
            "validBefore": valid_before,
            "nonce": nonce,
        },
    }

    # Sign the EIP-712 typed data
    signed = account.sign_typed_data(full_message=typed_data)

    # Create payment payload
    payment_payload = {
        "x402Version": 1,
        "scheme": "exact",
        "network": network,
        "payload": {
            "signature": "0x" + signed.signature.hex(),
            "authorization": {
                "from": payer_address,
                "to": pay_to,
                "value": str(required_amount),
                "validAfter": str(valid_after),
                "validBefore": str(valid_before),
                "nonce": nonce,
            },
        },
    }

    payment_header_json = json.dumps(payment_payload)
    header_b64 = base64.b64encode(payment_header_json.encode()).decode()
    return header_b64, nonce
