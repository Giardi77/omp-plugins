import { beforeAll, describe, expect, test } from "bun:test";
import { initThemeSync, visibleWidth } from "@oh-my-pi/pi-tui";
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { StoredLesson } from "../src/lessons";
import {
  ReviewWindow,
  runReview,
  type ReviewEntry,
  type ReviewHandlers,
  type ReviewOutcome,
  type ReviewTheme,
} from "../src/review";

/** `OverlayPanel` paints with the active theme; the window paints with the stub below. */
beforeAll(() => {
  initThemeSync();
});

const theme: ReviewTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const WIDTH = 90;
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ESC = "\x1b";
const ENTER = "\r";

const IDS = ["one", "two", "three"];

interface Pending {
  /** Hand a handler's promise to the window and remember it for `settled`. */
  track<T>(decision: Promise<T>): Promise<T>;
  /** Resolves once the tracked decisions — and the window's continuation for each — have run. */
  settled(): Promise<void>;
}

/**
 * The window applies a handler's result in the continuation of `await accept(...)`, so a test
 * that awaits the same promise resumes after the row is gone or the error is on screen. No
 * timers: the awaited signal is the decision the code took.
 */
function pendingDecisions(): Pending {
  let inFlight: Promise<unknown>[] = [];
  return {
    track: <T,>(decision: Promise<T>): Promise<T> => {
      inFlight.push(decision);
      return decision;
    },
    settled: async (): Promise<void> => {
      const batch = inFlight;
      inFlight = [];
      await Promise.allSettled(batch);
    },
  };
}

function lesson(id: string, overrides: Partial<StoredLesson> = {}): StoredLesson {
  return {
    id,
    state: "proposed",
    kind: "skill",
    title: `Title ${id}`,
    body: `Body of ${id}.`,
    target: `target-${id}`,
    rationale: "the same mistake came back three times",
    citations: [{ citation: `trace-${id}#record-1`, excerpt: `Excerpt of ${id}.` }],
    createdAt: "2026-09-24T00:00:00.000Z",
    provenance: {
      sessionId: `session-${id}`,
      traceSessionIds: [`session-${id}`],
      contractVersion: 1,
      promptSha256: "a".repeat(64),
    },
    ...overrides,
  };
}

function entry(id: string, overrides: Partial<ReviewEntry> = {}): ReviewEntry {
  return {
    lesson: lesson(id),
    preview: `## Lesson — 2026-09-24\n\nBody of ${id}.\n`,
    ...overrides,
  };
}

interface Sit extends Pending {
  window: ReviewWindow;
  outcome: ReviewOutcome | undefined;
  accepted: StoredLesson[];
  denied: [string, string | undefined][];
  renders: number;
  /** The whole rendered window, borders and all. */
  text(width?: number): string;
  /** Lessons currently listed as rows: rows spell it `kind · target`, the detail pane `target: `. */
  listed(): string[];
}

function sit(entries: ReviewEntry[], overrides: Partial<ReviewHandlers> = {}): Sit {
  const pending = pendingDecisions();
  const accepted: StoredLesson[] = [];
  const denied: [string, string | undefined][] = [];
  let outcome: ReviewOutcome | undefined;
  let renders = 0;

  const window = new ReviewWindow(
    entries,
    theme,
    () => {
      renders += 1;
    },
    result => {
      outcome = result;
    },
    {
      accept: (target: StoredLesson) => {
        accepted.push(target);
        const decision = overrides.accept?.(target) ?? Promise.resolve<string | undefined>(undefined);
        return pending.track(decision);
      },
      deny: (target: StoredLesson, reason: string | undefined) => {
        denied.push([target.id, reason]);
        const decision = overrides.deny?.(target, reason) ?? Promise.resolve<string | undefined>(undefined);
        return pending.track(decision);
      },
    },
  );

  return {
    ...pending,
    window,
    accepted,
    denied,
    get outcome() {
      return outcome;
    },
    get renders() {
      return renders;
    },
    text: (width = WIDTH) => window.render(width).join("\n"),
    listed: () => {
      const rendered = window.render(WIDTH).join("\n");
      return IDS.filter(id => rendered.includes(`skill · target-${id}`));
    },
  };
}

interface Headless {
  ctx: ExtensionCommandContext;
  notifications: string[];
  customCalls: number;
}

/** RPC stubs `custom`; print/json have no UI at all. Only RPC reports `hasUI: true`. */
function headlessContext(mode: "rpc" | "print" | "json"): Headless {
  const state: Headless = { notifications: [], customCalls: 0, ctx: undefined as unknown as ExtensionCommandContext };
  state.ctx = {
    mode,
    hasUI: mode === "rpc",
    ui: {
      notify: (message: string) => {
        state.notifications.push(message);
      },
      custom: () => {
        state.customCalls += 1;
        return Promise.resolve(undefined);
      },
    },
  } as unknown as ExtensionCommandContext;
  return state;
}

interface Terminal {
  ctx: ExtensionCommandContext;
  mounted(): ReviewWindow;
  options(): unknown;
}

function terminalContext(): Terminal {
  let mounted: ReviewWindow | undefined;
  let options: unknown;
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      notify: () => {},
      custom: (
        factory: (
          tui: { requestRender: () => void },
          theme: ReviewTheme,
          keybindings: unknown,
          done: (outcome: ReviewOutcome) => void,
        ) => ReviewWindow,
        customOptions: unknown,
      ) => {
        options = customOptions;
        return new Promise<ReviewOutcome>(resolve => {
          mounted = factory({ requestRender: () => {} }, theme, {}, resolve);
        });
      },
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, mounted: () => mounted!, options: () => options };
}

describe("ReviewWindow", () => {
  test("lists the undecided lessons and shows the selected lesson: target, body, why, evidence ids", () => {
    const review = sit([entry("one"), entry("two")]);
    const rendered = review.text();

    expect(review.listed()).toEqual(["one", "two"]);
    expect(rendered).toContain("skill · target: target-one");
    expect(rendered).toContain("Title one");
    expect(rendered).toContain("Body of one.");
    // The rationale is invisible everywhere else — the surface gets title and body — so review is
    // the only place the reviewer can read why the lesson is worth keeping.
    expect(rendered).toContain("why keep it:");
    expect(rendered).toContain("the same mistake came back three times");
    // The record ids always; the excerpts they stand for are one key away.
    expect(rendered).toContain("evidence: trace-one#record-1");
    expect(rendered).not.toContain("Excerpt of one.");
    expect(rendered).toContain("## Lesson — 2026-09-24");
    expect(rendered).toContain("↑/↓ or j/k move · a accept · d deny · e evidence · c all changes · q quit");

    // Only the selected lesson is detailed.
    expect(rendered).not.toContain("skill · target: target-two");
    expect(rendered).not.toContain("Body of two.");
  });

  test("moves with j/k and the arrow keys, and accepting the second lesson removes its row", async () => {
    const review = sit([entry("one"), entry("two")]);
    review.window.handleInput("j");
    expect(review.text()).toContain("Body of two.");
    review.window.handleInput(UP);
    expect(review.text()).toContain("Body of one.");
    review.window.handleInput(DOWN);
    review.window.handleInput(DOWN);
    expect(review.renders).toBeGreaterThan(0);

    review.window.handleInput("a");
    await review.settled();

    expect(review.accepted.map(accepted => accepted.id)).toEqual(["two"]);
    expect(review.listed()).toEqual(["one"]);
    expect(review.text()).toContain("accepted two");
    expect(review.outcome).toBeUndefined();
  });

  test("denying collects a one-line reason and records it", async () => {
    const review = sit([entry("one"), entry("two")]);
    review.window.handleInput("d");
    expect(review.text()).toContain("reason: ");
    expect(review.text()).toContain("Enter deny with this reason · Esc cancel");

    for (const character of "too vague") review.window.handleInput(character);
    expect(review.text()).toContain("reason: too vague");

    review.window.handleInput(ENTER);
    await review.settled();

    expect(review.denied).toEqual([["one", "too vague"]]);
    expect(review.listed()).toEqual(["two"]);
    expect(review.text()).toContain("denied one: too vague");
  });

  test("an empty reason prompt denies without a reason", async () => {
    const review = sit([entry("one")]);
    review.window.handleInput("d");
    review.window.handleInput(ENTER);
    await review.settled();

    expect(review.denied).toEqual([["one", undefined]]);
    expect(review.text()).toContain("denied one");
  });

  test("Esc during the reason prompt cancels the denial and leaves the window open", () => {
    const review = sit([entry("one"), entry("two")]);
    review.window.handleInput("d");
    review.window.handleInput("b");
    review.window.handleInput("x");
    review.window.handleInput(ESC);

    expect(review.denied).toEqual([]);
    expect(review.outcome).toBeUndefined();
    expect(review.listed()).toEqual(["one", "two"]);
    expect(review.text()).not.toContain("reason: bx");

    // Back on the list: the arrow keys move again.
    review.window.handleInput(DOWN);
    expect(review.text()).toContain("Body of two.");
  });

  test("a handler error keeps the row and renders the message", async () => {
    const rejecting = sit([entry("one"), entry("two")], { accept: async () => "cannot write: disk is full" });
    rejecting.window.handleInput("a");
    await rejecting.settled();

    expect(rejecting.accepted.map(accepted => accepted.id)).toEqual(["one"]);
    expect(rejecting.listed()).toEqual(["one", "two"]);
    expect(rejecting.text()).toContain("cannot write: disk is full");
    expect(rejecting.outcome).toBeUndefined();

    const throwing = sit([entry("one")], {
      accept: async () => {
        throw new Error("the store lock is held");
      },
    });
    throwing.window.handleInput("a");
    await throwing.settled();

    expect(throwing.text()).toContain("the store lock is held");
    expect(throwing.listed()).toEqual(["one"]);
  });

  test("a blocked lesson refuses accept and shows why", async () => {
    const review = sit([entry("one", { blocked: "no target skill in this project" })]);
    review.window.handleInput("a");
    await review.settled();

    expect(review.accepted).toEqual([]);
    expect(review.listed()).toEqual(["one"]);
    expect(review.text()).toContain("skill · target-one · blocked");
    expect(review.text()).toContain("blocked: no target skill in this project");
    expect(review.text()).toContain("cannot write: no target skill in this project");
  });

  test("shows the overlap check's lines when the entry carries them", () => {
    const review = sit([
      entry("one", { context: "existing skills: alpha, beta\nexisting agents: reviewer" }),
    ]);
    const rendered = review.text();
    expect(rendered).toContain("overlap check:");
    expect(rendered).toContain("existing skills: alpha, beta");
    expect(rendered).toContain("existing agents: reviewer");

    // Under the lesson itself: what it changes and why come first, the overlap check is a caveat.
    const lines = review.window.render(WIDTH);
    const at = (needle: string) => lines.findIndex(line => line.includes(needle));
    expect(at("skill · target: target-one")).toBeLessThan(at("Body of one."));
    expect(at("Body of one.")).toBeLessThan(at("existing skills: alpha, beta"));

    expect(sit([entry("one")]).text()).not.toContain("overlap check");
  });

  test("never lists an already decided lesson", () => {
    const review = sit([entry("one"), { ...entry("two"), lesson: lesson("two", { state: "approved" }) }]);

    expect(review.listed()).toEqual(["one"]);
    expect(review.text()).not.toContain("Body of two.");
  });

  test("q closes with the accumulated outcome", async () => {
    const review = sit([entry("one"), entry("two")]);
    review.window.handleInput("a");
    await review.settled();
    review.window.handleInput("q");

    expect(review.outcome).toEqual({ accepted: ["one"], denied: [], quit: true });
  });

  test("quitting waits for a decision that is still being written", async () => {
    const decision = Promise.withResolvers<string | undefined>();
    const review = sit([entry("one")], { accept: () => decision.promise });

    review.window.handleInput("a");
    review.window.handleInput("q");
    expect(review.outcome).toBeUndefined();

    decision.resolve(undefined);
    await review.settled();

    expect(review.outcome).toEqual({ accepted: ["one"], denied: [], quit: true });
  });

  test("a second accept mid-write approves the next lesson instead of being dropped", async () => {
    const first = Promise.withResolvers<string | undefined>();
    const second = Promise.withResolvers<string | undefined>();
    const calls: string[] = [];
    const review = sit([entry("one"), entry("two")], {
      accept: target => {
        calls.push(target.id);
        return calls.length === 1 ? first.promise : second.promise;
      },
    });

    review.window.handleInput("a");
    review.window.handleInput("a");
    expect(calls).toEqual(["one"]);

    first.resolve(undefined);
    await review.settled();
    expect(calls).toEqual(["one", "two"]);

    second.resolve(undefined);
    await review.settled();
    review.window.handleInput("q");

    expect(review.outcome).toEqual({ accepted: ["one", "two"], denied: [], quit: true });
  });

  test("quitting drops a queued accept and waits for the one in flight", async () => {
    const first = Promise.withResolvers<string | undefined>();
    const calls: string[] = [];
    const review = sit([entry("one"), entry("two")], {
      accept: target => {
        calls.push(target.id);
        return first.promise;
      },
    });

    review.window.handleInput("a");
    review.window.handleInput("a");
    review.window.handleInput("q");
    expect(review.outcome).toBeUndefined();

    first.resolve(undefined);
    await review.settled();

    expect(calls).toEqual(["one"]);
    expect(review.outcome).toEqual({ accepted: ["one"], denied: [], quit: true });
  });

  test("Esc outside the reason prompt closes the window too", () => {
    const review = sit([entry("one"), entry("two")]);
    review.window.handleInput(ESC);

    expect(review.outcome).toEqual({ accepted: [], denied: [], quit: true });
  });

  test("deciding the last lesson says so and keeps the window open", async () => {
    const review = sit([entry("one")]);
    review.window.handleInput("a");
    await review.settled();

    expect(review.listed()).toEqual([]);
    expect(review.text()).toContain("No undecided lessons left");
    expect(review.outcome).toBeUndefined();
  });

  test("no rendered line is wider than the window", () => {
    const long = entry("one", {
      lesson: lesson("one", {
        title: "A title that is far longer than any terminal width this window will ever see",
        body: "a lesson body ".repeat(60),
        citations: [{ citation: "trace-one#record-1", excerpt: "an excerpt ".repeat(120) }],
      }),
      preview: Array.from({ length: 40 }, (_, index) => `preview line ${index}`).join("\n"),
      blocked: "the target skill is 4000 bytes over the cap",
    });
    const review = sit([long]);

    for (const width of [30, 48, WIDTH]) {
      const lines = review.window.render(width);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  test("shows a lesson's change as a diff of the file it writes", () => {
    const review = sit([
      entry("one", {
        changes: [
          {
            path: ".omp/rules/tests-from-packages-core.md",
            mode: "create",
            lines: [
              { kind: "added", number: 1, text: "---" },
              { kind: "added", number: 2, text: "name: tests-from-packages-core" },
            ],
            added: 2,
            context: 0,
          },
        ],
      }),
    ]);

    const rendered = review.text();
    expect(rendered).toContain("new file  .omp/rules/tests-from-packages-core.md  (+2)");
    expect(rendered).toContain("1 + ---");
    expect(rendered).toContain("2 + name: tests-from-packages-core");
    // The diff is the lesson: the raw write preview is not repeated beside it.
    expect(rendered).not.toContain("the write:");
    expect(rendered).toContain("c shows every change in this batch");
  });

  test("the recap names the batch before anything is read", () => {
    const review = sit([
      entry("one", { changes: [{ path: ".omp/rules/a.md", mode: "create", lines: [], added: 0, context: 0 }] }),
      entry("two", { changes: [{ path: ".omp/skills/retry-helper/SKILL.md", mode: "append", lines: [], added: 0, context: 0 }] }),
      entry("three", { blocked: "the target skill is gone" }),
    ]);
    const rendered = review.text();
    expect(rendered).toContain("3 lesson(s) — 3 skill");
    expect(rendered).toContain(".omp/rules/a.md (new)");
    expect(rendered).toContain(".omp/skills/retry-helper/SKILL.md");
    expect(rendered).toContain("blocked: Title three — the target skill is gone");
  });

  test("c reads every change in the batch on one screen, and goes back", () => {
    const review = sit([
      entry("one", {
        changes: [{ path: ".omp/rules/one.md", mode: "create", lines: [{ kind: "added", number: 1, text: "one" }], added: 1, context: 0 }],
      }),
      entry("two", {
        changes: [{ path: ".omp/rules/two.md", mode: "create", lines: [{ kind: "added", number: 1, text: "two" }], added: 1, context: 0 }],
      }),
    ]);

    review.window.handleInput("c");
    const changeset = review.text();
    expect(changeset).toContain("1 + one");
    expect(changeset).toContain("1 + two");
    expect(changeset).toContain("Esc or c back to the list");

    review.window.handleInput("");
    expect(review.text()).toContain("↑/↓ or j/k move · a accept · d deny · e evidence · c all changes · q quit");
  });

  test("e shows the evidence, and hides it again", () => {
    const review = sit([entry("one")]);
    expect(review.text()).toContain("evidence: trace-one#record-1");
    expect(review.text()).toContain("e shows what it says in the session (1 record(s))");
    expect(review.text()).not.toContain("Excerpt of one.");

    review.window.handleInput("e");
    expect(review.text()).toContain("Excerpt of one.");
    expect(review.text()).toContain("e hides it");

    review.window.handleInput("e");
    expect(review.text()).not.toContain("Excerpt of one.");
  });
});

describe("runReview", () => {
  test("reports that review needs the terminal in modes without a window, and mounts nothing", async () => {
    for (const mode of ["rpc", "print", "json"] as const) {
      const headless = headlessContext(mode);
      const outcome = await runReview(headless.ctx, [entry("one")], {
        accept: async () => undefined,
        deny: async () => undefined,
      });

      expect(outcome).toBeUndefined();
      expect(headless.customCalls).toBe(0);
      expect(headless.notifications.join("\n")).toContain("needs the terminal");
    }
  });

  test("mounts the window through ctx.ui.custom in tui mode and resolves with its outcome", async () => {
    const pending = pendingDecisions();
    const terminal = terminalContext();
    const accepted: StoredLesson[] = [];
    const run = runReview(terminal.ctx, [entry("one"), entry("two")], {
      accept: (target: StoredLesson) => {
        accepted.push(target);
        return pending.track(Promise.resolve(undefined));
      },
      deny: () => pending.track(Promise.resolve(undefined)),
    });

    expect(terminal.options()).toEqual({ overlay: true });
    const mounted = terminal.mounted();
    expect(mounted.render(WIDTH).join("\n")).toContain("skill · target-two");

    mounted.handleInput(DOWN);
    mounted.handleInput("a");
    await pending.settled();
    mounted.handleInput("q");

    expect(await run).toEqual({ accepted: ["two"], denied: [], quit: true });
    expect(accepted.map(accepted => accepted.id)).toEqual(["two"]);
  });
});
