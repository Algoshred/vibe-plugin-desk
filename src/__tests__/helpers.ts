import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HostServices } from "@vibecontrols/plugin-sdk/contract";
import {
  DESK_ACTION_TYPES,
  type DeskAction,
  type DeskBackend,
  type DeskBackendResult,
  type ConfinedPaths,
} from "@vibecontrols/plugin-sdk/desk";

export interface Recorded {
  action: DeskAction;
  deskId: string;
  paths: ConfinedPaths;
}

/** A desk backend that records every call and answers with a fixed screenshot. */
export function fakeBackend(kind = "fake", over: Partial<DeskBackend> = {}) {
  const calls: Recorded[] = [];
  const backend: DeskBackend = {
    kind,
    actions: DESK_ACTION_TYPES,
    async act(action, { deskId, paths }): Promise<DeskBackendResult> {
      calls.push({ action, deskId, paths });
      return {
        ok: true,
        screenshotPng: new Uint8Array([137, 80, 78, 71]),
        text: action.type,
      };
    },
    ...over,
  };
  return { backend, calls };
}

/** An in-memory stand-in for the agent's provider registry, config and audit. */
export function fakeHost(config: Record<string, string> = {}) {
  const providers = new Map<string, unknown>();
  let elected: string | undefined;
  const services = new Map<string, unknown>();
  const audit: Array<{ event: string; payload?: Record<string, unknown> }> = [];
  const host: HostServices = {
    serviceRegistry: {
      registerProvider: (_type, provider, name) =>
        void providers.set(name, provider),
      getProviderByName: <T>(_type: string, name: string) =>
        providers.get(name) as T | undefined,
      listProvidersForType: () =>
        [...providers.keys()].map((pluginName) => ({
          pluginName,
          isDefault: pluginName === elected,
        })),
      registerService: (plugin, name, service) =>
        void services.set(`${plugin}/${name}`, service),
    },
    getConfig: async (key) => config[key],
    audit: { emit: (event, payload) => void audit.push({ event, payload }) },
  };
  return {
    host,
    config,
    providers,
    services,
    audit,
    elect: (name: string | undefined) => {
      elected = name;
    },
  };
}

export function tempDir(): string {
  // realpath: macOS tmpdir is a symlink and the guard compares real paths.
  return realpathSync(mkdtempSync(join(tmpdir(), "vibe-desk-")));
}
