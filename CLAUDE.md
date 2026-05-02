# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Use **pnpm**, not npx or npm.

- `pnpm dev` — Vite dev server; `vite-plugin-electron` auto-builds `electron/main.ts` + `preload.ts` and launches Electron against the dev URL.
- `pnpm build` — Production build of renderer (`dist/`) and main/preload (`dist-electron/`).
- `pnpm build:sidecar` — Builds the Rust per-process capture sidecar and copies it into `resources/proc-audio-capture/`. Run this at least once before `pnpm dev` or `pnpm dist:win`.
- `pnpm check` — `svelte-check` type check across the project.
- `pnpm test` — vitest run (sidecar IPC, audio worklet, app store, i18n, listener poll). `pnpm test:watch` for TDD; `pnpm vitest run <path>` to scope to a single file.

`ffmpeg` must be available on `PATH` at runtime — the encoder spawns it as a child process. `proc-audio-capture.exe` (the WASAPI sidecar) ships inside `resources/proc-audio-capture/` and is resolved relative to `process.resourcesPath` when packaged or to `native/proc-audio-capture/target/release/` in dev.

## Architecture

WebIce is an Electron + Svelte 5 desktop app that captures mic + system audio, runs a Web Audio effects chain in the renderer, and streams encoded output to Icecast (and optionally HLS) from the main process.

**Two-process split — this is the key mental model:**

- **Renderer (`src/`)** owns all audio DSP via Web Audio API. `src/lib/audio/engine.ts` (`AudioEngine`) builds the node graph: mic `MediaStreamAudioSourceNode` + N per-process PCM-player `AudioWorkletNode`s (one per captured PID) → per-source gain → ducking → effects chain (boost, noise-gate worklet, compressor, presence EQ, megaphone filters, convolver reverb, limiter) → master → `pcmCapture` AudioWorklet that emits raw f32 PCM frames. State lives in `src/lib/stores/app-store.svelte.ts` (Svelte 5 runes). Components in `src/lib/components/` are thin views over the engine + store.
- **Main (`electron/`)** owns everything that isn't DSP: spawning ffmpeg, Icecast SOURCE client, file I/O, settings persistence, dialogs, listener polling, and spawning the per-process capture sidecar. `proc-capture.ts` (`ProcCaptureManager`) runs one `proc-audio-capture.exe` child per target PID in include mode (and exactly one in 'all'/exclude mode, since WASAPI process loopback accepts only one target PID per client). In 'all' mode it passes `--exclude-pid <mainWindow.webContents.getOSProcessId()>` so the renderer's own audio (monitor beeps) never enters the capture; it also filters sessions whose `process_name` matches `path.basename(process.execPath)` from `listSessions()`, keeping the app out of the picker UI. `ipc-handlers.ts` is the central IPC surface — every renderer↔main interaction is registered here. `main.ts` installs a file logger that mirrors main-process `console.*` and renderer `console-message` events to `%APPDATA%/Radioo/radioo-debug.log` — use it when the user reports an issue and can't access DevTools.
- **Native sidecar (`native/proc-audio-capture/`)** — Rust binary using the `wasapi` crate's `AudioClient::new_application_loopback_client(pid, include_tree)`. Emits raw f32le stereo 48 kHz PCM on stdout, one JSON status object per line on stderr. The `list` subcommand enumerates audio sessions on the default render device. `--capture-all` (no PID) uses a sentinel that switches the sidecar to plain WASAPI system-wide loopback; it's only reached as a fallback when the renderer's OS PID can't be resolved.

**Audio data flow (hot paths):**

- **Output path:** Renderer's `pcmCapture` worklet → `ipcRenderer.send('audio:data', ArrayBuffer)` → `ipc-handlers.ts` writes the buffer to both `Encoder` and `HlsEncoder` (both in `electron/encoder.ts`). `Encoder` pipes f32le PCM into ffmpeg stdin with codec args chosen by format (mp3/ogg/aac/opus/flac) and emits encoded chunks on `'data'`, which are fanned out to `IcecastClient.send()` and the optional recording `WriteStream`. `HlsEncoder` is an independent ffmpeg instance writing segmented output to disk.
- **System audio input path:** `proc-audio-capture.exe` stdout (f32le interleaved stereo 48 kHz) → `ProcCaptureManager` re-aligns each pipe read to 8-byte (stereo f32) frame boundaries via `stdoutRemainder` — Node's `'data'` events don't respect frame boundaries, and an odd-byte buffer crashes `new Float32Array()` inside the worklet — then tags each chunk with its PID → `mainWindow.webContents.send('syscap:pcm', {pid, buffer})` → renderer's `onSyscapPcm` listener forwards each chunk to `AudioEngine.pushSysPcm(pid, buffer)`, which auto-creates (if absent) an `AudioWorkletNode` instance of `sys-pcm-player-processor` for that PID and transfers the ArrayBuffer into it. Each worklet has its own 1 s ring buffer, 100 ms prebuffer before draining, and connects to `sysInputGain` so Web Audio sums them into the mix automatically.

**Icecast client (`electron/icecast.ts`):** Raw TCP SOURCE protocol (no library). Emits `connected`/`disconnected`/`reconnecting`/`error` which `ipc-handlers.ts` forwards to the renderer as `status:update` messages. Listener counts are polled every 10s from `/status-json.xsl` on the target server and pushed via the same status channel.

**IPC conventions:** Renderer calls `window.api.*` (exposed in `preload.ts`). Status updates are one-way main→renderer on the `status:update` channel — treat this as the single source of truth for streaming state in the UI. Global shortcuts registered in `main.ts` (dispatched via the `'shortcut'` channel): `Ctrl+Shift+M` mute sys, `Ctrl+Shift+D` momentary duck, `Ctrl+Shift+S` toggle screen reader, `Ctrl+I`/`Ctrl+K` music volume ±5%. Window-focus-only shortcuts live in `App.svelte` `handleKeyDown`: `Ctrl+M` mic mute, `Ctrl+D` auto-duck toggle, `Ctrl+S` start/stop stream, `Ctrl+R` start/stop recording, `Ctrl+O` open music, `Ctrl+P` play/pause, `Ctrl+L` announce listener count, `Ctrl+Shift+R` announce music progress, `Ctrl+Shift+C` announce mic status on demand (silence detection still runs, but only announces when asked).

**Per-process capture channels:** `syscap:supported` (invoke, boolean), `syscap:list` (invoke, returns sessions — already filters out the app itself), `syscap:set-targets` (invoke, `{mode, pids}`), `syscap:stop` (invoke), `syscap:screen-reader-pid` (invoke, returns PID of NVDA/JAWS/Narrator on Windows or VoiceOver on mac). Main→renderer: `syscap:pcm` (streamed audio) and `syscap:ended` (a sidecar exited).

**Settings** persist to `app.getPath('userData')/webice-settings.json` via `settings:load` / `settings:save` / `settings:save-sync` (the sync variant exists for shutdown-time saves).

## Conventions

- Svelte 5 runes (`$state`, `$derived`, `$effect`) — not the legacy store API. `app-store.svelte.ts` is the pattern to follow. For `<input>` controls bound to store state, prefer `bind:value` over `value={…}` + `oninput` — the one-way form desyncs when the DOM property and attribute diverge (this is how music volume silently reset to 0 once).
- Preload is built as CJS (`preload.cjs`) while main and renderer are ESM — see `vite.config.ts`. Don't change this without understanding why.
- When adding an IPC channel, register it in `electron/ipc-handlers.ts` AND expose it through `electron/preload.ts`; there is no auto-binding.
- Error surfacing: main-process errors should go out via `sendStatus({ error: ... })` rather than throwing across the IPC boundary, so the StatusBar can display them.
- User-facing strings: add to every file under `src/lib/i18n/messages/` (en, es, pt, fr, de, it, ja). `i18n.test.ts` asserts key parity; missing keys fail CI.
