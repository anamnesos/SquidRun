# SDK Mode UI Review - Everything in Leads Pane Issue

**Date:** January 25, 2026
**Reviewer:** Claude-Reviewer
**Status:** 🔴 BUG IDENTIFIED - BLOCKING

---

## Issue Summary

When SDK mode is enabled, all messages are being routed to the Lead pane (Pane 1) instead of being properly distributed across the 4 panes (Lead, Worker A, Worker B, Reviewer).

---

## Root Cause Analysis

### 1. sdk-bridge.js - Fallback to Pane 1

**File:** `ui/modules/sdk-bridge.js`

The `PANE_MAP` correctly maps agents to panes:
```javascript
const PANE_MAP = {
  'lead': '1',
  'worker-a': '2',
  'worker-b': '3',
  'reviewer': '4',
};
```

However, **multiple fallback patterns default to pane '1'**:

| Line | Code | Problem |
|------|------|---------|
| 110 | `paneId: '1'` | Error messages always go to pane 1 |
| 132 | `paneId: '1', error: err.message` | Process errors always go to pane 1 |
| 159-169 | Multiple `paneId: '1'` | Session match, lead match default to pane 1 |
| 192 | `paneId: '1'` | Tool matches default to pane 1 |
| 212 | `paneId: '1'` | Error prefix matches go to pane 1 |
| 221 | `paneId: '1'` | Generic output always goes to pane 1 |
| **231** | `PANE_MAP[msg.agent] || msg.paneId || '1'` | **KEY ISSUE** |

### 2. Python SDK Output Not Tagging Agent

**File:** `hivemind-sdk.py`

The Python SDK's default message handler (line 249-250):
```python
def _default_message_handler(self, pane_id: int, message):
    """Default handler prints to console."""
    msg_type = getattr(message, 'type', 'unknown')
    print(f"[Pane {pane_id}] {msg_type}: {message}")
```

This outputs `[Pane X] type: message` format, but:
1. The `parseLine()` regex for `[Pane X]` is looking for a different format
2. **JSON messages lack the `agent` field** that `handleMessage()` needs

### 3. Message Flow Problem

```
Python SDK                  sdk-bridge.js                    renderer
    |                            |                               |
    |-- JSON message ----------->|                               |
    |   (no 'agent' field)       |                               |
    |                            |                               |
    |                    handleMessage(msg)                      |
    |                    paneId = PANE_MAP[msg.agent]           |
    |                           || msg.paneId                   |
    |                           || '1'  <-- FALLBACK TRIGGERED   |
    |                            |                               |
    |                            |------ sdk-message ----------->|
    |                            |       paneId: '1'             |
    |                            |                               |
```

### 4. parseLine() Regex Issues

Line 199 expects:
```
[Pane X] msgType: content
```

But Python outputs:
```
[Pane 1] assistant: <full message object>
```

The regex `^\[Pane (\d)\] (\w+): (.+)$` works but only captures a single line. Multi-line content breaks.

---

## Key Bugs Identified

### Bug 1: Missing `agent` Field in JSON Messages
- **Severity:** Critical
- **Location:** `hivemind-sdk.py` + `sdk-bridge.js`
- **Issue:** Python SDK doesn't include `agent` name in JSON messages
- **Result:** All JSON messages fall back to pane '1'

### Bug 2: Text Parsing Falls Through to Generic Handler
- **Severity:** High
- **Location:** `sdk-bridge.js` lines 218-224
- **Issue:** Generic text output handler sends everything to pane '1'
- **Result:** Any unparsed output goes to Lead pane

### Bug 3: SDK Mode Initialization May Not Properly Clear Existing Content
- **Severity:** Medium
- **Location:** `sdk-renderer.js` line 62-66
- **Issue:** `initSDKPane()` replaces terminal div content but xterm may have persisted state

---

## Required Fixes

### Fix 1: Python SDK Must Tag Messages with Agent Name

In `hivemind-sdk.py`, modify message output to include agent:
```python
# When outputting JSON, include agent field
import json
json_msg = {
    'type': msg_type,
    'agent': agent_name,  # ADD THIS
    'paneId': pane_id,
    ...
}
print(json.dumps(json_msg))
```

### Fix 2: SDK Bridge Should Use paneId from Coordinator

The `HivemindCoordinator.run_agent()` already passes `pane_id` to the callback:
```python
self.on_message(pane_id, message)  # Line 284
```

The default handler should output JSON with this pane_id:
```python
def _default_message_handler(self, pane_id: int, message):
    import json
    output = {
        'paneId': str(pane_id),
        'type': getattr(message, 'type', 'unknown'),
        'content': str(message)
    }
    print(json.dumps(output))
```

### Fix 3: SDK Bridge handleMessage Should Prefer paneId

Line 231 should be:
```javascript
const paneId = msg.paneId || PANE_MAP[msg.agent] || '1';
```

(Prioritize explicit paneId over agent name lookup)

---

## Verification Steps

To verify the fix works:

1. Enable SDK mode in settings
2. Use broadcast input to send a test message
3. Verify messages appear in ALL 4 panes:
   - Pane 1 (Lead): Lead orchestrator messages
   - Pane 2 (Worker A): UI/frontend agent messages
   - Pane 3 (Worker B): Backend agent messages
   - Pane 4 (Reviewer): Review messages
4. Check that tool_use, tool_result, assistant messages route correctly

---

## Verdict

**SDK Mode UI: BLOCKED** 🔴

The SDK mode architecture is sound, but the message routing implementation has a critical gap:
- JSON messages from Python lack agent/pane identification
- JavaScript falls back to pane 1 for all unidentified messages

**This must be fixed before SDK mode is usable.**

---

## Files Requiring Changes

| File | Changes Needed |
|------|----------------|
| `hivemind-sdk.py` | Add `paneId` or `agent` to JSON output |
| `ui/modules/sdk-bridge.js` | Improve paneId extraction, reduce fallbacks |
| `ui/modules/sdk-renderer.js` | No changes needed (display logic is correct) |

---

*Reviewed by Claude-Reviewer*
*January 25, 2026*
