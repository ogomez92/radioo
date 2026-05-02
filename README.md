# Radioo

A desktop audio broadcaster for Windows. Capture a microphone and system audio, run them through a live effects chain, and stream the mix to an Icecast server (and optionally record to disk or write HLS segments at the same time).

Built with Electron + Svelte 5. All DSP runs in the browser via the Web Audio API; ffmpeg handles encoding.

## What it does

- **Two sources**: pick any microphone and capture system audio.
- **Per-process system audio**: instead of grabbing everything that plays on the default output, target specific apps. Three modes — **All** (everything except Radioo itself), **Include** (only these processes), **Exclude** (everything except these processes). A native WASAPI sidecar (`proc-audio-capture.exe`) does the capture; Radioo auto-excludes its own renderer so monitor beeps don't leak into the stream, and hides itself from the process list.
- **Live effects chain** on the mic: input boost, noise gate, compressor, presence EQ, megaphone/telephone filters, convolver reverb (load your own impulse response), and a brickwall limiter.
- **Auto-ducking**: music and system audio drop automatically while you talk, or hold `Ctrl+Shift+D` to duck manually.
- **Music player**: load a local audio file and play it into the mix. A short beep warns you ~15s before the track ends.
- **Disconnect alert**: a continuous 1s beep plays on your speakers whenever the stream disconnects, for any reason (manual stop, server drop, error).
- **Streaming**: Icecast SOURCE protocol over raw TCP — mp3, ogg/vorbis, aac, opus, or flac. Listener count polled every 10s.
- **Recording**: save the encoded stream to a file while broadcasting.
- **HLS output**: optionally write segmented HLS to a local directory.
- **Multilingual UI**: English, Spanish, Portuguese, French, German, Italian, Japanese.
- **Accessible process picker**: the "Add process" dialog is a proper listbox — ↑/↓ to navigate, Space to toggle, Enter to apply, Escape to cancel.

## Requirements

- Windows 10/11 (the provided build targets `win-x64`).
- `ffmpeg` on `PATH` at runtime. A bundled copy is included in the unpacked build under `resources/ffmpeg/`.

## Running

Grab the latest `win-unpacked` build and run `Radioo.exe`. No installer.

## Keyboard shortcuts

Global shortcuts (marked ★) fire even when Radioo isn't focused.

| Shortcut | Action |
| --- | --- |
| `Ctrl+M` | Toggle mic mute |
| `Ctrl+Shift+M` ★ | Toggle system-audio capture on/off |
| `Ctrl+D` | Toggle auto-ducking |
| `Ctrl+Shift+D` ★ | Momentary duck (hold) |
| `Ctrl+S` | Start/stop streaming |
| `Ctrl+R` | Start/stop recording |
| `Ctrl+O` | Open a music file |
| `Ctrl+P` | Play / pause music |
| `Ctrl+I` ★ | Music volume up (+5%) |
| `Ctrl+K` ★ | Music volume down (−5%) |
| `Ctrl+Shift+R` | Announce music progress (time remaining) |
| `Ctrl+Shift+C` | Announce current mic status (no device / muted / silent / live) |
| `Ctrl+L` | Announce current listener count |
| `Ctrl+Shift+S` ★ | Toggle screen-reader process in the capture list (adds/removes NVDA/JAWS/Narrator) |

In the **Add process** dialog: `↑`/`↓` to move, `Home`/`End` for ends, `Space` to toggle, `Enter` to apply, `Esc` to cancel.

## Developing

```bash
pnpm install
pnpm build:sidecar   # builds native/proc-audio-capture (Rust) — needed once before pnpm dev
pnpm dev             # Vite + Electron with hot reload
pnpm build           # production renderer + main bundles
pnpm dist:win        # zipped Windows build via electron-builder
pnpm test            # vitest suite (audio worklet, IPC, store, i18n, sidecar)
```

Building the sidecar requires a Rust toolchain (`rustup default stable`). The binary lands in `native/proc-audio-capture/target/release/proc-audio-capture.exe` and is copied into `resources/proc-audio-capture/` for packaging.

Unpacked build (no zip):

```bash
pnpm build
pnpm exec electron-builder --win --dir
# output: release/win-unpacked/Radioo.exe
```

## Architecture

Three-process split:

- **Renderer** (`src/`) owns the Web Audio graph and UI. Mic plus one worklet per captured PID feed into per-source gains, then the ducking stage, effects chain, master bus, and a PCM capture worklet that emits raw f32 frames.
- **Main** (`electron/`) owns ffmpeg, the Icecast client, file I/O, settings, dialogs, listener polling, and the sidecar lifecycle. PCM frames from the renderer arrive over IPC and are piped into ffmpeg stdin; encoded output is fanned out to the Icecast socket and (optionally) a recording file. In 'all' mode it passes the renderer's OS PID to the sidecar as `--exclude-pid` so the app's own audio never reaches the capture.
- **Sidecar** (`native/proc-audio-capture/`, Rust) runs `AudioClient::new_application_loopback_client` and writes raw f32le stereo 48 kHz PCM to stdout with JSON status on stderr. One child per captured PID in include mode; a single child in all/exclude mode.

Settings persist to `%APPDATA%/Radioo/webice-settings.json`. A debug log (both main and renderer console output) is written to `%APPDATA%/Radioo/radioo-debug.log`.
