"""Web task tool for accomplishing tasks via browser automation."""

from typing import Dict, List, Optional, Any
from temporalio import activity
from playwright.async_api import async_playwright, Page, Browser
import structlog
from openai import AsyncOpenAI

from config import load_config

logger = structlog.get_logger()


class WebTaskExecutor:
    """Manager for web task execution using browser automation."""
    
    def __init__(self):
        config = load_config()
        self.openai_client = AsyncOpenAI(
            api_key=config.openrouter.api_key,
            base_url=config.openrouter.base_url
        )
        self.model = config.openrouter.model
    
    async def plan_task(self, goal: str, context: Optional[Dict] = None) -> List[Dict]:
        """
        Use LLM to plan the steps needed to accomplish a web task.
        
        Args:
            goal: What to accomplish
            context: Additional context (e.g., starting URL, credentials)
            
        Returns:
            List of steps with actions
        """
        prompt = f"""You are a web automation planner. Given a goal, break it down into specific browser actions.

Goal: {goal}

Context: {context or 'None provided'}

Break this down into a series of browser actions. Each step should be one of:
- navigate: Go to a URL
- click: Click an element (provide selector)
- type: Type text into a field (provide selector and text)
- wait: Wait for element or time
- extract: Extract data from page (provide what to extract)
- verify: Check if something is true

Return a JSON array of steps like:
[
  {{"action": "navigate", "url": "https://example.com"}},
  {{"action": "click", "selector": "#login-button"}},
  {{"action": "type", "selector": "#username", "text": "user@example.com"}},
  ...
]
"""
        
        response = await self.openai_client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": "You are a web automation expert."},
                {"role": "user", "content": prompt}
            ],
            response_format={"type": "json_object"}
        )
        
        import json
        result = json.loads(response.choices[0].message.content)
        return result.get("steps", [])
    
    async def execute_step(
        self,
        page: Page,
        step: Dict
    ) -> Dict:
        """
        Execute a single automation step.
        
        Args:
            page: Playwright page object
            step: Step definition
            
        Returns:
            Result of the step
        """
        action = step.get("action")
        
        activity.heartbeat(f"Executing: {action}")
        
        try:
            if action == "navigate":
                await page.goto(step["url"], wait_until="networkidle")
                return {"success": True, "action": action, "url": step["url"]}
            
            elif action == "click":
                await page.click(step["selector"])
                await page.wait_for_load_state("networkidle")
                return {"success": True, "action": action, "selector": step["selector"]}
            
            elif action == "type":
                await page.fill(step["selector"], step["text"])
                return {
                    "success": True,
                    "action": action,
                    "selector": step["selector"]
                }
            
            elif action == "wait":
                if "selector" in step:
                    await page.wait_for_selector(step["selector"])
                elif "time" in step:
                    await page.wait_for_timeout(step["time"] * 1000)
                return {"success": True, "action": action}
            
            elif action == "extract":
                # Extract data based on selectors
                data = {}
                for key, selector in step.get("selectors", {}).items():
                    element = await page.query_selector(selector)
                    if element:
                        data[key] = await element.inner_text()
                
                return {
                    "success": True,
                    "action": action,
                    "data": data
                }
            
            elif action == "verify":
                # Check if condition is met
                selector = step.get("selector")
                if selector:
                    element = await page.query_selector(selector)
                    verified = element is not None
                else:
                    verified = False
                
                return {
                    "success": True,
                    "action": action,
                    "verified": verified
                }
            
            else:
                return {
                    "success": False,
                    "action": action,
                    "error": f"Unknown action: {action}"
                }
        
        except Exception as e:
            logger.error("Step execution failed", action=action, error=str(e))
            return {
                "success": False,
                "action": action,
                "error": str(e)
            }
    
    async def accomplish_task(
        self,
        goal: str,
        context: Optional[Dict] = None,
        headless: bool = True
    ) -> Dict:
        """
        Accomplish a web task end-to-end.
        
        Args:
            goal: What to accomplish
            context: Additional context
            headless: Run browser in headless mode
            
        Returns:
            Task result with steps and outcome
        """
        try:
            activity.heartbeat(f"Planning web task: {goal}")
            
            # Plan the task
            steps = await self.plan_task(goal, context)
            
            logger.info("Task planned", goal=goal, step_count=len(steps))
            
            # Execute with browser
            async with async_playwright() as p:
                browser: Browser = await p.chromium.launch(headless=headless)
                page: Page = await browser.new_page()
                
                results = []
                
                for i, step in enumerate(steps):
                    activity.heartbeat(f"Step {i+1}/{len(steps)}: {step.get('action')}")
                    
                    result = await self.execute_step(page, step)
                    results.append(result)
                    
                    # Stop if step failed
                    if not result.get("success"):
                        logger.error(
                            "Step failed, stopping task",
                            step=i+1,
                            error=result.get("error")
                        )
                        break
                
                # Get final page state
                final_url = page.url
                final_title = await page.title()
                
                await browser.close()
            
            # Determine overall success
            success = all(r.get("success") for r in results)
            
            outcome = {
                "success": success,
                "goal": goal,
                "steps_executed": len(results),
                "steps_planned": len(steps),
                "final_url": final_url,
                "final_title": final_title,
                "results": results
            }
            
            logger.info(
                "Web task complete",
                goal=goal,
                success=success,
                steps=len(results)
            )
            
            return outcome
            
        except Exception as e:
            logger.error("Web task failed", goal=goal, error=str(e))
            return {
                "success": False,
                "goal": goal,
                "error": str(e)
            }


# Singleton instance
_web_task_executor: Optional[WebTaskExecutor] = None


def get_web_task_executor() -> WebTaskExecutor:
    """Get or create web task executor singleton."""
    global _web_task_executor
    if _web_task_executor is None:
        _web_task_executor = WebTaskExecutor()
    return _web_task_executor


@activity.defn
async def accomplish_web_task(
    goal: str,
    context: Optional[Dict] = None,
    headless: bool = True
) -> Dict:
    """
    Activity: Accomplish a web task via browser automation.
    
    Args:
        goal: What to accomplish
        context: Additional context (URLs, credentials, etc.)
        headless: Run browser in headless mode
        
    Returns:
        Task result with steps and outcome
    """
    executor = get_web_task_executor()
    return await executor.accomplish_task(goal, context, headless)

