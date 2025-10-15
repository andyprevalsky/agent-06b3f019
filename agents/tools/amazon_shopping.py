"""Amazon shopping tool - search, filter, and buy items from Amazon."""

from typing import Dict, Any, Optional
from temporalio import activity, workflow
from datetime import timedelta, datetime
import structlog
import httpx
import json
import os

from tools.request_user_attention import request_user_attention

logger = structlog.get_logger()


@activity.defn
async def search_amazon_activity(query: str, domain: str = "amazon.com") -> tuple:
    """
    Activity: Search Amazon via Fewsats API.
    
    Returns:
        Tuple of (status_code, products_list)
    """
    try:
        activity.heartbeat(f"Searching Amazon for: {query}")
        
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(
                "https://api.amazon.fewsats.com/api/v1/search",
                params={
                    "q": query,
                    "domain": domain
                }
            )
            
            if response.status_code == 200:
                products = response.json()
                logger.info(
                    "Amazon search completed",
                    query=query,
                    num_results=len(products) if isinstance(products, list) else 0
                )
                return (200, products)
            else:
                logger.warning(
                    "Amazon search failed",
                    query=query,
                    status=response.status_code
                )
                return (response.status_code, [])
                
    except Exception as e:
        logger.error("Amazon search error", error=str(e), query=query)
        raise


@activity.defn
async def fetch_user_settings_activity(user_id: str) -> Dict[str, Any]:
    """
    Activity: Fetch user data from backend API.
    
    Args:
        user_id: The user's ID (from Supabase auth)
        
    Returns:
        Dict with name, addressLine1, addressLine2, city, state, postalCode, country
    """
    try:
        activity.heartbeat(f"Fetching user settings for: {user_id}")
        
        # Get backend URL from environment
        backend_url = os.getenv("BACKEND_URL", "http://localhost:3001")
        
        # Get API key from environment (for internal service-to-service auth)
        api_key = os.getenv("INTERNAL_API_KEY")
        
        headers = {}
        if api_key:
            headers["x-api-key"] = api_key
        
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{backend_url}/api/user-settings",
                headers={
                    **headers,
                    # Pass user ID for auth - backend will validate
                    "x-user-id": user_id
                }
            )
            
            if response.status_code == 200:
                settings = response.json()
                logger.info("User settings fetched", user_id=user_id)
                return settings
            else:
                logger.warning(
                    "Failed to fetch user settings, using defaults",
                    user_id=user_id,
                    status=response.status_code
                )
                # Return defaults if user data not found
                return {
                    "name": None,
                    "addressLine1": None,
                    "addressLine2": None,
                    "city": None,
                    "state": None,
                    "postalCode": None,
                    "country": "United States"
                }
                
    except Exception as e:
        logger.error("Error fetching user data", error=str(e), user_id=user_id)
        # Return defaults on error
        return {
            "name": None,
            "addressLine1": None,
            "addressLine2": None,
            "city": None,
            "state": None,
            "postalCode": None,
            "country": "United States"
        }


@activity.defn
async def rank_amazon_products_activity(prompt: str) -> Dict[str, Any]:
    """
    Activity: Use LLM to rank Amazon products based on qualifications.
    
    Args:
        prompt: Formatted prompt with products and qualifications
        
    Returns:
        Dict with 'best_product_index', 'reasoning', and 'usage' (token tracking)
    """
    try:
        from pydantic import BaseModel
        from helpers.llm import call_llm_structured
        from config import load_config
        
        activity.heartbeat("Ranking products with LLM")
        
        class ProductRanking(BaseModel):
            """LLM's ranking of products based on user qualifications."""
            best_product_index: int
            reasoning: str
            runner_up_index: Optional[int] = None
        
        # Get agent config for model
        config = load_config()
        model = config.openrouter.model
        
        # Call LLM with structured output
        result, usage = await call_llm_structured(
            messages=[{"role": "user", "content": prompt}],
            model=model,
            temperature=0.3,  # Lower temp for more consistent ranking
            max_tokens=500,
            response_model=ProductRanking
        )
        
        logger.info(
            "Product ranking completed",
            best_index=result.best_product_index,
            tokens=usage.get("total_tokens", 0)
        )
        
        return {
            "best_product_index": result.best_product_index,
            "reasoning": result.reasoning,
            "runner_up_index": result.runner_up_index,
            "usage": usage  # IMPORTANT: Return usage for token tracking
        }
        
    except Exception as e:
        logger.error("Product ranking failed", error=str(e))
        raise


async def buy_item_from_amazon(
    item_search_query: str,
    item_qualifications: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Search for an item on Amazon, find the best match using LLM-based ranking, and "buy" it.
    
    This tool will:
    1. Fetch user's shipping/payment settings from backend
    2. Search Amazon for the item
    3. Use LLM to rank products based on natural language qualifications
    4. Select the best match
    5. Send purchase confirmation to user via request_user_attention (mock purchase)
    
    Args:
        item_search_query: What to search for (e.g., "wooden shower bench", "wireless headphones")
        item_qualifications: Optional natural language description of what qualities matter.
            Examples:
            - "under $100, highly rated, many reviews"
            - "best value for money, waterproof, has storage shelf"
            - "around $50, modern style, ergonomic design"
            - "premium quality, fast shipping, well-reviewed"
            - "budget-friendly, good for seniors, easy to assemble"
            If not provided, will select best overall product (high rating, good value, popular)
        
    Returns:
        Dict with purchase details or error
        
    Example:
        result = await buy_item_from_amazon(
            item_search_query="wooden shower bench",
            item_qualifications="under $100, highly rated, has storage shelf, natural wood finish"
        )
    """
    # Must be called from workflow
    if not workflow.in_workflow():
        raise RuntimeError("buy_item_from_amazon must be called from within a workflow")
    
    # Get user_id from workflow search attributes
    info = workflow.info()
    search_attrs = info.search_attributes
    user_id = search_attrs.get("userId", ["unknown"])[0] if search_attrs else "unknown"
    
    logger.info(
        "Starting Amazon purchase",
        item_search_query=item_search_query,
        qualifications=item_qualifications,
        user_id=user_id
    )
    
    # Step 1: Fetch user settings (shipping/payment info)
    user_settings = await workflow.execute_activity(
        fetch_user_settings_activity,
        args=[user_id],
        start_to_close_timeout=timedelta(seconds=10),
    )
    
    # Step 2: Search Amazon
    result = await workflow.execute_activity(
        search_amazon_activity,
        args=[item_search_query, "amazon.com"],
        start_to_close_timeout=timedelta(seconds=30),
    )
    
    if not isinstance(result, tuple) or len(result) != 2:
        return {
            "success": False,
            "error": "Unexpected response from Amazon search",
            "item_search_query": item_search_query
        }
    
    status_code, products = result
    
    if status_code != 200 or not isinstance(products, list) or not products:
        return {
            "success": False,
            "error": f"No products found for '{item_search_query}'",
            "item_search_query": item_search_query
        }
    
    # Step 2: Use LLM to rank products based on natural language qualifications
    # Prepare products summary for LLM (first 10 to keep context manageable)
    top_products = products[:10]
    products_summary = []
    
    for i, p in enumerate(top_products):
        summary = {
            "index": i,
            "title": p.get('title', ''),
            "price": p.get('extracted_price'),
            "original_price": p.get('extracted_original_price'),
            "rating": p.get('rating'),
            "reviews": p.get('reviews'),
            "recent_sales": p.get('recent_sales', ''),
        }
        products_summary.append(summary)
    
    # Format qualifications for LLM
    if item_qualifications:
        qualifications_text = item_qualifications
    else:
        qualifications_text = "None specified - choose the best overall product (high rating, many reviews, good value)"
    
    ranking_prompt = f"""You are helping a user buy an item from Amazon. They searched for: "{item_search_query}"

User's qualifications:
{qualifications_text}

Here are the top products found:
{json.dumps(products_summary, indent=2)}

Based on the user's qualifications, which product (by index) is the BEST match? Consider:
- Budget constraints if mentioned
- Features and priorities they care about
- Rating and review count (quality signal)
- Value for money (price vs. quality)
- Recent sales (popularity signal)

Return the index of the best product and explain your reasoning."""

    ranking_result = await workflow.execute_activity(
        rank_amazon_products_activity,
        args=[ranking_prompt],
        start_to_close_timeout=timedelta(seconds=30),
    )
    
    best_index = ranking_result.get("best_product_index", 0)
    llm_reasoning = ranking_result.get("reasoning", "Selected based on overall quality")
    token_usage = ranking_result.get("usage", {})
    
    # Validate index
    if best_index < 0 or best_index >= len(top_products):
        # Fallback to first product if LLM returns invalid index
        logger.warning("LLM returned invalid product index", index=best_index)
        best_index = 0
    
    best_product = top_products[best_index]
    
    # Step 3: Format purchase details
    title = best_product.get('title', item_search_query)
    price = best_product.get('extracted_price', 0)
    orig_price = best_product.get('extracted_original_price')
    rating = best_product.get('rating', 0)
    reviews = best_product.get('reviews', 0)
    link = best_product.get('link', '')
    asin = best_product.get('asin', '')
    
    # Calculate estimated delivery (mock - 3-5 business days)
    estimated_delivery = (datetime.now() + timedelta(days=5)).strftime("%B %d, %Y")
    
    # Format purchase confirmation message
    purchase_msg = f"# 🛒 Amazon Order Confirmation\n\n"
    purchase_msg += f"## {title}\n\n"
    
    # LLM's reasoning for selection
    purchase_msg += f"**Why this product:** {llm_reasoning}\n\n"
    purchase_msg += f"---\n\n"
    
    # Price info
    purchase_msg += f"**Price:** ${price:.2f}"
    if orig_price and orig_price > price:
        discount = (orig_price - price) / orig_price * 100
        purchase_msg += f" ~~${orig_price:.2f}~~ (${orig_price - price:.2f} savings, {discount:.0f}% off!)"
    purchase_msg += "\n\n"
    
    # Product details
    purchase_msg += f"**Rating:** {'⭐' * int(rating)} {rating}/5 ({reviews:,} reviews)\n"
    purchase_msg += f"**ASIN:** {asin}\n"
    purchase_msg += f"**Estimated Delivery:** {estimated_delivery}\n\n"
    
    # Format shipping address from user data
    name = user_settings.get("name")
    addr_line1 = user_settings.get("addressLine1")
    addr_line2 = user_settings.get("addressLine2")
    city = user_settings.get("city")
    state = user_settings.get("state")
    postal_code = user_settings.get("postalCode")
    country = user_settings.get("country", "United States")
    
    # Build formatted address
    if not addr_line1 or not city or not state or not postal_code:
        shipping_addr = "[No shipping address set - please update in /settings]"
    else:
        addr_parts = []
        if name:
            addr_parts.append(name)
        addr_parts.append(addr_line1)
        if addr_line2:
            addr_parts.append(addr_line2)
        addr_parts.append(f"{city}, {state} {postal_code}")
        if country:
            addr_parts.append(country)
        shipping_addr = "\n".join(addr_parts)
    
    purchase_msg += f"**Shipping Address:**\n{shipping_addr}\n\n"
    purchase_msg += f"**Payment Method:** [Default card ending in 1234]\n\n"
    
    # Link
    purchase_msg += f"---\n\n"
    purchase_msg += f"🔗 **[View Order on Amazon]({link})**\n\n"
    purchase_msg += f"---\n\n"
    purchase_msg += f"**Do you want to proceed with this purchase?**\n"
    purchase_msg += f"Reply 'confirm' to place the order, or 'cancel' to stop."
    
    logger.info(
        "Requesting purchase confirmation",
        item_search_query=item_search_query,
        selected_product=title,
        price=price,
        asin=asin,
        llm_reasoning=llm_reasoning
    )
    
    # Step 4: Request user confirmation (mock "purchase")
    attention_result = await request_user_attention(
        question=purchase_msg,
        context={
            "type": "amazon_purchase_confirmation",
            "item_search_query": item_search_query,
            "item_qualifications": item_qualifications,
            "selected_product": title,
            "price": price,
            "asin": asin,
            "link": link,
            "llm_reasoning": llm_reasoning
        }
    )
    
    user_response = attention_result.get("response", "").lower()
    
    # Check if user confirmed or canceled
    if "confirm" in user_response or "yes" in user_response or "proceed" in user_response or "buy" in user_response:
        # Purchase confirmed!
        logger.info(
            "Amazon purchase confirmed by user",
            selected_product=title,
            price=price
        )
        
        return {
            "success": True,
            "item_search_query": item_search_query,
            "item_name": title,
            "price": price,
            "original_price": orig_price,
            "discount_amount": (orig_price - price) if (orig_price and orig_price > price) else 0,
            "rating": rating,
            "reviews": reviews,
            "asin": asin,
            "link": link,
            "estimated_delivery": estimated_delivery,
            "shipping_address": shipping_addr,
            "payment_method": "[Default card ending in 1234]",
            "user_response": attention_result.get("response"),
            "llm_reasoning": llm_reasoning,
            "total_products_searched": len(products),
            "considered_products": len(top_products),
            "usage": token_usage  # IMPORTANT: Token usage for tracking
        }
    else:
        # Purchase canceled
        logger.info(
            "Amazon purchase canceled by user",
            selected_product=title,
            user_response=user_response
        )
        
        return {
            "success": False,
            "canceled": True,
            "item_search_query": item_search_query,
            "item_name": title,
            "price": price,
            "rejection_reason": f"User declined purchase: {attention_result.get('response')}",
            "link": link,
            "usage": token_usage  # IMPORTANT: Token usage for tracking
        }


def format_pre_message(tool_call: Dict[str, Any]) -> Dict[str, str]:
    """Format the pre-execution message."""
    item_search_query = tool_call.get("item_search_query", "item")
    item_qualifications = tool_call.get("item_qualifications", "")
    
    criteria_str = item_qualifications if item_qualifications else "best overall match (high rating, good value)"
    
    return {
        "title": f"🛒 Buying {item_search_query} from Amazon",
        "message": f"Using the following criteria to determine the best option: {criteria_str}"
    }


def format_post_message(tool_call: Dict[str, Any], result: Any) -> Dict[str, str]:
    """Format the post-execution message."""
    
    if not isinstance(result, dict):
        return {
            "title": "Amazon purchase completed",
            "message": str(result)
        }
    
    # Error case
    if not result.get("success") and not result.get("canceled"):
        return {
            "title": "❌ Amazon purchase failed",
            "message": result.get("error", "Unknown error")
        }
    
    # Canceled case
    if result.get("canceled"):
        item_name = result.get("item_name", "item")
        rejection_reason = result.get("rejection_reason", "User declined")
        
        return {
            "title": f"🚫 {item_name} Amazon order canceled",
            "message": rejection_reason
        }
    
    # Success case
    item_name = result.get("item_name", "item")
    price = result.get("price", 0)
    discount = result.get("discount_amount", 0)
    delivery = result.get("estimated_delivery", "Unknown")
    address = result.get("shipping_address", "[Default address]")
    payment = result.get("payment_method", "[Default card ending in 1234]")
    
    msg = f"**Price:** ${price:.2f}"
    if discount > 0:
        msg += f" (saved ${discount:.2f})"
    msg += f"\n**Delivery:** {delivery}\n**Shipping:** {address}\n**Payment:** {payment}"
    
    return {
        "title": f"✅ {item_name} purchased from Amazon",
        "message": msg
    }
