import { describe, expect, test } from "bun:test";
import { ApprovalGate, type ApprovalDecision, type ApprovalRequest } from "../src/approvals.ts";

function recordingSurface(decision: ApprovalDecision | Error) {
  const calls: ApprovalRequest[] = [];
  const surface = async (request: ApprovalRequest): Promise<ApprovalDecision> => {
    calls.push(request);
    if (decision instanceof Error) throw decision;
    return decision;
  };
  return { calls, surface };
}

function deferredSurface() {
  const calls: ApprovalRequest[] = [];
  const { promise, resolve, reject } = Promise.withResolvers<ApprovalDecision>();
  const surface = (request: ApprovalRequest): Promise<ApprovalDecision> => {
    calls.push(request);
    return promise;
  };
  return { calls, surface, resolve, reject };
}

const NEVER = () => new Promise<void>(() => {});

describe("ApprovalGate", () => {
  test("read-only tools pass without asking any surface", async () => {
    const telegram = recordingSurface("approve");
    const gate = new ApprovalGate();
    expect(await gate.decide({ toolName: "read", args: { path: "a.ts" } }, [telegram.surface])).toBeUndefined();
    expect(telegram.calls).toHaveLength(0);
  });

  test("approve lets the call through, deny blocks with the summary in the reason", async () => {
    const approving = new ApprovalGate();
    expect(await approving.decide({ toolName: "bash", args: { command: "bun test" } }, [recordingSurface("approve").surface])).toBeUndefined();

    const denying = new ApprovalGate();
    const verdict = await denying.decide({ toolName: "bash", args: { command: "rm -rf build" } }, [recordingSurface("deny").surface]);
    expect(verdict?.block).toBe(true);
    expect(verdict?.reason).toContain("rm -rf build");
  });

  test("always allow remembers the tool for the rest of the session", async () => {
    const telegram = recordingSurface("always");
    const gate = new ApprovalGate();
    await gate.decide({ toolName: "bash", args: { command: "bun test" } }, [telegram.surface]);
    await gate.decide({ toolName: "bash", args: { command: "bun build" } }, [telegram.surface]);
    expect(telegram.calls).toHaveLength(1);
  });

  test("an erroring surface falls through to the next one, invoked exactly once", async () => {
    const broken = recordingSurface(new Error("telegram down"));
    const tui = deferredSurface();
    const gate = new ApprovalGate(120_000, NEVER);

    const pending = gate.decide({ toolName: "bash", args: { command: "bun test" } }, [broken.surface, tui.surface]);
    tui.resolve("approve");
    expect(await pending).toBeUndefined();
    expect(broken.calls).toHaveLength(1);
    expect(tui.calls).toHaveLength(1);
  });

  test("all surfaces erroring defers to the built-in gate", async () => {
    const gate = new ApprovalGate(120_000, NEVER);
    const verdict = await gate.decide({ toolName: "bash", args: { command: "bun test" } }, [
      recordingSurface(new Error("a")).surface,
      recordingSurface(new Error("b")).surface,
    ]);
    expect(verdict).toBeUndefined();
  });

  test("no surfaces means no gate", async () => {
    const gate = new ApprovalGate();
    expect(await gate.decide({ toolName: "bash", args: { command: "bun test" } }, [undefined])).toBeUndefined();
  });

  test("timeout denies (fail-closed)", async () => {
    const telegram = deferredSurface();
    const instantTimeout = async () => {};
    const gate = new ApprovalGate(120_000, instantTimeout);
    const verdict = await gate.decide({ toolName: "bash", args: { command: "bun test" } }, [telegram.surface]);
    expect(verdict?.block).toBe(true);
    expect(verdict?.reason).toContain("timed out");
  });

  test("first answer wins when both surfaces answer", async () => {
    const telegram = deferredSurface();
    const tui = deferredSurface();
    const gate = new ApprovalGate(120_000, NEVER);

    const pending = gate.decide({ toolName: "bash", args: { command: "bun test" } }, [telegram.surface, tui.surface]);
    telegram.resolve("deny");
    const verdict = await pending;
    tui.resolve("approve"); // late answer must be ignorable without dangling

    expect(verdict?.block).toBe(true);
    expect(verdict?.reason).toContain("Denied");
  });
});
