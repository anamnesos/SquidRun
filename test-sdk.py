#!/usr/bin/env python3
"""Minimal SDK test to find the actual error."""
import asyncio
import sys
import os

# Fix Windows console
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

from claude_agent_sdk import ClaudeSDKClient, ClaudeAgentOptions

async def test():
    print("Creating client...")
    options = ClaudeAgentOptions(
        allowed_tools=["Read", "Glob", "Grep"],
        permission_mode="bypassPermissions",
        cwd=os.getcwd(),
    )

    client = ClaudeSDKClient(options)

    print("Connecting...")
    try:
        await client.connect()
        print("Connected!")

        print("Sending query...")
        await client.query("say hello in 5 words or less")

        print("Reading response...")
        async for msg in client.receive_response():
            print(f"MSG: {type(msg).__name__}: {msg}")

        print("Done!")
    except Exception as e:
        print(f"ERROR: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
    finally:
        print("Disconnecting...")
        await client.disconnect()

if __name__ == "__main__":
    asyncio.run(test())
