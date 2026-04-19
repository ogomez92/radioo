# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Use **pnpm**, not npx or npm.

- `pnpm dev` — Vite dev server; `vite-plugin-electron` auto-builds `electron/main.ts` + `preload.ts` and launches Electron against the dev URL.
- `pnpm build` — Production build of renderer (`dist/`) and main/preload (`dist-electron/`).
- `pnpm build:sidecar` — Builds the Rust per-process capture sidecar and copies it into `resources/proc-audio-capture/`. Run this at least once before `pnpm dev` or `pnpm dist:win`.
- `pnpm check` — `svelte-check` type check across the project.

There is no test runner configured. `ffmpeg` must be available on `PATH` at runtime — the encoder spawns it as a child process. `proc-audio-capture.exe` (the WASAPI sidecar) ships inside `resources/proc-audio-capture/` and is resolved relative to `process.resourcesPath` when packaged or to `native/proc-audio-capture/target/release/` in dev.

## Architecture

WebIce is an Electron + Svelte 5 desktop app that captures mic + system audio, runs a Web Audio effects chain in the renderer, and streams encoded output to Icecast (and optionally HLS) from the main process.

**Two-process split — this is the key mental model:**

- **Renderer (`src/`)** owns all audio DSP via Web Audio API. `src/lib/audio/engine.ts` (`AudioEngine`) builds the node graph: mic `MediaStreamAudioSourceNode` + N per-process PCM-player `AudioWorkletNode`s (one per captured PID) → per-source gain → ducking → effects chain (boost, noise-gate worklet, compressor, presence EQ, megaphone filters, convolver reverb, limiter) → master → `pcmCapture` AudioWorklet that emits raw f32 PCM frames. State lives in `src/lib/stores/app-store.svelte.ts` (Svelte 5 runes). Components in `src/lib/components/` are thin views over the engine + store.
- **Main (`electron/`)** owns everything that isn't DSP: spawning ffmpeg, Icecast SOURCE client, file I/O, settings persistence, dialogs, listener polling, and spawning the per-process capture sidecar. `proc-capture.ts` (`ProcCaptureManager`) runs one `proc-audio-capture.exe` child per target PID in include mode (and exactly one in exclude mode, since WASAPI process loopback accepts only one target PID per client). `ipc-handlers.ts` is the central IPC surface — every renderer↔main interaction is registered here.
- **Native sidecar (`native/proc-audio-capture/`)** — Rust binary using the `wasapi` crate's `AudioClient::new_application_loopback_client(pid, include_tree)`. Emits raw f32le stereo 48 kHz PCM on stdout, one JSON status object per line on stderr. The `list` subcommand enumerates audio sessions on the default render device. `process.pid` of the Electron app is NOT excluded by default — the UI's exclude-mode default list is empty.

**Audio data flow (hot paths):**

- **Output path:** Renderer's `pcmCapture` worklet → `ipcRenderer.send('audio:data', ArrayBuffer)` → `ipc-handlers.ts` writes the buffer to both `Encoder` and `HlsEncoder` (both in `electron/encoder.ts`). `Encoder` pipes f32le PCM into ffmpeg stdin with codec args chosen by format (mp3/ogg/aac/opus/flac) and emits encoded chunks on `'data'`, which are fanned out to `IcecastClient.send()` and the optional recording `WriteStream`. `HlsEncoder` is an independent ffmpeg instance writing segmented output to disk.
- **System audio input path:** `proc-audio-capture.exe` stdout (f32le interleaved stereo 48 kHz) → `ProcCaptureManager` tags each chunk with its PID → `mainWindow.webContents.send('syscap:pcm', {pid, buffer})` → renderer's `onSyscapPcm` listener forwards each chunk to `AudioEngine.pushSysPcm(pid, buffer)`, which auto-creates (if absent) an `AudioWorkletNode` instance of `sys-pcm-player-processor` for that PID and transfers the ArrayBuffer into it. Each worklet has its own 1 s ring buffer and connects to `sysInputGain` so Web Audio sums them into the mix automatically.

**Icecast client (`electron/icecast.ts`):** Raw TCP SOURCE protocol (no library). Emits `connected`/`disconnected`/`reconnecting`/`error` which `ipc-handlers.ts` forwards to the renderer as `status:update` messages. Listener counts are polled every 10s from `/status-json.xsl` on the target server and pushed via the same status channel.

**IPC conventions:** Renderer calls `window.api.*` (exposed in `preload.ts`). Status updates are one-way main→renderer on the `status:update` channel — treat this as the single source of truth for streaming state in the UI. Global shortcuts (`Ctrl+Shift+M` mute sys, `Ctrl+Shift+D` momentary duck, `Ctrl+Shift+S` toggle screen reader in the syscap list) are registered in `main.ts` and dispatched to the renderer via the `'shortcut'` channel.

**Per-process capture channels:** `syscap:list` (invoke, returns sessions), `syscap:set-targets` (invoke, `{mode, pids}`), `syscap:stop` (invoke), `syscap:screen-reader-pid` (invoke, returns PID of NVDA/JAWS/Narrator on Windows or VoiceOver on mac). Main→renderer: `syscap:pcm` (streamed audio) and `syscap:ended` (a sidecar exited).

**Settings** persist to `app.getPath('userData')/webice-settings.json` via `settings:load` / `settings:save` / `settings:save-sync` (the sync variant exists for shutdown-time saves).

## Conventions

- Svelte 5 runes (`$state`, `$derived`, `$effect`) — not the legacy store API. `app-store.svelte.ts` is the pattern to follow.
- Preload is built as CJS (`preload.cjs`) while main and renderer are ESM — see `vite.config.ts`. Don't change this without understanding why.
- When adding an IPC channel, register it in `electron/ipc-handlers.ts` AND expose it through `electron/preload.ts`; there is no auto-binding.
- Error surfacing: main-process errors should go out via `sendStatus({ error: ... })` rather than throwing across the IPC boundary, so the StatusBar can display them.
