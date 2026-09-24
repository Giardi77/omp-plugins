import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { notify, runDistillCommand } from "./commands";
import { distillPaths, readConfig, resolveProjectRoot } from "./config";
import { listLessons } from "./lessons";
import { messageOf } from "./util";

/**
 * The extension entry: one command and one notice. Nothing runs on a timer, at session end,
 * or from any other event — a scan is only ever the operator's explicit act (D7).
 */

const SUBCOMMANDS = ["setup", "enable", "disable", "status", "scan", "review", "purge"];

const FLAGS_BY_SUBCOMMAND: Record<string, string[]> = {
  setup: ["--model", "--thinking", "--yes"],
  scan: ["--limit", "--session", "--dry-run"],
  purge: ["--yes"],
};

export default function distillExtension(pi: ExtensionAPI): void {
  pi.setLabel("Distill");

  pi.registerCommand("distill", {
    description:
      "Session learning for this project: setup, enable/disable, status, scan, review, purge",
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
  });

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
