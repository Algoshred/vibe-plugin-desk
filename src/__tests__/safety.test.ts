/**
 * Own-machine safety (BOFF-16567) end to end through the `desk` / `remote`
 * service the agent's bridge commands call: consent, the app allow list, the
 * "Steward in control" session and the kill switch.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  DeskAction,
  DeskBackendResult,
} from "@vibecontrols/plugin-sdk/desk";

import { ConsentStore } from "../consent.js";
import {
  DESK_CONFIG,
  type DeskAppInfo,
  type DeskIndicatorState,
  DeskManager,
} from "../manager.js";
import { DeskRemote, DeskRemoteError, parseSteward } from "../remote.js";
import {
  appAllowed,
  DESK_SESSION_TOPIC,
  DeskSafety,
  type DeskSessionEvent,
  readSessionState,
  SESSION_FILE,
  targetApps,
  writeSessionState,
} from "../safety.js";
import { fakeBackend, fakeHost, tempDir } from "./helpers.js";

const dirs: string[] = [];
const running: DeskSafety[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  for (const s of running.splice(0)) s.stop();
});

const STEWARD = {
  id: "stw-1",
  name: "Ada",
  grantId: "grant-1",
  grantVersion: "1",
  apps: ["Safari", "Notes"],
};

let n = 0;
function payload(action: DeskAction, over: Record<string, unknown> = {}) {
  return {
    steward: STEWARD,
    deskId: "desk-1",
    fencingToken: "1",
    idempotencyKey: `k${++n}`,
    timeoutMs: 5000,
    action,
    ...over,
  };
}

interface Options {
  kind?: string;
  front?: DeskAppInfo | null;
  noActiveApp?: boolean;
  act?: (action: DeskAction, signal: AbortSignal) => Promise<DeskBackendResult>;
  idleMs?: number;
  now?: () => number;
}

async function setup(options: Options = {}) {
  const dataDir = tempDir();
  dirs.push(dataDir);
  const h = fakeHost({ [DESK_CONFIG.remoteControl]: "on" });
  const indicator: Array<DeskIndicatorState | null> = [];
  const front = {
    app:
      options.front === undefined
        ? { name: "Safari", bundleId: "com.apple.Safari" }
        : options.front,
  };
  const fake = fakeBackend(options.kind ?? "macos", {
    ...(options.act
      ? { act: (action, ctx) => options.act!(action, ctx.signal) }
      : {}),
  });
  const backend = Object.assign(fake.backend, {
    showIndicator: (s: DeskIndicatorState | null) => void indicator.push(s),
    ...(options.noActiveApp ? {} : { activeApp: async () => front.app }),
  });
  h.host.serviceRegistry?.registerProvider?.("desk", backend, "desk-macos");
  const published: Array<{ topic: string; payload: Record<string, unknown> }> =
    [];
  h.services.set("agent/bridge", {
    publishEvent: (e: { topic: string; payload: Record<string, unknown> }) =>
      void published.push(e),
  });
  h.host.serviceRegistry!.getService = <T>(plugin: string, name: string) =>
    h.services.get(`${plugin}/${name}`) as T | undefined;

  const manager = new DeskManager({ dataDir });
  await manager.init(h.host);
  const store = new ConsentStore(dataDir);
  const sessionFile = join(dataDir, SESSION_FILE);
  const safety = new DeskSafety({
    store,
    manager,
    sessionFile,
    pollMs: 20,
    ...(options.idleMs ? { idleMs: options.idleMs } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  safety.start(h.host);
  running.push(safety);
  const events: DeskSessionEvent[] = [];
  safety.onSessionEvent((e) => void events.push(e));
  const remote = new DeskRemote(manager, safety);
  const signal = new AbortController().signal;
  const act = (action: DeskAction, over: Record<string, unknown> = {}) =>
    remote.act(payload(action, over), { signal });
  const approve = async (apps?: string[]) => {
    await act({ type: "screenshot" });
    return safety.approve(STEWARD.id, apps);
  };
  return {
    ...h,
    fake,
    manager,
    store,
    safety,
    remote,
    act,
    approve,
    events,
    published,
    indicator,
    front,
    sessionFile,
  };
}

describe("local consent", () => {
  it("refuses an unapproved Steward and records its request for the person", async () => {
    const t = await setup();
    const result = await t.act({ type: "screenshot" });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "LOCAL_CONSENT_OFF" },
    });
    expect(t.fake.calls).toHaveLength(0);
    expect(t.store.read().pending["stw-1"]).toMatchObject({
      name: "Ada",
      grantId: "grant-1",
    });
    expect(
      t.audit.filter((a) => a.event === "desk.consent.requested"),
    ).toHaveLength(1);
    // A retry does not log the request again.
    await t.act({ type: "screenshot" });
    expect(
      t.audit.filter((a) => a.event === "desk.consent.requested"),
    ).toHaveLength(1);
  });

  it("runs actions once the person approved, and asks again when the grant changes", async () => {
    const t = await setup();
    await t.approve();
    expect(await t.act({ type: "screenshot" })).toMatchObject({ ok: true });
    const changed = await t.act(
      { type: "screenshot" },
      {
        steward: { ...STEWARD, grantVersion: "2" },
      },
    );
    expect(changed).toMatchObject({
      ok: false,
      error: { code: "LOCAL_CONSENT_OFF" },
    });
    expect((changed as { error: { message: string } }).error.message).toContain(
      "grant",
    );
  });

  it("still honours the desk.remote-control master switch", async () => {
    const t = await setup();
    await t.approve();
    t.config[DESK_CONFIG.remoteControl] = "off";
    expect(await t.act({ type: "screenshot" })).toMatchObject({
      ok: false,
      error: { code: "LOCAL_CONSENT_OFF" },
    });
  });
});

describe("app allow list", () => {
  it("runs actions in an approved app", async () => {
    const t = await setup();
    await t.approve();
    expect(
      await t.act({ type: "click", target: { by: "point", x: 1, y: 1 } }),
    ).toMatchObject({ ok: true });
    expect(await t.act({ type: "focus_window", app: "notes" })).toMatchObject({
      ok: true,
    });
    // Matched by platform id too.
    t.front.app = { name: "Something", bundleId: "Notes" };
    expect(await t.act({ type: "key", keys: ["a"] })).toMatchObject({
      ok: true,
    });
  });

  it("refuses and logs an action in an app outside the list", async () => {
    const t = await setup();
    await t.approve(["Notes"]);
    const before = t.fake.calls.length;
    const result = await t.act({ type: "type", text: "hi" });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "LOCAL_CONSENT_OFF" },
    });
    expect((result as { error: { message: string } }).error.message).toContain(
      "Safari (com.apple.Safari)",
    );
    expect(t.fake.calls.length).toBe(before);
    expect(
      t.audit.find((a) => a.event === "desk.app.refused")?.payload,
    ).toMatchObject({
      stewardId: "stw-1",
      action: "type",
      app: "Safari (com.apple.Safari)",
    });
  });

  it("refuses a target app outside the list, even through a window target", async () => {
    const t = await setup();
    await t.approve(["Safari"]);
    expect(
      await t.act({ type: "focus_window", app: "Terminal" }),
    ).toMatchObject({ ok: false });
    expect(
      await t.act({ type: "click", target: { by: "window", app: "Terminal" } }),
    ).toMatchObject({ ok: false, error: { code: "LOCAL_CONSENT_OFF" } });
  });

  it("fails closed when the desk cannot tell which app is in front", async () => {
    const none = await setup({ noActiveApp: true });
    await none.approve();
    expect(await none.act({ type: "screenshot" })).toMatchObject({ ok: false });

    const empty = await setup({ front: null });
    await empty.approve();
    expect(await empty.act({ type: "screenshot" })).toMatchObject({
      ok: false,
    });
    // Focusing an allowed app is still possible.
    expect(
      await empty.act({ type: "focus_window", app: "Safari" }),
    ).toMatchObject({ ok: true });

    const broken = await setup();
    await broken.approve();
    Object.assign(broken.providers.get("desk-macos") as object, {
      activeApp: async () => {
        throw new Error("AX denied");
      },
    });
    const r = await broken.act({ type: "screenshot" });
    expect((r as { error: { message: string } }).error.message).toContain(
      "AX denied",
    );
  });

  it("does not apply to the managed browser desk or to folder actions", async () => {
    const browser = await setup({ kind: "browser", noActiveApp: true });
    await browser.approve([]);
    expect(
      await browser.act({ type: "navigate", url: "https://example.com" }),
    ).toMatchObject({ ok: true });

    const desktop = await setup({ front: null });
    await desktop.approve([]);
    expect(
      await desktop.act({ type: "read_file", path: "a.txt", maxBytes: 10 }),
    ).toMatchObject({
      provenance: "UNTRUSTED",
    });
    expect(desktop.audit.some((a) => a.event === "desk.app.refused")).toBe(
      false,
    );
  });
});

describe("Steward in control", () => {
  it("shows the indicator, records the session and tells the server when it starts", async () => {
    const t = await setup();
    await t.approve();
    expect(t.safety.current()).toBeNull();
    await t.act({ type: "screenshot" });
    expect(t.safety.current()).toMatchObject({
      stewardId: "stw-1",
      stewardName: "Ada",
    });
    expect(t.indicator.at(-1)).toMatchObject({ stewardId: "stw-1" });
    expect(readSessionState(t.sessionFile)).toMatchObject({
      stewardId: "stw-1",
    });
    expect(t.published).toEqual([
      {
        topic: DESK_SESSION_TOPIC,
        payload: expect.objectContaining({
          event: "started",
          stewardId: "stw-1",
        }),
      },
    ]);
    expect(await t.remote.health()).toMatchObject({
      inControl: { stewardId: "stw-1" },
      remoteControl: true,
    });
  });

  it("keeps one Steward in control at a time", async () => {
    const t = await setup();
    await t.approve();
    await t.act({ type: "screenshot" });
    const other = { ...STEWARD, id: "stw-2", name: "Bob" };
    await t.act({ type: "screenshot" }, { steward: other });
    t.safety.approve("stw-2");
    const r = await t.act({ type: "screenshot" }, { steward: other });
    expect((r as { error: { message: string } }).error.message).toContain(
      "Ada",
    );
  });

  it("ends the session after the idle timeout", async () => {
    let clock = 1_000;
    const t = await setup({ idleMs: 100, now: () => clock });
    await t.approve();
    await t.act({ type: "screenshot" });
    clock += 150;
    expect(t.safety.current()).toBeNull();
    expect(t.events.at(-1)).toMatchObject({ event: "ended", reason: "idle" });
    expect(t.indicator.at(-1)).toBeNull();
    expect(readSessionState(t.sessionFile)).toBeNull();
  });

  it("ends the session when the person withdraws consent, here or from the CLI", async () => {
    const t = await setup();
    await t.approve();
    await t.act({ type: "screenshot" });
    expect(t.safety.revoke("stw-1")).toBe(true);
    expect(t.events.at(-1)).toMatchObject({
      event: "ended",
      reason: "consent_revoked",
    });

    const cli = await setup();
    await cli.approve();
    await cli.act({ type: "screenshot" });
    new ConsentStore(
      cli.store.path.replace(/\/desk-consent\.json$/, ""),
    ).revoke("stw-1");
    await cli.safety.poll();
    expect(cli.events.at(-1)).toMatchObject({ reason: "consent_revoked" });
  });
});

describe("kill switch", () => {
  it("stops an action in flight within one second and the server sees the session end", async () => {
    let backendSignal: AbortSignal | undefined;
    const t = await setup({
      act: (action, signal) => {
        if (action.type === "screenshot") return Promise.resolve({ ok: true });
        backendSignal = signal;
        // A backend that never finishes on its own and ignores the signal.
        return new Promise<DeskBackendResult>(() => undefined);
      },
    });
    await t.approve();
    await t.act({ type: "screenshot" });
    const inFlight = t.act({ type: "type", text: "long" });
    await Bun.sleep(10);

    const pressed = Date.now();
    // Pressed from the CLI: another process writes the consent file.
    new ConsentStore(
      t.store.path.replace(/\/desk-consent\.json$/, ""),
    ).engageKillSwitch("cli");
    const result = await inFlight;
    expect(Date.now() - pressed).toBeLessThan(1000);
    expect(result).toMatchObject({ ok: false, error: { code: "KILL_SWITCH" } });
    expect(backendSignal?.aborted).toBe(true);
    expect(t.published.at(-1)).toEqual({
      topic: DESK_SESSION_TOPIC,
      payload: expect.objectContaining({
        event: "ended",
        reason: "kill_switch",
        stewardId: "stw-1",
      }),
    });
    expect(t.audit.some((a) => a.event === "desk.kill_switch")).toBe(true);

    // Refused from now on; approvals are gone, so resuming is not enough.
    expect(await t.act({ type: "screenshot" })).toMatchObject({
      error: { code: "KILL_SWITCH" },
    });
    t.safety.resume();
    expect(await t.act({ type: "screenshot" })).toMatchObject({
      error: { code: "LOCAL_CONSENT_OFF" },
    });
  });

  it("works from the API in process, and stays pressed across a restart", async () => {
    const t = await setup();
    await t.approve();
    await t.act({ type: "screenshot" });
    t.safety.kill("api");
    expect(t.events.at(-1)).toMatchObject({ reason: "kill_switch" });
    expect(t.manager.killSwitchEngaged).toBe(true);

    const restarted = new DeskManager({
      dataDir: t.store.path.replace(/\/desk-consent\.json$/, ""),
    });
    await restarted.init(t.host);
    const again = new DeskSafety({ store: t.store, manager: restarted });
    again.start(t.host);
    running.push(again);
    expect(restarted.killSwitchEngaged).toBe(true);
  });

  it("the desk.kill-switch config key also aborts actions in flight", async () => {
    const t = await setup({
      act: (action) =>
        action.type === "screenshot"
          ? Promise.resolve({ ok: true })
          : new Promise<DeskBackendResult>(() => undefined),
    });
    await t.approve();
    await t.act({ type: "screenshot" });
    const inFlight = t.act({ type: "type", text: "x" });
    await Bun.sleep(10);
    t.config[DESK_CONFIG.killSwitch] = "on";
    expect(await inFlight).toMatchObject({ error: { code: "KILL_SWITCH" } });
    t.config[DESK_CONFIG.killSwitch] = "off";
    // The watcher (every 20 ms here) releases it again.
    await Bun.sleep(150);
    expect(t.manager.killSwitchEngaged).toBe(false);
  });

  it("a cancelled bridge request stops its action", async () => {
    const t = await setup({
      act: (action) =>
        action.type === "screenshot"
          ? Promise.resolve({ ok: true })
          : new Promise<DeskBackendResult>(() => undefined),
    });
    await t.approve();
    const controller = new AbortController();
    const pending = t.remote.act(payload({ type: "type", text: "x" }), {
      signal: controller.signal,
    });
    await Bun.sleep(10);
    controller.abort();
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: "TIMEOUT" },
    });
  });
});

describe("remote payloads", () => {
  it("refuses malformed requests with BAD_REQUEST", async () => {
    const t = await setup();
    const signal = new AbortController().signal;
    for (const bad of [
      null,
      { ...payload({ type: "screenshot" }), steward: undefined },
      {
        ...payload({ type: "screenshot" }),
        steward: { ...STEWARD, id: "bad id" },
      },
      {
        ...payload({ type: "screenshot" }),
        steward: { ...STEWARD, grantId: "" },
      },
      {
        ...payload({ type: "screenshot" }),
        steward: { ...STEWARD, grantVersion: 1 },
      },
      {
        ...payload({ type: "screenshot" }),
        steward: { ...STEWARD, apps: [1] },
      },
      {
        ...payload({ type: "screenshot" }),
        steward: { ...STEWARD, apps: "x" },
      },
      { ...payload({ type: "screenshot" }), deskId: undefined },
    ]) {
      await expect(t.remote.act(bad, { signal })).rejects.toBeInstanceOf(
        DeskRemoteError,
      );
    }
    expect(parseSteward({ id: "a", grantId: "g", grantVersion: "1" })).toEqual({
      id: "a",
      name: "a",
      grantId: "g",
      grantVersion: "1",
      apps: [],
    });
  });

  it("raises fences without consent and validates them", async () => {
    const t = await setup();
    expect(
      await t.remote.fence({ deskId: "desk-1", fencingToken: "5" }),
    ).toEqual({ ok: true });
    await expect(t.remote.fence(null)).rejects.toThrow("JSON object");
    await expect(
      t.remote.fence({ deskId: "x y", fencingToken: "1" }),
    ).rejects.toThrow("deskId");
    await expect(
      t.remote.fence({ deskId: "d", fencingToken: "-1" }),
    ).rejects.toThrow("fencingToken");
    await expect(
      t.remote.fence({ deskId: "d", fencingToken: "1", provider: 3 }),
    ).rejects.toThrow("provider");
    await expect(
      t.remote.fence({ deskId: "d", fencingToken: "1", provider: "missing" }),
    ).rejects.toMatchObject({ code: "DESK_OFFLINE" });
  });

  it("answers DESK_OFFLINE for an unknown provider", async () => {
    const t = await setup();
    await t.approve();
    expect(
      await t.act({ type: "screenshot" }, { provider: "missing" }),
    ).toMatchObject({
      ok: false,
      error: { code: "DESK_OFFLINE" },
    });
  });
});

describe("helpers", () => {
  it("finds the apps an action names", () => {
    expect(targetApps({ type: "focus_window", app: "A" })).toEqual(["A"]);
    expect(
      targetApps({ type: "click", target: { by: "window", app: "B" } }),
    ).toEqual(["B"]);
    expect(targetApps({ type: "type", text: "x" })).toEqual([]);
    expect(
      targetApps({
        type: "scroll",
        dx: 1,
        dy: 1,
        target: { by: "window", app: "C" },
      }),
    ).toEqual(["C"]);
    expect(targetApps({ type: "screenshot" })).toEqual([]);
    expect(appAllowed({ apps: ["safari"] }, " Safari ")).toBe(true);
    expect(
      appAllowed(
        { apps: ["com.apple.safari"] },
        { name: "X", bundleId: "com.apple.Safari" },
      ),
    ).toBe(true);
    expect(appAllowed({ apps: [] }, { name: "X" })).toBe(false);
  });

  it("reads back the session file and ignores a damaged one", () => {
    const dir = tempDir();
    dirs.push(dir);
    const file = join(dir, SESSION_FILE);
    expect(readSessionState(file)).toBeNull();
    writeSessionState(file, { stewardId: "a", stewardName: "A", since: "t" });
    expect(readSessionState(file)).toEqual({
      stewardId: "a",
      stewardName: "A",
      since: "t",
    });
    writeSessionState(file, null);
    expect(readSessionState(file)).toBeNull();
    writeFileSync(file, "{");
    expect(readSessionState(file)).toBeNull();
  });
});
