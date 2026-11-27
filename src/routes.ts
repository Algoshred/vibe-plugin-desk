/**
 * HTTP routes, mounted by the agent under `/api/desk`. The agent's own
 * authentication applies to every route here.
 *
 *   GET  /providers  registered desk providers and the actions each supports
 *   GET  /health     remote-control, kill-switch and readiness state
 *   POST /act        run one action          { provider?, deskId, fencingToken,
 *                                               idempotencyKey, timeoutMs, action }
 *   POST /fence      raise a desk's fence    { provider?, deskId, fencingToken }
 *
 * Own-machine safety (BOFF-16567), for the person who owns this agent:
 *
 *   GET  /session                       the Steward in control, or null
 *   GET  /consent                       approvals, pending requests, kill switch
 *   POST /consent/:stewardId/approve    approve a pending request  { apps? }
 *   POST /consent/:stewardId/revoke     withdraw an approval
 *   POST /kill                          press the kill switch
 *   POST /resume                        release it
 *
 * The BotManor command channel never reaches these routes: it calls the
 * `desk` / `remote` service, which cannot approve anything.
 *
 * JSON has no bytes or bigints: `fencingToken` is a decimal string, and a
 * screenshot comes back as `screenshotPngBase64`.
 */
import type {
  DeskActRequest,
  DeskActResult,
} from "@vibecontrols/plugin-sdk/desk";
import { Elysia } from "elysia";

import { DESK_LIMITS, type ParseResult, parseDeskAction } from "./actions.js";
import { ConsentError } from "./consent.js";
import { type DeskManager, DeskManagerError } from "./manager.js";
import type { DeskSafety } from "./safety.js";

type Body = Record<string, unknown>;

const isBody = (value: unknown): value is Body =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const MAX_ID = 256;
const ID = /^[A-Za-z0-9._:-]+$/;

function id(body: Body, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.length <= MAX_ID && ID.test(value)
    ? value
    : null;
}

function token(body: Body): string | null {
  const value = body["fencingToken"];
  return typeof value === "string" && /^\d{1,30}$/.test(value) ? value : null;
}

function provider(body: Body): string | undefined | null {
  const value = body["provider"];
  if (value === undefined) return undefined;
  return typeof value === "string" && value.length <= MAX_ID && ID.test(value)
    ? value
    : null;
}

/**
 * Parse the body of an act request (`POST /act`, and the `desk.act` bridge
 * command). Every field is checked; extra keys are ignored.
 */
export function parseActBody(
  body: unknown,
): ParseResult<{ request: DeskActRequest; provider: string | undefined }> {
  const bad = (error: string) => ({ ok: false as const, error });
  if (!isBody(body)) return bad("body must be a JSON object");
  const deskId = id(body, "deskId");
  if (!deskId) return bad("deskId is required");
  const idempotencyKey = id(body, "idempotencyKey");
  if (!idempotencyKey) return bad("idempotencyKey is required");
  const fencingToken = token(body);
  if (!fencingToken) return bad("fencingToken must be a decimal string");
  const timeoutMs = body["timeoutMs"];
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > DESK_LIMITS.maxTimeoutMs
  ) {
    return bad(
      `timeoutMs must be an integer from 1 to ${DESK_LIMITS.maxTimeoutMs}`,
    );
  }
  const name = provider(body);
  if (name === null) return bad("provider must be a plugin name");
  const action = parseDeskAction(body["action"]);
  if (!action.ok) return bad(action.error);
  return {
    ok: true,
    value: {
      request: {
        deskId,
        fencingToken,
        idempotencyKey,
        timeoutMs,
        action: action.value,
      },
      provider: name,
    },
  };
}

/** The JSON form of a result: bytes become base64. */
export function toWire(result: DeskActResult): Record<string, unknown> {
  const { screenshotPng, ...rest } = result;
  return screenshotPng
    ? {
        ...rest,
        screenshotPngBase64: Buffer.from(screenshotPng).toString("base64"),
      }
    : rest;
}

export function createDeskRoutes(manager: DeskManager, safety?: DeskSafety) {
  const fail = (
    set: { status?: number | string },
    status: number,
    error: string,
  ) => {
    set.status = status;
    return { error };
  };
  const managerFailure = (set: { status?: number | string }, err: unknown) => {
    if (err instanceof DeskManagerError) {
      return fail(set, err.code === "NO_PROVIDER" ? 404 : 503, err.message);
    }
    return fail(set, 500, "desk request failed");
  };

  return new Elysia()
    .get("/providers", () => ({ providers: manager.listProviders() }))

    .get("/health", () => manager.health())

    .post("/act", async ({ body, set }) => {
      const parsed = parseActBody(body);
      if (!parsed.ok) return fail(set, 400, parsed.error);
      try {
        const result = await manager.act(
          parsed.value.request,
          parsed.value.provider,
        );
        return toWire(result);
      } catch (err) {
        return managerFailure(set, err);
      }
    })

    .get("/session", () => ({ inControl: safety?.current() ?? null }))

    .get("/consent", ({ set }) =>
      safety ? safety.store.read() : fail(set, 503, "desk safety is not ready"),
    )

    .post("/consent/:stewardId/approve", ({ params, body, set }) => {
      if (!safety) return fail(set, 503, "desk safety is not ready");
      const apps = isBody(body) ? body["apps"] : undefined;
      if (
        apps !== undefined &&
        (!Array.isArray(apps) || !apps.every((a) => typeof a === "string"))
      ) {
        return fail(set, 400, "apps must be a list of app names");
      }
      try {
        return { approval: safety.approve(params.stewardId, apps) };
      } catch (err) {
        if (err instanceof ConsentError) return fail(set, 404, err.message);
        throw err;
      }
    })

    .post("/consent/:stewardId/revoke", ({ params, set }) =>
      safety
        ? { revoked: safety.revoke(params.stewardId) }
        : fail(set, 503, "desk safety is not ready"),
    )

    .post("/kill", ({ set }) => {
      if (!safety) return fail(set, 503, "desk safety is not ready");
      safety.kill("api");
      return { ok: true };
    })

    .post("/resume", ({ set }) => {
      if (!safety) return fail(set, 503, "desk safety is not ready");
      safety.resume();
      return { ok: true };
    })

    .post("/fence", async ({ body, set }) => {
      if (!isBody(body)) return fail(set, 400, "body must be a JSON object");
      const deskId = id(body, "deskId");
      if (!deskId) return fail(set, 400, "deskId is required");
      const fencingToken = token(body);
      if (!fencingToken)
        return fail(set, 400, "fencingToken must be a decimal string");
      const name = provider(body);
      if (name === null)
        return fail(set, 400, "provider must be a plugin name");
      try {
        await manager.raiseFence(deskId, fencingToken, name);
        return { ok: true };
      } catch (err) {
        return managerFailure(set, err);
      }
    });
}
