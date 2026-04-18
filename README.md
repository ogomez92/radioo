# Radioo

A desktop audio broadcaster for Windows. Capture a microphone and system audio, run them through a live effects chain, and stream the mix to an Icecast server (and optionally record to disk or write HLS segments at the same time).

Built with Electron + Svelte 5. All DSP runs in the browser via the Web Audio API; ffmpeg handles encoding.

## What it does

- **Two sources**: pick any microphone and capture system audio loopback (no picker dialog — it's auto-granted).
- **Live effects chain** on the mic: input boost, noise gate, compressor, presence EQ, megaphone/telephone filters, convolver reverb (load your own impulse response), and a brickwall limiter.
- **Auto-ducking**: music level drops automatically while you talk, or hold `Ctrl+Shift+D` to duck manually.
- **Music player**: load a local audio file and play it into the mix. A short beep warns you ~15s before the track ends.
- **Disconnect alert**: a continuous 1s beep plays on your speakers whenever the stream disconnects, for any reason (manual stop, server drop, error).
- **Streaming**: Icecast SOURCE protocol over raw TCP — mp3, ogg/vorbis, aac, opus, or flac. Listener count polled every 10s.
- **Recording**: save the encoded stream to a file while broadcasting.
- **HLS output**: optionally write segmented HLS to a local directory.
- **Multilingual UI**: English, Spanish, Portuguese, French, German, Italian, Japanese.

## Requirements

- Windows 10/11 (the provided build targets `win-x64`).
- `ffmpeg` on `PATH` at runtime. A bundled copy is included in the unpacked build under `resources/ffmpeg/`.

## Running

Grab the latest `win-unpacked` build and run `Radioo.exe`. No installer.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+M` | Toggle mic mute |
| `Ctrl+Shift+M` | Toggle system-audio mute (global) |
| `Ctrl+D` | Toggle auto-ducking |
| `Ctrl+Shift+D` | Momentary duck (hold) — global |
| `Ctrl+S` | Start/stop streaming |
| `Ctrl+R` | Start/stop recording |

## Developing

```bash
pnpm install
pnpm dev          # Vite + Electron with hot reload
pnpm build        # production renderer + main bundles
pnpm dist:win     # zipped Windows build via electron-builder
```

Unpacked build (no zip):

```bash
pnpm build
pnpm exec electron-builder --win --dir
# output: release/win-unpacked/Radioo.exe
```

## Architecture

Two-process split:

- **Renderer** (`src/`) owns the Web Audio graph and UI. Mic and system streams hit per-source gains, then the ducking stage, effects chain, master bus, and a PCM capture worklet that emits raw f32 frames.
- **Main** (`electron/`) owns ffmpeg, the Icecast client, file I/O, settings, and dialogs. PCM frames arrive over IPC and are piped into ffmpeg stdin; encoded output is fanned out to the Icecast socket and (optionally) a recording file.

Settings persist to `%APPDATA%/Radioo/webice-settings.json`.
