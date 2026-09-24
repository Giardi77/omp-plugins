import { describe, expect, test } from "bun:test";
import { runJq } from "../src/jq";

const records = [
  { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "edit" }, { type: "toolCall", name: "read" }] } },
  { type: "message", message: { role: "toolResult", toolName: "edit", isError: true, content: [{ type: "text", text: "blocked" }] } },
];

describe("jq for the evaluator", () => {
  test("answers an exact question about the records", async () => {
    if (!Bun.which("jq")) return;
    const result = await runJq('.message.content[]? | select(.type=="toolCall") | .name', records);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toContain('"edit"');
    expect(result.output).toContain('"read"');
    expect(result.truncated).toBe(false);
  });

  test("a filter that asks for everything is capped, not obeyed", async () => {
    if (!Bun.which("jq")) return;
    const result = await runJq("range(0; 100000000)", records, { maxChars: 500 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
    expect(result.output.length).toBeLessThan(700);
    expect(result.output).toContain("output capped");
  });

  test("a broken filter comes back as a message, not a crash", async () => {
    if (!Bun.which("jq")) return;
    const result = await runJq("select(", records);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toStartWith("jq:");
  });

  test("an unusable jq is reported rather than thrown", async () => {
    const result = await runJq(".", records, { jqPath: "/nonexistent/jq" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("could not run jq");
  });

  test("a filter that is still computing dies with the evaluation", async () => {
    if (!Bun.which("jq")) return;
    const controller = new AbortController();
    // Building twenty million numbers keeps jq busy for seconds and prints nothing until it is
    // done, so the abort is the only thing that can end this run. `runJq` attaches its abort
    // listener before its first await, so aborting here lands after the spawn, not before it.
    const pending = runJq("[range(0; 20000000)] | length", records, { signal: controller.signal, timeoutMs: 30_000 });
    controller.abort();
    const result = await pending;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("cancelled");
  });

  test("a signal that is already aborted never starts jq", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runJq(".", records, { signal: controller.signal });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("cancelled");
  });
});
