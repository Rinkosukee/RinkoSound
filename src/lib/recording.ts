/** Utilities shared by the system-audio recording workflow.
 *
 * The browser capture API is intentionally kept behind this small adapter so
 * the UI can validate the capture before creating a library item.  In
 * particular, getDisplayMedia is allowed to return a stream with only a
 * video track when the user did not tick "share audio".
 */

export interface RecordingDiagnostics {
  audioTrackCount: number
  audioTrackStates: Array<{ readyState: MediaStreamTrackState; enabled: boolean; muted: boolean }>
  mimeType: string
  chunkCount: number
  blobSize: number
  duration: number
}

export const SYSTEM_AUDIO_ERROR = '没有检测到系统音频，请在系统共享窗口中勾选共享系统音频，或选择支持系统音频的共享来源。'

/** Pick a MIME type the current WebView can actually encode. */
export function selectRecorderMimeType(isSupported: (mime: string) => boolean): string | null {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
  ]
  return candidates.find((mime) => isSupported(mime)) ?? null
}

export function audioTracksOf(stream: MediaStream): MediaStreamTrack[] {
  return stream.getAudioTracks().filter((track) => track.readyState === 'live' && track.enabled && !track.muted)
}

/**
 * Wait for MediaRecorder's final dataavailable event.  requestData() is made
 * before stop where possible; the stop event is awaited before callers clean
 * up the underlying capture tracks.
 */
export interface RecorderCollector {
  stop: () => Promise<{ blob: Blob; chunkCount: number }>
  chunkCount: () => number
  chunks: () => Blob[]
  dispose: () => void
}

/** Attach the data listener before recorder.start(), so chunks emitted during
 * the recording are never lost. */
export function createRecorderCollector(recorder: MediaRecorder): RecorderCollector {
  const chunks: Blob[] = []
  const onData = (event: BlobEvent) => { if (event.data && event.data.size > 0) chunks.push(event.data) }
  recorder.addEventListener('dataavailable', onData)
  return {
    chunkCount: () => chunks.length,
    chunks: () => [...chunks],
    dispose: () => recorder.removeEventListener('dataavailable', onData),
    stop: () => new Promise((resolve, reject) => {
      const cleanup = () => recorder.removeEventListener('dataavailable', onData)
      const onError = () => { cleanup(); reject(new Error('系统音频录制失败，MediaRecorder 报告了编码错误。')) }
      const onStop = () => {
        cleanup()
        recorder.removeEventListener('error', onError)
        recorder.removeEventListener('stop', onStop)
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
        resolve({ blob, chunkCount: chunks.length })
      }
      recorder.addEventListener('error', onError, { once: true })
      recorder.addEventListener('stop', onStop, { once: true })
      try {
        if (recorder.state === 'recording') {
          try { recorder.requestData() } catch { /* some WebViews do not expose requestData */ }
          recorder.stop()
        } else if (recorder.state === 'inactive') {
          onStop()
        } else {
          cleanup(); reject(new Error('录音状态无效。'))
        }
      } catch (error) {
        cleanup(); reject(error instanceof Error ? error : new Error('无法停止系统音频录制。'))
      }
    }),
  }
}

/** Backwards-compatible one-shot helper for callers that already own chunks. */
export function stopRecorderAndCollect(recorder: MediaRecorder, initialChunks: Blob[] = []): Promise<{ blob: Blob; chunkCount: number }> {
  return new Promise((resolve, reject) => {
    const chunks: Blob[] = [...initialChunks]
    const originalData = recorder.ondataavailable
    const originalError = recorder.onerror
    const originalStop = recorder.onstop

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data)
      originalData?.call(recorder, event)
    }
    recorder.onerror = (event) => {
      originalError?.call(recorder, event)
      reject(new Error('系统音频录制失败，MediaRecorder 报告了编码错误。'))
    }
    recorder.onstop = (event) => {
      originalStop?.call(recorder, event)
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
      resolve({ blob, chunkCount: chunks.length })
    }
    try {
      if (recorder.state === 'recording') {
        try { recorder.requestData() } catch { /* some WebViews do not expose requestData */ }
        recorder.stop()
      } else if (recorder.state === 'inactive') {
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
        resolve({ blob, chunkCount: chunks.length })
      } else {
        reject(new Error('录音状态无效。'))
      }
    } catch (error) {
      reject(error instanceof Error ? error : new Error('无法停止系统音频录制。'))
    }
  })
}

/** Verify that a Blob contains a playable, finite-duration audio stream. */
export function probeRecordedBlob(blob: Blob, timeoutMs = 12_000): Promise<number> {
  return new Promise((resolve, reject) => {
    if (blob.size <= 0) { reject(new Error('录音数据为空，未生成有效音频。')); return }
    const url = URL.createObjectURL(blob)
    const audio = new Audio()
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      audio.onloadedmetadata = null
      audio.oncanplay = null
      audio.onerror = null
      audio.removeAttribute('src')
      audio.load()
      URL.revokeObjectURL(url)
      if (error) reject(error)
    }
    const acceptDuration = async () => {
      const value = audio.duration
      if (Number.isFinite(value) && value > 0) {
        // A muted probe avoids autoplay policy while still exercising the
        // actual decoder/playback path. Metadata alone is insufficient for a
        // malformed WebM container.
        try {
          audio.muted = true
          if (typeof audio.play === 'function') await audio.play()
          audio.pause()
        } catch { /* canplay is still a valid load when autoplay is blocked */ }
        finish(); resolve(value); return
      }
      finish(new Error('录音文件缺少有效时长元数据，无法加入音乐库。'))
    }
    const timeout = window.setTimeout(() => finish(new Error('录音文件验证超时，文件可能缺少音频轨道。')), timeoutMs)
    audio.preload = 'metadata'
    audio.onloadedmetadata = acceptDuration
    audio.oncanplay = acceptDuration
    audio.onerror = () => finish(new Error('录音文件无法被音频播放器加载。'))
    audio.src = url
    audio.load()
  })
}

/** Verify a persisted/native asset through the same HTMLAudioElement used by
 * the player. This catches asset protocol or codec failures after FFmpeg has
 * produced a non-empty file. */
export function probeAudioUrl(url: string, timeoutMs = 12_000): Promise<number> {
  return new Promise((resolve, reject) => {
    if (!url) { reject(new Error('录音文件地址为空。')); return }
    const audio = new Audio()
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      audio.onloadedmetadata = null
      audio.oncanplay = null
      audio.onerror = null
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      if (error) reject(error)
    }
    const accept = async () => {
      const duration = audio.duration
      if (Number.isFinite(duration) && duration > 0) {
        try {
          audio.muted = true
          if (typeof audio.play === 'function') await audio.play()
          audio.pause()
        } catch { /* autoplay may be blocked even though the asset is valid */ }
        finish(); resolve(duration); return
      }
      finish(new Error('录音文件缺少有效时长，播放器无法加载。'))
    }
    const timeout = window.setTimeout(() => finish(new Error('录音文件加载超时。')), timeoutMs)
    audio.preload = 'metadata'
    audio.onloadedmetadata = accept
    audio.oncanplay = accept
    audio.onerror = () => finish(new Error('录音文件无法被音频播放器加载。'))
    audio.src = url
    audio.load()
  })
}

