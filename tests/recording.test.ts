import { describe, expect, it, vi } from 'vitest'
import { SYSTEM_AUDIO_ERROR, audioTracksOf, createRecorderCollector, probeAudioUrl, probeRecordedBlob, selectRecorderMimeType, stopRecorderAndCollect } from '../src/lib/recording'

describe('system recording workflow', () => {
  it('uses the first MIME type supported by the active WebView', () => {
    expect(selectRecorderMimeType((type) => type === 'audio/webm')).toBe('audio/webm')
    expect(selectRecorderMimeType(() => false)).toBeNull()
  })

  it('filters missing, muted and ended audio tracks before recording', () => {
    const stream = { getAudioTracks: () => [
      { readyState: 'live', enabled: true, muted: false },
      { readyState: 'live', enabled: false, muted: false },
      { readyState: 'ended', enabled: true, muted: false },
      { readyState: 'live', enabled: true, muted: true },
    ] }
    const liveTracks = audioTracksOf(stream as unknown as MediaStream)
    expect(liveTracks).toHaveLength(1)
    expect(audioTracksOf({ getAudioTracks: () => [] } as unknown as MediaStream)).toHaveLength(0)
    expect(SYSTEM_AUDIO_ERROR).toContain('没有检测到系统音频')
  })

  it('waits for stop and keeps the final dataavailable chunk', async () => {
    type FakeRecorder = {
      state: string
      mimeType: string
      ondataavailable: ((event: { data: Blob }) => void) | null
      onerror: ((event: Event) => void) | null
      onstop: ((event: Event) => void) | null
      requestData: () => void
      stop: () => void
    }
    let recorder!: FakeRecorder
    recorder = {
      state: 'recording', mimeType: 'audio/webm', ondataavailable: null, onerror: null, onstop: null,
      requestData: () => recorder.ondataavailable?.({ data: new Blob(['last']) }),
      stop: () => { recorder.state = 'inactive'; recorder.ondataavailable?.({ data: new Blob(['final']) }); recorder.onstop?.(new Event('stop')) },
    }
    const result = await stopRecorderAndCollect(recorder as unknown as MediaRecorder)
    expect(result.chunkCount).toBe(2)
    expect(result.blob.size).toBeGreaterThan(0)
    expect(result.blob.type).toBe('audio/webm')
  })

  it('collects all timeslice chunks when attached before recording starts', async () => {
    const listeners = new Map<string, Set<(event: Event) => void>>()
    const addEventListener = (name: string, listener: (event: Event) => void) => {
      const set = listeners.get(name) ?? new Set<(event: Event) => void>()
      set.add(listener); listeners.set(name, set)
    }
    const removeEventListener = (name: string, listener: (event: Event) => void) => listeners.get(name)?.delete(listener)
    const emit = (name: string, event: Event) => listeners.get(name)?.forEach((listener) => listener(event))
    const recorder = {
      state: 'recording', mimeType: 'audio/webm', addEventListener, removeEventListener,
      requestData: () => emit('dataavailable', Object.assign(new Event('dataavailable'), { data: new Blob(['last']) })),
      stop: () => { recorder.state = 'inactive'; emit('dataavailable', Object.assign(new Event('dataavailable'), { data: new Blob(['final']) })); emit('stop', new Event('stop')) },
    }
    const collector = createRecorderCollector(recorder as unknown as MediaRecorder)
    emit('dataavailable', Object.assign(new Event('dataavailable'), { data: new Blob(['timeslice']) }))
    const result = await collector.stop()
    expect(result.chunkCount).toBe(3)
    expect(result.blob.size).toBeGreaterThan(new Blob(['last', 'final']).size)
  })

  it('rejects empty blobs before adding a library record', async () => {
    await expect(probeRecordedBlob(new Blob())).rejects.toThrow('数据为空')
  })

  it('accepts only finite positive duration from the actual audio element', async () => {
    const originalAudio = globalThis.Audio
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    URL.createObjectURL = vi.fn(() => 'blob:test')
    URL.revokeObjectURL = vi.fn()
    class FakeAudio {
      duration = 3.5
      preload = ''
      onloadedmetadata: (() => void) | null = null
      oncanplay: (() => void) | null = null
      onerror: (() => void) | null = null
      removeAttribute = vi.fn()
      load = vi.fn(() => this.onloadedmetadata?.())
      set src(_value: string) { /* probe assigns a blob URL */ }
    }
    globalThis.Audio = FakeAudio as unknown as typeof Audio
    await expect(probeRecordedBlob(new Blob(['audio']))).resolves.toBe(3.5)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test')
    globalThis.Audio = originalAudio
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
  })

  it('checks persisted/native asset URLs through the player element', async () => {
    const originalAudio = globalThis.Audio
    class FakeAudio {
      duration = 4
      preload = ''
      onloadedmetadata: (() => void) | null = null
      oncanplay: (() => void) | null = null
      onerror: (() => void) | null = null
      pause = vi.fn()
      removeAttribute = vi.fn()
      load = vi.fn(() => this.onloadedmetadata?.())
      set src(_value: string) { /* asset URL assigned */ }
    }
    globalThis.Audio = FakeAudio as unknown as typeof Audio
    await expect(probeAudioUrl('asset://localhost/music/recording.mp3')).resolves.toBe(4)
    expect((globalThis.Audio as unknown as typeof FakeAudio)).toBeDefined()
    globalThis.Audio = originalAudio
  })
})

