import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import type { DeskAction, DeskActRequest } from "@vibecontrols/plugin-sdk/desk";

import {
  DESK_CONFIG,
  DeskManager,
  DeskManagerError,
  isDeskBackend,
} from "../manager.js";
import { fakeBackend, fakeHost, tempDir } from "./helpers.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const req = (
  action: DeskAction,
  over: Partial<DeskActRequest> = {},
): DeskActRequest => ({
  deskId: "desk-1",
  fencingToken: "1",
  idempotencyKey: `k${++n}`,
  timeoutMs: 1000,
  action,
  ...over,
});

async function setup(
  config: Record<string, string> = { [DESK_CONFIG.remoteControl]: "on" },
) {
  const dataDir = tempDir();
  dirs.push(dataDir);
  const h = fakeHost(config);
  const fake = fakeBackend("x11");
  h.host.serviceRegistry?.registerProvider?.("desk", fake.backend, "desk-x11");
  const manager = new DeskManager({ dataDir });
  await manager.init(h.host);
  return { ...h, fake, manager, dataDir };
}

describe("DeskManager.init", () => {
  it("creates a private workspace folder under the data dir", async () => {
    const { manager, dataDir } = await setup();
    expect(manager.workspaceFolder).toBe(join(dataDir, "desk-workspace"));
    if (process.platform !== "win32") {
      expect(statSync(manager.workspaceFolder!).mode & 0o777).toBe(0o700);
    }
  });

  it("uses the configured workspace folder", async () => {
    const custom = join(tempDir(), "custom");
    dirs.push(custom);
    const { manager } = await setup({
      [DESK_CONFIG.workspaceFolder]: `  ${custom} `,
    });
    expect(manager.workspaceFolder).toBe(custom);
    expect(existsSync(custom)).toBe(true);
  });
});

describe("DeskManager operations", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
    mkdirSync(join(ctx.manager.workspaceFolder!, "sub"), { recursive: true });
  });

  const simple: DeskAction[] = [
    { type: "screenshot" },
    { type: "snapshot" },
    { type: "click", target: { by: "ref", ref: "e1" } },
    { type: "type", text: "hello" },
    {
      type: "secret_fill",
      target: { by: "ref", ref: "e2" },
      secretRef: "vault:x",
      expectedOrigin: "https://example.com",
    },
    { type: "key", keys: ["Enter"] },
    { type: "scroll", dx: 0, dy: 300 },
    { type: "navigate", url: "https://example.com" },
    { type: "focus_window", app: "Terminal" },
  ];
  for (const action of simple) {
    it(`runs ${action.type} on the provider`, async () => {
      const result = await ctx.manager.act(req(action));
      expect(result).toMatchObject({
        ok: true,
        provenance: "UNTRUSTED",
        text: action.type,
      });
      expect(ctx.fake.calls.at(-1)).toEqual({
        action,
        deskId: "desk-1",
        paths: {},
      });
    });
  }

  it("runs read_file, write_file and shell with confined paths", async () => {
    const root = ctx.manager.workspaceFolder!;
    await ctx.manager.act(
      req({ type: "read_file", path: "sub/a.txt", maxBytes: 10 }),
    );
    expect(ctx.fake.calls.at(-1)?.paths).toEqual({
      path: join(root, "sub", "a.txt"),
    });
    await ctx.manager.act(
      req({ type: "write_file", path: "b.txt", content: "x" }),
    );
    expect(ctx.fake.calls.at(-1)?.paths).toEqual({ path: join(root, "b.txt") });
    await ctx.manager.act(
      req({ type: "shell", command: "ls", cwd: "sub", timeoutMs: 10 }),
    );
    expect(ctx.fake.calls.at(-1)?.paths).toEqual({ cwd: join(root, "sub") });
  });

  it("refuses paths outside the workspace folder", async () => {
    const result = await ctx.manager.act(
      req({ type: "read_file", path: "../../etc/passwd", maxBytes: 10 }),
    );
    expect(result.error?.code).toBe("OUTSIDE_WORKSPACE_FOLDER");
    expect(ctx.fake.calls).toHaveLength(0);
  });

  it("audits the decision without the payload", async () => {
    await ctx.manager.act(req({ type: "type", text: "my secret text" }));
    expect(ctx.audit.at(-1)).toEqual({
      event: "desk.act",
      payload: {
        provider: "desk-x11",
        deskId: "desk-1",
        action: "type",
        ok: true,
      },
    });
    expect(JSON.stringify(ctx.audit)).not.toContain("my secret text");
  });

  it("audits the error code of a refused action", async () => {
    ctx.config[DESK_CONFIG.killSwitch] = "on";
    await ctx.manager.act(req({ type: "screenshot" }));
    expect(ctx.audit.at(-1)?.payload).toMatchObject({
      ok: false,
      error: "KILL_SWITCH",
    });
  });
});

describe("DeskManager safety", () => {
  it("refuses every action while remote control is off (the default)", async () => {
    const { manager, fake } = await setup({});
    const result = await manager.act(req({ type: "screenshot" }));
    expect(result.error?.code).toBe("LOCAL_CONSENT_OFF");
    expect(fake.calls).toHaveLength(0);
  });

  it("reads consent and the kill switch on every action", async () => {
    const { manager, fake, config } = await setup();
    expect((await manager.act(req({ type: "screenshot" }))).ok).toBe(true);
    config[DESK_CONFIG.killSwitch] = "ON";
    expect((await manager.act(req({ type: "screenshot" }))).error?.code).toBe(
      "KILL_SWITCH",
    );
    config[DESK_CONFIG.killSwitch] = "off";
    config[DESK_CONFIG.remoteControl] = "off";
    expect((await manager.act(req({ type: "screenshot" }))).error?.code).toBe(
      "LOCAL_CONSENT_OFF",
    );
    expect(fake.calls).toHaveLength(1);
    expect(await manager.health()).toEqual({
      ready: true,
      remoteControl: false,
      killSwitch: false,
      providers: 1,
    });
  });

  it("refuses a stale fencing token after a takeover", async () => {
    const { manager, audit } = await setup();
    expect(
      (await manager.act(req({ type: "screenshot" }, { fencingToken: "3" })))
        .ok,
    ).toBe(true);
    await manager.raiseFence("desk-1", "4");
    expect(audit.at(-1)).toEqual({
      event: "desk.fence",
      payload: { provider: "desk-x11", deskId: "desk-1", token: "4" },
    });
    const stale = await manager.act(
      req({ type: "screenshot" }, { fencingToken: "3" }),
    );
    expect(stale.error?.code).toBe("STALE_FENCING_TOKEN");
    expect(
      (await manager.act(req({ type: "screenshot" }, { fencingToken: "4" })))
        .ok,
    ).toBe(true);
  });

  it("keeps fences and idempotency keys when the provider is reloaded", async () => {
    const { manager, providers, fake } = await setup();
    await manager.act(
      req(
        { type: "click", target: { by: "ref", ref: "a" } },
        {
          fencingToken: "9",
          idempotencyKey: "once",
        },
      ),
    );
    const reloaded = fakeBackend("x11");
    providers.set("desk-x11", reloaded.backend);

    const stale = await manager.act(
      req({ type: "screenshot" }, { fencingToken: "8" }),
    );
    expect(stale.error?.code).toBe("STALE_FENCING_TOKEN");
    const replay = await manager.act(
      req(
        { type: "click", target: { by: "ref", ref: "a" } },
        {
          fencingToken: "9",
          idempotencyKey: "once",
        },
      ),
    );
    expect(replay.ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(reloaded.calls).toHaveLength(0);
    expect(
      (await manager.act(req({ type: "screenshot" }, { fencingToken: "9" })))
        .ok,
    ).toBe(true);
    expect(reloaded.calls).toHaveLength(1);
  });

  it("answers DESK_OFFLINE when the provider's object stops being a backend", async () => {
    const { manager, providers } = await setup();
    await manager.act(req({ type: "screenshot" }));
    providers.set("desk-x11", { broken: true });
    const result = await manager.act(req({ type: "screenshot" }));
    expect(result.error?.code).toBe("DESK_OFFLINE");
  });

  it("refuses new actions after stop", async () => {
    const { manager, fake } = await setup();
    manager.stop();
    const result = await manager.act(req({ type: "screenshot" }));
    expect(result.error).toEqual({
      code: "DESK_OFFLINE",
      message: "the desk plugin is stopping",
    });
    expect(fake.calls).toHaveLength(0);
    expect((await manager.health()).ready).toBe(false);
  });
});

describe("DeskManager provider resolution", () => {
  it("lists providers with their kind and actions", async () => {
    const { manager, providers } = await setup();
    providers.set("desk-broken", { nope: 1 });
    expect(manager.listProviders()).toEqual([
      {
        pluginName: "desk-x11",
        isDefault: false,
        kind: "x11",
        actions: expect.arrayContaining([
          "screenshot",
          "shell",
        ]) as unknown as never,
      },
      { pluginName: "desk-broken", isDefault: false, actions: [] },
    ]);
  });

  it("uses the only provider when there is one", async () => {
    const { manager } = await setup();
    expect(await manager.resolveProviderName()).toBe("desk-x11");
  });

  it("prefers the named, then the configured, then the elected provider", async () => {
    const { manager, providers, config, elect } = await setup();
    providers.set("desk-browser", fakeBackend("browser").backend);
    await expect(manager.resolveProviderName()).rejects.toThrow(
      "several desk providers",
    );
    elect("desk-browser");
    expect(await manager.resolveProviderName()).toBe("desk-browser");
    config[DESK_CONFIG.defaultProvider] = "desk-x11";
    expect(await manager.resolveProviderName()).toBe("desk-x11");
    config[DESK_CONFIG.defaultProvider] = "desk-gone";
    expect(await manager.resolveProviderName()).toBe("desk-browser");
    expect(await manager.resolveProviderName(" desk-x11 ")).toBe("desk-x11");
  });

  it("fails with NO_PROVIDER for an unknown or missing provider", async () => {
    const { manager, providers } = await setup();
    const unknown = manager.resolveProviderName("desk-macos");
    await expect(unknown).rejects.toBeInstanceOf(DeskManagerError);
    await expect(manager.resolveProviderName("desk-macos")).rejects.toThrow(
      "not registered",
    );
    providers.clear();
    await expect(manager.resolveProviderName()).rejects.toThrow(
      "no desk provider is installed",
    );
  });

  it("accepts registries that list provider names as strings", async () => {
    const dataDir = tempDir();
    dirs.push(dataDir);
    const fake = fakeBackend();
    const manager = new DeskManager({ dataDir });
    await manager.init({
      serviceRegistry: {
        listProvidersForType: () => ["desk-x11"],
        getProviderByName: <T>() => fake.backend as T,
      },
      getConfig: async () => "on",
    });
    expect(manager.listProviders()[0]).toMatchObject({
      pluginName: "desk-x11",
      kind: "fake",
    });
  });

  it("works with a host that has no registry", async () => {
    const dataDir = tempDir();
    dirs.push(dataDir);
    const manager = new DeskManager({ dataDir });
    await manager.init({});
    expect(manager.listProviders()).toEqual([]);
    expect((await manager.health()).remoteControl).toBe(false);
  });

  it("refuses to act before init", async () => {
    const manager = new DeskManager({ dataDir: "/nonexistent" });
    await expect(manager.raiseFence("d", "1")).rejects.toThrow(
      "no desk provider",
    );
  });
});

describe("isDeskBackend", () => {
  it("checks the backend shape", () => {
    expect(isDeskBackend(fakeBackend().backend)).toBe(true);
    for (const value of [
      null,
      1,
      {},
      { kind: "x", actions: [] },
      { kind: 1, actions: [], act() {} },
    ]) {
      expect(isDeskBackend(value)).toBe(false);
    }
  });
});
