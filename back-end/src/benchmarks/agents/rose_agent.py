"""
Rose Agent for Harbor Terminal-Bench
Calls Rose completions API instead of Anthropic directly
"""
import json
import os
import requests
from pathlib import Path
from typing import Any

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
# No need to import trajectory models - Harbor manages them via context


class RoseAgent(BaseAgent):
    """
    Harbor agent that uses Rose completions API
    Compatible with Terminal-Bench and other Harbor benchmarks
    """
    
    def __init__(self, model_name: str | None = None, *args, **kwargs):
        super().__init__(model_name=model_name, *args, **kwargs)
        self.rose_api_url = os.environ.get('ROSE_API_URL', 'http://localhost:54321/functions/v1/completions')
        self.rose_api_key = os.environ.get('ROSE_API_KEY', '')
        self.max_iterations = int(os.environ.get('ROSE_MAX_ITERATIONS', '25'))
    
    @staticmethod
    def name() -> str:
        return "rose-agent"
    
    def version(self) -> str | None:
        return "1.0.0"
    
    async def setup(self, environment: BaseEnvironment) -> None:
        """Setup is a no-op for Rose agent - we call API externally"""
        pass
    
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        """
        Run Rose agent to complete the task
        Uses agentic loop: observe → think → act → repeat
        """
        # Read API credentials from environment at runtime (not from __init__)
        # This ensures we get the values even if the agent was instantiated before env vars were set
        rose_api_key = os.environ.get('ROSE_API_KEY', '')
        rose_api_url = os.environ.get('ROSE_API_URL', self.rose_api_url)
        supabase_service_key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY', '')
        max_iterations = int(os.environ.get('ROSE_MAX_ITERATIONS', str(self.max_iterations)))
        
        print(f"[Rose Agent] Starting with model: {self.model_name}")
        print(f"[Rose Agent] API URL: {rose_api_url}")
        print(f"[Rose Agent] API Key (first 10 chars): {rose_api_key[:10]}..." if rose_api_key else "[Rose Agent] ❌ API Key: NOT SET")
        print(f"[Rose Agent] Max iterations: {max_iterations}")
        
        if not rose_api_key:
            raise ValueError("ROSE_API_KEY environment variable must be set to run the agent")
        
        # Note: Trajectory will be populated by Harbor based on context updates
        # We don't need to manually create it
        
        system_prompt = """You are a helpful AI assistant with access to a Linux terminal.
You can execute bash commands to complete tasks.

After each command, you will see its output. Think carefully about what to do next.

When the task is complete, respond with: TASK_COMPLETE

Available commands:
- Any bash command (ls, cat, mkdir, curl, python, etc.)
- Use && to chain commands
- Be careful with permissions and paths
"""
        
        conversation_history = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"Task: {instruction}\n\nPlease complete this task step by step."}
        ]
        
        step_id = 0
        
        for iteration in range(max_iterations):
            step_id += 1
            
            # Call Rose completions API
            try:
                request_body = {
                    'model': self.model_name or 'rose-labs/rose-1-fast',
                    'messages': conversation_history,
                    'temperature': 0.7,
                    'max_tokens': 2000
                }
                
                response = requests.post(
                    rose_api_url,
                    headers={
                        'Content-Type': 'application/json',
                        'Authorization': f'Bearer {supabase_service_key}',
                        'x-api-key': rose_api_key
                    },
                    json=request_body,
                    timeout=60
                )
                
                # Log errors BEFORE raising
                if not response.ok:
                    print(f"❌ API Error {response.status_code}: {response.reason}")
                    try:
                        error_body = response.json()
                        print(f"   Error details: {json.dumps(error_body, indent=2)}")
                    except:
                        print(f"   Raw response: {response.text[:500]}")
                    
                    print(f"   Request had {len(conversation_history)} messages")
                    print(f"   Last user message length: {len(conversation_history[-1]['content']) if conversation_history else 0}")
                    if len(conversation_history) >= 2:
                        print(f"   Last assistant message length: {len(conversation_history[-2]['content'])}")
                
                response.raise_for_status()
                
                data = response.json()
                assistant_message = data['choices'][0]['message']['content']
                print(f"🤖 Model response: {assistant_message[:200]}...")
                
                conversation_history.append({
                    "role": "assistant",
                    "content": assistant_message
                })
                
                # Check if task is complete
                if 'TASK_COMPLETE' in assistant_message:
                    print(f"✅ Task completed after {iteration + 1} iterations")
                    break
                
                # Extract bash commands from response
                commands = self._extract_commands(assistant_message)
                
                if not commands:
                    # No commands found, ask for clarification
                    conversation_history.append({
                        "role": "user",
                        "content": "No bash commands found in your response. Please provide the next command to execute."
                    })
                    continue
                
                # Execute commands and collect output
                all_output = []
                for cmd in commands:
                    print(f"🔧 Executing: {cmd}")
                    result = await environment.exec(cmd)
                    
                    # Get exit code (different Harbor versions use different names)
                    exit_code = getattr(result, 'exit_code', getattr(result, 'exitcode', getattr(result, 'returncode', 0)))
                    
                    output = f"$ {cmd}\n{result.stdout}"
                    if result.stderr:
                        output += f"\nSTDERR: {result.stderr}"
                    if exit_code != 0:
                        output += f"\nExit code: {exit_code}"
                    all_output.append(output)
                    print(f"   Exit code: {exit_code}")
                
                # Send output back to agent
                conversation_history.append({
                    "role": "user",
                    "content": f"Command output:\n{chr(10).join(all_output)}\n\nWhat's the next step?"
                })
                
            except Exception as e:
                print(f"❌ Error in iteration {iteration}: {e}")
                import traceback
                traceback.print_exc()
                break
        
        # Harbor will finalize the trajectory based on context updates
        print(f"🏁 Rose Agent completed after {iteration + 1} iterations")
    
    def _extract_commands(self, text: str) -> list[str]:
        """
        Extract bash commands from model response
        Looks for ```bash code blocks or lines starting with $
        """
        commands = []
        
        # Look for code blocks
        lines = text.split('\n')
        in_code_block = False
        code_lang = None
        
        for line in lines:
            stripped = line.strip()
            
            # Check for code block start/end
            if stripped.startswith('```'):
                if not in_code_block:
                    in_code_block = True
                    code_lang = stripped[3:].strip().lower()
                else:
                    in_code_block = False
                    code_lang = None
                continue
            
            # Extract command from code block
            if in_code_block and (code_lang in ['', 'bash', 'sh', 'shell']):
                if stripped and not stripped.startswith('#'):
                    # Remove leading $ if present
                    cmd = stripped.lstrip('$').strip()
                    if cmd:
                        commands.append(cmd)
            
            # Extract command from $ prefix (outside code blocks)
            elif not in_code_block and stripped.startswith('$'):
                cmd = stripped[1:].strip()
                if cmd:
                    commands.append(cmd)
        
        return commands

