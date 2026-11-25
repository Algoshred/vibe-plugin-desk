import { afterAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";

import type { HostServices } from "@vibecontrols/plugin-sdk/contract";

import createPluginDefault, {
  createPlugin,
  DESK_PROVIDERS,
  DeskManager,
} from "../index.js";
import { fakeHost, tempDir } from "./helpers.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function plugin() {
  const dataDir = tempDir();
  dirs.push(dataDir);
  return createPlugin({ name: "default", dataDir });
}

describe("vibe-plugin-desk", () => {
  it("exports the factory as default and named", () => {
    expect(createPluginDefault).toBe(createPlugin);
  });

  it("declares the meta contract and only the capabilities it uses", () => {
    const p = plugin();
    expect(p.name).toBe("desk");
    expect(p.apiPrefix).toBe("/api/desk");
    expect(p.capabilities).toEqual({ audit: true, telemetry: true });
    expect(p.metaProviders).toBe(DESK_PROVIDERS);
    expect(p.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof p.createRoutes).toBe("function");
  });

  it("makes every provider opt-in (none is installed by default)", () => {
    for (const ref of DESK_PROVIDERS) {
      expect(ref.providerType).toBe("desk");
      expect(ref.defaultOn).toBeUndefined();
    }
  });

  it("starts the manager, registers it as a service, and stops cleanly", async () => {
    const p = plugin();
    const h = fakeHost();
    const telemetry: string[] = [];
    const host: HostServices = {
      ...h.host,
      telemetry: { emit: (e) => void telemetry.push(e) },
    };
    await p.onServerStart?.(undefined, host);
    const manager = h.services.get("desk/manager");
    expect(manager).toBeInstanceOf(DeskManager);
    expect(telemetry).toContain("desk.meta.ready");
    expect((await (manager as DeskManager).health()).ready).toBe(true);

    await p.onServerStop?.({ reason: "shutdown" });
    expect((await (manager as DeskManager).health()).ready).toBe(false);
    await p.onServerStop?.();
  });

  it("provisions no provider when none is a platform default", async () => {
    const installs: string[] = [];
    const p = plugin();
    await p.provisionProviders?.({
      plugins: {
        install: async (name: string) => void installs.push(name),
        loadProvider: async (name: string) => void installs.push(name),
      },
    } as unknown as HostServices);
    expect(installs).toEqual([]);
  });

  it("serves its routes", async () => {
    const p = plugin();
    await p.onServerStart?.(undefined, fakeHost().host);
    const app = p.createRoutes?.() as { handle(r: Request): Promise<Response> };
    const res = await app.handle(new Request("http://localhost/providers"));
    expect(await res.json()).toEqual({ providers: [] });
  });
});
