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

## Own-machine safety

When BotManor drives this machine over the agent bridge (`desk.act`, `desk.fence` and `desk.health` commands), every action goes through the `desk` / `remote` service. On top of `desk.remote-control`, that service enforces:

- **Local consent.** A Steward acts only after the person at the machine approved it, for the grant it asked with. A request from a Steward that is not approved, or whose grant id or version changed, is refused with `LOCAL_CONSENT_OFF` and listed as waiting. Nothing that arrives over the bridge can approve anything.
- **App allow list.** On a desktop desk, the app an action targets and the app in front must both be among the apps the person approved for that Steward. Otherwise the action is refused (`LOCAL_CONSENT_OFF`) and audited as `desk.app.refused`. A provider that cannot report the app in front gets no actions, except file and shell actions confined to the workspace folder. The managed browser desk is exempt: it is the one app.
- **Steward in control.** The first accepted action starts a session. Providers that implement `showIndicator` draw it on screen, `vibe desk status` and `GET /api/desk/session` show it, and the server gets a `desk.session` `started` event. Only one Steward is in control at a time. The session ends after 5 minutes without an action, when consent is withdrawn, or when the kill switch is pressed, and the server gets `desk.session` `ended` with the reason.
- **Kill switch.** `vibe desk kill` (or `POST /api/desk/kill`) aborts every action in flight at once and refuses all new ones. It also withdraws every approval, so after `vibe desk resume` each Steward needs a new approval. The daemon checks for a kill switch pressed from another process every 250 ms.

The person manages this from the machine:

```bash
vibe desk status                                   # who is in control, kill switch, approvals
vibe desk consent approve <stewardId> --apps "Safari,Notes"
vibe desk consent revoke <stewardId>
vibe desk kill
vibe desk resume
```

Decisions are kept in `desk-consent.json` (mode 0600) in the profile data directory. A damaged file reads as "kill switch engaged, nothing approved".

`desk.act` payload over the bridge: the `POST /act` body below plus `"steward": { "id", "name", "grantId", "grantVersion", "apps": [...] }`.

## HTTP API

The agent mounts these routes under `/api/desk`, behind its own authentication:

| Route                              | Purpose                                                         |
| ---------------------------------- | --------------------------------------------------------------- |
| `GET /providers`                   | Registered providers, their kind, and the actions each supports |
| `GET /health`                      | Readiness, remote control and kill switch state                 |
| `POST /act`                        | Run one action                                                  |
| `POST /fence`                      | Raise a desk's fence after a takeover                           |
| `GET /session`                     | The Steward in control, or `null`                               |
| `GET /consent`                     | Approvals, pending requests and kill switch                     |
| `POST /consent/:stewardId/approve` | Approve a pending request (`{ "apps"?: [...] }`)                |
| `POST /consent/:stewardId/revoke`  | Withdraw an approval                                            |
| `POST /kill` / `POST /resume`      | Press or release the kill switch                                |

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

A desktop provider should also implement the optional `DeskSafetyHooks`: `activeApp(signal)` returns the app in front (`{ name, bundleId? }`), so the app allow list can be enforced, and `showIndicator(state)` shows or hides the on-screen "Steward in control" indicator. A provider should check the app in front again right before it injects input, because focus can change between the meta's check and the action.

## Development

```bash
bun install
bun run sanity   # format, lint, type check, build, tests
```

## License

MIT
