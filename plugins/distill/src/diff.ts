/**
 * What a lesson will do to the project, as a diff.
 *
 * No diff algorithm lives here, because none is needed: every write this plugin makes is a `create`
 * or an `append` (writer.ts), never a replace or an in-place insert. So a change is entirely added
 * lines, plus the file's own tail as context and its real line numbers — which is exactly the part
 * of a diff an operator reads before approving.
 *
 * The host has a diff colorizer, but it sits behind `@oh-my-pi/pi-tui/chrome`, a package subpath a
 * compiled host does not serve — the same wall ADR-0011 recorded, and why `thinking.ts` and
 * `skill-rules.ts` are local mirrors. This mirrors the look instead: `+` in success, context dim,
 * one number column, the file path on its own line.
 */

import * as path from "node:path";
import type { DistillPaths } from "./config";
import type { PlannedWrite } from "./writer";

/** Context lines shown around an append, as git does. */
export const DEFAULT_CONTEXT_LINES = 3;
/** Lines one change shows in the detail pane; the changeset view shows them all. */
export const DEFAULT_DIFF_LINES = 40;

export interface ChangeLine {
  kind: "added" | "context";
  /** The file's own line number: existing lines keep theirs, added ones continue from it. */
  number: number;
  text: string;
}

export interface FileChange {
  /** Project-relative, so the review reads like the project does. */
  path: string;
  mode: PlannedWrite["mode"];
  lines: ChangeLine[];
  added: number;
  context: number;
}

export interface ChangeTheme {
  added(text: string): string;
  context(text: string): string;
  meta(text: string): string;
}

/** One lesson's writes, each read against the file as it is on disk right now. */
export async function planFileChanges(
  paths: DistillPaths,
  writes: readonly PlannedWrite[],
  options: { contextLines?: number } = {},
): Promise<FileChange[]> {
  const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;
  const changes: FileChange[] = [];

  for (const write of writes) {
    const absolute = path.isAbsolute(write.path) ? write.path : path.join(paths.projectRoot, write.path);
    const added = splitLines(write.text);
    const lines: ChangeLine[] = [];

    let existing: string[] = [];
    if (write.mode === "append") {
      const text = await Bun.file(absolute)
        .text()
        .catch(() => "");
      existing = splitLines(text);
      const tail = existing.slice(Math.max(0, existing.length - contextLines));
      const first = existing.length - tail.length + 1;
      tail.forEach((line, index) => lines.push({ kind: "context", number: first + index, text: line }));
    }

    const start = existing.length + 1;
    added.forEach((line, index) => lines.push({ kind: "added", number: start + index, text: line }));

    changes.push({
      path: path.relative(paths.projectRoot, absolute),
      mode: write.mode,
      lines,
      added: added.length,
      context: existing.length === 0 ? 0 : lines.length - added.length,
    });
  }

  return changes;
}

/** The heading above a change: the path, and what is being done to it. */
export function describeChange(change: FileChange): string {
  const verb = change.mode === "create" ? "new file" : "append";
  return `${verb}  ${change.path}  (+${change.added}${change.context === 0 ? "" : `, ${change.context} context`})`;
}

/**
 * A change as diff rows. `maxLines` caps it for a pane that shares the screen; the changeset view
 * passes nothing and reads the whole thing.
 */
export function renderFileChange(
  change: FileChange,
  theme: ChangeTheme,
  width: number,
  options: { maxLines?: number } = {},
): string[] {
  const maxLines = options.maxLines ?? DEFAULT_DIFF_LINES;
  const lines: string[] = [theme.meta(describeChange(change))];
  const shown = change.lines.slice(0, maxLines);

  const numbers = shown.map(line => String(line.number)).reduce((widest, value) => Math.max(widest, value.length), 1);
  for (const line of shown) {
    const number = String(line.number).padStart(numbers, " ");
    const gutter = line.kind === "added" ? "+" : " ";
    const text = `${number} ${gutter} ${line.text}`;
    const clipped = trimTo(text, width);
    lines.push(line.kind === "added" ? theme.added(clipped) : theme.context(clipped));
  }

  const hidden = change.lines.length - shown.length;
  if (hidden > 0) lines.push(theme.meta(`… ${hidden} more line(s)`));
  return lines;
}

/**
 * A trailing newline is a line terminator, not an empty line nobody can see — and no text at all is
 * no lines, not one empty one.
 */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function trimTo(text: string, width: number): string {
  if (text.length <= width) return text;
  return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
}
