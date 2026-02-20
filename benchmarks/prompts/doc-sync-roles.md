# Benchmark: Documentation Role Synchronization

## Task
Update all documentation files in the `docs/` directory to use the current role names:
- **Architect** (Pane 1)
- **Builder** (Pane 2)
- **Oracle** (Pane 3)

Legacy names like **Analyst**, **DevOps**, **Infra**, **Dev**, etc., should be replaced with their modern counterparts as defined in `ROLES.md`.

## Constraints
- Do not change technical identifiers in code (e.g., directory names or script parameters) unless specifically requested. This benchmark focus is on **documentation accuracy**.
- Maintain the original tone and intent of the documentation.
- Ensure all cross-references between documents are consistent.

## Evaluation Criteria
1. **Accuracy**: All stale role names replaced correctly.
2. **Completeness**: No files in `docs/` missed.
3. **Diff Quality**: Clean, minimal changes.
4. **Instruction Following**: Adhered to all constraints.
