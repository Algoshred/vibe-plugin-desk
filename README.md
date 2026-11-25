# @vibecontrols/vibe-plugin-desk

The desk meta plugin for [VibeControls](https://vibecontrols.com). It lets a BotManor Steward use a desk (a browser or a desktop) through the VibeControls agent, and keeps the person who owns the machine in control.

The meta does not drive a screen itself. Desk providers do the work, and the meta routes each action to one of them:

| Provider                       | Package                                              | Status  |
| ------------------------------ | ---------------------------------------------------- | ------- |
| Managed browser (Playwright)   | `@vibecontrols/vibe-plugin-desk-browser`             | planned |
| Linux desktop (Xvfb + xdotool) | `@vibecontrols/vibe-plugin-desk-x11`                 | planned |
| macOS, Windows                 | `vibe-plugin-desk-macos`, `vibe-plugin-desk-windows` | planned |

No provider is installed by default. Each one is installed on purpose.

## What the meta enforces

Every provider is wrapped in the desk guard from `@vibecontrols/plugin-sdk/desk`, so these rules hold for every provider:

- **Remote control is off by default.** Nothing runs until the machine's owner turns it on.
- **Kill switch.** When it is on, every action is refused at once.
- **Fencing.** Each desk remembers the highest fencing token it has seen. A lower token is refused with `STALE_FENCING_TOKEN`. When a person takes over, the fence is raised, so the Steward cannot act again until it gets a new lease. Fences survive a provider reload.
- **Idempotency.** A repeated `idempotencyKey` returns the stored result and does not act twice.
- **Workspace folder.** `read_file`, `write_file` and `shell` stay inside one folder, after symlinks are resolved.
- **Timeouts.** An action that overruns returns `TIMEOUT` and is aborted.
- **Untrusted output.** Every result is marked `provenance: "UNTRUSTED"`, whatever the provider says.
- **Audit without payloads.** Each decision is audited (provider, desk, action type, outcome). Typed text, file content, commands and screenshots are never audited.

## Configuration

Set these with `vibe config set <key> <value>`:

| Key                     | Default                             | Meaning                                                        |
| ----------------------- | ----------------------------------- | -------------------------------------------------------------- |
| `desk.remote-control`   | off                                 | `on` allows a Steward to act on this machine                   |
| `desk.kill-switch`      | off                                 | `on` refuses every action immediately                          |
| `desk.workspace-folder` | `<profile data dir>/desk-workspace` | The only folder file and shell actions may use. Read at start. |
| `desk.default-provider` | the elected provider                | The provider used when a request names none                    |

## HTTP API

The agent mounts these routes under `/api/desk`, behind its own authentication:

| Route            | Purpose                                                         |
| ---------------- | --------------------------------------------------------------- |
| `GET /providers` | Registered providers, their kind, and the actions each supports |
| `GET /health`    | Readiness, remote control and kill switch state                 |
| `POST /act`      | Run one action                                                  |
| `POST /fence`    | Raise a desk's fence after a takeover                           |

`POST /act` body:

```json
{
  "provider": "desk-browser",
  "deskId": "desk-1",
  "fencingToken": "42",
  "idempotencyKey": "step-17",
  "timeoutMs": 10000,
  "action": { "type": "click", "target": { "by": "ref", "ref": "e12" } }
}
```

`fencingToken` is a decimal string, because JSON has no big integers. A screenshot comes back as `screenshotPngBase64`. A request that is not valid gets `400`. A desk-level refusal (stale token, kill switch, outside the folder) gets `200` with `ok: false` and an `error.code`.

Other plugins reach the same manager in process as the `desk` / `manager` service.

## Actions

The vocabulary is the one in `@vibecontrols/plugin-sdk/desk`, shared with the BotManor server: `screenshot`, `snapshot`, `click`, `type`, `secret_fill`, `key`, `scroll`, `navigate`, `focus_window`, `shell`, `read_file` and `write_file`. Every action is validated field by field before a provider sees it.

## Writing a provider

A provider implements `DeskBackend` and registers it from `onServerStart`:

```ts
import type { DeskBackend } from "@vibecontrols/plugin-sdk/desk";

const backend: DeskBackend = {
  kind: "x11",
  actions: ["screenshot", "click", "type", "key"],
  async act(action, { signal, paths }) {
    // Use `paths.path` / `paths.cwd` for file and shell actions, never the raw action fields.
    return { ok: true };
  },
};

export function createPlugin() {
  return {
    name: "desk-x11",
    version: "1.0.0",
    onServerStart(_app, host) {
      host.serviceRegistry?.registerProvider?.("desk", backend, "desk-x11");
    },
  };
}
```

## Development

```bash
bun install
bun run sanity   # format, lint, type check, build, tests
```

## License

MIT
