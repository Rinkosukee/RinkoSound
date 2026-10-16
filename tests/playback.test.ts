import { describe, expect, it } from 'vitest'
import { PlaybackStateMachine, parsePersistedPlaybackState, type PlayableTrack } from '../src/lib/playback'

interface Track extends PlayableTrack {
  title: string
}

const tracks: Track[] = [
  { id: 'a', title: 'A', duration: 10 },
  { id: 'b', title: 'B', duration: 20 },
  { id: 'c', title: 'C', duration: 30 },
]

describe('PlaybackStateMachine', () => {
  it('deduplicates queue items and supports queue operations', () => {
    const player = new PlaybackStateMachine({ queue: [tracks[0], tracks[0], tracks[1]] })
    expect(player.getState().queue.map((track) => track.id)).toEqual(['a', 'b'])
    player.addToQueue(tracks[2])
    player.addToQueue(tracks[2])
    expect(player.getState().queue.map((track) => track.id)).toEqual(['a', 'b', 'c'])
    player.reorderQueue(2, 0)
    expect(player.getState().queue.map((track) => track.id)).toEqual(['c', 'a', 'b'])
    player.removeFromQueue('a')
    expect(player.getState().queue.map((track) => track.id)).toEqual(['c', 'b'])
    player.clearQueue()
    expect(player.getState().queue).toEqual([])
    expect(player.getState().currentTrackId).toBeNull()
    expect(player.getState().currentIndex).toBe(-1)
  })

  it('creates a queue in playlist order and tracks its source/current index', () => {
    const player = new PlaybackStateMachine<Track>({ queue: [], queueSource: { type: 'playlist', id: 'mix', name: '我的歌单' } })
    player.setQueue(tracks, { preserveCurrent: false, queueSource: { type: 'playlist', id: 'mix', name: '我的歌单' } })
    const state = player.play('a')
    expect(state.queue.map((track) => track.id)).toEqual(['a', 'b', 'c'])
    expect(state.currentTrackId).toBe('a')
    expect(state.currentIndex).toBe(0)
    expect(state.queueSource).toEqual({ type: 'playlist', id: 'mix', name: '我的歌单' })
    expect(player.next().currentIndex).toBe(1)
  })

  it('replacing a queue for a new playlist starts a fresh playback round', () => {
    const player = new PlaybackStateMachine({ queue: tracks, mode: 'shuffle', currentTrackId: 'b', isPlaying: true })
    player.next()
    player.setQueue([tracks[1], tracks[2]], { preserveCurrent: false, queueSource: { type: 'playlist', id: 'second' } })
    const state = player.getState()
    expect(state.queue.map((track) => track.id)).toEqual(['b', 'c'])
    expect(state.currentTrackId).toBe('b')
    expect(state.currentIndex).toBe(0)
    expect(state.position).toBe(0)
    expect(state.isPlaying).toBe(false)
    expect(state.history).toEqual([])
    expect(state.recentlyPlayed).toEqual([])
  })

  it('plays sequentially and stops at the end', () => {
    const player = new PlaybackStateMachine({ queue: tracks })
    expect(player.play().currentTrackId).toBe('a')
    expect(player.next().currentTrackId).toBe('b')
    expect(player.next().currentTrackId).toBe('c')
    const ended = player.ended()
    expect(ended.currentTrackId).toBe('c')
    expect(ended.position).toBe(0)
    expect(ended.isPlaying).toBe(false)
  })

  it('wraps in repeat-all mode', () => {
    const player = new PlaybackStateMachine({ queue: tracks, mode: 'repeat-all' })
    player.play('c')
    expect(player.next().currentTrackId).toBe('a')
    expect(player.previous().currentTrackId).toBe('c')
    const endedAtEnd = new PlaybackStateMachine({ queue: tracks, mode: 'repeat-all', currentTrackId: 'c', isPlaying: true })
    expect(endedAtEnd.ended().currentTrackId).toBe('a')
  })

  it('restarts the current track in repeat-one mode', () => {
    const player = new PlaybackStateMachine({ queue: tracks, mode: 'repeat-one' })
    player.play('b')
    player.seek(9)
    const ended = player.ended()
    expect(ended.currentTrackId).toBe('b')
    expect(ended.position).toBe(0)
    expect(ended.isPlaying).toBe(true)
  })

  it('appends queued tracks without interrupting the current song', () => {
    const player = new PlaybackStateMachine({ queue: [tracks[0]], currentTrackId: 'a', isPlaying: true })
    player.addManyToQueue([tracks[1], tracks[2]])
    const state = player.getState()
    expect(state.queue.map((track) => track.id)).toEqual(['a', 'b', 'c'])
    expect(state.currentTrackId).toBe('a')
    expect(state.currentIndex).toBe(0)
    expect(state.isPlaying).toBe(true)
  })

  it('keeps the current track index correct when an earlier queue item is removed', () => {
    const player = new PlaybackStateMachine({ queue: tracks, currentTrackId: 'c', isPlaying: true })
    player.removeFromQueue('a')
    expect(player.getState().queue.map((track) => track.id)).toEqual(['b', 'c'])
    expect(player.getState().currentTrackId).toBe('c')
    expect(player.getState().currentIndex).toBe(1)
    player.removeFromQueue('b')
    expect(player.getState().currentTrackId).toBe('c')
    expect(player.getState().currentIndex).toBe(0)
    expect(player.getState().isPlaying).toBe(true)
  })

  it('stops immediately when the currently playing track is manually removed', () => {
    const player = new PlaybackStateMachine({ queue: tracks, currentTrackId: 'b', isPlaying: true, position: 7 })

    const state = player.removeFromQueue('b')

    expect(state.queue.map((track) => track.id)).toEqual(['a', 'c'])
    expect(state.currentTrackId).toBeNull()
    expect(state.currentIndex).toBe(-1)
    expect(state.position).toBe(0)
    expect(state.isPlaying).toBe(false)
    expect(state.stopReason).toBe('manual-delete')
    expect(state.stopReason).toBe('manual-delete')
  })

  it('keeps other queue items idle after removing the current track', () => {
    const player = new PlaybackStateMachine({ queue: tracks, currentTrackId: 'a', isPlaying: true })
    player.removeFromQueue('a')

    expect(player.getState().queue.map((track) => track.id)).toEqual(['b', 'c'])
    expect(player.getState().currentTrackId).toBeNull()
    expect(player.getState().isPlaying).toBe(false)
    expect(player.getState().stopReason).toBe('manual-delete')

    // A subsequent natural-ended callback must not resurrect another item.
    expect(player.ended().currentTrackId).toBeNull()
    expect(player.getState().isPlaying).toBe(false)
  })

  it('distinguishes natural end from manual stop: ended advances, removal does not', () => {
    const natural = new PlaybackStateMachine({ queue: tracks, currentTrackId: 'a', isPlaying: true })
    const next = natural.ended()
    expect(next.currentTrackId).toBe('b')
    expect(next.currentIndex).toBe(1)
    expect(next.isPlaying).toBe(true)

    const manual = new PlaybackStateMachine({ queue: tracks, currentTrackId: 'a', isPlaying: true })
    const stopped = manual.removeFromQueue('a')
    expect(stopped.currentTrackId).toBeNull()
    expect(stopped.isPlaying).toBe(false)
    expect(stopped.stopReason).toBe('manual-delete')
    expect(manual.ended().currentTrackId).toBeNull()
    expect(manual.getState().isPlaying).toBe(false)
  })

  it('clearing the queue leaves no current track and cannot start playback again', () => {
    const player = new PlaybackStateMachine({ queue: tracks, currentTrackId: 'b', isPlaying: true, position: 4 })
    const state = player.clearQueue()

    expect(state.queue).toEqual([])
    expect(state.currentTrackId).toBeNull()
    expect(state.currentIndex).toBe(-1)
    expect(state.position).toBe(0)
    expect(state.isPlaying).toBe(false)
    expect(state.stopReason).toBe('manual-clear')
    expect(state.stopReason).toBe('manual-clear')
    expect(player.ended().currentTrackId).toBeNull()
    expect(player.next().currentTrackId).toBeNull()
  })

  it('shuffles without repeating recent tracks when alternatives exist', () => {
    // Deterministic random values make this test independent of Math.random.
    const randomValues = [0, 0, 0, 0]
    const player = new PlaybackStateMachine({ queue: tracks, mode: 'shuffle', random: () => randomValues.shift() ?? 0, shuffleMemory: 2 })
    player.play('a')
    expect(player.next().currentTrackId).toBe('b')
    expect(player.next().currentTrackId).toBe('c')
    // With all other tracks in the short-memory window, fallback still avoids
    // immediately repeating the current track and chooses the only alternative.
    expect(player.next().currentTrackId).toBe('a')
    expect(new Set(player.getState().recentlyPlayed).size).toBeLessThanOrEqual(2)
    expect(player.previous().currentTrackId).toBe('c')
  })

  it('does not repeat a shuffled queue item before the current round is complete', () => {
    const five: Track[] = [
      ...tracks,
      { id: 'd', title: 'D', duration: 40 },
      { id: 'e', title: 'E', duration: 50 },
    ]
    // Always pick the first candidate. With the old short-memory-only logic
    // this would return A before E had been played.
    const player = new PlaybackStateMachine({ queue: five, mode: 'shuffle', random: () => 0, shuffleMemory: 3 })
    player.play('a')
    const order = [player.getState().currentTrackId]
    for (let index = 0; index < five.length - 1; index += 1) order.push(player.next().currentTrackId)
    expect(order).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(new Set(order).size).toBe(five.length)
  })

  it('previous seeks to the beginning when already part way through a track', () => {
    const player = new PlaybackStateMachine({ queue: tracks })
    player.play('b')
    player.seek(4)
    expect(player.previous().currentTrackId).toBe('b')
    expect(player.getState().position).toBe(0)
  })

  it('clamps seek and volume values and emits snapshots', () => {
    const player = new PlaybackStateMachine({ queue: tracks })
    const snapshots: string[] = []
    const unsubscribe = player.subscribe((state) => snapshots.push(`${state.currentTrackId}:${state.position}`))
    player.play('a')
    player.seek(-5)
    expect(player.getState().position).toBe(0)
    player.seek(100)
    expect(player.getState().position).toBe(10)
    expect(player.setVolume(4).volume).toBe(1)
    expect(player.setVolume(-2).volume).toBe(0)
    unsubscribe()
    const count = snapshots.length
    player.pause()
    expect(snapshots).toHaveLength(count)
  })

  it('serializes and restores queue and preferences after a library reload', () => {
    const player = new PlaybackStateMachine({ queue: tracks, mode: 'shuffle', volume: 0.35, muted: true, queueSource: { type: 'playlist', id: 'mix', name: '我的歌单' } })
    player.play('b')
    player.seek(7)
    const persisted = player.toPersisted()
    const restored = PlaybackStateMachine.fromPersisted(persisted, tracks)
    expect(restored.getState().queue.map((track) => track.id)).toEqual(['a', 'b', 'c'])
    expect(restored.getState().currentTrackId).toBe('b')
    expect(restored.getState().currentIndex).toBe(1)
    expect(restored.getState().position).toBe(7)
    expect(restored.getState().mode).toBe('shuffle')
    expect(restored.getState().volume).toBe(0.35)
    expect(restored.getState().muted).toBe(true)
    expect(restored.getState().isPlaying).toBe(false)
    expect(restored.getState().queueSource).toEqual({ type: 'playlist', id: 'mix', name: '我的歌单' })
  })

  it('restores an explicitly empty queue instead of repopulating the library', () => {
    const player = new PlaybackStateMachine<Track>({ queue: tracks })
    player.clearQueue()
    const restored = PlaybackStateMachine.fromPersisted(player.toPersisted(), tracks)
    expect(restored.getState().queue).toEqual([])
    expect(restored.getState().currentTrackId).toBeNull()
    expect(restored.getState().currentIndex).toBe(-1)
  })
})

describe('parsePersistedPlaybackState', () => {
  it('rejects malformed values and sanitizes valid values', () => {
    expect(parsePersistedPlaybackState(null)).toBeNull()
    expect(parsePersistedPlaybackState('{invalid')).toBeNull()
    const parsed = parsePersistedPlaybackState(JSON.stringify({ queueIds: ['a', 2], mode: 'bad', volume: 4, position: 2, currentIndex: 0, queueSource: { type: 'playlist', id: 'mix', name: '我的歌单' } }))
    expect(parsed).toMatchObject({ queueIds: ['a'], mode: 'sequential', volume: 1, position: 2, currentIndex: 0, queueSource: { type: 'playlist', id: 'mix', name: '我的歌单' }, isPlaying: false })
  })
})

