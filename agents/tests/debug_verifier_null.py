"""
Debug script to identify NULL values in verifier context.

Usage:
    cd agents
    python tests/debug_verifier_null.py c71f878e-ae38-47c7-92cf-67d2a49ce01a
"""

import asyncio
import sys
import json
from pathlib import Path
from datetime import datetime, timezone

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from dotenv import load_dotenv
load_dotenv()

from config import load_config
from helpers.llm import convert_context_to_messages
from helpers.fetch_config import _fetch_agent_data_impl


async def fetch_and_analyze(agent_id: str):
    """Fetch messages from DB and analyze for None values."""
    
    print(f"\n{'='*60}")
    print(f"🔍 Analyzing agent: {agent_id}")
    print(f"{'='*60}\n")
    
    # 1. Fetch raw data from backend
    print("1️⃣ Fetching data from backend API...")
    try:
        data = await _fetch_agent_data_impl(agent_id)
        print(f"   ✅ Fetched successfully")
    except Exception as e:
        print(f"   ❌ Failed to fetch: {e}")
        return
    
    # 2. Extract messages
    raw_messages = data.get('messages', [])
    print(f"\n2️⃣ Raw messages from API: {len(raw_messages)} messages")
    
    # 3. Check for None values in raw messages
    print(f"\n3️⃣ Checking for None values in raw messages...")
    none_indices = []
    for i, msg in enumerate(raw_messages):
        if msg is None:
            none_indices.append(i)
            print(f"   ❌ raw_messages[{i}] is None!")
        elif not isinstance(msg, dict):
            print(f"   ⚠️ raw_messages[{i}] is {type(msg).__name__}, not dict: {str(msg)[:100]}")
    
    if not none_indices:
        print(f"   ✅ No None values in raw messages")
    
    # 4. Convert to workflow context format (what run_agent uses)
    print(f"\n4️⃣ Converting to workflow context format...")
    context = []
    for msg in raw_messages:
        if msg is None:
            print(f"   ⚠️ Skipping None message")
            continue
        context.append({
            "role": msg.get("role", "UNKNOWN"),
            "text": msg.get("text", ""),
            "timestamp": msg.get("timestamp", ""),
            "metadata": msg.get("metadata", {})
        })
    print(f"   Created context with {len(context)} messages")
    
    # 5. Check for None values in context
    print(f"\n5️⃣ Checking for None values in context...")
    none_indices_ctx = []
    for i, msg in enumerate(context):
        if msg is None:
            none_indices_ctx.append(i)
            print(f"   ❌ context[{i}] is None!")
        elif not isinstance(msg, dict):
            print(f"   ⚠️ context[{i}] is {type(msg).__name__}, not dict")
    
    if not none_indices_ctx:
        print(f"   ✅ No None values in context")
    
    # 6. Try convert_context_to_messages (this is what check_progress uses)
    print(f"\n6️⃣ Testing convert_context_to_messages...")
    try:
        openai_messages = convert_context_to_messages(context, include_system=False)
        print(f"   ✅ Converted to {len(openai_messages)} OpenAI messages")
    except Exception as e:
        print(f"   ❌ Failed to convert: {e}")
        print(f"   This is likely where the error occurs!")
        
        # Find the problematic message - deep inspection
        print(f"\n   🔍 Deep inspection of each message...")
        for i, msg in enumerate(context):
            print(f"\n   --- Message {i} ---")
            try:
                print(f"   Type: {type(msg)}")
                if msg is None:
                    print(f"   ❌ Message is None!")
                    continue
                    
                role = msg.get('role')
                text = msg.get('text', '')[:100]
                metadata = msg.get('metadata')
                
                print(f"   Role: {role}")
                print(f"   Text: {text}...")
                print(f"   Metadata type: {type(metadata)}")
                
                if metadata is None:
                    print(f"   ⚠️ Metadata is None")
                elif isinstance(metadata, dict):
                    print(f"   Metadata keys: {list(metadata.keys())}")
                    # Check tool_calls in metadata
                    tool_calls = metadata.get('tool_calls')
                    if tool_calls is not None:
                        print(f"   tool_calls type: {type(tool_calls)}")
                        if isinstance(tool_calls, list):
                            for j, tc in enumerate(tool_calls):
                                print(f"      tool_calls[{j}] type: {type(tc)}")
                                if tc is None:
                                    print(f"      ❌ tool_calls[{j}] is None!")
                                elif isinstance(tc, dict):
                                    print(f"      tool_calls[{j}] keys: {list(tc.keys())}")
                                else:
                                    print(f"      tool_calls[{j}] value: {tc}")
                else:
                    print(f"   Metadata value: {metadata}")
            except Exception as inner_e:
                print(f"   ❌ Error inspecting: {inner_e}")
                import traceback
                traceback.print_exc()
        return
    
    # 7. Simulate the verifier logging (this is the exact code that fails)
    print(f"\n7️⃣ Simulating verifier logging (the exact code that fails)...")
    try:
        # This is the exact code from check_progress lines 1066-1068
        agent_messages = len([m for m in context if m.get('role') == 'ASSISTANT'])
        system_messages = len([m for m in context if m.get('role') == 'SYSTEM'])
        context_summary = [f"{m.get('role')}: {m.get('text', '')[:50]}..." for m in context[-5:]]
        
        print(f"   ✅ No crash! Stats:")
        print(f"      ASSISTANT messages: {agent_messages}")
        print(f"      SYSTEM messages: {system_messages}")
        print(f"      Last 5 messages: {context_summary}")
    except Exception as e:
        print(f"   ❌ Crashed: {e}")
        print(f"   This is the exact error location!")
    
    # 8. Print message summary
    print(f"\n8️⃣ Message Summary:")
    roles = {}
    for msg in context:
        role = msg.get('role', 'UNKNOWN') if isinstance(msg, dict) else 'NOT_DICT'
        roles[role] = roles.get(role, 0) + 1
    for role, count in sorted(roles.items()):
        print(f"   {role}: {count}")
    
    # 9. Print last 10 messages for debugging
    print(f"\n9️⃣ Last 10 messages:")
    for i, msg in enumerate(context[-10:]):
        idx = len(context) - 10 + i
        if msg is None:
            print(f"   [{idx}] ❌ None")
        elif isinstance(msg, dict):
            role = msg.get('role', '?')
            text = msg.get('text', '')[:80]
            metadata = msg.get('metadata', {}) or {}  # Handle explicit None
            tool_name = metadata.get('toolName', '')
            tool_status = metadata.get('toolStatus', '')
            suffix = f" [{tool_name}:{tool_status}]" if tool_name else ""
            print(f"   [{idx}] {role}{suffix}: {text}...")
        else:
            print(f"   [{idx}] ⚠️ {type(msg).__name__}: {str(msg)[:80]}")
    
    print(f"\n{'='*60}")
    print(f"✅ Analysis complete")
    print(f"{'='*60}\n")


async def main():
    if len(sys.argv) < 2:
        print("Usage: python tests/debug_verifier_null.py <agent_id>")
        print("Example: python tests/debug_verifier_null.py c71f878e-ae38-47c7-92cf-67d2a49ce01a")
        sys.exit(1)
    
    agent_id = sys.argv[1]
    await fetch_and_analyze(agent_id)


if __name__ == "__main__":
    asyncio.run(main())

