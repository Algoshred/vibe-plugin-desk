/**
 * @vibecontrols/vibe-plugin-desk
 *
 * The desk META plugin for BotManor Stewards (BOFF-16556; BotManor spec
 * `10-STEWARDS-TECH-SPEC.md` §7). It owns no screen of its own. Desk
 * providers do the work and register a `DeskBackend` (from
 * `@vibecontrols/plugin-sdk/desk`) under the `desk` provider type:
 *
 *   - `@vibecontrols/vibe-plugin-desk-browser`  a managed browser (BOFF-16562)
 *   - `@vibecontrols/vibe-plugin-desk-x11`      a Linux desktop  (BOFF-16563)
 *   - macOS and Windows providers               (BOFF-16565, BOFF-16566)
 *
 * This meta routes each action to one provider and wraps every provider in
 * the SDK desk guard, so fencing, idempotency, workspace-folder confinement,
 * timeouts, `UNTRUSTED` provenance, local consent and the kill switch are
 * enforced once, here, and not re-implemented by each provider.
 *
 * Remote control is OFF until the machine's owner runs
 * `vibe config set desk.remote-control on`. On top of that master switch,
 * own-machine safety (BOFF-16567, `safety.ts`) asks the person to approve
 * each Steward and grant (`vibe desk consent approve`), limits it to the apps
 * they allowed, shows who is in control, and gives them a kill switch
 * (`vibe desk kill`).
 *
 * Other plugins reach the manager in process as the `desk` / `manager`
 * service. The agent's bridge commands (B4.1) call the `desk` / `remote`
 * service, which runs every action through the safety checks.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type HostServices,
  type MetaProviderRef,
  type PluginStopContext,
  type ProfileContext,
  type VibePlugin,
  type VibePluginFactory,
} from "@vibecontrols/plugin-sdk/contract";
import { createLifecycleHooks } from "@vibecontrols/plugin-sdk/lifecycle";
import { BoundLogger } from "@vibecontrols/plugin-sdk/log";
import { provisionMetaProviders } from "@vibecontrols/plugin-sdk/providers";

import { type CliCommand, registerDeskCommands } from "./cli.js";
import { ConsentStore } from "./consent.js";
import { DeskManager } from "./manager.js";
import { DeskRemote } from "./remote.js";
import { createDeskRoutes } from "./routes.js";
import { DeskSafety, SESSION_FILE } from "./safety.js";

const PLUGIN_NAME = "desk";
const PLUGIN_PACKAGE_NAME = "@vibecontrols/vibe-plugin-desk";
const PLUGIN_VERSION = getPluginVersion();

function getPluginVersion(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 10 && dir && dir !== dirname(dir); i++) {
      const pkgPath = joinPath(dir, "package.json");
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
            name?: string;
            version?: string;
          };
          if (
            pkg.name === PLUGIN_PACKAGE_NAME &&
            typeof pkg.version === "string"
          ) {
            return pkg.version;
          }
        } catch {
          /* malformed package.json: keep walking up */
        }
      }
      dir = dirname(dir);
    }
  } catch {
    /* fall through */
  }
  return "0.0.0";
}

/**
 * Desk providers this meta routes to. None is a platform default: a desk
 * hands a machine to a Steward, so every provider is installed on purpose,
 * never as a side effect of installing the meta.
 */
export const DESK_PROVIDERS: ReadonlyArray<MetaProviderRef> = [
  {
    packageName: "@vibecontrols/vibe-plugin-desk-browser",
    pluginName: "desk-browser",
    providerType: "desk",
  },
  {
    packageName: "@vibecontrols/vibe-plugin-desk-x11",
    pluginName: "desk-x11",
    providerType: "desk",
  },
];

/**
 * Plugin Contract v2 factory. Per-profile state (the DeskManager, with its
 * fencing tokens and idempotency keys) lives in this closure, so two profiles
 * never share a desk.
 */
export const createPlugin: VibePluginFactory = (
  ctx: ProfileContext,
): VibePlugin => {
  const log = new BoundLogger(ctx.logger, PLUGIN_NAME);
  const manager = new DeskManager({ dataDir: ctx.dataDir, logger: log });
  const store = new ConsentStore(ctx.dataDir);
  const sessionFile = joinPath(ctx.dataDir, SESSION_FILE);
  const safety = new DeskSafety({ store, manager, logger: log, sessionFile });
  const remote = new DeskRemote(manager, safety);

  const lifecycle = createLifecycleHooks({
    name: PLUGIN_NAME,
    telemetryEventName: "desk.meta.ready",
    onInit: async (hostServices: HostServices) => {
      await manager.init(hostServices);
      safety.start(hostServices);
      hostServices.serviceRegistry?.registerService?.(
        PLUGIN_NAME,
        "manager",
        manager,
      );
      hostServices.serviceRegistry?.registerService?.(
        PLUGIN_NAME,
        "remote",
        remote,
      );
    },
    onShutdown: (context?: PluginStopContext) => {
      safety.stop();
      manager.stop();
      log.info(`desk manager stopped (${context?.reason ?? "shutdown"})`);
    },
  });

  return {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    description:
      "Desk manager: routes Steward desk actions to a registered desk provider",
    tags: ["backend", "integration"],
    apiPrefix: "/api/desk",
    capabilities: {
      audit: true,
      telemetry: true,
    },
    metaProviders: DESK_PROVIDERS,
    provisionProviders: (hostServices: HostServices) =>
      provisionMetaProviders(hostServices, DESK_PROVIDERS),
    createRoutes: () => createDeskRoutes(manager, safety),
    onCliSetup: (program: unknown) => {
      // The agent passes its commander program; only the methods in
      // CliCommand are used.
      registerDeskCommands(program as CliCommand, store, sessionFile);
    },
    onServerStart: lifecycle.onServerStart,
    onServerStop: lifecycle.onServerStop,
  };
};

export default createPlugin;

export { DESK_LIMITS, parseDeskAction, parseDeskTarget } from "./actions.js";
export {
  CONSENT_FILE,
  ConsentError,
  ConsentStore,
  type StewardRef,
} from "./consent.js";
export { DeskRemote, DeskRemoteError, parseSteward } from "./remote.js";
export {
  DESK_SESSION_TOPIC,
  DeskSafety,
  type DeskSessionEvent,
  SAFETY_LIMITS,
} from "./safety.js";
export {
  DESK_CONFIG,
  DESK_PROVIDER_TYPE,
  type DeskAppInfo,
  type DeskIndicatorState,
  DeskManager,
  DeskManagerError,
  type DeskProviderInfo,
  type DeskSafetyHooks,
  isDeskBackend,
} from "./manager.js";
