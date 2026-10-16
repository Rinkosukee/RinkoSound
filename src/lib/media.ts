import type { ClipRequest } from '../types'

export const ACCEPTED_EXTENSIONS = ['mp4', 'mkv', 'webm', 'mov', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg']
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function isSupportedFile(file: File): boolean {
  return ACCEPTED_EXTENSIONS.includes(extensionOf(file.name)) && file.size <= MAX_FILE_BYTES
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Decode the selected range with Web Audio and render it to a PCM buffer. */
export async function renderClip(file: Blob, start: number, end: number, signal?: AbortSignal): Promise<AudioBuffer> {
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
  const context = new AudioContext()
  try {
    const bytes = await file.arrayBuffer()
    if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
    const decoded = await context.decodeAudioData(bytes)
    const sampleRate = decoded.sampleRate
    const from = Math.max(0, Math.floor(start * sampleRate))
    const to = Math.min(decoded.length, Math.ceil(end * sampleRate))
    const length = Math.max(1, to - from)
    const output = context.createBuffer(decoded.numberOfChannels, length, sampleRate)
    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
      output.getChannelData(channel).set(decoded.getChannelData(channel).subarray(from, to))
    }
    return output
  } finally {
    await context.close()
  }
}

export function encodeWav(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels
  const frameCount = buffer.length
  const bytesPerSample = 2
  const blockAlign = channels * bytesPerSample
  const output = new ArrayBuffer(44 + frameCount * blockAlign)
  const view = new DataView(output)
  const write = (offset: number, text: string) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)))
  write(0, 'RIFF')
  view.setUint32(4, 36 + frameCount * blockAlign, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, buffer.sampleRate, true)
  view.setUint32(28, buffer.sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, frameCount * blockAlign, true)
  let offset = 44
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const value = Math.max(-1, Math.min(1, buffer.getChannelData(channel)[frame]))
      view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true)
      offset += 2
    }
  }
  return new Blob([output], { type: 'audio/wav' })
}

/**
 * Decode a local media source and reduce its audio envelope to a small set of
 * peak samples suitable for the clip editor waveform.  The browser and Tauri
 * paths both use this helper: browser assets are passed as Blob instances,
 * while native assets are fetched from their Tauri asset URL.  Video files
 * without a browser-decodable audio track simply reject and let the caller
 * keep its static waveform fallback.
 */
export async function createWaveformSamples(source: Blob | string, sampleCount = 72, signal?: AbortSignal): Promise<number[]> {
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
  const bytes = source instanceof Blob
    ? await source.arrayBuffer()
    : await fetch(source).then((response) => {
      if (!response.ok) throw new Error(`无法读取媒体文件（${response.status}）。`)
      return response.arrayBuffer()
    })
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')

  const context = new AudioContext()
  try {
    const decoded = await context.decodeAudioData(bytes.slice(0))
    if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
    const count = Math.max(8, Math.min(256, Math.floor(sampleCount)))
    const samples = new Array<number>(count).fill(0)
    const channels = decoded.numberOfChannels
    const frameCount = decoded.length
    for (let index = 0; index < count; index += 1) {
      const from = Math.floor(index * frameCount / count)
      const to = Math.max(from + 1, Math.min(frameCount, Math.floor((index + 1) * frameCount / count)))
      let peak = 0
      // Peak amplitude preserves transients better than an average and keeps
      // the same visual language for mono and stereo material.
      for (let frame = from; frame < to; frame += 1) {
        for (let channel = 0; channel < channels; channel += 1) {
          peak = Math.max(peak, Math.abs(decoded.getChannelData(channel)[frame]))
        }
      }
      samples[index] = peak
    }
    const maximum = Math.max(...samples)
    if (!maximum) return samples.map(() => 0)
    return samples.map((value) => Math.min(1, value / maximum))
  } finally {
    await context.close()
  }
}

/** Browser fallback: WAV is lossless and reliable; Tauri maps the same request to FFmpeg. */
export async function createClip(file: Blob, request: ClipRequest, signal?: AbortSignal): Promise<Blob> {
  const rendered = await renderClip(file, request.start, request.end, signal)
  // Keep the historical default at unity gain; only touch samples when the
  // user explicitly changes the clip volume. The same linear gain is used by
  // the native FFmpeg path so browser previews and exports stay consistent.
  const volume = Number.isFinite(request.volume ?? 1) ? Math.min(2, Math.max(0, request.volume ?? 1)) : 1
  if (Math.abs(volume - 1) >= 0.0001) {
    for (let channel = 0; channel < rendered.numberOfChannels; channel += 1) {
      const samples = rendered.getChannelData(channel)
      for (let frame = 0; frame < samples.length; frame += 1) samples[frame] *= volume
    }
  }
  if (request.format !== 'wav' && typeof MediaRecorder !== 'undefined') {
    // Keep a lossless WAV fallback when the browser does not provide an encoder.
    // Native Tauri builds replace this adapter with the FFmpeg sidecar adapter.
    return encodeWav(rendered)
  }
  return encodeWav(rendered)
}
