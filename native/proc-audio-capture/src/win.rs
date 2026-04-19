use std::collections::VecDeque;
use std::error::Error;
use std::io::Write;

use wasapi::{
    initialize_mta, AudioClient, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat,
};

use crate::emit_status;

type Res<T> = Result<T, Box<dyn Error>>;

/// Queries the default render endpoint for its native mix sample rate.
/// Process-loopback clients can't report their own mix format (GetMixFormat
/// returns E_NOTIMPL there), so we read it from the regular IAudioClient on
/// the same endpoint, which is allowed and returns the actual rate Windows
/// is driving the hardware at.
unsafe fn default_render_mix_rate() -> Option<u32> {
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoTaskMemFree, CLSCTX_ALL,
    };
    let enumerator: IMMDeviceEnumerator =
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
    let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
    let client: IAudioClient = device.Activate(CLSCTX_ALL, None).ok()?;
    let fmt_ptr = client.GetMixFormat().ok()?;
    if fmt_ptr.is_null() { return None; }
    let rate = (*fmt_ptr).nSamplesPerSec;
    CoTaskMemFree(Some(fmt_ptr as *const _));
    let _ = client;
    Some(rate)
}

/// Linear-interpolation resampler. Good enough for broadcast; saves the
/// cost of pulling in a proper resampler for what's usually a no-op
/// (native rate == target rate on most modern Windows setups).
fn resample_linear_f32(
    input: &[f32],
    in_rate: u32,
    out_rate: u32,
    channels: usize,
) -> Vec<f32> {
    if in_rate == out_rate || input.is_empty() {
        return input.to_vec();
    }
    let frames_in = input.len() / channels;
    if frames_in == 0 {
        return Vec::new();
    }
    let ratio = in_rate as f64 / out_rate as f64;
    let frames_out = ((frames_in as f64) / ratio).floor() as usize;
    let mut out = Vec::with_capacity(frames_out * channels);
    for i in 0..frames_out {
        let pos = i as f64 * ratio;
        let idx = pos.floor() as usize;
        let frac = (pos - idx as f64) as f32;
        let idx_next = (idx + 1).min(frames_in - 1);
        for c in 0..channels {
            let a = input[idx * channels + c];
            let b = input[idx_next * channels + c];
            out.push(a + (b - a) * frac);
        }
    }
    out
}

/// Sentinel PID passed by `--capture-all`. We recognise it here and switch
/// from process-loopback to plain system-wide loopback — process-loopback's
/// exclude-tree mode requires the target PID to be a live audio-rendering
/// process, which we can't reliably guarantee.
pub const CAPTURE_ALL_SENTINEL: u32 = 0xFFFF_FFFE;

pub fn capture(
    pid: u32,
    include_tree: bool,
    sample_rate: u32,
    channels: u16,
    chunk_frames: u32,
) -> Res<()> {
    initialize_mta().ok()?;

    // Capture at the endpoint's native rate so WASAPI doesn't have to
    // autoconvert on the loopback path (where autoconvert is flaky).
    // Then resample to the renderer's target rate ourselves.
    let native_rate = unsafe { default_render_mix_rate() }.unwrap_or(sample_rate);
    let capture_format = WaveFormat::new(
        32,
        32,
        &SampleType::Float,
        native_rate as usize,
        channels as usize,
        None,
    );
    let blockalign_in = capture_format.get_blockalign() as usize;
    let chan = channels as usize;

    let mut audio_client = if pid == CAPTURE_ALL_SENTINEL {
        // Plain WASAPI loopback on the default render endpoint. Calling
        // initialize_client() below with Direction::Capture on a Render
        // device makes wasapi-rs set AUDCLNT_STREAMFLAGS_LOOPBACK
        // automatically, giving us system-wide capture with no per-process
        // filtering quirks.
        let enumerator = DeviceEnumerator::new()?;
        let device = enumerator.get_default_device(&Direction::Render)?;
        device.get_iaudioclient()?
    } else {
        AudioClient::new_application_loopback_client(pid, include_tree)?
    };
    let mode = StreamMode::EventsShared {
        autoconvert: false,
        buffer_duration_hns: 200_000,
    };
    audio_client.initialize_client(&capture_format, &Direction::Capture, &mode)?;

    let h_event = audio_client.set_get_eventhandle()?;
    let capture_client = audio_client.get_audiocaptureclient()?;

    emit_status(
        "ready",
        serde_json::json!({
            "sample_rate": sample_rate,
            "native_sample_rate": native_rate,
            "channels": channels,
            "format": "f32le",
            "mode": if include_tree { "include_tree" } else { "exclude_tree" },
            "pid": pid,
            "chunk_frames": chunk_frames,
        }),
    );

    audio_client.start_stream()?;

    let mut sample_queue: VecDeque<u8> =
        VecDeque::with_capacity(blockalign_in * (chunk_frames as usize) * 8);
    // Capture chunk sized in native-rate frames; we resample afterwards.
    // Use a slightly bigger native chunk so a single resampled chunk always
    // yields at least `chunk_frames` output frames, smoothing pacing.
    let native_chunk_frames = ((chunk_frames as u64) * (native_rate as u64) / (sample_rate as u64)) as usize;
    let chunk_bytes = blockalign_in * native_chunk_frames.max(1);
    let mut chunk_in = vec![0u8; chunk_bytes];
    let mut chunk_floats: Vec<f32> = vec![0.0; native_chunk_frames.max(1) * chan];

    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();

    const WAIT_MS: u32 = 30_000;

    // Reused scratch buffer for the byte-serialised resampled output;
    // avoids allocating a fresh Vec every 50 ms chunk.
    let mut out_bytes: Vec<u8> = Vec::with_capacity(blockalign_in * (chunk_frames as usize + 16));
    let same_rate = native_rate == sample_rate;

    loop {
        capture_client.read_from_device_to_deque(&mut sample_queue)?;

        while sample_queue.len() >= chunk_bytes {
            for b in chunk_in.iter_mut() {
                *b = sample_queue.pop_front().expect("queue len checked above");
            }

            if same_rate {
                // Fast path — no resampling, no float ↔ byte roundtrip.
                if stdout.write_all(&chunk_in).is_err() {
                    let _ = audio_client.stop_stream();
                    return Ok(());
                }
                continue;
            }

            // Interpret the captured bytes as f32 little-endian.
            for (i, s) in chunk_floats.iter_mut().enumerate() {
                let base = i * 4;
                *s = f32::from_le_bytes([
                    chunk_in[base],
                    chunk_in[base + 1],
                    chunk_in[base + 2],
                    chunk_in[base + 3],
                ]);
            }

            let resampled = resample_linear_f32(&chunk_floats, native_rate, sample_rate, chan);

            out_bytes.clear();
            out_bytes.reserve(resampled.len() * 4);
            for s in &resampled {
                out_bytes.extend_from_slice(&s.to_le_bytes());
            }
            if stdout.write_all(&out_bytes).is_err() {
                let _ = audio_client.stop_stream();
                return Ok(());
            }
        }

        let _ = h_event.wait_for_event(WAIT_MS);
    }
}

pub fn list_sessions() -> Res<()> {
    use windows::core::Interface;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
        MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
    };

    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;

        let result: Res<()> = (|| {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
            let manager: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None)?;
            let session_enum = manager.GetSessionEnumerator()?;
            let count = session_enum.GetCount()?;

            // A single process can own multiple audio sessions (e.g., foobar2000
            // opens one per output stream). The renderer only cares about PIDs,
            // so dedupe here and keep the "best" row per PID: prefer active
            // (state 1) over inactive (0) over expired (2), and a non-empty
            // display_name over an empty one.
            use std::collections::HashMap;
            let state_rank = |s: i32| -> i32 {
                match s {
                    1 => 2, // active
                    0 => 1, // inactive
                    _ => 0, // expired / other
                }
            };

            let mut by_pid: HashMap<u32, (i32, String, String)> = HashMap::new();
            // order preserves insertion so the UI stays stable across polls
            let mut order: Vec<u32> = Vec::new();
            for i in 0..count {
                let ctrl = session_enum.GetSession(i)?;
                let ctrl2: IAudioSessionControl2 = ctrl.cast()?;
                let pid = ctrl2.GetProcessId().unwrap_or(0);
                let state = ctrl.GetState().map(|s| s.0).unwrap_or(0);
                let display_name = ctrl2
                    .GetDisplayName()
                    .ok()
                    .and_then(|p| p.to_string().ok())
                    .unwrap_or_default();
                let process_name = read_process_name(pid).unwrap_or_default();
                let _ = i;

                match by_pid.get_mut(&pid) {
                    None => {
                        by_pid.insert(pid, (state, process_name, display_name));
                        order.push(pid);
                    }
                    Some(existing) => {
                        let better_state = state_rank(state) > state_rank(existing.0);
                        let better_name = existing.2.is_empty() && !display_name.is_empty();
                        if better_state || better_name {
                            existing.0 = state;
                            if !display_name.is_empty() { existing.2 = display_name; }
                            if !process_name.is_empty() && existing.1.is_empty() {
                                existing.1 = process_name;
                            }
                        }
                    }
                }
            }

            let sessions: Vec<serde_json::Value> = order
                .into_iter()
                .filter_map(|pid| {
                    by_pid.remove(&pid).map(|(state, process_name, display_name)| {
                        serde_json::json!({
                            "pid": pid,
                            "process_name": process_name,
                            "display_name": display_name,
                            "state": state,
                        })
                    })
                })
                .collect();

            println!("{}", serde_json::json!({ "sessions": sessions }));
            Ok(())
        })();

        CoUninitialize();
        result
    }
}

unsafe fn read_process_name(pid: u32) -> Option<String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    if pid == 0 {
        return None;
    }
    let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
    if handle.is_invalid() {
        return None;
    }
    let mut buf = [0u16; 1024];
    let mut len: u32 = buf.len() as u32;
    let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
    let _ = CloseHandle(handle);
    if !ok || len == 0 {
        return None;
    }
    let full = String::from_utf16_lossy(&buf[..len as usize]);
    Some(full.rsplit(['\\', '/']).next().unwrap_or(&full).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resample_is_noop_when_rates_match() {
        let input: Vec<f32> = (0..100).map(|i| i as f32).collect();
        let out = resample_linear_f32(&input, 48000, 48000, 2);
        assert_eq!(out, input);
    }

    #[test]
    fn resample_downsample_halves_frame_count() {
        // 10 stereo frames = 20 samples. 48000 → 24000 means frames / 2.
        let input: Vec<f32> = (0..20).map(|i| i as f32).collect();
        let out = resample_linear_f32(&input, 48000, 24000, 2);
        // 10 input frames, ratio 2.0 → 5 output frames = 10 samples.
        assert_eq!(out.len(), 10);
    }

    #[test]
    fn resample_upsample_doubles_frame_count() {
        // 10 stereo frames upsampled 24000 → 48000 should yield ~20 frames.
        let input: Vec<f32> = (0..20).map(|i| i as f32).collect();
        let out = resample_linear_f32(&input, 24000, 48000, 2);
        // ratio 0.5, frames_out = 10/0.5 = 20 frames = 40 samples.
        assert_eq!(out.len(), 40);
    }

    #[test]
    fn resample_preserves_endpoints_for_linear_input() {
        // A mono ramp; linear interpolation of a linear ramp is lossless.
        let input: Vec<f32> = (0..10).map(|i| i as f32).collect();
        let out = resample_linear_f32(&input, 44100, 48000, 1);
        // First sample is input[0].
        assert!((out[0] - 0.0).abs() < 1e-5);
        // Interpolated samples should lie on the same line.
        for (i, &v) in out.iter().enumerate() {
            let expected = (i as f64) * (44100.0 / 48000.0);
            assert!((v as f64 - expected).abs() < 1e-4, "i={i} v={v} exp={expected}");
        }
    }

    #[test]
    fn resample_handles_empty_input() {
        let out = resample_linear_f32(&[], 48000, 44100, 2);
        assert!(out.is_empty());
    }
}
