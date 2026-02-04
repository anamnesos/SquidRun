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
import warnings
from abc import ABC, abstractmethod

# Suppress Pydantic validation warnings from Claude SDK
# These are noisy "Failed to validate notification" warnings that fill the terminal
# The SDK still works fine - it just can't parse some notification types
warnings.filterwarnings('ignore', message='.*Failed to validate.*')
warnings.filterwarnings('ignore', module='pydantic.*')

# Also suppress via logging (some libraries use logging.warning instead of warnings.warn)
class PydanticWarningFilter(logging.Filter):
    """Filter out Pydantic validation warnings from Claude SDK."""
    def filter(self, record):
        msg = record.getMessage().lower()
        # Suppress validation errors and pydantic noise
        if 'failed to validate' in msg:
            return False
        if 'validation error' in msg:
            return False
        return True

# Apply filter to root logger to catch all sources
logging.getLogger().addFilter(PydanticWarningFilter())
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

# Stderr filter to suppress noisy SDK validation warnings
# The Claude SDK prints "WARNING: Failed to validate notification" directly to stderr
class FilteredStderr:
    """Wrapper that filters out Pydantic validation warnings from stderr."""
    def __init__(self, original):
        self._original = original
        self._buffer = ""

    def write(self, text):
        # Buffer multi-line writes
        self._buffer += text
        if '\n' in self._buffer:
            lines = self._buffer.split('\n')
            # Keep incomplete last line in buffer
            self._buffer = lines[-1]
            for line in lines[:-1]:
                # Skip validation warning lines
                if 'Failed to validate' in line:
                    continue
                if 'validation error' in line.lower():
                    continue
                if line.strip().startswith('Input should be'):
                    continue
                if line.strip().startswith('For further information'):
                    continue
                if 'pydantic' in line.lower() and 'error' in line.lower():
                    continue
                # Pass through everything else
                self._original.write(line + '\n')

    def flush(self):
        if self._buffer:
            # Flush remaining buffer if not a warning
            if 'Failed to validate' not in self._buffer:
                self._original.write(self._buffer)
            self._buffer = ""
        self._original.flush()

    def __getattr__(self, name):
        return getattr(self._original, name)

# Install filtered stderr
sys.stderr = FilteredStderr(sys.stderr)

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
            role_dir="arch",
            allowed_tools=["Read", "Edit", "Write", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"],
        )

    @classmethod
    def infra(cls):
        return cls(
            role="Infra",
            pane_id="2",
            model="codex",
            role_dir="infra",
            allowed_tools=["Read", "Edit", "Write", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"],
        )

    @classmethod
    def frontend(cls):
        return cls(
            role="Frontend",
            pane_id="3",
            model="claude",
            role_dir="front",
            allowed_tools=["Read", "Edit", "Write", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"],
        )

    @classmethod
    def backend(cls):
        return cls(
            role="Backend",
            pane_id="4",
            model="codex",
            role_dir="back",
            allowed_tools=["Read", "Edit", "Write", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"],
        )

    @classmethod
    def analyst(cls):
        return cls(
            role="Analyst",
            pane_id="5",
            model="gemini",
            role_dir="ana",
            allowed_tools=["Read", "Edit", "Write", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"],
        )

    @classmethod
    def reviewer(cls):
        return cls(
            role="Reviewer",
            pane_id="6",
            model="claude",
            role_dir="rev",
            allowed_tools=["Read", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"],  # Read-only for files, but needs Bash for hm-send.js
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
# ROLE MARKER CLEANING - Strip legacy Human:/Assistant: markers
# =============================================================================

def clean_role_markers(text: str) -> str:
    """
    Strip legacy role markers like Human: and Assistant: from content.

    Anthropic's legacy API and some CLI wrappers use these as turn markers.
    Leaking them into history causes feedback loops where agents think they
    are the human or vice-versa.
    """
    if not text:
        return text

    # List of markers to strip (both at start and end)
    markers = [
        "Human:", "Assistant:", "User:", "System:",
        "HUMAN:", "ASSISTANT:", "USER:", "SYSTEM:"
    ]

    result = text.strip()

    # Repeatedly strip markers from the beginning
    changed = True
    while changed:
        changed = False
        for m in markers:
            if result.startswith(m):
                result = result[len(m):].lstrip()
                changed = True

    # Repeatedly strip markers from the end
    changed = True
    while changed:
        changed = False
        for m in markers:
            if result.endswith(m):
                result = result[:-len(m)].rstrip()
                changed = True

    return result


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
            # V2 FIX: Clean legacy role markers before saving to history
            # This prevents feedback loops where 'Human:' markers are re-injected
            cleaned_content = clean_role_markers(content)
            if not cleaned_content and content:
                # If cleaning stripped everything but there was content,
                # it was likely just a role marker (e.g., "Human:").
                # Don't save empty entries.
                return

            self.history_file.parent.mkdir(parents=True, exist_ok=True)
            entry = {
                "timestamp": datetime.now().isoformat(),
                "role": role,
                "content": cleaned_content[:2000]  # Limit content size
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
            # FIX: Pass model via env var - ClaudeAgentOptions.model is ignored due to CLI bug
            # See: https://github.com/anthropics/claude-code/issues/13242
            env={"ANTHROPIC_MODEL": "claude-opus-4-5-20251101"},
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
                    # V2 FIX: Clean role markers (Human:/Assistant:) before saving
                    final_response = clean_role_markers(assistant_response)
                    if final_response:
                        self._save_to_history("assistant", final_response)
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
                    # V2 FIX: Clean role markers (Human:/Assistant:) before emitting
                    content_parts.append({"type": "text", "text": clean_role_markers(block.text)})
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
# CODEX AGENT - Codex via CLI subprocess with JSONL streaming
# =============================================================================

class CodexAgent(BaseAgent):
    """
    Codex agent using CLI subprocess with JSONL streaming.

    Spawns `codex exec --json` for each message, parsing JSONL events
    to provide real-time thinking indicators and text streaming to UI.

    Event types from Codex JSONL:
    - thread.started: Session begins (contains thread_id)
    - turn.started/completed/failed: Turn lifecycle
    - item.started/completed: Operations (reasoning, commands, file changes)

    Item types that indicate thinking:
    - reasoning: Agent thinking/planning (emit as thinking_delta)
    - agent_message: Text response (emit as text_delta)
    - command_execution: Running commands
    - file_change: File modifications
    """

    def __init__(self, config: AgentConfig, workspace: Path):
        super().__init__(config, workspace)
        self.process: Optional[asyncio.subprocess.Process] = None
        self.thread_id: Optional[str] = None
        self._interrupt_requested: bool = False

    async def connect(self, resume_id: Optional[str] = None) -> None:
        """
        Mark agent as ready. Codex CLI doesn't require persistent connection -
        we spawn a new process for each message.
        """
        self.thread_id = resume_id
        self.connected = True
        self._emit("status", {"state": "connected", "resumed": resume_id is not None})

    async def send(self, message: str) -> AsyncIterator[Dict[str, Any]]:
        """
        Send message to Codex via CLI subprocess and stream JSONL events.

        Spawns: codex exec --json [--resume thread_id] "message"
        Parses JSONL from stdout for real-time event streaming.
        """
        if not self.connected:
            yield {"type": "error", "message": "Codex agent not connected"}
            return

        self._save_to_history("user", message)
        self._emit("status", {"state": "thinking"})
        self._interrupt_requested = False

        # Build command
        # On Windows, use 'codex.cmd' because asyncio.create_subprocess_exec
        # doesn't resolve .cmd extensions like the shell does
        codex_cmd = "codex.cmd" if sys.platform == "win32" else "codex"

        # Resume existing thread if available
        # NOTE: 'resume' is a subcommand, not a flag: `codex exec resume <thread_id> "message"`
        if self.thread_id:
            cmd = [codex_cmd, "exec", "resume", self.thread_id, "--json"]
        else:
            cmd = [codex_cmd, "exec", "--json"]

        # Add the message as final argument
        cmd.append(message)

        response_text = ""
        has_error = False

        try:
            # On Windows, asyncio.create_subprocess_exec doesn't search PATH reliably
            # Use shutil.which to find the full path to codex
            import shutil
            codex_path = shutil.which("codex")
            if not codex_path:
                yield {"type": "error", "message": "Codex CLI not found in PATH. Install with: npm install -g @openai/codex"}
                return

            # Replace 'codex' with the full path
            cmd[0] = codex_path

            # Spawn subprocess
            # On Windows, codex is a .cmd batch wrapper that requires shell=True
            # Without shell=True, asyncio.create_subprocess_exec raises FileNotFoundError
            use_shell = sys.platform == 'win32'

            if use_shell:
                # For shell=True, pass command as a single string
                cmd_str = ' '.join(f'"{c}"' if ' ' in c else c for c in cmd)
                self.process = await asyncio.create_subprocess_shell(
                    cmd_str,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=str(self.workspace),
                )
            else:
                self.process = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=str(self.workspace),
                )

            # Read stdout line by line (JSONL stream)
            assert self.process.stdout is not None
            async for line in self.process.stdout:
                if self._interrupt_requested:
                    break

                line_str = line.decode('utf-8', errors='replace').strip()
                if not line_str:
                    continue

                try:
                    event = json.loads(line_str)
                    parsed = self._parse_codex_event(event)
                    if parsed:
                        # Accumulate text for history
                        if parsed.get("type") == "text_delta":
                            response_text += parsed.get("text", "")
                        yield parsed
                except json.JSONDecodeError:
                    # Non-JSON output (progress to stderr, or debug output)
                    LOGGER.debug(f"Codex non-JSON output: {line_str}")
                    continue

            # Wait for process to complete
            await self.process.wait()

            # Check for errors
            if self.process.returncode != 0:
                assert self.process.stderr is not None
                stderr = await self.process.stderr.read()
                stderr_text = stderr.decode('utf-8', errors='replace')
                if stderr_text.strip():
                    has_error = True
                    yield {"type": "error", "message": f"Codex exit code {self.process.returncode}: {stderr_text}"}

            # Save response to history
            if response_text.strip():
                self._save_to_history("assistant", response_text.strip())

            yield {
                "type": "result",
                "session_id": self.thread_id,
                "is_error": has_error,
            }

        except FileNotFoundError:
            yield {"type": "error", "message": "Codex CLI not found. Install with: npm install -g @openai/codex"}
        except Exception as e:
            yield {"type": "error", "message": f"Codex error: {e}"}
        finally:
            self.process = None
            self._emit("status", {"state": "idle"})

    def _parse_codex_event(self, event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        Parse Codex JSONL event and convert to Hivemind format.

        Maps Codex events to:
        - text_delta: For agent text responses (typewriter effect)
        - thinking_delta: For reasoning/planning (thinking indicator)
        - tool_use: For command execution, file changes
        - status: For turn lifecycle events
        """
        event_type = event.get("type", "")

        # Thread started - capture thread_id for session persistence
        if event_type == "thread.started":
            self.thread_id = event.get("thread_id")
            return {"type": "status", "state": "thread_started", "thread_id": self.thread_id}

        # Turn lifecycle
        if event_type == "turn.started":
            return {"type": "status", "state": "turn_started"}

        if event_type == "turn.completed":
            usage = event.get("usage", {})
            return {
                "type": "status",
                "state": "turn_completed",
                "input_tokens": usage.get("input_tokens"),
                "output_tokens": usage.get("output_tokens"),
            }

        if event_type == "turn.failed":
            return {"type": "error", "message": event.get("error", "Turn failed")}

        # Item events - the interesting ones for UI feedback
        if event_type == "item.started":
            item = event.get("item", {})
            item_type = item.get("type", "")

            # Reasoning = thinking indicator
            if item_type == "reasoning":
                return {"type": "thinking_delta", "thinking": "Reasoning..."}

            # Command execution
            if item_type == "command_execution":
                command = item.get("command", "")
                return {
                    "type": "tool_use",
                    "name": "Bash",
                    "input": {"command": command},
                }

            # File change
            if item_type == "file_change":
                file_path = item.get("file_path", "")
                return {
                    "type": "tool_use",
                    "name": "Edit",
                    "input": {"file_path": file_path},
                }

            # MCP tool call
            if item_type == "mcp_tool_call":
                tool_name = item.get("tool_name", "unknown")
                return {
                    "type": "tool_use",
                    "name": tool_name,
                    "input": item.get("arguments", {}),
                }

            # Web search
            if item_type == "web_search":
                query = item.get("query", "")
                return {
                    "type": "tool_use",
                    "name": "WebSearch",
                    "input": {"query": query},
                }

            # Plan update
            if item_type == "plan_update":
                return {"type": "thinking_delta", "thinking": "Updating plan..."}

        if event_type == "item.completed":
            item = event.get("item", {})
            item_type = item.get("type", "")

            # Agent message = actual text response
            if item_type == "agent_message":
                content = item.get("content", "")
                if content:
                    return {"type": "text_delta", "text": content}

            # Reasoning completed - emit the reasoning content
            if item_type == "reasoning":
                reasoning_content = item.get("content", "")
                if reasoning_content:
                    return {"type": "thinking_delta", "thinking": reasoning_content}

            # Command result
            if item_type == "command_execution":
                output = item.get("output", "")
                exit_code = item.get("exit_code", 0)
                return {
                    "type": "tool_result",
                    "content": output,
                    "is_error": exit_code != 0,
                }

            # File change result
            if item_type == "file_change":
                return {
                    "type": "tool_result",
                    "content": f"File changed: {item.get('file_path', 'unknown')}",
                    "is_error": False,
                }

        # Unknown event type - pass through for debugging
        return None

    async def interrupt(self) -> bool:
        """Interrupt the current Codex process."""
        self._interrupt_requested = True
        if self.process and self.process.returncode is None:
            try:
                self.process.terminate()
                # Give it a moment to terminate gracefully
                try:
                    await asyncio.wait_for(self.process.wait(), timeout=2.0)
                except asyncio.TimeoutError:
                    self.process.kill()
                return True
            except Exception:
                pass
        return False

    async def disconnect(self) -> Optional[str]:
        """Disconnect - terminate any running process."""
        if self.process and self.process.returncode is None:
            try:
                self.process.terminate()
            except Exception:
                pass
        self.process = None
        self.connected = False
        self._emit("status", {"state": "disconnected"})
        return self.thread_id


# =============================================================================
# GEMINI AGENT - Gemini via CLI subprocess (like CodexAgent)
# =============================================================================

class GeminiAgent(BaseAgent):
    """
    Gemini agent using CLI subprocess with stream-json output.

    Spawns `gemini` CLI for each message, parsing stream-json events
    to provide real-time streaming to UI. Uses CLI so GEMINI.md files
    are automatically loaded (just like CLAUDE.md for Claude agents).

    Key flags:
    - --output-format stream-json: JSONL streaming output
    - --yolo: Auto-approve tool calls
    - --resume: Resume previous session
    """

    def __init__(self, config: AgentConfig, workspace: Path):
        super().__init__(config, workspace)
        self.session_index: Optional[str] = None  # Gemini uses index numbers for resume
        self.process: Optional[asyncio.subprocess.Process] = None
        self._interrupt_requested: bool = False

    async def connect(self, resume_id: Optional[str] = None) -> None:
        """Initialize Gemini agent state.

        Unlike SDK-based agents, CLI agents don't maintain a persistent connection.
        Each message spawns a new subprocess.
        """
        self.session_index = resume_id
        self.connected = True
        self._emit("status", {"state": "connected", "resumed": resume_id is not None})

    async def send(self, message: str) -> AsyncIterator[Dict[str, Any]]:
        """
        Send message to Gemini via CLI subprocess and stream JSON events.

        Spawns: gemini --output-format stream-json --yolo [--resume index] -p "message"
        Parses stream-json from stdout for real-time event streaming.
        """
        if not self.connected:
            yield {"type": "error", "message": "Gemini agent not connected"}
            return

        self._save_to_history("user", message)
        self._emit("status", {"state": "thinking"})
        self._interrupt_requested = False

        # Build command
        # On Windows, use 'gemini.cmd' because asyncio.create_subprocess_exec
        # doesn't resolve .cmd extensions like the shell does
        gemini_cmd = "gemini.cmd" if sys.platform == "win32" else "gemini"
        cmd = [gemini_cmd, "--output-format", "stream-json", "--yolo"]

        # Resume existing session if available
        if self.session_index:
            cmd.extend(["--resume", self.session_index])

        # Add the message via -p flag
        cmd.extend(["-p", message])

        response_text = ""
        has_error = False

        try:
            # On Windows, find full path to gemini CLI
            import shutil
            gemini_path = shutil.which("gemini")
            if not gemini_path:
                yield {"type": "error", "message": "Gemini CLI not found in PATH. Install with: npm install -g @google/gemini-cli"}
                return

            # Replace 'gemini' with the full path
            cmd[0] = gemini_path

            # Spawn subprocess
            # On Windows, gemini is a .cmd batch wrapper that requires shell=True
            use_shell = sys.platform == 'win32'

            if use_shell:
                # For shell=True, pass command as a single string
                cmd_str = ' '.join(f'"{c}"' if ' ' in c else c for c in cmd)
                self.process = await asyncio.create_subprocess_shell(
                    cmd_str,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=str(self.workspace),
                )
            else:
                self.process = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=str(self.workspace),
                )

            # Read stdout line by line (stream-json)
            assert self.process.stdout is not None
            async for line in self.process.stdout:
                if self._interrupt_requested:
                    break

                line_str = line.decode('utf-8', errors='replace').strip()
                if not line_str:
                    continue

                # Try to parse as JSON
                try:
                    event = json.loads(line_str)
                except json.JSONDecodeError:
                    # Non-JSON output (e.g., plain text fallback)
                    response_text += line_str + "\n"
                    yield {"type": "text_delta", "text": line_str + "\n"}
                    continue

                # Handle Gemini CLI stream-json events
                # Format verified via: gemini --output-format stream-json
                # Events: init, message (user/assistant), result
                event_type = event.get("type", "")

                if event_type == "init":
                    # Session started - capture session_id for potential resume
                    session_id = event.get("session_id")
                    if session_id:
                        self.session_id = session_id

                elif event_type == "message":
                    role = event.get("role", "")
                    content = event.get("content", "")
                    is_delta = event.get("delta", False)

                    if role == "assistant" and content:
                        # Streaming assistant response
                        response_text += content
                        self._emit("status", {"state": "responding"})
                        yield {"type": "text_delta", "text": content}

                    # Ignore user message echoes (role == "user")

                elif event_type == "tool_use":
                    # Tool being called (may appear in some Gemini versions)
                    yield {
                        "type": "tool_use",
                        "tool": event.get("name", event.get("tool", "unknown")),
                        "args": event.get("args", event.get("input", {}))
                    }

                elif event_type == "tool_result":
                    # Tool completed
                    yield {
                        "type": "tool_result",
                        "tool": event.get("name", "unknown"),
                        "result": event.get("result", event.get("output", ""))
                    }

                elif event_type == "result":
                    # Gemini session complete
                    status = event.get("status", "")
                    if status != "success":
                        has_error = True

                elif event_type == "error":
                    has_error = True
                    yield {"type": "error", "message": event.get("message", event.get("content", "Unknown error"))}

            # Wait for process to complete
            await self.process.wait()

            # Check for errors in stderr
            if self.process.stderr:
                stderr = await self.process.stderr.read()
                stderr_str = stderr.decode('utf-8', errors='replace').strip()
                if stderr_str and self.process.returncode != 0:
                    has_error = True
                    yield {"type": "error", "message": f"Gemini CLI error: {stderr_str}"}

            # Save response to history
            # V2 FIX: Clean role markers before saving
            final_response = clean_role_markers(response_text)
            if final_response:
                self._save_to_history("assistant", final_response)

            yield {
                "type": "result",
                "session_id": self.session_index,
                "is_error": has_error,
            }

        except FileNotFoundError:
            yield {"type": "error", "message": "Gemini CLI not found. Install with: npm install -g @google/gemini-cli"}
        except Exception as e:
            yield {"type": "error", "message": f"Gemini error: {e}"}
        finally:
            self.process = None
            self._emit("status", {"state": "idle"})

    async def disconnect(self) -> Optional[str]:
        """Disconnect from Gemini (kill subprocess if running)."""
        if self.process:
            try:
                self.process.terminate()
                await asyncio.wait_for(self.process.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                self.process.kill()
            except Exception:
                pass

        self.connected = False
        self._emit("status", {"state": "disconnected"})
        return self.session_index

    async def interrupt(self) -> bool:
        """Interrupt current Gemini operation."""
        self._interrupt_requested = True
        if self.process:
            try:
                self.process.terminate()
                return True
            except Exception:
                pass
        return False


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

    def _load_model_settings(self) -> Dict[str, str]:
        """Load model assignments from settings.json."""
        settings_path = Path(__file__).parent / "ui" / "settings.json"
        models: Dict[str, str] = {}
        try:
            if settings_path.exists():
                with open(settings_path, 'r') as f:
                    settings = json.load(f)
                pane_commands = settings.get("paneCommands", {})
                for pane_id, command in pane_commands.items():
                    cmd = command.lower()
                    if cmd.startswith("codex"):
                        models[pane_id] = "codex"
                    elif cmd.startswith("gemini"):
                        models[pane_id] = "gemini"
                    else:
                        models[pane_id] = "claude"
                LOGGER.info(f"Loaded model settings: {models}")
        except Exception as e:
            LOGGER.warning(f"Could not load settings.json: {e}")
        return models

    async def start_all(self):
        """Start all 6 agents, resuming sessions if available."""

        # Load saved sessions
        saved_sessions = self._load_sessions()

        # Load model settings from settings.json (user's actual config)
        model_settings = self._load_model_settings()

        # Create agents with new role-based config (includes model type)
        configs = [
            AgentConfig.architect(),   # Pane 1
            AgentConfig.infra(),       # Pane 2
            AgentConfig.frontend(),    # Pane 3
            AgentConfig.backend(),     # Pane 4
            AgentConfig.analyst(),     # Pane 5
            AgentConfig.reviewer(),    # Pane 6
        ]

        # Override models from settings.json
        for config in configs:
            if config.pane_id in model_settings:
                config.model = model_settings[config.pane_id]

        for config in configs:
            agent = self._create_agent(config)
            self.agents[config.pane_id] = agent

            # Resume if we have a saved session
            # NOTE: Codex CLI mode supports thread resume via --resume flag, but threads
            # often expire between sessions. We try to resume but CodexAgent handles failures.
            # Gemini doesn't support session persistence.
            resume_id = saved_sessions.get(config.pane_id) if config.model not in ("gemini",) else None

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

    async def restart_agent(self, pane_id: str):
        """Restart a single agent session (clear history)."""
        if pane_id in self.agents:
            agent = self.agents[pane_id]
            LOGGER.info(f"Restarting agent {pane_id} ({agent.config.role})")
            try:
                await agent.disconnect()
            except Exception as e:
                LOGGER.error(f"Error disconnecting agent {pane_id} during restart: {e}")

            # Re-create and connect (without resume_id to force fresh session)
            config = agent.config
            new_agent = self._create_agent(config)
            self.agents[pane_id] = new_agent
            
            try:
                await new_agent.connect()
                self._emit("agent_restarted", {
                    "pane_id": pane_id,
                    "role": config.role,
                    "model": config.model
                })
                self._emit("status", {
                    "pane_id": pane_id,
                    "state": "idle",
                    "message": "Restarted"
                })
            except Exception as e:
                self._emit("error", {
                    "pane_id": pane_id,
                    "message": f"Failed to restart {config.role}: {e}"
                })

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

            elif command == "restart":
                pane_id = cmd.get("pane_id")
                if pane_id:
                    await manager.restart_agent(pane_id)
                else:
                    manager._emit("error", {"message": "restart requires pane_id"})

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
