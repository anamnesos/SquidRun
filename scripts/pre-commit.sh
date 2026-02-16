#!/bin/sh
#
# Hivemind Pre-commit Hook - Automated Quality Gates
# Runs type checking and linting before allowing commits.
#
# To bypass (emergencies only): git commit --no-verify
#

echo "Running pre-commit quality checks..."
echo ""

# Track if any check failed
FAILED=0

# =============================================================================
# Gate 1: Python Type Checking (mypy)
# =============================================================================

echo "Gate 1: Python type checking (mypy)..."

# Check if mypy is available
if python -m mypy --version > /dev/null 2>&1; then
    # Check hivemind-sdk-v2.py
    if [ -f "hivemind-sdk-v2.py" ]; then
        python -m mypy hivemind-sdk-v2.py --ignore-missing-imports --no-error-summary
        if [ $? -ne 0 ]; then
            echo "❌ mypy failed on hivemind-sdk-v2.py"
            FAILED=1
        else
            echo "✅ hivemind-sdk-v2.py passed mypy"
        fi
    fi

    # Check hivemind-sdk.py (original)
    if [ -f "hivemind-sdk.py" ]; then
        python -m mypy hivemind-sdk.py --ignore-missing-imports --no-error-summary
        if [ $? -ne 0 ]; then
            echo "❌ mypy failed on hivemind-sdk.py"
            FAILED=1
        else
            echo "✅ hivemind-sdk.py passed mypy"
        fi
    fi
else
    echo "⚠️  mypy not installed, skipping Python type check"
    echo "   Install with: pip install mypy"
fi

echo ""

# =============================================================================
# Gate 2: JavaScript Linting (ESLint)
# =============================================================================

echo "Gate 2: JavaScript linting (ESLint)..."

# Check if eslint is available in ui/node_modules
if [ -f "ui/node_modules/.bin/eslint" ] || [ -f "ui/node_modules/.bin/eslint.cmd" ]; then
    cd ui
    npx eslint modules/*.js renderer.js main.js --quiet 2>/dev/null
    if [ $? -ne 0 ]; then
        echo "❌ ESLint found issues"
        FAILED=1
    else
        echo "✅ JavaScript files passed ESLint"
    fi
    cd ..
else
    echo "⚠️  ESLint not installed, skipping JavaScript lint"
    echo "   Install with: cd ui && npm install --save-dev eslint"
fi

echo ""

# =============================================================================
# Gate 2B: IPC Handler Misuse Guard (ipcMain.handle/emit inside handlers)
# =============================================================================

echo "Gate 2B: IPC handler misuse guard..."

# Fail if ipcMain.handle()/ipcMain.emit() appears with deeper indent than the
# minimum indent for that file (catches handler-inside-handler regardless of
# 2- or 4-space style).
IPC_LINES=$(rg -n "^[[:space:]]*ipcMain\\.(handle|emit)\\(" ui --glob "*.js" 2>/dev/null || true)

if [ -n "$IPC_LINES" ]; then
    IPC_MISUSE=$(echo "$IPC_LINES" | awk -F: '
      {
        file=$1; line=$2;
        code=substr($0, length(file)+length(line)+3);
        match(code, /^[ \t]*/);
        indent=RLENGTH;
        if (min[file] == "" || indent < min[file]) { min[file]=indent; }
        lines[file]=lines[file] line ":" code "\n";
        indents[file]=indents[file] indent "\n";
      }
      END {
        for (f in lines) {
          n=split(lines[f], larr, "\n");
          split(indents[f], iarr, "\n");
          for (i=1; i<=n; i++) {
            if (larr[i] == "") continue;
            if (iarr[i] > min[f]) {
              print f ":" larr[i];
            }
          }
        }
      }
    ')
else
    IPC_MISUSE=""
fi

if [ -n "$IPC_MISUSE" ]; then
    echo "❌ Detected nested ipcMain.handle()/ipcMain.emit():"
    echo "$IPC_MISUSE"
    echo "   Rule: ipcMain.handle() registers handlers only; do not invoke/emit inside another handler."
    FAILED=1
else
    echo "✅ No nested ipcMain.handle()/emit found"
fi

echo ""

# =============================================================================
# Gate 3: Python Syntax Check (fast, always runs)
# =============================================================================

echo "Gate 3: Python syntax check..."

SYNTAX_FAILED=0
for pyfile in hivemind-sdk.py hivemind-sdk-v2.py; do
    if [ -f "$pyfile" ]; then
        python -m py_compile "$pyfile" 2>/dev/null
        if [ $? -ne 0 ]; then
            echo "❌ Syntax error in $pyfile"
            SYNTAX_FAILED=1
        fi
    fi
done

if [ $SYNTAX_FAILED -eq 0 ]; then
    echo "✅ Python syntax OK"
else
    FAILED=1
fi

echo ""

# =============================================================================
# Gate 4: Serialization Tests
# =============================================================================

echo "Gate 4: Serialization tests..."

if [ -f "tests/test-serialization.py" ]; then
    python tests/test-serialization.py > /dev/null 2>&1
    if [ $? -ne 0 ]; then
        echo "❌ Serialization tests failed"
        echo "   Run: python tests/test-serialization.py"
        FAILED=1
    else
        echo "✅ Serialization tests passed"
    fi
else
    echo "⚠️  Serialization tests not found, skipping"
fi

echo ""

# =============================================================================
# Gate 5: Jest Unit Tests (Task #10 - Automated Test Gate)
# =============================================================================

echo "Gate 5: Jest unit tests..."

# Check if Jest is available in ui/node_modules
if [ -f "ui/node_modules/.bin/jest" ] || [ -f "ui/node_modules/.bin/jest.cmd" ]; then
    cd ui
    # Run Jest with minimal output, fail on any test failure
    npm test -- --passWithNoTests --silent 2>&1
    JEST_EXIT=$?
    cd ..

    if [ $JEST_EXIT -ne 0 ]; then
        echo "❌ Jest tests failed"
        echo "   Run: cd ui && npm test"
        FAILED=1
    else
        echo "✅ Jest tests passed"
    fi
else
    echo "⚠️  Jest not installed, skipping unit tests"
    echo "   Install with: cd ui && npm install"
fi

echo ""

# =============================================================================
# Gate 6: Trigger Path Enforcement (absolute paths required)
# =============================================================================

echo "Gate 6: Trigger path enforcement..."

# Resolve project root in Windows path form so this check is machine-agnostic.
if command -v cygpath >/dev/null 2>&1; then
    PROJECT_ROOT_WIN=$(cygpath -w "$(pwd -P)")
else
    PROJECT_ROOT_WIN=$(pwd -P | sed -E 's#^/([A-Za-z])/#\1:/#; s#/#\\#g')
fi

# Find any workspace/triggers/*.txt path that isn't prefixed with <project-root>\
# This catches relative paths in CLAUDE.md and AGENTS.md files that cause ghost folder bugs
# Only flags actual file paths (containing .txt), not intro text or diagnostic references

ABS_TRIGGER_FWD="${PROJECT_ROOT_WIN}\\workspace/triggers/"
ABS_TRIGGER_BACK="${PROJECT_ROOT_WIN}\\workspace\\triggers"

RELATIVE_PATHS=$(rg -n "workspace/triggers/[a-z-]+\.txt" CLAUDE.md workspace/instances/ --glob "*.md" 2>/dev/null | \
    grep -vF "$ABS_TRIGGER_FWD" | \
    grep -vF "$ABS_TRIGGER_BACK" | \
    grep -v "ghost folder\|resolve WRONG\|Expected:\|Actual:\|ghost files" || true)

if [ -n "$RELATIVE_PATHS" ]; then
    echo "❌ Found relative trigger paths (must use absolute paths):"
    echo "$RELATIVE_PATHS"
    echo ""
    echo "   Fix: Replace 'workspace/triggers/X.txt' with '${PROJECT_ROOT_WIN}\\workspace\\triggers\\X.txt'"
    FAILED=1
else
    echo "✅ All trigger paths are absolute"
fi

echo ""

# =============================================================================
# Gate 7: Build Doc Hygiene Lint (staged docs only)
# =============================================================================

echo "Gate 7: Build doc hygiene lint..."

if [ -f "ui/scripts/doc-lint.js" ]; then
    node ui/scripts/doc-lint.js --staged
    if [ $? -ne 0 ]; then
        echo "âŒ Doc hygiene lint failed"
        echo "   Run: node ui/scripts/doc-lint.js"
        FAILED=1
    else
        echo "âœ… Build doc hygiene lint passed"
    fi
else
    echo "âš ï¸  ui/scripts/doc-lint.js not found, skipping build doc lint"
fi

echo ""

# =============================================================================
# Summary
# =============================================================================

if [ $FAILED -ne 0 ]; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "❌ PRE-COMMIT FAILED - Fix errors above before committing"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "To bypass (emergencies only): git commit --no-verify"
    exit 1
else
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "✅ ALL CHECKS PASSED"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    exit 0
fi
