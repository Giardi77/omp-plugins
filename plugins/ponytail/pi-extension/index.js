import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  DEFAULT_MODE,
  RUNTIME_MODES,
  getDefaultMode,
  getQuietStartup,
  getHideStatus,
  normalizeMode,
  normalizePersistedMode,
  isDeactivationCommand,
  writeDefaultMode,
} = require("../hooks/ponytail-config.cjs");
const { getPonytailInstructions, filterSkillBodyForMode } = require("../hooks/ponytail-instructions.cjs");

export { filterSkillBodyForMode };
export const readDefaultMode = getDefaultMode;
export const readQuietStartup = getQuietStartup;

const RUNTIME_MODE_LIST = RUNTIME_MODES.join("|");
const PONYTAIL_COMMAND_DESCRIPTION = `Set mode: ${RUNTIME_MODE_LIST}. Commands: status, default <mode>`;

export function resolveSessionMode(entries, fallbackMode = DEFAULT_MODE) {
  const fallback = normalizePersistedMode(fallbackMode) || DEFAULT_MODE;
  if (!Array.isArray(entries)) return fallback;

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "custom" || entry?.customType !== "ponytail-mode") continue;

    const mode = normalizePersistedMode(entry?.data?.mode);
    if (mode) return mode;
  }

  return fallback;
}

export function parsePonytailCommand(text, defaultMode = DEFAULT_MODE) {
  const fallback = normalizePersistedMode(defaultMode) || DEFAULT_MODE;
  const normalizedText = String(text || "").trim().toLowerCase();

  if (!normalizedText) {
    return { type: "set-mode", mode: fallback === "off" ? "full" : fallback };
  }

  const [primary, secondary] = normalizedText.split(/\s+/);

  if (primary === "status") return { type: "status" };

  if (primary === "default") {
    // ponytail: a default must be a runtime level; review is session-only (#377).
    const mode = normalizeMode(secondary);
    return mode ? { type: "set-default", mode } : { type: "invalid", reason: "invalid-default-mode" };
  }

  const mode = normalizeMode(primary);
  return mode ? { type: "set-mode", mode } : { type: "invalid", reason: "invalid-mode", mode: primary };
}

export { writeDefaultMode };

/**
 * Whether the bar renders segments from the preset tables we can splice into.
 * A `custom` preset skips them entirely and reads `statusLine.leftSegments`
 * from settings instead — a list we cannot extend, because the setting's items
 * are validated against the host's segment catalog (no `ponytail` id).
 *
 * Reads the config layers only: the extension API has no effective-value
 * getter, so a `--config` overlay or a runtime override naming `custom` is
 * missed. Worst case is a duplicate indicator, never a crash.
 * ponytail: layer read, use the effective-value API if omp ever exposes one.
 */
function usesPresetSegments(settings) {
  try {
    const preset =
      settings?.getProjectSettings?.()?.statusLine?.preset ?? settings?.getGlobalSettings?.()?.statusLine?.preset;
    return preset !== "custom";
  } catch {
    return true;
  }
}

export default function ponytailExtension(pi) {
  let currentMode = DEFAULT_MODE;
  let configuredDefaultMode = getDefaultMode();
  let hideStatus = getHideStatus();
  let isActive = false;
  let lastCtx = null;

  // -- Status line --
  // "🐴 <mode>" — accent while the agent runs, muted when idle. null hides.
  function ponytailStatus(themeOf) {
    if (currentMode === "off" || hideStatus) return null;
    const plain = "🐴 " + currentMode;
    try {
      const theme = themeOf?.();
      return theme?.fg ? "🐴 " + theme.fg(isActive ? "accent" : "muted", currentMode) : plain;
    } catch {
      return plain; // theme proxy can throw before initTheme
    }
  }

  // Register a real segment in the host's status-line registry — pi.pi is the
  // host's own module namespace, so this is the object the bar renders from —
  // and ride the built-in presets, so no user config is needed. The ascii preset
  // stays emoji-free. Preset hosts get the chip inline; hosts without the seam
  // fall back to the hook line under the composer (omp >= 18 renders hook
  // statuses as extra footer lines).
  // ponytail: unofficial seam — omp has no extension-segment API as of 18.3.1;
  // SEGMENTS/presets are root exports, so this breaks if omp stops exporting
  // them. Both are feature-tested and the hook line covers the gap. Replace
  // when an official API ships.
  const hostSegments = pi.pi?.SEGMENTS;
  const hostPresets = pi.pi?.STATUS_LINE_PRESETS;
  const hasStatusLine = Boolean(hostSegments && hostPresets);
  const inlineStatus = hasStatusLine && usesPresetSegments(pi.pi?.settings);

  if (hasStatusLine) {
    if (!hostSegments.ponytail) {
      hostSegments.ponytail = {
        id: "ponytail",
        render: () => {
          const text = ponytailStatus(() => pi.pi?.theme);
          return { content: text ?? "", visible: text !== null };
        },
      };
    }
    for (const [name, preset] of Object.entries(hostPresets)) {
      if (name === "ascii" || !Array.isArray(preset?.leftSegments) || preset.leftSegments.includes("ponytail")) continue;
      const after = preset.leftSegments.indexOf("mode");
      preset.leftSegments.splice(after === -1 ? preset.leftSegments.length : after + 1, 0, "ponytail");
    }
  }

  function syncStatus(ctx) {
    if (ctx) lastCtx = ctx;
    const c = ctx || lastCtx;
    if (!c?.ui?.setStatus) return;
    // Segment hosts render lazily from the registry above; this only nudges a
    // repaint and clears any legacy hook line. Hosts without the seam get a
    // hook line instead, so the mode is still visible.
    const text = inlineStatus ? undefined : ponytailStatus(() => c.ui?.theme);
    c.ui.setStatus("ponytail", text ?? undefined);
  }

  const setMode = (mode, ctx) => {
    const normalized = normalizePersistedMode(mode);
    if (!normalized) return;

    currentMode = normalized;
    pi.appendEntry("ponytail-mode", { mode: normalized });
    syncStatus(ctx);
    ctx?.ui?.notify?.(`Ponytail mode set to ${normalized}.`, "info");
  };

  const sendAlias = (skillName, args, ctx) => {
    const normalized = String(args || "").trim();
    const message = normalized ? `${skillName} ${normalized}` : skillName;

    if (ctx?.isIdle?.() === false) {
      pi.sendUserMessage(message, { deliverAs: "followUp" });
      ctx?.ui?.notify?.(`${skillName} queued as follow-up.`, "info");
      return;
    }

    pi.sendUserMessage(message);
  };

  pi.registerCommand("ponytail", {
    description: PONYTAIL_COMMAND_DESCRIPTION,
    handler: async (args, ctx) => {
      const parsed = parsePonytailCommand(args, configuredDefaultMode);

      if (parsed.type === "status") {
        ctx?.ui?.notify?.(`Ponytail: current ${currentMode} • default ${configuredDefaultMode}`, "info");
        return;
      }

      if (parsed.type === "set-default") {
        try {
          const written = writeDefaultMode(parsed.mode);
          if (written) {
            configuredDefaultMode = getDefaultMode();
            const message = configuredDefaultMode === written
              ? `Default Ponytail mode set to ${written}.`
              : `Saved default ${written}, but env override keeps default at ${configuredDefaultMode}.`;
            ctx?.ui?.notify?.(message, "info");
          }
        } catch (e) {
          ctx?.ui?.notify?.(`Failed to save default mode: ${e.message}`, "error");
        }
        return;
      }

      if (parsed.type === "set-mode") {
        setMode(parsed.mode, ctx);
        return;
      }

      ctx?.ui?.notify?.("Unknown or unsupported /ponytail mode.", "warning");
    },
  });

  pi.registerCommand("ponytail-review", {
    description: "Run /skill:ponytail-review",
    handler: (_args, ctx) => sendAlias("/skill:ponytail-review", "", ctx),
  });

  pi.registerCommand("ponytail-audit", {
    description: "Run /skill:ponytail-audit",
    handler: (_args, ctx) => sendAlias("/skill:ponytail-audit", "", ctx),
  });

  pi.registerCommand("ponytail-gain", {
    description: "Run /skill:ponytail-gain",
    handler: (_args, ctx) => sendAlias("/skill:ponytail-gain", "", ctx),
  });

  pi.registerCommand("ponytail-debt", {
    description: "Run /skill:ponytail-debt",
    handler: (_args, ctx) => sendAlias("/skill:ponytail-debt", "", ctx),
  });

  pi.registerCommand("ponytail-help", {
    description: "Run /skill:ponytail-help",
    handler: (_args, ctx) => sendAlias("/skill:ponytail-help", "", ctx),
  });

  pi.on("input", async (event) => {
    if (event?.source === "extension") return;

    const text = String(event?.text || "");
    if (currentMode !== "off" && isDeactivationCommand(text)) {
      setMode("off");
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx?.sessionManager?.getBranch?.() || ctx?.sessionManager?.getEntries?.() || [];
    configuredDefaultMode = getDefaultMode();
    hideStatus = getHideStatus();
    currentMode = resolveSessionMode(entries, configuredDefaultMode);
    syncStatus(ctx);
    if (!getQuietStartup()) {
      ctx?.ui?.notify?.(`Ponytail loaded: ${currentMode}`, "info");
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    isActive = true;
    syncStatus(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    isActive = false;
    syncStatus(ctx);
  });

  pi.on("before_agent_start", async (event) => {
    if (!currentMode || currentMode === "off") return;
    // The host hands the prompt over as ordered parts and takes an opaque
    // replacement back, so append ours as another part. Never interpolate the
    // array into a template string: that comma-joins the parts and mangles the
    // prompt (and drops the structure). Missing event/parts still injects the
    // ruleset without the literal "undefined" (#439, #440).
    const parts = Array.isArray(event?.systemPrompt)
      ? event.systemPrompt
      : typeof event?.systemPrompt === "string" && event.systemPrompt
        ? [event.systemPrompt]
        : [];
    return { systemPrompt: [...parts, getPonytailInstructions(currentMode)] };
  });
}
