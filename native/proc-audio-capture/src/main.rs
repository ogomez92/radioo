//! Per-process loopback capture sidecar for Radioo.
//!
//! Streams raw f32le PCM from stdout. Status/errors on stderr as one JSON object per line.

use clap::{Parser, Subcommand};
use std::error::Error;

#[cfg(windows)]
mod win;
#[cfg(target_os = "macos")]
mod mac;

#[cfg(windows)]
use win as backend;
#[cfg(target_os = "macos")]
use mac as backend;

#[derive(Parser)]
#[command(
    name = "proc-audio-capture",
    version,
    about = "Per-process WASAPI loopback capture. Writes raw f32le PCM to stdout."
)]
struct Cli {
    #[command(subcommand)]
    cmd: Option<Cmd>,

    /// Capture only audio from this PID and its child processes.
    #[arg(long, conflicts_with_all = ["exclude_pid", "capture_all"])]
    include_pid: Option<u32>,

    /// Capture everything except this PID and its child processes.
    #[arg(long, conflicts_with = "capture_all")]
    exclude_pid: Option<u32>,

    /// Capture all system audio (equivalent to --exclude-pid <our-own-pid>,
    /// which is a no-op exclude since the sidecar has no audio session).
    /// This mode bypasses the quirk where excluding another process's tree
    /// can produce silence instead of the expected captured audio.
    #[arg(long, conflicts_with_all = ["include_pid", "exclude_pid"])]
    capture_all: bool,

    /// Output sample rate (Hz).
    #[arg(long, default_value_t = 48_000)]
    sample_rate: u32,

    /// Output channel count.
    #[arg(long, default_value_t = 2)]
    channels: u16,

    /// Frames per stdout write (2400 = 50 ms @ 48 kHz). Bigger = fewer IPC
    /// round-trips and less audio-thread pressure on the renderer side,
    /// at the cost of monitoring latency.
    #[arg(long, default_value_t = 2400)]
    chunk_frames: u32,
}

#[derive(Subcommand)]
enum Cmd {
    /// Enumerate audio sessions on the default render device as JSON.
    List,
}

fn build_status(kind: &str, payload: serde_json::Value) -> serde_json::Value {
    let mut obj = serde_json::Map::new();
    obj.insert("type".into(), serde_json::Value::String(kind.into()));
    if let serde_json::Value::Object(map) = payload {
        for (k, v) in map {
            obj.insert(k, v);
        }
    }
    serde_json::Value::Object(obj)
}

fn emit_status(kind: &str, payload: serde_json::Value) {
    eprintln!("{}", build_status(kind, payload));
}

fn die(msg: impl Into<String>) -> ! {
    emit_status("error", serde_json::json!({ "message": msg.into() }));
    std::process::exit(1);
}

fn main() {
    let cli = Cli::parse();

    #[cfg(any(windows, target_os = "macos"))]
    {
        let result: Result<(), Box<dyn Error>> = match cli.cmd {
            Some(Cmd::List) => backend::list_sessions(),
            None => {
                let (pid, include_tree) = if cli.capture_all {
                    // Exclude-tree with a sentinel PID that is virtually
                    // guaranteed not to exist. Empirically, excluding a live
                    // PID's tree — including our own — can cause the loopback
                    // to deliver silence; excluding a nonexistent PID captures
                    // everything on the default render endpoint.
                    const SENTINEL: u32 = 0xFFFF_FFFE;
                    (SENTINEL, false)
                } else {
                    match (cli.include_pid, cli.exclude_pid) {
                        (Some(pid), None) => (pid, true),
                        (None, Some(pid)) => (pid, false),
                        _ => die("Must pass --include-pid, --exclude-pid, --capture-all, or the `list` subcommand."),
                    }
                };
                backend::capture(pid, include_tree, cli.sample_rate, cli.channels, cli.chunk_frames)
            }
        };
        if let Err(e) = result {
            die(format!("{e}"));
        }
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = cli;
        die("Per-process loopback capture is only implemented on Windows and macOS.");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn build_status_wraps_payload_with_type() {
        let v = build_status("ready", serde_json::json!({ "pid": 42 }));
        assert_eq!(v["type"], "ready");
        assert_eq!(v["pid"], 42);
    }

    #[test]
    fn build_status_accepts_non_object_payload_as_empty() {
        let v = build_status("error", serde_json::json!("ignored"));
        assert_eq!(v["type"], "error");
        // No extra fields merged.
        assert_eq!(v.as_object().unwrap().len(), 1);
    }

    #[test]
    fn cli_parses_include_pid() {
        let cli = Cli::try_parse_from(["proc-audio-capture", "--include-pid", "1234"]).unwrap();
        assert_eq!(cli.include_pid, Some(1234));
        assert_eq!(cli.exclude_pid, None);
        assert!(cli.cmd.is_none());
    }

    #[test]
    fn cli_parses_exclude_pid() {
        let cli = Cli::try_parse_from(["proc-audio-capture", "--exclude-pid", "9999"]).unwrap();
        assert_eq!(cli.exclude_pid, Some(9999));
        assert_eq!(cli.include_pid, None);
    }

    #[test]
    fn cli_rejects_both_include_and_exclude() {
        let res = Cli::try_parse_from([
            "proc-audio-capture",
            "--include-pid", "1",
            "--exclude-pid", "2",
        ]);
        assert!(res.is_err(), "clap should reject when both are supplied");
    }

    #[test]
    fn cli_capture_all_flag_parses() {
        let cli = Cli::try_parse_from(["proc-audio-capture", "--capture-all"]).unwrap();
        assert!(cli.capture_all);
        assert_eq!(cli.include_pid, None);
        assert_eq!(cli.exclude_pid, None);
    }

    #[test]
    fn cli_rejects_capture_all_with_include() {
        let res = Cli::try_parse_from([
            "proc-audio-capture",
            "--capture-all",
            "--include-pid", "1",
        ]);
        assert!(res.is_err(), "--capture-all conflicts with --include-pid");
    }

    #[test]
    fn cli_list_subcommand_parses() {
        let cli = Cli::try_parse_from(["proc-audio-capture", "list"]).unwrap();
        assert!(matches!(cli.cmd, Some(Cmd::List)));
    }

    #[test]
    fn cli_defaults_match_renderer_expectations() {
        // These defaults must match what the renderer and electron/proc-capture.ts
        // assume: f32le stereo 48 kHz at 2400 frames per chunk (50 ms).
        let cli = Cli::try_parse_from(["proc-audio-capture", "--include-pid", "1"]).unwrap();
        assert_eq!(cli.sample_rate, 48_000);
        assert_eq!(cli.channels, 2);
        assert_eq!(cli.chunk_frames, 2400);
    }

    #[test]
    fn cli_custom_sample_rate_and_channels() {
        let cli = Cli::try_parse_from([
            "proc-audio-capture",
            "--include-pid", "1",
            "--sample-rate", "44100",
            "--channels", "1",
            "--chunk-frames", "1024",
        ]).unwrap();
        assert_eq!(cli.sample_rate, 44_100);
        assert_eq!(cli.channels, 1);
        assert_eq!(cli.chunk_frames, 1024);
    }
}
