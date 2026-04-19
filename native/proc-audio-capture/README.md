# proc-audio-capture

Sidecar binary that does per-process audio capture on Windows and streams raw f32le
PCM to stdout. The renderer side of Radioo can consume that PCM the same way it
already consumes mic / system-loopback streams, and the main process can pipe it
into the existing `Encoder` / `HlsEncoder` pipeline.

## Platform support

| OS       | Status         | Backend                                                 |
| -------- | -------------- | ------------------------------------------------------- |
| Windows  | Implemented    | WASAPI process loopback (needs Windows 10 build 20348+) |
| macOS    | Not yet        | Will use ScreenCaptureKit (`SCStream` content filter)   |
| Linux    | Not planned    | PipeWire/PulseAudio can do this natively — no sidecar   |

Windows is the priority; the macOS backend can be added under a `#[cfg(target_os = "macos")]`
module using the `screencapturekit` crate, which exposes `SCContentFilter`'s
`excludingApplications:` / `includingApplications:`.

## Build

```sh
cargo build --release
```

Produces `target/release/proc-audio-capture.exe`. Copy it into
`resources/proc-audio-capture/` next to `resources/ffmpeg/ffmpeg.exe` so
electron-builder bundles it as an extra resource.

## CLI

```
proc-audio-capture --include-pid <PID>    # capture only this PID + children
proc-audio-capture --exclude-pid <PID>    # capture everything except this PID + children
proc-audio-capture list                   # JSON-print audio sessions to stdout
```

Optional flags:

- `--sample-rate <Hz>` — default `48000`
- `--channels <N>` — default `2`
- `--chunk-frames <N>` — bytes per stdout write, default `480` (10 ms @ 48 kHz)

## Protocol

**stdout:** raw interleaved f32 little-endian PCM. Nothing else. Close the pipe to
stop the capture cleanly.

**stderr:** one JSON object per line. The first line is always:

```json
{"type":"ready","sample_rate":48000,"channels":2,"format":"f32le","mode":"include_tree","pid":12345,"chunk_frames":480}
```

Errors are `{"type":"error","message":"…"}` and cause the process to exit non-zero.

## Wiring into Radioo (sketch)

```ts
// electron/proc-capture.ts
import { spawn } from 'node:child_process';
import { app } from 'electron';
import path from 'node:path';

const bin = app.isPackaged
  ? path.join(process.resourcesPath, 'proc-audio-capture', 'proc-audio-capture.exe')
  : path.resolve('native/proc-audio-capture/target/release/proc-audio-capture.exe');

export function startProcCapture(pid: number, mode: 'include' | 'exclude') {
  const child = spawn(bin, [
    mode === 'include' ? '--include-pid' : '--exclude-pid',
    String(pid),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  child.stderr.setEncoding('utf8').on('data', line => {
    for (const l of line.split('\n').filter(Boolean)) {
      try { handleStatus(JSON.parse(l)); } catch {}
    }
  });

  child.stdout.on('data', (buf: Buffer) => {
    // 32-bit float little-endian, stereo interleaved, 48 kHz.
    // Feed into Encoder/HlsEncoder the same way `audio:data` does today.
  });

  return child;
}
```

On the renderer side, the list subcommand can be invoked via a new IPC channel
(e.g. `procCapture:list`) so the UI can render a picker. The selected PID and
mode then go back to the main process via `procCapture:start`.

## Caveats

- **GetMixFormat / GetDevicePeriod are not supported** on process-loopback
  AudioClients — we use a fixed 20 ms buffer and fixed output format with
  autoconvert on.
- **Exclude mode excludes the target and its children.** If the target has no
  children and nothing else is playing, you get silence — which is correct,
  not a bug.
- **Silent sessions still deliver buffers.** When the target is muted or not
  producing audio, the capture yields all-zero frames at the normal rate. The
  timer/clock stays in sync.
- **Process discovery is not exhaustive.** `list` enumerates sessions on the
  default render device only. Processes without an active audio session won't
  appear. A richer picker should fall back to `EnumProcesses` and filter by
  recent audio activity.
