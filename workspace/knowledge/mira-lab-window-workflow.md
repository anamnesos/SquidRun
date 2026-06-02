# Mira Lab Standalone Window Workflow

## Overview
The Mira Lab UI (`ui/mira-lab.html`) is designed as a standalone window separate from the main SquidRun panel. It serves as a conversation-first environment to test Mira Presence without dashboard chrome.

## Launch Path
The Mira Lab window can be launched via the Command Palette:
1. Open Command Palette.
2. Select "Open Mira Lab" (`open-mira-lab`).
3. This triggers `openAppWindow('mira-lab')` which manages the window lifecycle, enforces menu suppression, and handles closed-window cleanup without duplicating existing open windows.

## IPC Channels
The following channels are allowlisted for the Mira Lab preload:
- `mira:lab-open`
- `mira:lab-turn`
- `mira:lab-export`

## Restart Requirements
Changes to the main-process IPC (such as `mira-lab-window.js` or `handler-registry.js`) require a full Electron app restart, not just a renderer reload.
