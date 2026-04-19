//! macOS backend — stubbed.
//!
//! The macOS equivalent of Windows process-loopback lives in ScreenCaptureKit
//! (`SCStream` + `SCContentFilter` with `excludingApplications:` /
//! `includingApplications:`, via `SCStreamConfiguration.capturesAudio = true`).
//! A future implementation should:
//!
//!   1. Enumerate `SCShareableContent.applications` and map them to PIDs via
//!      `SCRunningApplication.processID` — that's what `list_sessions` returns.
//!   2. Build an `SCContentFilter` that picks a display and either excludes
//!      the target application (`include_tree == false`) or includes it
//!      exclusively (`include_tree == true`).
//!   3. Open an `SCStream` with `capturesAudio = true` at the caller's sample
//!      rate / channel count, set an output handler for
//!      `SCStreamOutputType.audio`, and pump the `CMSampleBuffer`'s
//!      `AudioBufferList` through to stdout as interleaved f32le.
//!
//! The `screencapturekit` crate wraps most of this, but the audio-buffer
//! extraction path still needs a bit of CoreAudio / CoreMedia glue. Kept as a
//! compile-clean stub until someone on a Mac wires it up.

use std::error::Error;

type Res<T> = Result<T, Box<dyn Error>>;

pub fn capture(
    _pid: u32,
    _include_tree: bool,
    _sample_rate: u32,
    _channels: u16,
    _chunk_frames: u32,
) -> Res<()> {
    Err("macOS backend not yet implemented — see src/mac.rs for the plan.".into())
}

pub fn list_sessions() -> Res<()> {
    Err("macOS backend not yet implemented — see src/mac.rs for the plan.".into())
}
