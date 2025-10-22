"""Amazon shopping tool - migrated to event-driven architecture."""

from typing import Dict, Any, Optional, AsyncGenerator
from temporalio import activity, workflow
from temporalio.common import RetryPolicy
from datetime import timedelta, datetime
import structlog
import httpx
import json
import os

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus, UsageItem, UsageType
from tools.request_user_attention import request_user_attention_direct as request_user_attention

# Import helpers with safe imports to avoid sandbox restrictions
with workflow.unsafe.imports_passed_through():
    from helpers.llm import call_llm_structured
    from config import load_config
    from pydantic import BaseModel

logger = structlog.get_logger()


class AmazonShoppingManager(ToolManager):
    """Manager for Amazon shopping operations."""
    
    tool_name = "buy_item_from_amazon"
    
    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """
        Execute Amazon shopping flow and yield events.
        
        Steps:
        1. Fetch user settings (shipping/payment)
        2. Search Amazon
        3. Rank products with LLM
        4. Request user confirmation
        5. Return purchase result
        
        Yields:
            - Pre-execution status
            - Usage tracking for LLM ranking
            - Post-execution status with result
        """
        item_search_query = tool_call.get("item_search_query", "")
        item_qualifications = tool_call.get("item_qualifications", "")
        
        # Get user_id from workflow instance
        user_id = workflow_instance.user_id
        
        criteria_str = item_qualifications if item_qualifications else "best overall match (high rating, good value)"
        
        # 1. Pre-execution status
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"🛒 Buying {item_search_query} from Amazon",
            message=f"Using the following criteria to determine the best option: {criteria_str}",
            status=MessageStatus.IN_PROGRESS
        )
        
        try:
            # 2. Fetch user settings
            user_settings = await workflow.execute_activity(
                fetch_user_settings_activity,
                args=[user_id],
                start_to_close_timeout=timedelta(seconds=10),
            )
            
            # 3. Search Amazon
            search_result = await workflow.execute_activity(
                search_amazon_activity,
                args=[item_search_query, "amazon.com"],
                start_to_close_timeout=timedelta(seconds=30),
            )
            
            if not isinstance(search_result, tuple) or len(search_result) != 2:
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="❌ Amazon purchase failed",
                    message="Unexpected response from Amazon search",
                    status=MessageStatus.ERROR
                )
                return
            
            status_code, products = search_result
            
            if status_code != 200 or not isinstance(products, list) or not products:
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="❌ Amazon purchase failed",
                    message=f"No products found for '{item_search_query}'",
                    status=MessageStatus.ERROR
                )
                return
            
            # 4. Rank products with LLM
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
            
            qualifications_text = item_qualifications if item_qualifications else "None specified - choose the best overall product (high rating, many reviews, good value)"
            
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
            
            # Emit usage event for LLM ranking
            if token_usage.get("total_tokens"):
                # Estimate cost based on OpenRouter model pricing (rough estimate: ~$5 per 1M tokens)
                input_tokens = token_usage.get("prompt_tokens", 0)
                output_tokens = token_usage.get("completion_tokens", 0)
                
                usage_items = []
                if input_tokens:
                    cost = (input_tokens * 500) // 1_000_000  # $5 per M tokens = 500 cents per M
                    usage_items.append(UsageItem(
                        type=UsageType.LLM,
                        cost_cents=cost,
                        provider="OpenRouter Product Ranking (Input)",
                        number_of_tokens=input_tokens,
                        token_price_per_million_cents=500
                    ))
                
                if output_tokens:
                    cost = (output_tokens * 500) // 1_000_000
                    usage_items.append(UsageItem(
                        type=UsageType.LLM,
                        cost_cents=cost,
                        provider="OpenRouter Product Ranking (Output)",
                        number_of_tokens=output_tokens,
                        token_price_per_million_cents=500
                    ))
                
                if usage_items:
                    yield ToolEvent(
                        type=EventType.USAGE,
                        tool_name=self.tool_name,
                        usage_items=usage_items
                    )
            
            # Validate index
            if best_index < 0 or best_index >= len(top_products):
                logger.warning("LLM returned invalid product index", index=best_index)
                best_index = 0
            
            best_product = top_products[best_index]
            
            # 5. Format purchase details
            title = best_product.get('title', item_search_query)
            price = best_product.get('extracted_price', 0)
            orig_price = best_product.get('extracted_original_price')
            rating = best_product.get('rating', 0)
            reviews = best_product.get('reviews', 0)
            link = best_product.get('link', '')
            asin = best_product.get('asin', '')
            thumbnail = best_product.get('thumbnail', '')
            
            estimated_delivery = (datetime.now() + timedelta(days=5)).strftime("%B %d, %Y")
            
            # Format shipping address
            name = user_settings.get("name")
            addr_line1 = user_settings.get("addressLine1")
            addr_line2 = user_settings.get("addressLine2")
            city = user_settings.get("city")
            state = user_settings.get("state")
            postal_code = user_settings.get("postalCode")
            country = user_settings.get("country", "United States")
            
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
            
            # 6. Request user confirmation
            agent_goal = workflow_instance.goal
            purchase_msg = f"Agent with the goal **{agent_goal}** would like to buy **{title}** (${price:.2f}).\n\n"
            purchase_msg += f"Send **yes** to confirm or **no** to deny the request."
            
            logger.info(
                "Requesting purchase confirmation",
                item_search_query=item_search_query,
                selected_product=title,
                price=price,
                asin=asin
            )
            
            attention_result = await request_user_attention(
                workflow_instance,
                question=purchase_msg,
                image_url=thumbnail if thumbnail else None,
            )
            
            user_response = attention_result.get("response", "").lower()
            
            # 7. Check if confirmed or canceled
            if "confirm" in user_response or "yes" in user_response or "proceed" in user_response or "buy" in user_response:
                # Purchase confirmed!
                logger.info("Amazon purchase confirmed", product=title, price=price)
                
                discount = (orig_price - price) if (orig_price and orig_price > price) else 0
                
                msg = f"**Price:** ${price:.2f}"
                if discount > 0:
                    msg += f" (saved ${discount:.2f})"
                msg += f"\n**Delivery:** {estimated_delivery}\n**Shipping:** {shipping_addr}\n**Payment:** [Default card ending in 1234]"
                
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"✓ {title[:30]} purchased from Amazon",
                    message=msg,
                    status=MessageStatus.FINISHED
                )
            else:
                # Purchase canceled
                logger.info("Amazon purchase canceled", product=title, user_response=user_response)
                
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"🚫 {title} Amazon order canceled",
                    message=f"User declined purchase: {attention_result.get('response')}",
                    status=MessageStatus.FINISHED
                )
        
        except Exception as e:
            # Error status
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Amazon purchase failed",
                message=str(e),
                status=MessageStatus.ERROR
            )
            raise


# ========================================
# SINGLETON
# ========================================

_manager: Optional[AmazonShoppingManager] = None


def get_manager() -> AmazonShoppingManager:
    """Get or create Amazon shopping manager singleton."""
    global _manager
    if _manager is None:
        _manager = AmazonShoppingManager()
    return _manager


# ========================================
# WORKFLOW HELPER
# ========================================

async def buy_item_from_amazon(
    workflow_instance,
    tool_call: Dict[str, Any],
    tool_call_id: str
):
    """
    Workflow helper for Amazon shopping (new event-driven system).
    
    Args:
        workflow_instance: The workflow instance
        tool_call: Tool call dict with 'item_search_query' and optional 'item_qualifications'
        tool_call_id: Unique ID for this tool call
    """
    manager = get_manager()
    
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "buy_item_from_amazon")


# ========================================
# TEMPORAL ACTIVITIES
# (Keep existing activities from amazon_shopping.py)
# ========================================

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
        
        backend_url = os.getenv("BACKEND_URL", "http://localhost:3001")
        api_key = os.getenv("INTERNAL_API_KEY")
        
        headers = {}
        if api_key:
            headers["x-api-key"] = api_key
        
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{backend_url}/api/user-settings",
                headers={
                    **headers,
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
        return {
            "name": None,
            "addressLine1": None,
            "addressLine2": None,
            "city": None,
            "state": None,
            "postalCode": None,
            "country": "United States"
        }


class ProductRanking(BaseModel):
    """LLM's ranking of products based on user qualifications."""
    best_product_index: int
    reasoning: str
    runner_up_index: Optional[int] = None


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
        activity.heartbeat("Ranking products with LLM")
        
        config = load_config()
        model = config.openrouter.model
        
        # Call LLM with structured output
        result, usage = await call_llm_structured(
            messages=[{"role": "user", "content": prompt}],
            model=model,
            temperature=0.3,
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
            "usage": usage
        }
        
    except Exception as e:
        logger.error("Product ranking failed", error=str(e))
        raise

