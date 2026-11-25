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
 * JSON has no bytes or bigints: `fencingToken` is a decimal string, and a
 * screenshot comes back as `screenshotPngBase64`.
 */
import type { DeskActResult } from "@vibecontrols/plugin-sdk/desk";
import { Elysia } from "elysia";

import { DESK_LIMITS, parseDeskAction } from "./actions.js";
import { type DeskManager, DeskManagerError } from "./manager.js";

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

export function createDeskRoutes(manager: DeskManager) {
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
      if (!isBody(body)) return fail(set, 400, "body must be a JSON object");
      const deskId = id(body, "deskId");
      if (!deskId) return fail(set, 400, "deskId is required");
      const idempotencyKey = id(body, "idempotencyKey");
      if (!idempotencyKey) return fail(set, 400, "idempotencyKey is required");
      const fencingToken = token(body);
      if (!fencingToken)
        return fail(set, 400, "fencingToken must be a decimal string");
      const timeoutMs = body["timeoutMs"];
      if (
        typeof timeoutMs !== "number" ||
        !Number.isInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > DESK_LIMITS.maxTimeoutMs
      ) {
        return fail(
          set,
          400,
          `timeoutMs must be an integer from 1 to ${DESK_LIMITS.maxTimeoutMs}`,
        );
      }
      const name = provider(body);
      if (name === null)
        return fail(set, 400, "provider must be a plugin name");
      const action = parseDeskAction(body["action"]);
      if (!action.ok) return fail(set, 400, action.error);

      try {
        const result = await manager.act(
          {
            deskId,
            fencingToken,
            idempotencyKey,
            timeoutMs,
            action: action.value,
          },
          name,
        );
        return toWire(result);
      } catch (err) {
        return managerFailure(set, err);
      }
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
