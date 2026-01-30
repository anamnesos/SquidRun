# Agent Templates Library

Hivemind ships a built-in library of agent configuration templates. Templates
are meant to capture common operational setups (hybrid, research sprint, review
focus) and can be imported/exported for sharing.

## Built-in Templates

Built-ins live in `ui/modules/agent-templates.js` and appear alongside user
templates in the Templates tab. Built-ins are read-only.

Included:
- Hybrid Default (Claude + Codex)
- All Claude (Safe Mode)
- All Codex (Autonomous)
- Research Sprint
- Review Battle
- Focus Mode

## IPC Endpoints

Templates can be managed through IPC handlers in `ui/modules/ipc/template-handlers.js`.

List/export:
- `list-templates`
- `get-template`
- `export-template`
- `export-templates`

Import/save:
- `save-template`
- `import-template`
- `import-templates`
- `delete-template`

## Template Shape

```json
{
  "id": "tmpl-1234",
  "name": "Research Sprint",
  "description": "High communication mode",
  "config": {
    "autoSpawn": true,
    "autoSync": true,
    "paneCommands": { "1": "claude", "2": "codex" }
  },
  "paneProjects": {},
  "createdAt": "2026-01-30T00:00:00.000Z",
  "updatedAt": "2026-01-30T00:00:00.000Z"
}
```

`config` maps directly to `ui/settings.json` fields. Loading a template merges
`config` and `paneProjects` into the current settings.
