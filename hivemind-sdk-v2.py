#!/usr/bin/env python3
"""
Hivemind SDK V2 - 4 Independent Claude Sessions

Architecture: 4 persistent ClaudeSDKClient instances (NOT subagents)
- Each agent has its own full context window
- Sessions persist across app restarts
- Context compacts independently per agent

This replaces the PTY/keyboard event approach with reliable SDK API calls.
"""

import asyncio
import json
import sys
import os
from datetime import datetime
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional, Dict, Any, AsyncIterator, List, Literal

# Fix Windows console encoding
if sys.platform == 'win32':
    # Type ignore needed: reconfigure exists at runtime but TextIO stub doesn't include it
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')  # type: ignore[union-attr]
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')  # type: ignore[union-attr]
    os.environ.setdefault('PYTHONIOENCODING', 'utf-8')

try:
    from claude_agent_sdk import (
        ClaudeSDKClient,
        ClaudeAgentOptions,
        # Message types - handle ALL of them
        AssistantMessage,
        ResultMessage,
        SystemMessage,  # CRITICAL: Contains session_id at start
        UserMessage,
        # Content blocks
        TextBlock,
        ToolUseBlock,
        ToolResultBlock,
        ThinkingBlock,  # For extended thinking
    )
except ImportError:
    print(json.dumps({"type": "error", "message": "Claude Agent SDK not installed. Run: pip install claude-agent-sdk"}))
    sys.exit(1)


# =============================================================================
# UNICODE SANITIZATION - Prevent API 400 errors from bad surrogates
# =============================================================================

def sanitize_unicode(text: str) -> str:
    """
    Remove invalid Unicode surrogates that cause API 400 errors.

    The Claude API rejects JSON with unpaired UTF-16 surrogates (0xD800-0xDFFF).
    This can happen when reading binary files or files with encoding issues.
    """
    if not text:
        return text
    # Encode to UTF-8 with surrogateescape, then decode back
    # This replaces unpaired surrogates with the replacement character
    try:
        return text.encode('utf-8', errors='surrogatepass').decode('utf-8', errors='replace')
    except (UnicodeEncodeError, UnicodeDecodeError):
        # Fallback: strip all non-BMP characters
        return ''.join(c for c in text if ord(c) < 0x10000 and not (0xD800 <= ord(c) <= 0xDFFF))


# =============================================================================
# AGENT CONFIGURATION
# =============================================================================

PermissionMode = Literal['default', 'acceptEdits', 'plan', 'bypassPermissions']

@dataclass
class AgentConfig:
    """Configuration for a single Hivemind agent."""
    role: str
    pane_id: str
    allowed_tools: List[str] = field(default_factory=list)
    # V2 FIX: Use bypassPermissions for all agents - acceptEdits still prompts for reads
    permission_mode: PermissionMode = "bypassPermissions"

    # Reviewer is read-only
    @classmethod
    def lead(cls):
        return cls(
            role="Lead",
            pane_id="1",
            allowed_tools=["Read", "Edit", "Write", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"],
        )

    @classmethod
    def worker_a(cls):
        return cls(
            role="Worker A",
            pane_id="2",
            allowed_tools=["Read", "Edit", "Write", "Glob", "Grep"],
        )

    @classmethod
    def worker_b(cls):
        return cls(
            role="Worker B",
            pane_id="3",
            allowed_tools=["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
        )

    @classmethod
    def reviewer(cls):
        return cls(
            role="Reviewer",
            pane_id="4",
            allowed_tools=["Read", "Glob", "Grep"],  # Read-only!
            permission_mode="bypassPermissions",
        )


# =============================================================================
# HIVEMIND AGENT - Single persistent SDK session
# =============================================================================

class HivemindAgent:
    """
    A single Hivemind agent with persistent ClaudeSDKClient session.

    Each agent maintains its own:
    - Context window (compacts independently)
    - Session ID (survives restarts)
    - Tool permissions
    - Conversation history (for context restore on restart)
    """

    def __init__(self, config: AgentConfig, workspace: Path):
        self.config = config
        self.workspace = workspace
        self.client: Optional[ClaudeSDKClient] = None
        self.session_id: Optional[str] = None
        self.connected = False
        self.conversation_history: List[Dict[str, str]] = []  # Recent messages for context restore
        self.history_file = workspace / "workspace" / "history" / f"{config.pane_id}-{config.role.lower().replace(' ', '-')}.jsonl"
        self._pending_context: Optional[str] = None  # Context to inject on first message after restart

    async def connect(self, resume_session_id: Optional[str] = None):
        """
        Connect to SDK and optionally resume a previous session.

        Args:
            resume_session_id: Session ID to resume (from previous app run)
        """
        # V2 FIX: Use role-specific directory so each agent reads its own CLAUDE.md
        # Structure: workspace/instances/{role}/CLAUDE.md
        role_dir_name = self.config.role.lower().replace(' ', '-')  # "Worker A" -> "worker-a"
        role_specific_cwd = self.workspace / "workspace" / "instances" / role_dir_name

        # Fall back to main workspace if role directory doesn't exist
        if not role_specific_cwd.exists():
            role_specific_cwd = self.workspace
            self._emit("warning", {"message": f"Role directory not found: {role_specific_cwd}, using main workspace"})

        # V2 FIX: Don't try to resume sessions - stale session IDs cause "Fatal error in message reader"
        # Session resume is broken in claude-agent-sdk when session no longer exists
        # Better to start fresh each time than crash trying to resume dead sessions
        options = ClaudeAgentOptions(
            allowed_tools=self.config.allowed_tools,
            permission_mode=self.config.permission_mode,
            cwd=str(role_specific_cwd),
            # CRITICAL: setting_sources=["project"] tells Claude to load CLAUDE.md from cwd
            # Without this, agents have NO ROLE IDENTITY and respond as generic Claude
            setting_sources=["project"],
            # NOTE: Disabled resume - causes crashes with stale sessions
            # resume=resume_session_id,
        )

        self.client = ClaudeSDKClient(options)
        await self.client.connect()
        self.connected = True
        self.session_id = resume_session_id

        # Check if we have conversation history to restore
        context_msg = self.get_context_restore_message()
        has_context = context_msg is not None

        self._emit("status", {
            "state": "connected",
            "resumed": resume_session_id is not None,
            "has_history": has_context
        })

        # If we have history, send context restore message as first interaction
        if has_context:
            self._emit("system", {"message": f"Restoring context for {self.config.role}..."})
            # The context will be injected via the first message sent to this agent
            # Store it for injection
            self._pending_context = context_msg

    async def send(self, message: str) -> AsyncIterator[Dict[str, Any]]:
        """
        Send a message to this agent and stream responses.

        Args:
            message: The message to send

        Yields:
            Dict messages for each response chunk
        """
        if not self.client or not self.connected:
            yield {"type": "error", "message": "Agent not connected"}
            return

        # V2 FIX: Sanitize message to prevent API 400 errors from bad Unicode
        clean_message = sanitize_unicode(message)

        # Inject pending context if this is first message after reconnect
        if hasattr(self, '_pending_context') and self._pending_context:
            clean_message = self._pending_context + "\n\n---\n\nUser's current message:\n" + clean_message
            self._pending_context = None  # Clear after injection

        # Save user message to history (without context prefix)
        self._save_to_history("user", sanitize_unicode(message))

        self._emit("status", {"state": "thinking"})

        assistant_response = ""  # Accumulate assistant text for history

        try:
            await self.client.query(clean_message)

            async for msg in self.client.receive_response():
                # Convert SDK message to JSON-serializable dict
                parsed = self._parse_message(msg)
                if parsed:
                    yield parsed

                    # Accumulate assistant text for history
                    if isinstance(msg, AssistantMessage) and msg.content:
                        for block in msg.content:
                            if isinstance(block, TextBlock):
                                assistant_response += block.text + "\n"

                # Capture session ID from SystemMessage (sent at conversation start)
                if isinstance(msg, SystemMessage):
                    if msg.data and 'session_id' in msg.data:
                        self.session_id = msg.data['session_id']

                # Capture session ID from ResultMessage (sent at end)
                if isinstance(msg, ResultMessage):
                    self.session_id = msg.session_id
                    # Save assistant response to history
                    if assistant_response.strip():
                        self._save_to_history("assistant", assistant_response.strip())
                    yield {
                        "type": "result",
                        "session_id": msg.session_id,
                        "total_cost_usd": msg.total_cost_usd,
                        "duration_ms": msg.duration_ms,
                        "num_turns": msg.num_turns,
                        "is_error": msg.is_error,
                    }

        except Exception as e:
            yield {"type": "error", "message": str(e)}

        finally:
            self._emit("status", {"state": "idle"})

    def _parse_message(self, msg: Any) -> Optional[Dict[str, Any]]:
        """Convert SDK message to JSON-serializable dict."""

        if isinstance(msg, AssistantMessage):
            content_parts: List[Dict[str, Any]] = []
            for block in msg.content:
                if isinstance(block, TextBlock):
                    content_parts.append({"type": "text", "text": block.text})
                elif isinstance(block, ThinkingBlock):
                    # Extended thinking output
                    content_parts.append({
                        "type": "thinking",
                        "thinking": block.thinking,
                    })
                elif isinstance(block, ToolUseBlock):
                    content_parts.append({
                        "type": "tool_use",
                        "id": block.id,
                        "name": block.name,
                        "input": block.input,
                    })
                elif isinstance(block, ToolResultBlock):
                    # V2 FIX: block.content may contain non-serializable objects
                    # Convert to string if it's not already a simple type
                    tool_content = block.content
                    if not isinstance(tool_content, (str, int, float, bool, type(None))):
                        if isinstance(tool_content, (list, dict)):
                            try:
                                json.dumps(tool_content)  # Test if serializable
                            except (TypeError, ValueError):
                                tool_content = str(tool_content)
                        else:
                            tool_content = str(tool_content)
                    content_parts.append({
                        "type": "tool_result",
                        "tool_use_id": block.tool_use_id,
                        "content": tool_content,
                        "is_error": block.is_error,
                    })
            return {
                "type": "assistant",
                "content": content_parts,
                "model": getattr(msg, 'model', None),
            }

        elif isinstance(msg, SystemMessage):
            # CRITICAL: SystemMessage contains session info at conversation start
            # subtype can be: 'init', 'session', etc.
            # data dict may contain session_id
            # V2 FIX: Ensure data is JSON serializable
            sys_data: Any = msg.data
            if sys_data:
                try:
                    json.dumps(sys_data)  # Test if serializable
                except (TypeError, ValueError):
                    sys_data = str(sys_data)
            return {
                "type": "system",
                "subtype": msg.subtype,
                "data": sys_data,
            }

        elif isinstance(msg, UserMessage):
            # Echo of user input (if replay-user-messages enabled)
            # V2 FIX: UserMessage.content may be array of blocks, extract text only
            raw_content = getattr(msg, 'content', None)
            if isinstance(raw_content, list):
                # Extract text from content blocks
                text_parts = []
                for block in raw_content:
                    if hasattr(block, 'text'):
                        text_parts.append(block.text)
                    elif isinstance(block, dict) and 'text' in block:
                        text_parts.append(block['text'])
                    elif isinstance(block, str):
                        text_parts.append(block)
                user_content = ' '.join(text_parts) if text_parts else str(msg)
            elif isinstance(raw_content, str):
                user_content = raw_content
            else:
                user_content = str(msg)
            return {
                "type": "user",
                "content": user_content,
            }

        elif isinstance(msg, ResultMessage):
            # Handled separately for session_id capture
            return None

        # Unknown message type - return raw
        return {"type": "unknown", "raw": str(msg)}

    def _emit(self, msg_type: str, data: Dict[str, Any]):
        """Emit a message to stdout for IPC."""
        output = {
            "type": msg_type,
            "pane_id": self.config.pane_id,
            "role": self.config.role,
            **data,
        }
        # V2 FIX: Use safe serialization to handle any non-JSON-serializable objects
        print(json.dumps(output, default=str), flush=True)

    async def disconnect(self) -> Optional[str]:
        """
        Disconnect from SDK.

        Returns:
            Session ID for persistence
        """
        if self.client and self.connected:
            self.connected = False  # Mark disconnected first to prevent re-entry
            try:
                await asyncio.wait_for(self.client.disconnect(), timeout=2.0)
            except asyncio.TimeoutError:
                # Disconnect timed out - client may already be closed
                pass
            except asyncio.CancelledError:
                # Task was cancelled during shutdown - expected
                pass
            except Exception as e:
                # SDK disconnect can fail if connection was already closed
                # This is expected during abrupt shutdowns
                pass
            self._emit("status", {"state": "disconnected"})
        return self.session_id

    def get_session_id(self) -> Optional[str]:
        """Get current session ID for persistence."""
        return self.session_id

    def _save_to_history(self, role: str, content: str):
        """Append a message to conversation history file."""
        try:
            self.history_file.parent.mkdir(parents=True, exist_ok=True)
            entry = {
                "timestamp": datetime.now().isoformat(),
                "role": role,
                "content": content[:2000]  # Limit content size
            }
            with open(self.history_file, 'a', encoding='utf-8') as f:
                f.write(json.dumps(entry, default=str) + '\n')
        except Exception:
            pass  # Don't crash on history save failure

    def _load_history(self, max_entries: int = 20) -> List[Dict[str, str]]:
        """Load recent conversation history from file."""
        try:
            if not self.history_file.exists():
                return []
            entries = []
            with open(self.history_file, 'r', encoding='utf-8') as f:
                for line in f:
                    try:
                        entries.append(json.loads(line.strip()))
                    except json.JSONDecodeError:
                        continue
            return entries[-max_entries:]  # Return last N entries
        except Exception:
            return []

    def get_context_restore_message(self) -> Optional[str]:
        """Generate a context restore message from conversation history."""
        history = self._load_history(15)  # Last 15 messages
        if not history:
            return None

        lines = [f"[HIVEMIND CONTEXT RESTORE - {self.config.role}]"]
        lines.append(f"Previous session ended at {history[-1].get('timestamp', 'unknown')}")
        lines.append("Recent conversation summary:")

        for entry in history:
            role = entry.get('role', 'unknown')
            content = entry.get('content', '')[:200]  # Truncate for summary
            if content:
                lines.append(f"- {role}: {content}...")

        lines.append("[END CONTEXT - Continue from where we left off]")
        return '\n'.join(lines)


# =============================================================================
# HIVEMIND MANAGER - Manages all 4 agents
# =============================================================================

class HivemindManager:
    """
    Manages 4 independent Hivemind agents.

    Handles:
    - Agent lifecycle (connect, disconnect)
    - Message routing
    - Session persistence
    - IPC with Electron
    """

    def __init__(self, workspace: Path):
        self.workspace = workspace
        self.agents: Dict[str, HivemindAgent] = {}
        self.session_file = workspace / "session-state.json"  # V2 FIX: Project root, aligned with sdk-bridge.js

    async def start_all(self):
        """Start all 4 agents, resuming sessions if available."""

        # Load saved sessions
        saved_sessions = self._load_sessions()

        # Create agents
        configs = [
            AgentConfig.lead(),
            AgentConfig.worker_a(),
            AgentConfig.worker_b(),
            AgentConfig.reviewer(),
        ]

        for config in configs:
            agent = HivemindAgent(config, self.workspace)
            self.agents[config.pane_id] = agent

            # Resume if we have a saved session
            resume_id = saved_sessions.get(config.pane_id)

            try:
                await agent.connect(resume_id)
                self._emit("agent_started", {
                    "pane_id": config.pane_id,
                    "role": config.role,
                    "resumed": resume_id is not None,
                })
            except Exception as e:
                self._emit("error", {
                    "pane_id": config.pane_id,
                    "message": f"Failed to start {config.role}: {e}",
                })

    async def stop_all(self):
        """Stop all agents and save sessions."""
        sessions = {}

        for pane_id, agent in self.agents.items():
            try:
                session_id = await agent.disconnect()
                if session_id:
                    sessions[pane_id] = session_id
            except Exception as e:
                # Log but continue stopping other agents
                self._emit("warning", {
                    "pane_id": pane_id,
                    "message": f"Error stopping agent: {e}"
                })

        self._save_sessions(sessions)
        self._emit("all_stopped", {"sessions_saved": len(sessions)})

    async def send_message(self, pane_id: str, message: str):
        """
        Send a message to a specific agent.

        Args:
            pane_id: Target pane ("1", "2", "3", "4")
            message: Message to send
        """
        agent = self.agents.get(pane_id)
        if not agent:
            self._emit("error", {"pane_id": pane_id, "message": "Agent not found"})
            return

        # Confirm message received
        self._emit("message_received", {"pane_id": pane_id})

        # Stream responses
        async for response in agent.send(message):
            response["pane_id"] = pane_id
            # V2 FIX: Use default=str to handle any non-serializable objects
            print(json.dumps(response, default=str), flush=True)

    async def interrupt_agent(self, pane_id: str):
        """
        Interrupt a running agent.

        Args:
            pane_id: Target pane ("1", "2", "3", "4")
        """
        agent = self.agents.get(pane_id)
        if not agent:
            self._emit("error", {"pane_id": pane_id, "message": "Agent not found"})
            return

        if agent.client and agent.connected:
            try:
                await agent.client.interrupt()
                self._emit("interrupted", {"pane_id": pane_id, "role": agent.config.role})
            except Exception as e:
                self._emit("error", {"pane_id": pane_id, "message": f"Interrupt failed: {e}"})

    async def broadcast(self, message: str, exclude_panes: Optional[List[str]] = None):
        """
        Send a message to all agents (or subset).

        Args:
            message: Message to broadcast
            exclude_panes: Pane IDs to exclude
        """
        exclude_panes = exclude_panes or []

        tasks = []
        for pane_id, agent in self.agents.items():
            if pane_id not in exclude_panes:
                tasks.append(self._send_and_collect(pane_id, message))

        await asyncio.gather(*tasks, return_exceptions=True)

    async def _send_and_collect(self, pane_id: str, message: str):
        """Helper to send message and collect responses."""
        async for response in self.agents[pane_id].send(message):
            response["pane_id"] = pane_id
            # V2 FIX: Use default=str to handle any non-serializable objects
            print(json.dumps(response, default=str), flush=True)

    def get_all_sessions(self) -> Dict[str, str]:
        """Get all current session IDs."""
        result: Dict[str, str] = {}
        for pane_id, agent in self.agents.items():
            session_id = agent.get_session_id()
            if session_id is not None:
                result[pane_id] = session_id
        return result

    def _load_sessions(self) -> Dict[str, str]:
        """Load saved sessions from file."""
        try:
            if self.session_file.exists():
                with open(self.session_file, 'r') as f:
                    data = json.load(f)
                    return data.get("sdk_sessions", {})
        except Exception as e:
            self._emit("warning", {"message": f"Failed to load sessions: {e}"})
        return {}

    def _save_sessions(self, sessions: Dict[str, str]):
        """Save sessions to file."""
        try:
            # Load existing file to preserve other data
            existing = {}
            if self.session_file.exists():
                with open(self.session_file, 'r') as f:
                    existing = json.load(f)

            existing["sdk_sessions"] = sessions

            with open(self.session_file, 'w') as f:
                json.dump(existing, f, indent=2)

        except Exception as e:
            self._emit("error", {"message": f"Failed to save sessions: {e}"})

    def _emit(self, msg_type: str, data: Dict[str, Any]):
        """Emit a message to stdout."""
        # V2 FIX: Use default=str to handle any non-serializable objects
        print(json.dumps({"type": msg_type, **data}, default=str), flush=True)


# =============================================================================
# IPC PROTOCOL - Communication with Electron
# =============================================================================

def stdin_reader_thread(queue: 'asyncio.Queue', loop: asyncio.AbstractEventLoop):
    """
    Thread that reads stdin and puts lines into an asyncio queue.

    This avoids Windows asyncio proactor bugs with connect_read_pipe.
    """
    try:
        for line in sys.stdin:
            line = line.strip()
            if line:
                # Thread-safe way to put into asyncio queue
                loop.call_soon_threadsafe(queue.put_nowait, line)
    except Exception as e:
        loop.call_soon_threadsafe(queue.put_nowait, f'__ERROR__:{e}')
    finally:
        # Signal EOF
        loop.call_soon_threadsafe(queue.put_nowait, None)


async def run_ipc_server(manager: HivemindManager):
    """
    Run IPC server reading JSON commands from stdin.

    Protocol:
        Input (from Electron):
            {"command": "send", "pane_id": "1", "message": "hello"}
            {"command": "broadcast", "message": "sync"}
            {"command": "get_sessions"}
            {"command": "stop"}

        Output (to Electron):
            {"type": "assistant", "pane_id": "1", "content": [...]}
            {"type": "status", "pane_id": "1", "state": "thinking"}
            {"type": "result", "pane_id": "1", "session_id": "abc123"}
    """
    import threading

    manager._emit("ready", {"agents": list(manager.agents.keys())})

    # Use thread-based stdin reader to avoid Windows asyncio pipe bugs
    loop = asyncio.get_event_loop()
    queue: asyncio.Queue = asyncio.Queue()

    reader_thread = threading.Thread(
        target=stdin_reader_thread,
        args=(queue, loop),
        daemon=True
    )
    reader_thread.start()

    while True:
        try:
            line = await queue.get()
            if line is None:
                break

            if line.startswith('__ERROR__:'):
                manager._emit("error", {"message": f"stdin error: {line[10:]}"})
                continue

            line = line.strip()
            if not line:
                continue

            try:
                cmd = json.loads(line)
            except json.JSONDecodeError:
                manager._emit("error", {"message": f"Invalid JSON: {line}"})
                continue

            command = cmd.get("command")

            if command == "send":
                pane_id = cmd.get("pane_id")
                message = cmd.get("message")
                if pane_id and message:
                    await manager.send_message(pane_id, message)
                else:
                    manager._emit("error", {"message": "send requires pane_id and message"})

            elif command == "broadcast":
                message = cmd.get("message")
                exclude = cmd.get("exclude", [])
                if message:
                    await manager.broadcast(message, exclude)
                else:
                    manager._emit("error", {"message": "broadcast requires message"})

            elif command == "get_sessions":
                sessions = manager.get_all_sessions()
                manager._emit("sessions", {"sessions": sessions})

            elif command == "stop":
                await manager.stop_all()
                break

            elif command == "interrupt":
                pane_id = cmd.get("pane_id")
                if pane_id:
                    await manager.interrupt_agent(pane_id)
                else:
                    manager._emit("error", {"message": "interrupt requires pane_id"})

            else:
                manager._emit("error", {"message": f"Unknown command: {command}"})

        except Exception as e:
            manager._emit("error", {"message": f"IPC error: {e}"})


# =============================================================================
# CLI INTERFACE
# =============================================================================

async def main_async(workspace: Path, ipc_mode: bool = False):
    """Main async entry point."""

    manager = HivemindManager(workspace)

    try:
        await manager.start_all()

        if ipc_mode:
            # Run IPC server for Electron integration
            await run_ipc_server(manager)
        else:
            # Interactive CLI mode
            print("\nHivemind SDK V2 - 4 Independent Sessions")
            print("Commands: send <pane> <msg>, broadcast <msg>, sessions, quit\n")

            while True:
                try:
                    line = input("hivemind> ").strip()

                    if not line:
                        continue
                    elif line == "quit":
                        break
                    elif line == "sessions":
                        sessions = manager.get_all_sessions()
                        print(f"Sessions: {json.dumps(sessions, indent=2)}")
                    elif line.startswith("send "):
                        parts = line[5:].split(" ", 1)
                        if len(parts) == 2:
                            pane_id, message = parts
                            await manager.send_message(pane_id, message)
                        else:
                            print("Usage: send <pane_id> <message>")
                    elif line.startswith("broadcast "):
                        message = line[10:]
                        await manager.broadcast(message)
                    else:
                        print(f"Unknown command: {line}")

                except KeyboardInterrupt:
                    print("\nInterrupted")
                    break
                except EOFError:
                    break

    finally:
        await manager.stop_all()


def main():
    """CLI entry point."""
    import argparse

    parser = argparse.ArgumentParser(
        description="Hivemind SDK V2 - 4 Independent Claude Sessions"
    )

    parser.add_argument(
        "--workspace", "-w",
        type=Path,
        default=Path.cwd(),
        help="Working directory"
    )

    parser.add_argument(
        "--ipc",
        action="store_true",
        help="Run in IPC mode for Electron integration"
    )

    args = parser.parse_args()

    asyncio.run(main_async(args.workspace, args.ipc))


if __name__ == "__main__":
    main()
