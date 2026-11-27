import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  CONSENT_FILE,
  ConsentError,
  ConsentStore,
  normalizeApps,
  parseConsentState,
} from "../consent.js";
import { tempDir } from "./helpers.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function store(clock = { t: 0 }) {
  const dir = tempDir();
  dirs.push(dir);
  return new ConsentStore(dir, () => new Date(1_700_000_000_000 + clock.t++));
}

const steward = {
  id: "stw-1",
  name: "Ada",
  grantId: "grant-1",
  grantVersion: "3",
  apps: ["Safari", "com.apple.Notes", "safari"],
};

describe("ConsentStore", () => {
  it("starts with nothing approved and no kill switch", () => {
    const s = store();
    expect(s.read()).toEqual({ version: 1, stewards: {}, pending: {} });
    expect(s.check(steward)).toEqual({ ok: false, reason: "NOT_APPROVED" });
  });

  it("records a request once, then approves it for the requested or chosen apps", () => {
    const s = store();
    expect(s.recordPending(steward)).toBe(true);
    expect(s.recordPending(steward)).toBe(false);
    expect(s.read().pending["stw-1"]).toMatchObject({
      name: "Ada",
      apps: ["com.apple.notes", "safari"],
    });
    if (process.platform !== "win32") {
      expect(statSync(s.path).mode & 0o777).toBe(0o600);
    }

    const approval = s.approve("stw-1");
    expect(approval.apps).toEqual(["com.apple.notes", "safari"]);
    expect(s.read().pending).toEqual({});
    expect(s.check(steward)).toMatchObject({ ok: true });

    s.recordPending({ ...steward, id: "stw-2" });
    expect(s.approve("stw-2", [" Terminal "]).apps).toEqual(["terminal"]);
  });

  it("asks again when the grant changes", () => {
    const s = store();
    s.recordPending(steward);
    s.approve("stw-1");
    expect(s.check({ ...steward, grantVersion: "4" })).toEqual({
      ok: false,
      reason: "GRANT_CHANGED",
    });
    expect(s.check({ ...steward, grantId: "grant-2" })).toEqual({
      ok: false,
      reason: "GRANT_CHANGED",
    });
    // A changed request is recorded again.
    expect(s.recordPending({ ...steward, grantVersion: "4" })).toBe(true);
  });

  it("refuses to approve a Steward that never asked", () => {
    expect(() => store().approve("nobody")).toThrow(ConsentError);
  });

  it("revokes approvals and pending requests", () => {
    const s = store();
    s.recordPending(steward);
    s.approve("stw-1");
    expect(s.revoke("stw-1")).toBe(true);
    expect(s.revoke("stw-1")).toBe(false);
    s.recordPending(steward);
    expect(s.revoke("stw-1")).toBe(true);
    expect(s.read().pending).toEqual({});
  });

  it("withdraws every approval when the kill switch is pressed", () => {
    const s = store();
    s.recordPending(steward);
    s.approve("stw-1");
    s.engageKillSwitch("cli");
    expect(s.read().killSwitch).toMatchObject({ engaged: true, source: "cli" });
    expect(s.read().stewards).toEqual({});
    s.releaseKillSwitch();
    expect(s.read().killSwitch).toBeUndefined();
    expect(s.check(steward).ok).toBe(false);
  });

  it("sees writes from another process", () => {
    const s = store();
    const other = new ConsentStore(s.path.slice(0, -CONSENT_FILE.length - 1));
    expect(s.read().killSwitch).toBeUndefined();
    other.engageKillSwitch("cli");
    expect(s.read().killSwitch?.engaged).toBe(true);
  });

  it("keeps at most 32 pending requests, dropping the oldest", () => {
    const s = store();
    for (let i = 0; i < 40; i++) s.recordPending({ ...steward, id: `s${i}` });
    const ids = Object.keys(s.read().pending);
    expect(ids).toHaveLength(32);
    expect(ids).not.toContain("s0");
    expect(ids).toContain("s39");
  });
});

describe("parseConsentState", () => {
  it("fails closed on a damaged file", () => {
    for (const text of ["{nope", "null", JSON.stringify({ version: 2 })]) {
      const state = parseConsentState(text);
      expect(state.stewards).toEqual({});
      expect(state.killSwitch?.engaged).toBe(true);
    }
  });

  it("drops entries that do not parse", () => {
    const state = parseConsentState(
      JSON.stringify({
        version: 1,
        stewards: {
          good: {
            name: "A",
            grantId: "g",
            grantVersion: "1",
            apps: ["X"],
            approvedAt: "t",
          },
          bad: { name: "B" },
          worse: "x",
        },
        pending: {
          p: {
            name: "P",
            grantId: "g",
            grantVersion: "1",
            apps: [1],
            requestedAt: "t",
          },
          q: {
            name: "Q",
            grantId: "g",
            grantVersion: "1",
            apps: [],
            requestedAt: "t",
          },
        },
        killSwitch: { engaged: true },
      }),
    );
    expect(Object.keys(state.stewards)).toEqual(["good"]);
    expect(state.stewards["good"]?.apps).toEqual(["x"]);
    expect(Object.keys(state.pending)).toEqual(["q"]);
    expect(state.killSwitch).toMatchObject({
      engaged: true,
      source: "unknown",
    });
  });

  it("reads a damaged file on disk as engaged", () => {
    const s = store();
    writeFileSync(s.path, "garbage");
    expect(s.read().killSwitch?.engaged).toBe(true);
    expect(readFileSync(s.path, "utf8")).toBe("garbage");
  });
});

describe("normalizeApps", () => {
  it("lower-cases, trims, dedupes and bounds the list", () => {
    expect(normalizeApps([" A", "a", "", "B"])).toEqual(["a", "b"]);
    expect(
      normalizeApps(Array.from({ length: 100 }, (_, i) => `app${i}`)),
    ).toHaveLength(64);
    expect(normalizeApps(["x".repeat(300)])).toEqual([]);
  });

  it("keeps the store path in the data dir", () => {
    const s = store();
    expect(s.path.endsWith(join("", CONSENT_FILE))).toBe(true);
  });
});
