/**
 * DeskManager: routes desk actions to the registered desk providers.
 *
 * Desk providers (browser, x11, macOS, Windows) register a `DeskBackend`
 * under the `desk` provider type. The manager never calls a backend directly:
 * each provider is wrapped once in the SDK's `createDeskGuard`, which enforces
 * fencing, idempotency, workspace-folder confinement, timeouts, `UNTRUSTED`
 * provenance, local consent and the kill switch.
 *
 * The guard wraps a thin indirection, not the backend object itself, and
 * resolves the live backend from the registry on every action. A provider
 * that is reloaded or updated therefore keeps its fencing tokens and
 * idempotency keys: a stale Steward cannot act after a takeover just because
 * the provider plugin restarted. A provider that disappears answers
 * `DESK_OFFLINE` until it registers again.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { HostServices } from "@vibecontrols/plugin-sdk/contract";
import {
  type DeskAction,
  type DeskActionType,
  type DeskActRequest,
  type DeskActResult,
  type DeskBackend,
  type DeskBackendResult,
  type DeskGuard,
  createDeskGuard,
} from "@vibecontrols/plugin-sdk/desk";
import { BoundLogger } from "@vibecontrols/plugin-sdk/log";

export const DESK_PROVIDER_TYPE = "desk";

/** Agent config keys (`vibe config set <key> <value>`). */
export const DESK_CONFIG = {
  /** Must be "on" before any action runs. Off by default (spec §5.8). */
  remoteControl: "desk.remote-control",
  /** "on" refuses every action immediately. */
  killSwitch: "desk.kill-switch",
  /** The only folder file and shell actions may touch. */
  workspaceFolder: "desk.workspace-folder",
  /** Provider plugin used when a request names none. */
  defaultProvider: "desk.default-provider",
} as const;

const ON = new Set(["on", "true", "1", "yes"]);

/** The subset of the agent's ServiceRegistry the manager uses. */
interface DeskServiceRegistry {
  getProviderByName?<T>(type: string, name: string): T | undefined;
  listProvidersForType?(
    type: string,
  ): string[] | Array<{ pluginName: string; isDefault: boolean }>;
}

/** The application a desktop action lands in (B4.6 app allow list). */
export interface DeskAppInfo {
  /** Display name, e.g. "Safari". */
  name: string;
  /** Platform id when there is one: macOS bundle id, Windows exe, X11 WM_CLASS. */
  bundleId?: string;
}

/** What the "Steward in control" indicator shows; null hides it. */
export interface DeskIndicatorState {
  stewardId: string;
  stewardName: string;
  /** ISO time the session started. */
  since: string;
}

/**
 * Optional hooks a desk provider implements on top of `DeskBackend` for
 * own-machine safety (BOFF-16567). Desktop providers report the frontmost
 * app, so the app allow list can be enforced, and draw the on-screen
 * "Steward in control" indicator.
 */
export interface DeskSafetyHooks {
  activeApp?(signal: AbortSignal): Promise<DeskAppInfo | null>;
  showIndicator?(state: DeskIndicatorState | null): void;
}

export interface DeskProviderInfo {
  pluginName: string;
  isDefault: boolean;
  /** Missing when the registered object is not a valid desk backend. */
  kind?: string;
  actions: DeskActionType[];
}

export class DeskManagerError extends Error {
  constructor(
    readonly code: "NO_PROVIDER" | "NOT_READY",
    message: string,
  ) {
    super(message);
    this.name = "DeskManagerError";
  }
}

/** True when `value` has the shape of a `DeskBackend`. */
export function isDeskBackend(value: unknown): value is DeskBackend {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<DeskBackend>;
  return (
    typeof candidate.kind === "string" &&
    Array.isArray(candidate.actions) &&
    typeof candidate.act === "function"
  );
}

export interface DeskManagerOptions {
  /** Profile data directory; the default workspace folder lives under it. */
  dataDir: string;
  logger?: BoundLogger;
}

export class DeskManager {
  private host: HostServices | undefined;
  private registry: DeskServiceRegistry | undefined;
  private folder: string | undefined;
  private readonly guards = new Map<string, DeskGuard>();
  // Refreshed from agent config before each action; the guard reads them
  // synchronously.
  private consent = false;
  private killed = false;
  private stopped = false;
  // Kill switch pressed through the own-machine safety layer (CLI, HTTP).
  private localKill = false;
  // Aborted by the kill switch: every action in flight stops at once.
  private epoch = new AbortController();
  // Per-call cancellation from the caller (the bridge request). The guard
  // passes the request's action object through to the backend unchanged, so
  // the action identifies the call.
  private readonly callerSignals = new WeakMap<DeskAction, AbortSignal>();

  constructor(private readonly options: DeskManagerOptions) {}

  /** Bind to the host and prepare the workspace folder. */
  async init(host: HostServices): Promise<void> {
    this.host = host;
    // The agent registry is a superset of the SDK façade; narrow it once here.
    this.registry = host.serviceRegistry as DeskServiceRegistry | undefined;
    const configured = (
      await host.getConfig?.(DESK_CONFIG.workspaceFolder)
    )?.trim();
    const folder = configured || join(this.options.dataDir, "desk-workspace");
    // 0700: the folder holds whatever the Steward reads and writes.
    await mkdir(folder, { recursive: true, mode: 0o700 });
    this.folder = folder;
    this.stopped = false;
    await this.refreshSafety();
    this.options.logger?.info(
      `desk manager ready (remote control ${this.consent ? "on" : "off"})`,
    );
  }

  /** Forget every guard. In-flight actions finish; new ones are refused. */
  stop(): void {
    this.stopped = true;
    this.guards.clear();
  }

  get workspaceFolder(): string | undefined {
    return this.folder;
  }

  private entries(): Array<{ pluginName: string; isDefault: boolean }> {
    const raw = this.registry?.listProvidersForType?.(DESK_PROVIDER_TYPE) ?? [];
    return raw.map((entry) =>
      typeof entry === "string"
        ? { pluginName: entry, isDefault: false }
        : entry,
    );
  }

  private hooksOf(pluginName: string): DeskSafetyHooks | undefined {
    return this.backendOf(pluginName) as
      (DeskBackend & DeskSafetyHooks) | undefined;
  }

  /** The provider's kind ("browser", "x11", "macos", …), if it is registered. */
  kindOf(pluginName: string): string | undefined {
    return this.backendOf(pluginName)?.kind;
  }

  /**
   * The app in front on that provider's desk. Undefined when the provider
   * cannot tell (it does not implement `activeApp`), null when no app is in
   * front.
   */
  async activeApp(
    pluginName: string,
    signal: AbortSignal,
  ): Promise<DeskAppInfo | null | undefined> {
    const hooks = this.hooksOf(pluginName);
    if (typeof hooks?.activeApp !== "function") return undefined;
    return hooks.activeApp(signal);
  }

  /** Show or hide the "Steward in control" indicator on every provider. */
  showIndicator(state: DeskIndicatorState | null): void {
    for (const { pluginName } of this.entries()) {
      const hooks = this.hooksOf(pluginName);
      if (typeof hooks?.showIndicator !== "function") continue;
      try {
        hooks.showIndicator(state);
      } catch (err) {
        this.options.logger?.warn(
          `desk provider ${pluginName} could not update the indicator: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Press the kill switch: refuse every new action and abort every action in
   * flight now. A backend that ignores its signal is answered KILL_SWITCH
   * without waiting for it.
   */
  engageKillSwitch(): void {
    this.localKill = true;
    const previous = this.epoch;
    this.epoch = new AbortController();
    previous.abort();
  }

  releaseKillSwitch(): void {
    this.localKill = false;
  }

  get killSwitchEngaged(): boolean {
    return this.localKill || this.killed;
  }

  /** The `desk.kill-switch` config key alone, as of the last refresh. */
  get configKillSwitch(): boolean {
    return this.killed;
  }

  private backendOf(pluginName: string): DeskBackend | undefined {
    const value = this.registry?.getProviderByName?.<unknown>(
      DESK_PROVIDER_TYPE,
      pluginName,
    );
    return isDeskBackend(value) ? value : undefined;
  }

  /** Every registered desk provider, with what it can do. */
  listProviders(): DeskProviderInfo[] {
    return this.entries().map(({ pluginName, isDefault }) => {
      const backend = this.backendOf(pluginName);
      return backend
        ? {
            pluginName,
            isDefault,
            kind: backend.kind,
            actions: [...backend.actions],
          }
        : { pluginName, isDefault, actions: [] };
    });
  }

  /**
   * The provider a request goes to: the named one, else the configured
   * default, else the registry's elected default, else the only provider.
   */
  async resolveProviderName(requested?: string): Promise<string> {
    const entries = this.entries();
    const has = (name: string) => entries.some((e) => e.pluginName === name);
    const explicit = requested?.trim();
    if (explicit) {
      if (!has(explicit)) {
        throw new DeskManagerError(
          "NO_PROVIDER",
          `desk provider '${explicit}' is not registered`,
        );
      }
      return explicit;
    }
    const configured = (
      await this.host?.getConfig?.(DESK_CONFIG.defaultProvider)
    )?.trim();
    if (configured && has(configured)) return configured;
    const elected = entries.find((e) => e.isDefault);
    if (elected) return elected.pluginName;
    if (entries.length === 1) return entries[0]!.pluginName;
    throw new DeskManagerError(
      "NO_PROVIDER",
      entries.length === 0
        ? "no desk provider is installed"
        : "several desk providers are installed; name one or set desk.default-provider",
    );
  }

  private async refreshSafety(): Promise<void> {
    const read = async (key: string) =>
      ON.has(((await this.host?.getConfig?.(key)) ?? "").trim().toLowerCase());
    this.consent = await read(DESK_CONFIG.remoteControl);
    this.killed = await read(DESK_CONFIG.killSwitch);
  }

  private guardFor(pluginName: string): DeskGuard {
    const existing = this.guards.get(pluginName);
    if (existing) return existing;
    const folder = this.folder;
    if (!folder)
      throw new DeskManagerError("NOT_READY", "desk manager is not started");

    const live = (): DeskBackend | undefined => this.backendOf(pluginName);
    const indirection: DeskBackend = {
      get kind() {
        return live()?.kind ?? pluginName;
      },
      get actions() {
        return live()?.actions ?? [];
      },
      act: (action, context): Promise<DeskBackendResult> => {
        const backend = live();
        if (!backend)
          return Promise.reject(
            new Error(`desk provider '${pluginName}' is gone`),
          );
        return this.runCancellable(backend, action, context);
      },
    };
    const guard = createDeskGuard(indirection, {
      workspaceFolder: folder,
      consentGranted: () => this.consent,
      killSwitchEngaged: () => this.killSwitchEngaged,
    });
    this.guards.set(pluginName, guard);
    return guard;
  }

  /**
   * Run the backend with the kill switch and the caller's signal wired in.
   * Resolves as soon as either fires, even if the backend ignores its signal.
   */
  private runCancellable(
    backend: DeskBackend,
    action: DeskAction,
    context: Parameters<DeskBackend["act"]>[1],
  ): Promise<DeskBackendResult> {
    const epoch = this.epoch.signal;
    const caller = this.callerSignals.get(action);
    const signals = [context.signal, epoch, ...(caller ? [caller] : [])];
    const signal = AbortSignal.any(signals);
    if (epoch.aborted) {
      return Promise.resolve(killed());
    }
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<DeskBackendResult>((resolve) => {
      onAbort = () =>
        resolve(
          epoch.aborted
            ? killed()
            : {
                ok: false,
                error: {
                  code: "TIMEOUT",
                  message: "the request was cancelled",
                },
              },
        );
      epoch.addEventListener("abort", onAbort, { once: true });
      caller?.addEventListener("abort", onAbort, { once: true });
    });
    return Promise.race([
      backend.act(action, { ...context, signal }),
      cancelled,
    ]).finally(() => {
      if (onAbort) {
        epoch.removeEventListener("abort", onAbort);
        caller?.removeEventListener("abort", onAbort);
      }
    });
  }

  /** Run one action on a desk. Never throws for desk-level failures. */
  async act(
    request: DeskActRequest,
    provider?: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<DeskActResult> {
    if (this.stopped) {
      return {
        ok: false,
        provenance: "UNTRUSTED",
        error: { code: "DESK_OFFLINE", message: "the desk plugin is stopping" },
      };
    }
    const pluginName = await this.resolveProviderName(provider);
    await this.refreshSafety();
    if (options.signal) this.callerSignals.set(request.action, options.signal);
    const result = await this.guardFor(pluginName).act(request);
    // Audit the decision, never the payload: no typed text, file content,
    // command or screenshot leaves through the audit log.
    this.host?.audit?.emit("desk.act", {
      provider: pluginName,
      deskId: request.deskId,
      action: request.action.type,
      ok: result.ok,
      ...(result.error ? { error: result.error.code } : {}),
    });
    return result;
  }

  /**
   * A person took over the desk, or the lease moved: every fencing token
   * below `token` is now stale on that provider.
   */
  async raiseFence(
    deskId: string,
    token: bigint | string,
    provider?: string,
  ): Promise<void> {
    const pluginName = await this.resolveProviderName(provider);
    this.guardFor(pluginName).raiseFence(deskId, token);
    this.host?.audit?.emit("desk.fence", {
      provider: pluginName,
      deskId,
      token: String(token),
    });
  }

  /** Current safety state, for `GET /health` and `vibe status`. */
  async health(): Promise<{
    ready: boolean;
    remoteControl: boolean;
    killSwitch: boolean;
    providers: number;
  }> {
    await this.refreshSafety();
    return {
      ready: Boolean(this.folder) && !this.stopped,
      remoteControl: this.consent,
      killSwitch: this.killSwitchEngaged,
      providers: this.entries().length,
    };
  }
}

function killed(): DeskBackendResult {
  return {
    ok: false,
    error: { code: "KILL_SWITCH", message: "the kill switch was pressed" },
  };
}
