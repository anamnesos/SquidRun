#!/usr/bin/env python3
"""
Hivemind SDK - Multi-agent orchestration using Claude Agent SDK

This replaces the entire ui/ terminal-daemon architecture with ~150 lines.
"""

import asyncio
import sys
import os
from pathlib import Path
from typing import Optional, Dict, List, Any, Callable

# Fix Windows console encoding for emoji/unicode
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')  # type: ignore[union-attr]
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')  # type: ignore[union-attr]
    os.environ.setdefault('PYTHONIOENCODING', 'utf-8')

try:
    from claude_agent_sdk import query, ClaudeAgentOptions, AgentDefinition
except ImportError:
    print("ERROR: Claude Agent SDK not installed")
    print("Run: pip install claude-agent-sdk")
    sys.exit(1)


# =============================================================================
# AGENT DEFINITIONS
# =============================================================================

AGENTS = {
    "worker-a": AgentDefinition(
        description="UI and renderer specialist. Handles frontend code, HTML, CSS, and renderer.js.",
        prompt="""You are Worker A in the Hivemind system.

Your responsibilities:
- UI components and layout (index.html)
- Renderer logic (renderer.js)
- Frontend modules (modules/terminal.js, modules/tabs.js, etc.)
- CSS and styling

Rules:
- Only modify files in your domain
- Report completion back to Lead
- Coordinate with Worker B on shared interfaces
""",
        tools=["Read", "Edit", "Write", "Glob", "Grep"]
    ),

    "worker-b": AgentDefinition(
        description="Backend and daemon specialist. Handles Node.js backend, file watchers, and system integration.",
        prompt="""You are Worker B in the Hivemind system.

Your responsibilities:
- Terminal daemon (terminal-daemon.js)
- Daemon client (daemon-client.js)
- File watchers (modules/watcher.js)
- IPC handlers (modules/ipc-handlers.js)
- System integration

Rules:
- Only modify files in your domain
- Report completion back to Lead
- Coordinate with Worker A on shared interfaces
""",
        tools=["Read", "Edit", "Write", "Bash", "Glob", "Grep"]
    ),

    "reviewer": AgentDefinition(
        description="Code reviewer and quality assurance. Reviews changes for bugs, security, and best practices.",
        prompt="""You are the Reviewer in the Hivemind system.

Your responsibilities:
- Review all code changes for quality
- Check for bugs and security issues
- Verify implementations match requirements
- Write verification reports to workspace/build/reviews/

Rules:
- READ-ONLY access to code (no edits)
- Be thorough but concise
- Flag blockers in workspace/build/blockers.md
- Approve or reject with clear reasoning
""",
        tools=["Read", "Glob", "Grep"]  # Read-only!
    ),
}


# =============================================================================
# ORCHESTRATOR (LEAD)
# =============================================================================

LEAD_SYSTEM_PROMPT = """You are the Lead orchestrator in the Hivemind multi-agent system.

Your role:
- Break down user requests into tasks
- Assign tasks to Worker A (UI), Worker B (backend), or Reviewer
- Coordinate handoffs between agents
- Track progress and resolve blockers

Available agents:
- worker-a: UI/frontend specialist (renderer.js, index.html, CSS)
- worker-b: Backend specialist (daemon, watchers, IPC)
- reviewer: Code reviewer (read-only, quality checks)

Workflow:
1. Analyze the user's request
2. Create a plan with task assignments
3. Delegate to appropriate agents using the Task tool
4. Collect results and coordinate next steps
5. Have Reviewer verify before marking complete

Always use the Task tool to delegate work. Don't try to do everything yourself.
"""


async def run_hivemind(user_prompt: str, workspace: Optional[Path] = None):
    """
    Run the Hivemind orchestrator with the given prompt.

    Args:
        user_prompt: The task/request from the user
        workspace: Working directory (defaults to current)
    """
    workspace = workspace or Path.cwd()

    print(f"\n{'='*60}")
    print(f"HIVEMIND SDK - Starting orchestration")
    print(f"{'='*60}")
    print(f"Workspace: {workspace}")
    print(f"Task: {user_prompt[:100]}...")
    print(f"{'='*60}\n")

    session_id = None

    try:
        async for message in query(
            prompt=user_prompt,
            options=ClaudeAgentOptions(
                # Lead can read, search, and spawn subagents
                allowed_tools=["Read", "Glob", "Grep", "Task"],

                # Subagent definitions
                agents=AGENTS,

                # System prompt for Lead
                system_prompt=LEAD_SYSTEM_PROMPT,

                # Working directory
                cwd=str(workspace),

                # Accept edits without prompting (subagents handle their own permissions)
                permission_mode="acceptEdits",
            )
        ):
            # Capture session ID (comes from ResultMessage)
            if hasattr(message, 'session_id') and message.session_id:
                session_id = message.session_id
                print(f"[Session: {session_id}]")

            # Print based on message type
            msg_type = getattr(message, 'type', None)

            if msg_type == 'assistant':
                # Main orchestrator output
                content = getattr(message, 'content', None)
                if content:
                    # Content might be a list of blocks or a string
                    if isinstance(content, list):
                        for block in content:
                            if hasattr(block, 'text'):
                                print(f"\n[LEAD]: {block.text}")
                    else:
                        print(f"\n[LEAD]: {content}")

            elif msg_type == 'tool_use':
                # Tool being invoked
                name = getattr(message, 'name', '')
                if name == 'Task':
                    inp = getattr(message, 'input', {})
                    agent_name = inp.get('subagent_type', inp.get('agent', 'unknown'))
                    print(f"\n[DELEGATING TO {agent_name.upper()}]")
                else:
                    print(f"\n[TOOL: {name}]")

            # Final result
            if hasattr(message, 'result'):
                print(f"\n{'='*60}")
                print(f"RESULT:")
                print(f"{'='*60}")
                print(message.result)

    except Exception as e:
        print(f"\n[ERROR]: {e}")
        import traceback
        traceback.print_exc()

    return session_id


async def resume_session(session_id: str, follow_up: str):
    """
    Resume a previous session with a follow-up prompt.

    Args:
        session_id: The session ID from a previous run
        follow_up: The follow-up prompt
    """
    print(f"\n[Resuming session: {session_id}]")

    async for message in query(
        prompt=follow_up,
        options=ClaudeAgentOptions(
            resume=session_id,
            agents=AGENTS,
        )
    ):
        if hasattr(message, 'result'):
            print(message.result)


# =============================================================================
# TASK #3: MULTI-AGENT CO[private-live-ops]NATION
# =============================================================================

class HivemindCoordinator:
    """
    Coordinator for parallel multi-agent execution and broadcast.

    Provides:
    - Broadcast: Send same message to all agents simultaneously
    - Parallel execution: Run multiple agents concurrently
    - Message callbacks: Hook for UI integration
    """

    def __init__(self, workspace: Optional[Path] = None, on_message: Optional[Callable[[int, Any], None]] = None):
        """
        Args:
            workspace: Working directory
            on_message: Callback for each message (pane_id, message) -> None
        """
        self.workspace = workspace or Path.cwd()
        self.on_message = on_message or self._default_message_handler
        self.sessions: Dict[str, str] = {}  # agent_name -> session_id

    def _default_message_handler(self, pane_id: int, message):
        """Default handler prints to console."""
        msg_type = getattr(message, 'type', 'unknown')
        print(f"[Pane {pane_id}] {msg_type}: {message}")

    async def run_agent(self, agent_name: str, prompt: str, pane_id: int):
        """
        Run a single agent and stream messages to callback.

        Args:
            agent_name: Name of agent ('worker-a', 'worker-b', 'reviewer')
            prompt: The task prompt
            pane_id: UI pane ID for message routing
        """
        agent_def = AGENTS.get(agent_name)
        if not agent_def:
            raise ValueError(f"Unknown agent: {agent_name}")

        session_id = self.sessions.get(agent_name)

        options = ClaudeAgentOptions(
            allowed_tools=agent_def.tools or [],
            system_prompt=agent_def.prompt,
            cwd=str(self.workspace),
            permission_mode="acceptEdits",
        )

        # Resume if we have a session
        if session_id:
            options.resume = session_id

        async for message in query(prompt=prompt, options=options):
            # Capture session ID
            if hasattr(message, 'session_id') and message.session_id:
                self.sessions[agent_name] = message.session_id

            # Route to UI callback
            self.on_message(pane_id, message)

            # Yield for async iteration
            yield message

    async def broadcast(self, prompt: str, agents: Optional[List[str]] = None):
        """
        Broadcast a message to multiple agents in parallel.

        Args:
            prompt: Message to send to all agents
            agents: List of agent names (default: all workers + reviewer)

        Returns:
            Dict of agent_name -> list of messages
        """
        if agents is None:
            agents = ['worker-a', 'worker-b', 'reviewer']

        # Map agents to pane IDs (Lead=1, Worker-A=2, Worker-B=3, Reviewer=4)
        pane_map = {
            'lead': 1,
            'worker-a': 2,
            'worker-b': 3,
            'reviewer': 4,
        }

        async def collect_agent_messages(agent_name):
            """Collect all messages from one agent."""
            messages = []
            pane_id = pane_map.get(agent_name, 0)
            async for msg in self.run_agent(agent_name, prompt, pane_id):
                messages.append(msg)
            return agent_name, messages

        # Run all agents in parallel
        tasks = [collect_agent_messages(name) for name in agents]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        # Collect results
        output: Dict[str, List[Any]] = {}
        for result in results:
            if isinstance(result, BaseException):
                print(f"[ERROR] Agent failed: {result}")
            else:
                agent_name, messages = result  # type: ignore[misc]
                output[agent_name] = messages

        return output

    async def run_lead(self, prompt: str):
        """
        Run the Lead orchestrator (can delegate to other agents).

        This is the main entry point for complex tasks that need coordination.
        """
        async for message in self.run_agent('lead', prompt, pane_id=1):
            yield message

    def get_sessions(self):
        """Return all active session IDs."""
        return dict(self.sessions)

    def clear_sessions(self):
        """Clear all session state (start fresh)."""
        self.sessions = {}


# Add Lead as an agent for the coordinator
AGENTS['lead'] = AgentDefinition(
    description="Lead orchestrator. Coordinates tasks between Worker A, Worker B, and Reviewer.",
    prompt=LEAD_SYSTEM_PROMPT,
    tools=["Read", "Glob", "Grep", "Task"]
)


# =============================================================================
# CLI INTERFACE
# =============================================================================

async def test_broadcast():
    """Test broadcast functionality."""
    print("\n" + "="*60)
    print("BROADCAST TEST - Sending to all agents")
    print("="*60 + "\n")

    coordinator = HivemindCoordinator()

    results = await coordinator.broadcast(
        "Acknowledge receipt. Reply with your role name and 'ready'.",
        agents=['worker-a', 'worker-b', 'reviewer']
    )

    print("\n" + "="*60)
    print("BROADCAST RESULTS")
    print("="*60)
    for agent, messages in results.items():
        print(f"\n[{agent.upper()}]: {len(messages)} messages received")

    return results


def main():
    """CLI entry point."""
    import argparse

    parser = argparse.ArgumentParser(
        description="Hivemind SDK - Multi-agent orchestration",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python hivemind-sdk.py "Add a logout button to the UI"
  python hivemind-sdk.py "Fix the bug in terminal.js" --workspace ./ui
  python hivemind-sdk.py "Review all recent changes" --resume abc123
  python hivemind-sdk.py --broadcast "sync - report your status"
  python hivemind-sdk.py --test-broadcast
        """
    )

    parser.add_argument(
        "prompt",
        nargs="?",
        help="The task/request to execute"
    )

    parser.add_argument(
        "--workspace", "-w",
        type=Path,
        default=Path.cwd(),
        help="Working directory (default: current)"
    )

    parser.add_argument(
        "--resume", "-r",
        type=str,
        help="Resume a previous session by ID"
    )

    parser.add_argument(
        "--interactive", "-i",
        action="store_true",
        help="Interactive mode (multiple prompts)"
    )

    parser.add_argument(
        "--broadcast", "-b",
        action="store_true",
        help="Broadcast prompt to all agents in parallel"
    )

    parser.add_argument(
        "--test-broadcast",
        action="store_true",
        help="Run broadcast test (agents acknowledge)"
    )

    args = parser.parse_args()

    # Test broadcast mode
    if args.test_broadcast:
        asyncio.run(test_broadcast())
        return

    # Broadcast mode
    if args.broadcast and args.prompt:
        coordinator = HivemindCoordinator(workspace=args.workspace)
        asyncio.run(coordinator.broadcast(args.prompt))
        return

    if args.interactive:
        # Interactive REPL mode
        print("Hivemind SDK - Interactive Mode")
        print("Type 'exit' to quit, 'help' for commands\n")

        session_id = None

        while True:
            try:
                prompt = input("hivemind> ").strip()

                if not prompt:
                    continue
                elif prompt.lower() == 'exit':
                    break
                elif prompt.lower() == 'help':
                    print("Commands:")
                    print("  exit     - Quit")
                    print("  session  - Show current session ID")
                    print("  <task>   - Run a task")
                    continue
                elif prompt.lower() == 'session':
                    print(f"Session: {session_id or 'None'}")
                    continue

                # Run the task
                if session_id:
                    asyncio.run(resume_session(session_id, prompt))
                else:
                    session_id = asyncio.run(run_hivemind(prompt, args.workspace))

            except KeyboardInterrupt:
                print("\nInterrupted")
                break
            except EOFError:
                break

    elif args.resume and args.prompt:
        # Resume mode
        asyncio.run(resume_session(args.resume, args.prompt))

    elif args.prompt:
        # Single task mode
        asyncio.run(run_hivemind(args.prompt, args.workspace))

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
