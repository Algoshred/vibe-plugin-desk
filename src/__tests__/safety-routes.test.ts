/** The owner-facing safety routes and the `vibe desk` commands (BOFF-16567). */
import { afterAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

import {
  type CliCommand,
  deskStatusLines,
  registerDeskCommands,
} from "../cli.js";
import { ConsentStore } from "../consent.js";
import { DESK_CONFIG, DeskManager } from "../manager.js";
import { createDeskRoutes } from "../routes.js";
import { DeskSafety, SESSION_FILE, writeSessionState } from "../safety.js";
import { fakeBackend, fakeHost, tempDir } from "./helpers.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const STEWARD = {
  id: "stw-1",
  name: "Ada",
  grantId: "g",
  grantVersion: "1",
  apps: ["Safari"],
};

async function setup(withSafety = true) {
  const dataDir = tempDir();
  dirs.push(dataDir);
  const h = fakeHost({ [DESK_CONFIG.remoteControl]: "on" });
  h.host.serviceRegistry?.registerProvider?.(
    "desk",
    fakeBackend("browser").backend,
    "desk-browser",
  );
  const manager = new DeskManager({ dataDir });
  await manager.init(h.host);
  const store = new ConsentStore(dataDir);
  const safety = new DeskSafety({ store, manager });
  const app = createDeskRoutes(manager, withSafety ? safety : undefined);
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
  return { dataDir, store, safety, manager, call };
}

describe("safety routes", () => {
  it("lists, approves and revokes consent", async () => {
    const t = await setup();
    t.store.recordPending(STEWARD);
    expect((await t.call("GET", "/consent")).json).toMatchObject({
      pending: { "stw-1": { name: "Ada" } },
    });
    expect((await t.call("POST", "/consent/nobody/approve", {})).status).toBe(
      404,
    );
    expect(
      (await t.call("POST", "/consent/stw-1/approve", { apps: [1] })).status,
    ).toBe(400);
    const ok = await t.call("POST", "/consent/stw-1/approve", {
      apps: ["Notes"],
    });
    expect(ok.json).toMatchObject({ approval: { apps: ["notes"] } });
    expect((await t.call("POST", "/consent/stw-1/revoke")).json).toEqual({
      revoked: true,
    });
  });

  it("presses and releases the kill switch, and reports the session", async () => {
    const t = await setup();
    expect((await t.call("GET", "/session")).json).toEqual({ inControl: null });
    expect((await t.call("POST", "/kill")).json).toEqual({ ok: true });
    expect(t.store.read().killSwitch?.source).toBe("api");
    expect(t.manager.killSwitchEngaged).toBe(true);
    expect((await t.call("POST", "/resume")).json).toEqual({ ok: true });
    expect(t.manager.killSwitchEngaged).toBe(false);
  });

  it("answers 503 before safety is wired", async () => {
    const t = await setup(false);
    for (const [method, path] of [
      ["GET", "/consent"],
      ["POST", "/consent/a/approve"],
      ["POST", "/consent/a/revoke"],
      ["POST", "/kill"],
      ["POST", "/resume"],
    ] as const) {
      expect((await t.call(method, path)).status).toBe(503);
    }
    expect((await t.call("GET", "/session")).json).toEqual({ inControl: null });
  });
});

/** A commander stand-in that records commands and runs their actions. */
function fakeProgram() {
  const actions = new Map<
    string,
    (...args: unknown[]) => void | Promise<void>
  >();
  const make = (path: string): CliCommand => ({
    command: (nameAndArgs) =>
      make(`${path} ${nameAndArgs.split(" ")[0]}`.trim()),
    description: function () {
      return this;
    },
    option: function () {
      return this;
    },
    action: function (fn) {
      actions.set(path, fn);
      return this;
    },
  });
  return {
    program: make(""),
    run: (path: string, ...args: unknown[]) => actions.get(path)!(...args),
  };
}

describe("vibe desk", () => {
  async function cli() {
    const dataDir = tempDir();
    dirs.push(dataDir);
    const store = new ConsentStore(dataDir);
    const sessionFile = join(dataDir, SESSION_FILE);
    const out: string[] = [];
    const err: string[] = [];
    let failed = false;
    const p = fakeProgram();
    registerDeskCommands(p.program, store, sessionFile, {
      out: (l) => void out.push(l),
      err: (l) => void err.push(l),
      fail: () => {
        failed = true;
      },
    });
    return { store, sessionFile, out, err, run: p.run, failed: () => failed };
  }

  it("shows status, approves, revokes, kills and resumes", async () => {
    const c = await cli();
    await c.run("desk status");
    expect(c.out[0]).toBe("No Steward is in control of this machine.");

    c.store.recordPending(STEWARD);
    writeSessionState(c.sessionFile, {
      stewardId: "stw-1",
      stewardName: "Ada",
      since: "t",
    });
    c.out.length = 0;
    await c.run("desk consent list");
    expect(c.out.join("\n")).toContain("Waiting for your approval:");
    expect(c.out.join("\n")).toContain(
      'vibe desk consent approve stw-1 --apps "safari"',
    );

    await c.run("desk consent approve", "stw-1", { apps: "Safari, Notes" });
    expect(c.store.read().stewards["stw-1"]?.apps).toEqual(["notes", "safari"]);
    c.out.length = 0;
    await c.run("desk status");
    expect(c.out[0]).toContain("Steward in control: Ada (stw-1)");
    expect(c.out.join("\n")).toContain("apps: notes, safari");

    await c.run("desk consent revoke", "stw-1");
    await c.run("desk consent revoke", "stw-1");
    expect(c.out.at(-1)).toContain("neither approved nor waiting");

    await c.run("desk kill");
    expect(c.store.read().killSwitch?.source).toBe("cli");
    expect(deskStatusLines(c.store, c.sessionFile)[1]).toContain("ENGAGED");
    await c.run("desk resume");
    expect(c.store.read().killSwitch).toBeUndefined();
    expect(c.failed()).toBe(false);
  });

  it("reports a refused approval as a failure", async () => {
    const c = await cli();
    await c.run("desk consent approve", "nobody", {});
    expect(c.err[0]).toContain("no pending request");
    expect(c.failed()).toBe(true);
  });
});
