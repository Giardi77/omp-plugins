/**
 * `jq` for the evaluator's exact extractions ("every tool call to *edit*", "every error result"),
 * run by the plugin rather than by a shell: the filter is one argv element, the input is the
 * trace's own records as NDJSON, and the module search path is empty so `include`/`import` cannot
 * reach the filesystem. Output is capped and the process is killed on timeout, so a filter that
 * asks for everything gets a bounded answer instead of the session's sixteen megabytes.
 */

export interface JqOptions {
  timeoutMs?: number;
  maxChars?: number;
  /** Injectable for tests; defaults to the `jq` on PATH. */
  jqPath?: string;
}

export type JqResult =
  | { ok: true; output: string; truncated: boolean }
  | { ok: false; error: string };

export const JQ_DEFAULT_TIMEOUT_MS = 15_000;
export const JQ_DEFAULT_MAX_CHARS = 20_000;

export async function runJq(filter: string, records: readonly unknown[], options: JqOptions = {}): Promise<JqResult> {
  const jqPath = options.jqPath ?? Bun.which("jq");
  if (!jqPath) {
    return { ok: false, error: "jq is not installed on this machine; read the trace with a range or a pattern instead" };
  }

  const maxChars = options.maxChars ?? JQ_DEFAULT_MAX_CHARS;
  const timeoutMs = options.timeoutMs ?? JQ_DEFAULT_TIMEOUT_MS;
  const stdin = records.map(record => `${JSON.stringify(record)}\n`).join("");

  let process_: Bun.Subprocess<Blob, "pipe", "pipe">;
  try {
    // `-L` on a path that holds nothing: jq's own module loader is the only way a filter could
    // read a file, and this closes it.
    process_ = Bun.spawn([jqPath, "-c", "-L", "/nonexistent-jq-lib", filter], {
      stdin: new Blob([stdin]),
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: "/usr/bin:/bin" },
    });
  } catch (error) {
    return { ok: false, error: `could not run jq: ${error instanceof Error ? error.message : String(error)}` };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    process_.kill();
  }, timeoutMs);

  const chunks: string[] = [];
  let chars = 0;
  let truncated = false;
  const reader = process_.stdout.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (chars + text.length > maxChars) {
        chunks.push(text.slice(0, maxChars - chars));
        chars = maxChars;
        truncated = true;
        process_.kill();
        break;
      }
      chunks.push(text);
      chars += text.length;
    }
  } finally {
    clearTimeout(timer);
  }

  const stderr = (await new Response(process_.stderr).text()).trim();
  await process_.exited;

  if (timedOut) return { ok: false, error: `jq exceeded ${Math.round(timeoutMs / 1000)}s and was stopped` };
  if (stderr !== "" && chars === 0) return { ok: false, error: `jq: ${stderr.split("\n")[0]}` };

  const output = chunks.join("");
  return {
    ok: true,
    output: `${output}${truncated ? `\n… [output capped at ${maxChars} characters; narrow the filter]` : ""}`,
    truncated,
  };
}
