import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DESK_CONFIG, DeskManager } from "../manager.js";
import { createDeskRoutes, toWire } from "../routes.js";
import { fakeBackend, fakeHost, tempDir } from "./helpers.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function setup(withProvider = true) {
  const dataDir = tempDir();
  dirs.push(dataDir);
  const h = fakeHost({ [DESK_CONFIG.remoteControl]: "on" });
  const fake = fakeBackend("browser");
  if (withProvider) {
    h.host.serviceRegistry?.registerProvider?.(
      "desk",
      fake.backend,
      "desk-browser",
    );
  }
  const manager = new DeskManager({ dataDir });
  await manager.init(h.host);
  const app = createDeskRoutes(manager);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.handle(
      new Request(`http://localhost${path}`, {
        method,
        headers:
          body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return {
      status: res.status,
      json: (await res.json()) as Record<string, unknown>,
    };
  };
  return { ...h, fake, manager, call };
}

let k = 0;
const act = (over: Record<string, unknown> = {}) => ({
  deskId: "desk-1",
  fencingToken: "1",
  idempotencyKey: `key-${++k}`,
  timeoutMs: 2000,
  action: { type: "screenshot" },
  ...over,
});

describe("desk routes", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it("GET /providers lists the registered providers", async () => {
    const { status, json } = await ctx.call("GET", "/providers");
    expect(status).toBe(200);
    expect(json["providers"]).toEqual([
      expect.objectContaining({ pluginName: "desk-browser", kind: "browser" }),
    ]);
  });

  it("GET /health reports the safety state", async () => {
    const { json } = await ctx.call("GET", "/health");
    expect(json).toEqual({
      ready: true,
      remoteControl: true,
      killSwitch: false,
      providers: 1,
    });
  });

  it("POST /act runs the action and returns the screenshot as base64", async () => {
    const { status, json } = await ctx.call("POST", "/act", act());
    expect(status).toBe(200);
    expect(json).toEqual({
      ok: true,
      text: "screenshot",
      provenance: "UNTRUSTED",
      screenshotPngBase64: Buffer.from([137, 80, 78, 71]).toString("base64"),
    });
  });

  it("POST /act routes to the named provider", async () => {
    const other = fakeBackend("x11");
    ctx.providers.set("desk-x11", other.backend);
    const { json } = await ctx.call(
      "POST",
      "/act",
      act({ provider: "desk-x11", action: { type: "key", keys: ["Escape"] } }),
    );
    expect(json["ok"]).toBe(true);
    expect(other.calls).toHaveLength(1);
    expect(ctx.fake.calls).toHaveLength(0);
  });

  it("POST /act returns desk-level refusals as 200 with an error code", async () => {
    ctx.config[DESK_CONFIG.killSwitch] = "on";
    const { status, json } = await ctx.call("POST", "/act", act());
    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: false, error: { code: "KILL_SWITCH" } });
  });

  const invalid: Array<[string, unknown, string]> = [
    ["a non-object body", [1], "body must be a JSON object"],
    ["no deskId", act({ deskId: undefined }), "deskId"],
    ["a deskId with spaces", act({ deskId: "a b" }), "deskId"],
    ["no idempotencyKey", act({ idempotencyKey: "" }), "idempotencyKey"],
    ["a numeric fencingToken", act({ fencingToken: 1 }), "fencingToken"],
    ["a negative fencingToken", act({ fencingToken: "-1" }), "fencingToken"],
    ["a zero timeout", act({ timeoutMs: 0 }), "timeoutMs"],
    ["a huge timeout", act({ timeoutMs: 10_000_000 }), "timeoutMs"],
    ["a bad provider name", act({ provider: "../x" }), "provider"],
    [
      "an unknown action",
      act({ action: { type: "format_disk" } }),
      "unknown action type",
    ],
  ];
  for (const [name, body, message] of invalid) {
    it(`POST /act refuses ${name} with 400`, async () => {
      const { status, json } = await ctx.call("POST", "/act", body);
      expect(status).toBe(400);
      expect(String(json["error"])).toContain(message);
      expect(ctx.fake.calls).toHaveLength(0);
    });
  }

  it("POST /act answers 404 for an unknown provider", async () => {
    const { status, json } = await ctx.call(
      "POST",
      "/act",
      act({ provider: "desk-macos" }),
    );
    expect(status).toBe(404);
    expect(String(json["error"])).toContain("not registered");
  });

  it("POST /fence raises the fence", async () => {
    await ctx.call("POST", "/act", act({ fencingToken: "2" }));
    const fenced = await ctx.call("POST", "/fence", {
      deskId: "desk-1",
      fencingToken: "5",
    });
    expect(fenced).toEqual({ status: 200, json: { ok: true } });
    const { json } = await ctx.call("POST", "/act", act({ fencingToken: "2" }));
    expect(json).toMatchObject({
      ok: false,
      error: { code: "STALE_FENCING_TOKEN" },
    });
  });

  it("POST /fence validates its body", async () => {
    expect((await ctx.call("POST", "/fence", "x")).status).toBe(400);
    expect(
      (await ctx.call("POST", "/fence", { fencingToken: "1" })).status,
    ).toBe(400);
    expect((await ctx.call("POST", "/fence", { deskId: "d" })).status).toBe(
      400,
    );
    expect(
      (
        await ctx.call("POST", "/fence", {
          deskId: "d",
          fencingToken: "1",
          provider: 5,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await ctx.call("POST", "/fence", {
          deskId: "d",
          fencingToken: "1",
          provider: "nope",
        })
      ).status,
    ).toBe(404);
  });
});

describe("desk routes without a usable manager", () => {
  it("answers 404 when no provider is installed", async () => {
    const { call } = await setup(false);
    const { status, json } = await call("POST", "/act", act());
    expect(status).toBe(404);
    expect(json["error"]).toBe("no desk provider is installed");
  });

  it("answers 503 when the workspace folder could not be prepared", async () => {
    const base = tempDir();
    dirs.push(base);
    const blocker = join(base, "file");
    writeFileSync(blocker, "x");
    const h = fakeHost({
      [DESK_CONFIG.workspaceFolder]: join(blocker, "desk"),
    });
    h.host.serviceRegistry?.registerProvider?.(
      "desk",
      fakeBackend().backend,
      "desk-x11",
    );
    const manager = new DeskManager({ dataDir: base });
    await expect(manager.init(h.host)).rejects.toThrow();
    const app = createDeskRoutes(manager);
    const res = await app.handle(
      new Request("http://localhost/fence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deskId: "d", fencingToken: "1" }),
      }),
    );
    expect(res.status).toBe(503);
  });

  it("hides unexpected errors behind a generic 500", async () => {
    const manager = {
      act: () => Promise.reject(new Error("internal detail")),
    } as unknown as DeskManager;
    const res = await createDeskRoutes(manager).handle(
      new Request("http://localhost/act", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(act()),
      }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "desk request failed" });
  });
});

describe("toWire", () => {
  it("leaves results without a screenshot unchanged", () => {
    expect(toWire({ ok: true, provenance: "UNTRUSTED", text: "a" })).toEqual({
      ok: true,
      provenance: "UNTRUSTED",
      text: "a",
    });
  });
});
