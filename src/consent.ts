/**
 * Local consent for own-machine desks (BOFF-16567).
 *
 * The person at the machine decides which BotManor Stewards may use it, under
 * which grant, and in which apps. Their decisions live in one file in the
 * profile's data directory, `desk-consent.json` (mode 0600):
 *
 *   {
 *     "version": 1,
 *     "stewards": { "<stewardId>": { name, grantId, grantVersion, apps[], approvedAt } },
 *     "pending":  { "<stewardId>": { name, grantId, grantVersion, apps[], requestedAt } },
 *     "killSwitch": { "engaged": true, "at": "<iso>", "source": "cli" }
 *   }
 *
 * Consent is tied to the grant: a Steward whose grant id or version changed
 * needs a new approval. Only the person grants consent: through `vibe desk`
 * on the machine, which writes this file, or the agent's own authenticated
 * HTTP API. Nothing that arrives over the BotManor command channel can write
 * an approval; a request from an unapproved Steward only records itself as
 * pending, so the person can see who asked.
 *
 * The daemon and the CLI are separate processes. Every write re-reads the
 * file first and replaces it atomically (write to a temp file, then rename),
 * and readers cache by modification time.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const CONSENT_FILE = "desk-consent.json";

export interface StewardRef {
  id: string;
  name: string;
  grantId: string;
  grantVersion: string;
  /** Apps the Steward asks to use; the person may approve fewer. */
  apps: string[];
}

export interface Approval {
  name: string;
  grantId: string;
  grantVersion: string;
  /** Lower-cased app names or platform ids the Steward may act in. */
  apps: string[];
  approvedAt: string;
}

export interface PendingRequest {
  name: string;
  grantId: string;
  grantVersion: string;
  apps: string[];
  requestedAt: string;
}

export interface KillSwitchState {
  engaged: true;
  at: string;
  source: string;
}

export interface ConsentState {
  version: 1;
  stewards: Record<string, Approval>;
  pending: Record<string, PendingRequest>;
  killSwitch?: KillSwitchState;
}

export type ConsentVerdict =
  | { ok: true; approval: Approval }
  | { ok: false; reason: "NOT_APPROVED" | "GRANT_CHANGED" };

const MAX_PENDING = 32;
const MAX_APPS = 64;
const MAX_FIELD = 256;

const empty = (): ConsentState => ({ version: 1, stewards: {}, pending: {} });

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isText = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_FIELD;

/** Lower-cased, trimmed, deduplicated, bounded. */
export function normalizeApps(apps: readonly string[]): string[] {
  const out = new Set<string>();
  for (const app of apps) {
    const v = app.trim().toLowerCase();
    if (v && v.length <= MAX_FIELD) out.add(v);
    if (out.size >= MAX_APPS) break;
  }
  return [...out].sort();
}

function parseApps(v: unknown): string[] | null {
  if (!Array.isArray(v) || !v.every((a) => typeof a === "string")) return null;
  return normalizeApps(v);
}

function parseApproval(v: unknown): Approval | null {
  if (!isRecord(v)) return null;
  const apps = parseApps(v["apps"]);
  if (
    !isText(v["name"]) ||
    !isText(v["grantId"]) ||
    !isText(v["grantVersion"]) ||
    !isText(v["approvedAt"]) ||
    !apps
  ) {
    return null;
  }
  return {
    name: v["name"],
    grantId: v["grantId"],
    grantVersion: v["grantVersion"],
    apps,
    approvedAt: v["approvedAt"],
  };
}

function parsePending(v: unknown): PendingRequest | null {
  if (!isRecord(v)) return null;
  const apps = parseApps(v["apps"]);
  if (
    !isText(v["name"]) ||
    !isText(v["grantId"]) ||
    !isText(v["grantVersion"]) ||
    !isText(v["requestedAt"]) ||
    !apps
  ) {
    return null;
  }
  return {
    name: v["name"],
    grantId: v["grantId"],
    grantVersion: v["grantVersion"],
    apps,
    requestedAt: v["requestedAt"],
  };
}

/**
 * Parse the file. Entries that do not parse are dropped; a file that is not
 * a consent file at all reads as "nothing approved and the kill switch
 * engaged", so a damaged file fails closed.
 */
export function parseConsentState(text: string): ConsentState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  if (!isRecord(raw) || raw["version"] !== 1) {
    return {
      ...empty(),
      killSwitch: {
        engaged: true,
        at: new Date(0).toISOString(),
        source: "unreadable consent file",
      },
    };
  }
  const state = empty();
  if (isRecord(raw["stewards"])) {
    for (const [id, value] of Object.entries(raw["stewards"])) {
      const approval = parseApproval(value);
      if (approval && isText(id)) state.stewards[id] = approval;
    }
  }
  if (isRecord(raw["pending"])) {
    for (const [id, value] of Object.entries(raw["pending"])) {
      const pending = parsePending(value);
      if (pending && isText(id)) state.pending[id] = pending;
    }
  }
  const kill = raw["killSwitch"];
  if (isRecord(kill) && kill["engaged"] === true) {
    state.killSwitch = {
      engaged: true,
      at: isText(kill["at"]) ? kill["at"] : new Date(0).toISOString(),
      source: isText(kill["source"]) ? kill["source"] : "unknown",
    };
  }
  return state;
}

export class ConsentStore {
  readonly path: string;
  private cache: { mtimeMs: number; size: number; state: ConsentState } | null =
    null;

  constructor(
    dataDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.path = join(dataDir, CONSENT_FILE);
  }

  /** The current decisions. Cheap: re-reads only when the file changed. */
  read(): ConsentState {
    if (!existsSync(this.path)) {
      this.cache = null;
      return empty();
    }
    const stat = statSync(this.path);
    if (
      this.cache &&
      this.cache.mtimeMs === stat.mtimeMs &&
      this.cache.size === stat.size
    ) {
      return this.cache.state;
    }
    const state = parseConsentState(readFileSync(this.path, "utf8"));
    this.cache = { mtimeMs: stat.mtimeMs, size: stat.size, state };
    return state;
  }

  private update(change: (state: ConsentState) => void): ConsentState {
    // Re-read from disk, not the cache: the other process may have written.
    this.cache = null;
    const state = structuredClone(this.read());
    change(state);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
    this.cache = null;
    return state;
  }

  /** Is this Steward approved for its current grant? */
  check(
    steward: Pick<StewardRef, "id" | "grantId" | "grantVersion">,
  ): ConsentVerdict {
    const approval = this.read().stewards[steward.id];
    if (!approval) return { ok: false, reason: "NOT_APPROVED" };
    if (
      approval.grantId !== steward.grantId ||
      approval.grantVersion !== steward.grantVersion
    ) {
      return { ok: false, reason: "GRANT_CHANGED" };
    }
    return { ok: true, approval };
  }

  /**
   * Record that an unapproved Steward asked. Written only when something
   * changed, so a Steward retrying does not rewrite the file every time.
   * Returns true when the request is new.
   */
  recordPending(steward: StewardRef): boolean {
    const current = this.read().pending[steward.id];
    const apps = normalizeApps(steward.apps);
    if (
      current &&
      current.grantId === steward.grantId &&
      current.grantVersion === steward.grantVersion &&
      current.name === steward.name &&
      current.apps.join("\n") === apps.join("\n")
    ) {
      return false;
    }
    this.update((state) => {
      state.pending[steward.id] = {
        name: steward.name,
        grantId: steward.grantId,
        grantVersion: steward.grantVersion,
        apps,
        requestedAt: this.now().toISOString(),
      };
      const ids = Object.keys(state.pending);
      // Oldest requests go first when a misbehaving server floods the list.
      ids
        .sort((a, b) =>
          state.pending[a]!.requestedAt.localeCompare(
            state.pending[b]!.requestedAt,
          ),
        )
        .slice(0, Math.max(0, ids.length - MAX_PENDING))
        .forEach((id) => delete state.pending[id]);
    });
    return true;
  }

  /**
   * The person approves the Steward's pending request (its grant as it was
   * requested), for `apps` (default: the apps it asked for).
   */
  approve(stewardId: string, apps?: readonly string[]): Approval {
    const pending = this.read().pending[stewardId];
    if (!pending) {
      throw new ConsentError(
        `no pending request from Steward '${stewardId}'; it must ask first`,
      );
    }
    const approval: Approval = {
      name: pending.name,
      grantId: pending.grantId,
      grantVersion: pending.grantVersion,
      apps: normalizeApps(apps ?? pending.apps),
      approvedAt: this.now().toISOString(),
    };
    this.update((state) => {
      state.stewards[stewardId] = approval;
      delete state.pending[stewardId];
    });
    return approval;
  }

  /** Withdraw a Steward's consent (and drop its pending request). */
  revoke(stewardId: string): boolean {
    const state = this.read();
    if (!state.stewards[stewardId] && !state.pending[stewardId]) return false;
    this.update((s) => {
      delete s.stewards[stewardId];
      delete s.pending[stewardId];
    });
    return true;
  }

  /**
   * Press the kill switch. Every approval is withdrawn as well: after a kill,
   * each Steward needs a fresh approval.
   */
  engageKillSwitch(source: string): void {
    this.update((state) => {
      state.killSwitch = {
        engaged: true,
        at: this.now().toISOString(),
        source,
      };
      state.stewards = {};
    });
  }

  releaseKillSwitch(): void {
    this.update((state) => {
      delete state.killSwitch;
    });
  }
}

export class ConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsentError";
  }
}
