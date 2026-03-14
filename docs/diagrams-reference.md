# SquidRun Architecture Diagrams - Excalidraw Reference

This document provides visual ASCII diagram templates intended to be recreated directly in Excalidraw. 

---

## Diagram 1: Agent Message Flow

```text
┌─────────────────┐                           ┌──────────────────────────────┐
│                 │                           │  evidence-ledger.db          │
│                 │                           │  (Comms Journal / SQLite)    │
│   USER INPUT    │                           └──────────────▲───────────────┘
│  (Terminal UI)  │                                          │
│                 │                                          │ Logs routed/brokered events
└────────┬────────┘                                          │
         │                                    ┌────────────┴─────────────┐
         │ direct input                       │  squidrun-app.js         │
         │ into pane                          │  (Main Coordinator)      │
         │                                    │  ┌────────────────────┐  │
         │                                    │  │ websocket-runtime  │  │
         │                                    │  │ (In-process WS bus)│  │
         │                                    │  └─────────▲──────────┘  │
         │                                    └────────────┼─────────────┘
         │                                                 │
         │                                                 │ payload (via WS)
         │                                                 │
         │                                    ┌────────────┴─────────────┐
         │                                    │  hm-send.js              │
         │                                    │  (CLI Tool)              │
         │                                    └────────────▲─────────────┘
         │                                                 │
         │                                                 │ Agent calls command
         ▼                                                 │
┌─────────────────┐                       ┌────────────────┴───────────────────┐
│                 │                       │                                    │
│  AGENT PANES    │                       │  ┌────────────┐    ┌────────────┐  │
│                 │                       │  │ Builder    │    │ Oracle     │  │
│  ┌───────────┐  │                       │  │ (Pane 2)   │    │ (Pane 3)   │  │
│  │ Architect │  │                       │  └────────────┘    └────────────┘  │
│  │ (Pane 1)  │  │                       │                                    │
│  └───────────┘  │                       │                                    │
│                 │                       └────────────────────────────────────┘
└────────▲────────┘
         │
         │                                  EXTERNAL CHANNELS
         │                          ┌────────────────────────────────┐
         │ formatting               │                                │
         │                          │   ┌──────────────┐             │
┌────────┴─────────┐                │   │ hm-telegram  │──▶ Telegram │
│ injection.js     │                │   └──────────────┘             │
│ (PTY Writer)     │                │          ▲                     │
└────────▲─────────┘                │          │                     │
         │                          └──────────┼─────────────────────┘
         │                                     │ Branch on target
┌────────┴─────────┐                           │ ('user' or 'telegram')
│ triggers.        │                           │
│ sendDirectMessage│                           │
└────────▲─────────┘                           │
         │                                     │
         └─────────────────────────────────────┘
```

**Constraints to Note in Diagram:**
*   **Allowed Local:** Architect ↔ Builder, Architect ↔ Oracle, Builder ↔ Oracle.

---

## Diagram 2: Knowledge & Memory System

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                        │
│ LAYER 1: Shared Procedural Knowledge (Most Permanent)                                  │
│                                                                                        │
│   ┌─────────────────────────────────────┐ Cross-device via git/manual sync           │
│   │ workspace/knowledge/*.md            │◀──────────────────────────▶ ┌────────────┐   │
│   │ (Human-authored docs; queried via   │                             │ Git Repo   │   │
│   │ explicit ingest/search)             │                             └────────────┘   │
│   └─────────────────────────────────────┘                                              │
│                 ▲                                                                      │
│                 │ Explicit ingest/search via knowledge IPC                             │
│                 │ (knowledge-ingest, knowledge-search, knowledge-stats)                │
│                 │                                                                      │
└─────────────────┼──────────────────────────────────────────────────────────────────────┘
                  │
┌─────────────────┼──────────────────────────────────────────────────────────────────────┐
│                 │                                                                      │
│ LAYER 2: Session Handoffs (Cross-Session Persistence)                                  │
│                 │                                                                      │
│                 │  ┌─────────────────────────────────────┐                             │
│                 │  │ .squidrun/handoffs/session.md       │                             │
│                 │  │ (Prior decisions, open claims)      │                             │
│                 │  └──────────────────▲──────────────────┘                             │
│                 │                     │ Auto-materialized by `deterministic-v1`        │
│                 │                     │ (summarizes comms journal)                     │
│                 │                     │                                                │
└─────────────────┼─────────────────────┼────────────────────────────────────────────────┘
                  │                     │
┌─────────────────┼─────────────────────┼────────────────────────────────────────────────┐
│                 │                     │                                                │
│ LAYER 3: Comms Journal + Team Memory (Cross-Session, Local-Only)                       │
│                 │                     │                                                │
│                 │          ┌──────────┴──────────────┐     queries       ┌───────────┐ │
│                 │          │ .squidrun/runtime/      │◀──────────────────│ hm-comms  │ │
│                 │          │ evidence-ledger.db      │                   │ CLI Tool  │ │
│                 │          │ (Comms Journal)         │                   └───────────┘ │
│                 │          └──────────▲──────────────┘                                  │
│                 │                     │ feeds patterns/claims                            │
│                 │          ┌──────────┴──────────────┐                                  │
│                 │          │ .squidrun/runtime/      │                                  │
│                 │          │ team-memory.sqlite      │                                  │
│                 │          │ (claims/patterns/guards)│                                  │
│                 │          └─────────────────────────┘                                  │
│                 │                                                                      │
└─────────────────┼──────────────────────────────────────────────────────────────────────┘
                  │
┌─────────────────┼──────────────────────────────────────────────────────────────────────┐
│                 │                                                                      │
│ LAYER 4: Knowledge Graph + Model-Specific Memory (Local-Only)                           │
│                 │                                                                      │
│                 │  ┌─────────────────────────────────────┐                             │
│                 │  │ workspace/memory/_graph/            │                             │
│                 │  │ (nodes/edges persistent graph)      │                             │
│                 │  └─────────────────────────────────────┘                             │
│                 │                                                                      │
│                 │  ┌─────────────────────────────────────┐                             │
│                 │  │ ~/.claude/projects/.../MEMORY.md    │                             │
│                 │  │ (or Gemini equivalent)              │                             │
│                 │  └─────────────────────────────────────┘                             │
│                 │                                                                      │
└─────────────────┼──────────────────────────────────────────────────────────────────────┘
                  │
┌─────────────────┼──────────────────────────────────────────────────────────────────────┐
│                 │                                                                      │
│ LAYER 5: Runtime State (Session-Scoped, Ephemeral/Overwritten)                         │
│                 │                                                                      │
│                 ▼                                                                      │
│    ┌─────────────────────────┐   ┌───────────────────────┐   ┌───────────────────────┐ │
│    │ .squidrun/app-status.json │   │ .squidrun/link.json   │   │ .squidrun/            │ │
│    │ (Session ID, Host State)│   │ (Workspace routing)   │   │ context-snapshots/    │ │
│    └─────────────────────────┘   └───────────────────────┘   └───────────────────────┘ │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘

                      │
                      │
                      ▼
             ┌─────────────────┐
             │                 │
             │   ALL AGENTS    │
             │                 │
             └─────────────────┘
```
