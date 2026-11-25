import { describe, expect, it } from "bun:test";

import {
  DESK_ACTION_TYPES,
  type DeskAction,
} from "@vibecontrols/plugin-sdk/desk";

import { DESK_LIMITS, parseDeskAction, parseDeskTarget } from "../actions.js";

const VALID: Record<(typeof DESK_ACTION_TYPES)[number], DeskAction> = {
  screenshot: { type: "screenshot" },
  snapshot: { type: "snapshot" },
  click: {
    type: "click",
    target: { by: "point", x: 15, y: 38 },
    button: "right",
    count: 2,
  },
  type: { type: "type", target: { by: "ref", ref: "e7" }, text: "hello" },
  secret_fill: {
    type: "secret_fill",
    target: { by: "ref", ref: "e2" },
    secretRef: "vault:github/password",
    expectedOrigin: "https://github.com",
  },
  key: { type: "key", keys: ["Control", "l"] },
  scroll: {
    type: "scroll",
    target: { by: "window", app: "Firefox", title: "Docs" },
    dx: 0,
    dy: -400,
  },
  navigate: { type: "navigate", url: "https://example.com/a?b=1" },
  focus_window: { type: "focus_window", app: "Terminal", title: "bash" },
  shell: { type: "shell", command: "ls -la", cwd: "sub", timeoutMs: 5000 },
  read_file: { type: "read_file", path: "notes.txt", maxBytes: 1024 },
  write_file: { type: "write_file", path: "out/report.md", content: "" },
};

describe("parseDeskAction", () => {
  it("accepts every action of the vocabulary", () => {
    for (const type of DESK_ACTION_TYPES) {
      expect(parseDeskAction(VALID[type])).toEqual({
        ok: true,
        value: VALID[type],
      });
    }
  });

  it("accepts the minimal form of actions with optional fields", () => {
    for (const action of [
      { type: "click", target: { by: "ref", ref: "e1" } },
      { type: "type", text: "x" },
      { type: "scroll", dx: 1, dy: 0 },
      { type: "focus_window", app: "Finder" },
      { type: "shell", command: "pwd", timeoutMs: 1 },
    ]) {
      expect(parseDeskAction(action)).toEqual({
        ok: true,
        value: action as DeskAction,
      });
    }
  });

  it("drops keys the vocabulary does not define", () => {
    const parsed = parseDeskAction({ type: "screenshot", evil: true });
    expect(parsed).toEqual({ ok: true, value: { type: "screenshot" } });
  });

  it("refuses non-objects and unknown types", () => {
    for (const value of [
      null,
      "screenshot",
      [],
      { type: "clipboard" },
      { type: 3 },
    ]) {
      expect(parseDeskAction(value).ok).toBe(false);
    }
  });

  const refused: Array<[string, unknown]> = [
    ["click without target", { type: "click" }],
    [
      "click with bad button",
      { type: "click", target: { by: "ref", ref: "a" }, button: "middle" },
    ],
    [
      "click with bad count",
      { type: "click", target: { by: "ref", ref: "a" }, count: 3 },
    ],
    ["type without text", { type: "type", text: "" }],
    [
      "type with huge text",
      { type: "type", text: "x".repeat(DESK_LIMITS.maxTextLength + 1) },
    ],
    [
      "type with bad target",
      { type: "type", text: "a", target: { by: "css" } },
    ],
    [
      "secret_fill with a URL, not an origin",
      {
        ...VALID.secret_fill,
        expectedOrigin: "https://github.com/login",
      },
    ],
    [
      "secret_fill with garbage origin",
      { ...VALID.secret_fill, expectedOrigin: "github" },
    ],
    ["secret_fill without ref", { ...VALID.secret_fill, secretRef: "" }],
    ["secret_fill without target", { ...VALID.secret_fill, target: undefined }],
    ["key with no keys", { type: "key", keys: [] }],
    ["key with a non-string", { type: "key", keys: ["a", 1] }],
    [
      "key with too many keys",
      { type: "key", keys: Array(DESK_LIMITS.maxKeys + 1).fill("a") },
    ],
    ["scroll with a float", { type: "scroll", dx: 1.5, dy: 0 }],
    [
      "scroll too far",
      { type: "scroll", dx: 0, dy: DESK_LIMITS.maxScroll + 1 },
    ],
    ["scroll with bad dy", { type: "scroll", dx: 0 }],
    ["scroll with bad target", { type: "scroll", dx: 0, dy: 0, target: 1 }],
    ["navigate to file:", { type: "navigate", url: "file:///etc/passwd" }],
    [
      "navigate to javascript:",
      { type: "navigate", url: "javascript:alert(1)" },
    ],
    ["navigate to a relative URL", { type: "navigate", url: "/a" }],
    ["navigate without url", { type: "navigate" }],
    ["focus_window without app", { type: "focus_window" }],
    [
      "focus_window with bad title",
      { type: "focus_window", app: "a", title: 4 },
    ],
    ["shell without timeout", { type: "shell", command: "ls" }],
    [
      "shell with a huge timeout",
      { type: "shell", command: "ls", timeoutMs: 999_999 },
    ],
    ["shell without command", { type: "shell", command: "", timeoutMs: 5 }],
    [
      "shell with bad cwd",
      { type: "shell", command: "ls", timeoutMs: 5, cwd: "" },
    ],
    ["read_file without maxBytes", { type: "read_file", path: "a" }],
    [
      "read_file too large",
      { type: "read_file", path: "a", maxBytes: DESK_LIMITS.maxFileBytes + 1 },
    ],
    ["read_file without path", { type: "read_file", maxBytes: 1 }],
    ["write_file without content", { type: "write_file", path: "a" }],
    ["write_file without path", { type: "write_file", content: "a" }],
    [
      "write_file too large",
      {
        type: "write_file",
        path: "a",
        content: "x".repeat(DESK_LIMITS.maxFileBytes + 1),
      },
    ],
  ];
  for (const [name, value] of refused) {
    it(`refuses ${name}`, () => {
      const parsed = parseDeskAction(value);
      expect(parsed.ok).toBe(false);
    });
  }
});

describe("parseDeskTarget", () => {
  it("parses each target kind", () => {
    expect(parseDeskTarget({ by: "ref", ref: "e1" })).toEqual({
      ok: true,
      value: { by: "ref", ref: "e1" },
    });
    expect(
      parseDeskTarget({ by: "point", x: 0, y: DESK_LIMITS.maxCoordinate }),
    ).toEqual({
      ok: true,
      value: { by: "point", x: 0, y: DESK_LIMITS.maxCoordinate },
    });
    expect(parseDeskTarget({ by: "window", app: "Code" })).toEqual({
      ok: true,
      value: { by: "window", app: "Code" },
    });
  });

  it("refuses bad targets", () => {
    for (const value of [
      null,
      { by: "css", selector: "#a" },
      { by: "ref" },
      { by: "ref", ref: "x".repeat(DESK_LIMITS.maxShortString + 1) },
      { by: "point", x: -1, y: 0 },
      { by: "point", x: 0 },
      { by: "window" },
      { by: "window", app: "a", title: "" },
    ]) {
      expect(parseDeskTarget(value).ok).toBe(false);
    }
  });
});
