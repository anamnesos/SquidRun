# SquidRun Benchmark System

Internal benchmark framework for evaluating AI model performance on real engineering tasks. Results here reflect actual SquidRun workflow performance, not synthetic public benchmarks.

## Models Under Test

| CLI | Model | Provider |
|-----|-------|----------|
| Claude Code | Opus 4.6 | Anthropic |
| Codex CLI | ChatGPT 5.3 | OpenAI |
| Gemini CLI | Gemini 3 | Google |

## Methodology

- Each benchmark task starts from an identical frozen repo snapshot
- Models receive the same prompt with identical constraints
- Human scoring is blind (evaluator doesn't know which model produced the output)
- Mix of automated metrics and human rubric scoring
- Minimum 3 runs per task per model to account for variance

## Scoring Categories

### Automated Metrics (objective)

| # | Category | What We Measure | Scoring |
|---|----------|----------------|---------|
| 1 | **Code Accuracy** | Tests pass, correct behavior | pass/fail + partial credit |
| 2 | **Speed to Correct Output** | Wall-clock time to passing state | seconds |
| 3 | **Tool-Use Efficiency** | Commands run, retries, dead ends | count (lower = better) |
| 4 | **Cost Efficiency** | Tokens / $ per successful outcome | tokens + estimated cost |
| 5 | **Regression Safety** | Tests added, existing tests broken | count |
| 6 | **Hallucination Rate** | References to nonexistent files, tools, APIs | count (lower = better) |
| 7 | **Reliability / Variance** | Consistency across repeated identical runs | stddev of scores |

### Human-Scored Rubric (1-10 scale, blind)

| # | Category | What We Evaluate |
|---|----------|-----------------|
| 8 | **UI/UX Quality** | Visual polish, usability, design sense from identical prompt |
| 9 | **Investigation Depth** | Root-cause quality, evidence cited, thoroughness |
| 10 | **Instruction Following** | Did it do exactly what was asked, no more, no less |
| 11 | **Context Retention** | Performance degradation over long sessions |
| 12 | **Diff Readability** | Clean, maintainable, minimal code changes |
| 13 | **Handoff / Report Quality** | Clarity of status updates, summaries, inter-agent communication |

### SquidRun-Specific Metrics

| # | Category | What We Evaluate |
|---|----------|-----------------|
| 14 | **Recovery from Bad State** | How the model handles errors, failed commands, wrong paths |
| 15 | **Inter-Agent Handover** | Quality of delegation, context passed between agents |

## Task Types

### UI/UX Tasks
Same visual/interaction prompt given to all models. Scored on design quality, responsiveness, and adherence to existing style system.

### Bug Fix Tasks
Identical bug reproduction steps. Scored on correctness, investigation quality, and regression safety.

### Feature Tasks
Same feature spec. Scored on completeness, code quality, and test coverage.

### Investigation Tasks
Same system problem. Scored on root-cause accuracy, evidence quality, and report clarity.

## Directory Structure

```
benchmarks/
├── prompts/          # Standardized task prompts (one .md per task)
├── results/          # Raw outputs per model per run
│   └── {task-id}/
│       ├── claude/
│       ├── codex/
│       └── gemini/
├── scores/           # Rubric scores (auto + human)
│   └── {task-id}.json
├── snapshots/        # Frozen repo state for clean-slate runs
└── README.md         # This file
```

## Running a Benchmark

1. Select or create a prompt in `prompts/`
2. Create a snapshot of current repo state in `snapshots/`
3. Run each model from the same snapshot with the same prompt
4. Collect raw output in `results/{task-id}/{model}/`
5. Run automated scoring
6. Blind human scoring on the human-rubric categories
7. Aggregate in `scores/{task-id}.json`

## Scoring Format

```json
{
  "taskId": "ui-001",
  "prompt": "prompts/ui-001.md",
  "date": "2026-02-15",
  "models": {
    "claude": {
      "automated": {
        "code_accuracy": 1,
        "speed_seconds": 45,
        "tool_use_commands": 12,
        "cost_tokens": 8500,
        "regressions": 0,
        "hallucinations": 0
      },
      "human": {
        "ui_ux_quality": 8,
        "investigation_depth": null,
        "instruction_following": 9,
        "context_retention": null,
        "diff_readability": 7,
        "handoff_quality": 8
      }
    }
  }
}
```
