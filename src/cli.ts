/**
 * `vibe desk …`: the person at the machine controls the Stewards using it
 * (BOFF-16567). These commands run in the CLI process and act on the consent
 * file directly, so they work without the daemon's API key and only for
 * someone who can write this user's profile directory. The daemon notices
 * within {@link SAFETY_LIMITS.pollMs}.
 *
 *   vibe desk status                         who is in control, kill switch, approvals
 *   vibe desk consent list                   approved Stewards and pending requests
 *   vibe desk consent approve <steward> [--apps "Safari,Notes"]
 *   vibe desk consent revoke <steward>
 *   vibe desk kill                           stop every Steward now
 *   vibe desk resume                         release the kill switch
 */
import { ConsentError, type ConsentStore } from "./consent.js";
import { readSessionState, SAFETY_LIMITS } from "./safety.js";

/** The part of commander's `Command` these commands use. */
export interface CliCommand {
  command(nameAndArgs: string): CliCommand;
  description(text: string): CliCommand;
  option(flags: string, description?: string): CliCommand;
  action(fn: (...args: unknown[]) => void | Promise<void>): CliCommand;
}

export interface DeskCliIo {
  out(line: string): void;
  err(line: string): void;
  /** Sets the process exit code on failure. */
  fail(): void;
}

const consoleIo: DeskCliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  fail: () => {
    process.exitCode = 1;
  },
};

const appsList = (apps: readonly string[]) =>
  apps.length ? apps.join(", ") : "(none)";

export function deskStatusLines(
  store: ConsentStore,
  sessionFile: string,
): string[] {
  const state = store.read();
  const session = readSessionState(sessionFile);
  const lines = [
    session
      ? `Steward in control: ${session.stewardName} (${session.stewardId}) since ${session.since}`
      : "No Steward is in control of this machine.",
    state.killSwitch
      ? `Kill switch: ENGAGED (${state.killSwitch.source}, ${state.killSwitch.at}). Run 'vibe desk resume' to release it.`
      : "Kill switch: off. Run 'vibe desk kill' to stop every Steward at once.",
  ];
  const approved = Object.entries(state.stewards);
  lines.push(
    approved.length ? "Approved Stewards:" : "Approved Stewards: none",
  );
  for (const [id, a] of approved) {
    lines.push(
      `  ${a.name} (${id}) grant ${a.grantId}@${a.grantVersion}, apps: ${appsList(a.apps)}`,
    );
  }
  const pending = Object.entries(state.pending);
  if (pending.length) lines.push("Waiting for your approval:");
  for (const [id, p] of pending) {
    lines.push(
      `  ${p.name} (${id}) grant ${p.grantId}@${p.grantVersion}, asks for apps: ${appsList(p.apps)}`,
      `    approve: vibe desk consent approve ${id} --apps "${p.apps.join(",")}"`,
    );
  }
  return lines;
}

export function registerDeskCommands(
  program: CliCommand,
  store: ConsentStore,
  sessionFile: string,
  io: DeskCliIo = consoleIo,
): void {
  const run = (fn: () => void) => () => {
    try {
      fn();
    } catch (err) {
      io.err(
        err instanceof ConsentError ? err.message : `desk: ${String(err)}`,
      );
      io.fail();
    }
  };

  const desk = program
    .command("desk")
    .description("Control the BotManor Stewards that use this machine");

  desk
    .command("status")
    .description("Who is in control, the kill switch, and approved Stewards")
    .action(run(() => deskStatusLines(store, sessionFile).forEach(io.out)));

  desk
    .command("kill")
    .description("Stop every Steward now and withdraw every approval")
    .action(
      run(() => {
        store.engageKillSwitch("cli");
        io.out(
          `Kill switch engaged. Running actions stop within ${SAFETY_LIMITS.pollMs * 4} ms; every Steward must be approved again.`,
        );
      }),
    );

  desk
    .command("resume")
    .description("Release the kill switch (Stewards still need a new approval)")
    .action(
      run(() => {
        store.releaseKillSwitch();
        io.out("Kill switch released.");
      }),
    );

  const consent = desk
    .command("consent")
    .description("Approve or withdraw Stewards on this machine");

  consent
    .command("list")
    .description("Approved Stewards and pending requests")
    .action(
      run(() => deskStatusLines(store, sessionFile).slice(2).forEach(io.out)),
    );

  consent
    .command("approve <stewardId>")
    .description(
      "Let a Steward that asked use this machine, under the grant it asked with",
    )
    .option(
      "--apps <apps>",
      "Comma-separated apps it may act in (default: the apps it asked for)",
    )
    .action((...args: unknown[]) =>
      run(() => {
        const [stewardId, opts] = args;
        const raw =
          typeof opts === "object" && opts !== null && "apps" in opts
            ? opts.apps
            : undefined;
        const apps = typeof raw === "string" ? raw.split(",") : undefined;
        const approval = store.approve(String(stewardId), apps);
        io.out(
          `Approved ${approval.name} (grant ${approval.grantId}@${approval.grantVersion}) for apps: ${appsList(approval.apps)}`,
        );
      })(),
    );

  consent
    .command("revoke <stewardId>")
    .description("Withdraw a Steward's approval; its session ends at once")
    .action((...args: unknown[]) =>
      run(() => {
        const id = String(args[0]);
        io.out(
          store.revoke(id)
            ? `Withdrew the approval of ${id}.`
            : `${id} was neither approved nor waiting.`,
        );
      })(),
    );
}
