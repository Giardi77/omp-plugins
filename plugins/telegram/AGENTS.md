# AGENTS.md — omp-telegram-extension

Telegram bridge extension for OMP: drive a running session from Telegram, stream it back,
approve tool calls remotely.

## Layout

- `src/bot-api.ts` — typed Bot API client (drafts, rich messages, topics, keyboards),
  `BotUpdateSource` seam + polling impl, `chunkText`, `RateLimiter`
- `src/config.ts` — project config (`.omp/config.yml`) + user-global token store
- `src/pairing.ts` — one-time-code pairing handshake
- `src/lock.ts` — single-consumer instance lock
- `src/index.ts` — extension wiring: bootstrap, `/telegram-setup`, `/telegram-status`, event routing
- `src/stream.ts` — turn renderer (pure) + paced Telegram driver (draft coalescing, chunking)
- `src/topics.ts` — session↔topic router with runtime Threaded-Mode detection
- `src/approvals.ts` — plugin-owned approval gate (surface race, always-allow memory)
- `src/surfaces.ts` — Telegram card + TUI dialog approval surfaces
- `src/inbound.ts` — Telegram message → prompt conversion (text, photos)
- `prototype/run.ts` — live UI prototype against a real bot

## Rules

- Turn anatomy: ONE evolving rich message per turn — the draft grows (thinking block, streamed
  text, tool-call `<details>` blocks) and finalizes at turn end. Chosen over segmented cards.
- Zero runtime deps beyond `@oh-my-pi/pi-coding-agent`. Bun only.
- Bot token NEVER in project config: `~/.omp/telegram.json` (0600) or env
  `OMP_TELEGRAM_BOT_TOKEN`. Project config holds non-secret state only.
- One bot token = one `getUpdates` consumer: use the instance lock, never retry on 409.
- Every Bot API call must carry an abort timeout (see `TelegramBotApi.call`) — keep it that way.
- Bootstrap only when `ctx.hasUI` — headless/RPC sessions never poll.
- Plain messages and plain drafts cap at 4096 chars (`chunkText`); rich messages at 32768
  chars / 500 blocks — long turns paginate into a continuation message. Draft updates ≤ ~3/s
  (`RateLimiter`).
- Rich content: `markdown` for agent output, `html` for constructed cards. `<tg-thinking>` is
  draft-only, never persists.
- Topics are progressive enhancement: gate on `getMe().has_topics_enabled`; without it, post
  everything in the main chat (flat mode).
- The approval gate runs inside `tool_call` before the built-in gate — requires
  `tools.approvalMode: yolo` or every call double-prompts. No surfaces → defer to built-in.
  A late tap must show the settled verdict, never the tapped one.
- The `.omp/config.yml` YAML round-trip mirrors `plugins/setup-skills`; if a third plugin
  needs it, extract a shared package instead of copying again.
- OMP API truth: `.reference/oh-my-pi` (gitignored clone). The installed npm version is the
  compile gate.

## Verify

- `bun install && bun run check && bun test` (repo root)
- Live: `bun plugins/telegram/prototype/run.ts scene1,scene2,approvals,topics`
  (needs `OMP_TELEGRAM_BOT_TOKEN` in the repo-root `.env`)
