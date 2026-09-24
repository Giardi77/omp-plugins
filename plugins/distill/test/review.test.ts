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
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";

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
  /** Lessons currently listed as rows, in row order. */
  listed(): string[];
}

/** Rows the window is told it has: enough for the detail pane unless a test wants the cap. */
function sit(entries: ReviewEntry[], overrides: Partial<ReviewHandlers> = {}, rows = 80): Sit {
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
    { rows },
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
    listed: () => window.undecided,
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
  /** The terminal the window is painting into, as the host would resize it. */
  terminal: { rows: number };
}

function terminalContext(rows = 24): Terminal {
  let mounted: ReviewWindow | undefined;
  let options: unknown;
  const liveTerminal = { rows };
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      notify: () => {},
      custom: (
        factory: (
          tui: { requestRender: () => void; terminal: { rows: number } },
          theme: ReviewTheme,
          keybindings: unknown,
          done: (outcome: ReviewOutcome) => void,
        ) => ReviewWindow,
        customOptions: unknown,
      ) => {
        options = customOptions;
        return new Promise<ReviewOutcome>(resolve => {
          // The real TUI carries the terminal it is painting into, and the window reads its height
          // on every render so a resize is followed rather than remembered.
          mounted = factory({ requestRender: () => {}, terminal: liveTerminal }, theme, {}, resolve);
        });
      },
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, mounted: () => mounted!, options: () => options, terminal: liveTerminal };
}

describe("ReviewWindow", () => {
  test("lists the undecided lessons and shows the selected lesson: target, body, why, evidence ids", () => {
    const review = sit([entry("one"), entry("two")]);
    const rendered = review.text();

    expect(review.listed()).toEqual(["one", "two"]);
    expect(rendered).toContain("skill · target: target-one");
    expect(rendered).toContain("Title one");
    // The lesson itself, then why it is worth keeping — the rationale is invisible everywhere else,
    // since the surfaces only ever get the body.
    expect(rendered).toContain("The lesson:");
    expect(rendered).toContain("Body of one.");
    expect(rendered).toContain("Why keep it:");
    expect(rendered).toContain("the same mistake came back three times");
    // The record ids always; the excerpts they stand for are one key away.
    expect(rendered).toContain("evidence: trace-one#record-1");
    expect(rendered).not.toContain("Excerpt of one.");
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
    // The row marks it blocked; the detail pane says why, twice: once as the warning, once as the
    // refusal when the operator presses accept anyway.
    expect(review.text()).toContain("blocked");
    expect(review.text()).toContain("skill · target: target-one");
    expect(review.text()).toContain("blocked: no target skill in this project");
    expect(review.text()).toContain("cannot write: no target skill in this project");
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
      blocked: "the target skill is 4000 bytes over the cap",
    });
    const review = sit([long]);

    for (const width of [30, 48, WIDTH]) {
      const lines = review.window.render(width);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  /** A lesson whose detail is longer than any terminal: 40 lines of body plus the rest of the pane. */
  function tall(): ReviewEntry {
    return entry("one", {
      lesson: lesson("one", { body: Array.from({ length: 40 }, (_unused, index) => `body line ${index}`).join("\n") }),
    });
  }

  test("the frame is exactly as tall as the terminal, never taller", () => {
    // The overlay is anchored to the bottom, so a frame that outgrows the screen loses its *top*:
    // the recap and the list, which is what "the top text is cut off" was. Both views fill the
    // screen and neither may pass it.
    for (const rows of [6, 9, 12, 24, 40, 80]) {
      const tight = sit([tall()], {}, rows);
      expect(tight.window.render(WIDTH).length).toBe(rows);
      tight.window.handleInput("c");
      expect(tight.window.render(WIDTH).length).toBe(rows);
    }
  });

  test("a detail taller than its pane scrolls inside it, a page at a time", () => {
    const roomy = sit([tall()], {}, 80);
    expect(roomy.text()).toContain("body line 39");

    const tight = sit([tall()], {}, 24);
    const before = tight.text();
    // The top of the pane is what is shown, and the pane says how much is below it.
    expect(before).toContain("The lesson:");
    expect(before).not.toContain("body line 39");
    expect(before).toContain("more line(s) — PgUp/PgDn scrolls this pane");

    tight.window.handleInput(PAGE_DOWN);
    const scrolled = tight.text();
    expect(scrolled).not.toBe(before);
    expect(scrolled).toContain("body line 12"); // one page on from the top of the pane
    expect(scrolled).toContain("above ·");

    // …and back, to the very top: the note names only what is below it.
    tight.window.handleInput(PAGE_UP);
    tight.window.handleInput(PAGE_UP);
    expect(tight.text()).toContain("The lesson:");
    expect(tight.text()).toContain("more line(s) — PgUp/PgDn");
    expect(tight.text()).not.toContain("above");
  });

  test("the recap, the list and then the selected lesson's detail, in that order", () => {
    const review = sit([entry("one"), entry("two")]);
    const rendered = review.window.render(WIDTH);
    const at = (needle: string) => rendered.findIndex(line => line.includes(needle));

    expect(at("2 lesson(s)")).toBeGreaterThan(-1);
    expect(at("❯")).toBeGreaterThan(at("2 lesson(s)"));
    expect(at("The lesson:")).toBeGreaterThan(at("❯"));
    expect(at("q quit")).toBeGreaterThan(at("The lesson:"));
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
            removed: 0,
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
      entry("one", { changes: [{ path: ".omp/rules/a.md", mode: "create", lines: [], added: 0, removed: 0, context: 0 }] }),
      entry("two", { changes: [{ path: ".omp/skills/retry-helper/SKILL.md", mode: "append", lines: [], added: 0, removed: 0, context: 0 }] }),
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
        changes: [{ path: ".omp/rules/one.md", mode: "create", lines: [{ kind: "added", number: 1, text: "one" }], added: 1, removed: 0, context: 0 }],
      }),
      entry("two", {
        changes: [{ path: ".omp/rules/two.md", mode: "create", lines: [{ kind: "added", number: 1, text: "two" }], added: 1, removed: 0, context: 0 }],
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

    expect(terminal.options()).toEqual({
      overlay: true,
      // The frame is a screenful, so it borrows the alternate screen: nothing behind it, and the
      // terminal's own scrolling cannot move the modal. The rest restates the host's defaults,
      // which supplying options replaces wholesale.
      overlayOptions: { width: "100%", maxHeight: "100%", margin: 0, fullscreen: true, mouseTracking: false },
    });
    const mounted = terminal.mounted();
    expect(mounted.render(WIDTH).join("\n")).toContain("Title two");
    // The height is read per render, so a resized terminal is followed rather than remembered.
    expect(mounted.render(WIDTH).length).toBe(24);
    terminal.terminal.rows = 12;
    expect(mounted.render(WIDTH).length).toBe(12);

    mounted.handleInput(DOWN);
    mounted.handleInput("a");
    await pending.settled();
    mounted.handleInput("q");

    expect(await run).toEqual({ accepted: ["two"], denied: [], quit: true });
    expect(accepted.map(accepted => accepted.id)).toEqual(["two"]);
  });
});
