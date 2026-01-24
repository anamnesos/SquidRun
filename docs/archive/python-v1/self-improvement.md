# Self-Improvement System

## Overview

Hivemind learns from friction—patterns of problems that indicate the system isn't well-tuned for how you work. Rather than requiring manual configuration, the system observes what goes wrong and adapts.

## What is Friction?

Friction is any inefficiency or repeated problem in the system:

- Reviewer keeps flagging the same issues
- Tasks consistently take longer than estimated
- Workers make similar mistakes repeatedly
- Plans require multiple revision cycles
- Human intervention needed for predictable issues

## Friction Detection

### Automatic Detection

The system automatically detects friction patterns:

```python
class FrictionDetector:
    def analyze_task_completion(self, task_id: str):
        # Check revision count
        if state.revision_count > 2:
            self.log_friction("repeated_revision", ...)

        # Check reviewer patterns
        issues = self.get_reviewer_issues(task_id)
        patterns = self.find_repeated_patterns(issues)
        for pattern in patterns:
            self.log_friction("reviewer_pattern", pattern)

        # Check timing
        if actual_time > estimated_time * 2:
            self.log_friction("timeout", ...)
```

### Pattern Recognition

The system looks for:

| Pattern | Detection Method | Example |
|---------|-----------------|---------|
| Repeated issues | Same issue text across tasks | "Missing input validation" flagged 5 times |
| Underestimation | Actual vs estimated complexity | "Low" tasks taking 3x expected time |
| Worker failures | Same error types recurring | Timeout errors on API calls |
| Escalations | Human intervention triggers | Same question types escalated |

## Friction Log Schema

```json
{
  "id": "friction_001",
  "detected_at": "2024-01-15T11:00:00Z",
  "type": "reviewer_pattern",
  "severity": "medium",
  "description": "Reviewer consistently flags missing error handling in API endpoints",
  "evidence": {
    "occurrences": 5,
    "affected_tasks": ["task_1", "task_2", "task_3", "task_4", "task_5"],
    "sample_issues": [
      "No error handling for database connection failure",
      "Missing try-catch around external API call",
      "No validation error responses defined"
    ]
  },
  "affected_agent": "worker",
  "suggested_action": {
    "type": "prompt_update",
    "target": "worker",
    "change": "Add 'Always include error handling for external calls and database operations' to worker prompt",
    "reasoning": "Workers consistently miss error handling, causing reviewer cycles"
  },
  "status": "pending",
  "resolution": null
}
```

## Improvement Actions

### Types of Improvements

1. **Prompt Updates**
   - Add specific instructions to agent prompts
   - Emphasize frequently-missed requirements
   - Include examples of good patterns

2. **Checklist Additions**
   - Add items to quality checklists
   - Create domain-specific requirements
   - Include security or compliance checks

3. **Configuration Changes**
   - Adjust complexity estimation factors
   - Change checkpoint frequency
   - Modify retry limits

4. **Process Changes**
   - Add new checkpoint types
   - Change review criteria
   - Adjust parallelization rules

### Improvement Pipeline

```
Friction Detected
       │
       ▼
┌─────────────────┐
│  Analyze Root   │
│     Cause       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Generate      │
│  Suggestion     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Human Review   │ ◄── Optional for high-impact changes
│   (if needed)   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│     Apply       │
│   Improvement   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│    Monitor      │
│    Results      │
└─────────────────┘
```

## Automatic vs. Supervised

### Automatic Application

Low-risk improvements can be applied automatically:

- Adding items to checklists
- Minor prompt clarifications
- Adjusting estimates within bounds
- Adding examples to prompts

### Human Review Required

Higher-risk changes require approval:

- Significant prompt rewrites
- Process flow changes
- New checkpoint requirements
- Agent role modifications

```json
{
  "improvement": {
    "auto_apply": true,
    "conditions": [
      "type in ['checklist_addition', 'example_addition']",
      "severity == 'low'",
      "occurrences >= 3"
    ]
  }
}
```

## Implementation

### Friction Logger

```python
class FrictionLogger:
    def __init__(self, workspace: Workspace):
        self.workspace = workspace

    def log(self, friction_type: str, description: str, evidence: dict):
        entry = {
            "id": generate_id(),
            "detected_at": now(),
            "type": friction_type,
            "description": description,
            "evidence": evidence,
            "status": "pending"
        }
        self.workspace.append_friction(entry)

        # Check if pattern already exists
        existing = self.find_similar(description)
        if existing:
            self.increment_occurrences(existing, entry)
```

### Improvement Generator

```python
class ImprovementGenerator:
    def __init__(self, llm_client: LLMClient):
        self.llm = llm_client

    def suggest_improvement(self, friction: dict) -> dict:
        prompt = f"""
        Analyze this friction pattern and suggest an improvement:

        Type: {friction['type']}
        Description: {friction['description']}
        Evidence: {friction['evidence']}

        Suggest a specific, minimal change to prevent this friction.
        Focus on the root cause, not symptoms.
        """

        suggestion = self.llm.complete(prompt)
        return parse_suggestion(suggestion)
```

### Improvement Applier

```python
class ImprovementApplier:
    def apply(self, improvement: dict):
        if improvement['type'] == 'prompt_update':
            self.update_prompt(
                improvement['target'],
                improvement['change']
            )
        elif improvement['type'] == 'checklist_addition':
            self.add_checklist_item(
                improvement['target'],
                improvement['item']
            )

        # Log the application
        self.workspace.update_friction(
            improvement['friction_id'],
            status="applied",
            applied_at=now()
        )
```

## Monitoring Improvements

After applying an improvement, monitor its effectiveness:

```python
class ImprovementMonitor:
    def check_effectiveness(self, improvement_id: str, window_days: int = 14):
        improvement = self.get_improvement(improvement_id)

        # Count friction before and after
        before = self.count_similar_friction(
            improvement['friction_type'],
            end_date=improvement['applied_at']
        )
        after = self.count_similar_friction(
            improvement['friction_type'],
            start_date=improvement['applied_at']
        )

        if after < before * 0.5:
            return "effective"
        elif after > before:
            return "ineffective"  # Consider rollback
        else:
            return "inconclusive"
```

## Example Improvements

### Example 1: Missing Error Handling

**Friction:**
```
Reviewer flags missing error handling in 5 consecutive tasks
```

**Improvement:**
```json
{
  "type": "prompt_update",
  "target": "worker",
  "change": "Add to worker prompt: 'IMPORTANT: All external calls (APIs, database, file system) must have error handling with specific error types and user-friendly messages.'"
}
```

### Example 2: Complexity Underestimation

**Friction:**
```
Authentication-related tasks estimated as "medium" take 3x longer
```

**Improvement:**
```json
{
  "type": "configuration",
  "target": "orchestrator",
  "change": "Add complexity modifier: tasks containing 'auth', 'authentication', 'security' get +1 complexity level"
}
```

### Example 3: Repeated Security Issues

**Friction:**
```
Reviewer catches SQL injection risks in 3 tasks
```

**Improvement:**
```json
{
  "type": "checklist_addition",
  "target": "worker",
  "item": "All database queries use parameterized queries or ORM methods—never string concatenation"
}
```

## Privacy and Data

Friction logs may contain task information. For privacy:

- Anonymize task descriptions after 30 days
- Store patterns, not specific content
- Allow users to delete friction history
- Don't send friction data externally

## Configuration

```json
{
  "self_improvement": {
    "enabled": true,
    "auto_apply": true,
    "auto_apply_threshold": 3,
    "human_review_threshold": "high_impact",
    "monitoring_window_days": 14,
    "retention_days": 90
  }
}
```
