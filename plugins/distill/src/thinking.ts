/**
 * The `--thinking` selectors distill offers and validates, mirrored from the host's
 * `@oh-my-pi/pi-tui/thinking` (omp 18.3.0).
 *
 * That subpath cannot be imported from an extension in a compiled host, and neither the SDK root
 * nor `pi.pi` re-exports the selectors (ADR-0011). The vocabulary is small and stable; the host
 * still clamps whatever it is handed, and an unknown value is refused here rather than silently
 * falling back to the model default. `test/thinking.test.ts` pins the parsing.
 */

/** Thinking selectors accepted by `--thinking`, in display order. Mirrors the host's list. */
export const CLI_THINKING_LEVELS: readonly string[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "auto",
];

/**
 * The levels a resolved model can actually honor, in the host's order: `off`, the model's own effort
 * ladder, then `auto`.
 *
 * The ladder is the host's, read the way its own pickers read it — `model.reasoning` gating
 * `model.thinking.efforts`, which is all `@oh-my-pi/pi-catalog/model-thinking`'s `getSupportedEfforts`
 * does (18.3.0) and what the host's `defaultThinkingLevel` row spreads behind `auto`. So a
 * `deepseek-v4-flash` that exposes `low|high|max` on one provider and `high|xhigh` on another offers
 * exactly that, because `ctx.models.resolve` hands back the entry for the provider that will run the
 * evaluation.
 *
 * `off` is not an effort the model lists: it is distill's "no thinking for the evaluator", and
 * `auto` is the host's per-turn classifier — both valid for any model, which is why a model with no
 * effort surface still offers `off` and `auto` rather than an empty list. A model the registry
 * cannot resolve falls back to the full vocabulary the CLI accepts: the host clamps whatever it is
 * handed, so offering everything is honest when there is nothing to narrow against.
 */
export function supportedThinkingLevels(
  model: ThinkingCapableModel | undefined,
): readonly string[] {
  if (model === undefined) return CLI_THINKING_LEVELS;
  const efforts = model.reasoning ? (model.thinking?.efforts ?? []) : [];
  return ["off", ...efforts, "auto"];
}

/**
 * What {@link supportedThinkingLevels} reads: the fields the host's catalog sets on a model. Kept
 * structural so the plugin depends on the shape it reads rather than on pi-ai's type surface.
 */
export interface ThinkingCapableModel {
  readonly reasoning?: boolean;
  readonly thinking?: { readonly efforts?: readonly string[] } | undefined;
}

/**
 * Parses a `--thinking` value the way the host's CLI does, abbreviations included (`xhi` → `xhigh`,
 * `min` → `minimal`). A value that is unknown or ambiguous resolves to `undefined`; single
 * characters are never guessed. `inherit` is not a CLI selector.
 */
export function parseCliThinkingLevel(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (CLI_THINKING_LEVELS.includes(value)) return value;
  if (value.length < 2) return undefined;
  const matches = CLI_THINKING_LEVELS.filter(level => level.startsWith(value));
  return matches.length === 1 ? matches[0] : undefined;
}
