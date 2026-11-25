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
 * `vibe config set desk.remote-control on`. These config keys are the first
 * consent and kill-switch inputs; the full own-machine safety UX (consent
 * prompt, "Steward in control" indicator, app allow list) is BOFF-16567.
 *
 * Other plugins (the agent bridge command channel, B4.1) reach the manager
 * in process as the `desk` / `manager` service.
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

import { DeskManager } from "./manager.js";
import { createDeskRoutes } from "./routes.js";

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

  const lifecycle = createLifecycleHooks({
    name: PLUGIN_NAME,
    telemetryEventName: "desk.meta.ready",
    onInit: async (hostServices: HostServices) => {
      await manager.init(hostServices);
      hostServices.serviceRegistry?.registerService?.(
        PLUGIN_NAME,
        "manager",
        manager,
      );
    },
    onShutdown: (context?: PluginStopContext) => {
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
    createRoutes: () => createDeskRoutes(manager),
    onServerStart: lifecycle.onServerStart,
    onServerStop: lifecycle.onServerStop,
  };
};

export default createPlugin;

export { DESK_LIMITS, parseDeskAction, parseDeskTarget } from "./actions.js";
export {
  DESK_CONFIG,
  DESK_PROVIDER_TYPE,
  DeskManager,
  DeskManagerError,
  type DeskProviderInfo,
  isDeskBackend,
} from "./manager.js";
