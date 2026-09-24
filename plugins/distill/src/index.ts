import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { notify, runDistillCommand } from "./commands";
import { distillPaths, readConfig, resolveProjectRoot } from "./config";
import { listLessons } from "./lessons";
import { messageOf } from "./util";

/**
 * The extension entry: one command and one notice. Nothing runs on a timer, at session end,
 * or from any other event — a scan is only ever the operator's explicit act (D7).
 */

// `_job` is deliberately absent: it is the daemon's entry point, not something to type.
const SUBCOMMANDS = ["setup", "enable", "disable", "status", "scan", "cancel", "review", "purge"];

const FLAGS_BY_SUBCOMMAND: Record<string, string[]> = {
  setup: ["--model", "--thinking", "--yes"],
  scan: ["--limit", "--session", "--dry-run"],
  purge: ["--yes"],
};

/**
 * `registerCommand`'s options as the host actually reads them. The SDK's type has no `icon`; the
 * host's own commands carry one, and OMP 18.3.0 pins every extension command to its shared
 * `extension` glyph (🧩) instead of reading this field, so the value below is the intent, not
 * something on screen yet.
 *
 * It is the glyph itself rather than a name in pi-tui's vocabulary: the change this waits on makes
 * an unknown value a literal, which generalises to any plugin without touching the symbol maps.
 * A name would only resolve where the maps define it — and where they do not, the lookup throws.
 */
type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1] & { icon: string };

export default function distillExtension(pi: ExtensionAPI): void {
  pi.setLabel("Distill");

  pi.registerCommand("distill", {
    description:
      "Session learning for this project: setup, enable/disable, status, scan, cancel, review, purge",
    // The autocomplete glyph: 💧, as soon as OMP forwards an extension's own `icon` (see the type
    // above). Until then the command shows the shared extension glyph, which is the host's choice.
    icon: "💧",
    getArgumentCompletions(argumentPrefix: string) {
      const trimmed = argumentPrefix.trimStart();
      if (trimmed.includes(" ")) {
        const [subcommand, ...rest] = trimmed.split(/\s+/);
        if (rest.length > 1 || !subcommand) return null;
        const flags = (FLAGS_BY_SUBCOMMAND[subcommand] ?? []).filter(flag => flag.startsWith(rest[0] ?? ""));
        return flags.length > 0 ? flags.map(flag => ({ label: flag, value: flag })) : null;
      }
      const matches = SUBCOMMANDS.filter(name => name.startsWith(trimmed));
      return matches.length === 0 ? null : matches.map(name => ({ label: name, value: name }));
    },
    handler: async (args, ctx) => {
      try {
        await runDistillCommand(pi, args, ctx);
      } catch (error) {
        notify(ctx, `distill failed: ${messageOf(error)}`, "error");
      }
    },
  } as CommandOptions);

  pi.on("session_start", async (_event, ctx) => {
    // One notice per session, and only where a notification actually surfaces: print and
    // json sessions have no UI, and subagent sessions have no operator to inform.
    if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
    try {
      const paths = distillPaths(await resolveProjectRoot(ctx.cwd));
      const config = await readConfig(paths);
      if (!config?.enabled) return;

      const proposed = await listLessons(paths, "proposed");
      if (proposed.length === 0) return;
      ctx.ui.notify(
        `${proposed.length} proposed lesson(s) await review — /distill review`,
        "info",
      );
    } catch {
      // A reminder is never worth failing a session start for.
    }
  });
}
