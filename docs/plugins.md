# Hivemind Plugin System

Hivemind supports a lightweight plugin system in the main process. Plugins are
loaded from `workspace/plugins` and can register hooks, commands, and lifecycle
callbacks to extend core behavior.

## Plugin Location

Place plugins here:

```
workspace/
  plugins/
    my-plugin/
      plugin.json
      index.js
```

The plugin manager automatically creates `workspace/plugins/.data` for per-plugin
storage and `workspace/plugins/plugins.json` for enable/disable state.

## Manifest Formats

### plugin.json

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "Example plugin",
  "main": "index.js",
  "enabled": true,
  "timeoutMs": 2000
}
```

### package.json (optional)

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "hivemind": {
    "id": "my-plugin",
    "name": "My Plugin",
    "main": "index.js",
    "timeoutMs": 2000
  }
}
```

## Plugin Module API

Your `index.js` should export an object:

```js
module.exports = {
  onInit(api, manifest) {
    api.log('info', `Loaded ${manifest.name}`);
  },
  onUnload(api) {
    api.log('info', 'Unloaded');
  },
  hooks: {
    'message:beforeSend': (payload, api) => {
      // Optionally modify outbound messages
      return { message: `[PLUGIN] ${payload.message}` };
    },
    'message:afterSend': async (payload, api) => {
      api.log('debug', `Delivered ${payload.type} to ${payload.targets.join(',')}`);
    }
  },
  commands: [
    {
      id: 'ping',
      title: 'Ping',
      description: 'Emit a toast from the plugin',
      run: async (args, api) => {
        api.notify('Plugin ping', 'info');
        return { ok: true };
      }
    }
  ]
};
```

## Hook Events

Hooks can be synchronous or async depending on the event.

### Sync Hooks (message:beforeSend)

`message:beforeSend` runs synchronously and can modify outbound messages.

Payload:
```
{
  type: 'notify' | 'broadcast' | 'direct' | 'trigger',
  targets: string[],
  message: string,
  fromRole?: string,
  file?: string,
  sender?: string,
  seq?: number,
  mode: 'pty'
}
```

Return any of:
```
{ message?: string, targets?: string[], fromRole?: string, cancel?: boolean }
```

### Async Hooks

Async hooks are run with a timeout (default 2000ms).

- `message:afterSend` — called after delivery attempt
- `trigger:received` — trigger file parsed, before dispatch
- `activity:log` — new activity log entry
- `daemon:data` — raw daemon output data
- `agent:stateChanged` — agent running/idle transitions
- `agent:activity` — Codex activity updates

## Plugin API (Available in hooks/commands)

`api` provides:

- `log(level, message, meta?)`
- `notify(message, type?)` (toast)
- `emit(channel, payload)` (renderer event)
- `sendDirectMessage(targets, message)`
- `notifyAgents(targets, message)`
- `broadcast(message)`
- `logActivity(type, paneId, message, details?)`
- `storage.read()` / `storage.write(state)`
- `getSettings()` / `getState()`

## IPC Commands (for UI integration)

The main process exposes these IPC channels:

- `list-plugins`
- `enable-plugin`
- `disable-plugin`
- `reload-plugin`
- `reload-plugins`
- `run-plugin-command`

## Notes

- Plugins run in the main process; keep them lightweight.
- Use `timeoutMs` in the manifest to limit hook/command runtime.
- Failed hooks are logged and do not crash the app.
