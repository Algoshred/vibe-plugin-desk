/**
 * Validation for desk actions arriving over the wire.
 *
 * The SDK's `DeskAction` type describes the vocabulary, but a type is not a
 * check: requests reach this plugin as JSON from the BotManor command channel
 * or the agent HTTP API. Every action is parsed here, field by field, before a
 * guard or backend sees it. Unknown action types, unknown target kinds,
 * missing fields and out-of-range values are refused, and the parsed action
 * holds only the fields the vocabulary defines (extra keys are dropped).
 */
import {
  DESK_ACTION_TYPES,
  type DeskAction,
  type DeskActionType,
  type DeskTarget,
} from "@vibecontrols/plugin-sdk/desk";

/** Upper bounds for one action. Larger work is split into several actions. */
export const DESK_LIMITS = {
  /** Longest single action, in milliseconds. */
  maxTimeoutMs: 120_000,
  /** `type` text, shell command, key list entries and window titles. */
  maxTextLength: 10_000,
  /** `read_file.maxBytes` and `write_file.content` length. */
  maxFileBytes: 10 * 1024 * 1024,
  /** Keys pressed together in one `key` action. */
  maxKeys: 16,
  /** Scroll distance per action, in either direction. */
  maxScroll: 10_000,
  /** Screen coordinates. */
  maxCoordinate: 32_767,
  /** Paths, URLs, refs and identifiers. */
  maxShortString: 4_096,
} as const;

export type ParseResult<T> =
  { ok: true; value: T } | { ok: false; error: string };

type Fields = Record<string, unknown>;

const isObject = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
const bad = <T>(error: string): ParseResult<T> => ({ ok: false, error });

function str(
  fields: Fields,
  key: string,
  max: number = DESK_LIMITS.maxShortString,
): ParseResult<string> {
  const value = fields[key];
  if (typeof value !== "string" || value.length === 0) {
    return bad(`${key} must be a non-empty string`);
  }
  if (value.length > max) return bad(`${key} is longer than ${max} characters`);
  return ok(value);
}

function optStr(
  fields: Fields,
  key: string,
  max: number = DESK_LIMITS.maxShortString,
): ParseResult<string | undefined> {
  return fields[key] === undefined ? ok(undefined) : str(fields, key, max);
}

function int(
  fields: Fields,
  key: string,
  min: number,
  max: number,
): ParseResult<number> {
  const value = fields[key];
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    return bad(`${key} must be an integer from ${min} to ${max}`);
  }
  return ok(value);
}

/** Parse a target (`by: "ref" | "point" | "window"`). */
export function parseDeskTarget(value: unknown): ParseResult<DeskTarget> {
  if (!isObject(value)) return bad("target must be an object");
  switch (value["by"]) {
    case "ref": {
      const ref = str(value, "ref");
      return ref.ok ? ok({ by: "ref", ref: ref.value }) : ref;
    }
    case "point": {
      const x = int(value, "x", 0, DESK_LIMITS.maxCoordinate);
      if (!x.ok) return x;
      const y = int(value, "y", 0, DESK_LIMITS.maxCoordinate);
      if (!y.ok) return y;
      return ok({ by: "point", x: x.value, y: y.value });
    }
    case "window": {
      const app = str(value, "app");
      if (!app.ok) return app;
      const title = optStr(value, "title");
      if (!title.ok) return title;
      return ok(
        title.value === undefined
          ? { by: "window", app: app.value }
          : { by: "window", app: app.value, title: title.value },
      );
    }
    default:
      return bad('target.by must be "ref", "point" or "window"');
  }
}

function optTarget(fields: Fields): ParseResult<DeskTarget | undefined> {
  return fields["target"] === undefined
    ? ok(undefined)
    : parseDeskTarget(fields["target"]);
}

const isActionType = (value: unknown): value is DeskActionType =>
  typeof value === "string" &&
  (DESK_ACTION_TYPES as readonly string[]).includes(value);

/** Parse one action of the spec 10 §7.2 vocabulary. */
export function parseDeskAction(value: unknown): ParseResult<DeskAction> {
  if (!isObject(value)) return bad("action must be an object");
  const type = value["type"];
  if (!isActionType(type)) return bad(`unknown action type: ${String(type)}`);

  switch (type) {
    case "screenshot":
    case "snapshot":
      return ok({ type });

    case "click": {
      const target = parseDeskTarget(value["target"]);
      if (!target.ok) return target;
      const action: Extract<DeskAction, { type: "click" }> = {
        type,
        target: target.value,
      };
      const button = value["button"];
      if (button !== undefined) {
        if (button !== "left" && button !== "right")
          return bad('button must be "left" or "right"');
        action.button = button;
      }
      const count = value["count"];
      if (count !== undefined) {
        if (count !== 1 && count !== 2) return bad("count must be 1 or 2");
        action.count = count;
      }
      return ok(action);
    }

    case "type": {
      const text = str(value, "text", DESK_LIMITS.maxTextLength);
      if (!text.ok) return text;
      const target = optTarget(value);
      if (!target.ok) return target;
      return ok(
        target.value === undefined
          ? { type, text: text.value }
          : { type, target: target.value, text: text.value },
      );
    }

    case "secret_fill": {
      const target = parseDeskTarget(value["target"]);
      if (!target.ok) return target;
      const secretRef = str(value, "secretRef");
      if (!secretRef.ok) return secretRef;
      const origin = str(value, "expectedOrigin");
      if (!origin.ok) return origin;
      let parsed: URL;
      try {
        parsed = new URL(origin.value);
      } catch {
        return bad(
          "expectedOrigin must be an origin such as https://example.com",
        );
      }
      if (parsed.origin !== origin.value) {
        return bad(
          "expectedOrigin must be an origin such as https://example.com",
        );
      }
      return ok({
        type,
        target: target.value,
        secretRef: secretRef.value,
        expectedOrigin: origin.value,
      });
    }

    case "key": {
      const keys = value["keys"];
      if (
        !Array.isArray(keys) ||
        keys.length === 0 ||
        keys.length > DESK_LIMITS.maxKeys ||
        !keys.every(
          (k) => typeof k === "string" && k.length > 0 && k.length <= 64,
        )
      ) {
        return bad(
          `keys must be 1 to ${DESK_LIMITS.maxKeys} non-empty key names`,
        );
      }
      return ok({ type, keys: [...(keys as string[])] });
    }

    case "scroll": {
      const dx = int(
        value,
        "dx",
        -DESK_LIMITS.maxScroll,
        DESK_LIMITS.maxScroll,
      );
      if (!dx.ok) return dx;
      const dy = int(
        value,
        "dy",
        -DESK_LIMITS.maxScroll,
        DESK_LIMITS.maxScroll,
      );
      if (!dy.ok) return dy;
      const target = optTarget(value);
      if (!target.ok) return target;
      return ok(
        target.value === undefined
          ? { type, dx: dx.value, dy: dy.value }
          : { type, target: target.value, dx: dx.value, dy: dy.value },
      );
    }

    case "navigate": {
      const url = str(value, "url");
      if (!url.ok) return url;
      let parsed: URL;
      try {
        parsed = new URL(url.value);
      } catch {
        return bad("url must be an absolute http(s) URL");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return bad("url must be an absolute http(s) URL");
      }
      return ok({ type, url: url.value });
    }

    case "focus_window": {
      const app = str(value, "app");
      if (!app.ok) return app;
      const title = optStr(value, "title");
      if (!title.ok) return title;
      return ok(
        title.value === undefined
          ? { type, app: app.value }
          : { type, app: app.value, title: title.value },
      );
    }

    case "shell": {
      const command = str(value, "command", DESK_LIMITS.maxTextLength);
      if (!command.ok) return command;
      const timeoutMs = int(value, "timeoutMs", 1, DESK_LIMITS.maxTimeoutMs);
      if (!timeoutMs.ok) return timeoutMs;
      const cwd = optStr(value, "cwd");
      if (!cwd.ok) return cwd;
      return ok(
        cwd.value === undefined
          ? { type, command: command.value, timeoutMs: timeoutMs.value }
          : {
              type,
              command: command.value,
              cwd: cwd.value,
              timeoutMs: timeoutMs.value,
            },
      );
    }

    case "read_file": {
      const path = str(value, "path");
      if (!path.ok) return path;
      const maxBytes = int(value, "maxBytes", 1, DESK_LIMITS.maxFileBytes);
      if (!maxBytes.ok) return maxBytes;
      return ok({ type, path: path.value, maxBytes: maxBytes.value });
    }

    case "write_file": {
      const path = str(value, "path");
      if (!path.ok) return path;
      const content = value["content"];
      if (
        typeof content !== "string" ||
        content.length > DESK_LIMITS.maxFileBytes
      ) {
        return bad(
          `content must be a string of at most ${DESK_LIMITS.maxFileBytes} characters`,
        );
      }
      return ok({ type, path: path.value, content });
    }
  }
}
