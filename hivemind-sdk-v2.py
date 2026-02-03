#!/usr/bin/env python3
"""
Hivemind SDK V2 - 6 Independent Claude Sessions

Architecture: 6 persistent ClaudeSDKClient instances (NOT subagents)
- Each agent has its own full context window
- Sessions persist across app restarts
- Context compacts independently per agent

This replaces the PTY/keyboard event approach with reliable SDK API calls.
"""

import asyncio
import functools
import json
import logging
import sys
import os
from abc import ABC, abstractmethod
from datetime import datetime
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional, Dict, Any, AsyncIterator, List, Literal
# Retry logic for resilient API calls
try:
    from tenacity import (
        AsyncRetrying,
        RetryError,
        retry_if_exception_type,
        stop_after_attempt,
        wait_exponential,
        before_sleep_log,
    )
    TENACITY_AVAILABLE = True
except ImportError:
    TENACITY_AVAILABLE = False
    # Fallback stubs when tenacity not installed - SDK still works, just no retries
    AsyncRetrying = None  # type: ignore[misc,assignment]
    RetryError = Exception  # type: ignore[misc,assignment]
    retry_if_exception_type = None  # type: ignore[misc,assignment]
    stop_after_attempt = None  # type: ignore[misc,assignment]
    wait_exponential = None  # type: ignore[misc,assignment]
    before_sleep_log = None  # type: ignore[assignment]

# Fix Windows console encoding
if sys.platform == 'win32':
    # Type ignore needed: reconfigure exists at runtime but TextIO stub doesn't include it
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')  # type: ignore[union-attr]
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')  # type: ignore[union-attr]
    os.environ.setdefault('PYTHONIOENCODING', 'utf-8')

LOGGER = logging.getLogger(__name__)

RETRYABLE_EXCEPTIONS = (asyncio.TimeoutError, ConnectionError, OSError)

def sdk_retry(max_attempts: int = 3, wait_multiplier: float = 1.0, max_wait: float = 5.0):
    """
    Decorator factory that retries async API calls on transient errors.
    Falls back to no-op if tenacity isn't installed.
    """
    def decorator(func):
        if not TENACITY_AVAILABLE:
            # No retry capability without tenacity - just run the function
            return func
        @functools.wraps(func)
        async def wrapper(*args, **kwargs):
            async for attempt in AsyncRetrying(  # type: ignore[misc]
                stop=stop_after_attempt(max_attempts),  # type: ignore[misc]
                wait=wait_exponential(multiplier=wait_multiplier, min=wait_multiplier, max=max_wait),  # type: ignore[misc]
                retry=retry_if_exception_type(RETRYABLE_EXCEPTIONS),  # type: ignore[misc]
                reraise=True,
                before_sleep=before_sleep_log(LOGGER, logging.WARNING),  # type: ignore[misc]
            ):
                with attempt:
                    return await func(*args, **kwargs)
        return wrapper
    return decorator

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
    # STR-2: StreamEvent is in types submodule for real-time text streaming
    from claude_agent_sdk.types import StreamEvent
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
# RETRY HELPERS - Resilient API calls with exponential backoff
# =============================================================================

def is_retryable_error(exc: Exception) -> bool:
    """Check if an exception is retryable (rate limit, transient network)."""
    error_str = str(exc).lower()
    retryable_indicators = [
        "429", "rate limit", "too many requests",
        "503", "service unavailable",
        "timeout", "connection", "network"
    ]
    return any(indicator in error_str for indicator in retryable_indicators)


# Retry decorator for API calls - uses sdk_retry with sensible defaults
# api_retry is a simple alias for common case (no customization needed)
def api_retry(func):
    """Simple retry decorator with 3 attempts and exponential backoff."""
    return sdk_retry(max_attempts=3, wait_multiplier=2.0, max_wait=30.0)(func)


# =============================================================================
# AGENT CONFIGURATION
# =============================================================================

PermissionMode = Literal['default', 'acceptEdits', 'plan', 'bypassPermissions']
ModelType = Literal['claude', 'codex', 'gemini']

@dataclass
class AgentConfig:
    """Configuration for a single Hivemind agent."""
    role: str
    pane_id: str
    model: ModelType = "claude"  # Multi-model support
    role_dir: Optional[str] = None
    allowed_tools: List[str] = field(default_factory=list)
    # V2 FIX: Use bypassPermissions for all agents - acceptEdits still prompts for reads
    permission_mode: PermissionMode = "bypassPermissions"

    @classmethod
    def architect(cls):
        return cls(
            role="Architect",
            pane_id="1",
            model="claude",
            role_dir="lead",
            allowed_tools=["Read", "Edit", "Write", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"],
        )

    @classmethod
    def infra(cls):
        return cls(
            role="Infra",
            pane_id="2",
            model="codex",
            role_dir="infra",
            allowed_tools=["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
        )

    @classmethod
    def frontend(cls):
        return cls(
            role="Frontend",
            pane_id="3",
            model="claude",
            role_dir="worker-a",
            allowed_tools=["Read", "Edit", "Write", "Glob", "Grep"],
        )

    @classmethod
    def backend(cls):
        return cls(
            role="Backend",
            pane_id="4",
            model="codex",
            role_dir="worker-b",
            allowed_tools=["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
        )

    @classmethod
    def analyst(cls):
        return cls(
            role="Analyst",
            pane_id="5",
            model="gemini",
            role_dir="investigator",
            allowed_tools=["Read", "Edit", "Write", "Glob", "Grep"],
        )

    @classmethod
    def reviewer(cls):
        return cls(
            role="Reviewer",
            pane_id="6",
            model="claude",
            role_dir="reviewer",
            allowed_tools=["Read", "Glob", "Grep"],  # Read-only!
            permission_mode="bypassPermissions",
        )

    # Backward-compatible aliases
    @classmethod
    def lead(cls):
        return cls.architect()

    @classmethod
    def orchestrator(cls):
        return cls.infra()

    @classmethod
    def implementer_a(cls):
        return cls.frontend()

    @classmethod
    def implementer_b(cls):
        return cls.backend()

    @classmethod
    def investigator(cls):
        return cls.analyst()

    @classmethod
    def worker_a(cls):
        return cls.frontend()

    @classmethod
    def worker_b(cls):
        return cls.backend()


# =============================================================================
# BASE AGENT - Abstract base class for all models
# =============================================================================

class BaseAgent(ABC):
    """
    Abstract base for all Hivemind agents with shared history/error handling.

    Subclasses: ClaudeAgent, CodexAgent, GeminiAgent
    """

    def __init__(self, config: AgentConfig, workspace: Path):
        self.config = config
        self.workspace = workspace
        self.session_id: Optional[str] = None
        self.connected: bool = False
        self.history_file = workspace / "workspace" / "history" / f"{config.pane_id}-{config.role.lower().replace(' ', '-')}.jsonl"

    @abstractmethod
    async def connect(self, resume_id: Optional[str] = None) -> None:
        """Connect to SDK. Must set self.connected = True on success."""
        pass

    @abstractmethod
    def send(self, message: str) -> AsyncIterator[Dict[str, Any]]:
        """Send message, yield normalized response dicts. Must handle errors internally."""
        # Note: Implementations should be async generators (async def ... yield)
        # but the abstract signature doesn't use 'async' for AsyncIterator return type
        ...

    @abstractmethod
    async def disconnect(self) -> Optional[str]:
        """Disconnect and return session_id for persistence."""
        pass

    async def interrupt(self) -> bool:
        """
        Interrupt the current operation. Override in subclasses that support interruption.
        Returns True if interrupt was attempted, False if not supported.
        """
        return False  # Default: interruption not supported

    def get_session_id(self) -> Optional[str]:
        """Get current session ID for persistence."""
        return self.session_id

    def _save_to_history(self, role: str, content: str) -> None:
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

    def _emit(self, msg_type: str, data: Dict[str, Any]) -> None:
        """Emit a normalized message to stdout for IPC."""
        output = {
            "type": msg_type,
            "pane_id": self.config.pane_id,
            "role": self.config.role,
            **data,
        }
        print(json.dumps(output, default=str), flush=True)


# =============================================================================
# CLAUDE AGENT - Claude via claude_agent_sdk
# =============================================================================

class ClaudeAgent(BaseAgent):
    """
    Claude agent using claude_agent_sdk.

    Refactored from original HivemindAgent. Uses ClaudeSDKClient for direct
    API access with streaming support.
    """

    def __init__(self, config: AgentConfig, workspace: Path):
        super().__init__(config, workspace)
        self.client: Optional[ClaudeSDKClient] = None
        self._pending_context: Optional[str] = None  # Context to inject on first message after restart

    async def connect(self, resume_session_id: Optional[str] = None):
        """
        Connect to SDK and optionally resume a previous session.

        Args:
            resume_session_id: Session ID to resume (from previous app run)
        """
        # V2 FIX: Use role-specific directory so each agent reads its own CLAUDE.md
        # Structure: workspace/instances/{role_dir}/CLAUDE.md
        role_dir_name = self.config.role_dir or self.config.role.lower().replace(' ', '-')
        role_specific_cwd = self.workspace / "workspace" / "instances" / role_dir_name

        # Fall back to main workspace if role directory doesn't exist
        if not role_specific_cwd.exists():
            role_specific_cwd = self.workspace
            self._emit("warning", {"message": f"Role directory not found: {role_specific_cwd}, using main workspace"})

        # V2 FIX: Don't try to resume sessions - stale session IDs cause "Fatal error in message reader"
        # Session resume is broken in claude-agent-sdk when session no longer exists
        # Better to start fresh each time than crash trying to resume dead sessions
        options = ClaudeAgentOptions(
            # Use Opus 4.5 - the best model
            model="claude-opus-4-5-20251101",
            allowed_tools=self.config.allowed_tools,
            permission_mode=self.config.permission_mode,
            cwd=str(role_specific_cwd),
            # CRITICAL: setting_sources=["project"] tells Claude to load CLAUDE.md from cwd
            # Without this, agents have NO ROLE IDENTITY and respond as generic Claude
            setting_sources=["project"],
            # STR-1: Enable real-time text streaming for typewriter effect
            # This gives us StreamEvent with text_delta for character-by-character display
            include_partial_messages=True,
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
            await self._query_with_retry(clean_message)

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

        except RetryError as e:
            last = e.last_attempt.exception() if hasattr(e, "last_attempt") else None
            err_msg = last or e  # type: ignore[assignment]
            yield {"type": "error", "message": f"Claude API retry failed: {err_msg}"}
        except Exception as e:
            yield {"type": "error", "message": str(e)}
        finally:
            self._emit("status", {"state": "idle"})

    @sdk_retry()
    async def _query_with_retry(self, message: str) -> None:
        assert self.client is not None, "Claude client is not initialized"
        await self.client.query(message)

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

        elif isinstance(msg, StreamEvent):
            # STR-2: Real-time streaming event with text_delta
            # StreamEvent.event is a dict containing the raw Anthropic API stream event
            # We look for content_block_delta with text_delta type
            event = msg.event
            event_type = event.get("type") if isinstance(event, dict) else None

            if event_type == "content_block_delta":
                delta = event.get("delta", {})
                delta_type = delta.get("type")

                if delta_type == "text_delta":
                    # Character-by-character text streaming - emit for typewriter effect
                    text = delta.get("text", "")
                    if text:
                        return {
                            "type": "text_delta",
                            "text": text,
                            "session_id": msg.session_id,
                        }
                elif delta_type == "thinking_delta":
                    # Extended thinking streaming
                    thinking = delta.get("thinking", "")
                    if thinking:
                        return {
                            "type": "thinking_delta",
                            "thinking": thinking,
                            "session_id": msg.session_id,
                        }

            # Other stream events (message_start, content_block_start, etc.) - ignore
            return None

        # Unknown message type - return raw
        return {"type": "unknown", "raw": str(msg)}

    # _emit() inherited from BaseAgent

    async def interrupt(self) -> bool:
        """Interrupt the current Claude operation."""
        if self.client and self.connected:
            try:
                await self.client.interrupt()
                return True
            except Exception:
                pass
        return False

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

    # get_session_id(), _save_to_history(), _load_history(), get_context_restore_message()
    # are all inherited from BaseAgent


# =============================================================================
# CODEX AGENT - Codex via OpenAI Agents SDK (MCP)
# =============================================================================

class CodexAgent(BaseAgent):
    """
    Codex agent using OpenAI Agents SDK via MCP server.

    Codex runs as an MCP server, Python connects via MCPServerStdio.
    Uses elevated_windows_sandbox for safe command execution.
    """

    def __init__(self, config: AgentConfig, workspace: Path):
        super().__init__(config, workspace)
        self.mcp_server: Any = None  # MCPServerStdio - typed as Any for mypy
        self.thread_id: Optional[str] = None

    async def connect(self, resume_id: Optional[str] = None) -> None:
        """Connect to Codex MCP server."""
        try:
            from agents.mcp import MCPServerStdio

            # Create MCP server instance (don't use __aenter__, use connect/cleanup)
            # NOTE: Model is configured via ~/.codex/config.toml (mcp-server doesn't accept --model)
            # Add `model = "gpt-5.2-codex"` to config.toml for GPT-5.2
            # Default: gpt-5-codex (macOS/Linux) or gpt-5 (Windows)
            self.mcp_server = MCPServerStdio(
                name=f"Codex-{self.config.pane_id}",
                params={"command": "npx", "args": ["-y", "codex", "mcp-server"]},
                client_session_timeout_seconds=360000,
            )

            # Connect using proper SDK pattern
            await self.mcp_server.connect()

            # Verify connection by listing tools
            try:
                tools = await self.mcp_server.list_tools()
                self._emit("status", {"state": "tools_discovered", "tools": [t.name for t in tools]})
            except Exception as tool_err:
                self._emit("warning", {"message": f"Could not list tools: {tool_err}"})

            self.thread_id = resume_id
            self.connected = True
            self._emit("status", {"state": "connected", "resumed": resume_id is not None})

        except ImportError as e:
            self._emit("error", {"message": f"OpenAI Agents SDK not installed: {e}"})
            raise
        except Exception as e:
            self._emit("error", {"message": f"Codex connect failed: {e}"})
            raise

    async def send(self, message: str) -> AsyncIterator[Dict[str, Any]]:
        """Send message to Codex and yield normalized responses."""
        if not self.connected or not self.mcp_server:
            yield {"type": "error", "message": "Codex agent not connected"}
            return

        self._save_to_history("user", message)
        self._emit("status", {"state": "thinking"})

        try:
            if self.thread_id:
                # Continue existing thread
                try:
                    result = await self._call_codex_tool("codex-reply", {
                        "threadId": self.thread_id,
                        "prompt": message,
                    })
                except Exception as thread_err:
                    # Thread may be stale - start new session
                    if "not found" in str(thread_err).lower() or "expired" in str(thread_err).lower():
                        self._emit("status", {"state": "thread_expired_restarting"})
                        self.thread_id = None
                        result = await self._start_new_session(message)
                    else:
                        raise
            else:
                result = await self._start_new_session(message)

            # Extract content from MCP response
            content = result.get("structuredContent", {}) if isinstance(result, dict) else {}
            self.thread_id = content.get("threadId", self.thread_id)
            response_text = content.get("content", str(result))

            # Normalize to common format - emit as text_delta for consistency
            # Codex MCP doesn't stream, so emit full response as one delta
            yield {"type": "text_delta", "text": response_text}

            self._save_to_history("assistant", response_text)

            yield {
                "type": "result",
                "session_id": self.thread_id,
                "is_error": False,
            }

        except RetryError as e:
            last = e.last_attempt.exception() if hasattr(e, "last_attempt") else None
            err_msg = last or e  # type: ignore[assignment]
            yield {"type": "error", "message": f"Codex API retry failed: {err_msg}"}
        except Exception as e:
            yield {"type": "error", "message": f"Codex error: {e}"}

        finally:
            self._emit("status", {"state": "idle"})

    @sdk_retry()
    async def _start_new_session(self, message: str) -> Dict[str, Any]:
        """Start a new Codex session."""
        assert self.mcp_server is not None, "MCP server not connected"
        return await self.mcp_server.call_tool("codex", {
            "prompt": message,
            "approval-policy": "never",  # Safe: Codex runs in sandbox
            "sandbox": "workspace-write",  # Valid values: read-only, workspace-write, danger-full-access
        })

    @sdk_retry()
    async def _call_codex_tool(self, tool: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Call a Codex MCP tool with retry semantics."""
        assert self.mcp_server is not None, "MCP server not connected"
        return await self.mcp_server.call_tool(tool, payload)

    async def disconnect(self) -> Optional[str]:
        """Disconnect from Codex MCP server."""
        if self.mcp_server:
            try:
                await self.mcp_server.cleanup()
            except Exception:
                pass  # Best effort cleanup
        self.mcp_server = None
        self.connected = False
        self._emit("status", {"state": "disconnected"})
        return self.thread_id


# =============================================================================
# GEMINI AGENT - Gemini via google-genai SDK
# =============================================================================

class GeminiAgent(BaseAgent):
    """
    Gemini agent using google-genai SDK.

    Uses chat sessions for conversation continuity.
    Supports tool use via Automatic Function Calling (AFC).
    """

    def __init__(self, config: AgentConfig, workspace: Path):
        super().__init__(config, workspace)
        self.client: Any = None  # google.genai.Client - typed as Any for mypy
        self.chat: Any = None  # google.genai.Chat - typed as Any for mypy
        self._tools_config: Any = None  # GenerateContentConfig - typed as Any for mypy

    def _build_tools(self) -> list:
        """Build tool functions based on allowed_tools config."""
        import subprocess
        import glob as glob_module

        workspace = self.workspace

        def read_file(path: str) -> str:
            """Read content from a file.

            Args:
                path: The file path to read (absolute or relative to workspace)
            """
            try:
                file_path = Path(path) if Path(path).is_absolute() else workspace / path
                return file_path.read_text(encoding='utf-8')
            except Exception as e:
                return f"Error reading file: {e}"

        def write_file(path: str, content: str) -> str:
            """Write content to a file.

            Args:
                path: The file path to write (absolute or relative to workspace)
                content: The content to write
            """
            try:
                file_path = Path(path) if Path(path).is_absolute() else workspace / path
                file_path.parent.mkdir(parents=True, exist_ok=True)
                file_path.write_text(content, encoding='utf-8')
                return f"Successfully wrote {len(content)} bytes to {path}"
            except Exception as e:
                return f"Error writing file: {e}"

        def run_bash(command: str) -> str:
            """Execute a bash command and return output.

            Args:
                command: The bash command to execute
            """
            try:
                result = subprocess.run(
                    command,
                    shell=True,
                    capture_output=True,
                    text=True,
                    timeout=120,
                    cwd=str(workspace)
                )
                output = result.stdout
                if result.stderr:
                    output += f"\nSTDERR: {result.stderr}"
                if result.returncode != 0:
                    output += f"\nExit code: {result.returncode}"
                return output or "(no output)"
            except subprocess.TimeoutExpired:
                return "Error: Command timed out after 120 seconds"
            except Exception as e:
                return f"Error running command: {e}"

        def glob_files(pattern: str) -> str:
            """Find files matching a glob pattern.

            Args:
                pattern: The glob pattern (e.g., '**/*.py')
            """
            try:
                base = workspace if not Path(pattern).is_absolute() else Path('/')
                matches = list(base.glob(pattern))
                if not matches:
                    return "No files found matching pattern"
                return "\n".join(str(m) for m in matches[:100])  # Limit to 100
            except Exception as e:
                return f"Error in glob: {e}"

        def grep_search(pattern: str, path: str = ".") -> str:
            """Search for a pattern in files.

            Args:
                pattern: The regex pattern to search for
                path: The path to search in (default: current directory)
            """
            try:
                search_path = Path(path) if Path(path).is_absolute() else workspace / path
                result = subprocess.run(
                    ["grep", "-r", "-n", "--include=*.py", "--include=*.js", "--include=*.ts",
                     "--include=*.md", "--include=*.json", pattern, str(search_path)],
                    capture_output=True,
                    text=True,
                    timeout=60
                )
                return result.stdout[:10000] or "No matches found"  # Limit output
            except Exception as e:
                return f"Error in grep: {e}"

        # Map tool names to functions
        tool_map = {
            "Read": read_file,
            "Write": write_file,
            "Bash": run_bash,
            "Glob": glob_files,
            "Grep": grep_search,
        }

        # Return tools based on allowed_tools config
        tools = []
        for tool_name in self.config.allowed_tools:
            if tool_name in tool_map:
                tools.append(tool_map[tool_name])

        return tools

    async def connect(self, resume_id: Optional[str] = None) -> None:
        """Connect to Gemini API and create chat session with tools."""
        try:
            from google import genai
            from google.genai import types

            client = genai.Client()

            # Build tools based on config
            tools = self._build_tools()

            # Create chat config with tools and automatic function calling
            if tools:
                self._tools_config = types.GenerateContentConfig(
                    tools=tools,
                    automatic_function_calling=types.AutomaticFunctionCallingConfig(
                        disable=False,
                        maximum_remote_calls=10
                    )
                )

            # Create chat session with gemini-3-flash (matches PTY mode Auto Gemini 3)
            chat = client.chats.create(model="gemini-3-flash")
            self.client = client
            self.chat = chat
            self.connected = True

            # Restore context from history if available
            context_msg = self.get_context_restore_message()
            if context_msg:
                self._emit("status", {"state": "restoring_context"})
                # Send context restore as first message to prime the chat
                try:
                    chat.send_message(context_msg, config=self._tools_config)
                except Exception:
                    pass  # Non-fatal, continue without context

            self._emit("status", {
                "state": "connected",
                "has_history": context_msg is not None,
                "tools_enabled": len(tools) > 0
            })

        except ImportError as e:
            self._emit("error", {"message": f"Google GenAI SDK not installed: {e}"})
            raise
        except Exception as e:
            self._emit("error", {"message": f"Gemini connect failed: {e}"})
            raise

    async def send(self, message: str) -> AsyncIterator[Dict[str, Any]]:
        """Send message to Gemini and yield normalized responses.

        Uses Automatic Function Calling (AFC) - the SDK automatically executes
        tool functions when the model requests them and continues the conversation.
        """
        if not self.connected or not self.chat:
            yield {"type": "error", "message": "Gemini agent not connected"}
            return

        self._save_to_history("user", message)
        self._emit("status", {"state": "thinking"})

        response_text = ""

        try:
            # Use send_message_stream with tools config (collected via retry helper)
            chunks = await self._collect_gemini_stream(message)
            for chunk in chunks:
                # Handle text content
                text = chunk.text if hasattr(chunk, 'text') else ""
                if text:
                    response_text += text
                    yield {"type": "text_delta", "text": text}

                # Optionally emit tool use events for UI feedback
                if hasattr(chunk, 'function_call') and chunk.function_call:
                    yield {
                        "type": "tool_use",
                        "tool": chunk.function_call.name,
                        "args": dict(chunk.function_call.args) if chunk.function_call.args else {}
                    }

            self._save_to_history("assistant", response_text)

            yield {
                "type": "result",
                "session_id": self.session_id,
                "is_error": False,
            }

        except RetryError as e:
            last = e.last_attempt.exception() if hasattr(e, "last_attempt") else None
            err_msg = last or e  # type: ignore[assignment]
            yield {"type": "error", "message": f"Gemini API retry failed: {err_msg}"}
        except Exception as e:
            error_msg = str(e)

            # Handle rate limiting with backoff hint
            if "429" in error_msg or "rate" in error_msg.lower():
                yield {"type": "error", "message": f"Gemini rate limited: {error_msg}. Retry later."}
            else:
                yield {"type": "error", "message": f"Gemini error: {error_msg}"}

        finally:
            self._emit("status", {"state": "idle"})

    async def disconnect(self) -> Optional[str]:
        """Disconnect from Gemini."""
        self.connected = False
        self.chat = None
        self._emit("status", {"state": "disconnected"})
        return self.session_id

    @sdk_retry()
    async def _collect_gemini_stream(self, message: str) -> List[Any]:
        """Send a message via Gemini and collect stream chunks."""
        assert self.chat is not None, "Gemini chat session not initialized"
        return list(self.chat.send_message_stream(message, config=self._tools_config))


# =============================================================================
# HIVEMIND MANAGER - Manages all 6 agents
# =============================================================================

class HivemindManager:
    """
    Manages 6 independent Hivemind agents (Claude, Codex, Gemini).

    Handles:
    - Agent lifecycle (connect, disconnect)
    - Model-aware instantiation via factory
    - Message routing
    - Session persistence
    - IPC with Electron
    """

    def __init__(self, workspace: Path):
        self.workspace = workspace
        self.agents: Dict[str, BaseAgent] = {}  # Now supports all agent types
        self.session_file = workspace / "session-state.json"

    def _create_agent(self, config: AgentConfig) -> BaseAgent:
        """Factory method - instantiate correct agent class based on config.model."""
        if config.model == "claude":
            return ClaudeAgent(config, self.workspace)
        elif config.model == "codex":
            return CodexAgent(config, self.workspace)
        elif config.model == "gemini":
            return GeminiAgent(config, self.workspace)
        else:
            raise ValueError(f"Unknown model type: {config.model}")

    async def start_all(self):
        """Start all 6 agents, resuming sessions if available."""

        # Load saved sessions
        saved_sessions = self._load_sessions()

        # Create agents with new role-based config (includes model type)
        configs = [
            AgentConfig.architect(),   # Pane 1 - Claude
            AgentConfig.infra(),       # Pane 2 - Codex
            AgentConfig.frontend(),    # Pane 3 - Claude
            AgentConfig.backend(),     # Pane 4 - Codex
            AgentConfig.analyst(),     # Pane 5 - Gemini
            AgentConfig.reviewer(),    # Pane 6 - Claude
        ]

        for config in configs:
            agent = self._create_agent(config)
            self.agents[config.pane_id] = agent

            # Resume if we have a saved session
            resume_id = saved_sessions.get(config.pane_id)

            try:
                await agent.connect(resume_id)
                self._emit("agent_started", {
                    "pane_id": config.pane_id,
                    "role": config.role,
                    "model": config.model,  # Include model in startup message
                    "resumed": resume_id is not None,
                })
            except Exception as e:
                self._emit("error", {
                    "pane_id": config.pane_id,
                    "message": f"Failed to start {config.role} ({config.model}): {e}",
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
            pane_id: Target pane ("1", "2", "3", "4", "5", "6")
            message: Message to send
        """
        agent = self.agents.get(pane_id)
        if not agent:
            self._emit("error", {"pane_id": pane_id, "message": "Agent not found"})
            return

        # Confirm message received
        self._emit("message_received", {"pane_id": pane_id})

        # Stream responses with exception handling
        try:
            async for response in agent.send(message):
                response["pane_id"] = pane_id
                # V2 FIX: Use default=str to handle any non-serializable objects
                print(json.dumps(response, default=str), flush=True)
        except Exception as e:
            self._emit("error", {
                "pane_id": pane_id,
                "message": f"Agent send failed: {e}",
                "error_type": type(e).__name__
            })

    async def interrupt_agent(self, pane_id: str):
        """
        Interrupt a running agent.

        Args:
            pane_id: Target pane ("1", "2", "3", "4", "5", "6")
        """
        agent = self.agents.get(pane_id)
        if not agent:
            self._emit("error", {"pane_id": pane_id, "message": "Agent not found"})
            return

        if agent.connected:
            try:
                success = await agent.interrupt()
                if success:
                    self._emit("interrupted", {"pane_id": pane_id, "role": agent.config.role})
                else:
                    self._emit("warning", {"pane_id": pane_id, "message": "Agent does not support interrupt"})
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
        try:
            async for response in self.agents[pane_id].send(message):
                response["pane_id"] = pane_id
                # V2 FIX: Use default=str to handle any non-serializable objects
                print(json.dumps(response, default=str), flush=True)
        except Exception as e:
            self._emit("error", {
                "pane_id": pane_id,
                "message": f"Broadcast send failed: {e}",
                "error_type": type(e).__name__
            })

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

    # Track running tasks for parallel execution
    running_tasks: set = set()

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
                    # PARALLELISM FIX: Spawn task instead of awaiting
                    task = asyncio.create_task(manager.send_message(pane_id, message))
                    running_tasks.add(task)
                    # Use lambda to ensure task reference is captured
                    task.add_done_callback(lambda t: running_tasks.discard(t))
                else:
                    manager._emit("error", {"message": "send requires pane_id and message"})

            elif command == "broadcast":
                message = cmd.get("message")
                exclude = cmd.get("exclude", [])
                if message:
                    # PARALLELISM FIX: Spawn task instead of awaiting
                    task = asyncio.create_task(manager.broadcast(message, exclude))
                    running_tasks.add(task)
                    # Use lambda to ensure task reference is captured
                    task.add_done_callback(lambda t: running_tasks.discard(t))
                else:
                    manager._emit("error", {"message": "broadcast requires message"})

            elif command == "get_sessions":
                sessions = manager.get_all_sessions()
                manager._emit("sessions", {"sessions": sessions})

            elif command == "stop":
                # Wait for all running tasks before stopping (with timeout)
                if running_tasks:
                    try:
                        results = await asyncio.wait_for(
                            asyncio.gather(*running_tasks, return_exceptions=True),
                            timeout=30.0
                        )
                        # Log any failed tasks
                        for i, result in enumerate(results):
                            if isinstance(result, Exception):
                                manager._emit("warning", {
                                    "message": f"Task failed during shutdown: {result}",
                                    "error_type": type(result).__name__
                                })
                    except asyncio.TimeoutError:
                        manager._emit("warning", {
                            "message": f"Shutdown timeout: {len(running_tasks)} tasks still running",
                            "pending_count": len(running_tasks)
                        })
                await manager.stop_all()
                break

            elif command == "interrupt":
                pane_id = cmd.get("pane_id")
                if pane_id:
                    await manager.interrupt_agent(pane_id)
                else:
                    manager._emit("error", {"message": "interrupt requires pane_id"})

            elif command == "ping":
                # Re-emit ready signal - allows JS to recover if it missed the initial ready
                manager._emit("ready", {"agents": list(manager.agents.keys())})

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
            print("\nHivemind SDK V2 - 6 Independent Sessions")
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
        description="Hivemind SDK V2 - 6 Independent Claude Sessions"
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
