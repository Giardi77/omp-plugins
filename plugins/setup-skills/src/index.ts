import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { loadSkills, setActiveSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { loadProjectSkillsState, writeProjectSkillsSelection } from "./project-skills";
import { runProjectSkillsSelector } from "./selector";

type SkillRefreshableCommandContext = ExtensionCommandContext & {
  refreshSkills?: () => Promise<void>;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function filterDisabledSkillsFromSystemPrompt(
  systemPrompt: readonly string[],
  disabledSkillNames: ReadonlySet<string>,
): string[] {
  if (disabledSkillNames.size === 0) return [...systemPrompt];

  return systemPrompt.map(fragment =>
    fragment.replace(/<skills>([\s\S]*?)<\/skills>/g, (_block, body: string) => {
      let filtered = body;
      for (const name of disabledSkillNames) {
        const escapedName = escapeRegExp(name);
        filtered = filtered.replace(
          new RegExp(`<skill\\s+name=(["'])${escapedName}\\1[^>]*>[\\s\\S]*?<\\/skill>\\s*`, "g"),
          "",
        );
        filtered = filtered.replace(new RegExp(`^\\s*-\\s+${escapedName}:.*(?:\\r?\\n|$)`, "gm"), "");
      }
      return filtered.trim() === "" ? "" : `<skills>${filtered}</skills>`;
    }),
  );
}

function formatSavedSummary(configPath: string, enabledCount: number, totalCount: number): string {
  const disabledCount = Math.max(0, totalCount - enabledCount);
  return `Updated ${configPath} (${enabledCount} enabled, ${disabledCount} disabled). Reloading skills when the agent is idle...`;
}

export function isSessionWriteConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Session file changed before rewrite") || message.includes("SessionWriteConflictError");
}

export function hasRefreshSkills(
  ctx: ExtensionCommandContext,
): ctx is SkillRefreshableCommandContext & { refreshSkills: () => Promise<void> } {
  return typeof (ctx as SkillRefreshableCommandContext).refreshSkills === "function";
}

export async function reloadSessionAfterIdle(
  ctx: Pick<ExtensionCommandContext, "reload" | "waitForIdle">,
  attempts = 3,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await ctx.waitForIdle();
    try {
      await ctx.reload();
      return;
    } catch (error) {
      lastError = error;
      if (!isSessionWriteConflict(error) || attempt === attempts - 1) {
        throw error;
      }
    }
  }
  throw lastError;
}

export default function setupSkillsExtension(pi: ExtensionAPI): void {
  pi.setLabel("Setup Skills");
  let disabledSkillNames = new Set<string>();

  pi.on("before_agent_start", async event => {
    if (disabledSkillNames.size === 0) return;
    return {
      systemPrompt: filterDisabledSkillsFromSystemPrompt(event.systemPrompt, disabledSkillNames),
    };
  });


  pi.registerCommand("setup-skills", {
    description: "Select enabled skills for this project and reload the session",
    // The autocomplete glyph: 🧰, as soon as OMP forwards an extension's own `icon` (see the type
    // above). Until then the command shows the shared extension glyph, which is the host's choice.
    icon: "🧰",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/setup-skills requires the interactive OMP UI.", "error");
        return;
      }

      let state;
      try {
        state = await loadProjectSkillsState(ctx.cwd);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "error");
        return;
      }

      const selectedNames = await runProjectSkillsSelector(ctx, state);
      if (selectedNames === null) {
        ctx.ui.notify("Project skills unchanged.", "info");
        return;
      }

      let nextSkills;
      try {
        nextSkills = await writeProjectSkillsSelection(state, selectedNames);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "error");
        return;
      }

      disabledSkillNames = new Set(state.rows.filter(row => !selectedNames.has(row.name)).map(row => row.name));

      ctx.ui.notify(formatSavedSummary(state.configPath, selectedNames.size, state.rows.length), "info");

      try {
        if (hasRefreshSkills(ctx)) {
          await ctx.waitForIdle();
          await ctx.refreshSkills();
          return;
        }

        const refreshed = await loadSkills({
          ...nextSkills,
          cwd: state.projectRoot,
        });
        setActiveSkills(refreshed.skills);
        await reloadSessionAfterIdle(ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isSessionWriteConflict(error)) {
          ctx.ui.notify(
            `Skills config saved, but OMP could not rewrite the session file. Restart OMP to apply skill commands. ${message}`,
            "warning",
          );
          return;
        }
        ctx.ui.notify(message, "error");
      }
    },
  } as CommandOptions);
}
