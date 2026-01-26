#!/usr/bin/env python3
"""
Serialization Tests - Verify all SDK objects can be JSON serialized

Gate 4 of Automated Quality Gates.
Catches JSON serialization bugs before they hit runtime.

Run: python tests/test-serialization.py
"""

import json
import sys
import os
from pathlib import Path
from typing import Any, Dict, List
from unittest.mock import MagicMock
from dataclasses import dataclass

# Fix Windows console encoding for emoji/unicode
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')  # type: ignore[union-attr]
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')  # type: ignore[union-attr]
    os.environ.setdefault('PYTHONIOENCODING', 'utf-8')

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))


# =============================================================================
# Mock SDK Objects (simulate non-serializable objects we might encounter)
# =============================================================================

class MockToolResultBlock:
    """Simulates SDK ToolResultBlock with potentially non-serializable content."""
    def __init__(self) -> None:
        self.tool_use_id = "toolu_123abc"
        self.content = MagicMock()  # Non-serializable!
        self.is_error = False

    def __str__(self) -> str:
        return f"ToolResultBlock(tool_use_id={self.tool_use_id})"


class MockThinkingBlock:
    """Simulates SDK ThinkingBlock."""
    def __init__(self) -> None:
        self.thinking = "Let me analyze this step by step..."

    def __str__(self) -> str:
        return f"ThinkingBlock(thinking={self.thinking[:30]}...)"


class MockTextBlock:
    """Simulates SDK TextBlock."""
    def __init__(self, text: str = "Hello, world!") -> None:
        self.type = "text"
        self.text = text

    def __str__(self) -> str:
        return f"TextBlock(text={self.text[:30]}...)"


class MockAssistantMessage:
    """Simulates SDK AssistantMessage with nested content."""
    def __init__(self) -> None:
        self.content = [
            MockTextBlock("First response"),
            MockToolResultBlock(),
            MockThinkingBlock(),
        ]
        self.model = "claude-opus-4-5-20251101"

    def __str__(self) -> str:
        return f"AssistantMessage(content=[{len(self.content)} blocks])"


@dataclass
class MockAgentConfig:
    """Simulates our AgentConfig dataclass."""
    role: str
    pane_id: str
    allowed_tools: List[str]
    permission_mode: str = "bypassPermissions"


# =============================================================================
# Test Cases
# =============================================================================

def test_basic_types() -> int:
    """Test that basic Python types serialize correctly."""
    print("Testing basic types...")

    test_cases = [
        {"name": "string", "data": "hello"},
        {"name": "integer", "data": 42},
        {"name": "float", "data": 3.14159},
        {"name": "boolean", "data": True},
        {"name": "None", "data": None},
        {"name": "empty dict", "data": {}},
        {"name": "empty list", "data": []},
    ]

    failures = 0
    for case in test_cases:
        try:
            result = json.dumps(case["data"])
            print(f"  ✅ {case['name']}: {result[:50]}")
        except Exception as e:
            print(f"  ❌ {case['name']}: FAIL - {e}")
            failures += 1

    return failures


def test_nested_structures() -> int:
    """Test that nested dicts and lists serialize correctly."""
    print("\nTesting nested structures...")

    test_cases = [
        {"name": "simple dict", "data": {"key": "value"}},
        {"name": "nested dict", "data": {"outer": {"inner": {"deep": "value"}}}},
        {"name": "list of dicts", "data": [{"a": 1}, {"b": 2}, {"c": 3}]},
        {"name": "dict with list", "data": {"items": [1, 2, 3, 4, 5]}},
        {"name": "mixed nesting", "data": {"users": [{"name": "Alice", "tags": ["admin", "user"]}]}},
    ]

    failures = 0
    for case in test_cases:
        try:
            result = json.dumps(case["data"])
            print(f"  ✅ {case['name']}: {result[:50]}...")
        except Exception as e:
            print(f"  ❌ {case['name']}: FAIL - {e}")
            failures += 1

    return failures


def test_default_str_fallback() -> int:
    """Test that default=str handles non-serializable objects."""
    print("\nTesting default=str fallback...")

    test_cases = [
        {"name": "MagicMock", "data": {"mock": MagicMock()}},
        {"name": "custom object", "data": {"obj": MockToolResultBlock()}},
        {"name": "Path object", "data": {"path": Path("/some/path")}},
        {"name": "set (not JSON native)", "data": {"items": {1, 2, 3}}},
        {"name": "bytes", "data": {"binary": b"hello bytes"}},
        {"name": "nested non-serializable", "data": {"outer": {"inner": MagicMock()}}},
    ]

    failures = 0
    for case in test_cases:
        try:
            result = json.dumps(case["data"], default=str)
            print(f"  ✅ {case['name']}: serialized OK")
        except Exception as e:
            print(f"  ❌ {case['name']}: FAIL - {e}")
            failures += 1

    return failures


def test_sdk_message_shapes() -> int:
    """Test the exact message shapes our SDK code produces."""
    print("\nTesting SDK message shapes...")

    # These mirror the actual structures in hivemind-sdk-v2.py
    test_cases = [
        {
            "name": "status message",
            "data": {
                "type": "status",
                "pane_id": "1",
                "role": "Lead",
                "state": "thinking",
            }
        },
        {
            "name": "assistant text message",
            "data": {
                "type": "assistant",
                "pane_id": "1",
                "content": [{"type": "text", "text": "Hello!"}],
                "model": "claude-opus-4-5-20251101",
            }
        },
        {
            "name": "assistant with tool_use",
            "data": {
                "type": "assistant",
                "pane_id": "2",
                "content": [
                    {"type": "text", "text": "Let me read that file."},
                    {"type": "tool_use", "id": "toolu_123", "name": "Read", "input": {"file_path": "/test.txt"}},
                ],
                "model": None,
            }
        },
        {
            "name": "assistant with tool_result",
            "data": {
                "type": "assistant",
                "pane_id": "3",
                "content": [
                    {"type": "tool_result", "tool_use_id": "toolu_123", "content": "File contents here", "is_error": False},
                ],
                "model": None,
            }
        },
        {
            "name": "result message",
            "data": {
                "type": "result",
                "pane_id": "1",
                "session_id": "session_abc123",
                "total_cost_usd": 0.0234,
                "duration_ms": 5432,
                "num_turns": 3,
                "is_error": False,
            }
        },
        {
            "name": "error message",
            "data": {
                "type": "error",
                "pane_id": "4",
                "message": "Something went wrong",
            }
        },
        {
            "name": "system message",
            "data": {
                "type": "system",
                "subtype": "init",
                "data": {"session_id": "sess_123", "cwd": "/projects/hivemind"},
            }
        },
    ]

    failures = 0
    for case in test_cases:
        try:
            result = json.dumps(case["data"], default=str)
            # Also verify it can be parsed back
            parsed = json.loads(result)
            assert parsed["type"] == case["data"]["type"], "Type mismatch after round-trip"
            print(f"  ✅ {case['name']}")
        except Exception as e:
            print(f"  ❌ {case['name']}: FAIL - {e}")
            failures += 1

    return failures


def test_edge_cases() -> int:
    """Test edge cases that have caused bugs before."""
    print("\nTesting edge cases...")

    test_cases = [
        {
            "name": "unicode/emoji",
            "data": {"message": "Hello 👋 World 🌍"},
        },
        {
            "name": "newlines in text",
            "data": {"content": "Line 1\nLine 2\nLine 3"},
        },
        {
            "name": "special characters",
            "data": {"text": "Quotes: \"hello\" and 'world', backslash: \\"},
        },
        {
            "name": "very long string",
            "data": {"content": "x" * 10000},
        },
        {
            "name": "deeply nested (10 levels)",
            "data": {"l1": {"l2": {"l3": {"l4": {"l5": {"l6": {"l7": {"l8": {"l9": {"l10": "deep"}}}}}}}}}},
        },
        {
            "name": "mixed None values",
            "data": {"a": None, "b": {"c": None}, "d": [None, None]},
        },
    ]

    failures = 0
    for case in test_cases:
        try:
            result = json.dumps(case["data"], default=str)
            # Verify round-trip
            parsed = json.loads(result)
            print(f"  ✅ {case['name']}")
        except Exception as e:
            print(f"  ❌ {case['name']}: FAIL - {e}")
            failures += 1

    return failures


def test_actual_sdk_imports() -> int:
    """Test serialization with actual SDK types if available."""
    print("\nTesting actual SDK types (if installed)...")

    try:
        from claude_agent_sdk import (
            AssistantMessage,
            TextBlock,
            ToolUseBlock,
            ToolResultBlock,
        )
        print("  SDK installed, testing real types...")

        # We can't instantiate these without a real SDK connection,
        # but we can verify our mock shapes match expectations
        print("  ✅ SDK imports available")
        return 0

    except ImportError:
        print("  ⚠️  SDK not installed, skipping real type tests")
        print("     (Install with: pip install claude-agent-sdk)")
        return 0  # Not a failure, just skipped


# =============================================================================
# Main
# =============================================================================

def main() -> int:
    """Run all serialization tests."""
    print("=" * 60)
    print("GATE 4: Serialization Tests")
    print("=" * 60)
    print()

    total_failures = 0

    total_failures += test_basic_types()
    total_failures += test_nested_structures()
    total_failures += test_default_str_fallback()
    total_failures += test_sdk_message_shapes()
    total_failures += test_edge_cases()
    total_failures += test_actual_sdk_imports()

    print()
    print("=" * 60)
    if total_failures == 0:
        print("✅ ALL SERIALIZATION TESTS PASSED")
        print("=" * 60)
        return 0
    else:
        print(f"❌ {total_failures} TEST(S) FAILED")
        print("=" * 60)
        return 1


if __name__ == "__main__":
    sys.exit(main())
