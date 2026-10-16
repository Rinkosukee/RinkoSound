import type { ClipRequest } from '../types'
import { clipNativeMedia, isTauriRuntime, type NativeClipResult } from './tauri'

const safePath = (value: string) => value.replace(/[\u0000\r\n]/g, '')

/**
 * Native Tauri adapter contract. It returns argv as an array so a Command API can
 * pass arguments without invoking a shell or allowing user input to be interpreted.
 */
export function buildFfmpegArgs(inputPath: string, outputPath: string, request: ClipRequest): string[] {
  if (!Number.isFinite(request.start) || !Number.isFinite(request.end) || request.end <= request.start) {
    throw new Error('invalid clip range')
  }
  const input = safePath(inputPath)
  const output = safePath(outputPath)
  if (!input || !output || input === output) throw new Error('invalid media paths')
  const duration = (request.end - request.start).toFixed(3)
  const volume = Number.isFinite(request.volume ?? 1) ? Math.min(2, Math.max(0, request.volume ?? 1)) : 1
  const volumeFilter = Math.abs(volume - 1) < 0.0001 ? [] : ['-filter:a', 'volume=' + volume.toFixed(2)]
  const codec = request.format === 'wav' ? ['-c:a', 'pcm_s16le'] : request.format === 'm4a' ? ['-c:a', 'aac', '-b:a', request.quality === 'high' ? '256k' : '192k', '-movflags', '+faststart'] : ['-c:a', 'libmp3lame', '-q:a', request.quality === 'economy' ? '5' : request.quality === 'high' ? '1' : '2']
  return ['-hide_banner', '-loglevel', 'error', '-y', '-ss', request.start.toFixed(3), '-t', duration, '-i', input, '-vn', ...volumeFilter, ...codec, output]
}

/**
 * Native desktop path. The Rust command validates the input path, creates an
 * application-owned output path, invokes the FFmpeg sidecar with argv, and
 * removes its temporary file on every failure path.
 */
export function createNativeClip(path: string, request: ClipRequest): Promise<NativeClipResult> {
  if (!isTauriRuntime()) throw new Error('当前不是 Tauri 原生运行环境。')
  return clipNativeMedia(path, request)
}



