/**
 * The `desk` / `remote` service: what the agent's bridge commands
 * (`desk.act`, `desk.fence`, `desk.health`, BOFF-16560) call when BotManor
 * drives this machine. Unlike the local HTTP routes, every action here passes
 * the own-machine safety checks first (BOFF-16567).
 *
 * `desk.act` payload (JSON):
 *
 *   {
 *     "steward": { "id", "name", "grantId", "grantVersion", "apps": [...] },
 *     "provider"?, "deskId", "fencingToken", "idempotencyKey", "timeoutMs", "action"
 *   }
 *
 * The result is the desk result in its JSON form (`screenshotPngBase64`).
 * Desk-level refusals (KILL_SWITCH, LOCAL_CONSENT_OFF, ...) come back as a
 * result with `ok: false`; a malformed payload throws a {@link DeskRemoteError}
 * with code `BAD_REQUEST`.
 */
import { DESK_LIMITS } from "./actions.js";
import type { StewardRef } from "./consent.js";
import { type DeskManager, DeskManagerError } from "./manager.js";
import { parseActBody, toWire } from "./routes.js";
import type { DeskSafety } from "./safety.js";

export class DeskRemoteError extends Error {
  constructor(
    readonly code: "BAD_REQUEST" | "DESK_OFFLINE",
    message: string,
  ) {
    super(message);
    this.name = "DeskRemoteError";
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const ID = /^[A-Za-z0-9._:-]{1,256}$/;
const MAX_NAME = 200;
const MAX_APPS = 64;

function text(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max
    ? v.trim()
    : null;
}

/** Parse the `steward` block of a remote request. */
export function parseSteward(value: unknown): StewardRef {
  if (!isRecord(value)) {
    throw new DeskRemoteError("BAD_REQUEST", "steward is required");
  }
  const id = value["id"];
  const grantId = value["grantId"];
  const grantVersion = value["grantVersion"];
  if (typeof id !== "string" || !ID.test(id)) {
    throw new DeskRemoteError("BAD_REQUEST", "steward.id is invalid");
  }
  if (typeof grantId !== "string" || !ID.test(grantId)) {
    throw new DeskRemoteError("BAD_REQUEST", "steward.grantId is invalid");
  }
  if (typeof grantVersion !== "string" || !ID.test(grantVersion)) {
    throw new DeskRemoteError("BAD_REQUEST", "steward.grantVersion is invalid");
  }
  const name = text(value["name"], MAX_NAME) ?? id;
  const rawApps: unknown = value["apps"] ?? [];
  const apps = Array.isArray(rawApps)
    ? rawApps.filter(
        (a): a is string =>
          typeof a === "string" &&
          a.length > 0 &&
          a.length <= DESK_LIMITS.maxShortString,
      )
    : [];
  if (
    !Array.isArray(rawApps) ||
    apps.length !== rawApps.length ||
    apps.length > MAX_APPS
  ) {
    throw new DeskRemoteError(
      "BAD_REQUEST",
      `steward.apps must be at most ${MAX_APPS} app names`,
    );
  }
  return { id, name, grantId, grantVersion, apps };
}

export class DeskRemote {
  constructor(
    private readonly manager: DeskManager,
    private readonly safety: DeskSafety,
  ) {}

  async act(
    payload: unknown,
    context: { signal: AbortSignal },
  ): Promise<Record<string, unknown>> {
    const steward = parseSteward(
      isRecord(payload) ? payload["steward"] : undefined,
    );
    const parsed = parseActBody(payload);
    if (!parsed.ok) throw new DeskRemoteError("BAD_REQUEST", parsed.error);
    const result = await this.safety.run(
      steward,
      parsed.value.provider,
      parsed.value.request,
      context.signal,
    );
    return toWire(result);
  }

  /**
   * Raise a desk's fence (a person took over, or the lease moved). Lowering
   * trust is always allowed, so this needs no consent.
   */
  async fence(payload: unknown): Promise<{ ok: true }> {
    if (!isRecord(payload)) {
      throw new DeskRemoteError("BAD_REQUEST", "body must be a JSON object");
    }
    const deskId = payload["deskId"];
    const token = payload["fencingToken"];
    const provider = payload["provider"];
    if (typeof deskId !== "string" || !ID.test(deskId)) {
      throw new DeskRemoteError("BAD_REQUEST", "deskId is required");
    }
    if (typeof token !== "string" || !/^\d{1,30}$/.test(token)) {
      throw new DeskRemoteError(
        "BAD_REQUEST",
        "fencingToken must be a decimal string",
      );
    }
    if (
      provider !== undefined &&
      (typeof provider !== "string" || !ID.test(provider))
    ) {
      throw new DeskRemoteError(
        "BAD_REQUEST",
        "provider must be a plugin name",
      );
    }
    try {
      await this.manager.raiseFence(deskId, token, provider);
    } catch (err) {
      if (err instanceof DeskManagerError) {
        throw new DeskRemoteError("DESK_OFFLINE", err.message);
      }
      throw err;
    }
    return { ok: true };
  }

  /** Safety state the server may show: never the consent details. */
  async health(): Promise<Record<string, unknown>> {
    const health = await this.manager.health();
    const session = this.safety.current();
    return {
      ...health,
      inControl: session
        ? { stewardId: session.stewardId, since: session.since }
        : null,
    };
  }
}
