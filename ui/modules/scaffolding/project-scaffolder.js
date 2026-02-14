/**
 * Project Scaffolder
 * Task #12: Project Templates and Scaffolding
 *
 * Creates pre-built project structures, config presets, and directory scaffolding.
 * Supports multiple project types: Node.js, Python, React, Electron, etc.
 */

const fs = require('fs');
const path = require('path');

// Project type constants
const PROJECT_TYPES = {
  NODE_BASIC: 'node-basic',
  NODE_EXPRESS: 'node-express',
  NODE_CLI: 'node-cli',
  PYTHON_BASIC: 'python-basic',
  PYTHON_FLASK: 'python-flask',
  PYTHON_FASTAPI: 'python-fastapi',
  REACT_BASIC: 'react-basic',
  REACT_TYPESCRIPT: 'react-typescript',
  ELECTRON_BASIC: 'electron-basic',
  HIVEMIND_WORKSPACE: 'hivemind-workspace',
  MONOREPO: 'monorepo',
  EMPTY: 'empty',
};

// Default scaffolding options
const DEFAULT_OPTIONS = {
  createGitignore: true,
  createReadme: true,
  initGit: false,
  installDependencies: false,
  overwrite: false,
};

/**
 * Project template definitions
 * Each template defines directories and files to create
 */
const PROJECT_TEMPLATES = {
  [PROJECT_TYPES.NODE_BASIC]: {
    name: 'Node.js Basic',
    description: 'Simple Node.js project with package.json and basic structure',
    category: 'nodejs',
    directories: ['src', 'tests', 'docs'],
    files: {
      'package.json': {
        type: 'json',
        content: {
          name: '{{projectName}}',
          version: '1.0.0',
          description: '{{description}}',
          main: 'src/index.js',
          scripts: {
            start: 'node src/index.js',
            test: 'node --test tests/',
            lint: 'eslint src/',
          },
          keywords: [],
          author: '{{author}}',
          license: 'MIT',
          engines: {
            node: '>=18.0.0',
          },
        },
      },
      'src/index.js': {
        type: 'text',
        content: `/**
 * {{projectName}}
 * {{description}}
 */

console.log('Hello from {{projectName}}!');

module.exports = {};
`,
      },
      'tests/index.test.js': {
        type: 'text',
        content: `const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('{{projectName}}', () => {
  it('should pass basic test', () => {
    assert.strictEqual(1 + 1, 2);
  });
});
`,
      },
      '.gitignore': {
        type: 'text',
        content: `node_modules/
.env
.env.local
*.log
coverage/
dist/
.DS_Store
`,
      },
      'README.md': {
        type: 'text',
        content: `# {{projectName}}

{{description}}

## Installation

\`\`\`bash
npm install
\`\`\`

## Usage

\`\`\`bash
npm start
\`\`\`

## Testing

\`\`\`bash
npm test
\`\`\`

## License

MIT
`,
      },
    },
  },

  [PROJECT_TYPES.NODE_EXPRESS]: {
    name: 'Node.js Express API',
    description: 'Express.js REST API with middleware and routes',
    category: 'nodejs',
    directories: ['src', 'src/routes', 'src/middleware', 'src/controllers', 'tests'],
    files: {
      'package.json': {
        type: 'json',
        content: {
          name: '{{projectName}}',
          version: '1.0.0',
          description: '{{description}}',
          main: 'src/index.js',
          scripts: {
            start: 'node src/index.js',
            dev: 'node --watch src/index.js',
            test: 'node --test tests/',
          },
          dependencies: {
            express: '^4.18.2',
            cors: '^2.8.5',
            helmet: '^7.1.0',
          },
          devDependencies: {
            eslint: '^8.56.0',
          },
        },
      },
      'src/index.js': {
        type: 'text',
        content: `const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const routes = require('./routes');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Routes
app.use('/api', routes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal Server Error' });
});

app.listen(PORT, () => {
  console.log(\`Server running on port \${PORT}\`);
});

module.exports = app;
`,
      },
      'src/routes/index.js': {
        type: 'text',
        content: `const express = require('express');
const router = express.Router();

// Example route
router.get('/', (req, res) => {
  res.json({ message: 'Welcome to {{projectName}} API' });
});

module.exports = router;
`,
      },
      'src/middleware/auth.js': {
        type: 'text',
        content: `/**
 * Authentication middleware
 *
 * IMPORTANT: This is a placeholder implementation for development only.
 * You MUST implement proper token verification before deploying to production.
 */

// Example using jsonwebtoken (uncomment and install: npm install jsonwebtoken):
// const jwt = require('jsonwebtoken');
// const JWT_SECRET = process.env.JWT_SECRET;
//
// function verifyToken(token) {
//   try {
//     return jwt.verify(token, JWT_SECRET);
//   } catch (err) {
//     return null;
//   }
// }

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  // WARNING: Placeholder implementation - does NOT verify tokens
  if (process.env.NODE_ENV !== 'production') {
    console.warn('[AUTH] Token verification skipped - implement before production!');
  } else {
    // In production, fail-safe: reject unverified tokens
    console.error('[AUTH] CRITICAL: Token verification not implemented!');
    return res.status(500).json({ error: 'Auth not configured' });
  }

  // TODO: Replace with actual verification:
  // const decoded = verifyToken(token);
  // if (!decoded) {
  //   return res.status(401).json({ error: 'Invalid token' });
  // }
  // req.user = decoded;

  req.user = { id: 'placeholder-user-id' };
  next();
}

module.exports = { authMiddleware };
`,
      },
      '.gitignore': {
        type: 'text',
        content: `node_modules/
.env
.env.local
*.log
coverage/
dist/
.DS_Store
`,
      },
      'README.md': {
        type: 'text',
        content: `# {{projectName}}

{{description}}

## Setup

\`\`\`bash
npm install
\`\`\`

## Development

\`\`\`bash
npm run dev
\`\`\`

## Production

\`\`\`bash
npm start
\`\`\`

## API Endpoints

- \`GET /health\` - Health check
- \`GET /api\` - API root

## License

MIT
`,
      },
    },
  },

  [PROJECT_TYPES.NODE_CLI]: {
    name: 'Node.js CLI Tool',
    description: 'Command-line application with argument parsing',
    category: 'nodejs',
    directories: ['src', 'src/commands', 'tests'],
    files: {
      'package.json': {
        type: 'json',
        content: {
          name: '{{projectName}}',
          version: '1.0.0',
          description: '{{description}}',
          bin: {
            '{{projectName}}': './src/cli.js',
          },
          scripts: {
            start: 'node src/cli.js',
            test: 'node --test tests/',
            link: 'npm link',
          },
          dependencies: {
            commander: '^11.1.0',
            chalk: '^5.3.0',
          },
        },
      },
      'src/cli.js': {
        type: 'text',
        content: `#!/usr/bin/env node

const { program } = require('commander');
const { version } = require('../package.json');

program
  .name('{{projectName}}')
  .description('{{description}}')
  .version(version);

program
  .command('hello <name>')
  .description('Say hello')
  .option('-l, --loud', 'Use uppercase')
  .action((name, options) => {
    const greeting = \`Hello, \${name}!\`;
    console.log(options.loud ? greeting.toUpperCase() : greeting);
  });

program.parse();
`,
      },
      '.gitignore': {
        type: 'text',
        content: `node_modules/
.env
*.log
.DS_Store
`,
      },
      'README.md': {
        type: 'text',
        content: `# {{projectName}}

{{description}}

## Installation

\`\`\`bash
npm install -g .
\`\`\`

## Usage

\`\`\`bash
{{projectName}} hello World
{{projectName}} hello World --loud
\`\`\`

## License

MIT
`,
      },
    },
  },

  [PROJECT_TYPES.PYTHON_BASIC]: {
    name: 'Python Basic',
    description: 'Simple Python project with virtual environment setup',
    category: 'python',
    directories: ['src', 'tests', 'docs'],
    files: {
      'requirements.txt': {
        type: 'text',
        content: `# Core dependencies
# Add your dependencies here
`,
      },
      'requirements-dev.txt': {
        type: 'text',
        content: `# Development dependencies
pytest>=7.4.0
pytest-cov>=4.1.0
black>=23.12.0
flake8>=6.1.0
mypy>=1.8.0
`,
      },
      'src/__init__.py': {
        type: 'text',
        content: `"""{{projectName}} - {{description}}"""

__version__ = "1.0.0"
`,
      },
      'src/main.py': {
        type: 'text',
        content: `"""
{{projectName}}
{{description}}
"""


def main():
    """Main entry point."""
    print("Hello from {{projectName}}!")


if __name__ == "__main__":
    main()
`,
      },
      'tests/__init__.py': {
        type: 'text',
        content: '',
      },
      'tests/test_main.py': {
        type: 'text',
        content: `"""Tests for main module."""

import pytest
from src.main import main


def test_main(capsys):
    """Test main function."""
    main()
    captured = capsys.readouterr()
    assert "Hello" in captured.out
`,
      },
      'pyproject.toml': {
        type: 'text',
        content: `[build-system]
requires = ["setuptools>=61.0"]
build-backend = "setuptools.build_meta"

[project]
name = "{{projectName}}"
version = "1.0.0"
description = "{{description}}"
authors = [{name = "{{author}}"}]
license = {text = "MIT"}
requires-python = ">=3.9"

[tool.pytest.ini_options]
testpaths = ["tests"]

[tool.black]
line-length = 88
target-version = ["py39"]

[tool.mypy]
python_version = "3.9"
warn_return_any = true
warn_unused_configs = true
`,
      },
      '.gitignore': {
        type: 'text',
        content: `__pycache__/
*.py[cod]
*$py.class
.env
.venv/
venv/
.pytest_cache/
.mypy_cache/
*.egg-info/
dist/
build/
.DS_Store
`,
      },
      'README.md': {
        type: 'text',
        content: `# {{projectName}}

{{description}}

## Setup

\`\`\`bash
python -m venv venv
source venv/bin/activate  # or venv\\Scripts\\activate on Windows
pip install -r requirements.txt
pip install -r requirements-dev.txt
\`\`\`

## Usage

\`\`\`bash
python src/main.py
\`\`\`

## Testing

\`\`\`bash
pytest
\`\`\`

## License

MIT
`,
      },
    },
  },

  [PROJECT_TYPES.PYTHON_FASTAPI]: {
    name: 'Python FastAPI',
    description: 'FastAPI REST API with async support',
    category: 'python',
    directories: ['app', 'app/routers', 'app/models', 'tests'],
    files: {
      'requirements.txt': {
        type: 'text',
        content: `fastapi>=0.109.0
uvicorn[standard]>=0.27.0
pydantic>=2.5.0
python-dotenv>=1.0.0
`,
      },
      'app/__init__.py': {
        type: 'text',
        content: '',
      },
      'app/main.py': {
        type: 'text',
        content: `"""
{{projectName}} - FastAPI Application
{{description}}
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import health, items

app = FastAPI(
    title="{{projectName}}",
    description="{{description}}",
    version="1.0.0",
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routers
app.include_router(health.router, tags=["health"])
app.include_router(items.router, prefix="/api/items", tags=["items"])


@app.get("/")
async def root():
    return {"message": "Welcome to {{projectName}}"}
`,
      },
      'app/routers/__init__.py': {
        type: 'text',
        content: '',
      },
      'app/routers/health.py': {
        type: 'text',
        content: `"""Health check router."""

from fastapi import APIRouter
from datetime import datetime

router = APIRouter()


@router.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "timestamp": datetime.utcnow().isoformat(),
    }
`,
      },
      'app/routers/items.py': {
        type: 'text',
        content: `"""Items router."""

from fastapi import APIRouter, HTTPException
from app.models.item import Item, ItemCreate

router = APIRouter()

# In-memory storage
items_db: dict[int, Item] = {}
counter = 0


@router.get("/")
async def list_items():
    return list(items_db.values())


@router.post("/", response_model=Item)
async def create_item(item: ItemCreate):
    global counter
    counter += 1
    new_item = Item(id=counter, **item.model_dump())
    items_db[counter] = new_item
    return new_item


@router.get("/{item_id}", response_model=Item)
async def get_item(item_id: int):
    if item_id not in items_db:
        raise HTTPException(status_code=404, detail="Item not found")
    return items_db[item_id]
`,
      },
      'app/models/__init__.py': {
        type: 'text',
        content: '',
      },
      'app/models/item.py': {
        type: 'text',
        content: `"""Item models."""

from pydantic import BaseModel


class ItemBase(BaseModel):
    name: str
    description: str | None = None
    price: float


class ItemCreate(ItemBase):
    pass


class Item(ItemBase):
    id: int

    class Config:
        from_attributes = True
`,
      },
      '.gitignore': {
        type: 'text',
        content: `__pycache__/
*.py[cod]
.env
.venv/
venv/
.pytest_cache/
.DS_Store
`,
      },
      'README.md': {
        type: 'text',
        content: `# {{projectName}}

{{description}}

## Setup

\`\`\`bash
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
\`\`\`

## Run

\`\`\`bash
uvicorn app.main:app --reload
\`\`\`

## API Docs

- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc

## License

MIT
`,
      },
    },
  },

  [PROJECT_TYPES.REACT_TYPESCRIPT]: {
    name: 'React TypeScript',
    description: 'React application with TypeScript and Vite',
    category: 'frontend',
    directories: ['src', 'src/components', 'src/hooks', 'src/types', 'public'],
    files: {
      'package.json': {
        type: 'json',
        content: {
          name: '{{projectName}}',
          version: '1.0.0',
          type: 'module',
          scripts: {
            dev: 'vite',
            build: 'tsc && vite build',
            preview: 'vite preview',
            lint: 'eslint src --ext ts,tsx',
          },
          dependencies: {
            react: '^18.2.0',
            'react-dom': '^18.2.0',
          },
          devDependencies: {
            '@types/react': '^18.2.48',
            '@types/react-dom': '^18.2.18',
            '@vitejs/plugin-react': '^4.2.1',
            typescript: '^5.3.3',
            vite: '^5.0.12',
          },
        },
      },
      'tsconfig.json': {
        type: 'json',
        content: {
          compilerOptions: {
            target: 'ES2020',
            useDefineForClassFields: true,
            lib: ['ES2020', 'DOM', 'DOM.Iterable'],
            module: 'ESNext',
            skipLibCheck: true,
            moduleResolution: 'bundler',
            allowImportingTsExtensions: true,
            resolveJsonModule: true,
            isolatedModules: true,
            noEmit: true,
            jsx: 'react-jsx',
            strict: true,
            noUnusedLocals: true,
            noUnusedParameters: true,
            noFallthroughCasesInSwitch: true,
          },
          include: ['src'],
          references: [{ path: './tsconfig.node.json' }],
        },
      },
      'tsconfig.node.json': {
        type: 'json',
        content: {
          compilerOptions: {
            composite: true,
            skipLibCheck: true,
            module: 'ESNext',
            moduleResolution: 'bundler',
            allowSyntheticDefaultImports: true,
          },
          include: ['vite.config.ts'],
        },
      },
      'vite.config.ts': {
        type: 'text',
        content: `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})
`,
      },
      'index.html': {
        type: 'text',
        content: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{{projectName}}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
      },
      'src/main.tsx': {
        type: 'text',
        content: `import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
`,
      },
      'src/App.tsx': {
        type: 'text',
        content: `import { useState } from 'react'
import './App.css'

function App() {
  const [count, setCount] = useState(0)

  return (
    <div className="App">
      <h1>{{projectName}}</h1>
      <p>{{description}}</p>
      <button onClick={() => setCount(c => c + 1)}>
        Count: {count}
      </button>
    </div>
  )
}

export default App
`,
      },
      'src/App.css': {
        type: 'text',
        content: `.App {
  text-align: center;
  padding: 2rem;
}

button {
  padding: 0.5rem 1rem;
  font-size: 1rem;
  cursor: pointer;
}
`,
      },
      'src/index.css': {
        type: 'text',
        content: `:root {
  font-family: Inter, system-ui, Avenir, Helvetica, Arial, sans-serif;
  line-height: 1.5;
  font-weight: 400;
}

body {
  margin: 0;
  min-height: 100vh;
}
`,
      },
      '.gitignore': {
        type: 'text',
        content: `node_modules/
dist/
.env
.env.local
*.log
.DS_Store
`,
      },
      'README.md': {
        type: 'text',
        content: `# {{projectName}}

{{description}}

## Setup

\`\`\`bash
npm install
\`\`\`

## Development

\`\`\`bash
npm run dev
\`\`\`

## Build

\`\`\`bash
npm run build
\`\`\`

## License

MIT
`,
      },
    },
  },

  [PROJECT_TYPES.ELECTRON_BASIC]: {
    name: 'Electron Basic',
    description: 'Desktop application with Electron',
    category: 'desktop',
    directories: ['src', 'src/renderer', 'assets'],
    files: {
      'package.json': {
        type: 'json',
        content: {
          name: '{{projectName}}',
          version: '1.0.0',
          description: '{{description}}',
          main: 'src/main.js',
          scripts: {
            start: 'electron .',
            build: 'electron-builder',
          },
          devDependencies: {
            electron: '^28.1.0',
            'electron-builder': '^24.9.1',
          },
        },
      },
      'src/main.js': {
        type: 'text',
        content: `const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile('src/renderer/index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
`,
      },
      'src/preload.js': {
        type: 'text',
        content: `const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  send: (channel, data) => ipcRenderer.send(channel, data),
  receive: (channel, func) => ipcRenderer.on(channel, (event, ...args) => func(...args)),
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
});
`,
      },
      'src/renderer/index.html': {
        type: 'text',
        content: `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'">
  <title>{{projectName}}</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <h1>{{projectName}}</h1>
  <p>{{description}}</p>
  <script src="renderer.js"></script>
</body>
</html>
`,
      },
      'src/renderer/styles.css': {
        type: 'text',
        content: `body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  margin: 0;
  padding: 2rem;
  background: #1e1e1e;
  color: #fff;
}

h1 {
  margin-bottom: 0.5rem;
}
`,
      },
      'src/renderer/renderer.js': {
        type: 'text',
        content: `// Renderer process code
console.log('{{projectName}} renderer loaded');
`,
      },
      '.gitignore': {
        type: 'text',
        content: `node_modules/
dist/
out/
.env
*.log
.DS_Store
`,
      },
      'README.md': {
        type: 'text',
        content: `# {{projectName}}

{{description}}

## Setup

\`\`\`bash
npm install
\`\`\`

## Development

\`\`\`bash
npm start
\`\`\`

## Build

\`\`\`bash
npm run build
\`\`\`

## License

MIT
`,
      },
    },
  },

  [PROJECT_TYPES.HIVEMIND_WORKSPACE]: {
    name: 'Hivemind Workspace',
    description: 'Multi-agent workspace structure for Hivemind projects',
    category: 'hivemind',
    directories: [
      'workspace',
      'workspace/build',
      'workspace/build/reviews',
      'workspace/triggers',
      'workspace/messages',
      'workspace/history',
      'docs',
      'docs/claude',
    ],
    files: {
      'CLAUDE.md': {
        type: 'text',
        content: `# CLAUDE.md

## Project: {{projectName}}

{{description}}

## Roles

| Role | Owner | Focus |
|------|-------|-------|
| Architect | Pane 1 | Architecture, coordination |
| DevOps | Pane 2 | CI/CD, deployment, infra, backend |
| Analyst | Pane 5 | Debugging, profiling, analysis |

## Quick Start

1. Open this project in Hivemind
2. Agents will auto-register from docs/claude/REGISTRY.md
3. Check workspace/build/status.md for current progress

## Communication

- Triggers: workspace/triggers/
- Status: workspace/build/status.md
- Blockers: workspace/build/blockers.md
`,
      },
      'AGENTS.md': {
        type: 'text',
        content: `# AGENTS.md

## Project: {{projectName}}

Use this file for Codex-focused role guidance.

## Role Sections

### Architect
- Owns planning, architecture, and cross-agent coordination.

### DevOps
- Owns CI/CD, deployment, daemon/process lifecycle, and backend IPC.

### Analyst
- Owns debugging, profiling, and root cause analysis.
`,
      },
      'GEMINI.md': {
        type: 'text',
        content: `# GEMINI.md

## Project: {{projectName}}

Use this file for Gemini-focused role guidance.

## Role Sections

### Architect
- Coordination, review, and high-level decisions.

### DevOps
- Infrastructure and backend execution.

### Analyst
- Investigation and evidence gathering.
`,
      },
      'SPRINT.md': {
        type: 'text',
        content: `# Sprint Plan

## Current Sprint: Sprint 1

### Goals
- [ ] Initial setup
- [ ] Core implementation
- [ ] Testing

### Tasks

| Task | Owner | Status | Notes |
|------|-------|--------|-------|
| Task 1 | DevOps | Pending | |
| Task 2 | DevOps | Pending | |
| Task 3 | Analyst | Pending | |

## Notes

Add sprint notes here.
`,
      },
      'workspace/shared_context.md': {
        type: 'text',
        content: `# Shared Context

## Current State
- Phase: Setup
- Active Tasks: None

## Session Notes

_No notes yet_
`,
      },
      'workspace/build/status.md': {
        type: 'text',
        content: `# Build Status

## Completed
_None yet_

## In Progress
_None yet_

## Pending
_Check SPRINT.md for task assignments_
`,
      },
      'workspace/build/blockers.md': {
        type: 'text',
        content: `# Blockers

_No active blockers_
`,
      },
      'workspace/build/errors.md': {
        type: 'text',
        content: `# Errors Log

_No errors logged_
`,
      },
      'docs/claude/REGISTRY.md': {
        type: 'text',
        content: `# Agent Registry

| Role | Status | Agent | Date |
|------|--------|-------|------|
| Architect | OPEN | | |
| DevOps | OPEN | | |
| Analyst | OPEN | | |
`,
      },
      '.gitignore': {
        type: 'text',
        content: `node_modules/
.env
*.log
workspace/messages/
workspace/triggers/*.txt
__pycache__/
.DS_Store
`,
      },
      'README.md': {
        type: 'text',
        content: `# {{projectName}}

{{description}}

## Hivemind Project

This project is structured for multi-agent development with Hivemind.

## Getting Started

1. Open in Hivemind desktop app
2. Agents will auto-register
3. Check SPRINT.md for current tasks

## Structure

\`\`\`
├── CLAUDE.md           # Project instructions
├── AGENTS.md           # Codex role instructions
├── GEMINI.md           # Gemini role instructions
├── SPRINT.md           # Sprint plan
├── workspace/
│   ├── shared_context.md
│   ├── build/
│   │   ├── status.md
│   │   ├── blockers.md
│   │   └── errors.md
│   ├── triggers/       # Inter-agent messaging
│   └── messages/       # Message queue
└── docs/
    └── claude/
        └── REGISTRY.md
\`\`\`

## License

MIT
`,
      },
    },
  },

  [PROJECT_TYPES.MONOREPO]: {
    name: 'Monorepo',
    description: 'Multi-package monorepo with npm workspaces',
    category: 'infrastructure',
    directories: ['packages', 'packages/core', 'packages/cli', 'packages/shared'],
    files: {
      'package.json': {
        type: 'json',
        content: {
          name: '{{projectName}}',
          version: '1.0.0',
          private: true,
          workspaces: ['packages/*'],
          scripts: {
            build: 'npm run build --workspaces',
            test: 'npm run test --workspaces',
            lint: 'npm run lint --workspaces',
          },
          devDependencies: {
            eslint: '^8.56.0',
          },
        },
      },
      'packages/core/package.json': {
        type: 'json',
        content: {
          name: '@{{projectName}}/core',
          version: '1.0.0',
          main: 'src/index.js',
          scripts: {
            build: 'echo "Build core"',
            test: 'node --test',
          },
        },
      },
      'packages/core/src/index.js': {
        type: 'text',
        content: `/**
 * @{{projectName}}/core
 * Core functionality
 */

module.exports = {
  version: '1.0.0',
};
`,
      },
      'packages/cli/package.json': {
        type: 'json',
        content: {
          name: '@{{projectName}}/cli',
          version: '1.0.0',
          bin: {
            '{{projectName}}': './src/cli.js',
          },
          dependencies: {
            '@{{projectName}}/core': '*',
          },
        },
      },
      'packages/cli/src/cli.js': {
        type: 'text',
        content: `#!/usr/bin/env node

const core = require('@{{projectName}}/core');

console.log('{{projectName}} CLI v' + core.version);
`,
      },
      'packages/shared/package.json': {
        type: 'json',
        content: {
          name: '@{{projectName}}/shared',
          version: '1.0.0',
          main: 'src/index.js',
        },
      },
      'packages/shared/src/index.js': {
        type: 'text',
        content: `/**
 * @{{projectName}}/shared
 * Shared utilities
 */

module.exports = {};
`,
      },
      '.gitignore': {
        type: 'text',
        content: `node_modules/
dist/
.env
*.log
.DS_Store
`,
      },
      'README.md': {
        type: 'text',
        content: `# {{projectName}}

{{description}}

## Packages

- \`@{{projectName}}/core\` - Core functionality
- \`@{{projectName}}/cli\` - CLI tool
- \`@{{projectName}}/shared\` - Shared utilities

## Setup

\`\`\`bash
npm install
\`\`\`

## Build

\`\`\`bash
npm run build
\`\`\`

## License

MIT
`,
      },
    },
  },

  [PROJECT_TYPES.EMPTY]: {
    name: 'Empty Project',
    description: 'Minimal project with just README and gitignore',
    category: 'basic',
    directories: ['src', 'docs'],
    files: {
      '.gitignore': {
        type: 'text',
        content: `node_modules/
.env
*.log
.DS_Store
__pycache__/
`,
      },
      'README.md': {
        type: 'text',
        content: `# {{projectName}}

{{description}}

## Getting Started

Add your getting started instructions here.

## License

MIT
`,
      },
    },
  },
};

/**
 * ProjectScaffolder class
 * Handles project creation and scaffolding
 */
class ProjectScaffolder {
  constructor() {
    this.templates = PROJECT_TEMPLATES;
    this.customTemplates = new Map();
  }

  /**
   * Get all available templates
   */
  getTemplates() {
    const templates = [];

    // Built-in templates
    for (const [type, template] of Object.entries(this.templates)) {
      templates.push({
        id: type,
        ...template,
        source: 'builtin',
      });
    }

    // Custom templates
    for (const [id, template] of this.customTemplates) {
      templates.push({
        id,
        ...template,
        source: 'custom',
      });
    }

    return templates;
  }

  /**
   * Get template by ID
   */
  getTemplate(templateId) {
    if (this.templates[templateId]) {
      return { id: templateId, ...this.templates[templateId], source: 'builtin' };
    }
    if (this.customTemplates.has(templateId)) {
      return { id: templateId, ...this.customTemplates.get(templateId), source: 'custom' };
    }
    return null;
  }

  /**
   * Add custom template
   */
  addCustomTemplate(id, template) {
    this.customTemplates.set(id, {
      ...template,
      createdAt: Date.now(),
    });
    return { id, ...template };
  }

  /**
   * Remove custom template
   */
  removeCustomTemplate(id) {
    return this.customTemplates.delete(id);
  }

  /**
   * Scaffold a project from template
   */
  async scaffold(targetPath, templateId, variables = {}, options = {}) {
    const template = this.getTemplate(templateId);
    if (!template) {
      return { success: false, error: `Template not found: ${templateId}` };
    }

    const opts = { ...DEFAULT_OPTIONS, ...options };
    const vars = {
      projectName: path.basename(targetPath),
      description: '',
      author: '',
      ...variables,
    };

    // Check if target exists
    if (fs.existsSync(targetPath)) {
      if (!opts.overwrite) {
        const files = fs.readdirSync(targetPath);
        if (files.length > 0) {
          return { success: false, error: 'Target directory is not empty' };
        }
      }
    } else {
      fs.mkdirSync(targetPath, { recursive: true });
    }

    const created = {
      directories: [],
      files: [],
    };

    try {
      // Create directories
      if (template.directories) {
        for (const dir of template.directories) {
          const dirPath = path.join(targetPath, dir);
          if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
            created.directories.push(dir);
          }
        }
      }

      // Create files
      if (template.files) {
        for (const [filePath, fileConfig] of Object.entries(template.files)) {
          const fullPath = path.join(targetPath, filePath);
          const dirPath = path.dirname(fullPath);

          // Ensure directory exists
          if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
          }

          // Generate content
          let content;
          if (fileConfig.type === 'json') {
            content = JSON.stringify(
              this._replaceVariables(fileConfig.content, vars),
              null,
              2
            );
          } else {
            content = this._replaceVariablesInString(
              fileConfig.content,
              vars
            );
          }

          fs.writeFileSync(fullPath, content, 'utf-8');
          created.files.push(filePath);
        }
      }

      return {
        success: true,
        path: targetPath,
        template: templateId,
        created,
      };
    } catch (err) {
      return {
        success: false,
        error: err.message,
        created,
      };
    }
  }

  /**
   * Replace variables in object
   */
  _replaceVariables(obj, vars) {
    if (typeof obj === 'string') {
      return this._replaceVariablesInString(obj, vars);
    }
    if (Array.isArray(obj)) {
      return obj.map(item => this._replaceVariables(item, vars));
    }
    if (obj && typeof obj === 'object') {
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        const newKey = this._replaceVariablesInString(key, vars);
        result[newKey] = this._replaceVariables(value, vars);
      }
      return result;
    }
    return obj;
  }

  /**
   * Replace variables in string
   */
  _replaceVariablesInString(str, vars) {
    if (typeof str !== 'string') return str;
    return str.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return vars[key] !== undefined ? vars[key] : match;
    });
  }

  /**
   * Preview what would be created
   */
  preview(templateId) {
    const template = this.getTemplate(templateId);
    if (!template) {
      return { success: false, error: 'Template not found' };
    }

    return {
      success: true,
      template: {
        id: templateId,
        name: template.name,
        description: template.description,
        category: template.category,
      },
      directories: template.directories || [],
      files: Object.keys(template.files || {}),
    };
  }

  /**
   * Export template to JSON
   */
  exportTemplate(templateId) {
    const template = this.getTemplate(templateId);
    if (!template) {
      return { success: false, error: 'Template not found' };
    }

    return {
      success: true,
      json: JSON.stringify(template, null, 2),
    };
  }

  /**
   * Import template from JSON
   */
  importTemplate(json, customId) {
    try {
      const template = typeof json === 'string' ? JSON.parse(json) : json;
      const id = customId || `custom-${Date.now()}`;
      this.addCustomTemplate(id, template);
      return { success: true, id };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}

// Singleton instance
let scaffolderInstance = null;

function getProjectScaffolder() {
  if (!scaffolderInstance) {
    scaffolderInstance = new ProjectScaffolder();
  }
  return scaffolderInstance;
}

function resetScaffolder() {
  scaffolderInstance = null;
}

module.exports = {
  ProjectScaffolder,
  getProjectScaffolder,
  resetScaffolder,
  PROJECT_TYPES,
  PROJECT_TEMPLATES,
  DEFAULT_OPTIONS,
};
