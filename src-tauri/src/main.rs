#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;

use serde::{Deserialize, Serialize};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::{process::{CommandChild, CommandEvent}, ShellExt};

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Default)]
struct ClipProcessState {
    child: Mutex<Option<CommandChild>>,
    canceled: AtomicBool,
}

#[derive(Default)]
struct SaveDirectoryState {
    roots: Mutex<HashSet<PathBuf>>,
}

#[derive(Debug, Serialize)]
struct MediaMetadata {
    path: String,
    file_name: String,
    format: String,
    duration: f64,
    size: u64,
}

#[derive(Debug, Deserialize)]
struct ClipOptions {
    start: f64,
    end: f64,
    format: String,
    quality: String,
    /// Linear gain from 0 (mute) to 2 (200%); 1 preserves source loudness.
    #[serde(default)]
    volume: Option<f64>,
    #[serde(default)]
    output_dir: Option<String>,
}

#[derive(Debug, Serialize)]
struct ClipResult {
    path: String,
    file_name: String,
    format: String,
    duration: f64,
    size: u64,
}

/// The browser's MediaRecorder output is intentionally treated as untrusted
/// input.  This command validates it with ffprobe, then remuxes/transcodes it
/// into a regular MP3 before the file is exposed to the library.  That avoids
/// keeping a WebM blob with missing duration metadata in the collection.
#[derive(Debug, Deserialize)]
struct RecordingOptions {
    data_base64: String,
    mime_type: Option<String>,
    #[serde(default)]
    output_dir: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProbeOutput {
    streams: Option<Vec<ProbeStream>>,
    format: Option<ProbeFormat>,
}

#[derive(Debug, Deserialize)]
struct ProbeStream {
    codec_type: Option<String>,
    duration: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProbeFormat {
    duration: Option<String>,
}

fn audio_duration_from_probe(parsed: &ProbeOutput) -> Result<f64, String> {
    if !has_audio_stream(parsed) {
        return Err("录音文件不包含音频轨道。".to_string());
    }
    let duration = parsed
        .streams
        .as_ref()
        .and_then(|streams| {
            streams
                .iter()
                .filter(|stream| stream.codec_type.as_deref() == Some("audio"))
                .find_map(|stream| stream.duration.as_deref().and_then(|value| value.parse::<f64>().ok()).filter(|value| value.is_finite() && *value > 0.0))
        })
        .or_else(|| parsed.format.as_ref().and_then(|format| format.duration.as_deref().and_then(|value| value.parse::<f64>().ok()).filter(|value| value.is_finite() && *value > 0.0)))
        .ok_or_else(|| "录音文件没有有效时长。".to_string())?;
    if !duration.is_finite() || duration <= 0.0 {
        return Err("录音文件时长无效。".to_string());
    }
    Ok(duration)
}

fn has_audio_stream(parsed: &ProbeOutput) -> bool {
    parsed
        .streams
        .as_ref()
        .map(|streams| streams.iter().any(|stream| stream.codec_type.as_deref() == Some("audio")))
        .unwrap_or(false)
}

fn clean_user_path(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.chars().any(|ch| ch == '\0' || ch == '\r' || ch == '\n') {
        return Err("媒体路径无效。".to_string());
    }
    let path = PathBuf::from(value);
    let metadata = std::fs::metadata(&path).map_err(|_| "找不到媒体文件，或文件无法访问。".to_string())?;
    if !metadata.is_file() {
        return Err("媒体路径必须指向一个文件。".to_string());
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err("文件超过 2 GB 限制。".to_string());
    }
    Ok(path)
}

fn app_music_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join("music"))
        .map_err(|error| format!("无法定位音乐库目录：{error}"))
}

async fn prepare_output_directory(
    app: &AppHandle,
    state: &SaveDirectoryState,
    requested: Option<&str>,
) -> Result<PathBuf, String> {
    let requested = requested.unwrap_or("").trim();
    if requested.chars().any(|ch| ch == '\0' || ch == '\r' || ch == '\n') {
        return Err("保存目录路径无效。".to_string());
    }
    let is_custom = !requested.is_empty();
    let path = if is_custom { PathBuf::from(requested) } else { app_music_directory(app)? };
    tokio::fs::create_dir_all(&path)
        .await
        .map_err(|error| storage_error("无法创建保存目录", &error))?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| storage_error("无法读取保存目录", &error))?;
    if !metadata.is_dir() {
        return Err("保存目录必须是文件夹。".to_string());
    }
    let canonical = tokio::fs::canonicalize(&path)
        .await
        .map_err(|error| storage_error("无法确认保存目录", &error))?;
    if is_custom {
        state
            .roots
            .lock()
            .map_err(|_| "无法管理保存目录。".to_string())?
            .insert(canonical.clone());
    }
    Ok(canonical)
}

fn is_allowed_media_path(target: &Path, app_root: &Path, state: &SaveDirectoryState) -> Result<bool, String> {
    if target.starts_with(app_root) {
        return Ok(true);
    }
    let roots = state.roots.lock().map_err(|_| "无法管理保存目录。".to_string())?;
    Ok(roots.iter().any(|root| target.starts_with(root)))
}

fn storage_error(prefix: &str, error: &std::io::Error) -> String {
    // Windows ERROR_DISK_FULL (112) and ERROR_HANDLE_DISK_FULL (39).
    if matches!(error.raw_os_error(), Some(112) | Some(39)) {
        "磁盘空间不足，无法保存音频片段。请清理空间后重试。".to_string()
    } else {
        format!("{prefix}：{error}")
    }
}

fn clean_stem(path: &Path) -> String {
    path.file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("clip")
        .chars()
        .map(|value| if value.is_ascii_alphanumeric() || " ._-".contains(value) { value } else { '_' })
        .collect::<String>()
        .trim()
        .chars()
        .take(96)
        .collect()
}

fn format_extension(format: &str) -> Result<&'static str, String> {
    match format {
        "mp3" => Ok("mp3"),
        "wav" => Ok("wav"),
        "m4a" => Ok("m4a"),
        _ => Err("输出格式仅支持 MP3、WAV 或 M4A。".to_string()),
    }
}

fn quality_args(format: &str, quality: &str) -> Result<Vec<String>, String> {
    let args = match format {
        "wav" => vec!["-c:a".to_string(), "pcm_s16le".to_string()],
        "m4a" => {
            let bitrate = match quality {
                "economy" => "128k",
                "standard" => "192k",
                "high" => "256k",
                "lossless" => return Err("M4A 不支持无损选项，请选择高品质或转换为 WAV。".to_string()),
                _ => return Err("音质选项无效。".to_string()),
            };
            vec![
                "-c:a".to_string(),
                "aac".to_string(),
                "-b:a".to_string(),
                bitrate.to_string(),
                "-movflags".to_string(),
                "+faststart".to_string(),
            ]
        }
        "mp3" => {
            let q = match quality {
                "economy" => "5",
                "standard" => "2",
                "high" => "1",
                "lossless" => return Err("MP3 不支持无损选项，请选择高品质或转换为 WAV。".to_string()),
                _ => return Err("音质选项无效。".to_string()),
            };
            vec!["-c:a".to_string(), "libmp3lame".to_string(), "-q:a".to_string(), q.to_string()]
        }
        _ => return Err("输出格式无效。".to_string()),
    };
    Ok(args)
}

async fn probe_duration(app: &AppHandle, input: &Path) -> Result<f64, String> {
    let input_string = input.to_string_lossy().to_string();
    let command = app
        .shell()
        .sidecar("ffprobe")
        .map_err(|error| format!("无法启动 FFprobe：{error}"))?
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            input_string.as_str(),
        ]);
    let output = command.output().await.map_err(|error| format!("读取媒体信息失败：{error}"))?;
    if !output.status.success() {
        return Err("无法读取媒体信息，文件可能已损坏或格式不受支持。".to_string());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let duration = text.trim().parse::<f64>().map_err(|_| "媒体时长无效。".to_string())?;
    if !duration.is_finite() || duration <= 0.0 {
        return Err("媒体时长无效。".to_string());
    }
    Ok(duration)
}

/// Probe both stream presence and duration.  `format.duration` is not enough
/// for MediaRecorder WebM because some browser versions omit it or emit only
/// a video stream.  We require an actual audio stream and a finite duration.
async fn probe_audio_duration(app: &AppHandle, input: &Path) -> Result<f64, String> {
    let input_string = input.to_string_lossy().to_string();
    let command = app
        .shell()
        .sidecar("ffprobe")
        .map_err(|error| format!("无法启动 FFprobe：{error}"))?
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,duration:format=duration",
            "-of",
            "json",
            input_string.as_str(),
        ]);
    let output = command.output().await.map_err(|error| format!("读取录音信息失败：{error}"))?;
    if !output.status.success() {
        return Err("无法验证录音文件，文件可能不完整或不包含可用音频。".to_string());
    }
    let parsed: ProbeOutput = serde_json::from_slice(&output.stdout)
        .map_err(|_| "FFprobe 返回了无效的媒体信息。".to_string())?;
    audio_duration_from_probe(&parsed)
}

/// Browser MediaRecorder WebM may have an audio stream but no duration
/// metadata.  Check only the stream before FFmpeg conversion; the converted
/// output is checked strictly with `probe_audio_duration` below.
async fn probe_audio_stream(app: &AppHandle, input: &Path) -> Result<(), String> {
    let input_string = input.to_string_lossy().to_string();
    let command = app
        .shell()
        .sidecar("ffprobe")
        .map_err(|error| format!("无法启动 FFprobe：{error}"))?
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "json",
            input_string.as_str(),
        ]);
    let output = command.output().await.map_err(|error| format!("读取录音信息失败：{error}"))?;
    if !output.status.success() {
        return Err("无法读取录音文件，文件可能不完整或格式不受支持。".to_string());
    }
    let parsed: ProbeOutput = serde_json::from_slice(&output.stdout)
        .map_err(|_| "FFprobe 返回了无效的媒体信息。".to_string())?;
    if !has_audio_stream(&parsed) {
        return Err("录音文件不包含音频轨道。".to_string());
    }
    Ok(())
}

#[tauri::command]
async fn probe_media(app: AppHandle, path: String) -> Result<MediaMetadata, String> {
    let input = clean_user_path(&path)?;
    let duration = probe_duration(&app, &input).await?;
    let metadata = std::fs::metadata(&input).map_err(|_| "无法读取文件信息。".to_string())?;
    let format = input.extension().and_then(|value| value.to_str()).unwrap_or("").to_uppercase();
    let file_name = input.file_name().and_then(|value| value.to_str()).unwrap_or("media").to_string();
    Ok(MediaMetadata { path, file_name, format, duration, size: metadata.len() })
}

/// Decode a native media file into a compact mono PCM envelope.  FFmpeg does
/// the demuxing, so videos and formats that Web Audio cannot decode still get
/// a real waveform in the desktop build.  The sample rate is intentionally
/// bounded and derived from the duration to keep stdout tiny even for long
/// recordings.
#[tauri::command]
async fn waveform_media(app: AppHandle, path: String, sample_count: Option<u32>) -> Result<Vec<f32>, String> {
    let input = clean_user_path(&path)?;
    let count = sample_count.unwrap_or(72).clamp(8, 256) as usize;
    let duration = probe_duration(&app, &input).await?;
    let desired_rate = ((count as f64 * 8.0) / duration.max(0.25)).ceil() as u32;
    let sample_rate = desired_rate.clamp(32, 256);
    let input_string = input.to_string_lossy().to_string();
    let rate_string = sample_rate.to_string();
    let command = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|error| format!("无法启动 FFmpeg：{error}"))?
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-i",
            input_string.as_str(),
            "-vn",
            "-ac",
            "1",
            "-ar",
            rate_string.as_str(),
            "-f",
            "s16le",
            "pipe:1",
        ]);
    let output = command.output().await.map_err(|error| format!("读取波形失败：{error}"))?;
    if !output.status.success() {
        return Err("FFmpeg 无法读取音频轨道。".to_string());
    }
    let values: Vec<f32> = output
        .stdout
        .chunks_exact(2)
        .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]) as f32 / 32768.0)
        .map(f32::abs)
        .collect();
    if values.is_empty() {
        return Err("媒体文件没有可用的音频波形。".to_string());
    }
    let mut peaks = vec![0.0_f32; count];
    for (index, peak) in peaks.iter_mut().enumerate() {
        let from = index * values.len() / count;
        let to = ((index + 1) * values.len() / count).max(from + 1).min(values.len());
        *peak = values[from..to].iter().copied().fold(0.0_f32, f32::max);
    }
    let maximum = peaks.iter().copied().fold(0.0_f32, f32::max);
    if maximum > 0.0 {
        peaks.iter_mut().for_each(|peak| *peak = (*peak / maximum).clamp(0.0, 1.0));
    }
    Ok(peaks)
}

#[tauri::command]
async fn process_recording_impl(app: AppHandle, save_state: &SaveDirectoryState, options: RecordingOptions) -> Result<ClipResult, String> {
    let bytes = BASE64
        .decode(options.data_base64.trim())
        .map_err(|_| "录音数据无效，无法解码。".to_string())?;
    if bytes.is_empty() {
        return Err("录音数据为空，录音失败。".to_string());
    }
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("录音文件超过 2 GB 限制。".to_string());
    }
    let music_dir = prepare_output_directory(&app, save_state, options.output_dir.as_deref()).await?;
    let temp_dir = music_dir.join(".tmp");
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(|error| storage_error("无法创建临时目录", &error))?;
    tokio::fs::create_dir_all(&music_dir)
        .await
        .map_err(|error| storage_error("无法创建音乐库目录", &error))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "系统时间无效。".to_string())?
        .as_millis();
    // The extension is selected from a fixed allow-list only to help FFmpeg
    // choose its demuxer.  It is never copied from user input.
    let source_extension = match options.mime_type.as_deref() {
        Some(value) if value.contains("ogg") => "ogg",
        _ => "webm",
    };
    let temp_input = temp_dir.join(format!("recording-{stamp}.{source_extension}"));
    let temp_output = temp_dir.join(format!("recording-{stamp}.part.mp3"));
    let file_name = format!("系统录音-{stamp}.mp3");
    let output_path = music_dir.join(&file_name);
    if let Err(error) = tokio::fs::write(&temp_input, &bytes).await {
        let _ = tokio::fs::remove_file(&temp_input).await;
        return Err(storage_error("保存录音临时文件失败", &error));
    }

    let result = async {
        // Probe before conversion so a zero-byte or video-only WebM cannot be
        // silently promoted to a library item.
        probe_audio_stream(&app, &temp_input).await?;
        let input_string = temp_input.to_string_lossy().to_string();
        let output_string = temp_output.to_string_lossy().to_string();
        let command = app
            .shell()
            .sidecar("ffmpeg")
            .map_err(|error| format!("无法启动 FFmpeg，录音无法转换：{error}"))?
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-y",
                "-i",
                input_string.as_str(),
                "-map",
                "0:a:0",
                "-vn",
                "-c:a",
                "libmp3lame",
                "-q:a",
                "2",
                output_string.as_str(),
            ]);
        let output = command
            .output()
            .await
            .map_err(|error| format!("无法启动 FFmpeg，录音无法转换：{error}"))?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr);
            return Err(if detail.trim().is_empty() {
                "FFmpeg 无法转换录音，请确认系统音频数据有效。".to_string()
            } else {
                format!("FFmpeg 转换录音失败：{}", detail.trim())
            });
        }
        let size = tokio::fs::metadata(&temp_output)
            .await
            .map_err(|error| storage_error("读取转换结果失败", &error))?
            .len();
        if size == 0 {
            return Err("FFmpeg 生成了空录音文件。".to_string());
        }
        // Validate the converted file and use the measured duration rather
        // than the recorder wall-clock time.
        let duration = probe_audio_duration(&app, &temp_output).await?;
        tokio::fs::rename(&temp_output, &output_path)
            .await
            .map_err(|error| storage_error("保存录音文件失败", &error))?;
        let output_size = tokio::fs::metadata(&output_path)
            .await
            .map_err(|error| storage_error("读取录音文件失败", &error))?
            .len();
        if output_size == 0 {
            return Err("保存的录音文件为空。".to_string());
        }
        Ok(ClipResult {
            path: output_path.to_string_lossy().to_string(),
            file_name,
            format: "MP3".to_string(),
            duration,
            size: output_size,
        })
    }
    .await;
    let _ = tokio::fs::remove_file(&temp_input).await;
    let _ = tokio::fs::remove_file(&temp_output).await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&output_path).await;
    }
    result
}

#[tauri::command]
async fn process_recording(app: AppHandle, save_state: State<'_, SaveDirectoryState>, options: RecordingOptions) -> Result<ClipResult, String> {
    process_recording_impl(app, &save_state, options).await
}

/// Repair a legacy recording that was imported with a zero duration or a
/// browser WebM container that cannot be decoded reliably.  The source must
/// already live in this app's music directory or in a folder the user has
/// selected as an output directory; it is converted through the same
/// validated path as a new recording and the caller can then replace the old
/// database row.
#[tauri::command]
async fn repair_recording(app: AppHandle, save_state: State<'_, SaveDirectoryState>, path: String) -> Result<ClipResult, String> {
    let input = clean_user_path(&path)?;
    let music_dir = app_music_directory(&app)?;
    let input_canonical = input.canonicalize().map_err(|_| "录音文件不存在。".to_string())?;
    let music_canonical = music_dir.canonicalize().map_err(|_| "音乐库目录不存在。".to_string())?;
    if !is_allowed_media_path(&input_canonical, &music_canonical, &save_state)? {
        return Err("只能修复应用音乐库或已选择保存目录中的录音文件。".to_string());
    }
    let bytes = tokio::fs::read(&input)
        .await
        .map_err(|error| storage_error("读取旧录音失败", &error))?;
    if bytes.is_empty() {
        return Err("旧录音文件为空，无法修复。".to_string());
    }
    let mime_type = match input.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "ogg" | "oga" => "audio/ogg",
        _ => "audio/webm",
    };
    // Keep repaired recordings next to their source.  This avoids silently
    // moving a file out of a user-selected directory back into the default
    // app music folder.
    let output_dir = input_canonical.parent().map(|directory| directory.to_string_lossy().to_string());
    process_recording_impl(app, &save_state, RecordingOptions { data_base64: BASE64.encode(bytes), mime_type: Some(mime_type.to_string()), output_dir }).await
}

#[tauri::command]
async fn clip_media(app: AppHandle, state: State<'_, ClipProcessState>, save_state: State<'_, SaveDirectoryState>, path: String, options: ClipOptions) -> Result<ClipResult, String> {
    let input = clean_user_path(&path)?;
    if !options.start.is_finite() || !options.end.is_finite() || options.start < 0.0 || options.end <= options.start {
        return Err("开始和结束时间无效，结束时间必须大于开始时间。".to_string());
    }
    let duration = probe_duration(&app, &input).await?;
    if options.end > duration + 0.01 {
        return Err(format!("结束时间不能超过媒体时长（{} 秒）。", format!("{duration:.2}")));
    }
    let extension = format_extension(&options.format)?;
    let codec = quality_args(&options.format, &options.quality)?;
    let volume = options.volume.unwrap_or(1.0);
    if !volume.is_finite() || !(0.0..=2.0).contains(&volume) {
        return Err("音量必须在 0% 到 200% 之间。".to_string());
    }
    let music_dir = prepare_output_directory(&app, &save_state, options.output_dir.as_deref()).await?;
    let temp_dir = music_dir.join(".tmp");
    tokio::fs::create_dir_all(&temp_dir).await.map_err(|error| storage_error("无法创建音乐库目录", &error))?;
    tokio::fs::create_dir_all(&music_dir).await.map_err(|error| storage_error("无法创建音乐库目录", &error))?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "系统时间无效。".to_string())?.as_millis();
    let stem = clean_stem(&input);
    let file_name = format!("{stem}-{stamp}.{extension}");
    // Keep the media extension on the temporary output so FFmpeg can infer
    // the muxer.  A name such as `clip.mp3.part` has an unknown `.part`
    // extension and makes FFmpeg fail before it writes any bytes.  The
    // temporary marker is placed before the real extension and is removed
    // atomically by the rename below.
    let temp_path = temp_dir.join(format!("{stem}-{stamp}.part.{extension}"));
    let output_path = music_dir.join(&file_name);
    let input_string = input.to_string_lossy().to_string();
    let temp_string = temp_path.to_string_lossy().to_string();
    let seconds = format!("{:.3}", options.end - options.start);
    let start = format!("{:.3}", options.start);
    let mut args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-y".to_string(),
        "-ss".to_string(),
        start,
        "-t".to_string(),
        seconds,
        "-i".to_string(),
        input_string,
        "-vn".to_string(),
    ];
    if (volume - 1.0).abs() >= 0.0001 {
        args.push("-filter:a".to_string());
        args.push(format!("volume={volume:.2}"));
    }
    args.extend(codec);
    args.push(temp_string);
    state.canceled.store(false, Ordering::SeqCst);
    let result = async {
        let command = app
            .shell()
            .sidecar("ffmpeg")
            .map_err(|error| format!("无法启动 FFmpeg：{error}"))?
            .args(args)
            .set_process_group(true);
        let (mut events, child) = command.spawn().map_err(|error| format!("音频截取失败：{error}"))?;
        *state.child.lock().map_err(|_| "无法管理 FFmpeg 进程。".to_string())? = Some(child);
        let mut exit_code = None;
        let mut stderr = Vec::new();
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Terminated(payload) => { exit_code = payload.code; break; }
                CommandEvent::Stderr(line) => stderr.extend(line),
                CommandEvent::Error(error) => stderr.extend(error.into_bytes()),
                CommandEvent::Stdout(_) => {}
                _ => {}
            }
        }
        // Dropping the completed child releases the process handle. If the
        // user cancelled, cancel_clip already consumed and killed it.
        let _ = state.child.lock().map_err(|_| "无法管理 FFmpeg 进程。".to_string())?.take();
        if state.canceled.load(Ordering::SeqCst) {
            return Err("任务已取消。".to_string());
        }
        if exit_code != Some(0) {
            let detail = String::from_utf8_lossy(&stderr);
            return Err(if detail.trim().is_empty() { "音频截取失败，请确认 FFmpeg 可用。".to_string() } else { format!("音频截取失败：{}", detail.trim()) });
        }
        tokio::fs::rename(&temp_path, &output_path).await.map_err(|error| storage_error("保存片段失败", &error))?;
        let size = tokio::fs::metadata(&output_path).await.map_err(|error| storage_error("读取输出文件失败", &error))?.len();
        Ok(ClipResult { path: output_path.to_string_lossy().to_string(), file_name, format: extension.to_uppercase(), duration: options.end - options.start, size })
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temp_path).await;
        let _ = tokio::fs::remove_file(&output_path).await;
    }
    result
}

#[tauri::command]
fn cancel_clip(state: State<'_, ClipProcessState>) -> Result<(), String> {
    state.canceled.store(true, Ordering::SeqCst);
    let child = state.child.lock().map_err(|_| "无法管理 FFmpeg 进程。".to_string())?.take();
    if let Some(child) = child {
        child.kill().map_err(|error| format!("取消截取失败：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
async fn delete_media(app: AppHandle, save_state: State<'_, SaveDirectoryState>, path: String) -> Result<(), String> {
    let target = clean_user_path(&path)?;
    let music_dir = app_music_directory(&app)?;
    let target_canonical = target.canonicalize().map_err(|_| "文件不存在。".to_string())?;
    let music_canonical = music_dir.canonicalize().map_err(|_| "音乐库目录不存在。".to_string())?;
    if !is_allowed_media_path(&target_canonical, &music_canonical, &save_state)? {
        return Err("只能删除应用音乐库或已选择保存目录中的文件。".to_string());
    }
    tokio::fs::remove_file(target).await.map_err(|error| format!("删除文件失败：{error}"))
}

#[tauri::command]
async fn set_save_directory(app: AppHandle, save_state: State<'_, SaveDirectoryState>, path: String) -> Result<String, String> {
    let directory = prepare_output_directory(&app, &save_state, Some(&path)).await?;
    // A previous process may have been interrupted after creating a partial
    // file.  The next explicit selection (including preference hydration on
    // startup) is a safe point to remove that stale working directory before
    // new output is written there.
    let temp_dir = directory.join(".tmp");
    match tokio::fs::remove_dir_all(&temp_dir).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(storage_error("无法清理保存目录中的临时文件", &error)),
    }
    Ok(directory.to_string_lossy().to_string())
}

#[tauri::command]
async fn music_directory(app: AppHandle) -> Result<String, String> {
    let path = app.path().app_local_data_dir().map_err(|error| format!("无法定位音乐库目录：{error}"))?.join("music");
    tokio::fs::create_dir_all(&path).await.map_err(|error| format!("无法创建音乐库目录：{error}"))?;
    // Remove interrupted `.part` files left by a previous process before the
    // directory is exposed to the UI. Completed files are never touched.
    let temp_dir = path.join(".tmp");
    let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    Ok(path.to_string_lossy().to_string())
}

fn main() {
    tauri::Builder::default()
        .setup(db::setup)
        .manage(ClipProcessState::default())
        .manage(SaveDirectoryState::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            probe_media, waveform_media, process_recording, repair_recording, clip_media, cancel_clip, delete_media, set_save_directory, music_directory,
            db::db_initialize, db::db_list_tracks, db::db_get_track, db::db_find_track_by_path, db::db_upsert_track, db::db_delete_track,
            db::db_set_track_favorite, db::db_list_playlists, db::db_create_playlist, db::db_rename_playlist,
            db::db_delete_playlist, db::db_list_playlist_tracks, db::db_add_playlist_track,
            db::db_remove_playlist_track, db::db_reorder_playlist_tracks, db::db_get_queue, db::db_set_queue,
            db::db_get_app_state, db::db_set_app_state, db::db_import_legacy_library
        ])
        .run(tauri::generate_context!())
        .expect("error while running RinkoSound");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_supported_output_formats() {
        assert_eq!(format_extension("mp3").unwrap(), "mp3");
        assert_eq!(format_extension("wav").unwrap(), "wav");
        assert_eq!(format_extension("m4a").unwrap(), "m4a");
        assert!(format_extension("flac").is_err());
    }

    #[test]
    fn rejects_lossless_compressed_output() {
        assert!(quality_args("mp3", "lossless").is_err());
        assert!(quality_args("m4a", "lossless").is_err());
        assert!(quality_args("wav", "lossless").is_ok());
    }

    #[test]
    fn sanitizes_output_stems() {
        let path = PathBuf::from("song:*?.wav");
        assert_eq!(clean_stem(&path), "song___");
    }

    #[test]
    fn probe_requires_audio_and_positive_duration() {
        let audio = ProbeOutput {
            streams: Some(vec![ProbeStream { codec_type: Some("audio".to_string()), duration: Some("10.25".to_string()) }]),
            format: Some(ProbeFormat { duration: Some("10.25".to_string()) }),
        };
        assert_eq!(audio_duration_from_probe(&audio).unwrap(), 10.25);
        let video_only = ProbeOutput {
            streams: Some(vec![ProbeStream { codec_type: Some("video".to_string()), duration: Some("10.25".to_string()) }]),
            format: Some(ProbeFormat { duration: Some("10.25".to_string()) }),
        };
        assert!(audio_duration_from_probe(&video_only).unwrap_err().contains("音频轨道"));
        let zero = ProbeOutput {
            streams: Some(vec![ProbeStream { codec_type: Some("audio".to_string()), duration: Some("0".to_string()) }]),
            format: Some(ProbeFormat { duration: Some("0".to_string()) }),
        };
        assert!(audio_duration_from_probe(&zero).is_err());
    }

    #[test]
    fn accepts_audio_stream_without_source_duration_for_ffmpeg_recovery() {
        let webm_without_duration = ProbeOutput {
            streams: Some(vec![ProbeStream { codec_type: Some("audio".to_string()), duration: None }]),
            format: Some(ProbeFormat { duration: None }),
        };
        assert!(has_audio_stream(&webm_without_duration));
        assert!(audio_duration_from_probe(&webm_without_duration).is_err());
    }
}
