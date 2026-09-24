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
