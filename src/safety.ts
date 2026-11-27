/**
 * Own-machine safety for BotManor Stewards (BOFF-16567): local consent, the
 * "Steward in control" session and indicator, the kill switch and the app
 * allow list.
 *
 * Every desk action that arrives over the BotManor command channel passes
 * through {@link DeskSafety.authorize} before the desk guard sees it:
 *
 *   1. kill switch      engaged -> KILL_SWITCH
 *   2. local consent    the Steward must be approved for its current grant;
 *                       otherwise the request is recorded as pending for the
 *                       person to approve, and refused LOCAL_CONSENT_OFF
 *   3. one Steward      while one Steward is in control, another is refused
 *   4. app allow list   on a desktop desk, the action's target app and the
 *                       app in front must be approved for this Steward;
 *                       otherwise refused LOCAL_CONSENT_OFF and audited
 *
 * The first accepted action starts a session: the "Steward in control"
 * indicator appears (on every provider that draws one, in `vibe desk status`
 * and `GET /api/desk/session`) and `desk.session` `started` goes to the
 * server. The session ends when the kill switch is pressed, the Steward's
 * consent is withdrawn, the plugin stops, or after {@link SAFETY_LIMITS.idleMs}
 * without an action; `desk.session` `ended` tells the server, which ends the
 * lease.
 *
 * The kill switch can be pressed from another process (`vibe desk kill`
 * writes the consent file), so the daemon re-reads that file every
 * {@link SAFETY_LIMITS.pollMs}; pressing it aborts every action in flight at
 * once, well within the one second the ticket allows.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import type { HostServices } from "@vibecontrols/plugin-sdk/contract";
import type {
  DeskAction,
  DeskActRequest,
  DeskActResult,
  DeskErrorCode,
  DeskTarget,
} from "@vibecontrols/plugin-sdk/desk";
import { BoundLogger } from "@vibecontrols/plugin-sdk/log";

import {
  type Approval,
  type ConsentState,
  ConsentStore,
  type StewardRef,
} from "./consent.js";
import {
  type DeskAppInfo,
  type DeskIndicatorState,
  type DeskManager,
  DeskManagerError,
} from "./manager.js";

export const SAFETY_LIMITS = {
  /** How often the daemon re-reads the kill switch and consent file. */
  pollMs: 250,
  /** A session with no action for this long ends. */
  idleMs: 5 * 60_000,
  /** Longest wait for a provider to report the app in front. */
  activeAppTimeoutMs: 2_000,
} as const;

/**
 * Desk kinds the app allow list does not apply to. The managed browser desk
 * is one app the person installed for the Steward; its own URL policy
 * decides where it may go.
 */
const APP_SCOPE_EXEMPT_KINDS: ReadonlySet<string> = new Set(["browser"]);

/** Actions confined to the workspace folder instead of an app. */
const FOLDER_ACTIONS: ReadonlySet<DeskAction["type"]> = new Set([
  "shell",
  "read_file",
  "write_file",
]);

export type SessionEndReason =
  "kill_switch" | "consent_revoked" | "idle" | "stopped";

export interface DeskSessionEvent {
  event: "started" | "ended";
  stewardId: string;
  stewardName: string;
  at: string;
  reason?: SessionEndReason;
}

/** The agent's bridge, as registered under `agent` / `bridge` (B4.6 agent side). */
interface BridgeEvents {
  publishEvent(event: {
    topic: string;
    payload: Record<string, unknown>;
  }): void;
}

export const DESK_SESSION_TOPIC = "desk.session";

type Refusal = { ok: false; code: DeskErrorCode; message: string };

export function refusal(code: DeskErrorCode, message: string): DeskActResult {
  return { ok: false, provenance: "UNTRUSTED", error: { code, message } };
}

/** App names a desk action targets explicitly. */
export function targetApps(action: DeskAction): string[] {
  const apps: string[] = [];
  const add = (target: DeskTarget | undefined) => {
    if (target?.by === "window") apps.push(target.app);
  };
  switch (action.type) {
    case "focus_window":
      apps.push(action.app);
      break;
    case "click":
    case "secret_fill":
      add(action.target);
      break;
    case "type":
    case "scroll":
      add(action.target);
      break;
    default:
      break;
  }
  return apps;
}

/** Is `app` on the approved list? Matches the name or the platform id. */
export function appAllowed(
  approval: Pick<Approval, "apps">,
  app: string | DeskAppInfo,
): boolean {
  const names =
    typeof app === "string"
      ? [app]
      : [app.name, ...(app.bundleId ? [app.bundleId] : [])];
  return names.some((n) => approval.apps.includes(n.trim().toLowerCase()));
}

const describeApp = (app: string | DeskAppInfo) =>
  typeof app === "string"
    ? app
    : app.bundleId
      ? `${app.name} (${app.bundleId})`
      : app.name;

interface ActiveSession extends DeskIndicatorState {
  lastActionAt: number;
}

export interface DeskSafetyOptions {
  store: ConsentStore;
  /**
   * Where the daemon records who is in control, for `vibe desk status` (a
   * separate process). Omitted: not recorded.
   */
  sessionFile?: string;
  manager: DeskManager;
  logger?: BoundLogger;
  now?: () => number;
  pollMs?: number;
  idleMs?: number;
}

export class DeskSafety {
  private host: HostServices | undefined;
  private session: ActiveSession | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private configKill = false;
  private readonly listeners = new Set<(event: DeskSessionEvent) => void>();
  private readonly now: () => number;

  constructor(private readonly options: DeskSafetyOptions) {
    this.now = options.now ?? Date.now;
  }

  get store(): ConsentStore {
    return this.options.store;
  }

  /** Start watching the kill switch and consent file. */
  start(host: HostServices): void {
    this.host = host;
    // A kill switch pressed while the daemon was down still holds.
    if (this.options.store.read().killSwitch) {
      this.options.manager.engageKillSwitch();
    }
    this.stopPolling();
    this.poller = setInterval(() => {
      void this.poll();
    }, this.options.pollMs ?? SAFETY_LIMITS.pollMs);
    (this.poller as { unref?: () => void }).unref?.();
  }

  stop(): void {
    this.stopPolling();
    this.endSession("stopped");
  }

  private stopPolling(): void {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
  }

  onSessionEvent(listener: (event: DeskSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The Steward in control now, or null. */
  current(): DeskIndicatorState | null {
    this.expireIdle();
    if (!this.session) return null;
    const { stewardId, stewardName, since } = this.session;
    return { stewardId, stewardName, since };
  }

  /** One tick of the watcher. Exposed for tests. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const state = this.options.store.read();
      this.applyFileState(state);
      // `vibe config set desk.kill-switch on` is the older switch; it must
      // stop actions in flight too, not only refuse new ones.
      await this.options.manager.health();
      const configKill =
        this.options.manager.configKillSwitch && !state.killSwitch;
      if (configKill && !this.configKill) this.trip("config");
      this.configKill = configKill;
      this.expireIdle();
    } catch (err) {
      this.options.logger?.warn(
        `desk safety check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.polling = false;
    }
  }

  private applyFileState(state: ConsentState): void {
    const manager = this.options.manager;
    if (state.killSwitch && !manager.killSwitchEngaged) {
      this.trip(state.killSwitch.source);
    } else if (
      !state.killSwitch &&
      manager.killSwitchEngaged &&
      !this.configKill
    ) {
      manager.releaseKillSwitch();
    }
    if (this.session && !state.stewards[this.session.stewardId]) {
      this.endSession(state.killSwitch ? "kill_switch" : "consent_revoked");
    }
  }

  /** Abort everything now and end the session. */
  private trip(source: string): void {
    this.options.manager.engageKillSwitch();
    this.options.logger?.warn(`desk kill switch pressed (${source})`);
    this.host?.audit?.emit("desk.kill_switch", { source });
    this.endSession("kill_switch");
  }

  /** Press the kill switch from this process (HTTP route). */
  kill(source: string): void {
    this.options.store.engageKillSwitch(source);
    this.trip(source);
  }

  /** Release the kill switch. Stewards need a fresh approval afterwards. */
  resume(): void {
    this.options.store.releaseKillSwitch();
    this.configKill = false;
    this.options.manager.releaseKillSwitch();
    this.host?.audit?.emit("desk.kill_switch.released", {});
  }

  approve(stewardId: string, apps?: readonly string[]): Approval {
    const approval = this.options.store.approve(stewardId, apps);
    this.host?.audit?.emit("desk.consent.granted", {
      stewardId,
      grantId: approval.grantId,
      grantVersion: approval.grantVersion,
      apps: approval.apps,
    });
    return approval;
  }

  revoke(stewardId: string): boolean {
    const revoked = this.options.store.revoke(stewardId);
    if (revoked) {
      this.host?.audit?.emit("desk.consent.revoked", { stewardId });
      if (this.session?.stewardId === stewardId)
        this.endSession("consent_revoked");
    }
    return revoked;
  }

  private expireIdle(): void {
    const idleMs = this.options.idleMs ?? SAFETY_LIMITS.idleMs;
    if (this.session && this.now() - this.session.lastActionAt >= idleMs) {
      this.endSession("idle");
    }
  }

  private startOrTouch(steward: StewardRef): void {
    this.expireIdle();
    if (this.session) {
      this.session.lastActionAt = this.now();
      return;
    }
    this.session = {
      stewardId: steward.id,
      stewardName: steward.name,
      since: new Date(this.now()).toISOString(),
      lastActionAt: this.now(),
    };
    const state = this.current();
    this.options.manager.showIndicator(state);
    this.writeSessionFile(state);
    this.options.logger?.info(
      `Steward ${steward.name} is in control of this machine`,
    );
    this.host?.audit?.emit("desk.session.started", { stewardId: steward.id });
    this.publish({
      event: "started",
      stewardId: steward.id,
      stewardName: steward.name,
      at: new Date(this.now()).toISOString(),
    });
  }

  private endSession(reason: SessionEndReason): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    this.options.manager.showIndicator(null);
    this.writeSessionFile(null);
    this.options.logger?.info(
      `Steward ${session.stewardName} is no longer in control (${reason})`,
    );
    this.host?.audit?.emit("desk.session.ended", {
      stewardId: session.stewardId,
      reason,
    });
    this.publish({
      event: "ended",
      stewardId: session.stewardId,
      stewardName: session.stewardName,
      at: new Date(this.now()).toISOString(),
      reason,
    });
  }

  private writeSessionFile(state: DeskIndicatorState | null): void {
    const file = this.options.sessionFile;
    if (!file) return;
    try {
      writeSessionState(file, state);
    } catch (err) {
      this.options.logger?.warn(
        `could not record the desk session: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private publish(event: DeskSessionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A listener's failure must not stop the kill switch.
      }
    }
    // Looked up per event: the agent registers the bridge after plugins load.
    const bridge = this.host?.serviceRegistry?.getService?.<BridgeEvents>(
      "agent",
      "bridge",
    );
    if (typeof bridge?.publishEvent !== "function") return;
    try {
      bridge.publishEvent({
        topic: DESK_SESSION_TOPIC,
        payload: { ...event },
      });
    } catch (err) {
      this.options.logger?.warn(
        `could not tell the server about the desk session: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Checks 1 to 4 above. On success the session is started or kept alive.
   */
  async authorize(
    steward: StewardRef,
    provider: string | undefined,
    action: DeskAction,
    signal: AbortSignal,
  ): Promise<{ ok: true; provider: string } | Refusal> {
    const manager = this.options.manager;
    const fileState = this.options.store.read();
    if (fileState.killSwitch || manager.killSwitchEngaged) {
      return {
        ok: false,
        code: "KILL_SWITCH",
        message: "the kill switch is engaged",
      };
    }

    const consent = this.options.store.check(steward);
    if (!consent.ok) {
      if (this.options.store.recordPending(steward)) {
        this.options.logger?.warn(
          `Steward ${steward.name} asks to use this machine; approve with: vibe desk consent approve ${steward.id}`,
        );
        this.host?.audit?.emit("desk.consent.requested", {
          stewardId: steward.id,
          grantId: steward.grantId,
          grantVersion: steward.grantVersion,
          reason: consent.reason,
        });
      }
      return {
        ok: false,
        code: "LOCAL_CONSENT_OFF",
        message:
          consent.reason === "GRANT_CHANGED"
            ? `the grant for Steward ${steward.name} changed; the person at this machine must approve it again`
            : `the person at this machine has not approved Steward ${steward.name}`,
      };
    }

    this.expireIdle();
    if (this.session && this.session.stewardId !== steward.id) {
      return {
        ok: false,
        code: "LOCAL_CONSENT_OFF",
        message: `another Steward (${this.session.stewardName}) is in control of this machine`,
      };
    }

    let name: string;
    try {
      name = await manager.resolveProviderName(provider);
    } catch (err) {
      if (err instanceof DeskManagerError) {
        return { ok: false, code: "DESK_OFFLINE", message: err.message };
      }
      throw err;
    }

    const apps = await this.checkApps(consent.approval, name, action, signal);
    if (!apps.ok) {
      this.options.logger?.warn(
        `desk action refused for Steward ${steward.name}: ${apps.message}`,
      );
      this.host?.audit?.emit("desk.app.refused", {
        stewardId: steward.id,
        provider: name,
        action: action.type,
        app: apps.app,
      });
      return { ok: false, code: "LOCAL_CONSENT_OFF", message: apps.message };
    }

    this.startOrTouch(steward);
    return { ok: true, provider: name };
  }

  private async checkApps(
    approval: Approval,
    provider: string,
    action: DeskAction,
    signal: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; message: string; app: string }> {
    const kind = this.options.manager.kindOf(provider);
    if (kind !== undefined && APP_SCOPE_EXEMPT_KINDS.has(kind))
      return { ok: true };
    if (FOLDER_ACTIONS.has(action.type)) return { ok: true };

    for (const app of targetApps(action)) {
      if (!appAllowed(approval, app)) {
        return {
          ok: false,
          app,
          message: `app '${app}' is not on the allow list`,
        };
      }
    }
    // Focusing an allowed app is how a Steward gets out of a disallowed one.
    if (action.type === "focus_window") return { ok: true };

    const timeout = AbortSignal.timeout(SAFETY_LIMITS.activeAppTimeoutMs);
    let active: DeskAppInfo | null | undefined;
    try {
      active = await this.options.manager.activeApp(
        provider,
        AbortSignal.any([signal, timeout]),
      );
    } catch (err) {
      return {
        ok: false,
        app: "unknown",
        message: `could not tell which app is in front: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (active === undefined) {
      return {
        ok: false,
        app: "unknown",
        message: `the ${kind ?? provider} desk cannot report the app in front, so the app allow list cannot be enforced`,
      };
    }
    if (active === null) {
      return {
        ok: false,
        app: "none",
        message: "no app is in front; focus an allowed app first",
      };
    }
    if (!appAllowed(approval, active)) {
      return {
        ok: false,
        app: describeApp(active),
        message: `app '${describeApp(active)}' is not on the allow list`,
      };
    }
    return { ok: true };
  }

  /** Run an authorized request through the manager (the desk guard). */
  async run(
    steward: StewardRef,
    provider: string | undefined,
    request: DeskActRequest,
    signal: AbortSignal,
  ): Promise<DeskActResult> {
    const verdict = await this.authorize(
      steward,
      provider,
      request.action,
      signal,
    );
    if (!verdict.ok) return refusal(verdict.code, verdict.message);
    const result = await this.options.manager.act(request, verdict.provider, {
      signal,
    });
    if (result.error?.code === "KILL_SWITCH") this.endSession("kill_switch");
    return result;
  }
}

export const SESSION_FILE = "desk-session.json";

/** Record who is in control (null: nobody). Atomic, mode 0600. */
export function writeSessionState(
  file: string,
  state: DeskIndicatorState | null,
): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ inControl: state })}\n`, {
    mode: 0o600,
  });
  renameSync(tmp, file);
}

/** Read what {@link writeSessionState} recorded. */
export function readSessionState(file: string): DeskIndicatorState | null {
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      inControl?: Partial<DeskIndicatorState> | null;
    };
    const s = raw.inControl;
    return s &&
      typeof s.stewardId === "string" &&
      typeof s.stewardName === "string" &&
      typeof s.since === "string"
      ? { stewardId: s.stewardId, stewardName: s.stewardName, since: s.since }
      : null;
  } catch {
    return null;
  }
}
