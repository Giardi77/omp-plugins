import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import ponytailExtension from "../pi-extension/index.js";

/** The injected ruleset lands in the prompt parts the host takes back. */
function promptText(result) {
  return (Array.isArray(result?.systemPrompt) ? result.systemPrompt : [result?.systemPrompt]).join("\n\n");
}

function createPiHarness({ host = true, settings = { getProjectSettings: () => ({}), getGlobalSettings: () => ({}) } } = {}) {
  const events = new Map();
  const commands = new Map();
  const appendedEntries = [];
  const sentUserMessages = [];
  const colors = [];

  const pi = {
    on(eventName, handler) {
      events.set(eventName, handler);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    appendEntry(customType, data) {
      appendedEntries.push({ customType, data });
    },
    sendUserMessage(text, options) {
      sentUserMessages.push({ text, options });
    },
  };

  if (host) {
    // Minimal stand-in for the omp host namespace surface ponytail uses.
    pi.pi = {
      SEGMENTS: {},
      STATUS_LINE_PRESETS: {
        default: { leftSegments: ["pi", "model", "mode", "path"] },
        minimal: { leftSegments: ["path", "git"] },
        ascii: { leftSegments: ["path"] },
      },
      theme: { fg: (color, text) => { colors.push(color); return text; } },
      settings,
    };
  }

  ponytailExtension(pi);
  return { events, commands, appendedEntries, sentUserMessages, colors, host: pi.pi };
}

function createCommandContext(overrides = {}) {
  return {
    isIdle: () => true,
    sessionManager: { getEntries: () => [] },
    ui: { notify() {} },
    ...overrides,
  };
}

function withTempConfig(fn) {
  const tempConfigHome = mkdtempSync(join(tmpdir(), "ponytail-test-"));
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const previousHide = process.env.PONYTAIL_HIDE_STATUS;
  process.env.XDG_CONFIG_HOME = tempConfigHome;
  delete process.env.PONYTAIL_HIDE_STATUS;

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
      if (previousHide === undefined) delete process.env.PONYTAIL_HIDE_STATUS;
      else process.env.PONYTAIL_HIDE_STATUS = previousHide;
      rmSync(tempConfigHome, { recursive: true, force: true });
    });
}

test("extension registers Ponytail commands", () => {
  const { commands } = createPiHarness();

  assert.deepEqual([...commands.keys()].sort(), ["ponytail", "ponytail-audit", "ponytail-debt", "ponytail-gain", "ponytail-help", "ponytail-review"]);
});

test("/ponytail updates session mode and injects instructions", async () => withTempConfig(async () => {
  const { commands, events, appendedEntries } = createPiHarness();
  const ctx = createCommandContext();

  await events.get("session_start")({ reason: "startup" }, ctx);
  await commands.get("ponytail").handler("ultra", ctx);

  assert.deepEqual(appendedEntries.at(-1), {
    customType: "ponytail-mode",
    data: { mode: "ultra" },
  });

  const result = await events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx);
  assert.ok(promptText(result).includes("PONYTAIL MODE ACTIVE"));
  assert.ok(promptText(result).includes("ultra"));
}));

test("before_agent_start guards missing event and missing systemPrompt (#439, #440)", async () => withTempConfig(async () => {
  const { events } = createPiHarness();
  const ctx = createCommandContext();
  await events.get("session_start")({ reason: "startup" }, ctx); // currentMode -> default (full)

  // #439: a null/undefined event must not crash, and still injects the ruleset.
  for (const bad of [undefined, null]) {
    const r = await events.get("before_agent_start")(bad, ctx);
    assert.ok(promptText(r).includes("PONYTAIL MODE ACTIVE"));
    assert.ok(!promptText(r).includes("undefined"), "must not contain the literal 'undefined'");
  }

  // #440: an event without a systemPrompt must not prepend the literal "undefined".
  const empty = await events.get("before_agent_start")({}, ctx);
  assert.ok(promptText(empty).includes("PONYTAIL MODE ACTIVE"));
  assert.ok(!promptText(empty).startsWith("undefined"), "must not start with 'undefined'");

  // A real base prompt is still preserved ahead of the ruleset.
  const withBase = await events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx);
  assert.deepEqual(withBase.systemPrompt.slice(0, 1), ["BASE"]);
  assert.ok(promptText(withBase).includes("PONYTAIL MODE ACTIVE"));
}));

test("before_agent_start appends to the prompt parts instead of flattening them", async () => withTempConfig(async () => {
  const { events } = createPiHarness();
  const ctx = createCommandContext();
  await events.get("session_start")({ reason: "startup" }, ctx);

  const result = await events.get("before_agent_start")({ systemPrompt: ["BASE", "SKILLS"] }, ctx);

  assert.deepEqual(result.systemPrompt.slice(0, 2), ["BASE", "SKILLS"], "host parts must survive verbatim");
  assert.equal(result.systemPrompt.length, 3);
  assert.ok(result.systemPrompt[2].includes("PONYTAIL MODE ACTIVE"));
}));

test("session_start restores latest persisted mode", async () => withTempConfig(async () => {
  const { events } = createPiHarness();
  const ctx = createCommandContext({
    sessionManager: {
      getEntries: () => [
        { type: "custom", customType: "ponytail-mode", data: { mode: "lite" } },
      ],
    },
  });

  await events.get("session_start")({ reason: "resume" }, ctx);
  const result = await events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx);

  assert.ok(promptText(result).includes("lite"));
}));

test("skill alias commands delegate to Pi skill commands", async () => {
  const { commands, sentUserMessages } = createPiHarness();
  const ctx = createCommandContext();

  await commands.get("ponytail-review").handler("", ctx);
  await commands.get("ponytail-audit").handler("", ctx);
  await commands.get("ponytail-debt").handler("", ctx);
  await commands.get("ponytail-gain").handler("", ctx);
  await commands.get("ponytail-help").handler("", ctx);

  assert.deepEqual(sentUserMessages.map((entry) => entry.text), [
    "/skill:ponytail-review",
    "/skill:ponytail-audit",
    "/skill:ponytail-debt",
    "/skill:ponytail-gain",
    "/skill:ponytail-help",
  ]);
});

test("normal mode disables persistent instructions", async () => withTempConfig(async () => {
  const { commands, events } = createPiHarness();
  const ctx = createCommandContext();

  await events.get("session_start")({ reason: "startup" }, ctx);
  await commands.get("ponytail").handler("ultra", ctx);
  await events.get("input")({ text: "normal mode", source: "interactive" }, ctx);

  const disabled = await events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx);
  assert.equal(disabled, undefined);
}));

test("a request mentioning normal mode stays active", async () => withTempConfig(async () => {
  const { commands, events } = createPiHarness();
  const ctx = createCommandContext();

  await events.get("session_start")({ reason: "startup" }, ctx);
  await commands.get("ponytail").handler("ultra", ctx);
  await events.get("input")({ text: "add a normal mode toggle next to dark mode", source: "interactive" }, ctx);

  const result = await events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx);
  assert.match(promptText(result), /PONYTAIL MODE ACTIVE/);
}));

test("status chip renders in the host status line and flips color on agent_start", async () => withTempConfig(async () => {
  const { events, colors, host } = createPiHarness();
  const statusWrites = [];
  const ctx = createCommandContext({
    sessionManager: { getEntries: () => [{ type: "custom", customType: "ponytail-mode", data: { mode: "ultra" } }] },
    ui: { notify() {}, setStatus: (key, text) => statusWrites.push({ key, text }), theme: { fg: (_c, t) => t } },
  });

  await events.get("session_start")({ reason: "resume" }, ctx);
  const segment = host.SEGMENTS.ponytail;
  assert.ok(segment, "ponytail segment must be registered in the host registry");
  assert.equal(segment.render().content, "🐴 ultra");
  assert.match(colors.at(-1), /muted/);

  await events.get("agent_start")({}, ctx);
  assert.equal(segment.render().content, "🐴 ultra");
  assert.match(colors.at(-1), /accent/);

  // The bar owns the indicator now: hook line only receives repaint nudges.
  assert.ok(statusWrites.length > 0);
  assert.ok(statusWrites.every((write) => write.text === undefined));
}));

test("status chip rides the built-in presets (except ascii)", () => {
  const { host } = createPiHarness();

  assert.deepEqual(host.STATUS_LINE_PRESETS.default.leftSegments, ["pi", "model", "mode", "ponytail", "path"]);
  assert.deepEqual(host.STATUS_LINE_PRESETS.minimal.leftSegments, ["path", "git", "ponytail"]);
  assert.deepEqual(host.STATUS_LINE_PRESETS.ascii.leftSegments, ["path"]);
});

test("custom-preset hosts fall back to the hook line (their list is not extensible)", async () => withTempConfig(async () => {
  const custom = {
    getProjectSettings: () => ({ statusLine: { preset: "custom", leftSegments: ["model", "mode", "git"] } }),
    getGlobalSettings: () => ({}),
  };
  const { events, host } = createPiHarness({ settings: custom });
  const statusWrites = [];
  const ctx = createCommandContext({
    sessionManager: { getEntries: () => [{ type: "custom", customType: "ponytail-mode", data: { mode: "ultra" } }] },
    ui: { notify() {}, setStatus: (_key, text) => statusWrites.push(text) },
  });

  await events.get("session_start")({ reason: "resume" }, ctx);

  // The preset tables still carry the chip, but a custom host never reads them,
  // so the hook line is what the user actually sees.
  assert.ok(host.STATUS_LINE_PRESETS.default.leftSegments.includes("ponytail"));
  assert.equal(statusWrites.at(-1), "🐴 ultra");
}));

test("a custom preset in the project layer wins over the global layer", async () => withTempConfig(async () => {
  const { events } = createPiHarness({
    settings: {
      getProjectSettings: () => ({ statusLine: { preset: "custom" } }),
      getGlobalSettings: () => ({ statusLine: { preset: "default" } }),
    },
  });
  const statusWrites = [];
  const ctx = createCommandContext({
    sessionManager: { getEntries: () => [{ type: "custom", customType: "ponytail-mode", data: { mode: "lite" } }] },
    ui: { notify() {}, setStatus: (_key, text) => statusWrites.push(text) },
  });

  await events.get("session_start")({ reason: "resume" }, ctx);

  assert.equal(statusWrites.at(-1), "🐴 lite");
}));

test("preset hosts keep the hook line empty (the segment owns the indicator)", async () => withTempConfig(async () => {
  const { events } = createPiHarness({
    settings: {
      getProjectSettings: () => ({ statusLine: { preset: "default" } }),
      getGlobalSettings: () => ({}),
    },
  });
  const statusWrites = [];
  const ctx = createCommandContext({
    sessionManager: { getEntries: () => [{ type: "custom", customType: "ponytail-mode", data: { mode: "ultra" } }] },
    ui: { notify() {}, setStatus: (_key, text) => statusWrites.push(text) },
  });

  await events.get("session_start")({ reason: "resume" }, ctx);
  await events.get("agent_start")({}, ctx);

  assert.ok(statusWrites.length > 0, "the segment still needs a repaint nudge");
  assert.deepEqual([...new Set(statusWrites)], [undefined]);
}));

test("hosts whose settings object dropped the old path API stay on the segment path", async () => withTempConfig(async () => {
  // omp 18 removed Settings#get/#override; only the layer getters remain. The
  // status line must not throw on either of them being absent.
  const settings = { overlay: () => ({}), isConfigured: () => false, rawValue: () => undefined };
  const { events } = createPiHarness({ settings });
  const statusWrites = [];
  const ctx = createCommandContext({
    sessionManager: { getEntries: () => [{ type: "custom", customType: "ponytail-mode", data: { mode: "lite" } }] },
    ui: { notify() {}, setStatus: (_key, text) => statusWrites.push(text) },
  });

  await events.get("session_start")({ reason: "resume" }, ctx);

  assert.deepEqual([...new Set(statusWrites)], [undefined]);
}));

test("hosts without the status-line registry fall back to the hook line", async () => withTempConfig(async () => {
  const { events, colors } = createPiHarness({ host: false });
  const statusWrites = [];
  const ctx = createCommandContext({
    sessionManager: { getEntries: () => [{ type: "custom", customType: "ponytail-mode", data: { mode: "ultra" } }] },
    ui: { notify() {}, setStatus: (key, text) => statusWrites.push({ key, text }), theme: { fg: (color, text) => { colors.push(color); return text; } } },
  });

  await events.get("session_start")({ reason: "resume" }, ctx);
  await events.get("agent_start")({}, ctx);

  assert.equal(statusWrites.at(-2).text, "🐴 ultra");
  assert.match(colors.at(-2), /muted/);
  assert.equal(statusWrites.at(-1).text, "🐴 ultra");
  assert.match(colors.at(-1), /accent/);
}));

test("hook-line fallback renders unstyled when the host theme is unavailable", async () => withTempConfig(async () => {
  const { events } = createPiHarness({ host: false });
  const calls = [];
  const ctx = createCommandContext({
    sessionManager: { getEntries: () => [{ type: "custom", customType: "ponytail-mode", data: { mode: "ultra" } }] },
    ui: { notify() {}, setStatus: (_key, text) => calls.push(text) }, // setStatus present, theme absent
  });

  await events.get("session_start")({ reason: "resume" }, ctx);

  assert.deepEqual(calls, ["🐴 ultra"]);
}));

test("PONYTAIL_HIDE_STATUS hides the chip but keeps ponytail active (#324)", async () => withTempConfig(async () => {
  process.env.PONYTAIL_HIDE_STATUS = "1";
  const { events, host } = createPiHarness();
  const ctx = createCommandContext({
    sessionManager: { getEntries: () => [{ type: "custom", customType: "ponytail-mode", data: { mode: "ultra" } }] },
    ui: { notify() {}, setStatus: () => {} },
  });

  await events.get("session_start")({ reason: "resume" }, ctx);
  await events.get("agent_start")({}, ctx);
  const injected = await events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx);

  assert.equal(host.SEGMENTS.ponytail.render().visible, false, "chip must hide while the ruleset stays active");
  assert.match(promptText(injected), /PONYTAIL MODE ACTIVE/, "ruleset must still inject while status is hidden");
}));

test("config.hideStatus hides the chip but keeps ponytail active (#324)", async () => withTempConfig(async () => {
  mkdirSync(join(process.env.XDG_CONFIG_HOME, "ponytail"), { recursive: true });
  writeFileSync(join(process.env.XDG_CONFIG_HOME, "ponytail", "config.json"), JSON.stringify({ hideStatus: true }));
  const { events, host } = createPiHarness();
  const ctx = createCommandContext({
    ui: { notify() {}, setStatus: () => {} },
  });

  await events.get("session_start")({ reason: "startup" }, ctx);
  await events.get("agent_start")({}, ctx);
  const injected = await events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx);

  assert.equal(host.SEGMENTS.ponytail.render().visible, false, "chip must hide while the ruleset stays active");
  assert.match(promptText(injected), /PONYTAIL MODE ACTIVE/, "ruleset must still inject while status is hidden");
}));

test("PONYTAIL_HIDE_STATUS=0 does not hide the chip", async () => withTempConfig(async () => {
  process.env.PONYTAIL_HIDE_STATUS = "0";
  const { events, host } = createPiHarness();
  const ctx = createCommandContext({
    sessionManager: { getEntries: () => [{ type: "custom", customType: "ponytail-mode", data: { mode: "ultra" } }] },
    ui: { notify() {}, setStatus: () => {} },
  });

  await events.get("session_start")({ reason: "resume" }, ctx);

  assert.equal(host.SEGMENTS.ponytail.render().visible, true, "0 must be treated as 'do not hide'");
}));
