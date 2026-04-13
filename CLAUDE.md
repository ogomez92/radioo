# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Use **pnpm**, not npx or npm.

- `pnpm dev` — Vite dev server; `vite-plugin-electron` auto-builds `electron/main.ts` + `preload.ts` and launches Electron against the dev URL.
- `pnpm build` — Production build of renderer (`dist/`) and main/preload (`dist-electron/`).
- `pnpm check` — `svelte-check` type check across the project.

There is no test runner configured. `ffmpeg` must be available on `PATH` at runtime — the encoder spawns it as a child process.

## Architecture

WebIce is an Electron + Svelte 5 desktop app that captures mic + system audio, runs a Web Audio effects chain in the renderer, and streams encoded output to Icecast (and optionally HLS) from the main process.

**Two-process split — this is the key mental model:**

- **Renderer (`src/`)** owns all audio DSP via Web Audio API. `src/lib/audio/engine.ts` (`AudioEngine`) builds the node graph: mic & system `MediaStreamAudioSourceNode`s → per-source gain → ducking → effects chain (boost, noise-gate worklet, compressor, presence EQ, megaphone filters, convolver reverb, limiter) → master → `pcmCapture` AudioWorklet that emits raw f32 PCM frames. State lives in `src/lib/stores/app-store.svelte.ts` (Svelte 5 runes). Components in `src/lib/components/` are thin views over the engine + store.
- **Main (`electron/`)** owns everything that isn't DSP: spawning ffmpeg, Icecast SOURCE client, file I/O, settings persistence, dialogs, listener polling. `main.ts` creates the window and wires a `setDisplayMediaRequestHandler` that auto-grants system-audio loopback capture (no picker). `ipc-handlers.ts` is the central IPC surface — every renderer↔main interaction is registered here.

**Audio data flow (hot path):**

Renderer's `pcmCapture` worklet → `ipcRenderer.send('audio:data', ArrayBuffer)` → `ipc-handlers.ts` writes the buffer to both `Encoder` and `HlsEncoder` (both in `electron/encoder.ts`). `Encoder` pipes f32le PCM into ffmpeg stdin with codec args chosen by format (mp3/ogg/aac/opus/flac) and emits encoded chunks on `'data'`, which are fanned out to `IcecastClient.send()` and the optional recording `WriteStream`. `HlsEncoder` is an independent ffmpeg instance writing segmented output to disk.

**Icecast client (`electron/icecast.ts`):** Raw TCP SOURCE protocol (no library). Emits `connected`/`disconnected`/`reconnecting`/`error` which `ipc-handlers.ts` forwards to the renderer as `status:update` messages. Listener counts are polled every 10s from `/status-json.xsl` on the target server and pushed via the same status channel.

**IPC conventions:** Renderer calls `window.electron.*` (exposed in `preload.ts`). Status updates are one-way main→renderer on the `status:update` channel — treat this as the single source of truth for streaming state in the UI. Global shortcuts (`Ctrl+Shift+M`, `Ctrl+Shift+D`) are registered in `main.ts` and dispatched to the renderer via a `'shortcut'` message.

**Settings** persist to `app.getPath('userData')/webice-settings.json` via `settings:load` / `settings:save` / `settings:save-sync` (the sync variant exists for shutdown-time saves).

## Conventions

- Svelte 5 runes (`$state`, `$derived`, `$effect`) — not the legacy store API. `app-store.svelte.ts` is the pattern to follow.
- Preload is built as CJS (`preload.cjs`) while main and renderer are ESM — see `vite.config.ts`. Don't change this without understanding why.
- When adding an IPC channel, register it in `electron/ipc-handlers.ts` AND expose it through `electron/preload.ts`; there is no auto-binding.
- Error surfacing: main-process errors should go out via `sendStatus({ error: ... })` rather than throwing across the IPC boundary, so the StatusBar can display them.
