/**
 * Small, UI agnostic playback state machine.
 *
 * The HTMLAudioElement belongs in the UI adapter.  This module only decides
 * what should be played next and keeps queue/player preferences in one place.
 * Keeping that decision logic here makes it possible to use the same rules in
 * the React player, keyboard shortcuts, and a native Tauri audio adapter.
 */

export type PlaybackMode = 'sequential' | 'repeat-all' | 'repeat-one' | 'shuffle'

/** Why playback stopped.  This lets the audio adapter distinguish a natural
 * end (where it may advance) from an explicit user stop/removal (where it
 * must remain silent). */
export type PlaybackStopReason = 'none' | 'pause' | 'manual-delete' | 'manual-clear' | 'natural-end' | 'error'

export interface PlayableTrack {
  id: string
  duration?: number
}

/** The logical origin of the current queue.  The source is metadata for the
 * player UI only; changing the queue never mutates the originating playlist. */
export interface QueueSource {
  type: 'playlist' | 'library' | 'manual' | 'unknown'
  id?: string
  name?: string
}

export interface PlaybackState<T extends PlayableTrack = PlayableTrack> {
  queue: T[]
  currentTrackId: string | null
  /** Index of currentTrackId in queue, or -1 when there is no current track. */
  currentIndex: number
  position: number
  isPlaying: boolean
  mode: PlaybackMode
  volume: number
  muted: boolean
  queueSource: QueueSource | null
  stopReason: PlaybackStopReason
  /** IDs recently selected by shuffle, newest item last. */
  recentlyPlayed: string[]
  /** IDs selected before the current item, used by the previous button. */
  history: string[]
}

export interface PersistedPlaybackState {
  queueIds: string[]
  currentTrackId: string | null
  currentIndex?: number
  position: number
  isPlaying: boolean
  mode: PlaybackMode
  volume: number
  muted: boolean
  queueSource?: QueueSource | null
  recentlyPlayed: string[]
  history: string[]
  stopReason?: PlaybackStopReason
}

export interface PlaybackOptions<T extends PlayableTrack> {
  queue?: T[]
  currentTrackId?: string | null
  queueSource?: QueueSource | null
  position?: number
  isPlaying?: boolean
  mode?: PlaybackMode
  volume?: number
  muted?: boolean
  recentlyPlayed?: string[]
  history?: string[]
  stopReason?: PlaybackStopReason
  /** Injected in tests; defaults to Math.random. */
  random?: () => number
  /** Number of previously selected shuffle tracks to avoid. */
  shuffleMemory?: number
}

export type PlaybackListener<T extends PlayableTrack = PlayableTrack> = (state: PlaybackState<T>) => void

const DEFAULT_VOLUME = 1
const DEFAULT_SHUFFLE_MEMORY = 3

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function validMode(mode: PlaybackMode | undefined): PlaybackMode {
  return mode === 'repeat-all' || mode === 'repeat-one' || mode === 'shuffle' ? mode : 'sequential'
}

function validStopReason(reason: PlaybackStopReason | undefined): PlaybackStopReason {
  return reason === 'pause' || reason === 'manual-delete' || reason === 'manual-clear' || reason === 'natural-end' || reason === 'error' ? reason : 'none'
}

function uniqueIds(values: string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))]
}

/**
 * Deterministic player rules and queue operations.
 *
 * The class never touches files or the DOM.  A caller can subscribe to state
 * changes and drive an HTMLAudioElement (or a Tauri/native player) from the
 * resulting state.
 */
export class PlaybackStateMachine<T extends PlayableTrack = PlayableTrack> {
  private state: PlaybackState<T>
  private readonly listeners = new Set<PlaybackListener<T>>()
  private readonly random: () => number
  private readonly shuffleMemory: number

  constructor(options: PlaybackOptions<T> = {}) {
    this.random = options.random ?? Math.random
    this.shuffleMemory = Math.max(1, Math.floor(options.shuffleMemory ?? DEFAULT_SHUFFLE_MEMORY))
    const queue = this.dedupeQueue(options.queue ?? [])
    const currentTrackId = this.resolveCurrentTrackId(queue, options.currentTrackId ?? null)
    const current = queue.find((track) => track.id === currentTrackId)
    const maxPosition = current?.duration && Number.isFinite(current.duration) ? Math.max(0, current.duration) : Number.POSITIVE_INFINITY
    this.state = {
      queue,
      currentTrackId,
      currentIndex: currentTrackId ? queue.findIndex((track) => track.id === currentTrackId) : -1,
      position: clamp(Number.isFinite(options.position ?? 0) ? options.position ?? 0 : 0, 0, maxPosition),
      isPlaying: Boolean(options.isPlaying && currentTrackId),
      mode: validMode(options.mode),
      volume: clamp(Number.isFinite(options.volume ?? DEFAULT_VOLUME) ? options.volume ?? DEFAULT_VOLUME : DEFAULT_VOLUME, 0, 1),
      muted: Boolean(options.muted),
      queueSource: options.queueSource ?? null,
      stopReason: validStopReason(options.stopReason),
      recentlyPlayed: uniqueIds(options.recentlyPlayed ?? []).filter((id) => queue.some((track) => track.id === id)).slice(-this.shuffleMemory),
      history: uniqueIds(options.history ?? []).filter((id) => queue.some((track) => track.id === id)),
    }
  }

  getState(): PlaybackState<T> {
    return {
      ...this.state,
      queue: [...this.state.queue],
      currentIndex: this.state.currentTrackId ? this.state.queue.findIndex((track) => track.id === this.state.currentTrackId) : -1,
      queueSource: this.state.queueSource ? { ...this.state.queueSource } : null,
      stopReason: this.state.stopReason,
      recentlyPlayed: [...this.state.recentlyPlayed],
      history: [...this.state.history],
    }
  }

  subscribe(listener: PlaybackListener<T>): () => void {
    this.listeners.add(listener)
    listener(this.getState())
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    const snapshot = this.getState()
    this.listeners.forEach((listener) => listener(snapshot))
  }

  private update(patch: Partial<PlaybackState<T>>): PlaybackState<T> {
    this.state = { ...this.state, ...patch }
    this.state.currentIndex = this.state.currentTrackId ? this.state.queue.findIndex((track) => track.id === this.state.currentTrackId) : -1
    this.emit()
    return this.getState()
  }

  private dedupeQueue(queue: T[]): T[] {
    const seen = new Set<string>()
    return queue.filter((track) => {
      if (!track?.id || seen.has(track.id)) return false
      seen.add(track.id)
      return true
    })
  }

  private resolveCurrentTrackId(queue: T[], id: string | null): string | null {
    if (id && queue.some((track) => track.id === id)) return id
    return queue[0]?.id ?? null
  }

  private currentIndex(): number {
    return this.state.queue.findIndex((track) => track.id === this.state.currentTrackId)
  }

  private rememberShuffle(trackId: string): string[] {
    return [...this.state.recentlyPlayed.filter((id) => id !== trackId), trackId].slice(-this.shuffleMemory)
  }

  private select(trackId: string | null, options: { playing?: boolean; resetPosition?: boolean; pushHistory?: boolean } = {}): PlaybackState<T> {
    if (!trackId || !this.state.queue.some((track) => track.id === trackId)) {
      return this.update({ currentTrackId: null, position: 0, isPlaying: false, stopReason: 'pause' })
    }
    const previous = this.state.currentTrackId
    const history = options.pushHistory !== false && previous && previous !== trackId
      ? [...this.state.history, previous].slice(-Math.max(20, this.state.queue.length * 2))
      : this.state.history
    const patch: Partial<PlaybackState<T>> = {
      currentTrackId: trackId,
      isPlaying: options.playing ?? this.state.isPlaying,
      stopReason: 'none',
      history,
    }
    if (options.resetPosition !== false) patch.position = 0
    if (this.state.mode === 'shuffle') patch.recentlyPlayed = this.rememberShuffle(trackId)
    return this.update(patch)
  }

  setQueue(queue: T[], options: { preserveCurrent?: boolean; queueSource?: QueueSource | null } = {}): PlaybackState<T> {
    const nextQueue = this.dedupeQueue(queue)
    const preserveCurrent = options.preserveCurrent !== false
    const current = preserveCurrent ? this.state.currentTrackId : null
    const currentTrackId = this.resolveCurrentTrackId(nextQueue, current)
    const hasCurrent = Boolean(currentTrackId && nextQueue.some((track) => track.id === currentTrackId))
    return this.update({
      queue: nextQueue,
      currentTrackId,
      position: preserveCurrent && hasCurrent ? this.state.position : 0,
      isPlaying: preserveCurrent && hasCurrent ? this.state.isPlaying : false,
      history: preserveCurrent ? this.state.history.filter((id) => nextQueue.some((track) => track.id === id)) : [],
      recentlyPlayed: preserveCurrent ? this.state.recentlyPlayed.filter((id) => nextQueue.some((track) => track.id === id)) : [],
      stopReason: preserveCurrent && hasCurrent ? this.state.stopReason : 'none',
      ...(Object.prototype.hasOwnProperty.call(options, 'queueSource') ? { queueSource: options.queueSource ?? null } : {}),
    })
  }

  addToQueue(track: T, index?: number): PlaybackState<T> {
    if (!track?.id || this.state.queue.some((item) => item.id === track.id)) return this.getState()
    const queue = [...this.state.queue]
    const insertion = index === undefined ? queue.length : clamp(Math.floor(index), 0, queue.length)
    queue.splice(insertion, 0, track)
    const currentTrackId = this.state.currentTrackId ?? track.id
    return this.update({ queue, currentTrackId, stopReason: this.state.currentTrackId ? this.state.stopReason : 'none' })
  }

  addManyToQueue(tracks: T[], index?: number): PlaybackState<T> {
    const incoming = this.dedupeQueue(tracks).filter((track) => !this.state.queue.some((item) => item.id === track.id))
    if (!incoming.length) return this.getState()
    const queue = [...this.state.queue]
    const insertion = index === undefined ? queue.length : clamp(Math.floor(index), 0, queue.length)
    queue.splice(insertion, 0, ...incoming)
    return this.update({ queue, currentTrackId: this.state.currentTrackId ?? incoming[0].id, stopReason: this.state.currentTrackId ? this.state.stopReason : 'none' })
  }

  removeFromQueue(trackId: string): PlaybackState<T> {
    const index = this.state.queue.findIndex((track) => track.id === trackId)
    if (index < 0) return this.getState()
    const queue = this.state.queue.filter((track) => track.id !== trackId)
    if (trackId !== this.state.currentTrackId) {
      return this.update({ queue, history: this.state.history.filter((id) => id !== trackId), recentlyPlayed: this.state.recentlyPlayed.filter((id) => id !== trackId) })
    }
    // Removing the current row is an explicit stop.  Keep the remaining rows
    // available in the queue, but clear the current selection so the audio
    // adapter cannot interpret this as a request to play a replacement.
    return this.update({
      queue,
      currentTrackId: null,
      position: 0,
      isPlaying: false,
      stopReason: 'manual-delete',
      history: this.state.history.filter((id) => id !== trackId),
      recentlyPlayed: this.state.recentlyPlayed.filter((id) => id !== trackId),
    })
  }

  clearQueue(): PlaybackState<T> {
    return this.update({ queue: [], currentTrackId: null, position: 0, isPlaying: false, history: [], recentlyPlayed: [], queueSource: null, stopReason: 'manual-clear' })
  }

  reorderQueue(fromIndex: number, toIndex: number): PlaybackState<T> {
    const queue = [...this.state.queue]
    if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex < 0 || fromIndex >= queue.length || toIndex < 0 || toIndex >= queue.length || fromIndex === toIndex) return this.getState()
    const [track] = queue.splice(fromIndex, 1)
    queue.splice(toIndex, 0, track)
    return this.update({ queue })
  }

  play(trackId?: string): PlaybackState<T> {
    if (trackId && trackId !== this.state.currentTrackId) return this.select(trackId, { playing: true, resetPosition: true })
    if (!this.state.currentTrackId && this.state.queue[0]) return this.select(this.state.queue[0].id, { playing: true, resetPosition: true, pushHistory: false })
    // A shuffle session starts remembering the first item when playback is
    // actually started.  Without this, the first `next()` call could select
    // that same item again because the constructor only restored state.
    const recentlyPlayed = this.state.mode === 'shuffle' && this.state.currentTrackId
      ? this.rememberShuffle(this.state.currentTrackId)
      : this.state.recentlyPlayed
    return this.update({ isPlaying: Boolean(this.state.currentTrackId), recentlyPlayed, stopReason: 'none' })
  }

  pause(): PlaybackState<T> {
    return this.update({ isPlaying: false, stopReason: 'pause' })
  }

  toggle(): PlaybackState<T> {
    return this.state.isPlaying ? this.pause() : this.play()
  }

  seek(position: number): PlaybackState<T> {
    const current = this.state.queue.find((track) => track.id === this.state.currentTrackId)
    const max = current?.duration && Number.isFinite(current.duration) ? Math.max(0, current.duration) : Number.POSITIVE_INFINITY
    return this.update({ position: clamp(Number.isFinite(position) ? position : 0, 0, max) })
  }

  setVolume(volume: number): PlaybackState<T> {
    return this.update({ volume: clamp(Number.isFinite(volume) ? volume : DEFAULT_VOLUME, 0, 1) })
  }

  toggleMute(): PlaybackState<T> {
    return this.update({ muted: !this.state.muted })
  }

  setMode(mode: PlaybackMode): PlaybackState<T> {
    return this.update({ mode: validMode(mode) })
  }

  /** Called by the audio adapter on `ended`. */
  ended(): PlaybackState<T> {
    if (!this.state.currentTrackId || !this.state.queue.length) {
      // A late ended callback after a manual delete/clear must not overwrite
      // the explicit stop reason (and, most importantly, must not select a
      // replacement row).
      const stopReason = this.state.stopReason === 'manual-delete' || this.state.stopReason === 'manual-clear' ? this.state.stopReason : 'natural-end'
      return this.update({ isPlaying: false, position: 0, stopReason })
    }
    if (this.state.mode === 'repeat-one') return this.update({ position: 0, isPlaying: true, stopReason: 'none' })
    const next = this.nextTrackId()
    if (!next) return this.update({ position: 0, isPlaying: false, stopReason: 'natural-end' })
    return this.select(next, { playing: true, resetPosition: true })
  }

  next(): PlaybackState<T> {
    const next = this.nextTrackId()
    if (!next) return this.update({ isPlaying: false, position: 0, stopReason: 'pause' })
    return this.select(next, { playing: true, resetPosition: true })
  }

  previous(): PlaybackState<T> {
    if (!this.state.currentTrackId || !this.state.queue.length) return this.getState()
    if (this.state.position > 3) return this.seek(0)
    if (this.state.mode === 'shuffle' && this.state.history.length) {
      const history = [...this.state.history]
      const previous = history.pop() as string
      return this.update({ currentTrackId: previous, history, position: 0, isPlaying: true, recentlyPlayed: this.rememberShuffle(previous) })
    }
    const index = this.currentIndex()
    if (index < 0) return this.getState()
    const previousIndex = index - 1
    if (previousIndex < 0) {
      if (this.state.mode === 'repeat-all') return this.select(this.state.queue[this.state.queue.length - 1].id, { playing: true, resetPosition: true })
      return this.update({ position: 0 })
    }
    return this.select(this.state.queue[previousIndex].id, { playing: true, resetPosition: true })
  }

  private nextTrackId(): string | null {
    if (!this.state.currentTrackId) return this.state.queue[0]?.id ?? null
    if (this.state.mode === 'repeat-one') return this.state.currentTrackId
    if (this.state.mode === 'shuffle') return this.chooseShuffleTrack()
    const index = this.currentIndex()
    if (index < 0) return this.state.queue[0]?.id ?? null
    const nextIndex = index + 1
    if (nextIndex < this.state.queue.length) return this.state.queue[nextIndex].id
    return this.state.mode === 'repeat-all' ? this.state.queue[0].id : null
  }

  private chooseShuffleTrack(): string | null {
    // `recentlyPlayed` is intentionally short lived for the UI, but a
    // shuffle round must remember every item already selected. The history
    // contains all prior selections in this queue, so prefer tracks that are
    // absent from both history and the current item. This prevents a 5-song
    // queue from returning song A before song E has had a turn.
    const playedThisRound = new Set([...this.state.history, ...(this.state.currentTrackId ? [this.state.currentTrackId] : [])])
    const candidates = this.state.queue.filter((track) => !playedThisRound.has(track.id))
    const fallback = this.state.queue.filter((track) => track.id !== this.state.currentTrackId)
    const pool = candidates.length ? candidates : fallback
    if (!pool.length) return this.state.currentTrackId
    const random = clamp(this.random(), 0, 0.999999999)
    return pool[Math.floor(random * pool.length)]?.id ?? pool[0].id
  }

  toPersisted(): PersistedPlaybackState {
    return {
      queueIds: this.state.queue.map((track) => track.id),
      currentTrackId: this.state.currentTrackId,
      currentIndex: this.state.currentIndex,
      position: this.state.position,
      isPlaying: false,
      mode: this.state.mode,
      volume: this.state.volume,
      muted: this.state.muted,
      queueSource: this.state.queueSource ? { ...this.state.queueSource } : null,
      stopReason: this.state.stopReason,
      recentlyPlayed: [...this.state.recentlyPlayed],
      history: [...this.state.history],
    }
  }

  /** Build a machine from persisted IDs after the library has been loaded. */
  static fromPersisted<T extends PlayableTrack>(persisted: Partial<PersistedPlaybackState>, tracks: T[], options: Omit<PlaybackOptions<T>, 'queue' | 'currentTrackId' | 'position' | 'isPlaying' | 'mode' | 'volume' | 'muted' | 'recentlyPlayed' | 'history' | 'queueSource'> = {}): PlaybackStateMachine<T> {
    const byId = new Map(tracks.map((track) => [track.id, track]))
    // An explicitly persisted empty queue is meaningful (the user cleared
    // it), while an older snapshot with no queueIds should bootstrap with the
    // library tracks for backwards compatibility.
    const hasPersistedQueue = Array.isArray(persisted.queueIds)
    const queueIds = hasPersistedQueue ? (persisted.queueIds ?? []) : []
    const queue = queueIds.map((id) => byId.get(id)).filter((track): track is T => Boolean(track))
    return new PlaybackStateMachine({ ...options, queue: hasPersistedQueue ? queue : tracks, currentTrackId: persisted.currentTrackId ?? null, position: persisted.position ?? 0, isPlaying: false, mode: validMode(persisted.mode), volume: persisted.volume, muted: persisted.muted, queueSource: persisted.queueSource ?? null, recentlyPlayed: persisted.recentlyPlayed, history: persisted.history, stopReason: validStopReason(persisted.stopReason) })
  }
}

export function parsePersistedPlaybackState(value: string | null): PersistedPlaybackState | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<PersistedPlaybackState>
    if (!parsed || !Array.isArray(parsed.queueIds)) return null
    return {
      queueIds: parsed.queueIds.filter((id): id is string => typeof id === 'string'),
      currentTrackId: typeof parsed.currentTrackId === 'string' ? parsed.currentTrackId : null,
      currentIndex: typeof parsed.currentIndex === 'number' && Number.isInteger(parsed.currentIndex) ? parsed.currentIndex : undefined,
      position: typeof parsed.position === 'number' && Number.isFinite(parsed.position) ? parsed.position : 0,
      isPlaying: false,
      mode: validMode(parsed.mode),
      volume: typeof parsed.volume === 'number' && Number.isFinite(parsed.volume) ? clamp(parsed.volume, 0, 1) : DEFAULT_VOLUME,
      muted: Boolean(parsed.muted),
      queueSource: parsed.queueSource && typeof parsed.queueSource === 'object' && ['playlist', 'library', 'manual', 'unknown'].includes((parsed.queueSource as QueueSource).type)
        ? { type: (parsed.queueSource as QueueSource).type, id: typeof (parsed.queueSource as QueueSource).id === 'string' ? (parsed.queueSource as QueueSource).id : undefined, name: typeof (parsed.queueSource as QueueSource).name === 'string' ? (parsed.queueSource as QueueSource).name : undefined }
        : null,
      recentlyPlayed: Array.isArray(parsed.recentlyPlayed) ? parsed.recentlyPlayed.filter((id): id is string => typeof id === 'string') : [],
      history: Array.isArray(parsed.history) ? parsed.history.filter((id): id is string => typeof id === 'string') : [],
      stopReason: validStopReason(parsed.stopReason),
    }
  } catch {
    return null
  }
}

