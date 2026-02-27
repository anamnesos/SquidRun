# Workspace Model: App vs Project Boundary

This document explains what lives where, and who owns what.

## Short Version

- SquidRun app: the application you launch.
- Project workspace: the folder you select in SquidRun.
- `.squidrun/`: runtime and coordination state inside that project workspace.

Your selected workspace is not the SquidRun app source repository.

## Two Different Things

## 1) SquidRun App (Product Runtime)

The app provides:
- UI (3 panes)
- PTY/session orchestration
- Agent coordination and messaging
- Runtime services

You do not edit app internals during normal usage.

## 2) Project Workspace (Your Code + State)

The selected project folder contains:
- Your actual code/files
- SquidRun coordination/runtime metadata in `.squidrun/`

This is the working area agents operate on.

## What `.squidrun/` Is

`.squidrun/` is the workspace-local operational layer used by SquidRun.

Typical contents include:
- Runtime databases and ledgers (`runtime/`)
- Session handoff/context snapshots (`handoffs/`, `context-snapshots/`)
- Messaging launchers (`bin/`)
- App/session status files (`app-status.json`, `state.json`, `link.json`)
- Reports and generated diagnostics (`reports/`)

Think of it as “project-local control plane state,” not product source code.

## Ownership: User Files vs Runtime Files

User-owned (you own/edit as project code):
- Everything in your project that is part of your application/repo
- Examples: `src/`, tests, configs, docs you created for your project

SquidRun runtime-owned (app-managed):
- `.squidrun/**` operational files
- Generated status/snapshot/handoff/runtime DB artifacts

Practical rule:
- Edit your project code freely.
- Avoid manual edits in `.squidrun/` unless troubleshooting instructions explicitly say so.

## Persistent vs Ephemeral Data

Persistent (survives restarts):
- `.squidrun/runtime/*.db` ledgers/memory
- `.squidrun/handoffs/session.md`
- `.squidrun/context-snapshots/*`
- `.squidrun/app-status.json` and related status metadata

Ephemeral or frequently regenerated:
- Active trigger/state files
- Temporary coordination artifacts
- Session-scoped runtime details that may be refreshed on restart

If unsure, treat `.squidrun/` as app-managed state and avoid hand-editing.

## Why the Workspace Is Not the App Source Repo

SquidRun attaches to any project folder, including empty/new folders.
That workspace is where the team performs work.

So you may see:
- Your project files
- `.squidrun/` runtime metadata
- Docs seeded for agent behavior

You should not expect this folder to mirror SquidRun product internals.

## Common Confusion Patterns

1. “I don’t see full SquidRun source files in my project.”
- Expected. You are in a project workspace, not product source checkout.

2. “Why is `.squidrun/` in my project?”
- It stores local session/runtime context so agents can resume and coordinate.

3. “Can I delete `.squidrun/`?”
- You can, but you lose local history/state and may break current session continuity.

## Safe Operating Rules

1. Keep `.squidrun/` in the workspace root.
2. Back up your project as usual; include or exclude `.squidrun/` based on whether you want local session history preserved.
3. For errors, use documented diagnostics first (`hm-comms`, troubleshooting guide) before manual state edits.
4. Treat `.squidrun/bin` launchers as tooling shims, not your app’s runtime dependencies.