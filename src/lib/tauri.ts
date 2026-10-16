import { open } from '@tauri-apps/plugin-dialog'
import { convertFileSrc } from '@tauri-apps/api/core'

/** Minimal Tauri bridge that keeps the browser build dependency-free.
 *
 * `withGlobalTauri` is enabled in src-tauri/tauri.conf.json, so the desktop
 * build exposes the invoke bridge through `window.__TAURI_INTERNALS__`. The
 * browser build simply reports that native commands are unavailable and keeps
 * using the Web Audio fallback.
 */
export interface TauriInvokeBridge {
  invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInvokeBridge
  }
}

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && typeof window.__TAURI_INTERNALS__?.invoke === 'function'
}

export async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const bridge = typeof window !== 'undefined' ? window.__TAURI_INTERNALS__ : undefined
  if (!bridge) throw new Error('当前不是 Tauri 原生运行环境。')
  return bridge.invoke<T>(command, args)
}

export interface NativeMediaMetadata {
  path: string
  file_name: string
  format: string
  duration: number
  size: number
}

export interface NativeClipResult {
  path: string
  file_name: string
  format: string
  duration: number
  size: number
}

export interface NativeRecordingResult {
  path: string
  file_name: string
  format: string
  duration: number
  size: number
}

export interface NativeClipOptions {
  start: number
  end: number
  format: 'mp3' | 'wav' | 'm4a'
  quality: 'economy' | 'standard' | 'high' | 'lossless'
  /** Linear gain from 0 to 2; 1 preserves the source level. */
  volume?: number
  outputDir?: string
}

export function probeNativeMedia(path: string): Promise<NativeMediaMetadata> {
  return invokeNative<NativeMediaMetadata>('probe_media', { path })
}

/** Generate a compact PCM peak envelope for a native media file. */
export function waveformNativeMedia(path: string, sampleCount = 72): Promise<number[]> {
  return invokeNative<number[]>('waveform_media', { path, sample_count: sampleCount })
}

export function clipNativeMedia(path: string, options: NativeClipOptions): Promise<NativeClipResult> {
  const { outputDir, ...clipOptions } = options
  return invokeNative<NativeClipResult>('clip_media', { path, options: { ...clipOptions, output_dir: outputDir } })
}

/** Send a validated MediaRecorder payload to the native side for FFmpeg
 * conversion and ffprobe validation.  The raw bytes never leave the app. */
export function processNativeRecording(dataBase64: string, mimeType: string, outputDir?: string): Promise<NativeRecordingResult> {
  return invokeNative<NativeRecordingResult>('process_recording', { options: { data_base64: dataBase64, mime_type: mimeType, output_dir: outputDir } })
}

/** Re-encode a legacy recording already stored in the local music directory. */
export function repairNativeRecording(path: string): Promise<NativeRecordingResult> {
  return invokeNative<NativeRecordingResult>('repair_recording', { path })
}

export function cancelNativeClip(): Promise<void> {
  return invokeNative<void>('cancel_clip')
}

export function deleteNativeMedia(path: string): Promise<void> {
  return invokeNative<void>('delete_media', { path })
}

export function nativeMusicDirectory(): Promise<string> {
  return invokeNative<string>('music_directory')
}

export async function pickNativeDirectory(): Promise<string | null> {
  const selected = await open({ multiple: false, directory: true })
  return typeof selected === 'string' ? selected : null
}

export function setNativeSaveDirectory(path: string): Promise<string> {
  return invokeNative<string>('set_save_directory', { path })
}

export async function pickNativeMediaPaths(): Promise<string[]> {
  const selected = await open({
    multiple: true,
    directory: false,
    filters: [{ name: '媒体文件', extensions: ['mp4', 'mkv', 'webm', 'mov', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'] }],
  })
  if (!selected) return []
  return Array.isArray(selected) ? selected : [selected]
}

/** Convert an application-local path into a Tauri asset URL for media playback. */
export function nativeAssetUrl(path: string): string {
  // Let Tauri encode Windows drive letters and separators for the asset protocol.
  if (isTauriRuntime()) {
    try {
      return convertFileSrc(path)
    } catch {
      // Some test harnesses expose only invoke on __TAURI_INTERNALS__.
      // Falling through keeps metadata rendering usable in those contexts.
    }
  }
  return `asset://localhost/${encodeURIComponent(path)}`
}

